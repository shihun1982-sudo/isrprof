"""Build information: where the sources are and how they are built.

``build.yaml``::

    root: ../../examples/nr_modem          # source root; module / layer file globs are relative to it
    sources: ["**/*.c", "**/*.h"]          # globs relative to root (absolute paths also work)
    cmake:                                 # optional, recorded and used to locate compile_commands.json
      source_dir: .
      build_dir: build
      configure: "cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON"
    build_command: "cmake --build build"   # recorded only (never executed by the profiler)
    compile_commands: build/compile_commands.json   # if present: the translation units + -D / -I flags
    defines: { CONFIG_NR: 1 }              # extra defines (informational for the builtin parser)
    exclude: ["**/test/**"]                # globs removed from the file list
    parser: { backend: builtin, ignore_calls: [...] }
    cache: true                            # per-file parse cache under <output>/.cache

``compile_commands.json`` (CMake / Bear / Ninja) is the preferred source of truth for real trees:
every translation unit listed there is parsed (headers are added from ``sources`` globs), and the
``-D`` / ``-I`` flags are collected per file.  Nothing is executed.
"""
from __future__ import annotations

import fnmatch
import glob
import json
import os
import shlex


def _norm(p: str) -> str:
    return os.path.normpath(p)


def expand_globs(root: str, patterns: list[str]) -> list[str]:
    out: list[str] = []
    for p in patterns or []:
        full = p if os.path.isabs(p) else os.path.join(root, p)
        hits = sorted(glob.glob(full, recursive=True))
        if not hits and os.path.isfile(full):
            hits = [full]
        out.extend(h for h in hits if os.path.isfile(h))
    seen, res = set(), []
    for f in out:
        n = _norm(f)
        if n not in seen:
            seen.add(n)
            res.append(n)
    return res


def _flags(entry: dict) -> list[str]:
    if entry.get("arguments"):
        return list(entry["arguments"])
    if entry.get("command"):
        try:
            return shlex.split(entry["command"], posix=os.name != "nt")
        except ValueError:
            return entry["command"].split()
    return []


def read_compile_commands(path: str, root: str | None = None) -> list[dict]:
    """[{file, directory, defines{}, includes[]}] from a compile_commands.json.  A relative `directory`
    is resolved against the source root (then the file's own directory)."""
    base = root or os.path.dirname(os.path.abspath(path))
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    out = []
    for e in data:
        f = e.get("file")
        if not f:
            continue
        d = e.get("directory") or base
        d = d if os.path.isabs(d) else os.path.normpath(os.path.join(base, d))
        full = f if os.path.isabs(f) else os.path.join(d, f)
        defines, includes = {}, []
        args = _flags(e)
        i = 0
        while i < len(args):
            a = args[i]
            if a.startswith("-D"):
                kv = a[2:] if len(a) > 2 else (args[i + 1] if i + 1 < len(args) else "")
                if len(a) == 2:
                    i += 1
                k, _, v = kv.partition("=")
                defines[k] = v if v != "" else "1"
            elif a.startswith("-I"):
                inc = a[2:] if len(a) > 2 else (args[i + 1] if i + 1 < len(args) else "")
                if len(a) == 2:
                    i += 1
                includes.append(inc if os.path.isabs(inc) else os.path.join(d, inc))
            i += 1
        out.append({"file": _norm(full), "directory": d, "defines": defines, "includes": includes})
    return out


def resolve(base_dir: str, braw: dict | None, legacy_sources: list[str] | None = None) -> dict:
    """Normalize the build section: absolute source root, file list, flags, recorded commands."""
    braw = braw or {}
    root = braw.get("root")
    root = os.path.abspath(root if os.path.isabs(root) else os.path.join(base_dir, root)) if root else base_dir
    patterns = list(braw.get("sources") or legacy_sources or [])
    files = expand_globs(root, patterns)
    cc_path = braw.get("compile_commands")
    cmake = braw.get("cmake") or {}
    if not cc_path and cmake.get("build_dir"):
        cand = os.path.join(cmake["build_dir"], "compile_commands.json")
        cand = cand if os.path.isabs(cand) else os.path.join(root, cand)
        if os.path.isfile(cand):
            cc_path = cand
    units: list[dict] = []
    if cc_path:
        cc_full = cc_path if os.path.isabs(cc_path) else os.path.join(root, cc_path)
        if os.path.isfile(cc_full):
            units = read_compile_commands(cc_full, root)
            cc_path = cc_full
            tu = [u["file"] for u in units if os.path.isfile(u["file"])]
            headers = [f for f in files if f.lower().endswith((".h", ".hpp", ".hh"))]
            files = tu + [h for h in headers if h not in tu]
            if patterns and not braw.get("sources_from_globs_too", False):
                pass
        else:
            cc_path = None
    excl = list(braw.get("exclude") or [])
    if excl:
        def keep(f):
            rel = os.path.relpath(f, root).replace("\\", "/")
            return not any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(f.replace("\\", "/"), p) for p in excl)
        files = [f for f in files if keep(f)]
    defines = {str(k): str(v) for k, v in (braw.get("defines") or {}).items()}
    per_file_defines = {u["file"]: u["defines"] for u in units}
    includes = sorted({i for u in units for i in u["includes"]} | {str(i) for i in (braw.get("include_dirs") or [])})
    parser = dict(braw.get("parser") or {})
    parser.setdefault("backend", "builtin")
    parser.setdefault("ignore_calls", ["sizeof", "memcpy", "memset", "assert", "ASSERT", "likely", "unlikely"])
    parser.setdefault("defines", defines)
    return {
        "root": root, "patterns": patterns, "files": files,
        "cmake": {"source_dir": cmake.get("source_dir"), "build_dir": cmake.get("build_dir"),
                  "configure": cmake.get("configure")} if cmake else None,
        "build_command": braw.get("build_command"),
        "compile_commands": cc_path, "translation_units": len(units),
        "defines": defines, "file_defines": per_file_defines, "include_dirs": includes,
        "parser": parser, "cache": bool(braw.get("cache", True)),
    }


def summary(build: dict) -> dict:
    """What the viewer / JSON shows about the build."""
    return {
        "root": build["root"], "patterns": build["patterns"], "files": len(build["files"]),
        "cmake": build["cmake"], "build_command": build["build_command"],
        "compile_commands": build["compile_commands"], "translation_units": build["translation_units"],
        "defines": build["defines"], "include_dirs": build["include_dirs"],
    }
