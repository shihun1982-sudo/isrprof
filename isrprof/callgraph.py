"""Build per-ISR call trees and place them on the timing axes.

Model
-----
* Each ISR has an *entry* function, an x-lane (timing item, with its offset vs NW
  timing), a start time inside that lane, and an optional measured envelope length.
* The call tree is expanded from the entry down to the leaves (recursion is cut and
  flagged).  Each node gets ``self_us`` (own cost) and ``total_us`` (self + callees).
* Children are laid out sequentially in call order, so every node has an absolute
  start time in the NW frame::

      abs_start(node) = lane.offset + isr.start + (sum of previous siblings' total)
                        + parent's self time consumed before this call

  The parent's self time is split evenly over its sequenced events (calls + HW
  accesses) so register accesses get an interpolated timestamp too.
* Every HW access becomes an *event* with an absolute time; it is compared with the
  destination block's deadline (also expressed in the NW frame) -> violation flag.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .config import Config, IsrSpec
from .cparser import FunctionDef, ParseResult


@dataclass
class Node:
    fid: str
    name: str
    depth: int
    start_us: float
    self_us: float
    total_us: float
    children: list["Node"] = field(default_factory=list)
    external: bool = False
    recursive: bool = False
    truncated: bool = False
    hw_events: list[dict] = field(default_factory=list)
    call_line: int = 0
    via_table: str = ""       # set when reached through a function-pointer / dispatch-table call

    def to_dict(self) -> dict:
        return {
            "fid": self.fid, "name": self.name, "depth": self.depth,
            "start_us": round(self.start_us, 3), "self_us": round(self.self_us, 3),
            "total_us": round(self.total_us, 3), "external": self.external,
            "recursive": self.recursive, "truncated": self.truncated, "call_line": self.call_line,
            "via_table": self.via_table,
            "hw_events": self.hw_events, "children": [c.to_dict() for c in self.children],
        }


class CallGraph:
    def __init__(self, cfg: Config, pr: ParseResult, costs: dict[str, float]):
        self.cfg = cfg
        self.pr = pr
        self.costs = costs                     # function id -> self cost in us
        self.by_name: dict[str, list[FunctionDef]] = {}
        self.by_id: dict[str, FunctionDef] = {}
        for f in pr.functions:
            self.by_name.setdefault(f.name, []).append(f)
            self.by_id[f.id] = f
        self.max_depth = int(cfg.raw.get("callgraph", {}).get("max_depth", 24))
        self.block_deadlines = self._deadlines_nw()

    # ------------------------------------------------------------------ resolution
    def resolve(self, callee: str, from_file: str) -> FunctionDef | None:
        cands = self.by_name.get(callee)
        if not cands:
            return None
        for c in cands:
            if c.file == from_file:
                return c
        for c in cands:
            if not c.is_static:
                return c
        return cands[0]

    def _deadlines_nw(self) -> dict[str, list[dict]]:
        """block id -> list of deadline specs resolved to the NW frame."""
        out: dict[str, list[dict]] = {}
        for b in self.cfg.hw_blocks:
            for dl in b.deadlines:
                lane = self.cfg.timing(dl["timing"])
                out.setdefault(b.id, []).append({
                    "block": b.id, "timing": lane.id, "offset_us": lane.offset_us,
                    "at_us": dl["at_us"],                      # within the lane frame
                    "period_us": dl["period_us"],              # None -> one-shot
                    "abs_us": lane.offset_us + dl["at_us"],    # first occurrence, NW frame
                    "note": dl.get("note", ""),
                    "cores": dl.get("cores"), "isrs": dl.get("isrs"),
                })
        return out

    def check_deadline(self, block: str, t_abs: float, core: int, isr_name: str) -> tuple[float | None, bool, str]:
        """Return (deadline instant in NW frame that applies to this access, violated?, note)."""
        best: tuple[float | None, bool, str] = (None, False, "")
        for dl in self.block_deadlines.get(block, []):
            if dl["cores"] is not None and core not in dl["cores"]:
                continue
            if dl["isrs"] is not None and isr_name not in dl["isrs"]:
                continue
            t_lane = t_abs - dl["offset_us"]
            if dl["period_us"]:
                k = math.floor(t_lane / dl["period_us"])
                instant = dl["offset_us"] + k * dl["period_us"] + dl["at_us"]
            else:
                instant = dl["abs_us"]
            violated = t_abs > instant + 1e-6
            if best[0] is None or instant < best[0] or (violated and not best[1]):
                best = (instant, violated or best[1], dl["note"])
        return best

    def cost_of(self, f: FunctionDef | None, callee: str) -> float:
        if f is None:
            return self.costs.get(callee, self.cfg.cost_model["external_cost_us"])
        return self.costs.get(f.id, self.costs.get(f.name, self.cfg.cost_model["default_cost_us"]))

    # ------------------------------------------------------------------ tree
    def build_isr(self, isr: IsrSpec) -> dict:
        lane = self.cfg.timing(isr.timing)
        base = lane.offset_us + isr.start_us
        entry = self.resolve(isr.entry, "")
        if entry is None:
            root = Node(fid=isr.entry, name=isr.entry, depth=0, start_us=base, self_us=0.0,
                        total_us=0.0, external=True)
            return self._finish(isr, lane, root, [])
        events: list[dict] = []
        root = self._expand(entry, depth=0, start=base, stack=[], events=events,
                            period_us=isr.period_us, lane_id=lane.id, isr_name=isr.name, core=isr.core)
        return self._finish(isr, lane, root, events)

    def _finish(self, isr, lane, root, events):
        computed = root.total_us
        budget = isr.length_us
        over = budget is not None and computed > budget + 1e-6
        # per-ISR summary of blocks touched
        blocks: dict[str, dict] = {}
        for e in events:
            b = blocks.setdefault(e["block"], {"block": e["block"], "r": 0, "w": 0, "rmw": 0,
                                                "last_us": 0.0, "violations": 0})
            b[{"read": "r", "write": "w", "rmw": "rmw"}[e["kind"]]] += 1
            b["last_us"] = max(b["last_us"], e["t_us"])
            b["violations"] += 1 if e["violation"] else 0
        return {
            "name": isr.name, "core": isr.core, "timing": lane.id, "entry": isr.entry,
            "priority": isr.priority, "description": isr.description,
            "start_us": round(isr.start_us, 3), "abs_start_us": round(lane.offset_us + isr.start_us, 3),
            "length_us": None if budget is None else round(budget, 3),
            "period_us": None if isr.period_us is None else round(isr.period_us, 3),
            "computed_us": round(computed, 3), "over_budget": over,
            "tree": root.to_dict(), "hw_events": events,
            "blocks": sorted(blocks.values(), key=lambda b: b["block"]),
            "functions": sorted(self._collect_fids(root)),
        }

    def _collect_fids(self, n: Node, acc=None) -> set[str]:
        acc = set() if acc is None else acc
        acc.add(n.fid)
        for c in n.children:
            self._collect_fids(c, acc)
        return acc

    def _expand(self, f: FunctionDef, depth: int, start: float, stack: list[str],
                events: list[dict], period_us, lane_id: str, isr_name: str, core: int = 0,
                call_line: int = 0) -> Node:
        self_us = self.cost_of(f, f.name)
        node = Node(fid=f.id, name=f.name, depth=depth, start_us=start, self_us=self_us,
                    total_us=self_us, call_line=call_line)
        if f.id in stack:
            node.recursive = True
            return node
        if depth >= self.max_depth:
            node.truncated = True
            return node
        # sequenced events: calls + hw accesses, ordered by seq
        seq_items: list[tuple[int, str, object]] = []
        for c in f.calls:
            seq_items.append((c.seq, "call", c))
        for h in f.hw:
            seq_items.append((h.seq, "hw", h))
        seq_items.sort(key=lambda x: x[0])
        n_events = max(1, f.n_seq)
        slice_us = self_us / n_events
        cursor = start
        stack.append(f.id)
        for seq, kind, obj in seq_items:
            # the parent's own time consumed up to this event
            t_event = start + slice_us * seq + sum(c.total_us for c in node.children)
            if kind == "hw":
                h = obj
                instant, violated, note = self.check_deadline(h.block, t_event, core, isr_name)
                ev = {
                    "t_us": round(t_event, 3), "block": h.block, "reg": h.reg, "kind": h.kind,
                    "macro": h.macro, "fid": f.id, "func": f.name, "line": h.line,
                    "isr": isr_name, "lane": lane_id,
                    "deadline_us": None if instant is None else round(instant, 3),
                    "deadline_note": note,
                    "violation": violated,
                    "unknown_block": h.block not in {b.id for b in self.cfg.hw_blocks},
                }
                events.append(ev)
                node.hw_events.append(ev)
                continue
            c = obj
            if c.indirect:
                # call through a struct member / function pointer: expand every function that is
                # referenced in a file-scope table of this file (stage / dispatch tables), in table order
                cands = [self.resolve(nm, f.file) for nm in self.pr.table_refs.get(f.file, [])]
                cands = [t for t in cands if t is not None and t.id not in stack and t.id != f.id]
                if cands:
                    for t in cands:
                        t_child = start + slice_us * seq + sum(ch.total_us for ch in node.children)
                        child = self._expand(t, depth + 1, t_child, stack, events, period_us,
                                             lane_id, isr_name, core=core, call_line=c.line)
                        child.via_table = c.callee
                        node.children.append(child)
                    continue
                child = Node(fid=c.callee, name=c.callee, depth=depth + 1, start_us=t_event,
                             self_us=self.cfg.cost_model["external_cost_us"],
                             total_us=self.cfg.cost_model["external_cost_us"], external=True,
                             call_line=c.line)
                node.children.append(child)
                continue
            target = self.resolve(c.callee, f.file)
            if target is None:
                cost = self.cost_of(None, c.callee)
                child = Node(fid=c.callee, name=c.callee, depth=depth + 1, start_us=t_event,
                             self_us=cost, total_us=cost, external=True, call_line=c.line)
            else:
                child = self._expand(target, depth + 1, t_event, stack, events, period_us,
                                     lane_id, isr_name, core=core, call_line=c.line)
            node.children.append(child)
        stack.pop()
        node.total_us = self_us + sum(c.total_us for c in node.children)
        return node

    # ------------------------------------------------------------------ all
    def build_all(self) -> list[dict]:
        return [self.build_isr(isr) for isr in self.cfg.isrs]

    def static_graph(self) -> dict[str, list[str]]:
        """Function-id -> list of callee ids (resolved) for the whole project."""
        g: dict[str, list[str]] = {}
        for f in self.pr.functions:
            outs = []
            for c in f.calls:
                if c.indirect:
                    for nm in self.pr.table_refs.get(f.file, []):
                        t = self.resolve(nm, f.file)
                        if t is not None and t.id != f.id:
                            outs.append(t.id)
                    continue
                t = self.resolve(c.callee, f.file)
                outs.append(t.id if t else c.callee)
            g[f.id] = outs
        return g
