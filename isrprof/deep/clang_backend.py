"""libclang backend: compile-accurate symbols and references without producing a binary.

Per translation unit (in parallel, cached):

* definitions of functions, C++ methods (incl. qualified names, overloads, virtual + overrides),
  constructors / destructors, function templates, lambdas (attributed to the enclosing function)
* calls: direct, member, virtual (the override set is attached as candidates), through function pointers
  (candidates = address-taken functions of the file / dispatch tables), constructors
* references to global / static / class-static variables and to members of global objects, each classified
  read / write / read-write / address-of
* heap: new / delete and the configured heap functions
* HW register macros, accessor macros and IPC macros from the preprocessing record (the token layout rules of
  the profile apply unchanged)

Flags come from compile_commands.json (per file), ``deep.target`` (``--target=arm-none-eabi``),
``deep.extra_args`` and ``deep.sysroot``; missing system headers only degrade the result for the symbols
they declare - the parse continues (``-ferror-limit=0``).
"""
from __future__ import annotations

import hashlib
import os
import pickle
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

from . import DEEP_VERSION, FnSym, SymbolGraph, VarSym, translation_units

_KINDS_FN = None


def _ci():
    import clang.cindex as ci  # type: ignore
    return ci


def available() -> tuple[bool, str]:
    try:
        ci = _ci()
        ci.Index.create()
        return True, "libclang"
    except Exception as e:  # pragma: no cover
        return False, f"libclang unavailable: {e} (pip install libclang)"


# ------------------------------------------------------------------------------------------ flags

def tu_args(cfg, path: str) -> list[str]:
    deep = cfg.build.get("deep") or {}
    args: list[str] = []
    fd = cfg.build.get("file_defines", {}).get(path, {})
    for k, v in fd.items():
        args.append(f"-D{k}={v}" if v not in ("", "1") else f"-D{k}")
    for k, v in (cfg.build.get("defines") or {}).items():
        if k not in fd:
            args.append(f"-D{k}={v}" if v not in ("", "1") else f"-D{k}")
    for inc in cfg.build.get("include_dirs") or []:
        args.append(f"-I{inc}")
    args.append(f"-I{cfg.src_root}")
    cxx = path.endswith((".cc", ".cpp", ".cxx", ".c++", ".C"))
    std = deep.get("std_cxx" if cxx else "std_c") or deep.get("std") or ("c++17" if cxx else "gnu11")
    if cxx and not std.startswith(("c++", "gnu++")):
        std = "c++17"
    if not cxx and std.startswith(("c++", "gnu++")):
        std = "gnu11"
    args.append(f"-std={std}")
    if deep.get("target"):
        args.append(f"--target={deep['target']}")
    if deep.get("sysroot"):
        args.append(f"--sysroot={deep['sysroot']}")
    args += list(deep.get("extra_args") or ["-ffreestanding"])
    # fallback freestanding headers (stdint.h, stddef.h, <new> ...) when the toolchain sysroot is not available;
    # -isystem after the user include dirs so real headers win
    args += ["-isystem", os.path.join(os.path.dirname(os.path.abspath(__file__)), "include")]
    args += ["-Wno-everything", "-ferror-limit=0", "-fparse-all-comments"]
    if cxx:
        args.append("-x"); args.append("c++")
    return args


# ------------------------------------------------------------------------------------------ worker

def _qualified(cur) -> tuple[str, str]:
    """(qualified name, class name) for a function / method cursor."""
    ci = _ci()
    parts, cls = [], ""
    p = cur.semantic_parent
    while p is not None and p.kind not in (ci.CursorKind.TRANSLATION_UNIT,):
        if p.kind in (ci.CursorKind.NAMESPACE, ci.CursorKind.CLASS_DECL, ci.CursorKind.STRUCT_DECL, ci.CursorKind.CLASS_TEMPLATE, ci.CursorKind.UNION_DECL):
            if p.spelling:
                parts.append(p.spelling)
                if not cls and p.kind != ci.CursorKind.NAMESPACE:
                    cls = p.spelling
        p = p.semantic_parent
    parts.reverse()
    return "::".join(parts + [cur.spelling]), cls


def _tokens_text(cur) -> list[str]:
    try:
        return [t.spelling for t in cur.get_tokens()]
    except Exception:
        return []


