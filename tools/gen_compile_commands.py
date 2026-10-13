"""Write a compile_commands.json for a source tree without running a build system.

    python tools/gen_compile_commands.py examples/nr_modem examples/nr_modem/build/compile_commands.json \
        -DCONFIG_NR_MU=1 -DCONFIG_NUM_CORES=4 -I. -Ihal -Icommon

Useful when the real build cannot be exported (CMake: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON; Make: bear).
"""
from __future__ import annotations

import glob
import json
import os
import sys


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    root, out = os.path.abspath(argv[0]), argv[1]
    flags = " ".join(argv[2:])
    entries = []
    files = []
    for ext in ("*.c", "*.cc", "*.cpp", "*.cxx"):
        files += glob.glob(os.path.join(root, "**", ext), recursive=True)
    for f in sorted(files):
        rel = os.path.relpath(f, root).replace("\\", "/")
        if rel.startswith("build/"):
            continue
        entries.append({"directory": ".", "file": rel,
                        "command": f"{'c++' if not rel.endswith('.c') else 'cc'} {flags} -O2 -c {rel} -o build/{os.path.basename(rel)}.o"})
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(entries, fh, indent=1)
    print(f"{len(entries)} translation units -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
