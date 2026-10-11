"""Command line entry point:  python -m isrprof --config examples/sample_config.yaml"""
from __future__ import annotations

import argparse
import sys

from . import config as cfgmod
from .pipeline import run
from .render import write_outputs


def _summary(p: dict) -> str:
    num = p["numerology"]
    sym = num["symbol_us"]
    lines = [f"isrprof {p['tool']['version']} - {p['project']['name']}",
             f"  parsed {p['parse_stats']['files']} files, {p['parse_stats']['functions']} functions, "
             f"{p['parse_stats']['variables']} globals/statics, {p['parse_stats']['macros']} macros",
             f"  numerology: mu={num['mu']} slot={num['slot_us']:.1f}us symbol={sym:.2f}us", "", "  ISRs:"]
    for isr in p["isrs"]:
        budget = "-" if isr["length_us"] is None else f"{isr['length_us'] / sym:.2f}"
        flag = "  OVER BUDGET" if isr["over_budget"] else ""
        viol = sum(1 for e in isr["hw_events"] if e["violation"])
        lines.append(f"    core{isr['core']} {isr['name']:<16} lane={isr['timing']:<9} start={isr['start_us'] / sym:5.2f} sym "
                     f"computed={isr['computed_us'] / sym:5.2f} sym budget={budget:>5} sym  "
                     f"hw={len(isr['hw_events'])} deadline-miss={viol}{flag}")
    m = p["structure"]["metrics"]
    lines += ["", "  Structure (Structure101-style):",
              f"    functions={m['functions']} deps={m['dependencies']} feedback={m['feedback_dependencies']} "
              f"tangled={m['tangled_pct']}% tangles={m['tangles']} max-level={m['max_level']}",
              f"    layer/rule violations={m['layer_violations']} overweight modules={m['overweight_modules']}"]
    for t in p["structure"]["tangles"]:
        lines.append(f"    tangle: {' <-> '.join(t)}")
    for v in p["structure"]["violations"]:
        lines.append(f"    violation[{v['kind']}]: {v['from']} -> {v['to']} ({v.get('from_layer') or v.get('rule', '')}"
                     f"{' -> ' + v['to_layer'] if v.get('to_layer') else ''})")
    if p["llm"]["log"]:
        lines += ["", "  LLM log:"] + [f"    {l}" for l in p["llm"]["log"]]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="isrprof", description="ISR / timing / HW-access profiler for modem firmware")
    ap.add_argument("--config", "-c", required=True, help="YAML or JSON config")
    ap.add_argument("--out", "-o", help="HTML output (overrides output.html)")
    ap.add_argument("--json", help="JSON output (overrides output.json)")
    ap.add_argument("--fragment", help="also write a body-only HTML fragment (for embedding / artifacts)")
    ap.add_argument("--quiet", "-q", action="store_true")
    args = ap.parse_args(argv)

    cfg = cfgmod.load(args.config)
    profile = run(cfg)
    html = args.out or cfg.output["html"]
    js = args.json or cfg.output["json"]
    write_outputs(profile, html, js, args.fragment)
    if not args.quiet:
        print(_summary(profile))
        print(f"\n  wrote {html}" + (f"\n  wrote {js}" if js else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
