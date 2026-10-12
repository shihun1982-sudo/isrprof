"""Syntax-check the viewer's JavaScript parts (templates/parts/*.js) without a browser.

    python tools/check_js.py            # every part, as assembled by render.py (one IIFE)

Uses the `esprima` package when installed (pip install esprima); reports file + line of the first error.
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from isrprof import render  # noqa: E402


def main() -> int:
    try:
        import esprima  # type: ignore
    except ImportError:
        print("esprima not installed (pip install esprima); skipping JS syntax check")
        return 0
    parts = []
    for name in sorted(os.listdir(render.PARTS_DIR)):
        if name.endswith(".js"):
            with open(os.path.join(render.PARTS_DIR, name), "r", encoding="utf-8") as fh:
                parts.append((name, fh.read()))
    src = "(function () {\n'use strict';\n" + "\n".join(t for _, t in parts) + "\n})();\n"
    try:
        esprima.parseScript(src, {"tolerant": False})
    except esprima.Error as e:  # type: ignore[attr-defined]
        line = getattr(e, "lineNumber", None) or 0
        off = 2
        for name, txt in parts:
            n = txt.count("\n") + 1
            if off + 1 <= line <= off + n:
                print(f"SYNTAX ERROR {name}:{line - off}: {e}")
                lines = txt.split("\n")
                print("   " + lines[line - off - 1][:240])
                return 1
            off += n
        print(f"SYNTAX ERROR line {line}: {e}")
        return 1
    print(f"ok: {len(parts)} parts, {src.count(chr(10))} lines parse")
    return 0


if __name__ == "__main__":
    sys.exit(main())
