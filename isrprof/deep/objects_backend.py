"""objects backend: the real build.

1. **Build** - ``deep.build.run: true`` runs the profile's ``cmake.configure`` / ``build_command`` in the
   source root (the project's own toolchain).  Without a toolchain on the analysis PC, ``deep.build.compile:
   zig`` (the default when no object files are found) compiles every translation unit in scope itself with
   the bundled zig/clang cross compiler (``pip install ziglang``): the compile_commands flags, the cross
   target (``arm-none-eabi`` -> ``arm-freestanding-eabi``) and ``-O0 -fno-inline`` so the object graph matches
   the source graph.  Objects land in ``output/<name>/.cache/obj`` and are re-built only when the source or
   the flags change.
2. **Read** - every ``.o`` is read with the pure-Python ELF reader (:mod:`isrprof.deep.elf_reader`): defined
   functions and data symbols, call relocations (``bl`` / ``b.w`` / ``call``), address-taken functions
   (function pointers, vtables, tables) and data references, names demangled.  ``deep.build.reader:
   binutils`` switches to the toolchain's ``nm`` / ``objdump`` text output instead (COFF / Mach-O objects).

The graph is what the linker will connect.  Register / variable *direction* (read vs write) and virtual-call
targets are not visible in relocations, which is why ``backend: both`` (clang + objects) is the most complete
setting: the frontend supplies methods, overrides and read / write, the objects confirm the linked edges and
add what the frontend could not see (assembly, LTO-visible tables, compiler-generated calls).
"""
from __future__ import annotations

import glob
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time

from . import FnSym, SymbolGraph, VarSym, in_scope, translation_units

# ------------------------------------------------------------------------------------------ binutils text parsers (kept for COFF / Mach-O)
_SYM_HDR = re.compile(r"^[0-9a-fA-F]+ <(.+)>:\s*$")
_RELOC = re.compile(r"^\s*[0-9a-fA-F]+:\s+(R_[A-Z0-9_]+|DISP32|REL32|dir32|addr32)\s+(.+?)\s*$")
_NM = re.compile(r"^([0-9a-fA-F]+)\s+(?:([0-9a-fA-F]+)\s+)?([A-Za-z?])\s+(.+)$")


def demangle_name(sym: str) -> str:
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
    out: dict[str, dict] = {}
    cur = None
    for line in text.splitlines():
        m = _SYM_HDR.match(line)
        if m:
            cur = demangle_name(m.group(1)); out[cur] = {"calls": [], "refs": []}
            continue
        if cur is None:
            continue
        m = _RELOC.match(line)
        if not m:
            continue
        rtype, target = m.group(1), demangle_name(m.group(2))
        if not target or target.startswith("."):
            continue
        if rtype.endswith("_CALL") or "JUMP" in rtype or "PLT" in rtype or rtype in ("R_AARCH64_CALL26", "DISP32", "REL32"):
            if target not in [c["callee"] for c in out[cur]["calls"]]:
                out[cur]["calls"].append({"callee": target, "kind": "objects"})
        else:
            out[cur]["refs"].append({"var": target, "rw": "ref"})
    return out


# ------------------------------------------------------------------------------------------ building with zig

ZIG_TARGETS = {"arm-none-eabi": "arm-freestanding-eabi", "armv7m-none-eabi": "thumb-freestanding-eabi", "armv7em-none-eabi": "thumb-freestanding-eabi",
               "thumbv7m-none-eabi": "thumb-freestanding-eabi", "aarch64-none-elf": "aarch64-freestanding-none", "aarch64-none-eabi": "aarch64-freestanding-none",
               "riscv32-none-elf": "riscv32-freestanding-none", "riscv64-none-elf": "riscv64-freestanding-none", "x86_64-linux-gnu": "x86_64-linux-gnu", "i686-linux-gnu": "x86-linux-gnu"}


def zig_cmd() -> list[str] | None:
    try:
        import ziglang  # noqa: F401
        return [sys.executable, "-m", "ziglang"]
    except ImportError:
        z = shutil.which("zig")
        return [z] if z else None


