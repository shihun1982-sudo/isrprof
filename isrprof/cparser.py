"""Lightweight C front-end for firmware sources.

Why not a full C parser?  Embedded modem trees are usually not preprocessable
outside their build system (vendor headers, generated register maps, compiler
builtins).  This module therefore works on a *token stream* and recovers what
the profiler needs, without needing a complete include path:

* function definitions (name, file, line range, body tokens)
* direct calls inside each body (including macro invocations)
* HW register access macros  -> block / register / read|write|rmw
* global, file-static and function-static variables, and who reads/writes them
* heap allocation calls and IPC macro invocations
* ``#define`` bodies (so HW macros can be auto-detected by their ``*(volatile`` casts)

A ``libclang`` backend can be plugged in by implementing ``parse_file`` with the
same return types; select it with ``parser.backend: libclang`` in the config.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

KEYWORDS = {
    "if", "else", "for", "while", "do", "switch", "case", "default", "return", "break",
    "continue", "goto", "sizeof", "typedef", "struct", "union", "enum", "static", "extern",
    "const", "volatile", "register", "inline", "__inline", "__inline__", "auto", "void",
    "int", "char", "short", "long", "float", "double", "signed", "unsigned", "_Bool",
    "__attribute__", "__asm__", "asm", "__asm", "_Static_assert", "_Alignas", "_Atomic",
    "restrict", "__restrict", "__extension__", "__typeof__", "typeof",
}
TYPE_KEYWORDS = {"void", "int", "char", "short", "long", "float", "double", "signed",
                 "unsigned", "_Bool", "struct", "union", "enum", "const", "volatile",
                 "static", "extern", "inline", "register", "__inline", "__inline__"}
ASSIGN_OPS = {"=", "+=", "-=", "*=", "/=", "%=", "|=", "&=", "^=", "<<=", ">>="}

_TOKEN_RE = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<pp>\#[^\n]*(?:\\\n[^\n]*)*)                    # preprocessor line (with continuations)
  | (?P<str>"(?:\\.|[^"\\\n])*")
  | (?P<chr>'(?:\\.|[^'\\\n])*')
  | (?P<num>0[xX][0-9a-fA-F]+[uUlL]*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[uUlLfF]*)
  | (?P<id>[A-Za-z_]\w*)
  | (?P<op><<=|>>=|\.\.\.|->|\+\+|--|&&|\|\||<=|>=|==|!=|\+=|-=|\*=|/=|%=|&=|\|=|\^=|<<|>>|[-+*/%<>=!&|^~?:;,.(){}\[\]])
    """,
    re.VERBOSE,
)
_COMMENT_RE = re.compile(r"/\*.*?\*/|//[^\n]*", re.DOTALL)


@dataclass
class Tok:
    kind: str
    text: str
    line: int


@dataclass
class HwAccess:
    macro: str
    kind: str                 # read | write | rmw
    block: str
    reg: str
    line: int
    seq: int                  # ordinal position inside the function body (for timing interpolation)


@dataclass
class VarAccess:
    name: str
    rw: str                   # r | w | rw | addr
    line: int
    kind: str                 # global | static | static_local | extern
    seq: int = 0              # position among the function's sequenced events (for timing interpolation)
    member: str = ""          # member chain after the identifier ("dl.harq_ack", indices dropped) - for structures
    via_macro: str = ""       # accessor macro that produced this access (ASA_GET ...) when applicable


@dataclass
class Call:
    callee: str
    line: int
    seq: int
    indirect: bool = False


@dataclass
class IpcOp:
    macro: str
    channel: str
    line: int
    seq: int


@dataclass
class FunctionDef:
    name: str
    file: str
    line: int
    end_line: int
    is_static: bool
    signature: str
    calls: list[Call] = field(default_factory=list)
    hw: list[HwAccess] = field(default_factory=list)
    vars: list[VarAccess] = field(default_factory=list)
    heap: list[Call] = field(default_factory=list)
    ipc: list[IpcOp] = field(default_factory=list)
    static_locals: list[str] = field(default_factory=list)
    body_text: str = ""
    n_seq: int = 0            # total number of sequenced events (calls + hw) in body

    @property
    def id(self) -> str:
        return f"{self.name}@{os.path.basename(self.file)}" if self.is_static else self.name


