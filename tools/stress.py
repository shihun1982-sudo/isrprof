"""Stress / monkey test: random multi-file C and C++ firmware trees are generated, analysed end to end
(token parser, and the deep backends when available), the viewer is written, and a sample of the viewers
is driven through the browser self-test.

    python tools/stress.py --programs 30 --viewers 6 [--seed 1] [--deep clang|objects|both|off] [--out DIR]

Each program has random cores / ISRs / reference lines / HW blocks, classes with virtual stages, templates,
function-pointer tables, namespaces, access macros, shared globals and C files mixed in.  The pipeline output
is checked for structural invariants (every ISR has a tree, every function in the table resolves, HW events
reference known blocks, deep stats present); the browser run checks every window renders and reacts.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass
from isrprof import config, pipeline  # noqa: E402
from isrprof.render import write_outputs  # noqa: E402

HAL = """#pragma once
#include <stdint.h>
#define HW_REG(b, r) (*(volatile uint32_t *)(0x1000u))
#define HW_WR(b, r, v) (HW_REG(b, r) = (uint32_t)(v))
#define HW_RD(b, r) (HW_REG(b, r))
#define SHM_SET(f, v) (g_shm.f = (v))
#define SHM_GET(f) (g_shm.f)
#define IPC_SEND(ch, msg) ipc_send_raw((ch), (msg))
#define IPC_RECV(ch, buf) ipc_recv_raw((ch), (buf))
enum { CH_A = 0, CH_B = 1, CH_C = 2 };
#ifdef __cplusplus
extern "C" {
#endif
void ipc_send_raw(int ch, const void *msg);
int ipc_recv_raw(int ch, void *buf);
#ifdef __cplusplus
}
#endif
#ifdef __cplusplus
#define ISR_ENTRY(n) extern "C" void n(void)
#else
#define ISR_ENTRY(n) void n(void)
#endif
"""


class Program:
    def __init__(self, seed: int):
        self.r = random.Random(seed)
        self.seed = seed
        self.ncores = self.r.randint(1, 4)
        self.blocks = [f"B{i}" for i in range(self.r.randint(2, 6))]
        self.regs = ["CTRL", "START", "STATUS", "CFG"]
        self.nfiles = self.r.randint(2, 5)
        self.files: dict[str, str] = {}
        self.funcs: list[tuple[str, str, bool]] = []        # (name, file, is_cpp)
        self.isrs: list[dict] = []

    def hw(self):
        return f"HW_WR({self.r.choice(self.blocks)}, {self.r.choice(self.regs)}, {self.r.randint(0, 99)});" if self.r.random() < 0.7 else f"(void)HW_RD({self.r.choice(self.blocks)}, STATUS);"

    def shm(self, cpp):
        f = self.r.choice(["a", "b", "c"])
        if self.r.random() < 0.5:
            return f"SHM_SET({f}, {self.r.randint(1, 9)});"
        return f"(void)SHM_GET({f});" if self.r.random() < 0.5 else f"g_shm.{f} += 1;"

    def gen_file(self, idx: int, cpp: bool) -> str:
        r = self.r
        tag = f"f{idx}"
        n = r.randint(3, 8)
        names = [f"{tag}_fn{k}" for k in range(n)]
        out = ['#include "hal.h"', '#include "shm.h"']
        body_of = {}
        for k, nm in enumerate(names):
            callees = r.sample(names[k + 1:], min(len(names[k + 1:]), r.randint(0, 2)))
            lines = []
            if r.random() < 0.8:
                lines.append(self.hw())
            if r.random() < 0.7:
                lines.append(self.shm(cpp))
            if r.random() < 0.3:
                lines.append(f"s_{tag}_cnt++;")
            if r.random() < 0.3:
                lines.append(f"IPC_SEND(CH_{r.choice('ABC')}, &s_{tag}_cnt);" if r.random() < 0.6 else f"(void)IPC_RECV(CH_{r.choice('ABC')}, &s_{tag}_cnt);")
            for c in callees:
                lines.append(f"{c}();")
            body_of[nm] = lines
        out.append(f"static uint32_t s_{tag}_cnt;")
        if cpp:
            out.append(f"namespace ns{idx} {{")
            out.append(f"struct Base{idx} {{ virtual void run() {{ {self.hw()} }} virtual ~Base{idx}() {{}} }};")
            out.append(f"struct D{idx}a : Base{idx} {{ void run() override {{ {self.hw()} {names[0]}(); }} }};")
            out.append(f"struct D{idx}b : Base{idx} {{ void run() override {{ {self.shm(True)} }} }};")
            out.append(f"template <typename T> void tmpl{idx}(T x) {{ (void)x; {self.hw()} }}")
            out.append(f"static Base{idx} *g_obj{idx};")
            out.append(f"class Drv{idx} {{ public: Drv{idx}() : m_n(0) {{ init(); }} void tick() {{ m_n++; {self.hw()} }} static Drv{idx} &inst() {{ static Drv{idx} d; return d; }} private: void init() {{ {self.hw()} }} int m_n; }};")
            out.append("}")
            for nm in names:
                out.insert(2, f"static void {nm}(void);")
            for nm in names:
                extra = []
                if r.random() < 0.4:
                    extra.append(f"ns{idx}::g_obj{idx}->run();")
                if r.random() < 0.4:
                    extra.append(f"ns{idx}::tmpl{idx}<int>({r.randint(0, 9)});")
                if r.random() < 0.4:
                    extra.append(f"ns{idx}::Drv{idx}::inst().tick();")
                if r.random() < 0.2:
                    extra.append(f"auto lam = [](){{ {self.hw()} }}; lam();")
                out.append(f"static void {nm}(void) {{\n    " + "\n    ".join(body_of[nm] + extra) + "\n}")
            out.append(f"typedef void (*step{idx}_t)(void); static const step{idx}_t k_steps{idx}[] = {{ {names[0]}, {names[-1]} }};")
        else:
            for nm in names:
                out.insert(2, f"static void {nm}(void);")
            for nm in names:
                extra = []
                if r.random() < 0.3:
                    extra.append(f"k_steps{idx}[{r.randint(0, 1)}]();")
                out.append(f"static void {nm}(void) {{\n    " + "\n    ".join(body_of[nm] + extra) + "\n}")
            out.insert(3, f"typedef void (*step{idx}_t)(void); static void {names[0]}(void); static void {names[-1]}(void); static const step{idx}_t k_steps{idx}[] = {{ {names[0]}, {names[-1]} }};")
        # ISRs for this file
        nisr = r.randint(1, 2)
        for j in range(nisr):
            isr = f"isr_{tag}_{j}"
            core = r.randrange(self.ncores)
            entry_calls = r.sample(names, min(len(names), r.randint(1, 3)))
            ex = f"ns{idx}::g_obj{idx} = ns{idx}::g_obj{idx} ? ns{idx}::g_obj{idx} : nullptr; " if cpp and j == 0 else ""
            tbl = f"k_steps{idx}[{r.randint(0, 1)}]();" if r.random() < 0.5 else ""
            out.append(f"ISR_ENTRY({isr}) {{ {ex}{tbl} " + " ".join(f"{c}();" for c in entry_calls) + " }")
            self.isrs.append({"name": isr.upper(), "core": core, "timing": r.choice(["nw", "dl", "ul"]), "entry": isr,
                              "start": f"{r.uniform(0, 12):.1f} symbol", "length": f"{r.uniform(0.3, 2.5):.1f} symbol",
                              "period": r.choice(["1 slot", "1 symbol", "2 slot", "5 slot"]), "priority": r.randint(1, 5)})
        return "\n".join(out)

    def build(self, out: str):
        src = os.path.join(out, "src")
        os.makedirs(src, exist_ok=True)
        open(os.path.join(src, "hal.h"), "w", encoding="utf-8").write(HAL)
        open(os.path.join(src, "shm.h"), "w", encoding="utf-8").write("#pragma once\n#include <stdint.h>\ntypedef struct { uint32_t a, b, c; } shm_t;\n#ifdef __cplusplus\nextern \"C\" {\n#endif\nextern volatile shm_t g_shm;\n#ifdef __cplusplus\n}\n#endif\n")
        open(os.path.join(src, "shm.c"), "w", encoding="utf-8").write('#include "shm.h"\n#include "hal.h"\nvolatile shm_t g_shm;\nstatic int s_ipc_seq;\n'
                                                                        'void ipc_send_raw(int ch, const void *msg) { (void)ch; (void)msg; s_ipc_seq++; }\n'
                                                                        'int ipc_recv_raw(int ch, void *buf) { (void)ch; (void)buf; return s_ipc_seq; }\n')
        mods = []
        for i in range(self.nfiles):
            cpp = self.r.random() < 0.65
            name = f"mod{i}/m{i}.{'cpp' if cpp else 'c'}"
            os.makedirs(os.path.join(src, f"mod{i}"), exist_ok=True)
            open(os.path.join(src, name), "w", encoding="utf-8").write(self.gen_file(i, cpp))
            mods.append((i, name))
        prof = os.path.join(out, "profile")
        os.makedirs(prof, exist_ok=True)
        import yaml
        yaml.safe_dump({"name": f"stress{self.seed}", "inputs": {}, "output": {"dir": "../out"}, "viewer": {"expand_depth": 2}}, open(os.path.join(prof, "profile.yaml"), "w"))
        yaml.safe_dump({"root": "../src", "sources": ["**/*.c", "**/*.cpp", "**/*.h"], "parser": {"ignore_calls": ["HW_REG"]},
                        "deep": {"enabled": False, "backend": "clang", "target": "arm-none-eabi", "cache": False, "jobs": 1, "build": {"compile": "zig"}}}, open(os.path.join(prof, "build.yaml"), "w"))
        yaml.safe_dump({"numerology": {"mu": 1}, "cores": [{"id": c, "name": f"core{c}", "clock_mhz": 1000} for c in range(self.ncores)],
                        "references": [{"id": "nw", "name": "NW", "offset": 0, "kind": "ref"}, {"id": "dl", "name": "DL RTG", "offset": "-0.3 symbol"}, {"id": "ul", "name": "UL RTG", "offset": "2 symbol"}],
                        "channels": {"tdd_pattern": "DDDSU", "items": [{"id": "PDSCH", "dir": "dl", "symbols": [2, 12], "slots": "dl"}, {"id": "PUSCH", "dir": "ul", "symbols": [0, 12], "slots": "ul"}]},
                        "isrs": self.isrs, "window": {"start": "-1 symbol", "end": "6 slot"}}, open(os.path.join(prof, "timing.yaml"), "w"))
        yaml.safe_dump({"depth": 3, "nodes": [{"id": f"sub{i}", "name": f"Module {i}", "kind": "subsystem", "core": self.r.randrange(self.ncores),
                                               "children": [{"id": f"m{i}", "kind": "module", "files": [f"mod{i}/*"]}]} for i, _ in mods] +
                                             [{"id": "shm", "name": "Shared", "kind": "shared_memory", "children": [{"id": "g_shm", "kind": "struct", "variables": ["g_shm"]}]}],
                        "touch": {"globals": [], "access_macros": [{"name": "SHM_SET", "rw": "w", "var": "g_shm", "field_arg": 0}, {"name": "SHM_GET", "rw": "r", "var": "g_shm", "field_arg": 0}],
                                  "heap_functions": ["malloc", "free", "new", "delete"],
                                  "ipc": {"macros": ["IPC_SEND", "IPC_RECV"], "channel_arg": 0, "channels": [{"id": f"CH_{c}", "from": self.r.randrange(self.ncores), "to": self.r.randrange(self.ncores)} for c in "ABC"]}},
                        "architecture": {"layers": [{"name": "ISR", "functions": ["isr_*"]}, {"name": "Module", "functions": ["f*"]}]}}, open(os.path.join(prof, "sw_structure.yaml"), "w"))
        yaml.safe_dump({"depth": 2, "macros": {"read": ["HW_RD"], "write": ["HW_WR"], "rmw": [], "block_arg": 0, "reg_arg": 1},
                        "nodes": [{"id": "chain", "name": "Chain", "kind": "chain", "children": [{"id": b, "regs": self.regs, "deadline": {"at": f"{self.r.uniform(0.3, 13):.1f} symbol", "period": "1 slot"}} for b in self.blocks]}],
                        "links": [{"from": self.blocks[i], "to": self.blocks[i + 1]} for i in range(len(self.blocks) - 1)]}, open(os.path.join(prof, "hw_structure.yaml"), "w"))
        return prof


def invariants(p: dict) -> list[str]:
    bad = []
    F = p["functions"]
    if not p["isrs"]:
        bad.append("no ISRs")
    for isr in p["isrs"]:
        if not isr["tree"] or not isr["functions"]:
            bad.append(f"{isr['name']}: empty tree")
        for e in isr["hw_events"]:
            if e["block"] not in {b["id"] for b in p["hw"]["blocks"]} and e["block"] not in p["hw"]["unknown_blocks"]:
                bad.append(f"{isr['name']}: event on unknown block {e['block']}")
    for fid, f in F.items():
        for c in f["calls"]:
            if c["callee_id"] and c["callee_id"] not in F:
                bad.append(f"{fid}: callee_id {c['callee_id']} not in table")
            for cid in c["callee_ids"]:
                if cid not in F:
                    bad.append(f"{fid}: candidate {cid} not in table")
    for n in p["sw_structure"]["nodes"]:
        for fid in n["functions"]:
            if fid not in F:
                bad.append(f"sw node {n['id']}: function {fid} not in table")
    if p["structure"]["metrics"]["functions"] == 0:
        bad.append("structure analysis empty")
    return bad


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--programs", type=int, default=20)
    ap.add_argument("--viewers", type=int, default=4, help="how many generated viewers to drive through the browser self-test")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--deep", default="clang", choices=["off", "clang", "objects", "both"])
    ap.add_argument("--out", help="keep the generated trees here (default: temp dir, removed)")
    a = ap.parse_args(argv)
    base = a.out or tempfile.mkdtemp(prefix="isrprof-stress-")
    results = []
    t_all = time.perf_counter()
    for k in range(a.programs):
        seed = a.seed * 1000 + k
        d = os.path.join(base, f"p{seed}")
        if os.path.isdir(d):
            shutil.rmtree(d)
        prog = Program(seed)
        prof = prog.build(d)
        row = {"seed": seed, "files": prog.nfiles, "cores": prog.ncores, "isrs": len(prog.isrs)}
        for mode in (["token"] + ([a.deep] if a.deep != "off" else [])):
            t0 = time.perf_counter()
            try:
                cfg = config.load(prof)
                if mode != "token":
                    cfg.build["deep"]["enabled"] = True
                    cfg.build["deep"]["backend"] = mode
                p = pipeline.run(cfg)
                html = os.path.join(d, "out", f"profile_{mode}.html")
                write_outputs(p, html, html[:-5] + ".json")
                bad = invariants(p)
                if mode != "token" and not p.get("deep"):
                    bad.append("deep stats missing")
                row[mode] = {"ok": not bad, "bad": bad[:3], "functions": len(p["functions"]), "edges": sum(len(f["calls"]) for f in p["functions"].values()),
                             "ms": round((time.perf_counter() - t0) * 1000), "html": html,
                             "deep": {kk: vv for kk, vv in (p.get("deep") or {}).items() if kk in ("files", "functions", "replaced", "added", "errors", "objects", "compiled")}}
            except Exception as e:  # noqa: BLE001
                row[mode] = {"ok": False, "bad": [f"exception: {e!r}"], "ms": round((time.perf_counter() - t0) * 1000)}
        results.append(row)
        flag = "ok" if all(v.get("ok") for kk, v in row.items() if isinstance(v, dict)) else "FAIL"
        print(f"  {flag:4} seed {seed}: files {row['files']} cores {row['cores']} isrs {row['isrs']} · " + " · ".join(f"{m}: {v.get('functions', '?')} fn / {v.get('edges', '?')} calls / {v.get('ms')} ms" + ("" if v.get("ok") else f" {v.get('bad')}") for m, v in row.items() if isinstance(v, dict)))
    # browser runs on a sample
    verify = os.path.join(ROOT, "tools", "verify_viewer.py")
    sample = [r for r in results if all(v.get("ok") for kk, v in r.items() if isinstance(v, dict))][: a.viewers]
    vres = []
    for r in sample:
        mode = a.deep if a.deep != "off" else "token"
        html = r.get(mode, r["token"])["html"]
        t0 = time.perf_counter()
        pr = subprocess.run([sys.executable, verify, html, "--budget", "60000"], capture_output=True, text=True, encoding="utf-8", errors="replace")
        ok = pr.returncode == 0
        tail = (pr.stdout.strip().splitlines() or [""])[-1]
        vres.append((r["seed"], ok, round(time.perf_counter() - t0, 1), tail))
        print(f"  viewer seed {r['seed']}: {'ok' if ok else 'FAIL'} ({vres[-1][2]} s) {tail}")
        if not ok:
            print(pr.stdout[-1500:])
    nfail = sum(1 for r in results if not all(v.get("ok") for kk, v in r.items() if isinstance(v, dict))) + sum(1 for v in vres if not v[1])
    print(f"\n{len(results)} programs, {len(vres)} viewers, {nfail} failures, {round(time.perf_counter() - t_all)} s total; trees in {base}")
    with open(os.path.join(base, "stress_report.json"), "w", encoding="utf-8") as fh:
        json.dump({"results": results, "viewers": vres}, fh, indent=1, default=str)
    if not a.out:
        shutil.rmtree(base, ignore_errors=True)
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
