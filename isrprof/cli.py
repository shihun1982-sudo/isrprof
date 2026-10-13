"""Command line entry point.

    python -m isrprof run <profile>            # profile name (profiles/<name>), directory or config file
    python -m isrprof list                     # stored profiles
    python -m isrprof new <name> [--from <profile>]
    python -m isrprof --config <file.yaml>     # legacy single-file config (same as `run <file>`)
"""
from __future__ import annotations

import argparse
import os
import sys
import time

from . import config as cfgmod
from . import profile as profmod
from .pipeline import run
from .render import write_outputs


def _summary(p: dict) -> str:
    num = p["numerology"]
    sym = num["symbol_us"]
    lines = [f"isrprof {p['tool']['version']} - {p['project']['name']}",
             f"  parsed {p['parse_stats']['files']} files, {p['parse_stats']['functions']} functions, "
             f"{p['parse_stats']['variables']} globals/statics, {p['parse_stats']['macros']} macros"
             f"  ({p['parse_stats'].get('parse_ms', 0)} ms parse, {p['parse_stats'].get('total_ms', 0)} ms total)",
             f"  numerology: mu={num['mu']} slot={num['slot_us']:.1f}us symbol={sym:.2f}us",
             f"  SW structure: {len(p['sw_structure']['nodes'])} nodes (depth {p['sw_structure']['depth']}), "
             f"{len(p['sw_structure']['relations'])} relations | HW structure: {len(p['hw_structure']['nodes'])} nodes, "
             f"{len(p['hw']['blocks'])} blocks, {len(p['hw_structure']['links'])} links | channels: "
             f"{', '.join(c['id'] for c in p['channels']['items']) or '-'}", "", "  ISRs:"]
    for isr in p["isrs"]:
        budget = "-" if isr["length_us"] is None else f"{isr['length_us'] / sym:.2f}"
        flag = "  OVER BUDGET" if isr["over_budget"] else ""
        viol = sum(1 for e in isr["hw_events"] if e["violation"])
        lines.append(f"    core{isr['core']} {isr['name']:<16} ref={isr['timing']:<9} start={isr['start_us'] / sym:5.2f} sym "
                     f"computed={isr['computed_us'] / sym:5.2f} sym budget={budget:>5} sym  "
                     f"hw={len(isr['hw_events'])} deadline-miss={viol}{flag}")
    if p.get("deep"):
        d = p["deep"]
        lines += ["", f"  Deep analysis ({d['backend']}): {d['files']} translation units, {d['functions']} functions ({d['replaced']} refined, {d['added']} new, {d['virtual_methods']} virtual) in {d.get('ms', d.get('total_ms', 0))} ms, cache hits {d.get('cache_hits', 0)}"]
        lines += [f"    note: {l}" for l in d.get("log", [])[:5]]
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


def cmd_run(args) -> int:
    t0 = time.perf_counter()
    cfg = cfgmod.load(args.target, args.profiles_dir)
    d = cfg.build.setdefault("deep", {})
    if args.deep:
        d["enabled"] = True
    if args.no_deep:
        d["enabled"] = False
    if args.deep_backend:
        d["backend"] = args.deep_backend
    if args.deep_scope:
        d["scope"] = [s.strip() for s in args.deep_scope.split(",") if s.strip()]
    profile = run(cfg)
    out_dir = args.out_dir or cfg.output["dir"]
    html = args.out or (os.path.join(out_dir, os.path.basename(cfg.output["html"])) if args.out_dir else cfg.output["html"])
    js = args.json or (os.path.join(out_dir, os.path.basename(cfg.output["json"])) if (args.out_dir and cfg.output["json"]) else cfg.output["json"])
    if args.no_json:
        js = None
    write_outputs(profile, html, js, args.fragment)
    resolved = None
    if cfg.meta and not cfg.meta.legacy:
        resolved = profmod.write_resolved(cfg, cfg.meta, os.path.dirname(os.path.abspath(html)))
    profile["parse_stats"]["total_ms"] = round((time.perf_counter() - t0) * 1000)
    if not args.quiet:
        print(_summary(profile))
        print(f"\n  wrote {html}" + (f"\n  wrote {js}" if js else "") + (f"\n  wrote {resolved}" if resolved else ""))
    return 0


def cmd_list(args) -> int:
    rows = profmod.list_profiles(args.profiles_dir)
    if not rows:
        print(f"no profiles in {args.profiles_dir or profmod.default_profiles_dir()}")
        return 0
    for r in rows:
        parts = ", ".join(f"{k}={v}" for k, v in r["inputs"].items()) or "(defaults)"
        print(f"  {r['name']:<20} {r['dir']}\n      {r['description'] or ''}\n      inputs: {parts}")
    return 0


def cmd_new(args) -> int:
    dest = profmod.new_profile(args.name, args.from_profile, args.profiles_dir)
    print(f"created profile {args.name} at {dest}")
    return 0


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    ap = argparse.ArgumentParser(prog="isrprof", description="ISR / timing / HW-access profiler for modem firmware")
    ap.add_argument("--profiles-dir", help="directory holding the profiles (default: <package>/profiles or $ISRPROF_PROFILES)")
    sub = ap.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="analyse a profile (name, directory or config file) and write the viewer")
    r.add_argument("target")
    r.add_argument("--out-dir", help="output directory (overrides the profile's output.dir)")
    r.add_argument("--out", "-o", help="HTML output path")
    r.add_argument("--json", help="JSON output path")
    r.add_argument("--no-json", action="store_true")
    r.add_argument("--fragment", help="also write a body-only HTML fragment (for embedding)")
    r.add_argument("--quiet", "-q", action="store_true")
    r.add_argument("--deep", action="store_true", help="enable the build-based deep analysis (build.deep.enabled: true)")
    r.add_argument("--no-deep", action="store_true", help="disable it even if the profile enables it")
    r.add_argument("--deep-backend", choices=["clang", "objects", "both"], help="override build.deep.backend")
    r.add_argument("--deep-scope", help="comma-separated globs / SW node ids analysed deeply (override build.deep.scope)")
    r.set_defaults(func=cmd_run)
    l = sub.add_parser("list", help="list stored profiles")
    l.set_defaults(func=cmd_list)
    n = sub.add_parser("new", help="store a new profile directory")
    n.add_argument("name")
    n.add_argument("--from", dest="from_profile", help="clone an existing profile")
    n.set_defaults(func=cmd_new)
    # legacy form: isrprof --config file.yaml [--out ...]
    if argv and argv[0] in ("--config", "-c"):
        argv = ["run"] + argv[1:2] + argv[2:]
    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