def _binop(cur) -> str:
    """Operator token of a binary / compound-assignment operator cursor."""
    kids = list(cur.get_children())
    if len(kids) < 2:
        return ""
    end = kids[0].extent.end.offset
    for t in cur.get_tokens():
        if t.extent.start.offset >= end:
            return t.spelling
    return ""


def _unop(cur) -> str:
    toks = _tokens_text(cur)
    if not toks:
        return ""
    if toks[0] in ("++", "--", "&", "*", "-", "!", "~", "+"):
        return toks[0]
    return toks[-1] if toks[-1] in ("++", "--") else ""


def _rw_of(ref_cur, ancestors) -> str:
    """Read / write classification of a variable reference from its ancestor chain."""
    ci = _ci()
    child = ref_cur
    for anc in reversed(ancestors):
        k = anc.kind
        if k in (ci.CursorKind.MEMBER_REF_EXPR, ci.CursorKind.ARRAY_SUBSCRIPT_EXPR, ci.CursorKind.UNEXPOSED_EXPR, ci.CursorKind.PAREN_EXPR, ci.CursorKind.CSTYLE_CAST_EXPR):
            if k == ci.CursorKind.ARRAY_SUBSCRIPT_EXPR:
                kids = list(anc.get_children())
                if kids and kids[0] != child and not _same(kids[0], child):
                    return "r"          # used as the index
            child = anc
            continue
        if k == ci.CursorKind.UNARY_OPERATOR:
            op = _unop(anc)
            if op in ("++", "--"):
                return "rw"
            if op == "&":
                return "addr"
            if op == "*":
                child = anc
                continue            # deref of a pointer variable: the pointer itself is read
            return "r"
        if k in (ci.CursorKind.BINARY_OPERATOR, ci.CursorKind.COMPOUND_ASSIGNMENT_OPERATOR):
            kids = list(anc.get_children())
            lhs = kids[0] if kids else None
            if lhs is not None and _same(lhs, child):
                op = _binop(anc)
                if k == ci.CursorKind.COMPOUND_ASSIGNMENT_OPERATOR or op.endswith("=") and op not in ("==", "!=", "<=", ">="):
                    return "rw" if k == ci.CursorKind.COMPOUND_ASSIGNMENT_OPERATOR else "w"
            return "r"
        return "r"
    return "r"


def _same(a, b) -> bool:
    try:
        return a.extent.start.offset == b.extent.start.offset and a.extent.end.offset == b.extent.end.offset
    except Exception:
        return False


def _base_var(cur):
    """For a MEMBER_REF_EXPR chain `g.a.b`: (base DECL_REF cursor, member chain) or (None, '')."""
    ci = _ci()
    chain = []
    c = cur
    while c is not None and c.kind in (ci.CursorKind.MEMBER_REF_EXPR, ci.CursorKind.ARRAY_SUBSCRIPT_EXPR, ci.CursorKind.UNEXPOSED_EXPR, ci.CursorKind.PAREN_EXPR):
        if c.kind == ci.CursorKind.MEMBER_REF_EXPR:
            chain.append(c.spelling)
        kids = list(c.get_children())
        c = kids[0] if kids else None
    if c is not None and c.kind == ci.CursorKind.DECL_REF_EXPR:
        return c, ".".join(reversed(chain))
    return None, ""


def _var_key(ref, src_root) -> tuple[str, str] | None:
    """(key, kind) for a VAR_DECL cursor that is worth tracking (not a plain local)."""
    ci = _ci()
    sc = ref.storage_class
    parent = ref.semantic_parent
    pk = parent.kind if parent is not None else None
    if pk in (ci.CursorKind.FUNCTION_DECL, ci.CursorKind.CXX_METHOD, ci.CursorKind.CONSTRUCTOR, ci.CursorKind.DESTRUCTOR, ci.CursorKind.FUNCTION_TEMPLATE, ci.CursorKind.LAMBDA_EXPR):
        if sc == ci.StorageClass.STATIC:
            return f"{ref.spelling}@{parent.spelling}", "static_local"
        return None
    if pk in (ci.CursorKind.CLASS_DECL, ci.CursorKind.STRUCT_DECL, ci.CursorKind.CLASS_TEMPLATE):
        return f"{parent.spelling}::{ref.spelling}", "global"           # class-static member
    if ref.linkage == ci.LinkageKind.INTERNAL or sc == ci.StorageClass.STATIC:
        return f"{ref.spelling}@{os.path.basename(ref.location.file.name) if ref.location.file else '?'}", "static"
    if ref.linkage in (ci.LinkageKind.EXTERNAL, ci.LinkageKind.UNIQUE_EXTERNAL):
        return ref.spelling, "global"
    if pk == ci.CursorKind.NAMESPACE:
        return ref.spelling, "global"
    return None