def compile_with_zig(cfg, g: SymbolGraph, obj_dir: str) -> list[str]:
    """Compile the in-scope translation units into obj_dir; returns the object paths (cached by source + flags)."""
    from .clang_backend import tu_args
    zig = zig_cmd()
    if not zig:
        g.log.append("zig not available (pip install ziglang) and no object files found")
        return []
    deep = cfg.build.get("deep") or {}
    bcfg = deep.get("build") or {}
    target = bcfg.get("zig_target") or ZIG_TARGETS.get(deep.get("target") or "", deep.get("target") or "arm-freestanding-eabi")
    mcpu = bcfg.get("mcpu") or ("cortex_m4" if target.startswith(("arm", "thumb")) else None)
    os.makedirs(obj_dir, exist_ok=True)
    out: list[str] = []
    built = 0
    for tu in translation_units(cfg):
        raw = tu_args(cfg, tu)
        args, skip = [], False
        for a in raw:
            if skip:
                skip = False
                continue
            if a in ("-isystem", "-x"):
                skip = True
                continue
            if a.startswith(("--target=", "-ferror-limit", "-fparse-all-comments", "-Wno-everything", "-isystem", "-fsyntax-only")):
                continue
            args.append(a)
        cxx = tu.endswith((".cc", ".cpp", ".cxx", ".c++", ".C"))
        cmd = zig + ["c++" if cxx else "cc", "-target", target] + ([f"-mcpu={mcpu}"] if mcpu else []) + \
              ["-c", "-O0", "-fno-inline", "-fno-sanitize=all", "-fno-stack-protector", "-fno-exceptions", "-fno-rtti" if cxx else "-fno-builtin", "-w"] + list(bcfg.get("zig_args") or []) + args + [tu]
        key = hashlib.sha1(("|".join(cmd) + "|" + str(os.stat(tu).st_mtime_ns)).encode("utf-8")).hexdigest()[:16]
        obj = os.path.join(obj_dir, f"{os.path.splitext(os.path.basename(tu))[0]}.{key}.o")
        if not os.path.isfile(obj):
            try:
                r = subprocess.run(cmd + ["-o", obj], capture_output=True, text=True, timeout=int(bcfg.get("timeout", 600)), cwd=cfg.src_root)
                if r.returncode != 0:
                    g.log.append(f"zig compile failed: {os.path.basename(tu)}: {(r.stderr or r.stdout).strip().splitlines()[-1][:160] if (r.stderr or r.stdout).strip() else r.returncode}")
                    continue
                built += 1
            except Exception as e:
                g.log.append(f"zig compile error: {os.path.basename(tu)}: {e}")
                continue
        out.append(obj)
    g.stats["zig_target"] = target
    g.stats["compiled"] = built
    return out


