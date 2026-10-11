import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from isrprof import config, pipeline  # noqa: E402
from isrprof.timing import Numerology  # noqa: E402
from isrprof.render import render_html  # noqa: E402

SAMPLE = os.path.join(ROOT, "examples", "sample_config.yaml")


class TimingTests(unittest.TestCase):
    def test_units(self):
        n = Numerology(mu=1)
        self.assertAlmostEqual(n.slot_us, 500.0)
        self.assertAlmostEqual(n.parse("1 slot"), 500.0)
        self.assertAlmostEqual(n.parse("1.2 symbol"), 1.2 * 500.0 / 14)
        self.assertAlmostEqual(n.parse("-30 us"), -30.0)
        self.assertAlmostEqual(n.parse("2 ms"), 2000.0)
        self.assertAlmostEqual(n.parse(2), 2 * n.sym_us)
        with self.assertRaises(ValueError):
            n.parse("3 parsecs")


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = config.load(SAMPLE)
        cls.p = pipeline.run(cls.cfg)

    def test_parse_finds_functions_and_macros(self):
        f = self.p["functions"]
        self.assertIn("dl_slot_isr", f)
        self.assertIn("drv_fft_configure", f)
        # static function ids carry the file name
        self.assertIn("dl_fft_kick@dl_isr.c", f)
        hw = f["drv_fft_configure"]["hw"]
        self.assertEqual({(h["block"], h["reg"], h["kind"]) for h in hw},
                         {("FFT", "SIZE", "write"), ("FFT", "CTRL", "rmw")})

    def test_variable_classification(self):
        fn = self.p["functions"]["dl_track_symbol@dl_isr.c"]
        kinds = {(v["name"], v["rw"]) for v in fn["vars"]}
        self.assertIn(("g_nw_timing", "w"), kinds)
        self.assertIn(("s_sym_in_slot", "w"), kinds)
        shared = {v["name"] for v in self.p["memory"]["variables"] if v["shared_across_cores"]}
        self.assertIn("g_nw_timing", shared)
        self.assertIn("g_timing_adv", shared)

    def test_isr_trees_and_deadlines(self):
        isrs = {i["name"]: i for i in self.p["isrs"]}
        dl = isrs["DL_SLOT_ISR"]
        names = set(dl["functions"])
        self.assertTrue({"dl_pdcch_decode@dl_isr.c", "drv_ldpc_start", "drv_dma_start", "pool_alloc"} <= names)
        # recursion (drv_dma_start <-> dl_dma_done_cb) is cut, not infinite
        self.assertGreater(dl["computed_us"], 0)
        misses = [e for e in dl["hw_events"] if e["violation"]]
        self.assertTrue(misses and all(e["block"] == "LDPC" for e in misses))
        # periodic deadline: RF gate written late inside the UL symbol
        ul = isrs["UL_TX_PREP_ISR"]
        self.assertEqual([e["block"] for e in ul["hw_events"] if e["violation"]], ["RF"])
        self.assertFalse(any(e["violation"] for e in isrs["UL_SYMBOL_ISR"]["hw_events"]))

    def test_structure_metrics(self):
        st = self.p["structure"]
        self.assertEqual(st["tangles"], [["dl_dma_done_cb", "drv_dma_start"]])
        kinds = {(v["kind"], v["from"].split("@")[0], v["to"]) for v in st["violations"]}
        self.assertIn(("upward", "hal_ldpc_wait", "sched_notify_late"), kinds)
        self.assertIn(("rule", "dl_harq_buffer", "pool_alloc"), kinds)
        self.assertIn("dl_isr", st["metrics"]["overweight_modules"])
        # feedback edges live in the lower-left triangle of the levelized order
        pos = {f: i for i, f in enumerate(st["order"])}
        fb = [(st["order"][r], st["order"][c]) for r, c, n, f in st["matrix"] if f]
        self.assertEqual(len(fb), 1)
        self.assertGreater(pos[fb[0][0]], pos[fb[0][1]])

    def test_render_embeds_json(self):
        html = render_html(self.p)
        self.assertIn("<!doctype html>", html)
        self.assertIn('id="profile-data"', html)
        frag = render_html(self.p, fragment=True)
        self.assertFalse(frag.lstrip().startswith("<!doctype"))
        # the embedded JSON must not terminate the script tag early
        start = frag.index('id="profile-data"'); end = frag.index("</script>", start)
        blob = frag[frag.index(">", start) + 1:end]
        self.assertEqual(json.loads(blob.replace("<\\/", "</"))["project"]["name"], self.p["project"]["name"])


if __name__ == "__main__":
    unittest.main()
