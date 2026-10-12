"""Profiles: one directory per analysis target, holding the user inputs as separate files.

    profiles/<name>/
      profile.yaml        name, which input files to use, output location, viewer / llm options
      build.yaml          sources, source root, cmake / build command, compile_commands.json, parser options
      sw_structure.yaml   SW structure: hierarchy of subsystems / modules / classes / structures / shared
                          memory, relations, diagram depth, touch rules (tracked globals, accessor macros,
                          heap / IPC primitives), architecture layers and rules
      timing.yaml         3GPP numerology, cores, reference timing lines (NW, DL RTG, UL RTG, HW REF ...),
                          channel allocation (PDCCH / PDSCH / PUCCH / PUSCH ...), ISRs, window, cost model
      hw_structure.yaml   HW structure: chains / groups / blocks / registers, links, register-access
                          macros, deadlines
      annotations.yaml    optional free-text notes

The parts are merged into one raw dict (``build`` / ``sw_structure`` / ``timing`` / ``hw_structure``
sections) which :mod:`isrprof.config` normalizes.  A single-file legacy config (everything in one YAML,
see ``examples/sample_config.yaml``) is still accepted: :func:`load_raw` returns it unchanged.

Store / load: ``new_profile`` creates a profile directory (optionally cloned from another one),
``list_profiles`` enumerates them, ``find_profile`` resolves a name or path, and
``write_resolved`` stores the merged, normalized inputs next to the outputs so every result is
reproducible from a single file.
"""
from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass, field

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover
    yaml = None

PROFILE_FILE = "profile.yaml"
PART_KEYS = ("build", "sw_structure", "timing", "hw_structure")
DEFAULT_PARTS = {"build": "build.yaml", "sw_structure": "sw_structure.yaml", "timing": "timing.yaml",
                 "hw_structure": "hw_structure.yaml", "annotations": "annotations.yaml"}


class ProfileError(Exception):
    pass


def read_yaml(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    if path.lower().endswith(".json"):
        return json.loads(text) or {}
    if yaml is None:
        raise ProfileError("PyYAML not installed; use .json files or `pip install pyyaml`")
    return yaml.safe_load(text) or {}


@dataclass
class ProfileMeta:
    name: str
    dir: str                       # profile directory (base for relative paths in the part files)
    file: str                      # profile.yaml (or the legacy single config file)
    parts: dict = field(default_factory=dict)      # section -> absolute path of the part file
    output_dir: str = ""
    legacy: bool = False


def default_profiles_dir() -> str:
    """``$ISRPROF_PROFILES`` or ``<package root>/profiles``."""
    env = os.environ.get("ISRPROF_PROFILES")
    if env:
        return os.path.abspath(env)
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "profiles")


def list_profiles(profiles_dir: str | None = None) -> list[dict]:
    pdir = profiles_dir or default_profiles_dir()
    out = []
    if not os.path.isdir(pdir):
        return out
    for name in sorted(os.listdir(pdir)):
        d = os.path.join(pdir, name)
        pf = os.path.join(d, PROFILE_FILE)
        if os.path.isfile(pf):
            try:
                raw = read_yaml(pf)
            except Exception:
                raw = {}
            out.append({"name": raw.get("name", name), "dir": d, "file": pf,
                        "description": raw.get("description", ""),
                        "inputs": {k: v for k, v in (raw.get("inputs") or {}).items()}})
    return out


def find_profile(target: str, profiles_dir: str | None = None) -> str:
    """Resolve a profile name, a profile directory or a config file path to a file path."""
    if os.path.isdir(target):
        pf = os.path.join(target, PROFILE_FILE)
        if os.path.isfile(pf):
            return os.path.abspath(pf)
        raise ProfileError(f"{target} is a directory without {PROFILE_FILE}")
    if os.path.isfile(target):
        return os.path.abspath(target)
    pdir = profiles_dir or default_profiles_dir()
    pf = os.path.join(pdir, target, PROFILE_FILE)
    if os.path.isfile(pf):
        return os.path.abspath(pf)
    raise ProfileError(f"profile {target!r} not found (looked in {pdir})")