@dataclass
class VarDef:
    name: str
    file: str
    line: int
    kind: str                 # global | static | extern
    decl: str


@dataclass
class ParseResult:
    functions: list[FunctionDef] = field(default_factory=list)
    variables: list[VarDef] = field(default_factory=list)
    macros: dict[str, str] = field(default_factory=dict)     # name -> definition body
    prototypes: set[str] = field(default_factory=set)
    files: list[str] = field(default_factory=list)
    # file -> function names referenced as *values* in file-scope initializers (dispatch / stage tables).
    # Indirect calls through struct members (`tbl[i].run(ctx)`) in that file resolve to these candidates.
    table_refs: dict[str, list[str]] = field(default_factory=dict)


# ----------------------------------------------------------------------------- tokenizer

def strip_comments(src: str) -> str:
    """Replace comments with whitespace, preserving newlines for line numbers."""
    def repl(m):
        return re.sub(r"[^\n]", " ", m.group(0))
    # protect string literals from the comment regex by a two-pass approach
    out, i = [], 0
    pattern = re.compile(r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|/\*.*?\*/|//[^\n]*', re.DOTALL)
    for m in pattern.finditer(src):
        out.append(src[i:m.start()])
        t = m.group(0)
        out.append(repl(m) if t.startswith("/") else t)
        i = m.end()
    out.append(src[i:])
    return "".join(out)


def tokenize(src: str) -> tuple[list[Tok], list[tuple[int, str]]]:
    """Return (tokens, preprocessor_lines)."""
    toks: list[Tok] = []
    pps: list[tuple[int, str]] = []
    line = 1
    pos = 0
    n = len(src)
    while pos < n:
        m = _TOKEN_RE.match(src, pos)
        if not m:
            pos += 1  # skip unknown char
            continue
        kind = m.lastgroup
        text = m.group(0)
        if kind == "ws":
            line += text.count("\n")
        elif kind == "pp":
            pps.append((line, text))
            line += text.count("\n")
        else:
            toks.append(Tok(kind, text, line))
        pos = m.end()
    return toks, pps


# ----------------------------------------------------------------------------- helpers

def _match_close(toks: list[Tok], i: int, open_t: str, close_t: str) -> int:
    """toks[i] is open_t; return index of matching close_t (or len-1)."""
    depth = 0
    for j in range(i, len(toks)):
        t = toks[j].text
        if t == open_t:
            depth += 1
        elif t == close_t:
            depth -= 1
            if depth == 0:
                return j
    return len(toks) - 1


def _split_args(toks: list[Tok]) -> list[list[Tok]]:
    args, cur, depth = [], [], 0
    for t in toks:
        if t.text in "([{":
            depth += 1
        elif t.text in ")]}":
            depth -= 1
        if t.text == "," and depth == 0:
            args.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur or args:
        args.append(cur)
    return args


def _join(toks: list[Tok]) -> str:
    return " ".join(t.text for t in toks)


# ----------------------------------------------------------------------------- parser

class CParser:
    def __init__(self, cfg):
        self.cfg = cfg
        hm = cfg.hw_macros
        self.hw_read = set(hm["read"])
        self.hw_write = set(hm["write"])
        self.hw_rmw = set(hm["rmw"])
        self.block_arg = hm["block_arg"]
        self.reg_arg = hm["reg_arg"]
        self.auto_volatile = hm["auto_detect_volatile"]
        # detailed register-macro registrations (name -> spec); simple lists are expanded lazily in _hw_spec
        self.hw_custom = {m["name"]: m for m in hm.get("custom", [])}
        self.block_aliases = dict(hm.get("block_aliases", {}))
        self.block_ids = [b.id for b in cfg.hw_blocks]
        self.block_lower = {b.id.lower(): b.id for b in cfg.hw_blocks}
        self.heap_funcs = set(cfg.memory["heap_functions"])
        self.ipc_macros = set(cfg.memory["ipc_macros"])
        self.ipc_arg = cfg.memory["ipc_channel_arg"]
        self.access_macros = {m["name"]: m for m in cfg.memory.get("access_macros", [])}
        self.ignore_calls = set(cfg.parser.get("ignore_calls", []))
        self.ignore_vars = set(cfg.memory.get("ignore_vars", []))
        self.result = ParseResult()
        self._globals: dict[str, VarDef] = {}
        self._file_statics: dict[str, dict[str, VarDef]] = {}
        self._init_idents: dict[str, list[str]] = {}     # file -> identifiers seen inside file-scope initializers
        # registered shared structures / variables (may live outside the parsed sources)
        for g in cfg.memory.get("globals", []):
            vd = VarDef(name=g["name"], file="<config>", line=0, kind=g.get("kind", "global"), decl=g.get("note", "registered in config"))
            self._globals[g["name"]] = vd
            self.result.variables.append(vd)

    # -- register macro resolution ----------------------------------------------------------------
    def _hw_spec(self, name: str):
        """Return {kind, block_arg, reg_arg, block, block_from_reg} for a register macro, or None."""
        if name in self.hw_custom:
            return self.hw_custom[name]
        if name in self.hw_read or name in self.hw_write or name in self.hw_rmw:
            kind = "read" if name in self.hw_read else ("write" if name in self.hw_write else "rmw")
            return {"kind": kind, "block_arg": self.block_arg, "reg_arg": self.reg_arg, "block": None, "block_from_reg": None}
        return None

    def _norm_block(self, raw: str) -> str:
        """Map a block name as written in code onto a configured block id (aliases, case)."""
        raw = raw.strip()
        if raw in self.block_aliases:
            return self.block_aliases[raw]
        if raw in self.block_ids:
            return raw
        return self.block_lower.get(raw.lower(), raw)

    def _hw_from_call(self, name: str, args: list[list[Tok]], line: int, seq: int) -> "HwAccess | None":
        spec = self._hw_spec(name)
        if spec is None:
            return None
        reg = _join(args[spec["reg_arg"]]) if spec.get("reg_arg") is not None and len(args) > spec["reg_arg"] else ""
        if spec.get("block"):
            block = str(spec["block"])
        elif spec.get("block_arg") is not None and len(args) > spec["block_arg"] and args[spec["block_arg"]]:
            block = _join(args[spec["block_arg"]])
        elif spec.get("block_from_reg"):
            m = re.search(spec["block_from_reg"], reg)
            block = m.group(1) if m else "?"
        else:
            block = "?"
        return HwAccess(macro=name, kind=spec["kind"], block=self._norm_block(block), reg=reg, line=line, seq=seq)

    # -- public -----------------------------------------------------------------
    def parse_all(self, files: list[str]) -> ParseResult:
        per_file_tokens = {}
        # pass 1: macros + top-level declarations (globals need to be known before bodies)
        for f in files:
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                src = strip_comments(fh.read())
            toks, pps = tokenize(src)
            per_file_tokens[f] = toks
            self._collect_macros(pps)
            self._collect_toplevel(f, toks)
            self.result.files.append(f)
        self._apply_macro_autodetect()
        # pass 2: function bodies
        for f, toks in per_file_tokens.items():
            self._collect_functions(f, toks)
        # dispatch tables: identifiers in file-scope initializers that name a known function
        known = {fn.name for fn in self.result.functions} | self.result.prototypes
        for f, idents in self._init_idents.items():
            refs = []
            for name in idents:
                if name in known and name not in refs:
                    refs.append(name)
            if refs:
                self.result.table_refs[f] = refs
        return self.result

    # -- macros -----------------------------------------------------------------
    def _collect_macros(self, pps: list[tuple[int, str]]):
        for _line, text in pps:
            m = re.match(r"#\s*define\s+([A-Za-z_]\w*)(\([^)]*\))?\s*(.*)", text, re.DOTALL)
            if m:
                body = m.group(3).replace("\\\n", " ")
                self.result.macros[m.group(1)] = re.sub(r"\s+", " ", body).strip()

    def _apply_macro_autodetect(self):
        if not self.auto_volatile:
            return
        for name, body in self.result.macros.items():
            if name in self.hw_read or name in self.hw_write or name in self.hw_rmw:
                continue
            if re.search(r"\*\s*\(\s*volatile", body) or "REG32" in body or "__IO" in body:
                # heuristic: an assignment to the deref => write, otherwise read
                if re.search(r"\)\s*=[^=]", body) or re.search(r"\|=|&=", body):
                    (self.hw_rmw if re.search(r"\|=|&=", body) else self.hw_write).add(name)
                else:
                    self.hw_read.add(name)

    # -- top level ----------------------------------------------------------------
    def _collect_toplevel(self, file: str, toks: list[Tok]):
        """Find global / static variable definitions at brace depth 0."""
        i, n = 0, len(toks)
        statics = self._file_statics.setdefault(file, {})
        while i < n:
            t = toks[i]
            if t.text == "{":
                # function body or aggregate type body: skip but check for trailing declarator
                j = _match_close(toks, i, "{", "}")
                i = j + 1
                continue
            # gather a statement up to ';' or '{' (at depth 0 of parens)
            stmt_start = i
            depth = 0
            while i < n:
                tt = toks[i].text
                if tt in "([":
                    depth += 1
                elif tt in ")]":
                    depth -= 1
                elif depth == 0 and tt in (";", "{"):
                    break
                i += 1
            stmt = toks[stmt_start:i]
            terminator = toks[i].text if i < n else ";"
            if terminator == "{":
                # function definition  or  struct/enum/union body or initializer
                is_func = self._looks_like_function_header(stmt)
                if is_func:
                    j = _match_close(toks, i, "{", "}")
                    i = j + 1
                    continue
                # aggregate / initializer: find end of braces then continue to ';'
                j = _match_close(toks, i, "{", "}")
                tail_start = j + 1
                k = tail_start
                while k < n and toks[k].text != ";":
                    k += 1
                full = stmt + toks[i:k]
                if any(t.text == "=" for t in stmt):     # `type name[] = { ... }` -> remember referenced identifiers
                    self._init_idents.setdefault(file, []).extend(
                        t.text for t in toks[i + 1:j] if t.kind == "id" and t.text not in KEYWORDS)
                self._maybe_var_decl(file, full, statics)
                i = k + 1
                continue
            # terminator ';'
            if stmt:
                if any(t.text == "(" for t in stmt) and self._looks_like_prototype(stmt):
                    name = self._function_name_from_header(stmt)
                    if name:
                        self.result.prototypes.add(name)
                else:
                    eq = next((k for k, t in enumerate(stmt) if t.text == "="), None)
                    if eq is not None:                    # `fn_ptr_t handler = dl_stage_eq;`
                        self._init_idents.setdefault(file, []).extend(
                            t.text for t in stmt[eq + 1:] if t.kind == "id" and t.text not in KEYWORDS)
                    self._maybe_var_decl(file, stmt, statics)
            i += 1

    def _looks_like_prototype(self, stmt: list[Tok]) -> bool:
        if stmt[0].text in ("typedef",):
            return False
        # has '=' before '(' -> initializer with call, not a prototype
        for t in stmt:
            if t.text == "=":
                return False
            if t.text == "(":
                break
        return True

    def _looks_like_function_header(self, stmt: list[Tok]) -> bool:
        if not stmt:
            return False
        if stmt[0].text in ("typedef",):
            return False
        if any(t.text == "=" for t in stmt):
            return False
        # strip trailing __attribute__((...))
        toks = list(stmt)
        while toks and toks[-1].text == ")":
            k = len(toks) - 1
            depth = 0
            while k >= 0:
                if toks[k].text == ")":
                    depth += 1
                elif toks[k].text == "(":
                    depth -= 1
                    if depth == 0:
                        break
                k -= 1
            if k > 0 and toks[k - 1].kind == "id" and toks[k - 1].text == "__attribute__":
                toks = toks[:k - 1]
                continue
            return k > 0 and toks[k - 1].kind == "id" and toks[k - 1].text not in (
                "struct", "union", "enum", "if", "while", "for", "switch")
        return False

    def _function_name_from_header(self, stmt: list[Tok]) -> str | None:
        # macro-wrapped definitions:  ISR_ENTRY(dl_symbol_isr) { ... }  /  static ISR_ENTRY(x, PRIO_HI) { ... }
        body = [t for t in stmt if t.text not in ("static", "inline", "__inline", "__inline__")]
        if (len(body) >= 4 and body[0].kind == "id" and body[0].text.isupper() and body[1].text == "("
                and body[-1].text == ")" and body[2].kind == "id" and all(t.text != "(" for t in body[2:-1])):
            return body[2].text
        depth = 0
        for k in range(len(stmt) - 1, -1, -1):
            t = stmt[k].text
            if t == ")":
                depth += 1
            elif t == "(":
                depth -= 1
                if depth == 0 and k > 0 and stmt[k - 1].kind == "id":
                    name = stmt[k - 1].text
                    if name == "__attribute__":
                        continue
                    return name
        return None

    def _maybe_var_decl(self, file: str, stmt: list[Tok], statics: dict[str, VarDef]):
        if not stmt or stmt[0].text in ("typedef", "return"):
            return
        words = [t.text for t in stmt]
        if "typedef" in words:
            return
        # anonymous struct body followed by name: handled by caller passing full tokens
        is_static = "static" in words
        is_extern = "extern" in words
        # split declarators on top-level commas (after the type part)
        # find the '=' / '[' / ',' / end for each declarator; name = last identifier before it
        decls: list[list[Tok]] = []
        cur, depth = [], 0
        for t in stmt:
            if t.text in "([{":
                depth += 1
            elif t.text in ")]}":
                depth -= 1
            if t.text == "," and depth == 0:
                decls.append(cur)
                cur = []
            else:
                cur.append(t)
        decls.append(cur)
        type_prefix: list[Tok] = []
        for di, d in enumerate(decls):
            name = None
            depth = 0
            for k, t in enumerate(d):
                if t.text in "([{":
                    depth += 1
                elif t.text in ")]}":
                    depth -= 1
                if depth == 0 and t.text in ("=", "[") :
                    # name is last id before this
                    for b in range(k - 1, -1, -1):
                        if d[b].kind == "id" and d[b].text not in KEYWORDS:
                            name = d[b]
                            break
                    break
            if name is None:
                # last identifier in declarator that isn't a keyword
                ids = [t for t in d if t.kind == "id" and t.text not in KEYWORDS]
                if len(ids) >= 2 or (di > 0 and ids) or (len(ids) == 1 and type_prefix):
                    name = ids[-1]
            if di == 0:
                type_prefix = d
            if name is None or name.text in self.ignore_vars:
                continue
            # skip things that are clearly function pointers typedef'd or enum constants etc.
            kind = "extern" if is_extern else ("static" if is_static else "global")
            vd = VarDef(name=name.text, file=file, line=name.line, kind=kind, decl=_join(d)[:120])
            if kind == "static":
                statics[name.text] = vd
            elif kind == "global":
                self._globals[name.text] = vd
            else:
                self._globals.setdefault(name.text, vd)
            self.result.variables.append(vd)

    # -- functions ----------------------------------------------------------------
    def _collect_functions(self, file: str, toks: list[Tok]):
        i, n = 0, len(toks)
        while i < n:
            if toks[i].text != "{":
                i += 1
                continue
            # find header: walk back to previous ';' or '}' at depth 0
            k = i - 1
            while k >= 0 and toks[k].text not in (";", "}"):
                k -= 1
            header = toks[k + 1:i]
            if self._looks_like_function_header(header):
                name = self._function_name_from_header(header)
                end = _match_close(toks, i, "{", "}")
                if name:
                    fd = FunctionDef(
                        name=name, file=file, line=header[0].line if header else toks[i].line,
                        end_line=toks[end].line, is_static=any(t.text == "static" for t in header),
                        signature=_join(header)[:160],
                    )
                    self._scan_body(fd, toks[i + 1:end])
                    self.result.functions.append(fd)
                i = end + 1
            else:
                i += 1

    def _scan_body(self, fd: FunctionDef, body: list[Tok]):
        file_statics = self._file_statics.get(fd.file, {})
        seq = 0
        n = len(body)
        local_names: set[str] = set()
        # collect static locals + plain local declarations (to avoid false global hits)
        i = 0
        while i < n:
            t = body[i]
            if t.text == "static":
                # static <type...> name [= ...];
                k = i + 1
                while k < n and body[k].text not in (";", "=", "[") :
                    k += 1
                ids = [x for x in body[i + 1:k] if x.kind == "id" and x.text not in KEYWORDS]
                if ids:
                    fd.static_locals.append(ids[-1].text)
                    local_names.add(ids[-1].text)
                i = k
                continue
            i += 1
        fd.body_text = _join(body)
        i = 0
        while i < n:
            t = body[i]
            nxt = body[i + 1].text if i + 1 < n else ""
            prev = body[i - 1].text if i > 0 else ""
            if t.kind == "id" and t.text not in KEYWORDS:
                if nxt == "(" and prev not in (".", "->"):
                    close = _match_close(body, i + 1, "(", ")")
                    args = _split_args(body[i + 2:close])
                    name = t.text
                    seq += 1
                    hw_acc = self._hw_from_call(name, args, t.line, seq)
                    if hw_acc is not None:
                        fd.hw.append(hw_acc)
                    elif name in self.access_macros:
                        # accessor macro for a registered structure: ASA_GET(dl.harq) / SHM_WR(ASA, ul.tpc, v)
                        am = self.access_macros[name]
                        var = am.get("var") or (_join(args[am["var_arg"]]) if am.get("var_arg") is not None and len(args) > am["var_arg"] else "?")
                        field = _join(args[am["field_arg"]]).replace(" ", "") if am.get("field_arg") is not None and len(args) > am["field_arg"] else ""
                        vd = self._globals.get(var) or file_statics.get(var)
                        fd.vars.append(VarAccess(name=var, rw=am.get("rw", "r"), line=t.line, kind=vd.kind if vd else "global",
                                                 seq=seq, member=field, via_macro=name))
                    elif name in self.ipc_macros:
                        ch = _join(args[self.ipc_arg]) if len(args) > self.ipc_arg else "?"
                        fd.ipc.append(IpcOp(macro=name, channel=ch, line=t.line, seq=seq))
                        fd.calls.append(Call(callee=name, line=t.line, seq=seq))
                    elif name in self.heap_funcs:
                        fd.heap.append(Call(callee=name, line=t.line, seq=seq))
                        fd.calls.append(Call(callee=name, line=t.line, seq=seq))
                    elif name not in self.ignore_calls:
                        fd.calls.append(Call(callee=name, line=t.line, seq=seq))
                    # scan args for nested calls / var accesses: do not skip them
                    i += 1
                    continue
                if nxt == "(" and prev in (".", "->"):
                    seq += 1
                    fd.calls.append(Call(callee=prev + t.text, line=t.line, seq=seq, indirect=True))
                    i += 1
                    continue
                # variable access?
                vname = t.text
                if prev in (".", "->"):
                    i += 1
                    continue
                vd = None
                if vname in local_names:
                    vd = None
                    kind = "static_local" if vname in fd.static_locals else None
                    if kind:
                        rw = self._classify_rw(body, i, prev)
                        fd.vars.append(VarAccess(name=vname, rw=rw, line=t.line, kind=kind, seq=seq))
                    i += 1
                    continue
                if vname in file_statics:
                    vd = file_statics[vname]
                elif vname in self._globals:
                    vd = self._globals[vname]
                if vd is not None:
                    rw = self._classify_rw(body, i, prev)
                    fd.vars.append(VarAccess(name=vname, rw=rw, line=t.line, kind=vd.kind, seq=seq,
                                             member=self._member_chain(body, i)))
            i += 1
        fd.n_seq = seq

    def _member_chain(self, body: list[Tok], i: int) -> str:
        """'ASA . dl . harq [ 2 ] . ack' -> 'dl.harq.ack' (array indices dropped); '' when no member follows."""
        parts, k, n = [], i + 1, len(body)
        while k < n:
            tt = body[k].text
            if tt == "[":
                k = _match_close(body, k, "[", "]") + 1
            elif tt in (".", "->") and k + 1 < n and body[k + 1].kind == "id":
                parts.append(body[k + 1].text)
                k += 2
            else:
                break
        return ".".join(parts)

    def _classify_rw(self, body: list[Tok], i: int, prev: str) -> str:
        n = len(body)
        k = i + 1
        # skip member / index chains
        while k < n:
            tt = body[k].text
            if tt == "[":
                k = _match_close(body, k, "[", "]") + 1
            elif tt in (".", "->") and k + 1 < n:
                k += 2
            else:
                break
        nxt = body[k].text if k < n else ""
        if prev == "&":
            return "addr"
        if nxt in ASSIGN_OPS:
            return "w" if nxt == "=" else "rw"
        if nxt in ("++", "--") or prev in ("++", "--"):
            return "rw"
        return "r"


def parse(cfg) -> ParseResult:
    backend = cfg.parser.get("backend", "builtin")
    if backend == "libclang":
        try:
            from . import clang_backend  # type: ignore
            return clang_backend.parse(cfg)
        except ImportError:
            print("[isrprof] libclang backend unavailable, falling back to builtin parser")
    return CParser(cfg).parse_all(cfg.sources)
