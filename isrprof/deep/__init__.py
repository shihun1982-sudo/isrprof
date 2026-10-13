"""Deep (build-based) analysis.

The builtin token parser (:mod:`isrprof.cparser`) works on any tree without a build.  When
``build.deep.enabled`` is on, the profile's build information (compile_commands.json flags, cmake /
build command, toolchain) is used to analyse the code *the way the compiler sees it*:

* ``clang`` backend  - libclang (``pip install libclang``) parses every translation unit in scope with its
  real -D / -I / -std flags and a cross target (``--target=arm-none-eabi``).  No binary is produced, but
  the result is what a build would resolve: C++ methods, namespaces, overloads, templates, virtual calls
  (with their overrides), member accesses of global objects, static / global / member symbols, new /
  delete, and the exact read / write direction of every reference.
* ``objects`` backend - the real build: optionally runs the configured cmake / build commands, then reads
  the object files with the toolchain's ``nm`` / ``objdump`` (relocations = call and data references).
  This is the linker's truth, usable when the (ARM) toolchain is installed on the analysis machine.

Both produce a :class:`SymbolGraph`; :func:`apply` merges it into the token parser's
:class:`~isrprof.cparser.ParseResult` (precise functions replace the token-level ones, new functions are
added), so the rest of the pipeline - call trees, timing, structure, impact - is unchanged.

Scope: ``deep.scope`` (globs / SW node ids) limits the translation units analysed deeply; everything else
stays on the fast token parser, so a big tree can be analysed module by module.  Results are cached per
translation unit (file mtime + flags), so re-runs only re-analyse what changed.
"""
from __future__ import annotations

import fnmatch
import os
import time
from dataclasses import dataclass, field

from ..cparser import Call, FunctionDef, HwAccess, IpcOp, ParseResult, VarAccess, VarDef

DEEP_VERSION = 1


@dataclass
class FnSym:
    id: str                    # function id (qualified name; `name@file.c` for file statics; overloads get `#n`)
    name: str                  # display name (qualified)
    short: str                 # unqualified name
    file: str
    line: int
    end_line: int
    kind: str = "function"     # function | method | ctor | dtor | template | lambda
    cls: str = ""              # owning class / struct (methods)
    static: bool = False       # internal linkage (file static)
    virtual: bool = False
    overrides: list[str] = field(default_factory=list)   # ids of the methods this one overrides
    signature: str = ""
    usr: str = ""
    calls: list[dict] = field(default_factory=list)      # {callee, callee_id, line, col, kind: direct|virtual|indirect|member, candidates:[ids]}
    refs: list[dict] = field(default_factory=list)       # {var, key, rw, line, member, kind}
    hw: list[dict] = field(default_factory=list)         # {macro, kind, block, reg, line}
    heap: list[dict] = field(default_factory=list)       # {fn, line}
    ipc: list[dict] = field(default_factory=list)        # {macro, channel, line}
    static_locals: list[str] = field(default_factory=list)


@dataclass
class VarSym:
    key: str
    name: str
    file: str
    line: int
    kind: str                  # global | static | extern | member_static | static_local
    decl: str = ""
    type: str = ""


@dataclass
class SymbolGraph:
    backend: str = ""
    functions: dict[str, FnSym] = field(default_factory=dict)
    variables: dict[str, VarSym] = field(default_factory=dict)
    files: list[str] = field(default_factory=list)          # translation units analysed
    headers: list[str] = field(default_factory=list)        # headers with definitions seen
    overrides: dict[str, list[str]] = field(default_factory=dict)   # base method id -> overriding ids
    address_taken: dict[str, list[str]] = field(default_factory=dict)  # file -> function ids whose address is taken
    log: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


# ------------------------------------------------------------------------------------------ scope

def in_scope(cfg, path: str) -> bool:
    deep = cfg.build.get("deep") or {}
    scope, excl = deep.get("scope") or [], deep.get("exclude") or []
    rel = os.path.relpath(path, cfg.src_root).replace("\\", "/")
    base = os.path.basename(path)
    if excl and any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(base, p) for p in excl):
        return False
    if not scope:
        return True
    for pat in scope:
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(base, pat) or rel.startswith(pat.rstrip("/*") + "/"):
            return True
        node = next((n for n in cfg.sw_nodes if n.id == pat), None)       # a SW node id = its files
        if node and any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(base, g) for g in node.files):
            return True
    return False