def _overrides_via_bases(cur, fn_id) -> list[str]:
    """Fallback when libclang's overridden-cursor list is empty: same-named virtual methods of the base classes."""
    ci = _ci()
    out: list[str] = []
    cls = cur.semantic_parent
    if cls is None:
        return out
    stack = [cls]
    seen = set()
    while stack:
        c = stack.pop()
        for ch in c.get_children():
            if ch.kind == ci.CursorKind.CXX_BASE_SPECIFIER:
                base = ch.referenced
                if base is None:
                    base = ch.type.get_declaration()
                if base is None or base.get_usr() in seen:
                    continue
                seen.add(base.get_usr())
                for m in base.get_children():
                    if m.kind == ci.CursorKind.CXX_METHOD and m.spelling == cur.spelling and m.is_virtual_method():
                        fid = fn_id(m)[0]
                        if fid not in out:
                            out.append(fid)
                stack.append(base)
    return out


def analyze_tu(job: dict) -> dict:
    """Worker: analyse one translation unit; returns plain dicts (picklable)."""
    ci = _ci()
    path, args, src_root, hw_cfg, mem_cfg = job["path"], job["args"], job["src_root"], job["hw"], job["mem"]
    t0 = time.perf_counter()
    out = {"path": path, "functions": [], "variables": [], "headers": set(), "address_taken": [], "overrides": {}, "diag": 0, "ms": 0}
    try:
        idx = ci.Index.create()
        tu = idx.parse(path, args=args, options=ci.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD)
    except Exception as e:
        out["error"] = str(e)
        return out
    out["diag"] = sum(1 for d in tu.diagnostics if d.severity >= ci.Diagnostic.Error)
    nsrc = os.path.normcase(os.path.abspath(src_root))
    main = os.path.normcase(os.path.abspath(path))

    def in_tree(loc) -> bool:
        if not loc.file:
            return False
        f = os.path.normcase(os.path.abspath(loc.file.name))
        return f == main or f.startswith(nsrc + os.sep)

    heap_funcs = set(mem_cfg["heap_functions"])
    FN_KINDS = (ci.CursorKind.FUNCTION_DECL, ci.CursorKind.CXX_METHOD, ci.CursorKind.CONSTRUCTOR, ci.CursorKind.DESTRUCTOR,
                ci.CursorKind.FUNCTION_TEMPLATE, ci.CursorKind.CONVERSION_FUNCTION)
    fns: list[dict] = []
    fn_by_usr: dict[str, dict] = {}
    seen_defs: set[str] = set()

    def fn_id(cur) -> tuple[str, str, str]:
        qname, cls = _qualified(cur)
        static = cur.linkage == ci.LinkageKind.INTERNAL
        fid = qname
        if static and cur.location.file:
            fid = f"{qname}@{os.path.basename(cur.location.file.name)}"
        return fid, qname, cls

    def record_def(cur):
        usr = cur.get_usr()
        if usr in seen_defs:
            return None
        seen_defs.add(usr)
        fid, qname, cls = fn_id(cur)
        kind = {ci.CursorKind.CXX_METHOD: "method", ci.CursorKind.CONSTRUCTOR: "ctor", ci.CursorKind.DESTRUCTOR: "dtor",
                ci.CursorKind.FUNCTION_TEMPLATE: "template", ci.CursorKind.CONVERSION_FUNCTION: "method"}.get(cur.kind, "function")
        virtual = cur.kind == ci.CursorKind.CXX_METHOD and cur.is_virtual_method()
        overrides = []
        if cur.kind == ci.CursorKind.CXX_METHOD:
            try:
                for o in cur.get_overridden_cursors():
                    overrides.append(fn_id(o)[0])
            except Exception:
                pass
            if not overrides and virtual:
                overrides = _overrides_via_bases(cur, fn_id)
        sig = " ".join(_tokens_text(cur)[:24])
        sig = sig[:sig.find("{")] if "{" in sig else sig
        rec = {"id": fid, "name": qname, "short": cur.spelling, "file": os.path.abspath(cur.location.file.name), "line": cur.location.line,
               "end_line": cur.extent.end.line, "kind": kind, "cls": cls, "static": cur.linkage == ci.LinkageKind.INTERNAL,
               "virtual": virtual, "overrides": overrides, "signature": sig.strip()[:160], "usr": usr,
               "calls": [], "refs": [], "hw": [], "heap": [], "ipc": [], "static_locals": [], "start_off": cur.extent.start.offset, "end_off": cur.extent.end.offset}
        fns.append(rec)
        fn_by_usr[usr] = rec
        if os.path.normcase(rec["file"]) != main:
            out["headers"].add(rec["file"])
        for o in overrides:
            out["overrides"].setdefault(o, []).append(fid)
        return rec

    def ref_fid(ref) -> str | None:
        if ref is None:
            return None
        if ref.kind in FN_KINDS:
            d = ref.get_definition() or ref
            return fn_id(d)[0]
        return None

    ptr_cache: dict[str, list[str]] = {}
    assigned: dict[str, list[str]] = {}            # usr of a pointer variable / field -> functions assigned to it anywhere in the TU

    def fns_in(cur) -> list[str]:
        out: list[str] = []
        for ch in cur.walk_preorder():
            if ch.kind == ci.CursorKind.DECL_REF_EXPR:
                r = ch.referenced
                if r is not None and r.kind in FN_KINDS:
                    fid = ref_fid(r)
                    if fid and fid not in out:
                        out.append(fid)
        return out

    def ptr_targets(ref) -> list[str]:
        usr = ref.get_usr()
        if usr in ptr_cache:
            return ptr_cache[usr]
        out: list[str] = []
        d = ref.get_definition() or ref
        for ch in d.get_children():               # the initializer (one function, or an init list of functions)
            if ch.kind not in (ci.CursorKind.TYPE_REF, ci.CursorKind.TEMPLATE_REF, ci.CursorKind.NAMESPACE_REF):
                out += [x for x in fns_in(ch) if x not in out]
        for x in assigned.get(usr, []):
            if x not in out:
                out.append(x)
        ptr_cache[usr] = out
        return out

    def collect_assignments(cur):
        """`ptr = fn;` / `obj.cb = fn;` / aggregate initializers of struct variables: remember fn per target symbol."""
        if cur.kind in (ci.CursorKind.BINARY_OPERATOR,) and _binop(cur) == "=":
            kids = list(cur.get_children())
            if len(kids) == 2:
                tgt = kids[0]
                while tgt is not None and tgt.kind in (ci.CursorKind.UNEXPOSED_EXPR, ci.CursorKind.PAREN_EXPR, ci.CursorKind.ARRAY_SUBSCRIPT_EXPR):
                    kk = list(tgt.get_children()); tgt = kk[0] if kk else None
                if tgt is not None and tgt.referenced is not None and tgt.referenced.kind in (ci.CursorKind.VAR_DECL, ci.CursorKind.FIELD_DECL):
                    lst = assigned.setdefault(tgt.referenced.get_usr(), [])
                    for x in fns_in(kids[1]):
                        if x not in lst:
                            lst.append(x)
        if cur.kind == ci.CursorKind.VAR_DECL:           # struct initializer `static Ctl g = { fn, 0 }` -> the fields of that struct
            td = cur.type.get_declaration()
            fields = [f for f in td.get_children() if f.kind == ci.CursorKind.FIELD_DECL] if td is not None and td.kind in (ci.CursorKind.STRUCT_DECL, ci.CursorKind.CLASS_DECL) else []
            if fields:
                for ch in cur.get_children():
                    if ch.kind == ci.CursorKind.INIT_LIST_EXPR:
                        for fld, val in zip(fields, ch.get_children()):
                            lst = assigned.setdefault(fld.get_usr(), [])
                            for x in fns_in(val):
                                if x not in lst:
                                    lst.append(x)
        for ch in cur.get_children():
            collect_assignments(ch)

    def walk(cur, fn, ancestors):
        k = cur.kind
        if k in FN_KINDS and cur.is_definition() and in_tree(cur.location):
            rec = record_def(cur)
            if rec is not None:
                for ch in cur.get_children():
                    walk(ch, rec, [cur])
                return
        if fn is not None:
            loc = cur.location
            if k == ci.CursorKind.CALL_EXPR:
                ref = cur.referenced
                name = cur.spelling or (ref.spelling if ref is not None else "")
                callee_id = ref_fid(ref)
                kind = "direct"
                cands: list[str] = []
                if ref is not None and ref.kind in (ci.CursorKind.VAR_DECL, ci.CursorKind.FIELD_DECL):
                    cands = ptr_targets(ref)                      # functions stored in that pointer / table / field
                if ref is None or ref.kind in (ci.CursorKind.VAR_DECL, ci.CursorKind.FIELD_DECL, ci.CursorKind.PARM_DECL):
                    kind = "indirect"
                    if ref is None and not name:          # dependent / unresolved call: the callee's spelling from the tokens
                        kids = list(cur.get_children())
                        toks = _tokens_text(kids[0]) if kids else []
                        name = next((t for t in reversed(toks) if t.isidentifier()), "") if toks else ""
                        if name:
                            kind = "member"
                    name = name or (ref.spelling if ref is not None else "(fnptr)")
                elif ref.kind == ci.CursorKind.CXX_METHOD:
                    kind = "virtual" if ref.is_virtual_method() else "member"
                elif ref.kind == ci.CursorKind.CONSTRUCTOR:
                    kind = "ctor"
                if name in heap_funcs:
                    fn["heap"].append({"fn": name, "line": loc.line, "col": loc.column})
                elif name:
                    fn["calls"].append({"callee": name, "callee_id": callee_id, "line": loc.line, "col": loc.column, "kind": kind, "candidates": cands})
                    # registered access functions: the call is also a HW register / shared-variable access
                    if name in job["hw_fns"] or name in job["acc_fns"]:
                        toks = [t.spelling for t in cur.get_tokens()]
                        if "(" in toks:
                            inner = toks[toks.index("(") + 1:-1] if toks and toks[-1] == ")" else toks[toks.index("(") + 1:]
                            args, curarg, depth = [], [], 0
                            for t in inner:
                                if t in "([{": depth += 1
                                elif t in ")]}": depth -= 1
                                if t == "," and depth == 0: args.append(" ".join(curarg)); curarg = []
                                else: curarg.append(t)
                            if curarg or args: args.append(" ".join(curarg))
                            fn.setdefault("fn_access", []).append({"name": name, "args": args, "line": loc.line, "col": loc.column})
            elif k == ci.CursorKind.CXX_NEW_EXPR:
                fn["heap"].append({"fn": "new", "line": loc.line, "col": loc.column})
            elif k == ci.CursorKind.CXX_DELETE_EXPR:
                fn["heap"].append({"fn": "delete", "line": loc.line, "col": loc.column})
            elif k == ci.CursorKind.DECL_REF_EXPR:
                ref = cur.referenced
                if ref is not None:
                    if ref.kind == ci.CursorKind.VAR_DECL:
                        vk = _var_key(ref, src_root)
                        if vk:
                            key, vkind = vk
                            # is this reference the base of a member chain?  (handled by the MEMBER_REF_EXPR ancestor)
                            member = ""
                            for anc in reversed(ancestors):
                                if anc.kind == ci.CursorKind.MEMBER_REF_EXPR:
                                    b, chain = _base_var(anc)
                                    if b is not None and _same(b, cur):
                                        member = chain
                                    break
                                if anc.kind not in (ci.CursorKind.UNEXPOSED_EXPR, ci.CursorKind.PAREN_EXPR, ci.CursorKind.ARRAY_SUBSCRIPT_EXPR):
                                    break
                            rw = _rw_of(cur, ancestors)
                            fn["refs"].append({"var": key.split("@")[0] if vkind != "global" else key, "key": key, "rw": rw, "line": loc.line, "col": loc.column,
                                               "member": member, "kind": vkind})
                            if vkind == "static_local" and ref.spelling not in fn["static_locals"]:
                                fn["static_locals"].append(ref.spelling)
                            if key not in job["seen_vars"]:
                                job["seen_vars"][key] = {"key": key, "name": key.split("@")[0], "file": os.path.abspath(ref.location.file.name) if ref.location.file else "<unknown>",
                                                         "line": ref.location.line, "kind": vkind, "type": ref.type.spelling, "decl": f"{ref.type.spelling} {ref.spelling}"}
                    elif ref.kind in FN_KINDS and not _in_callee_position(cur, ancestors):
                        fid = ref_fid(ref)
                        if fid and fid not in out["address_taken"]:
                            out["address_taken"].append(fid)
        for ch in cur.get_children():
            walk(ch, fn, ancestors + [cur] if fn is not None else ancestors)

    def _in_callee_position(ref_cur, ancestors) -> bool:
        # walk up through the wrappers libclang puts around a callee (UNEXPOSED_EXPR, PAREN, MEMBER_REF) to the CALL_EXPR
        for anc in reversed(ancestors):
            if anc.kind == ci.CursorKind.CALL_EXPR:
                return _is_callee(anc, ref_cur)
            if anc.kind not in (ci.CursorKind.UNEXPOSED_EXPR, ci.CursorKind.PAREN_EXPR, ci.CursorKind.MEMBER_REF_EXPR):
                return False
        return False

    def _is_callee(call_cur, ref_cur) -> bool:
        kids = list(call_cur.get_children())
        if not kids:
            return False
        c = kids[0]
        a, b = c.extent.start.offset, c.extent.end.offset
        return a <= ref_cur.extent.start.offset and ref_cur.extent.end.offset <= b

    job["seen_vars"] = {}
    for ch in tu.cursor.get_children():
        if in_tree(ch.location):
            collect_assignments(ch)
    job["hw_fns"] = {m["name"] for m in hw_cfg.get("custom", []) if m.get("function")}
    job["acc_fns"] = {m["name"] for m in mem_cfg.get("access_macros", []) if m.get("function")}
    for ch in tu.cursor.get_children():
        walk(ch, None, [])
    # macros from the preprocessing record: HW register / accessor / IPC macros inside function bodies
    hw_names = set(hw_cfg["read"]) | set(hw_cfg["write"]) | set(hw_cfg["rmw"]) | {m["name"] for m in hw_cfg.get("custom", [])}
    acc_names = {m["name"] for m in mem_cfg.get("access_macros", [])}
    ipc_names = set(mem_cfg["ipc_macros"])
    if hw_names or acc_names or ipc_names:
        from ..cparser import CParser, Tok, _split_args, _join

        class _Cfg:              # minimal stand-in so CParser's macro spec logic can be reused in the worker
            hw_macros = hw_cfg
            memory = mem_cfg
            hw_blocks = [type("B", (), {"id": b}) for b in hw_cfg.get("block_ids", [])]
            parser = {"ignore_calls": []}
        cp = CParser(_Cfg())
        spans = [(f["start_off"], f["end_off"], f) for f in fns if os.path.normcase(f["file"]) == main]
        for cur in tu.cursor.get_children():
            if cur.kind != ci.CursorKind.MACRO_INSTANTIATION or not in_tree(cur.location):
                continue
            name = cur.spelling
            if name not in hw_names and name not in acc_names and name not in ipc_names:
                continue
            off = cur.extent.start.offset
            fn = next((f for a, b, f in spans if a <= off <= b), None)
            if fn is None:
                continue
            toks = [Tok("id" if t.kind == ci.TokenKind.IDENTIFIER else "op", t.spelling, t.location.line) for t in tu.get_tokens(extent=cur.extent)]
            if len(toks) < 3 or toks[1].text != "(":
                continue
            args_t = _split_args(toks[2:-1])
            line, col = cur.location.line, cur.location.column
            if name in hw_names:
                acc = cp._hw_from_call(name, args_t, line, 0)
                if acc:
                    fn["hw"].append({"macro": name, "kind": acc.kind, "block": acc.block, "reg": acc.reg, "line": line, "col": col})
            elif name in acc_names:
                am = cp.access_macros[name]
                var = am.get("var") or (_join(args_t[am["var_arg"]]) if am.get("var_arg") is not None and len(args_t) > am["var_arg"] else "?")
                fld = _join(args_t[am["field_arg"]]).replace(" ", "") if am.get("field_arg") is not None and len(args_t) > am["field_arg"] else ""
                fn["refs"].append({"var": var, "key": var, "rw": am.get("rw", "r"), "line": line, "col": col, "member": fld, "kind": "global", "via_macro": name})
            else:
                ch = _join(args_t[mem_cfg["ipc_channel_arg"]]) if len(args_t) > mem_cfg["ipc_channel_arg"] else "?"
                fn["ipc"].append({"macro": name, "channel": ch, "line": line, "col": col})
    # access functions -> HW / variable entries (same argument rules as the macros)
    if any(f.get("fn_access") for f in fns):
        from ..cparser import CParser, Tok, _join

        class _Cfg2:
            hw_macros = hw_cfg
            memory = mem_cfg
            hw_blocks = [type("B", (), {"id": b}) for b in hw_cfg.get("block_ids", [])]
            parser = {"ignore_calls": []}
        cp2 = CParser(_Cfg2())
        for f in fns:
            for fa in f.pop("fn_access", []):
                args_t = [[Tok("id", a, fa["line"])] for a in fa["args"]]
                if fa["name"] in job["hw_fns"]:
                    acc = cp2._hw_from_call(fa["name"], args_t, fa["line"], 0)
                    if acc:
                        f["hw"].append({"macro": fa["name"], "kind": acc.kind, "block": acc.block, "reg": acc.reg, "line": fa["line"], "col": fa["col"]})
                else:
                    am = cp2.access_macros[fa["name"]]
                    var = am.get("var") or (_join(args_t[am["var_arg"]]).lstrip("&") if am.get("var_arg") is not None and len(args_t) > am["var_arg"] else "?")
                    fld = am.get("field") or (_join(args_t[am["field_arg"]]).replace(" ", "") if am.get("field_arg") is not None and len(args_t) > am["field_arg"] else "")
                    f["refs"].append({"var": var, "key": var, "rw": am.get("rw", "r"), "line": fa["line"], "col": fa["col"], "member": fld, "kind": "global", "via_macro": fa["name"]})
    for f in fns:
        f.pop("start_off", None); f.pop("end_off", None)
    out["functions"] = fns
    out["variables"] = list(job["seen_vars"].values())
    out["headers"] = sorted(out["headers"])
    out["ms"] = round((time.perf_counter() - t0) * 1000)
    return out


