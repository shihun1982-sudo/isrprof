import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from isrprof import config, pipeline, profile  # noqa: E402
from isrprof.render import render_html  # noqa: E402


class ManyCoresTests(unittest.TestCase):
    """The core count is data: an 8-core variant of the NR sample must build and render."""

    def test_eight_cores(self):
        raw, meta = profile.load_raw("nr_modem", os.path.join(ROOT, "profiles"))
        tim = raw["timing"]
        base = tim["cores"]
        # four extra cores that re-use the UL / MEAS code paths with their own ISRs
        for i in range(4, 8):
            tim["cores"].append({"id": i, "name": f"Core{i} AUX{i}", "clock_mhz": 500})
            tim["isrs"].append({"name": f"AUX{i}_ISR", "core": i, "timing": "meas", "entry": "track_isr",
                                "start": f"{i} symbol", "length": "0.5 symbol", "period": "2 slot"})
        raw["viewer"]["sw_structure"]["columns"] = 3
        cfg = config.build_config(raw, meta)
        self.assertEqual(len(cfg.cores), 8)
        p = pipeline.run(cfg)
        self.assertEqual(len(p["cores"]), 8)
        self.assertEqual(sum(1 for i in p["isrs"] if i["name"].startswith("AUX")), 4)
        # track_isr now executes on cores 3..7 -> its variables are cross-core
        tr = next(v for v in p["memory"]["variables"] if v["name"] == "g_track_state")
        self.assertTrue({3, 4, 5, 6, 7} <= set(tr["cores"]))
        html = render_html(p)
        self.assertIn('"columns": 3'.replace(" ", ""), html.replace(" ", ""))
        self.assertGreater(len(base), 0)


if __name__ == "__main__":
    unittest.main()