def translation_units(cfg) -> list[str]:
    exts = (".c", ".cc", ".cpp", ".cxx", ".c++", ".C")
    return [f for f in cfg.sources if f.endswith(exts) and in_scope(cfg, f)]


# ------------------------------------------------------------------------------------------ run + merge

def run(cfg) -> SymbolGraph | None:
    deep = cfg.build.get("deep") or {}
    if not deep.get("enabled"):
        return None
    backend = str(deep.get("backend", "clang"))
    t0 = time.perf_counter()
    graphs: list[SymbolGraph] = []
    if backend in ("clang", "both"):
        from . import clang_backend
        graphs.append(clang_backend.analyze(cfg))
    if backend in ("objects", "both"):
        from . import objects_backend
        graphs.append(objects_backend.analyze(cfg))
    if not graphs:
        g = SymbolGraph(backend=backend)
        g.log.append(f"unknown deep backend {backend!r}")
        return g
    g = graphs[0]
    for extra in graphs[1:]:                 # objects after clang: add edges the frontend could not see
        for fid, fn in extra.functions.items():
            if fid in g.functions:
                known = {(c["callee_id"] or c["callee"]) for c in g.functions[fid].calls}
                for c in fn.calls:
                    if (c["callee_id"] or c["callee"]) not in known:
                        c = dict(c, kind=c.get("kind", "direct") + "+objects")
                        g.functions[fid].calls.append(c)
                knownv = {(r["key"], r["rw"]) for r in g.functions[fid].refs}
                for r in fn.refs:
                    if (r["key"], r["rw"]) not in knownv:
                        g.functions[fid].refs.append(r)
            else:
                g.functions[fid] = fn
        g.variables.update({k: v for k, v in extra.variables.items() if k not in g.variables})
        g.files = sorted(set(g.files) | set(extra.files))
        g.log += extra.log
        g.stats["objects"] = extra.stats
    g.stats["total_ms"] = round((time.perf_counter() - t0) * 1000)
    return g


