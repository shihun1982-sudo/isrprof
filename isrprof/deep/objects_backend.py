"""objects backend: the real build.

Optionally runs the profile's configure / build commands (``deep.build.run``), then reads the object
files with the toolchain's ``nm`` and ``objdump``:

* ``nm -S -C --defined-only``   defined symbols: functions (T/t/W) and data (D/d/B/b/R/r), sizes, local vs global
* ``objdump -dr -C``            disassembly with relocations: every ``R_ARM_CALL / R_ARM_THM_CALL /
                                R_ARM_JUMP24`` (and the x86 / PLT variants) is a call edge, every data
                                relocation (``R_ARM_ABS32``, ``MOVW/MOVT``, ``R_X86_64_PC32`` ...) a data
                                reference; the next load / store that uses the materialised address decides
                                read vs write when it can be seen, otherwise the reference is ``ref``

This is what the linker will connect, including anything the frontend could not see (assembly, LTO-visible
tables, compiler-generated calls).  Tools come from ``deep.build.toolchain_prefix`` (``arm-none-eabi-``) or the
explicit ``nm`` / ``objdump`` paths; without them the backend logs and returns an empty graph.  The text
parsers are pure functions (``parse_nm`` / ``parse_objdump``) so they can be unit-tested with fixtures.
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import time

from . import FnSym, SymbolGraph, VarSym

CALL_RELOCS = ("R_ARM_CALL", "R_ARM_THM_CALL", "R_ARM_JUMP24", "R_ARM_THM_JUMP24", "R_ARM_THM_JUMP19", "R_ARM_PLT32", "R_ARM_PREL31",
               "R_X86_64_PLT32", "R_X86_64_PC32", "R_386_PLT32", "R_386_PC32", "R_AARCH64_CALL26", "R_AARCH64_JUMP26",
               "DISP32", "REL32")
DATA_RELOCS = ("R_ARM_ABS32", "R_ARM_THM_MOVW_ABS_NC", "R_ARM_THM_MOVT_ABS", "R_ARM_MOVW_ABS_NC", "R_ARM_MOVT_ABS", "R_ARM_GOT_BREL",
               "R_ARM_REL32", "R_X86_64_32", "R_X86_64_32S", "R_X86_64_64", "R_X86_64_REX_GOTPCRELX", "R_X86_64_GOTPCRELX",
               "R_386_32", "R_386_GOTOFF", "R_AARCH64_ADR_PREL_PG_HI21", "R_AARCH64_ADD_ABS_LO12_NC", "R_AARCH64_LDST32_ABS_LO12_NC", "dir32", "addr32")
_SYM_HDR = re.compile(r"^[0-9a-fA-F]+ <(.+)>:\s*$")
_RELOC = re.compile(r"^\s*[0-9a-fA-F]+:\s+(R_[A-Z0-9_]+|DISP32|REL32|dir32|addr32)\s+(.+?)\s*$")
_INSN = re.compile(r"^\s*[0-9a-fA-F]+:\s+(?:[0-9a-f]{2,8}\s+)*([a-z][a-z0-9.]*)\s*(.*)$")
_NM = re.compile(r"^([0-9a-fA-F]+)\s+(?:([0-9a-fA-F]+)\s+)?([A-Za-z?])\s+(.+)$")


def demangle_name(sym: str) -> str:
    """`Decoder::run(dl::Ctx&)` -> `Decoder::run`; `fn` stays; strips section / plt suffixes."""
    s = sym.strip()
    s = re.sub(r"@plt$|@@.*$|@GOTPCREL.*$|-0x[0-9a-f]+$|\+0x[0-9a-f]+$", "", s)
    depth, cut = 0, None
    for i, ch in enumerate(s):
        if ch == "(" and depth == 0 and cut is None:
            cut = i
        if ch in "(<":
            depth += 1
        elif ch in ")>":
            depth -= 1
    if cut is not None:
        s = s[:cut]
    return s.strip()


def parse_nm(text: str) -> dict[str, dict]:
    """symbol -> {kind: function|data, local: bool, size: int}"""
    out: dict[str, dict] = {}
    for line in text.splitlines():
        m = _NM.match(line.strip())
        if not m:
            continue
        _addr, size, typ, name = m.groups()
        name = demangle_name(name)
        if typ in "TtWw":
            out[name] = {"kind": "function", "local": typ.islower(), "size": int(size or "0", 16)}
        elif typ in "DdBbRrGgSsVv":
            out[name] = {"kind": "data", "local": typ.islower(), "size": int(size or "0", 16)}
    return out


def parse_objdump(text: str) -> dict[str, dict]:
    """Per function (section header `<sym>:`): calls[] and refs[] from relocations.
    refs carry rw = r / w / ref using the next load / store on the same register when visible."""
    out: dict[str, dict] = {}
    cur = None
    pending: list[tuple[str, str | None]] = []       # (symbol, register the address was loaded into)
    last_dst = None
    for line in text.splitlines():
        m = _SYM_HDR.match(line)
        if m:
            cur = demangle_name(m.group(1))
            out[cur] = {"calls": [], "refs": []}
            pending, last_dst = [], None
            continue
        if cur is None:
            continue
        m = _RELOC.match(line)
        if m:
            rtype, target = m.group(1), demangle_name(m.group(2))
            if not target or target.startswith("."):
                continue
            if rtype in CALL_RELOCS or rtype.endswith("_CALL") or "JUMP" in rtype or "PLT" in rtype:
                if target not in [c["callee"] for c in out[cur]["calls"]]:
                    out[cur]["calls"].append({"callee": target, "kind": "objects"})
            elif rtype in DATA_RELOCS or "ABS" in rtype or "GOT" in rtype or "32" in rtype:
                pending.append((target, last_dst))
                out[cur]["refs"].append({"var": target, "rw": "ref"})
            continue
        m = _INSN.match(line)
        if m:
            mnem, ops = m.group(1), m.group(2)
            regs = re.findall(r"\b(r\d+|sp|lr|pc|x\d+|w\d+|%[a-z0-9]+)\b", ops)
            last_dst = regs[0] if regs else None
            if pending and (mnem.startswith(("ldr", "str", "mov", "add", "sub")) or mnem in ("movw", "movt")):
                # a load / store through the register that received the address resolves the direction
                base = re.findall(r"\[\s*(r\d+|sp|x\d+)", ops) or re.findall(r"\(\s*(%[a-z0-9]+)\s*\)", ops)
                if base:
                    for sym, reg in list(pending):
                        if reg and reg == base[0]:
                            rw = "w" if mnem.startswith("str") or (mnem.startswith("mov") and ops.strip().startswith("%") is False and "," in ops and ops.split(",")[-1].strip().startswith("(")) else "r"
                            for r in out[cur]["refs"]:
                                if r["var"] == sym and r["rw"] == "ref":
                                    r["rw"] = rw
                                    break
                            pending.remove((sym, reg))
    return out


def _tool(deep_build: dict, name: str) -> str | None:
    explicit = deep_build.get(name)
    if explicit and (os.path.isfile(explicit) or shutil.which(explicit)):
        return explicit
    prefix = deep_build.get("toolchain_prefix", "") or ""
    for cand in (prefix + name, name, "llvm-" + name):
        p = shutil.which(cand)
        if p:
            return p
    return None


def analyze(cfg) -> SymbolGraph:
    g = SymbolGraph(backend="objects")
    deep = cfg.build.get("deep") or {}
    bcfg = deep.get("build") or {}
    root = cfg.src_root
    t0 = time.perf_counter()
    log_dir = os.path.join(cfg.output["dir"], ".cache")
    os.makedirs(log_dir, exist_ok=True)
    if bcfg.get("run"):
        cmds = []
        cm = cfg.build.get("cmake") or {}
        if cm and cm.get("configure"):
            cmds.append(cm["configure"])
        if cfg.build.get("build_command"):
            cmds.append(cfg.build["build_command"])
        with open(os.path.join(log_dir, "build.log"), "w", encoding="utf-8", errors="replace") as logf:
            for cmd in cmds:
                g.log.append(f"build: {cmd}")
                try:
                    r = subprocess.run(cmd, shell=True, cwd=root, capture_output=True, text=True, timeout=int(bcfg.get("timeout", 3600)))
                    logf.write(f"$ {cmd}\n{r.stdout}\n{r.stderr}\n")
                    if r.returncode != 0:
                        g.log.append(f"build command failed ({r.returncode}); see .cache/build.log")
                except Exception as e:
                    g.log.append(f"build command error: {e}")
    nm, objdump = _tool(bcfg, "nm"), _tool(bcfg, "objdump")
    if not nm or not objdump:
        g.log.append(f"toolchain not found (nm={nm}, objdump={objdump}); set deep.build.toolchain_prefix or nm / objdump paths")
        g.stats = {"objects": 0, "ms": round((time.perf_counter() - t0) * 1000)}
        return g
    pats = bcfg.get("objects") or ["build/**/*.o", "build/**/*.obj"]
    objs: list[str] = []
    for p in pats:
        full = p if os.path.isabs(p) else os.path.join(root, p)
        objs += sorted(glob.glob(full, recursive=True))
    from . import in_scope
    objs = [o for o in objs if in_scope(cfg, o)]
    fn_syms: dict[str, dict] = {}
    data_syms: dict[str, dict] = {}
    per_fn: dict[str, dict] = {}
    for o in objs:
        try:
            nm_out = subprocess.run([nm, "-S", "-C", "--defined-only", o], capture_output=True, text=True, timeout=120).stdout
            od_out = subprocess.run([objdump, "-dr", "-C", "--no-show-raw-insn", o], capture_output=True, text=True, timeout=600).stdout
        except Exception as e:
            g.log.append(f"{os.path.basename(o)}: {e}")
            continue
        syms = parse_nm(nm_out)
        for name, info in syms.items():
            (fn_syms if info["kind"] == "function" else data_syms).setdefault(name, dict(info, obj=o))
        for fname, body in parse_objdump(od_out).items():
            rec = per_fn.setdefault(fname, {"calls": [], "refs": [], "obj": o})
            rec["calls"] += body["calls"]
            rec["refs"] += body["refs"]
    for name, info in fn_syms.items():
        src = _guess_source(info["obj"], root)
        fid = f"{name}@{os.path.basename(src)}" if info["local"] and src else name
        body = per_fn.get(name, {"calls": [], "refs": []})
        calls = [{"callee": c["callee"], "callee_id": None, "line": 0, "col": 0, "kind": "objects", "candidates": []} for c in body["calls"]]
        refs = []
        seen = set()
        for r in body["refs"]:
            if r["var"] in data_syms and (r["var"], r["rw"]) not in seen:
                seen.add((r["var"], r["rw"]))
                dinfo = data_syms[r["var"]]
                key = f"{r['var']}@{os.path.basename(_guess_source(dinfo['obj'], root))}" if dinfo["local"] else r["var"]
                refs.append({"var": r["var"], "key": key, "rw": "r" if r["rw"] == "ref" else r["rw"], "line": 0, "col": 0, "member": "", "kind": "static" if dinfo["local"] else "global", "via_macro": "objects"})
        g.functions[fid] = FnSym(id=fid, name=name, short=name.split("::")[-1], file=src or info["obj"], line=0, end_line=0,
                                 kind="method" if "::" in name else "function", cls=name.rsplit("::", 1)[0] if "::" in name else "",
                                 static=info["local"], calls=calls, refs=refs)
    for name, info in data_syms.items():
        src = _guess_source(info["obj"], root)
        key = f"{name}@{os.path.basename(src)}" if info["local"] else name
        g.variables.setdefault(key, VarSym(key=key, name=name, file=src or info["obj"], line=0, kind="static" if info["local"] else "global", decl=f"{info['size']} bytes"))
    # resolve callee ids by name
    for fn in g.functions.values():
        for c in fn.calls:
            c["callee_id"] = c["callee"] if c["callee"] in g.functions else next((fid for fid in g.functions if fid.split("@")[0] == c["callee"]), None)
    g.files = objs
    g.stats = {"objects": len(objs), "functions": len(g.functions), "data_symbols": len(data_syms), "ms": round((time.perf_counter() - t0) * 1000)}
    return g


def _guess_source(obj: str, root: str) -> str:
    """build/dl/dl_isr.c.o -> <root>/dl/dl_isr.c when such a file exists."""
    base = os.path.basename(obj)
    for suf in (".o", ".obj"):
        if base.endswith(suf):
            base = base[: -len(suf)]
    cands = [base] + [base + e for e in (".c", ".cpp", ".cc", ".cxx")]
    rel_dir = os.path.relpath(os.path.dirname(obj), root).replace("\\", "/").split("/")
    for i in range(len(rel_dir)):
        d = os.path.join(root, *rel_dir[i:]) if rel_dir[i:] else root
        for c in cands:
            p = os.path.join(d, c)
            if os.path.isfile(p):
                return p
    for c in cands:
        hits = glob.glob(os.path.join(root, "**", c), recursive=True)
        if hits:
            return hits[0]
    return ""
