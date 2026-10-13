"""Config loading / normalization.

Inputs come either from a *profile* (``profiles/<name>/`` with ``build.yaml``, ``sw_structure.yaml``,
``timing.yaml``, ``hw_structure.yaml``, see :mod:`isrprof.profile`) or from a legacy single YAML / JSON
file (``examples/sample_config.yaml``).  Both end up in the same normalized :class:`Config`: relative paths
resolved, every time expression converted to microseconds, defaults filled, the SW / HW hierarchies
flattened, so the rest of the pipeline never looks at raw user strings.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from . import build as buildmod
from .profile import ProfileMeta, load_raw, read_yaml
from .timing import Numerology


class ConfigError(Exception):
    pass


@dataclass
class TimingItem:
    """A reference timing line.  NW timing is the reference; every other line is NW ± offset
    (DL RTG, UL RTG, HW REF ...).  ISRs are placed on a line; HW blocks draw their control timing and
    deadlines on a line.  Any number of lines can be added in the config."""
    id: str
    name: str
    offset_us: float          # relative to the NW reference
    priority: int = 0
    color: str | None = None
    description: str = ""
    kind: str = "sw"          # ref | sw | hw (informational)


@dataclass
class IsrSpec:
    name: str
    core: int
    timing: str               # TimingItem.id (reference line)
    entry: str                # root function
    start_us: float           # relative to the reference line frame
    length_us: float | None   # measured/budget envelope (None -> computed)
    period_us: float | None
    priority: int = 0
    description: str = ""


@dataclass
class HwBlock:
    id: str
    name: str
    base: str = ""
    regs: list[str] = field(default_factory=list)
    line: str = "nw"                 # timing line (timing_items id) the block's control timing is drawn on
    deadlines: list[dict] = field(default_factory=list)
    # each: {"timing": id, "at_us": float, "period_us": float|None, "note": str,
    #        "cores": [int]|None, "isrs": [str]|None}   (timing defaults to the block's line)
    pos: tuple[int, int] = (0, 0)
    group: str = ""


@dataclass
class Layer:
    name: str
    functions: list[str] = field(default_factory=list)   # glob patterns on function names
    files: list[str] = field(default_factory=list)       # glob patterns on file names
    modules: list[str] = field(default_factory=list)


@dataclass
class StructNode:
    """One node of the SW or HW structure hierarchy (flattened, depth-first order)."""
    id: str
    name: str
    kind: str                       # sw: subsystem|core|module|class|struct|shared_memory|variable|queue ...
                                    # hw: chain|group|block|register ...
    parent: str | None = None
    depth: int = 0
    children: list[str] = field(default_factory=list)
    core: int | None = None         # sw: core the node runs on (inherited)
    files: list[str] = field(default_factory=list)       # sw module: file globs (relative to the source root)
    functions: list[str] = field(default_factory=list)   # sw: function-name globs that belong to the node
    variables: list[str] = field(default_factory=list)   # sw: global / shared variables the node stands for
    type: str = ""                  # sw struct: C type name
    note: str = ""
    color: str | None = None
    extra: dict = field(default_factory=dict)            # hw block attributes etc.


@dataclass
class Config:
    raw: dict
    base_dir: str                   # profile directory (config file directory)
    src_root: str                   # source root (module / layer file globs are relative to it)
    name: str
    sources: list[str]
    numerology: Numerology
    cores: list[dict]
    timing_items: list[TimingItem]
    isrs: list[IsrSpec]
    hw_blocks: list[HwBlock]
    hw_macros: dict
    memory: dict
    architecture: dict
    layers: list[Layer]
    cost_model: dict
    llm: dict
    output: dict
    parser: dict
    build: dict = field(default_factory=dict)
    channels: dict = field(default_factory=dict)
    sw_nodes: list[StructNode] = field(default_factory=list)
    sw_relations: list[dict] = field(default_factory=list)
    sw_depth: int = 3
    hw_nodes: list[StructNode] = field(default_factory=list)
    hw_links: list[dict] = field(default_factory=list)
    hw_depth: int = 2
    viewer: dict = field(default_factory=dict)
    annotations: dict = field(default_factory=dict)
    meta: ProfileMeta | None = None

    def timing(self, tid: str) -> TimingItem:
        for t in self.timing_items:
            if t.id == tid:
                return t
        raise ConfigError(f"unknown timing item {tid!r}")

    def core(self, cid: int) -> dict:
        for c in self.cores:
            if c["id"] == cid:
                return c
        raise ConfigError(f"unknown core {cid!r}")


# ---------------------------------------------------------------------------- sections

def _sections(raw: dict) -> tuple[dict, dict, dict, dict]:
    """(build, timing, sw, hw) sections, whether the raw dict is a profile merge or a legacy config."""
    tim = raw.get("timing")
    if tim is None:
        tim = {"numerology": raw.get("numerology", {}), "cores": raw.get("cores", []),
               "references": raw.get("timing_items", []), "isrs": raw.get("isrs", []),
               "window": (raw.get("output") or {}).get("window", {}), "cost_model": raw.get("cost_model", {}),
               "callgraph": raw.get("callgraph", {}), "channels": raw.get("channels", {})}
    else:
        tim = dict(tim)
        tim.setdefault("references", tim.get("timing_items", []))
        tim.setdefault("cores", raw.get("cores", []))
    sw = raw.get("sw_structure")
    if sw is None:
        sw = {"nodes": [], "relations": [], "touch": raw.get("memory", {}), "architecture": raw.get("architecture", {})}
    else:
        sw = dict(sw)
        sw.setdefault("touch", raw.get("memory", {}))
        sw.setdefault("architecture", raw.get("architecture", {}))
    hw = raw.get("hw_structure")
    if hw is None:
        hw = dict(raw.get("hw", {}) or {})
        hw.setdefault("nodes", [])
    bld = raw.get("build")
    if bld is None:
        bld = {"sources": (raw.get("project") or {}).get("sources", []), "parser": raw.get("parser", {})}
    else:
        bld = dict(bld)
        bld.setdefault("parser", raw.get("parser", {}))
    return bld, tim, sw, hw


def _flatten(nodes_raw: list, kind_default: str, parent: StructNode | None, out: list[StructNode], depth: int):
    for n in nodes_raw or []:
        if not isinstance(n, dict):
            n = {"id": str(n)}
        nid = str(n.get("id") or n.get("name"))
        if not nid:
            raise ConfigError("structure node without id")
        node = StructNode(
            id=nid, name=str(n.get("name", nid)), kind=str(n.get("kind", kind_default)),
            parent=parent.id if parent else None, depth=depth,
            core=(int(n["core"]) if n.get("core") is not None else (parent.core if parent else None)),
            files=[str(f) for f in (n.get("files") or [])],
            functions=[str(f) for f in (n.get("functions") or [])],
            variables=[str(v) for v in (n.get("variables") or [])] + ([nid] if n.get("kind") in ("variable",) and not n.get("variables") else []),
            type=str(n.get("type", "")), note=str(n.get("note", "")), color=n.get("color"),
            extra={k: v for k, v in n.items() if k not in ("id", "name", "kind", "core", "files", "functions", "variables",
                                                               "type", "note", "color", "children")},
        )
        out.append(node)
        if parent:
            parent.children.append(nid)
        _flatten(n.get("children") or [], "module" if kind_default != "block" else "block", node, out, depth + 1)


def _deadline(num: Numerology, dl, default_line: str) -> dict:
    if not isinstance(dl, dict):
        return {"timing": default_line, "at_us": num.parse(dl), "period_us": None, "note": "", "cores": None, "isrs": None}
    return {
        "timing": dl.get("timing", default_line),
        "at_us": num.parse(dl.get("at", 0)),
        "period_us": num.parse(dl["period"]) if dl.get("period") is not None else None,
        "note": dl.get("note", ""),
        "cores": [int(c) for c in dl["cores"]] if dl.get("cores") is not None else None,
        "isrs": list(dl["isrs"]) if dl.get("isrs") is not None else None,
    }


# ---------------------------------------------------------------------------- load

def load(path: str, profiles_dir: str | None = None) -> Config:
    raw, meta = load_raw(path, profiles_dir)
    return build_config(raw, meta)


def build_config(raw: dict, meta: ProfileMeta) -> Config:
    base = meta.dir
    bld_raw, tim_raw, sw_raw, hw_raw = _sections(raw)

    # ---- build / sources
    build = buildmod.resolve(base, bld_raw if "build" in raw else {"parser": bld_raw.get("parser", {})},
                             legacy_sources=(raw.get("project") or {}).get("sources", []))
    sources = build["files"]
    if not sources:
        raise ConfigError("no source files matched (build.sources / project.sources)")
    src_root = build["root"]

    # ---- numerology
    num_raw = tim_raw.get("numerology", {}) or {}
    num = Numerology(mu=int(num_raw.get("mu", 1)), symbols_per_slot=int(num_raw.get("symbols_per_slot", 14)),
                     symbol_us=num_raw.get("symbol_us"))

    # ---- SW structure: hierarchy, relations, touch rules, architecture
    sw_nodes: list[StructNode] = []
    _flatten(sw_raw.get("nodes") or [], "subsystem", None, sw_nodes, 0)
    sw_relations = [dict(from_=str(r.get("from")), to=str(r.get("to")), kind=str(r.get("kind", "uses")),
                         label=str(r.get("label", "")), note=str(r.get("note", "")))
                    for r in (sw_raw.get("relations") or [])]
    sw_depth = int(sw_raw.get("depth", 3))
    sw_ids = {n.id for n in sw_nodes}
    for r in sw_relations:
        for k in ("from_", "to"):
            if r[k] not in sw_ids:
                raise ConfigError(f"sw_structure relation refers to unknown node {r[k]!r}")

    # ---- cores (timing) + module map (sw nodes with files, or legacy cores[].modules)
    cores = []
    for c in tim_raw.get("cores", []) or []:
        cores.append({"id": int(c["id"]), "name": c.get("name", f"core{c['id']}"),
                      "clock_mhz": float(c.get("clock_mhz", 1000)), "modules": list(c.get("modules", []) or []),
                      "description": c.get("description", ""), "color": c.get("color")})
    if not cores:
        cores = [{"id": 0, "name": "core0", "clock_mhz": 1000.0, "modules": [], "description": "", "color": None}]
    core_ids = {c["id"] for c in cores}
    for n in sw_nodes:                       # file-bearing nodes become the module map of their core
        if n.files:
            cid = n.core if n.core in core_ids else cores[0]["id"]
            if n.core is not None and n.core not in core_ids:
                raise ConfigError(f"sw node {n.id}: unknown core {n.core}")
            next(c for c in cores if c["id"] == cid)["modules"].append({"name": n.id, "files": n.files, "node": n.id})

    # ---- reference timing lines
    tis: list[TimingItem] = []
    for i, t in enumerate(tim_raw.get("references", []) or []):
        tis.append(TimingItem(id=str(t["id"]), name=t.get("name", t["id"]), offset_us=num.parse(t.get("offset", 0)),
                              priority=int(t.get("priority", i)), color=t.get("color"),
                              description=t.get("description", ""), kind=str(t.get("kind", "sw"))))
    if not any(t.id == "nw" for t in tis):
        tis.insert(0, TimingItem(id="nw", name="NW timing", offset_us=0.0, kind="ref"))
    line_ids = {t.id for t in tis}

    # ---- channels (3GPP channel allocation shown on the NW time axis)
    ch_raw = tim_raw.get("channels", {}) or {}
    items = ch_raw.get("items", ch_raw if isinstance(ch_raw, list) else []) or []
    channels = {"tdd_pattern": str(ch_raw.get("tdd_pattern", "")) if isinstance(ch_raw, dict) else "",
                "special": dict((ch_raw.get("special") or {}) if isinstance(ch_raw, dict) else {}), "items": []}
    for ch in items:
        syms = ch.get("symbols", [0, num.symbols_per_slot])
        if isinstance(syms, (int, float)):
            syms = [0, syms]
        slots = ch.get("slots", "all")
        channels["items"].append({
            "id": str(ch["id"]), "name": str(ch.get("name", ch["id"])), "dir": str(ch.get("dir", "dl")),
            "sym_start": float(syms[0]), "sym_len": float(syms[1]) if len(syms) > 1 else float(num.symbols_per_slot - syms[0]),
            "slots": slots if isinstance(slots, str) else [int(s) for s in slots],
            "period_slots": int(ch["period_slots"]) if ch.get("period_slots") else None,
            "offset_slot": int(ch.get("offset_slot", 0)), "color": ch.get("color"), "note": str(ch.get("note", "")),
        })

    # ---- ISRs
    isrs: list[IsrSpec] = []
    for s in tim_raw.get("isrs", []) or []:
        tid = str(s.get("timing", s.get("ref", "nw")))
        if tid not in line_ids:
            raise ConfigError(f"isr {s['name']}: unknown reference line {tid!r} (add it to timing.references)")
        isrs.append(IsrSpec(name=s["name"], core=int(s.get("core", cores[0]["id"])), timing=tid, entry=s["entry"],
                            start_us=num.parse(s.get("start", 0)),
                            length_us=num.parse(s["length"]) if s.get("length") is not None else None,
                            period_us=num.parse(s["period"]) if s.get("period") is not None else None,
                            priority=int(s.get("priority", 0)), description=s.get("description", "")))

    # ---- HW structure: hierarchy -> blocks, links, macros
    hw_nodes: list[StructNode] = []
    _flatten(hw_raw.get("nodes") or [], "chain", None, hw_nodes, 0)
    hw_depth = int(hw_raw.get("depth", 2))
    default_line = str(hw_raw.get("default_line", "nw"))
    blocks: list[HwBlock] = []
    block_raws = []
    for n in hw_nodes:                       # a node with registers (or kind block) is a HW block
        if n.kind == "block" or n.extra.get("regs") is not None or n.extra.get("base") is not None:
            n.kind = "block"
            block_raws.append((n, dict(n.extra, id=n.id, name=n.name, group=n.parent or "")))
    for b in hw_raw.get("blocks", []) or []:   # legacy flat list
        node = StructNode(id=str(b["id"]), name=b.get("name", b["id"]), kind="block", parent=b.get("group") or None,
                          depth=1 if b.get("group") else 0, note="", extra=dict(b))
        if b.get("group") and not any(x.id == b["group"] for x in hw_nodes):
            hw_nodes.append(StructNode(id=str(b["group"]), name=str(b["group"]), kind="group", children=[]))
        if b.get("group"):
            next(x for x in hw_nodes if x.id == b["group"]).children.append(node.id)
        hw_nodes.append(node)
        block_raws.append((node, dict(b, group=b.get("group", ""))))
    for node, b in block_raws:
        line = str(b.get("line", default_line))
        if line not in line_ids:
            raise ConfigError(f"hw block {b['id']}: unknown timing line {line!r} (add it to timing.references)")
        dls = []
        if b.get("deadline") is not None:
            dls.append(_deadline(num, b["deadline"], line))
        for dl in b.get("deadlines", []) or []:
            dls.append(_deadline(num, dl, line))
        pos = b.get("pos", [0, 0])
        blocks.append(HwBlock(id=str(b["id"]), name=b.get("name", b["id"]), base=str(b.get("base", "")),
                              regs=[str(r) for r in (b.get("regs", []) or [])], line=line, deadlines=dls,
                              pos=(int(pos[0]), int(pos[1])), group=str(b.get("group", "") or "")))
    hw_ids = {n.id for n in hw_nodes}
    hw_links = []
    for l in hw_raw.get("links", []) or []:
        a, b_ = str(l.get("from")), str(l.get("to"))
        if a not in hw_ids or b_ not in hw_ids:
            raise ConfigError(f"hw_structure link refers to unknown node {a!r} -> {b_!r}")
        hw_links.append({"from_": a, "to": b_, "kind": str(l.get("kind", "data")), "label": str(l.get("label", ""))})
    hm = hw_raw.get("macros", {}) or {}
    hw_macros = {
        "read": list(hm.get("read", ["HW_RD", "REG_READ"])),
        "write": list(hm.get("write", ["HW_WR", "REG_WRITE"])),
        "rmw": list(hm.get("rmw", ["HW_RMW", "REG_SET_BITS", "REG_CLR_BITS"])),
        "block_arg": int(hm.get("block_arg", 0)),
        "reg_arg": int(hm.get("reg_arg", 1)),
        "auto_detect_volatile": bool(hm.get("auto_detect_volatile", True)),
        "custom": [dict(name=str(m["name"]), kind=str(m.get("kind", "read")),
                        block_arg=(None if m.get("block_arg") is None else int(m["block_arg"])),
                        reg_arg=(None if m.get("reg_arg") is None else int(m["reg_arg"])),
                        block=m.get("block"), block_from_reg=m.get("block_from_reg"), reg=m.get("reg"), function=False)
                   for m in (hm.get("custom", []) or [])] +
                  # access *functions* (hal_fft_start(), Reg::write(FFT, CTRL, v) ...): the call stays a call edge and is
                  # also recorded as a register access of the configured block / register
                  [dict(name=str(m["name"]), kind=str(m.get("kind", "write")),
                        block_arg=(None if m.get("block_arg") is None else int(m["block_arg"])),
                        reg_arg=(None if m.get("reg_arg") is None else int(m["reg_arg"])),
                        block=m.get("block"), block_from_reg=m.get("block_from_reg"), reg=m.get("reg"), function=True)
                   for m in (hm.get("functions", []) or hw_raw.get("access_functions", []) or [])],
        "block_aliases": {str(k): str(v) for k, v in (hw_raw.get("block_aliases", {}) or {}).items()},
    }

    # ---- touch rules (memory): registered globals, accessor macros, heap, IPC
    mem = sw_raw.get("touch", {}) or {}
    memory = {
        "heap_functions": list(mem.get("heap_functions", ["malloc", "calloc", "realloc", "free"])),
        "ipc_macros": list((mem.get("ipc") or {}).get("macros", ["IPC_SEND", "IPC_RECV", "IPC_NOTIFY"])),
        "ipc_channel_arg": int((mem.get("ipc") or {}).get("channel_arg", 0)),
        "ipc_channels": list((mem.get("ipc") or {}).get("channels", [])),
        "ignore_vars": list(mem.get("ignore_vars", [])),
        "globals": [dict(name=str(g["name"]), kind=str(g.get("kind", "global")), note=str(g.get("note", "")))
                    for g in (mem.get("globals", []) or [])],
        "access_macros": [dict(name=str(m["name"]), rw=str(m.get("rw", "r")), var=m.get("var"), field=m.get("field"),
                               var_arg=(None if m.get("var_arg") is None else int(m["var_arg"])),
                               field_arg=(None if m.get("field_arg") is None else int(m["field_arg"])), function=False)
                          for m in (mem.get("access_macros", []) or [])] +
                         # access functions for shared SW blocks (shm_write(&g_x, v), Mailbox::post(...)): call edge + variable access
                         [dict(name=str(m["name"]), rw=str(m.get("rw", "w")), var=m.get("var"), field=m.get("field"),
                               var_arg=(None if m.get("var_arg") is None else int(m["var_arg"])),
                               field_arg=(None if m.get("field_arg") is None else int(m["field_arg"])), function=True)
                          for m in (mem.get("access_functions", []) or [])],
        "auto_variables": str(sw_raw.get("auto_variables", "cross_core")),   # cross_core | all | none
    }
    # variables named by SW nodes are tracked even when defined outside the sources
    declared = {g["name"] for g in memory["globals"]}
    for n in sw_nodes:
        for v in n.variables:
            if v not in declared and n.extra.get("registered"):
                memory["globals"].append({"name": v, "kind": "global", "note": n.note or f"declared by SW node {n.id}"})
                declared.add(v)

    # ---- architecture
    arch = sw_raw.get("architecture", {}) or {}
    layers = [Layer(name=l["name"], functions=list(l.get("functions", [])), files=list(l.get("files", [])),
                    modules=list(l.get("modules", []))) for l in arch.get("layers", [])]
    architecture = {"rules": list(arch.get("rules", [])), "fat_threshold": int(arch.get("fat_threshold", 12)),
                    "allow_skip_layer": bool(arch.get("allow_skip_layer", True)),
                    "ignore_external": bool(arch.get("ignore_external", True)),
                    "include_unreached": bool(arch.get("include_unreached", False))}

    # ---- cost model
    cm = tim_raw.get("cost_model", {}) or {}
    cost_model = {"default_cost_us": num.parse(cm.get("default_cost", "0.02 symbol")),
                  "function_costs_us": {k: num.parse(v) for k, v in (cm.get("function_costs") or {}).items()},
                  "external_cost_us": num.parse(cm.get("external_cost", "0.01 symbol")),
                  "trace_file": cm.get("trace_file"),
                  "source_priority": list(cm.get("source_priority", ["trace", "config", "llm", "default"]))}

    # ---- llm / output / parser / viewer / annotations
    llm = dict(raw.get("llm", {}) or {})
    llm.setdefault("enabled", False)
    llm.setdefault("provider", "anthropic")
    llm.setdefault("model", "claude-opus-5-5")
    llm.setdefault("api_key_env", "ANTHROPIC_API_KEY")
    llm.setdefault("max_tokens", 4096)
    llm.setdefault("cache_file", ".isrprof_llm_cache.json")
    llm.setdefault("tasks", {})

    out_raw = raw.get("output", {}) or {}
    out_dir = out_raw.get("dir") or meta.output_dir or base
    out_dir = out_dir if os.path.isabs(out_dir) else os.path.join(base, out_dir)
    out_html = out_raw.get("html", "profile.html")
    out_json = out_raw.get("json")
    output = {
        "dir": os.path.normpath(out_dir),
        "html": out_html if os.path.isabs(out_html) else os.path.join(out_dir, out_html),
        "json": (out_json if os.path.isabs(out_json) else os.path.join(out_dir, out_json)) if out_json else None,
        "window": tim_raw.get("window", out_raw.get("window", {})) or {},
    }

    parser = dict(build["parser"])
    parser["callgraph"] = dict(tim_raw.get("callgraph", raw.get("callgraph", {})) or {})
    viewer = _deep_merge(VIEWER_DEFAULTS, raw.get("viewer", {}) or {})
    viewer["sw_structure"] = _deep_merge(viewer["sw_structure"], {"depth": sw_depth})
    viewer["hw_structure"] = _deep_merge(viewer["hw_structure"], {"depth": hw_depth})
    annotations = _load_annotations(base, raw)

    cfg = Config(raw=raw, base_dir=base, src_root=src_root, name=str(raw.get("name") or (raw.get("project") or {}).get("name", "modem")),
                 sources=sources, numerology=num, cores=cores, timing_items=tis, isrs=isrs, hw_blocks=blocks,
                 hw_macros=hw_macros, memory=memory, architecture=architecture, layers=layers,
                 cost_model=cost_model, llm=llm, output=output, parser=parser, build=build, channels=channels,
                 sw_nodes=sw_nodes, sw_relations=sw_relations, sw_depth=sw_depth,
                 hw_nodes=hw_nodes, hw_links=hw_links, hw_depth=hw_depth, viewer=viewer, annotations=annotations,
                 meta=meta)
    return cfg


# ---------------------------------------------------------------- viewer appearance (all overridable)
VIEWER_DEFAULTS: dict = {
    "default_view": "tilt",         # tilt (cores stacked on the diagonal) | aligned (front) | 3d (perspective)
    "tilt_dx_px": 36,               # tilt view: horizontal shift per core plane (pixels)
    "theme": "auto",                # auto | light | dark
    "unit": "sym",                  # sym | us  (time unit in labels)
    "row_px": 12,                   # pixel height of one call-depth row at scale 1
    "label_margin_px": 200,         # left margin reserved for row / lane labels
    "expand_depth": 1,              # call-tree levels open below the ISR entry at load (0 = entries only)
    "max_instances": 1500,          # cap on periodic instances drawn per ISR
    "max_boxes": 40000,             # LOD: above this many boxes only the shown instance keeps its subtree
    "max_labels": 700,              # LOD: label sprites per build
    "legend": True,
    "colors": {                     # categorical palette (modules / cores) and semantic colours
        "palette_light": ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
        "palette_dark": ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
        "read": None, "write": None, "miss": None, "heap": None, "accent": None,
    },
    "channels": {"show": True, "row_px": 12},
    "sw_structure": {"depth": 3, "columns": 4, "open": []},
    "hw_structure": {"depth": 2, "columns": 3, "open": []},
    "window_range": None,           # initial time range in slots, e.g. [0, 1.5]
    "dsm_max_functions": 400,       # above this the DSM starts with every module collapsed
}


def _deep_merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _load_annotations(base: str, raw: dict) -> dict:
    """Free-text notes shown in tooltips / details: {functions: {name: note}, blocks: {id: note},
    variables: {name: note}, isrs: {name: note}}.  Inline (`annotations:`) or from `annotations_file`."""
    ann = {"functions": {}, "blocks": {}, "variables": {}, "isrs": {}, "nodes": {}}
    for src in (raw.get("annotations") or {},):
        for k in ann:
            ann[k].update(src.get(k, {}) or {})
    path = raw.get("annotations_file")
    if path:
        full = path if os.path.isabs(path) else os.path.join(base, path)
        if os.path.exists(full):
            data = read_yaml(full) or {}
            for k in ann:
                ann[k].update(data.get(k, {}) or {})
    return ann
