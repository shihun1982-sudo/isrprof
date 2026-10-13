import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from isrprof import config, pipeline  # noqa: E402

PROFILES = os.path.join(ROOT, "profiles")


class NrModemTests(unittest.TestCase):
    """The 4-core NR modem sample exercises the parser features real firmware needs."""

    @classmethod
    def setUpClass(cls):
        cls.p = pipeline.run(config.load("nr_modem", PROFILES))
        cls.isrs = {i["name"]: i for i in cls.p["isrs"]}

    def test_macro_wrapped_isr_entries(self):
        # ISR_ENTRY(dl_pdsch_isr) { ... } must be recorded as a function named dl_pdsch_isr
        f = self.p["functions"]
        for name in ("slot_tick_isr", "mbox_isr", "dl_symbol_isr", "dl_pdsch_isr", "ul_srs_isr", "ssb_isr"):
            self.assertIn(name, f, name)
        self.assertEqual(self.isrs["DL_PDSCH_ISR"]["tree"]["fid"], "dl_pdsch_isr")

    def test_dispatch_table_calls_are_followed(self):
        run = self.isrs["DL_PDSCH_ISR"]["tree"]["children"][0]
        self.assertEqual(run["name"], "dl_pdsch_run")
        stages = [c["name"] for c in run["children"]]
        self.assertEqual(stages, ["stage_eq", "stage_demap", "stage_descramble", "stage_rate_dematch",
                                  "stage_ldpc_decode", "stage_crc", "stage_deliver"])
        self.assertTrue(all(c["via_table"] == "run" for c in run["children"]))
        # the static closure handed to the viewer carries the same candidates
        call = next(c for c in self.p["functions"]["dl_pdsch_run"]["calls"] if c["indirect"])
        self.assertEqual(len(call["callee_ids"]), 7)

    def test_hw_lines_and_per_core_deadlines(self):
        blocks = {b["id"]: b for b in self.p["hw"]["blocks"]}
        self.assertEqual(blocks["FFT"]["line"], "hw_rx")
        self.assertEqual(blocks["IFFT"]["line"], "hw_tx")
        rf = blocks["RFIC"]["deadlines"]
        self.assertEqual({tuple(d["cores"]) for d in rf}, {(1,), (2,), (3,)})
        # the UL core's RFIC accesses are judged against the hw_tx deadline only
        ul_rf = [e for e in self.isrs["UL_SYMBOL_ISR"]["hw_events"] if e["block"] == "RFIC"]
        self.assertTrue(ul_rf)
        # every UL-core RFIC access is judged against the hw_tx deadline (periodic: some multiple of the period after it)
        dl = blocks["RFIC"]["deadlines"][1]
        self.assertEqual(dl["timing"], "hw_tx")
        for e in ul_rf:
            self.assertIsNotNone(e["deadline_us"])
            k = (e["deadline_us"] - dl["offset_us"] - dl["at_us"]) / dl["period_us"]
            self.assertAlmostEqual(k, round(k), places=4, msg=e)

    def test_poll_macro_is_a_read_and_shared_block_clients(self):
        hw = self.p["functions"]["drv_polar_decode"]["hw"]
        self.assertIn(("POLAR", "STATUS", "read"), {(h["block"], h["reg"], h["kind"]) for h in hw})
        polar = next(b for b in self.p["hw"]["blocks"] if b["id"] == "POLAR")
        self.assertTrue({"drv_polar_decode", "drv_pbch_polar_decode"} <= set(polar["accessors"]))

    def test_custom_register_macro_and_registered_structure(self):
        f = self.p["functions"]
        # REGISTER_READ(DCOC, , DFE_RX): register macro with (reg, unused, block) layout and an empty argument
        self.assertIn(("DFE_RX", "DCOC", "read"), {(h["block"], h["reg"], h["kind"]) for h in f["dl_fe_symbol_start"]["hw"]})
        # ASA is registered in the config (defined outside the sources): direct and macro accesses, per field
        asa = next(v for v in self.p["memory"]["variables"] if v["name"] == "ASA")
        self.assertTrue(asa["registered"] and asa["shared_across_cores"])
        self.assertEqual(set(asa["fields"]), {"dl.dcoc_overflow", "dl.symbol_count", "dl.agc_target_dbm", "ul.max_tx_gain"})
        self.assertEqual(asa["fields"]["dl.dcoc_overflow"]["w"], 1)
        acc = {(a["rw"], a["member"], a["via_macro"]) for a in asa["accessors"]}
        self.assertIn(("w", "dl.dcoc_overflow", "ASA_SET"), acc)
        self.assertIn(("r", "dl.agc_target_dbm", "ASA_GET"), acc)
        self.assertIn(("w", "dl.symbol_count", ""), acc)

    def test_viewer_section_and_annotations(self):
        v = self.p["viewer"]
        self.assertEqual(v["default_view"], "aligned")
        self.assertEqual(v["row_px"], 12)                      # default kept
        self.assertEqual(v["sw_structure"]["open"], ["dl_pdsch"])   # deep-merged user value
        self.assertEqual(len(v["colors"]["palette_light"]), 8)
        self.assertIn("function-pointer table", self.p["functions"]["dl_pdsch_run"]["note"])
        self.assertTrue(next(b for b in self.p["hw"]["blocks"] if b["id"] == "POLAR")["note"])
        self.assertTrue(self.isrs["DL_PDSCH_ISR"]["note"])

    def test_cross_core_variables_and_structure(self):
        shared = {v["name"] for v in self.p["memory"]["variables"] if v["shared_across_cores"]}
        self.assertTrue({"g_nw_timing", "g_dl_harq_ack", "g_track_state", "g_csi_report"} <= shared)
        st = self.p["structure"]
        kinds = {(v["kind"], v["from"].split("@")[0], v["to"].split("@")[0]) for v in st["violations"]}
        self.assertIn(("upward", "hal_ldpc_wait", "sched_notify_late"), kinds)
        self.assertIn(("rule", "mac_if_handle_ul_tb", "pool_alloc"), kinds)
        self.assertEqual(st["tangles"], [["dl_dma_done_cb", "drv_dma_start"]])
        # glob cost patterns resolved for every function
        self.assertTrue(all(f["cost_source"] == "config" for f in self.p["functions"].values()
                            if f["name"].startswith(("drv_", "stage_", "ul_", "dl_"))))


if __name__ == "__main__":
    unittest.main()
