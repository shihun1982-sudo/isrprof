"""Structure101-style structural analysis of the ISR call graph.

Produces, for the set of functions reachable from the configured ISRs (plus
optionally everything else):

* **DSM** (Dependency Structure Matrix) - rows = callers, columns = callees,
  ordered by *levelization* (highest level first, grouped by module).  With this
  order every "healthy" dependency sits in the upper-right triangle; anything in
  the lower-left is a *feedback* dependency, i.e. part of a cycle.
* **Tangles** - strongly connected components with more than one member
  (Tarjan).  Structure101 calls these tangles; the tangled % metric is the share
  of dependencies that participate in a cycle.
* **Levels / LSM** - the Levelized Structure Map: level 0 = leaves, level n = 1 +
  max(level of callees), computed on the condensation DAG so tangles share a
  level.
* **Fat** - for a module: number of dependency edges among its direct children
  (functions); for the whole system: edges among modules.  Over the threshold ->
  "overweight" (Structure101 XS).
* **Layer rule violations** - every function is assigned to a layer by glob
  patterns; a call from a lower layer to a higher one is an upward violation,
  a call that skips a layer is a "skip" (reported only if disallowed).
* **Per-ISR slices** - the subset of all of the above reachable from each ISR, so
  the viewer can show "what structure does DL_SYMBOL_ISR actually drag in".
"""
from __future__ import annotations

import fnmatch
import os
from collections import defaultdict

from .config import Config
from .cparser import ParseResult