def apply(cfg, pr: ParseResult, g: SymbolGraph) -> dict:
    """Merge the deep symbol graph into the token parser's result.  Returns the stats for the profile."""
    by_file_name: dict[tuple[str, str], FunctionDef] = {}
    by_id: dict[str, FunctionDef] = {}
    for f in pr.functions:
        by_file_name[(os.path.normcase(f.file), f.name)] = f
        by_id[f.id] = f
    replaced, added = 0, 0
    deep_files = {os.path.normcase(f) for f in g.files} | {os.path.normcase(h) for h in g.headers}
    by_file: dict[str, list[FunctionDef]] = {}
    for f in pr.functions:
        by_file.setdefault(os.path.normcase(f.file), []).append(f)
    matched: set[int] = set()

    def match(fn: FnSym) -> FunctionDef | None:
        nf = os.path.normcase(fn.file)
        cands = [f for f in by_file.get(nf, []) if id(f) not in matched and (f.name == fn.name or f.name == fn.short or f.name.endswith('::' + fn.short) or fn.name.endswith('::' + f.name))]
        if not cands:
            cands = [f for f in by_file.get(nf, []) if id(f) not in matched and abs(f.line - fn.line) <= 1]
        if not cands:
            return None
        return min(cands, key=lambda f: abs(f.line - fn.line))

    for fid, fn in g.functions.items():
        fd = by_id.get(fid) if id(by_id.get(fid, None)) not in matched else None
        if fd is None:
            fd = match(fn)
        if fd is not None:
            matched.add(id(fd))
        if fd is None:
            fd = FunctionDef(name=fn.name, file=fn.file, line=fn.line, end_line=fn.end_line, is_static=fn.static,
                             signature=fn.signature or fn.name)
            fd.id_override = fid          # type: ignore[attr-defined]
            pr.functions.append(fd)
            added += 1
        else:
            replaced += 1
            if fn.name != fd.name and "::" in fn.name:
                fd.name = fn.name         # qualified C++ name
            fd.id_override = fid          # type: ignore[attr-defined]
        fd.deep = True                    # type: ignore[attr-defined]
        fd.kind = fn.kind                 # type: ignore[attr-defined]
        fd.cls = fn.cls                   # type: ignore[attr-defined]
        fd.virtual = fn.virtual           # type: ignore[attr-defined]
        fd.overrides = fn.overrides       # type: ignore[attr-defined]
        # sequenced events in source order
        events: list[tuple[int, int, str, dict]] = []
        for c in fn.calls:
            events.append((c["line"], c.get("col", 0), "call", c))
        for h in fn.hw:
            events.append((h["line"], h.get("col", 0), "hw", h))
        for r in fn.refs:
            events.append((r["line"], r.get("col", 0), "ref", r))
        for hp in fn.heap:
            events.append((hp["line"], hp.get("col", 0), "heap", hp))
        for i in fn.ipc:
            events.append((i["line"], i.get("col", 0), "ipc", i))
        events.sort(key=lambda e: (e[0], e[1]))
        fd.calls, fd.hw, fd.vars, fd.heap, fd.ipc = [], [], [], [], []
        seq = 0
        for line, _col, kind, obj in events:
            if kind in ("call", "hw", "heap", "ipc"):
                seq += 1
            if kind == "call":
                ck, cid = obj.get("kind", "direct"), obj.get("callee_id")
                cands = list(obj.get("candidates") or [])
                # virtual (override set) and function-pointer calls are indirect; a member / ctor / direct call with a
                # resolved target is direct; an unresolved member call (dependent template context) resolves by name
                indirect = ck == "virtual" or ck == "indirect" or (ck in ("member", "direct", "ctor") and not cid)
                call = Call(callee=cid or obj["callee"], line=line, seq=seq, indirect=indirect,
                            member=(not cid and ck in ("member", "indirect", "direct")))
                call.candidates = cands   # type: ignore[attr-defined]
                call.call_kind = ck       # type: ignore[attr-defined]
                fd.calls.append(call)
            elif kind == "hw":
                fd.hw.append(HwAccess(macro=obj["macro"], kind=obj["kind"], block=obj["block"], reg=obj["reg"], line=line, seq=seq))
            elif kind == "ref":
                fd.vars.append(VarAccess(name=obj["var"], rw=obj["rw"], line=line, kind=obj["kind"], seq=seq,
                                         member=obj.get("member", ""), via_macro=obj.get("via_macro", "")))
            elif kind == "heap":
                fd.heap.append(Call(callee=obj["fn"], line=line, seq=seq))
                fd.calls.append(Call(callee=obj["fn"], line=line, seq=seq))
            elif kind == "ipc":
                fd.ipc.append(IpcOp(macro=obj["macro"], channel=obj["channel"], line=line, seq=seq))
                fd.calls.append(Call(callee=obj["macro"], line=line, seq=seq))
        fd.n_seq = max(1, seq)
        fd.static_locals = list(fn.static_locals)
    # token-level entries in deeply analysed files that the frontend did not confirm are stale (macro-generated
    # ISR wrappers, class bodies mistaken for functions ...): the frontend's view is authoritative there
    pr.functions[:] = [f for f in pr.functions if getattr(f, 'deep', False) or os.path.normcase(f.file) not in deep_files]
    # variables the frontend knows (members of classes, namespaced globals ...)
    known = {v.name for v in pr.variables}
    for key, v in g.variables.items():
        if v.name not in known:
            pr.variables.append(VarDef(name=v.name, file=v.file, line=v.line, kind=("static" if v.kind == "static" else "global"), decl=v.decl or v.type))
            known.add(v.name)
    # address-taken functions extend the dispatch-table candidates of their file
    for file, fids in g.address_taken.items():
        lst = pr.table_refs.setdefault(file, [])
        for fid in fids:
            if fid not in lst:
                lst.append(fid)
    stats = {"backend": g.backend, "files": len(g.files), "functions": len(g.functions), "replaced": replaced, "added": added,
             "variables": len(g.variables), "virtual_methods": sum(1 for f in g.functions.values() if f.virtual),
             "deep_files": sorted(os.path.relpath(f, cfg.src_root).replace("\\", "/") for f in g.files),
             "log": g.log[-50:], **{k: v for k, v in g.stats.items()}}
    return stats
