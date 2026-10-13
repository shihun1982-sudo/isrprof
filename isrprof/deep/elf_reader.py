"""Pure-Python ELF relocatable-object reader for the objects backend (no binutils needed).

From a ``.o`` (ELF32 / ELF64, little or big endian; ARM / Thumb, AArch64, x86, x86-64, RISC-V ...) it
extracts:

* defined symbols: functions (STT_FUNC) and data (STT_OBJECT / COMMON), with binding (local / global / weak)
  and size
* per function, from the relocations that fall inside its code range:
  - ``calls``         relocation of a call / branch type to a FUNC symbol
  - ``addr_taken``    any other relocation to a FUNC symbol (function pointer, vtable slot, table entry)
  - ``data``          relocations to OBJECT / NOTYPE symbols (global / static data references)
  Local (static) targets that the compiler references through a *section symbol* are resolved by the
  addend (RELA) or by the addend stored in the instruction / literal word (ARM REL: ABS32 word, Thumb BL /
  ARM BL immediates).

Names are demangled with a small Itanium-ABI demangler (nested names, ctors / dtors, operators, template
argument lists are skipped) so ``_ZN2dl8CrcStage3runERNS_3CtxE`` becomes ``dl::CrcStage::run``.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

SHT_SYMTAB, SHT_STRTAB, SHT_RELA, SHT_REL, SHT_NOBITS = 2, 3, 4, 9, 8
STT_NOTYPE, STT_OBJECT, STT_FUNC, STT_SECTION, STT_COMMON = 0, 1, 2, 3, 5
STB_LOCAL, STB_GLOBAL, STB_WEAK = 0, 1, 2
SHN_UNDEF, SHN_ABS, SHN_COMMON = 0, 0xFFF1, 0xFFF2
EM_386, EM_ARM, EM_X86_64, EM_AARCH64, EM_RISCV = 3, 40, 62, 183, 243

# relocation types that are calls / branches (per machine)
CALL_TYPES = {
    EM_ARM: {28, 29, 10, 30, 51, 9},            # R_ARM_CALL, JUMP24, THM_CALL, THM_JUMP24, THM_JUMP19, (SBREL32 unused)
    EM_AARCH64: {283, 282},                      # R_AARCH64_CALL26, JUMP26
    EM_X86_64: {4, 2},                           # PLT32, PC32 (when the target is a function)
    EM_386: {4, 2},                              # PLT32, PC32
    EM_RISCV: {18, 19, 17},                      # CALL, CALL_PLT, JAL
}
R_ARM_ABS32, R_ARM_THM_CALL, R_ARM_CALL, R_ARM_JUMP24, R_ARM_THM_JUMP24, R_ARM_TARGET1 = 2, 10, 28, 29, 30, 38


@dataclass
class ObjFunction:
    name: str
    raw: str
    local: bool
    size: int
    section: int
    value: int
    calls: list[str] = field(default_factory=list)
    addr_taken: list[str] = field(default_factory=list)
    data: list[str] = field(default_factory=list)


@dataclass
class ObjFile:
    path: str
    machine: int
    functions: dict[str, ObjFunction] = field(default_factory=dict)
    data: dict[str, dict] = field(default_factory=dict)      # name -> {local, size, raw}
    warnings: list[str] = field(default_factory=list)


# ------------------------------------------------------------------------------------ demangling (Itanium, small subset)

def demangle(sym: str) -> str:
    if not sym.startswith("_Z"):
        return sym
    try:
        if sym.startswith("_ZZ"):            # local entity: _ZZ <function encoding> E <name>  -> `name@function`
            inner = _Dem("_Z" + sym[3:])
            fn = inner.parse()
            rest = sym[3 + inner.i - 2:]
            k = rest.find("E")
            while k >= 0 and not (k + 1 < len(rest) and rest[k + 1].isdigit()):
                k = rest.find("E", k + 1)
            if k >= 0:
                tail = _Dem("_Z" + rest[k + 1:])
                name = tail.parse()
                if fn and name:
                    return f"{name}@{fn.split('::')[-1]}"
            return sym
        p = _Dem(sym)
        out = p.parse()
        return out or sym
    except Exception:
        return sym


class _Dem:
    def __init__(self, s: str):
        self.s = s
        self.i = 2
        self.subs: list[str] = []

    def peek(self, n=1):
        return self.s[self.i:self.i + n]

    def num(self) -> int | None:
        j = self.i
        while j < len(self.s) and self.s[j].isdigit():
            j += 1
        if j == self.i:
            return None
        n = int(self.s[self.i:j]); self.i = j
        return n

    def ident(self) -> str | None:
        n = self.num()
        if n is None:
            return None
        s = self.s[self.i:self.i + n]; self.i += n
        if s.startswith("_GLOBAL__N"):
            return "(anonymous namespace)"
        return s

    def skip_template_args(self):
        # I ... E ; nested names (N ... E) and nested template lists inside are balanced too
        depth = 0
        while self.i < len(self.s):
            c = self.s[self.i]
            if c == "S":                                 # substitution S_, S1_, St ... (digits inside are not lengths)
                j = self.s.find("_", self.i, self.i + 6)
                self.i = j + 1 if j > 0 and self.s[self.i + 1:j].isalnum() or j == self.i + 1 else self.i + 2
                continue
            if c == "L":                                 # literal L<type><value>E
                j = self.s.find("E", self.i)
                self.i = (j + 1) if j > 0 else len(self.s)
                depth -= 0
                continue
            if c in ("I", "N"):
                depth += 1
            elif c == "E":
                depth -= 1
                if depth <= 0:
                    self.i += 1
                    return
            elif c.isdigit():
                n = self.num() or 0
                self.i += n
                continue
            self.i += 1

    OPS = {"pl": "operator+", "mi": "operator-", "ml": "operator*", "dv": "operator/", "rm": "operator%", "eq": "operator==", "ne": "operator!=",
           "lt": "operator<", "gt": "operator>", "le": "operator<=", "ge": "operator>=", "aS": "operator=", "pL": "operator+=", "mI": "operator-=",
           "ix": "operator[]", "cl": "operator()", "pp": "operator++", "mm": "operator--", "nw": "operator new", "dl": "operator delete",
           "na": "operator new[]", "da": "operator delete[]", "an": "operator&", "or": "operator|", "eo": "operator^", "ls": "operator<<", "rs": "operator>>",
           "aa": "operator&&", "oo": "operator||", "nt": "operator!", "co": "operator~", "ps": "operator+", "ng": "operator-", "de": "operator*", "ad": "operator&",
           "pt": "operator->", "cv": "operator (cast)"}

    def component(self, last: str | None) -> str | None:
        c = self.peek()
        if c.isdigit():
            return self.ident()
        two = self.peek(2)
        if two in ("C1", "C2", "C3", "CI"):
            self.i += 2
            if two == "CI":
                self.ident()
            return last or "ctor"
        if two in ("D0", "D1", "D2"):
            self.i += 2
            return "~" + (last or "dtor")
        if two == "St":
            self.i += 2
            return "std"
        if two in self.OPS:
            self.i += 2
            return self.OPS[two]
        if c == "L":                     # internal linkage marker
            self.i += 1
            return self.component(last)
        if c == "S":                     # substitution: S_ / S<n>_ / Sa / Ss ...
            j = self.s.index("_", self.i) if "_" in self.s[self.i:self.i + 4] else -1
            if j > 0:
                ref = self.s[self.i + 1:j]; self.i = j + 1
                idx = 0 if ref == "" else int(ref, 36) + 1
                return self.subs[idx] if idx < len(self.subs) else "?"
            self.i += 2
            return "std"
        return None

    def parse(self) -> str:
        s = self.s
        if self.peek() == "N":
            self.i += 1
            while self.peek() in ("K", "V", "r", "R", "O"):   # cv / ref qualifiers of the method
                self.i += 1
            parts: list[str] = []
            while self.i < len(s) and self.peek() != "E":
                comp = self.component(parts[-1] if parts else None)
                if comp is None:
                    break
                parts.append(comp)
                self.subs.append("::".join(parts))
                if self.peek() == "I":
                    self.skip_template_args()
            return "::".join(parts)
        if self.peek() == "L":
            self.i += 1
        if self.peek().isdigit():
            name = self.ident() or ""
            if self.peek() == "I":
                self.skip_template_args()
            return name
        two = self.peek(2)
        if two in self.OPS:
            return self.OPS[two]
        return ""


# ------------------------------------------------------------------------------------ ELF parsing

def read_object(path: str) -> ObjFile:
    with open(path, "rb") as fh:
        b = fh.read()
    if b[:4] != b"\x7fELF":
        raise ValueError(f"{path}: not an ELF file (COFF / Mach-O objects need the binutils reader)")
    cls, data = b[4], b[5]
    le = data == 1
    E = "<" if le else ">"
    is64 = cls == 2
    if is64:
        (e_type, e_machine, _v, _entry, _phoff, e_shoff, _flags, _ehsize, _phes, _phnum, e_shentsize, e_shnum, e_shstrndx) = struct.unpack(E + "HHIQQQIHHHHHH", b[16:64])
    else:
        (e_type, e_machine, _v, _entry, _phoff, e_shoff, _flags, _ehsize, _phes, _phnum, e_shentsize, e_shnum, e_shstrndx) = struct.unpack(E + "HHIIIIIHHHHHH", b[16:52])
    obj = ObjFile(path=path, machine=e_machine)
    secs = []
    for i in range(e_shnum):
        off = e_shoff + i * e_shentsize
        if is64:
            (name, typ, flags, addr, offset, size, link, info, align, entsize) = struct.unpack(E + "IIQQQQIIQQ", b[off:off + 64])
        else:
            (name, typ, flags, addr, offset, size, link, info, align, entsize) = struct.unpack(E + "IIIIIIIIII", b[off:off + 40])
        secs.append({"name": name, "type": typ, "flags": flags, "addr": addr, "offset": offset, "size": size, "link": link, "info": info, "entsize": entsize})
    shstr = secs[e_shstrndx] if e_shstrndx < len(secs) else None

    def cstr(tab, off):
        if tab is None:
            return ""
        start = tab["offset"] + off
        end = b.index(b"\0", start)
        return b[start:end].decode("utf-8", "replace")

    for s in secs:
        s["sname"] = cstr(shstr, s["name"])
    # symbols
    symtabs = [s for s in secs if s["type"] == SHT_SYMTAB]
    syms: list[dict] = []
    if symtabs:
        st = symtabs[0]
        strtab = secs[st["link"]]
        ent = st["entsize"] or (24 if is64 else 16)
        for k in range(st["size"] // ent):
            off = st["offset"] + k * ent
            if is64:
                (name, info, other, shndx, value, size) = struct.unpack(E + "IBBHQQ", b[off:off + 24])
            else:
                (name, value, size, info, other, shndx) = struct.unpack(E + "IIIBBH", b[off:off + 16])
            syms.append({"name": cstr(strtab, name), "value": value, "size": size, "type": info & 0xF, "bind": info >> 4, "shndx": shndx})
    thumb = e_machine == EM_ARM
    by_sec: dict[int, list[dict]] = {}
    for sidx, sy in enumerate(syms):
        sy["idx"] = sidx
        if sy["type"] == STT_FUNC and sy["shndx"] not in (SHN_UNDEF, SHN_ABS):
            v = sy["value"] & ~1 if thumb else sy["value"]
            sy["start"] = v
            by_sec.setdefault(sy["shndx"], []).append(sy)
            nm = demangle(sy["name"])
            obj.functions[nm] = ObjFunction(name=nm, raw=sy["name"], local=sy["bind"] == STB_LOCAL, size=sy["size"], section=sy["shndx"], value=v)
        elif sy["type"] in (STT_OBJECT, STT_COMMON) and sy["name"] and sy["shndx"] != SHN_UNDEF:
            obj.data[demangle(sy["name"])] = {"local": sy["bind"] == STB_LOCAL, "size": sy["size"], "raw": sy["name"]}
    for lst in by_sec.values():
        lst.sort(key=lambda s: s["start"])

    def func_at(shndx: int, off: int) -> dict | None:
        lst = by_sec.get(shndx) or []
        best = None
        for sy in lst:
            if sy["start"] <= off:
                best = sy
            else:
                break
        if best is not None and (best["size"] == 0 or off < best["start"] + max(best["size"], 1)):
            return best
        return None

    def sym_at(shndx: int, off: int) -> dict | None:
        """named symbol (function or object) covering offset `off` of section `shndx` (for section-symbol targets)."""
        best = None
        for sy in syms:
            if sy["shndx"] == shndx and sy["type"] in (STT_FUNC, STT_OBJECT, STT_NOTYPE) and sy["name"]:
                st_ = sy["value"] & ~1 if (thumb and sy["type"] == STT_FUNC) else sy["value"]
                if st_ <= off < st_ + max(sy["size"], 1) or (st_ == off):
                    if best is None or sy["size"] > best["size"]:
                        best = sy
        return best

    call_types = CALL_TYPES.get(e_machine, set())
    reloc_at: set[tuple[int, int]] = set()
    # relocations
    for rs in secs:
        if rs["type"] not in (SHT_REL, SHT_RELA):
            continue
        target_sec = rs["info"]
        tsec = secs[target_sec] if target_sec < len(secs) else None
        if tsec is None or not (tsec["flags"] & 0x4):          # SHF_EXECINSTR: only code sections carry calls / references of functions
            continue
        rela = rs["type"] == SHT_RELA
        ent = rs["entsize"] or ((24 if rela else 16) if is64 else (12 if rela else 8))
        for k in range(rs["size"] // ent):
            off = rs["offset"] + k * ent
            if is64:
                r_offset, r_info = struct.unpack(E + "QQ", b[off:off + 16])
                r_sym, r_type = r_info >> 32, r_info & 0xFFFFFFFF
                addend = struct.unpack(E + "q", b[off + 16:off + 24])[0] if rela else 0
            else:
                r_offset, r_info = struct.unpack(E + "II", b[off:off + 8])
                r_sym, r_type = r_info >> 8, r_info & 0xFF
                addend = struct.unpack(E + "i", b[off + 8:off + 12])[0] if rela else 0
            if r_sym >= len(syms):
                continue
            reloc_at.add((target_sec, r_offset))
            fn = func_at(target_sec, r_offset)
            if fn is None:
                continue
            tgt = syms[r_sym]
            tname, ttype = tgt["name"], tgt["type"]
            if ttype == STT_SECTION or (not tname and tgt["shndx"] not in (SHN_UNDEF, SHN_ABS)):
                # local target through its section symbol: resolve by addend (RELA) or from the instruction (ARM REL)
                if not rela and e_machine == EM_ARM:
                    addend = _arm_rel_addend(b, tsec["offset"] + r_offset, r_type, le)
                resolved = sym_at(tgt["shndx"], addend)
                if resolved is None:
                    continue
                tname, ttype = resolved["name"], resolved["type"]
                if ttype == STT_NOTYPE:
                    ttype = STT_FUNC if (secs[tgt["shndx"]]["flags"] & 0x4) else STT_OBJECT
            if not tname or tname.startswith((".L", "_ZTV", "_ZTI", "_ZTS", "_ZTT", "__dso_handle")):
                continue                     # literal pools, vtables / typeinfo: compiler bookkeeping, not a source relation
            dn = demangle(tname)
            rec = obj.functions[demangle(fn["name"])]
            if dn == rec.name:
                continue
            if ttype == STT_FUNC or (ttype == STT_NOTYPE and tgt["shndx"] == SHN_UNDEF and r_type in call_types):
                if r_type in call_types:
                    if dn not in rec.calls:
                        rec.calls.append(dn)
                elif dn not in rec.addr_taken:
                    rec.addr_taken.append(dn)
            elif ttype in (STT_OBJECT, STT_COMMON, STT_NOTYPE):
                if dn not in rec.data:
                    rec.data.append(dn)
    _scan_assembled_calls(b, secs, by_sec, func_at, e_machine, le, obj, reloc_at)
    return obj


def _scan_assembled_calls(b, secs, by_sec, func_at, e_machine, le, obj, reloc_at):
    """Calls the assembler already resolved (no relocation): a static function in the same section.

    Thumb-2 BL / BLX, ARM BL, AArch64 BL and x86 CALL rel32 are decoded over each function's bytes and
    accepted only when the computed target is exactly the start of another function in the section.
    """
    E = "<" if le else ">"
    for shndx, lst in by_sec.items():
        sec = secs[shndx]
        if not (sec["flags"] & 0x4):
            continue
        base = sec["offset"]
        for k, sy in enumerate(lst):
            start = sy["start"]
            end = start + sy["size"] if sy["size"] else (lst[k + 1]["start"] if k + 1 < len(lst) else sec["size"])
            end = min(end, sec["size"])
            rec = obj.functions.get(demangle(sy["name"]))
            if rec is None or end <= start:
                continue
            targets: list[int] = []
            try:
                if e_machine == EM_ARM and (sy["value"] & 1):                       # Thumb
                    off = start
                    while off + 4 <= end:
                        if (shndx, off) in reloc_at:
                            off += 2
                            continue
                        hi, lo = struct.unpack(E + "HH", b[base + off:base + off + 4])
                        if (hi & 0xF800) == 0xF000 and (lo & 0xD000) in (0xD000, 0xC000):
                            s_ = (hi >> 10) & 1; j1 = (lo >> 13) & 1; j2 = (lo >> 11) & 1
                            i1 = 1 - (j1 ^ s_); i2 = 1 - (j2 ^ s_)
                            imm = (s_ << 24) | (i1 << 23) | (i2 << 22) | ((hi & 0x3FF) << 12) | ((lo & 0x7FF) << 1)
                            if imm & (1 << 24):
                                imm -= 1 << 25
                            pc = (off + 4) & ~3 if (lo & 0xD000) == 0xC000 else off + 4
                            targets.append(pc + imm)
                            off += 4
                            continue
                        off += 2
                elif e_machine == EM_ARM:                                            # ARM
                    for off in range(start, end - 3, 4):
                        if (shndx, off) in reloc_at:
                            continue
                        w = struct.unpack(E + "I", b[base + off:base + off + 4])[0]
                        if (w & 0x0F000000) == 0x0B000000 and (w >> 28) != 0xF:
                            imm = w & 0x00FFFFFF
                            if imm & 0x00800000:
                                imm -= 0x01000000
                            targets.append(off + 8 + (imm << 2))
                elif e_machine == EM_AARCH64:
                    for off in range(start, end - 3, 4):
                        if (shndx, off) in reloc_at:
                            continue
                        w = struct.unpack(E + "I", b[base + off:base + off + 4])[0]
                        if (w & 0xFC000000) == 0x94000000:
                            imm = w & 0x03FFFFFF
                            if imm & 0x02000000:
                                imm -= 0x04000000
                            targets.append(off + (imm << 2))
                elif e_machine in (EM_X86_64, EM_386):
                    off = start
                    while off + 5 <= end:
                        if b[base + off] == 0xE8 and (shndx, off + 1) not in reloc_at:
                            rel = struct.unpack("<i", b[base + off + 1:base + off + 5])[0]
                            targets.append(off + 5 + rel)
                        off += 1
            except Exception:
                continue
            for t in targets:
                f = func_at(shndx, t)
                if f is None or f["start"] != t or f is sy:
                    continue
                dn = demangle(f["name"])
                if dn != rec.name and dn not in rec.calls:
                    rec.calls.append(dn)


def _arm_rel_addend(b: bytes, pos: int, r_type: int, le: bool) -> int:
    """Addend encoded in the instruction / word for ARM REL relocations we care about."""
    try:
        if r_type in (R_ARM_ABS32, R_ARM_TARGET1):
            return struct.unpack("<I" if le else ">I", b[pos:pos + 4])[0]
        if r_type in (R_ARM_THM_CALL, R_ARM_THM_JUMP24):          # Thumb-2 BL / B.W: two halfwords
            hi, lo = struct.unpack("<HH" if le else ">HH", b[pos:pos + 4])
            s = (hi >> 10) & 1; j1 = (lo >> 13) & 1; j2 = (lo >> 11) & 1
            i1 = 1 - (j1 ^ s); i2 = 1 - (j2 ^ s)
            imm10 = hi & 0x3FF; imm11 = lo & 0x7FF
            imm = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1)
            if imm & (1 << 24):
                imm -= 1 << 25
            return imm + 4
        if r_type in (R_ARM_CALL, R_ARM_JUMP24):                   # ARM BL: 24-bit signed imm << 2, pc+8
            w = struct.unpack("<I" if le else ">I", b[pos:pos + 4])[0]
            imm = w & 0x00FFFFFF
            if imm & 0x00800000:
                imm -= 0x01000000
            return (imm << 2) + 8
    except Exception:
        pass
    return 0
