import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from isrprof import config, pipeline  # noqa: E402
from isrprof.render import render_html  # noqa: E402


class ScaleTests(unittest.TestCase):
    """A synthetic tree (tools/gen_scale.py) keeps the pipeline linear: 6 copies of the NR sample must
    analyse in well under a few seconds and must not explode the derived relations."""

    def test_six_copies(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "scale6")
            r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "gen_scale.py"), "6", "--out", out], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            t0 = time.perf_counter()
            cfg = config.load("scale", os.path.join(out, "profiles"))
            p = pipeline.run(cfg)
            dt = time.perf_counter() - t0
            self.assertEqual(p["parse_stats"]["functions"], 6 * 105 + 6)        # 105 renamed functions per copy + 6 common (ipc, pool, irq)
            self.assertEqual(len(p["isrs"]), 6 * 13)
            self.assertLess(dt, 8.0, f"pipeline took {dt:.1f}s for {p['parse_stats']['functions']} functions")
            # every copy's modules map to their own SW nodes, nothing is left unassigned
            self.assertFalse([n for n in p["sw_structure"]["nodes"] if n["id"].startswith("_auto_core")])
            # derived IPC relations stay bounded (module level for small trees)
            self.assertLess(len([x for x in p["sw_structure"]["relations"] if x["derived"]]), 400)
            st = p["structure"]["metrics"]
            self.assertEqual(st["tangles"], 6)
            html = render_html(p)
            self.assertLess(len(html), 6_000_000)


if __name__ == "__main__":
    unittest.main()
