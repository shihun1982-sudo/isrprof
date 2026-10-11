"""Glue: config -> parse -> costs -> call trees -> structure -> profile dict."""
from __future__ import annotations

import csv
import fnmatch
import os

from . import __version__
from .callgraph import CallGraph
from .config import Config
from .cparser import parse
from .llm import LLMAssist
from .structure import StructureAnalyzer


def _load_trace_costs(cfg: Config) -> dict[str, float]:
    """Optional CSV trace: function,avg_us (or function,cycles with core clock)."""
    path = cfg.cost_model.get("trace_file")
    if not path:
        return {}
    full = path if os.path.isabs(path) else os.path.join(cfg.base_dir, path)
    if not os.path.exists(full):
        return {}
    out = {}
    with open(full, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            name = row.get("function")
            if not name:
                continue
            if row.get("us"):
                out[name] = float(row["us"])
            elif row.get("cycles") and row.get("clock_mhz"):
                out[name] = float(row["cycles"]) / float(row["clock_mhz"])
    return out


def _core_of_file(cfg: Config, path: str) -> int | None:
    rel = os.path.relpath(path, cfg.base_dir).replace("\\", "/")
    for core in cfg.cores:
        for m in core.get("modules", []):
            for pat in m.get("files", []):
                if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(os.path.basename(path), pat):
                    return core["id"]
    return None


def run(cfg: Config) -> dict:
    pr = parse(cfg)
    llm = LLMAssist(cfg)

    # ---- optional: macro classification for unknown register macros
    if llm.task_enabled("classify_hw_macro"):
        unknown = {k: v for k, v in pr.macros.items()
                   if ("volatile" in v or "REG" in k) and k not in cfg.hw_macros["read"] + cfg.hw_macros["write"]}
        for name, info in llm.classify_hw_macros(unknown).items():
            cfg.hw_macros[info.get("kind", "read")].append(name)
        pr = parse(cfg)   # re-parse with the enriched macro lists

    # ---- cost resolution (priority: trace > config > llm > default)
    costs: dict[str, float] = {}
    trace = _load_trace_costs(cfg)
    conf = cfg.cost_model["function_costs_us"]
    patterns = [(k, v) for k, v in conf.items() if any(ch in k for ch in "*?[")]

    def conf_cost(f):
        """exact id / name match first, then the first glob pattern (config order) that matches."""
        if f.id in conf:
            return conf[f.id]
        if f.name in conf:
            return conf[f.name]
        for pat, v in patterns:
            if fnmatch.fnmatch(f.name, pat) or fnmatch.fnmatch(f.id, pat):
                return v
        return None

    for f in pr.functions:
        for src in cfg.cost_model["source_priority"]:
            if src == "trace" and (f.id in trace or f.name in trace):
                costs[f.id] = trace.get(f.id, trace.get(f.name))
                break
            if src == "config" and conf_cost(f) is not None:
                costs[f.id] = conf_cost(f)
                break
            if src == "llm" and llm.task_enabled("estimate_costs"):
                core_id = _core_of_file(cfg, f.file)
                core = cfg.core(core_id) if core_id is not None else cfg.cores[0]
                est = llm.estimate_costs([f], core["name"], core["clock_mhz"])
                if f.id in est:
                    costs[f.id] = est[f.id]
                    break
    for name, us in conf.items():      # external functions (no definition) can also be priced
        if not any(ch in name for ch in "*?["):
            costs.setdefault(name, us)

    cg = CallGraph(cfg, pr, costs)
    isrs = cg.build_all()
    graph = cg.static_graph()

    fid_to_core: dict[str, int] = {}
    for f in pr.functions:
        c = _core_of_file(cfg, f.file)
        if c is not None:
            fid_to_core[f.id] = c
    exec_cores: dict[str, set[int]] = {}   # fid -> cores whose ISRs execute it
    for isr in isrs:                    # anything reachable from an ISR inherits the ISR's core if unknown
        for fid in isr["functions"]:
            fid_to_core.setdefault(fid, isr["core"])
            exec_cores.setdefault(fid, set()).add(isr["core"])

    analyzer = StructureAnalyzer(cfg, pr, graph, isrs, fid_to_core)
    structure = analyzer.analyze()
    summaries = llm.summarize(pr.functions) if llm.task_enabled("summarize") else {}

    # ---- function table
    functions = {}
    for f in pr.functions:
        functions[f.id] = {
            "id": f.id, "name": f.name, "file": os.path.relpath(f.file, cfg.base_dir).replace("\\", "/"),
            "line": f.line, "end_line": f.end_line, "static": f.is_static, "signature": f.signature,
            "core": fid_to_core.get(f.id), "module": analyzer.module_of(f.id),
            "self_us": round(costs.get(f.id, cfg.cost_model["default_cost_us"]), 3),
            "cost_source": ("trace" if f.id in trace or f.name in trace else
                            "config" if conf_cost(f) is not None else
                            "llm" if f.id in costs else "default"),
            "calls": [{"callee": c.callee, "line": c.line, "indirect": c.indirect,
                       "callee_id": (lambda t: t.id if t else None)(None if c.indirect else cg.resolve(c.callee, f.file)),
                       # indirect (function-pointer / dispatch-table) call: every candidate from the file's tables
                       "callee_ids": ([t.id for t in (cg.resolve(nm, f.file) for nm in pr.table_refs.get(f.file, []))
                                       if t is not None and t.id != f.id] if c.indirect else [])}
                      for c in f.calls],
            "hw": [{"macro": h.macro, "kind": h.kind, "block": h.block, "reg": h.reg, "line": h.line, "seq": h.seq} for h in f.hw],
            "vars": [{"name": v.name, "rw": v.rw, "line": v.line, "kind": v.kind, "seq": v.seq, "member": v.member, "via_macro": v.via_macro} for v in f.vars],
            "heap": [{"fn": c.callee, "line": c.line, "seq": c.seq} for c in f.heap],
            "ipc": [{"macro": i.macro, "channel": i.channel, "line": i.line, "seq": i.seq} for i in f.ipc],
            "n_seq": max(1, f.n_seq),
            "static_locals": f.static_locals,
            "summary": summaries.get(f.id, ""),
            "note": cfg.annotations["functions"].get(f.id, cfg.annotations["functions"].get(f.name, "")),
        }

    # ---- memory view: variables + accessors
    vars_out: dict[str, dict] = {}

    def _relfile(path: str) -> str:
        return path if path.startswith("<") else os.path.relpath(path, cfg.base_dir).replace("\\", "/")

    for v in pr.variables:
        key = v.name if v.kind != "static" else f"{v.name}@{os.path.basename(v.file)}"
        vars_out.setdefault(key, {"name": v.name, "kind": v.kind, "file": _relfile(v.file),
                                  "line": v.line, "decl": v.decl, "accessors": [], "cores": set(), "fields": {},
                                  "registered": v.file == "<config>"})
    for f in pr.functions:
        for a in f.vars:
            key = a.name if a.kind != "static" else f"{a.name}@{os.path.basename(f.file)}"
            if a.kind == "static_local":
                key = f"{a.name}@{f.name}"
                vars_out.setdefault(key, {"name": a.name, "kind": "static_local",
                                          "file": os.path.relpath(f.file, cfg.base_dir).replace("\\", "/"),
                                          "line": a.line, "decl": f"static local in {f.name}", "accessors": [], "cores": set(),
                                          "fields": {}, "registered": False})
            if key not in vars_out:
                if a.via_macro:          # accessor macro for a name that was not registered: create it on the fly
                    vars_out[key] = {"name": a.name, "kind": a.kind, "file": "<macro>", "line": 0, "decl": f"via {a.via_macro}",
                                     "accessors": [], "cores": set(), "fields": {}, "registered": False}
                else:
                    continue
            vars_out[key]["accessors"].append({"fid": f.id, "rw": a.rw, "line": a.line, "member": a.member, "via_macro": a.via_macro})
            if a.member:
                fld = vars_out[key]["fields"].setdefault(a.member, {"r": 0, "w": 0, "fids": []})
                fld["r" if a.rw in ("r", "addr") else "w"] += 1
                if a.rw == "rw":
                    fld["r"] += 1
                if f.id not in fld["fids"]:
                    fld["fids"].append(f.id)
            c = fid_to_core.get(f.id)
            if c is not None:
                vars_out[key]["cores"].add(c)
            vars_out[key]["cores"] |= exec_cores.get(f.id, set())
    for v in vars_out.values():
        v["cores"] = sorted(v["cores"])
        v["shared_across_cores"] = len(v["cores"]) > 1
        v["note"] = cfg.annotations["variables"].get(v["name"], "")
    for isr in isrs:
        isr["note"] = cfg.annotations["isrs"].get(isr["name"], "")
    heap_users = [{"fid": f.id, "calls": [{"fn": c.callee, "line": c.line} for c in f.heap]} for f in pr.functions if f.heap]
    ipc_ops = [{"fid": f.id, "core": fid_to_core.get(f.id), "macro": i.macro, "channel": i.channel, "line": i.line}
               for f in pr.functions for i in f.ipc]

    # ---- hw blocks with per-block event roll-up
    blocks = []
    for b in cfg.hw_blocks:
        evs = [e for isr in isrs for e in isr["hw_events"] if e["block"] == b.id]
        blocks.append({
            "id": b.id, "name": b.name, "base": b.base, "regs": b.regs, "group": b.group, "pos": list(b.pos),
            "line": b.line, "deadlines": cg.block_deadlines.get(b.id, []),
            "note": cfg.annotations["blocks"].get(b.id, ""),
            "reads": sum(1 for e in evs if e["kind"] == "read"),
            "writes": sum(1 for e in evs if e["kind"] in ("write", "rmw")),
            "violations": sum(1 for e in evs if e["violation"]),
            "last_access_us": max((e["t_us"] for e in evs), default=None),
            "accessors": sorted({e["fid"] for e in evs}),
        })
    known = {b.id for b in cfg.hw_blocks}
    unknown_blocks = sorted({e["block"] for isr in isrs for e in isr["hw_events"] if e["block"] not in known})

    # ---- window
    num = cfg.numerology
    win = cfg.output.get("window", {})
    t_min = min([i["abs_start_us"] for i in isrs] + [0.0])
    t_max = max([i["abs_start_us"] + max(i["computed_us"], i["length_us"] or 0) for i in isrs] + [num.slot_us])
    start = num.parse(win["start"]) if win.get("start") is not None else min(0.0, t_min - num.sym_us)
    end = num.parse(win["end"]) if win.get("end") is not None else t_max + num.sym_us

    return {
        "tool": {"name": "isrprof", "version": __version__},
        "project": {"name": cfg.name, "sources": [os.path.relpath(s, cfg.base_dir).replace("\\", "/") for s in cfg.sources]},
        "numerology": num.to_dict(),
        "window": {"start_us": round(start, 3), "end_us": round(end, 3)},
        "cores": cfg.cores,
        "timing_items": [{"id": t.id, "name": t.name, "offset_us": round(t.offset_us, 3), "priority": t.priority,
                          "color": t.color, "description": t.description, "kind": t.kind} for t in cfg.timing_items],
        "isrs": isrs,
        "functions": functions,
        "hw": {"blocks": blocks, "unknown_blocks": unknown_blocks,
               "macros": {"read": sorted(set(cfg.hw_macros["read"])), "write": sorted(set(cfg.hw_macros["write"])),
                          "rmw": sorted(set(cfg.hw_macros["rmw"]))}},
        "memory": {"variables": sorted(vars_out.values(), key=lambda v: (-len(v["accessors"]), v["name"])),
                   "heap_users": heap_users, "ipc_ops": ipc_ops, "ipc_channels": cfg.memory["ipc_channels"]},
        "structure": structure,
        "viewer": cfg.viewer,
        "llm": {"enabled": llm.enabled, "model": llm.model if llm.enabled else None, "log": llm.log,
                "tasks": {k: bool(v.get("enabled")) for k, v in cfg.llm.get("tasks", {}).items()}},
        "parse_stats": {"files": len(pr.files), "functions": len(pr.functions), "variables": len(pr.variables),
                        "macros": len(pr.macros)},
    }