# ------------------------------------------------------------------------------------------ driver

def _cache_key(path: str, args: list[str]) -> str:
    st = os.stat(path)
    h = hashlib.sha1(f"{DEEP_VERSION}|{path}|{st.st_mtime_ns}|{st.st_size}|{'|'.join(args)}".encode("utf-8")).hexdigest()
    return h


def analyze(cfg) -> SymbolGraph:
    g = SymbolGraph(backend="clang")
    ok, why = available()
    if not ok:
        g.log.append(why)
        return g
    deep = cfg.build.get("deep") or {}
    tus = translation_units(cfg)
    limit = int(deep.get("max_files", 0) or 0)
    if limit and len(tus) > limit:
        g.log.append(f"deep scope limited to the first {limit} of {len(tus)} translation units (deep.max_files)")
        tus = tus[:limit]
    cache_dir = os.path.join(cfg.output["dir"], ".cache", "deep") if cfg.build.get("cache", True) and deep.get("cache", True) else None
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
    hw_cfg = dict(cfg.hw_macros, block_ids=[b.id for b in cfg.hw_blocks])
    mem_cfg = cfg.memory
    jobs, results, hits = [], [], 0
    t0 = time.perf_counter()
    for path in tus:
        args = tu_args(cfg, path)
        key = _cache_key(path, args)
        if cache_dir:
            cp = os.path.join(cache_dir, key + ".pkl")
            if os.path.isfile(cp):
                try:
                    with open(cp, "rb") as fh:
                        results.append(pickle.load(fh))
                    hits += 1
                    continue
                except Exception:
                    pass
        jobs.append({"path": path, "args": args, "src_root": cfg.src_root, "hw": hw_cfg, "mem": mem_cfg, "key": key})
    jobs_n = int(deep.get("jobs", 0) or 0) or max(1, (os.cpu_count() or 2) - 1)
    if jobs:
        if jobs_n > 1 and len(jobs) > 1:
            with ProcessPoolExecutor(max_workers=min(jobs_n, len(jobs))) as ex:
                futs = {ex.submit(analyze_tu, j): j for j in jobs}
                for fut in as_completed(futs):
                    j = futs[fut]
                    try:
                        r = fut.result()
                    except Exception as e:  # pragma: no cover
                        r = {"path": j["path"], "error": str(e), "functions": [], "variables": [], "headers": [], "address_taken": [], "overrides": {}, "diag": 0, "ms": 0}
                    results.append(r)
                    if cache_dir and "error" not in r:
                        with open(os.path.join(cache_dir, j["key"] + ".pkl"), "wb") as fh:
                            pickle.dump(r, fh)
        else:
            for j in jobs:
                r = analyze_tu(j)
                results.append(r)
                if cache_dir and "error" not in r:
                    with open(os.path.join(cache_dir, j["key"] + ".pkl"), "wb") as fh:
                        pickle.dump(r, fh)
    errors, diags = 0, 0
    for r in results:
        g.files.append(r["path"])
        if r.get("error"):
            errors += 1
            g.log.append(f"{os.path.basename(r['path'])}: {r['error']}")
            continue
        diags += r.get("diag", 0)
        for fr in r["functions"]:
            fid = fr["id"]
            if fid in g.functions and g.functions[fid].usr != fr["usr"]:
                n = 2
                while f"{fid}#{n}" in g.functions:
                    n += 1
                fid = f"{fid}#{n}"
            fn = FnSym(id=fid, name=fr["name"], short=fr["short"], file=fr["file"], line=fr["line"], end_line=fr["end_line"], kind=fr["kind"], cls=fr["cls"],
                       static=fr["static"], virtual=fr["virtual"], overrides=fr["overrides"], signature=fr["signature"], usr=fr["usr"],
                       calls=fr["calls"], refs=fr["refs"], hw=fr["hw"], heap=fr["heap"], ipc=fr["ipc"], static_locals=fr["static_locals"])
            if fid not in g.functions:
                g.functions[fid] = fn
        for v in r["variables"]:
            g.variables.setdefault(v["key"], VarSym(key=v["key"], name=v["name"], file=v["file"], line=v["line"], kind=v["kind"], decl=v["decl"], type=v["type"]))
        for base, derived in r["overrides"].items():
            lst = g.overrides.setdefault(base, [])
            for d in derived:
                if d not in lst:
                    lst.append(d)
        for h in r["headers"]:
            if h not in g.headers:
                g.headers.append(h)
        if r["address_taken"]:
            g.address_taken[r["path"]] = list(r["address_taken"])
    # virtual calls: attach the override set as candidates; member calls that could not be resolved: all methods of that short name
    by_short: dict[str, list[str]] = {}
    for fid, fn in g.functions.items():
        by_short.setdefault(fn.short, []).append(fid)
    for fn in g.functions.values():
        for c in fn.calls:
            if c["kind"] == "virtual" and c.get("callee_id"):
                c["candidates"] = [c["callee_id"]] + [d for d in g.overrides.get(c["callee_id"], []) if d != c["callee_id"]]
                # overrides of overrides
                frontier = list(c["candidates"])
                while frontier:
                    x = frontier.pop()
                    for d in g.overrides.get(x, []):
                        if d not in c["candidates"]:
                            c["candidates"].append(d); frontier.append(d)
            elif c["kind"] == "indirect" and not c.get("candidates"):
                c["candidates"] = list(g.address_taken.get(fn.file, []))
            elif c["kind"] == "member" and not c.get("callee_id"):
                c["candidates"] = list(by_short.get(c["callee"], []))
    g.stats = {"translation_units": len(tus), "cache_hits": hits, "analysed": len(jobs), "errors": errors, "error_diagnostics": diags,
               "ms": round((time.perf_counter() - t0) * 1000), "jobs": jobs_n}
    if diags:
        g.log.append(f"{diags} compiler error diagnostics (missing system headers?) - symbols they declare may be incomplete; set deep.sysroot / deep.extra_args")
    return g
