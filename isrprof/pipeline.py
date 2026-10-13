"""Glue: config -> parse -> costs -> call trees -> structure -> profile dict."""
from __future__ import annotations

import csv
import fnmatch
import os
import time

from . import __version__
from . import build as buildmod
from .callgraph import CallGraph
from .config import Config, StructNode
from .cparser import parse
from . import deep as deepmod
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


class _FileMap:
    """file -> (core id, module name) resolved once.  Exact file patterns (the common case) go through a
    dict; only wildcard patterns are fnmatch'ed, in config order (first match wins, as before)."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.cache: dict[str, tuple[int | None, str | None]] = {}
        self.exact: dict[str, tuple[int, str, int]] = {}          # rel path or basename -> (core, module, order)
        self.globs: list[tuple[str, int, str, int]] = []           # (pattern, core, module, order)
        order = 0
        for core in cfg.cores:
            for m in core.get("modules", []):
                for pat in m.get("files", []):
                    if any(ch in pat for ch in "*?["):
                        self.globs.append((pat, core["id"], m["name"], order))
                    else:
                        self.exact.setdefault(pat.replace("\\", "/"), (core["id"], m["name"], order))
                    order += 1

    def lookup(self, path: str) -> tuple[int | None, str | None]:
        hit = self.cache.get(path)
        if hit is not None:
            return hit
        rel = os.path.relpath(path, self.cfg.src_root).replace("\\", "/")
        base = os.path.basename(path)
        best: tuple[int, int, str] | None = None                  # (order, core, module)
        for key in (rel, base):
            e = self.exact.get(key)
            if e is not None and (best is None or e[2] < best[0]):
                best = (e[2], e[0], e[1])
        for pat, core, mod, order in self.globs:
            if best is not None and order > best[0]:
                break
            if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(base, pat):
                best = (order, core, mod)
                break
        res: tuple[int | None, str | None] = (best[1], best[2]) if best else (None, None)
        self.cache[path] = res
        return res


def _rel(cfg: Config, path: str) -> str:
    return path if path.startswith("<") else os.path.relpath(path, cfg.src_root).replace("\\", "/")


def run(cfg: Config) -> dict:
    t0 = time.perf_counter()
    pr = parse(cfg)
    deep_stats = None
    graph_deep = deepmod.run(cfg)
    if graph_deep is not None:
        deep_stats = deepmod.apply(cfg, pr, graph_deep)
    t_parse = time.perf_counter()
    llm = LLMAssist(cfg)
    fmap = _FileMap(cfg)

    # ---- optional: macro classification for unknown register macros
    if llm.task_enabled("classify_hw_macro"):
        unknown = {k: v for k, v in pr.macros.items()
                   if ("volatile" in v or "REG" in k) and k not in cfg.hw_macros["read"] + cfg.hw_macros["write"]}
        for name, info in llm.classify_hw_macros(unknown).items():
            cfg.hw_macros[info.get("kind", "read")].append(name)
        pr = parse(cfg)   # re-parse with the enriched macro lists

    # ---- cost resolution (priority: trace > config > llm > default)
    costs: dict[str, float] = {}
    cost_src: dict[str, str] = {}
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
                cost_src[f.id] = "trace"
                break
            if src == "config":
                c = conf_cost(f)
                if c is not None:
                    costs[f.id] = c
                    cost_src[f.id] = "config"
                    break
            if src == "llm" and llm.task_enabled("estimate_costs"):
                core_id = fmap.lookup(f.file)[0]
                core = cfg.core(core_id) if core_id is not None else cfg.cores[0]
                est = llm.estimate_costs([f], core["name"], core["clock_mhz"])
                if f.id in est:
                    costs[f.id] = est[f.id]
                    cost_src[f.id] = "llm"
                    break
    for name, us in conf.items():      # external functions (no definition) can also be priced
        if not any(ch in name for ch in "*?["):
            costs.setdefault(name, us)

    cg = CallGraph(cfg, pr, costs)
    isrs = cg.build_all()
    graph = cg.static_graph()

    fid_to_core: dict[str, int] = {}
    fid_module: dict[str, str] = {}
    for f in pr.functions:
        c, m = fmap.lookup(f.file)
        if c is not None:
            fid_to_core[f.id] = c
        fid_module[f.id] = m or os.path.splitext(os.path.basename(f.file))[0]
    exec_cores: dict[str, set[int]] = {}   # fid -> cores whose ISRs execute it
    for isr in isrs:                    # anything reachable from an ISR inherits the ISR's core if unknown
        for fid in isr["functions"]:
            fid_to_core.setdefault(fid, isr["core"])
            exec_cores.setdefault(fid, set()).add(isr["core"])

    analyzer = StructureAnalyzer(cfg, pr, graph, isrs, fid_to_core)
    analyzer._module_by_file = {f.file: fid_module[f.id] for f in pr.functions}
    structure = analyzer.analyze()
    summaries = llm.summarize(pr.functions) if llm.task_enabled("summarize") else {}

    # ---- resolve call targets once (used by the function table and the viewer's closure walks)
    resolved: dict[tuple[str, str], str | None] = {}

    def res_id(callee: str, file: str) -> str | None:
        key = (callee, file)
        if key not in resolved:
            t = cg.resolve(callee, file)
            resolved[key] = t.id if t else None
        return resolved[key]

    # ---- function table
    functions = {}
    for f in pr.functions:
        functions[f.id] = {
            "id": f.id, "name": f.name, "file": _rel(cfg, f.file),
            "line": f.line, "end_line": f.end_line, "static": f.is_static, "signature": f.signature,
            "core": fid_to_core.get(f.id), "module": fid_module[f.id],
            "self_us": round(costs.get(f.id, cfg.cost_model["default_cost_us"]), 3),
            "cost_source": cost_src.get(f.id, "default"),
            "calls": [{"callee": c.callee, "line": c.line, "indirect": c.indirect, "kind": getattr(c, "call_kind", "") or ("member" if getattr(c, "member", False) else ("indirect" if c.indirect else "direct")),
                       "callee_id": None if c.indirect else res_id(c.callee, f.file),
                       # indirect (member / virtual / function-pointer) call: the resolved candidates
                       "callee_ids": ([t.id for t in cg._indirect_targets(c, f) if t.id != f.id] if c.indirect else [])}
                      for c in f.calls],
            "hw": [{"macro": h.macro, "kind": h.kind, "block": h.block, "reg": h.reg, "line": h.line, "seq": h.seq} for h in f.hw],
            "vars": [{"name": v.name, "rw": v.rw, "line": v.line, "kind": v.kind, "seq": v.seq, "member": v.member, "via_macro": v.via_macro} for v in f.vars],
            "heap": [{"fn": c.callee, "line": c.line, "seq": c.seq} for c in f.heap],
            "ipc": [{"macro": i.macro, "channel": i.channel, "line": i.line, "seq": i.seq} for i in f.ipc],
            "n_seq": max(1, f.n_seq),
            "static_locals": f.static_locals,
            "precise": bool(getattr(f, "deep", False)), "kind": getattr(f, "kind", "function"), "cls": getattr(f, "cls", ""),
            "virtual": bool(getattr(f, "virtual", False)), "overrides": list(getattr(f, "overrides", []) or []),
            "summary": summaries.get(f.id, ""),
            "note": cfg.annotations["functions"].get(f.id, cfg.annotations["functions"].get(f.name, "")),
        }

    # ---- memory view: variables + accessors
    vars_out: dict[str, dict] = {}
    for v in pr.variables:
        key = v.name if v.kind != "static" else f"{v.name}@{os.path.basename(v.file)}"
        vars_out.setdefault(key, {"key": key, "name": v.name, "kind": v.kind, "file": _rel(cfg, v.file),
                                  "line": v.line, "decl": v.decl, "accessors": [], "cores": set(), "fields": {},
                                  "registered": v.file == "<config>"})
    for f in pr.functions:
        for a in f.vars:
            key = a.name if a.kind != "static" else f"{a.name}@{os.path.basename(f.file)}"
            if a.kind == "static_local":
                key = f"{a.name}@{f.name}"
                vars_out.setdefault(key, {"key": key, "name": a.name, "kind": "static_local", "file": _rel(cfg, f.file),
                                          "line": a.line, "decl": f"static local in {f.name}", "accessors": [], "cores": set(),
                                          "fields": {}, "registered": False})
            if key not in vars_out:
                if a.via_macro:          # accessor macro for a name that was not registered: create it on the fly
                    vars_out[key] = {"key": key, "name": a.name, "kind": a.kind, "file": "<macro>", "line": 0, "decl": f"via {a.via_macro}",
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

    # ---- SW structure: declared hierarchy + implicit nodes for unassigned modules / detected shared memory
    sw_nodes: list[StructNode] = list(cfg.sw_nodes)
    node_by_id = {n.id: n for n in sw_nodes}
    module_node: dict[str, str] = {}
    for n in sw_nodes:
        if n.files:
            module_node[n.id] = n.id
    func_globs = [(n.id, pat) for n in sw_nodes for pat in n.functions]
    fn_node: dict[str, str] = {}
    for f in pr.functions:
        m = fid_module[f.id]
        nid = module_node.get(m)
        if nid is None:
            for owner, pat in func_globs:
                if fnmatch.fnmatch(f.name, pat) or fnmatch.fnmatch(f.id, pat):
                    nid = owner
                    break
        if nid is None:                                   # implicit module node under its core
            core = fid_to_core.get(f.id)
            parent_id = f"_auto_core{core}" if core is not None else "_auto_unassigned"
            if parent_id not in node_by_id:
                cname = cfg.core(core)["name"] if core is not None else "unassigned"
                pn = StructNode(id=parent_id, name=f"{cname} · files without SW node", kind="subsystem", core=core,
                                depth=0, note="functions from files that no sw_structure node claims")
                sw_nodes.append(pn)
                node_by_id[parent_id] = pn
            nid = f"{parent_id}/{m}"
            if nid not in node_by_id:
                mn = StructNode(id=nid, name=m, kind="module", parent=parent_id, depth=1, core=fid_to_core.get(f.id))
                sw_nodes.append(mn)
                node_by_id[nid] = mn
                node_by_id[parent_id].children.append(nid)
            module_node[m] = nid
        fn_node[f.id] = nid
    var_node: dict[str, str] = {}
    for n in sw_nodes:
        for vname in n.variables:
            for key, v in vars_out.items():
                if v["name"] == vname:
                    var_node.setdefault(key, n.id)
    auto = cfg.memory.get("auto_variables", "cross_core")
    if auto != "none":
        for key, v in vars_out.items():
            if key in var_node or not v["accessors"]:
                continue
            if auto == "cross_core" and not v["shared_across_cores"]:
                continue
            pid = "_auto_shared"
            if pid not in node_by_id:
                pn = StructNode(id=pid, name="Shared memory · detected (cross-core)" if auto == "cross_core" else "Variables · detected",
                                kind="shared_memory", depth=0, note="globals touched from more than one core that no sw_structure node declares")
                sw_nodes.append(pn)
                node_by_id[pid] = pn
            nid = f"{pid}/{key}"
            vn = StructNode(id=nid, name=v["name"], kind="variable", parent=pid, depth=1, variables=[v["name"]],
                            type=v["decl"][:60])
            sw_nodes.append(vn)
            node_by_id[nid] = vn
            node_by_id[pid].children.append(nid)
            var_node[key] = nid
    # function -> nodes it touches: own module (x = executes in), variables (r / w / rw / addr)
    touch: dict[str, list] = {}
    for f in pr.functions:
        acc: dict[str, str] = {fn_node[f.id]: "x"}
        for a in f.vars:
            key = a.name if a.kind != "static" else f"{a.name}@{os.path.basename(f.file)}"
            if a.kind == "static_local":
                key = f"{a.name}@{f.name}"
            nid = var_node.get(key)
            if nid is None:
                continue
            prev = acc.get(nid)
            rw = a.rw if a.rw != "addr" else "r"
            if prev is None or prev == "x":
                acc[nid] = rw
            elif prev != rw and prev != "rw":
                acc[nid] = "rw" if {prev, rw} <= {"r", "w", "rw"} else prev
        touch[f.id] = [[k, v] for k, v in acc.items()]
    node_fids: dict[str, list[str]] = {}
    for fid, nid in fn_node.items():
        node_fids.setdefault(nid, []).append(fid)
    node_vars: dict[str, list[str]] = {}
    for key, nid in var_node.items():
        node_vars.setdefault(nid, []).append(key)
    # derived relations: IPC between the modules of sender / receiver functions
    derived = []
    seen_rel = set()
    chans = {c["id"]: c for c in cfg.memory["ipc_channels"]}
    senders: dict[str, set[str]] = {}
    receivers: dict[str, set[str]] = {}
    for op in ipc_ops:
        (receivers if op["macro"] == "IPC_RECV" or op["macro"].endswith("RECV") else senders).setdefault(op["channel"], set()).add(fn_node[op["fid"]])
    root_of = {}
    for n in sw_nodes:
        r = n
        while r.parent and r.parent in node_by_id:
            r = node_by_id[r.parent]
        root_of[n.id] = r.id
    pairs = sum(len(src) * len(receivers.get(ch, ())) for ch, src in senders.items())
    coarse = pairs > 300            # big trees: one arrow per subsystem pair instead of per module pair
    derived_skipped = 0
    for ch, src in senders.items():
        for a in src:
            for b in receivers.get(ch, set()):
                a2, b2 = (root_of[a], root_of[b]) if coarse else (a, b)
                if a2 != b2 and (a2, b2, ch) not in seen_rel:
                    seen_rel.add((a2, b2, ch))
                    if len(derived) >= 400:          # keep the diagram readable; the IPC rows / details still list every op
                        derived_skipped += 1
                        continue
                    derived.append({"from": a2, "to": b2, "kind": "ipc", "label": ch, "derived": True})
    sw_structure = {
        "depth": cfg.sw_depth,
        "nodes": [{"id": n.id, "name": n.name, "kind": n.kind, "parent": n.parent, "depth": n.depth, "children": n.children,
                   "core": n.core, "type": n.type, "note": n.note or cfg.annotations.get("nodes", {}).get(n.id, ""),
                   "color": n.color, "functions": sorted(node_fids.get(n.id, [])), "variables": sorted(node_vars.get(n.id, [])),
                   "implicit": n.id.startswith("_auto")} for n in sw_nodes],
        "relations": [{"from": r["from_"], "to": r["to"], "kind": r["kind"], "label": r["label"], "note": r["note"], "derived": False}
                      for r in cfg.sw_relations] + derived,
        "touch": touch,
        "derived_skipped": derived_skipped,
        "fn_node": fn_node,
        "var_node": var_node,
    }

    # ---- hw blocks with per-block event roll-up + HW structure
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
    hw_nodes = [{"id": n.id, "name": n.name, "kind": n.kind, "parent": n.parent, "depth": n.depth, "children": n.children,
                 "note": n.note or cfg.annotations["blocks"].get(n.id, ""), "color": n.color,
                 "block": n.id in known} for n in cfg.hw_nodes]
    if unknown_blocks:
        hw_nodes.append({"id": "_auto_hw", "name": "Blocks referenced by code but not declared", "kind": "group", "parent": None,
                         "depth": 0, "children": unknown_blocks, "note": "", "color": None, "block": False})
        for ub in unknown_blocks:
            hw_nodes.append({"id": ub, "name": ub, "kind": "block", "parent": "_auto_hw", "depth": 1, "children": [], "note": "",
                             "color": None, "block": True})
    hw_structure = {"depth": cfg.hw_depth, "nodes": hw_nodes,
                    "links": [{"from": l["from_"], "to": l["to"], "kind": l["kind"], "label": l["label"]} for l in cfg.hw_links]}

    # ---- window
    num = cfg.numerology
    win = cfg.output.get("window", {})
    t_min = min([i["abs_start_us"] for i in isrs] + [0.0])
    t_max = max([i["abs_start_us"] + max(i["computed_us"], i["length_us"] or 0) for i in isrs] + [num.slot_us])
    start = num.parse(win["start"]) if win.get("start") is not None else min(0.0, t_min - num.sym_us)
    end = num.parse(win["end"]) if win.get("end") is not None else t_max + num.sym_us

    t_end = time.perf_counter()
    return {
        "tool": {"name": "isrprof", "version": __version__},
        "project": {"name": cfg.name, "profile": cfg.meta.name if cfg.meta else cfg.name,
                    "sources": [_rel(cfg, s) for s in cfg.sources]},
        "build": buildmod.summary(cfg.build),
        "deep": deep_stats,
        "numerology": num.to_dict(),
        "window": {"start_us": round(start, 3), "end_us": round(end, 3)},
        "cores": [{k: v for k, v in c.items() if k != "modules"} | {"modules": [m["name"] for m in c["modules"]]} for c in cfg.cores],
        "timing_items": [{"id": t.id, "name": t.name, "offset_us": round(t.offset_us, 3), "priority": t.priority,
                          "color": t.color, "description": t.description, "kind": t.kind} for t in cfg.timing_items],
        "channels": cfg.channels,
        "isrs": isrs,
        "functions": functions,
        "hw": {"blocks": blocks, "unknown_blocks": unknown_blocks,
               "macros": {"read": sorted(set(cfg.hw_macros["read"])), "write": sorted(set(cfg.hw_macros["write"])),
                          "rmw": sorted(set(cfg.hw_macros["rmw"]))}},
        "hw_structure": hw_structure,
        "sw_structure": sw_structure,
        "memory": {"variables": sorted(vars_out.values(), key=lambda v: (-len(v["accessors"]), v["name"])),
                   "heap_users": heap_users, "ipc_ops": ipc_ops, "ipc_channels": cfg.memory["ipc_channels"]},
        "structure": structure,
        "viewer": cfg.viewer,
        "llm": {"enabled": llm.enabled, "model": llm.model if llm.enabled else None, "log": llm.log,
                "tasks": {k: bool(v.get("enabled")) for k, v in cfg.llm.get("tasks", {}).items()}},
        "parse_stats": {"files": len(pr.files), "functions": len(pr.functions), "variables": len(pr.variables),
                        "macros": len(pr.macros), "parse_ms": round((t_parse - t0) * 1000),
                        "total_ms": round((t_end - t0) * 1000)},
    }
