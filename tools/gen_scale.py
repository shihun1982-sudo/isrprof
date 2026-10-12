"""Generate a large synthetic firmware tree + profile from the NR modem sample, to benchmark the pipeline
and the viewer at scale.

    python tools/gen_scale.py 40 --out /tmp/scale40      # 40 copies -> ~1200 files, ~4400 functions, 520 ISRs

Every copy gets its own suffix (functions, statics, ISR names) so the call graph grows linearly; the HW
blocks and the shared-memory structures are shared by all copies (like variants of one chip's drivers).
The generated profile is written to <out>/profiles/scale and can be run with
    python -m isrprof --profiles-dir <out>/profiles run scale
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import yaml  # noqa: E402

SRC = os.path.join(ROOT, "examples", "nr_modem")
PROF = os.path.join(ROOT, "profiles", "nr_modem")
IDENT = re.compile(r"\b([A-Za-z_]\w*)\b")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("copies", type=int)
    ap.add_argument("--out", required=True)
    ap.add_argument("--window-slots", type=int, default=4)
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)
    src_out = os.path.join(out, "src")
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(src_out)
    # function / ISR names defined in the sample (renamed per copy); headers are shared
    names = set()
    for dp, _, fs in os.walk(SRC):
        for f in fs:
            if f.endswith(".c"):
                txt = open(os.path.join(dp, f), encoding="utf-8").read()
                names |= set(re.findall(r"^(?:static\s+)?(?:inline\s+)?[A-Za-z_][\w\s\*]*?\b([a-z_]\w*)\s*\([^;]*\)\s*\{", txt, re.M))
                names |= set(re.findall(r"ISR_ENTRY\((\w+)\)", txt))
    names -= {"main"}
    shutil.copytree(os.path.join(SRC, "hal"), os.path.join(src_out, "hal"))
    shutil.copytree(os.path.join(SRC, "common"), os.path.join(src_out, "common"))
    tim = yaml.safe_load(open(os.path.join(PROF, "timing.yaml"), encoding="utf-8"))
    sw = yaml.safe_load(open(os.path.join(PROF, "sw_structure.yaml"), encoding="utf-8"))
    base_isrs = tim["isrs"]
    isrs, nodes = [], []
    core_nodes = {n["id"]: n for n in sw["nodes"] if n.get("core") is not None and n["id"] != "platform"}
    for i in range(a.copies):
        sfx = f"_v{i}"
        for sub in ("dl", "ul", "l1c", "meas"):
            d_in, d_out = os.path.join(SRC, sub), os.path.join(src_out, f"{sub}{sfx}")
            os.makedirs(d_out)
            for f in os.listdir(d_in):
                txt = open(os.path.join(d_in, f), encoding="utf-8").read()
                txt = IDENT.sub(lambda m: m.group(1) + sfx if m.group(1) in names else m.group(1), txt)
                txt = txt.replace('#include "../', '#include "../')
                open(os.path.join(d_out, f), "w", encoding="utf-8").write(txt)
        for isr in base_isrs:
            s = dict(isr); s["name"] = isr["name"] + sfx.upper(); s["entry"] = isr["entry"] + sfx
            isrs.append(s)
        for nid, n in core_nodes.items():
            cn = {"id": f"{nid}{sfx}", "name": f"{n['name']} v{i}", "kind": "subsystem", "core": n["core"], "children": []}
            for ch in n.get("children", []):
                c2 = {"id": f"{ch['id']}{sfx}", "name": ch.get("name", ch["id"]), "kind": "module",
                      "files": [f.replace(f"{f.split('/')[0]}/", f"{f.split('/')[0]}{sfx}/") for f in ch.get("files", [])]}
                cn["children"].append(c2)
            nodes.append(cn)
    nodes += [n for n in sw["nodes"] if n["id"] in ("platform", "shm")]
    sw_out = dict(sw, nodes=nodes, relations=[], depth=2)
    sw_out["architecture"]["layers"] = [{"name": "ISR", "functions": ["*_isr*"]}, {"name": "Control", "functions": ["l1c_*", "sched_*", "timer_*", "mac_if_*"]},
                                         {"name": "Pipeline", "functions": ["dl_*", "pdcch_*", "stage_*", "ul_*", "sync_*", "csi_*", "ipc_*", "pool_*"]},
                                         {"name": "Driver", "functions": ["drv_*"]}, {"name": "HAL", "functions": ["hal_*"]}]
    tim_out = dict(tim, isrs=isrs, window={"start": "-1 symbol", "end": f"{a.window_slots} slot"})
    tim_out["cost_model"]["function_costs"] = {k + ("*" if not k.endswith("*") and "*" not in k else ""): v for k, v in tim["cost_model"]["function_costs"].items()}
    pdir = os.path.join(out, "profiles", "scale")
    os.makedirs(pdir)
    yaml.safe_dump(tim_out, open(os.path.join(pdir, "timing.yaml"), "w", encoding="utf-8"), sort_keys=False)
    yaml.safe_dump(sw_out, open(os.path.join(pdir, "sw_structure.yaml"), "w", encoding="utf-8"), sort_keys=False)
    shutil.copy(os.path.join(PROF, "hw_structure.yaml"), pdir)
    yaml.safe_dump({"root": "../../src", "sources": ["**/*.c", "**/*.h"], "parser": {"ignore_calls": ["sizeof", "memcpy", "memset", "ASSERT", "irq_lock", "irq_unlock", "HW_REG"]}},
                   open(os.path.join(pdir, "build.yaml"), "w", encoding="utf-8"))
    yaml.safe_dump({"name": "scale", "description": f"{a.copies} copies of the NR sample", "inputs": {"build": "build.yaml", "sw_structure": "sw_structure.yaml", "timing": "timing.yaml", "hw_structure": "hw_structure.yaml"},
                    "output": {"dir": "../../output/scale"}, "viewer": {"default_view": "tilt", "expand_depth": 1, "sw_structure": {"depth": 2, "columns": 6}}},
                   open(os.path.join(pdir, "profile.yaml"), "w", encoding="utf-8"), sort_keys=False)
    nfiles = sum(len(fs) for _, _, fs in os.walk(src_out))
    print(f"{a.copies} copies -> {nfiles} files, {len(isrs)} ISRs, {len(nodes)} top-level SW nodes at {out}")
    print(f"run: python -m isrprof --profiles-dir {os.path.join(out, 'profiles')} run scale")
    return 0


if __name__ == "__main__":
    sys.exit(main())
