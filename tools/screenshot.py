"""Full-page screenshot of a generated viewer with a headless Chromium / Edge.

    python tools/screenshot.py output/nr_modem/profile.html out.png [--hash sel-DL_PDSCH_ISR--view-3d] [--size 1600x3000]

Works from any shell.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify_viewer import browser_env, find_browser  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("png")
    ap.add_argument("--hash", default="")
    ap.add_argument("--size", default="1600x3000")
    ap.add_argument("--browser")
    ap.add_argument("--budget", type=int, default=10000)
    a = ap.parse_args(argv)
    browser = find_browser(a.browser)
    if not browser:
        print("no browser found")
        return 2
    w, h = a.size.lower().split("x")
    url = "file:///" + os.path.abspath(a.html).replace("\\", "/") + ("#" + a.hash if a.hash else "")
    prof = tempfile.mkdtemp(prefix="isrprof-shot-")
    args = [browser, "--headless=new", "--no-first-run", f"--user-data-dir={prof}", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist", "--hide-scrollbars", f"--window-size={w},{h}", f"--virtual-time-budget={a.budget}",
            f"--screenshot={os.path.abspath(a.png)}", url]
    subprocess.run(args, capture_output=True, timeout=240, env=browser_env())
    shutil.rmtree(prof, ignore_errors=True)
    ok = os.path.isfile(a.png)
    print(("wrote " if ok else "FAILED ") + a.png)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