# ------------------------------------------------------------------------------------------ driver

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
    cache = os.path.join(cfg.output["dir"], ".cache")
    os.makedirs(cache, exist_ok=True)
    # 1. the project's own build
    if bcfg.get("run"):
        cmds = []
        cm = cfg.build.get("cmake") or {}
        if cm and cm.get("configure"):
            cmds.append(cm["configure"])
        if cfg.build.get("build_command"):
            cmds.append(cfg.build["build_command"])
        with open(os.path.join(cache, "build.log"), "w", encoding="utf-8", errors="replace") as logf:
            for cmd in cmds:
                g.log.append(f"build: {cmd}")
                try:
                    r = subprocess.run(cmd, shell=True, cwd=root, capture_output=True, text=True, timeout=int(bcfg.get("timeout", 3600)))
                    logf.write(f"$ {cmd}\n{r.stdout}\n{r.stderr}\n")
                    if r.returncode != 0:
                        g.log.append(f"build command failed ({r.returncode}); see .cache/build.log")
                except Exception as e:
                    g.log.append(f"build command error: {e}")
    # 2. the object files: the project's, or compiled here with zig
    pats = bcfg.get("objects") or ["build/**/*.o", "build/**/*.obj"]
    objs: list[str] = []
    for p in pats:
        full = p if os.path.isabs(p) else os.path.join(root, p)
        objs += sorted(glob.glob(full, recursive=True))
    objs = [o for o in objs if in_scope(cfg, o)]
    tu_of: dict[str, str] = {}
    compile_mode = str(bcfg.get("compile", "auto"))
    if (not objs and compile_mode in ("auto", "zig")) or compile_mode == "zig":
        objs = compile_with_zig(cfg, g, os.path.join(cache, "obj"))
        for tu in translation_units(cfg):
            base = os.path.splitext(os.path.basename(tu))[0] + "."
            for o in objs:
                if os.path.basename(o).startswith(base):
                    tu_of[o] = tu
    if not objs:
        g.stats = {"objects": 0, "ms": round((time.perf_counter() - t0) * 1000)}
        return g
    reader = str(bcfg.get("reader", "elf"))
    fn_syms: dict[str, dict] = {}
    data_syms: dict[str, dict] = {}
    per_fn: dict[str, dict] = {}
    if reader == "binutils":
        nm, objdump = _tool(bcfg, "nm"), _tool(bcfg, "objdump")
        if not nm or not objdump:
            g.log.append(f"toolchain not found (nm={nm}, objdump={objdump}); set deep.build.toolchain_prefix or use reader: elf")
            g.stats = {"objects": len(objs), "ms": round((time.perf_counter() - t0) * 1000)}
            return g
        for o in objs:
            try:
                nm_out = subprocess.run([nm, "-S", "-C", "--defined-only", o], capture_output=True, text=True, timeout=120).stdout
                od_out = subprocess.run([objdump, "-dr", "-C", "--no-show-raw-insn", o], capture_output=True, text=True, timeout=600).stdout
            except Exception as e:
                g.log.append(f"{os.path.basename(o)}: {e}")
                continue
            for name, info in parse_nm(nm_out).items():
                (fn_syms if info["kind"] == "function" else data_syms).setdefault(name, dict(info, obj=o))
            for fname, body in parse_objdump(od_out).items():
                rec = per_fn.setdefault(fname, {"calls": [], "addr": [], "data": [], "obj": o})
                rec["calls"] += [c["callee"] for c in body["calls"]]
                rec["data"] += [r["var"] for r in body["refs"]]
    else:
        from . import elf_reader
        for o in objs:
            try:
                of = elf_reader.read_object(o)
            except Exception as e:
                g.log.append(f"{os.path.basename(o)}: {e}")
                continue
            for name, f in of.functions.items():
                fn_syms.setdefault(name, {"local": f.local, "size": f.size, "obj": o})
                rec = per_fn.setdefault(name, {"calls": [], "addr": [], "data": [], "obj": o})
                rec["calls"] += f.calls; rec["addr"] += f.addr_taken; rec["data"] += f.data
            for name, d in of.data.items():
                data_syms.setdefault(name, dict(d, obj=o))
    # 3. graph
    def src_of(o: str) -> str:
        return tu_of.get(o) or _guess_source(o, root)

    for name, info in fn_syms.items():
        src = src_of(info["obj"])
        fid = f"{name}@{os.path.basename(src)}" if info["local"] and src else name
        body = per_fn.get(name, {"calls": [], "addr": [], "data": []})
        calls = [{"callee": c, "callee_id": None, "line": 0, "col": 0, "kind": "objects", "candidates": []} for c in dict.fromkeys(body["calls"])]
        refs, seen = [], set()
        for var in dict.fromkeys(body["data"]):
            if var in data_syms and var not in seen:
                seen.add(var)
                dinfo = data_syms[var]
                vsrc = src_of(dinfo["obj"])
                key = f"{var}@{os.path.basename(vsrc)}" if dinfo["local"] and vsrc and "@" not in var else var
                refs.append({"var": var.split("@")[0], "key": key, "rw": "r", "line": 0, "col": 0, "member": "", "kind": "static" if dinfo["local"] else "global", "via_macro": "objects"})
        fsym = FnSym(id=fid, name=name, short=name.split("::")[-1], file=src or info["obj"], line=0, end_line=0,
                     kind="method" if "::" in name else "function", cls=name.rsplit("::", 1)[0] if "::" in name else "",
                     static=bool(info["local"]), calls=calls, refs=refs)
        fsym.addr_taken = list(dict.fromkeys(body["addr"]))     # type: ignore[attr-defined]
        g.functions[fid] = fsym
    for name, info in data_syms.items():
        src = src_of(info["obj"])
        key = f"{name}@{os.path.basename(src)}" if info["local"] and src and "@" not in name else name
        g.variables.setdefault(key, VarSym(key=key, name=name.split("@")[0], file=src or info["obj"], line=0, kind="static" if info["local"] else "global", decl=f"{info['size']} bytes"))
    by_short = {}
    for fid in g.functions:
        by_short.setdefault(fid.split("@")[0], fid)
    for fn in g.functions.values():
        for c in fn.calls:
            c["callee_id"] = by_short.get(c["callee"])
        at = getattr(fn, "addr_taken", [])
        if at:
            g.address_taken.setdefault(fn.file, [])
            for a in at:
                fid = by_short.get(a)
                if fid and fid not in g.address_taken[fn.file]:
                    g.address_taken[fn.file].append(fid)
    g.files = objs
    g.stats.update({"objects": len(objs), "functions": len(g.functions), "data_symbols": len(data_syms), "reader": reader, "ms": round((time.perf_counter() - t0) * 1000)})
    return g


def _guess_source(obj: str, root: str) -> str:
    base = os.path.basename(obj)
    for suf in (".o", ".obj"):
        if base.endswith(suf):
            base = base[: -len(suf)]
    base = base.split(".")[0]
    cands = [base + e for e in (".c", ".cpp", ".cc", ".cxx")]
    for c in cands:
        hits = glob.glob(os.path.join(root, "**", c), recursive=True)
        if hits:
            return hits[0]
    return ""
