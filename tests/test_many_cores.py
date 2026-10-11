import os
import sys
import tempfile
import unittest

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from isrprof import config, pipeline  # noqa: E402
from isrprof.render import render_html  # noqa: E402


class ManyCoresTests(unittest.TestCase):
    """The core count is data: an 8-core variant of the NR sample must build and render."""

    def test_eight_cores(self):
        src = os.path.join(ROOT, "examples", "nr_modem_config.yaml")
        with open(src, encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
        base = raw["cores"]
        # four extra cores that re-use the UL / MEAS code paths with their own ISRs
        for i in range(4, 8):
            raw["cores"].append({"id": i, "name": f"Core{i} AUX{i}", "clock_mhz": 500, "modules": []})
            raw["isrs"].append({"name": f"AUX{i}_ISR", "core": i, "timing": "meas", "entry": "track_isr",
                                "start": f"{i} symbol", "length": "0.5 symbol", "period": "2 slot"})
        raw["viewer"]["sw_structure"]["columns"] = 3
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "cfg.yaml")
            raw["project"]["sources"] = [os.path.join(ROOT, "examples", "nr_modem", "**", "*.c"),
                                         os.path.join(ROOT, "examples", "nr_modem", "**", "*.h")]
            raw["annotations_file"] = os.path.join(ROOT, "examples", "nr_modem_annotations.yaml")
            with open(path, "w", encoding="utf-8") as fh:
                yaml.safe_dump(raw, fh)
            cfg = config.load(path)
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
