"""Config loading / normalization.

A config is YAML (or JSON).  See ``examples/sample_config.yaml`` for the full
schema with comments.  This module resolves relative paths, expands source
globs, converts every time expression to microseconds and fills defaults, so
the rest of the pipeline never has to look at raw user strings.
"""
from __future__ import annotations

import glob
import json
import os
from dataclasses import dataclass, field
from typing import Any

from .timing import Numerology

try:  # PyYAML is optional; JSON configs work without it.
    import yaml  # type: ignore
except Exception:  # pragma: no cover
    yaml = None


class ConfigError(Exception):
    pass


@dataclass
class TimingItem:
    """A timing line.  NW timing is the reference; every other line is NW ± offset.
    SW ISRs are placed on sw lines (dl / ul / slot tick ...), HW blocks draw their control timing
    and deadlines on hw lines (hw_rx / hw_tx ...).  Any number of lines can be added in the config."""
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
    timing: str               # TimingItem.id
    entry: str                # root function
    start_us: float           # relative to timing item frame
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
class Config:
    raw: dict
    base_dir: str
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
    viewer: dict = field(default_factory=dict)
    annotations: dict = field(default_factory=dict)

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


def _read(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    if path.lower().endswith(".json"):
        return json.loads(text)
    if yaml is None:
        raise ConfigError("PyYAML not installed; use a .json config or `pip install pyyaml`")
    return yaml.safe_load(text) or {}


def _expand_sources(base: str, patterns: list[str]) -> list[str]:
    out: list[str] = []
    for p in patterns:
        full = p if os.path.isabs(p) else os.path.join(base, p)
        hits = sorted(glob.glob(full, recursive=True))
        if not hits and os.path.isfile(full):
            hits = [full]
        out.extend(h for h in hits if os.path.isfile(h))
    # de-dup, keep order
    seen, res = set(), []
    for f in out:
        n = os.path.normpath(f)
        if n not in seen:
            seen.add(n)
            res.append(n)
    return res


def load(path: str) -> Config:
    raw = _read(path)
    base = os.path.dirname(os.path.abspath(path))
    proj = raw.get("project", {})
    num_raw = raw.get("numerology", {})
    num = Numerology(
        mu=int(num_raw.get("mu", 1)),
        symbols_per_slot=int(num_raw.get("symbols_per_slot", 14)),
        symbol_us=num_raw.get("symbol_us"),
    )
    sources = _expand_sources(base, proj.get("sources", []))
    if not sources:
        raise ConfigError("project.sources matched no files")

    cores = []
    for c in raw.get("cores", []):
        cores.append({
            "id": int(c["id"]),
            "name": c.get("name", f"core{c['id']}"),
            "clock_mhz": float(c.get("clock_mhz", 1000)),
            "modules": c.get("modules", []),      # [{name, files:[glob]}]
            "description": c.get("description", ""),
        })
    if not cores:
        cores = [{"id": 0, "name": "core0", "clock_mhz": 1000.0, "modules": [], "description": ""}]

    tis: list[TimingItem] = []
    for i, t in enumerate(raw.get("timing_items", [])):
        tis.append(TimingItem(
            id=str(t["id"]), name=t.get("name", t["id"]),
            offset_us=num.parse(t.get("offset", 0)),
            priority=int(t.get("priority", i)),
            color=t.get("color"), description=t.get("description", ""),
            kind=str(t.get("kind", "sw")),
        ))
    if not any(t.id == "nw" for t in tis):
        tis.insert(0, TimingItem(id="nw", name="NW timing", offset_us=0.0, kind="ref"))

    isrs: list[IsrSpec] = []
    for s in raw.get("isrs", []):
        isrs.append(IsrSpec(
            name=s["name"], core=int(s.get("core", cores[0]["id"])), timing=str(s["timing"]),
            entry=s["entry"], start_us=num.parse(s.get("start", 0)),
            length_us=num.parse(s["length"]) if s.get("length") is not None else None,
            period_us=num.parse(s["period"]) if s.get("period") is not None else None,
            priority=int(s.get("priority", 0)), description=s.get("description", ""),
        ))

    hw = raw.get("hw", {})
    blocks: list[HwBlock] = []
    def _deadline(dl, default_line: str) -> dict:
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

    line_ids = {t.id for t in tis}
    for b in hw.get("blocks", []):
        line = str(b.get("line", hw.get("default_line", "nw")))
        if line not in line_ids:
            raise ConfigError(f"hw block {b['id']}: unknown timing line {line!r} (add it to timing_items)")
        dls = []
        if b.get("deadline") is not None:
            dls.append(_deadline(b["deadline"], line))
        for dl in b.get("deadlines", []) or []:
            dls.append(_deadline(dl, line))
        pos = b.get("pos", [0, 0])
        blocks.append(HwBlock(id=str(b["id"]), name=b.get("name", b["id"]), base=str(b.get("base", "")),
                              regs=list(b.get("regs", [])), line=line, deadlines=dls,
                              pos=(int(pos[0]), int(pos[1])), group=b.get("group", "")))
    hm = hw.get("macros", {}) or {}
    hw_macros = {
        "read": list(hm.get("read", ["HW_RD", "REG_READ"])),
        "write": list(hm.get("write", ["HW_WR", "REG_WRITE"])),
        "rmw": list(hm.get("rmw", ["HW_RMW", "REG_SET_BITS", "REG_CLR_BITS"])),
        "block_arg": int(hm.get("block_arg", 0)),
        "reg_arg": int(hm.get("reg_arg", 1)),
        "auto_detect_volatile": bool(hm.get("auto_detect_volatile", True)),
        # detailed registrations: any argument layout, fixed block, or block derived from the register name
        #   - { name: REGISTER_READ, kind: read, reg_arg: 0, block_arg: 2 }      REGISTER_READ(STATUS, , DFE_RX)
        #   - { name: RXF_WR, kind: write, block: RXF, reg_arg: 0 }              RXF_WR(CTRL, v)
        #   - { name: REG_WR, kind: write, reg_arg: 0, block_from_reg: "^([A-Z0-9]+)_" }   REG_WR(FFT_CTRL, v)
        "custom": [dict(name=str(m["name"]), kind=str(m.get("kind", "read")),
                        block_arg=(None if m.get("block_arg") is None else int(m["block_arg"])),
                        reg_arg=(None if m.get("reg_arg") is None else int(m["reg_arg"])),
                        block=m.get("block"), block_from_reg=m.get("block_from_reg"))
                   for m in (hm.get("custom", []) or [])],
        # block name aliases used in code -> block id in the config (matching is also case-insensitive)
        "block_aliases": {str(k): str(v) for k, v in (hw.get("block_aliases", {}) or {}).items()},
    }

    mem = raw.get("memory", {})
    memory = {
        "heap_functions": list(mem.get("heap_functions", ["malloc", "calloc", "realloc", "free"])),
        "ipc_macros": list(mem.get("ipc", {}).get("macros", ["IPC_SEND", "IPC_RECV", "IPC_NOTIFY"])),
        "ipc_channel_arg": int(mem.get("ipc", {}).get("channel_arg", 0)),
        "ipc_channels": list(mem.get("ipc", {}).get("channels", [])),
        "ignore_vars": list(mem.get("ignore_vars", [])),
        # registered shared structures / variables, tracked even when they are defined outside the parsed
        # sources (platform library, linker symbol):  - { name: ASA, kind: global, note: "..." }
        "globals": [dict(name=str(g["name"]), kind=str(g.get("kind", "global")), note=str(g.get("note", "")))
                    for g in (mem.get("globals", []) or [])],
        # accessor macros that read / write a registered variable:
        #   - { name: ASA_GET, rw: r, var: ASA, field_arg: 0 }      ASA_GET(dl.harq)   -> read  ASA.dl.harq
        #   - { name: SHM_WR,  rw: w, var_arg: 0, field_arg: 1 }    SHM_WR(ASA, ul.tpc, v) -> write ASA.ul.tpc
        "access_macros": [dict(name=str(m["name"]), rw=str(m.get("rw", "r")), var=m.get("var"),
                               var_arg=(None if m.get("var_arg") is None else int(m["var_arg"])),
                               field_arg=(None if m.get("field_arg") is None else int(m["field_arg"])))
                          for m in (mem.get("access_macros", []) or [])],
    }

    arch = raw.get("architecture", {})
    layers = [Layer(name=l["name"], functions=list(l.get("functions", [])),
                    files=list(l.get("files", [])), modules=list(l.get("modules", [])))
              for l in arch.get("layers", [])]
    architecture = {
        "rules": list(arch.get("rules", [])),
        "fat_threshold": int(arch.get("fat_threshold", 12)),
        "allow_skip_layer": bool(arch.get("allow_skip_layer", True)),
        "ignore_external": bool(arch.get("ignore_external", True)),
    }

    cm = raw.get("cost_model", {})
    cost_model = {
        "default_cost_us": num.parse(cm.get("default_cost", "0.02 symbol")),
        "function_costs_us": {k: num.parse(v) for k, v in (cm.get("function_costs") or {}).items()},
        "external_cost_us": num.parse(cm.get("external_cost", "0.01 symbol")),
        "trace_file": cm.get("trace_file"),
        "source_priority": list(cm.get("source_priority", ["trace", "config", "llm", "default"])),
    }

    llm = raw.get("llm", {}) or {}
    llm.setdefault("enabled", False)
    llm.setdefault("provider", "anthropic")
    llm.setdefault("model", "claude-sonnet-5-5")
    llm.setdefault("api_key_env", "ANTHROPIC_API_KEY")
    llm.setdefault("max_tokens", 2048)
    llm.setdefault("cache_file", ".isrprof_llm_cache.json")
    llm.setdefault("tasks", {})

    output = raw.get("output", {})
    out_html = output.get("html", "profile.html")
    out_json = output.get("json")
    output = {
        "html": out_html if os.path.isabs(out_html) else os.path.join(base, out_html),
        "json": (out_json if os.path.isabs(out_json) else os.path.join(base, out_json)) if out_json else None,
        "window": output.get("window", {}),   # {start, end} time window to show (nw frame)
    }

    parser = raw.get("parser", {}) or {}
    parser.setdefault("backend", "builtin")
    parser.setdefault("ignore_calls", ["sizeof", "memcpy", "memset", "assert", "ASSERT", "likely", "unlikely"])
    parser.setdefault("defines", {})

    viewer = _deep_merge(VIEWER_DEFAULTS, raw.get("viewer", {}) or {})
    annotations = _load_annotations(base, raw)

    cfg = Config(raw=raw, base_dir=base, name=proj.get("name", "modem"), sources=sources,
                 numerology=num, cores=cores, timing_items=tis, isrs=isrs, hw_blocks=blocks,
                 hw_macros=hw_macros, memory=memory, architecture=architecture, layers=layers,
                 cost_model=cost_model, llm=llm, output=output, parser=parser)
    cfg.viewer = viewer
    cfg.annotations = annotations
    return cfg


# ---------------------------------------------------------------- viewer appearance (all overridable)
VIEWER_DEFAULTS: dict = {
    "default_view": "aligned",      # aligned (orthographic front) | tilt (orthographic, depth tilted down) | 3d (perspective)
    "tilt_deg": 18,                 # tilt angle of the tilt view
    "theme": "auto",                # auto | light | dark
    "unit": "sym",                  # sym | us  (time unit in labels)
    "row_px": 15,                   # pixel height of one call-depth row at scale 1
    "label_margin_px": 215,         # left margin reserved for row / lane labels
    "expand_depth": 2,              # call-tree levels expanded by default (1 = ISR entry only)
    "max_instances": 1500,          # cap on periodic instances drawn per ISR
    "connectors": "all",            # all | focus | none  (lines from function boxes to SW / HW rows)
    "legend": True,
    "colors": {                     # categorical palette (modules / cores) and semantic colours
        "palette_light": ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
        "palette_dark": ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
        "read": None, "write": None, "miss": None, "heap": None, "accent": None,
    },
    "groups": {                     # row groups of the timing diagram
        "modules": {"open": True, "functions": False},
        "vars": {"open": True, "all": False},
        "ipc": {"open": True},
        "heap": {"open": True},
        "blocks": {"open": True, "registers": False},
    },
    "sw_structure": {"open_modules": [], "columns": 4},   # modules expanded at load; core columns per row (any core count wraps)
    "window_range": None,           # initial 3D time range in slots, e.g. [0, 1.5]
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
    ann = {"functions": {}, "blocks": {}, "variables": {}, "isrs": {}}
    for src in (raw.get("annotations") or {},):
        for k in ann:
            ann[k].update(src.get(k, {}) or {})
    path = raw.get("annotations_file")
    if path:
        full = path if os.path.isabs(path) else os.path.join(base, path)
        if os.path.exists(full):
            data = _read(full) or {}
            for k in ann:
                ann[k].update(data.get(k, {}) or {})
    return ann