def load_raw(target: str, profiles_dir: str | None = None) -> tuple[dict, ProfileMeta]:
    """Merge a profile's part files into one raw dict (or return a legacy single-file config)."""
    path = find_profile(target, profiles_dir)
    base = os.path.dirname(path)
    raw = read_yaml(path)
    name = str(raw.get("name") or os.path.basename(base))
    inputs = raw.get("inputs")
    legacy = inputs is None and not any(k in raw for k in PART_KEYS) and (
        "project" in raw or "isrs" in raw or "timing_items" in raw)
    meta = ProfileMeta(name=name, dir=base, file=path, legacy=legacy)
    if legacy:
        meta.output_dir = base
        return raw, meta
    inputs = dict(inputs or {})
    merged = dict(raw)
    for key in PART_KEYS + ("annotations",):
        rel = inputs.get(key, DEFAULT_PARTS[key] if key in DEFAULT_PARTS else None)
        if rel is None:
            continue
        full = rel if os.path.isabs(rel) else os.path.join(base, rel)
        if os.path.isfile(full):
            part = read_yaml(full)
            meta.parts[key] = full
            if key == "annotations":
                merged.setdefault("annotations_file", full)
            elif isinstance(merged.get(key), dict) and isinstance(part, dict):
                merged[key] = _deep_merge(part, merged[key])     # inline section overrides the file
            else:
                merged[key] = part
        elif key in inputs:
            raise ProfileError(f"profile {name}: input file {rel!r} ({key}) not found")
    out = merged.get("output") or {}
    odir = out.get("dir")
    if odir:
        odir = odir if os.path.isabs(odir) else os.path.join(base, odir)
    else:
        odir = os.path.join(os.path.dirname(base), "..", "output", name)
    meta.output_dir = os.path.normpath(odir)
    merged["output"] = dict(out, dir=meta.output_dir,
                            html=out.get("html", "profile.html"), json=out.get("json", "profile.json"))
    merged["name"] = name
    return merged, meta


def _deep_merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


TEMPLATE_PROFILE = """# isrprof profile: {name}
name: {name}
description: ""
inputs:                       # input files, relative to this directory (each one is optional)
  build: build.yaml
  sw_structure: sw_structure.yaml
  timing: timing.yaml
  hw_structure: hw_structure.yaml
  annotations: annotations.yaml
output:
  dir: ../../output/{name}    # default: <profiles>/../output/<name>
  html: profile.html
  json: profile.json
viewer:
  default_view: tilt          # tilt (cores on the diagonal) | aligned | 3d
llm:
  enabled: false
"""

TEMPLATE_PARTS = {
    "build.yaml": "root: ../../src        # source root (module file globs are relative to it)\nsources:\n  - \"**/*.c\"\n  - \"**/*.h\"\n",
    "sw_structure.yaml": "depth: 3\nnodes: []\nrelations: []\ntouch:\n  globals: []\n  access_macros: []\n",
    "timing.yaml": "numerology: { mu: 1, symbols_per_slot: 14 }\ncores:\n  - { id: 0, name: core0, clock_mhz: 1000 }\nreferences:\n  - { id: nw, name: \"NW timing\", offset: \"0 symbol\", kind: ref }\nchannels: { tdd_pattern: \"DDDSU\", items: [] }\nisrs: []\nwindow: { start: \"-1 symbol\", end: \"2 slot\" }\n",
    "hw_structure.yaml": "depth: 2\nmacros: { read: [HW_RD], write: [HW_WR], rmw: [HW_RMW], block_arg: 0, reg_arg: 1 }\nnodes: []\nlinks: []\n",
    "annotations.yaml": "functions: {}\nblocks: {}\nvariables: {}\nisrs: {}\n",
}


def new_profile(name: str, from_profile: str | None = None, profiles_dir: str | None = None) -> str:
    """Store a new profile directory; clone an existing one or start from the template."""
    pdir = profiles_dir or default_profiles_dir()
    dest = os.path.join(pdir, name)
    if os.path.exists(dest):
        raise ProfileError(f"profile {name!r} already exists at {dest}")
    os.makedirs(pdir, exist_ok=True)
    if from_profile:
        src = os.path.dirname(find_profile(from_profile, profiles_dir))
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__", ".isrprof_llm_cache.json"))
        pf = os.path.join(dest, PROFILE_FILE)
        raw = read_yaml(pf)
        raw["name"] = name
        out = raw.get("output") or {}
        if not out.get("dir") or str(out.get("dir")).endswith(os.path.basename(src)):
            out["dir"] = f"../../output/{name}"
        raw["output"] = out
        with open(pf, "w", encoding="utf-8") as fh:
            yaml.safe_dump(raw, fh, sort_keys=False, allow_unicode=True)
    else:
        os.makedirs(dest)
        with open(os.path.join(dest, PROFILE_FILE), "w", encoding="utf-8") as fh:
            fh.write(TEMPLATE_PROFILE.format(name=name))
        for fn, txt in TEMPLATE_PARTS.items():
            with open(os.path.join(dest, fn), "w", encoding="utf-8") as fh:
                fh.write(txt)
    return dest


def write_resolved(cfg, meta: ProfileMeta, out_dir: str) -> str:
    """Store the merged raw inputs (one file) next to the outputs."""
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "profile.resolved.yaml" if yaml else "profile.resolved.json")
    data = {"name": meta.name, "profile_file": meta.file, "parts": meta.parts, "inputs": cfg.raw}
    with open(path, "w", encoding="utf-8") as fh:
        if yaml:
            yaml.safe_dump(data, fh, sort_keys=False, allow_unicode=True, default_flow_style=None)
        else:
            json.dump(data, fh, indent=1, ensure_ascii=False)
    return path