def _tarjan(nodes: list[str], adj: dict[str, list[str]]) -> list[list[str]]:
    index = {}
    low = {}
    on = set()
    stack: list[str] = []
    out: list[list[str]] = []
    counter = [0]

    def strong(v: str):
        # iterative to survive deep graphs
        work = [(v, iter(adj.get(v, [])))]
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on.add(v)
        while work:
            node, it = work[-1]
            advanced = False
            for w in it:
                if w not in index:
                    index[w] = low[w] = counter[0]
                    counter[0] += 1
                    stack.append(w)
                    on.add(w)
                    work.append((w, iter(adj.get(w, []))))
                    advanced = True
                    break
                elif w in on:
                    low[node] = min(low[node], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == node:
                        break
                out.append(comp)

    for v in nodes:
        if v not in index:
            strong(v)
    return out


class StructureAnalyzer:
    def __init__(self, cfg: Config, pr: ParseResult, graph: dict[str, list[str]],
                 isrs: list[dict], fid_to_core: dict[str, int]):
        self.cfg = cfg
        self.pr = pr
        self.graph = graph
        self.isrs = isrs
        self.fid_to_core = fid_to_core
        self.func_meta = {f.id: f for f in pr.functions}
        self.layers = cfg.layers
        self.ignore_external = cfg.architecture["ignore_external"]
        # file -> module and fid -> layer are resolved once (fnmatch over every pattern per call is the
        # dominant cost on big trees); the pipeline can hand in its own file map to share the work
        self._module_by_file: dict[str, str] = {}
        self._layer_by_fid: dict[str, int | None] = {}
        self._mod_patterns = [(m["name"], pat) for core in cfg.cores for m in core.get("modules", []) for pat in m.get("files", [])]
        self._rel_cache: dict[str, tuple[str, str]] = {}

    def _rel(self, path: str) -> tuple[str, str]:
        r = self._rel_cache.get(path)
        if r is None:
            r = (os.path.relpath(path, self.cfg.src_root).replace("\\", "/"), os.path.basename(path))
            self._rel_cache[path] = r
        return r

    # ---------------------------------------------------------------- helpers
    def module_of(self, fid: str) -> str:
        f = self.func_meta.get(fid)
        if f is None:
            return "<external>"
        m = self._module_by_file.get(f.file)
        if m is None:
            rel, base = self._rel(f.file)
            m = next((name for name, pat in self._mod_patterns if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(base, pat)),
                     os.path.splitext(base)[0])
            self._module_by_file[f.file] = m
        return m

    def layer_of(self, fid: str) -> int | None:
        if fid in self._layer_by_fid:
            return self._layer_by_fid[fid]
        f = self.func_meta.get(fid)
        name = fid.split("@")[0]
        rel, base = ("", "") if f is None else self._rel(f.file)
        mod = self.module_of(fid)
        res = None
        for i, L in enumerate(self.layers):
            if any(fnmatch.fnmatchcase(name, p) for p in L.functions):
                res = i
                break
            if f is not None and any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(base, p) for p in L.files):
                res = i
                break
            if mod in L.modules:
                res = i
                break
        self._layer_by_fid[fid] = res
        return res

    # ---------------------------------------------------------------- main
    def analyze(self) -> dict:
        reach_all: set[str] = set()
        slices: dict[str, list[str]] = {}
        for isr in self.isrs:
            fids = set(isr["functions"])
            slices[isr["name"]] = sorted(fids)
            reach_all |= fids
        include_unreached = bool(self.cfg.architecture.get("include_unreached", False))
        nodes = set(reach_all)
        if include_unreached:
            nodes |= set(self.graph.keys())
        if self.ignore_external:
            nodes = {n for n in nodes if n in self.func_meta}
        nodes_l = sorted(nodes)

        adj: dict[str, list[str]] = {}
        edges: dict[tuple[str, str], int] = defaultdict(int)
        for a in nodes_l:
            outs = []
            for b in self.graph.get(a, []):
                if b in nodes:
                    outs.append(b)
                    edges[(a, b)] += 1
            adj[a] = sorted(set(outs))

        sccs = _tarjan(nodes_l, adj)
        comp_of: dict[str, int] = {}
        for ci, comp in enumerate(sccs):
            for v in comp:
                comp_of[v] = ci
        tangles = [sorted(c) for c in sccs if len(c) > 1]
        tangle_members = {v for t in tangles for v in t}

        # condensation DAG + levels (0 = leaf)
        cadj: dict[int, set[int]] = defaultdict(set)
        for (a, b) in edges:
            if comp_of[a] != comp_of[b]:
                cadj[comp_of[a]].add(comp_of[b])
        level_c: dict[int, int] = {}

        def lvl(c: int) -> int:
            if c in level_c:
                return level_c[c]
            level_c[c] = 0  # guard
            v = 0
            for d in cadj.get(c, ()):
                v = max(v, lvl(d) + 1)
            level_c[c] = v
            return v

        for ci in range(len(sccs)):
            lvl(ci)
        level = {v: level_c[comp_of[v]] for v in nodes_l}

        # layers
        layer = {v: self.layer_of(v) for v in nodes_l}
        module = {v: self.module_of(v) for v in nodes_l}

        # DSM order: level desc, then module, then name
        order = sorted(nodes_l, key=lambda v: (-level[v], module[v], v))
        pos = {v: i for i, v in enumerate(order)}
        matrix = []
        feedback_edges = 0
        for (a, b), n in sorted(edges.items()):
            fb = pos[a] > pos[b]  # lower-left triangle = feedback (cycle) dependency
            if fb:
                feedback_edges += 1
            matrix.append([pos[a], pos[b], n, 1 if fb else 0])

        # layer violations
        violations = []
        for (a, b), n in sorted(edges.items()):
            la, lb = layer[a], layer[b]
            if la is None or lb is None:
                continue
            if lb < la:
                violations.append({"from": a, "to": b, "kind": "upward",
                                   "from_layer": self.layers[la].name, "to_layer": self.layers[lb].name, "n": n})
            elif lb > la + 1 and not self.cfg.architecture["allow_skip_layer"]:
                violations.append({"from": a, "to": b, "kind": "skip",
                                   "from_layer": self.layers[la].name, "to_layer": self.layers[lb].name, "n": n})
        for rule in self.cfg.architecture["rules"]:
            deny = rule.get("deny")
            if not deny:
                continue
            src_pat, dst_pat = deny.get("from", "*"), deny.get("to", "*")
            for (a, b), n in edges.items():
                if fnmatch.fnmatch(a, src_pat) and fnmatch.fnmatch(b, dst_pat):
                    violations.append({"from": a, "to": b, "kind": "rule", "rule": rule.get("name", f"{src_pat}->{dst_pat}"),
                                       "from_layer": "", "to_layer": "", "n": n})

        # module metrics
        mods: dict[str, dict] = {}
        for v in nodes_l:
            m = mods.setdefault(module[v], {"name": module[v], "functions": [], "fat": 0, "fan_in": 0,
                                            "fan_out": 0, "tangled": 0, "core": None, "layer": None})
            m["functions"].append(v)
            c = self.fid_to_core.get(v)
            if c is not None and m["core"] is None:
                m["core"] = c
            if layer[v] is not None and m["layer"] is None:
                m["layer"] = self.layers[layer[v]].name
            if v in tangle_members:
                m["tangled"] += 1
        mod_edges: dict[tuple[str, str], int] = defaultdict(int)
        for (a, b), n in edges.items():
            ma, mb = module[a], module[b]
            if ma == mb:
                mods[ma]["fat"] += 1
            else:
                mod_edges[(ma, mb)] += n
                mods[ma]["fan_out"] += 1
                mods[mb]["fan_in"] += 1
        fat_t = self.cfg.architecture["fat_threshold"]
        for m in mods.values():
            m["overweight"] = m["fat"] > fat_t
            m["functions"].sort(key=lambda v: (-level[v], v))
        # module-level tangles
        mod_adj = defaultdict(list)
        for (ma, mb) in mod_edges:
            mod_adj[ma].append(mb)
        mod_sccs = [sorted(c) for c in _tarjan(sorted(mods), mod_adj) if len(c) > 1]
        mod_level: dict[str, int] = {m: max(level[v] for v in d["functions"]) for m, d in mods.items()}

        per_func = {}
        for v in nodes_l:
            f = self.func_meta.get(v)
            per_func[v] = {
                "level": level[v], "module": module[v],
                "layer": None if layer[v] is None else self.layers[layer[v]].name,
                "fan_in": sum(1 for (a, b) in edges if b == v),
                "fan_out": len(adj[v]),
                "tangled": v in tangle_members,
                "scc": comp_of[v] if v in tangle_members else None,
                "core": self.fid_to_core.get(v),
                "file": None if f is None else os.path.relpath(f.file, self.cfg.src_root).replace("\\", "/"),
                "line": None if f is None else f.line,
            }

        total_edges = len(edges)
        return {
            "order": order,
            "matrix": matrix,                       # [row, col, n, feedback]
            "functions": per_func,
            "tangles": tangles,
            "module_tangles": mod_sccs,
            "modules": sorted(mods.values(), key=lambda m: (-mod_level[m["name"]], m["name"])),
            "module_edges": [[a, b, n] for (a, b), n in sorted(mod_edges.items())],
            "module_levels": mod_level,
            "layers": [L.name for L in self.layers],
            "violations": violations,
            "slices": slices,
            "metrics": {
                "functions": len(nodes_l),
                "dependencies": total_edges,
                "feedback_dependencies": feedback_edges,
                "tangled_pct": round(100.0 * feedback_edges / total_edges, 1) if total_edges else 0.0,
                "tangles": len(tangles),
                "max_level": max(level.values()) if level else 0,
                "system_fat": len(mod_edges),
                "fat_threshold": fat_t,
                "overweight_modules": [m["name"] for m in mods.values() if m["overweight"]],
                "layer_violations": len(violations),
            },
        }
