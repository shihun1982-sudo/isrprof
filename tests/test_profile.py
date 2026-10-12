import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from isrprof import build as buildmod  # noqa: E402
from isrprof import config, pipeline, profile  # noqa: E402
from isrprof.render import render_html  # noqa: E402

PROFILES = os.path.join(ROOT, "profiles")


class ProfileStoreLoadTests(unittest.TestCase):
    """Profiles bundle the separate input files; they can be listed, cloned and resolved."""

    def test_list_and_find(self):
        names = [p["name"] for p in profile.list_profiles(PROFILES)]
        self.assertIn("nr_modem", names)
        self.assertTrue(profile.find_profile("nr_modem", PROFILES).endswith("profile.yaml"))
        self.assertEqual(profile.find_profile(os.path.join(PROFILES, "nr_modem"), PROFILES), profile.find_profile("nr_modem", PROFILES))

    def test_merge_parts_and_output_dir(self):
        raw, meta = profile.load_raw("nr_modem", PROFILES)
        for k in ("build", "sw_structure", "timing", "hw_structure"):
            self.assertIn(k, raw, k)
            self.assertIn(k, meta.parts)
        self.assertFalse(meta.legacy)
        self.assertEqual(os.path.normpath(meta.output_dir), os.path.normpath(os.path.join(ROOT, "output", "nr_modem")))

    def test_new_profile_clone_and_run(self):
        with tempfile.TemporaryDirectory() as td:
            pdir = os.path.join(td, "profiles")
            shutil.copytree(os.path.join(PROFILES, "nr_modem"), os.path.join(pdir, "nr_modem"))
            dest = profile.new_profile("copy1", "nr_modem", pdir)
            self.assertTrue(os.path.isfile(os.path.join(dest, "timing.yaml")))
            with open(os.path.join(dest, "profile.yaml"), encoding="utf-8") as fh:
                raw = yaml.safe_load(fh)
            self.assertEqual(raw["name"], "copy1")
            self.assertEqual(raw["output"]["dir"], "../../output/copy1")
            # the clone must point at the same sources: fix the relative root for the temp location
            with open(os.path.join(dest, "build.yaml"), encoding="utf-8") as fh:
                b = yaml.safe_load(fh)
            b["root"] = os.path.join(ROOT, "examples", "nr_modem")
            with open(os.path.join(dest, "build.yaml"), "w", encoding="utf-8") as fh:
                yaml.safe_dump(b, fh)
            cfg = config.load("copy1", pdir)
            self.assertEqual(cfg.name, "copy1")
            self.assertTrue(cfg.output["dir"].endswith("copy1"))
            p = pipeline.run(cfg)
            self.assertEqual(p["project"]["profile"], "copy1")
            # template profile
            dest2 = profile.new_profile("blank", None, pdir)
            self.assertTrue(os.path.isfile(os.path.join(dest2, "sw_structure.yaml")))
            with self.assertRaises(profile.ProfileError):
                profile.new_profile("blank", None, pdir)

    def test_cli_run_list_and_resolved(self):
        with tempfile.TemporaryDirectory() as td:
            env = dict(os.environ, PYTHONIOENCODING="utf-8")
            r = subprocess.run([sys.executable, "-m", "isrprof", "run", "nr_modem", "--out-dir", td, "-q"], cwd=ROOT, capture_output=True, text=True, env=env)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(os.path.isfile(os.path.join(td, "profile.html")))
            self.assertTrue(os.path.isfile(os.path.join(td, "profile.json")))
            self.assertTrue(os.path.isfile(os.path.join(td, "profile.resolved.yaml")))
            with open(os.path.join(td, "profile.resolved.yaml"), encoding="utf-8") as fh:
                res = yaml.safe_load(fh)
            self.assertEqual(res["name"], "nr_modem")
            self.assertIn("timing", res["inputs"])
            r = subprocess.run([sys.executable, "-m", "isrprof", "list"], cwd=ROOT, capture_output=True, text=True, env=env)
            self.assertIn("nr_modem", r.stdout)


class BuildInfoTests(unittest.TestCase):
    def test_compile_commands_drive_the_file_list(self):
        cfg = config.load("nr_modem", PROFILES)
        self.assertEqual(cfg.build["translation_units"], 19)
        self.assertEqual(cfg.build["defines"], {"CONFIG_NR_MU": "1", "CONFIG_NUM_CORES": "4"})
        self.assertTrue(any(i.endswith("common") for i in cfg.build["include_dirs"]))
        cs = [os.path.basename(f) for f in cfg.sources if f.endswith(".c")]
        self.assertEqual(len(cs), 19)
        self.assertIn("hal_regs.h", [os.path.basename(f) for f in cfg.sources])
        self.assertTrue(cfg.build["build_command"].startswith("cmake"))

    def test_resolve_without_compile_commands_and_exclude(self):
        b = buildmod.resolve(os.path.join(PROFILES, "nr_modem"), {"root": "../../examples/nr_modem", "sources": ["**/*.c"], "exclude": ["dl/**"]})
        self.assertFalse(any("dl_isr.c" in f for f in b["files"]))
        self.assertTrue(any("ul_isr.c" in f for f in b["files"]))
        self.assertIsNone(b["compile_commands"])


class StructureInputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = config.load("nr_modem", PROFILES)
        cls.p = pipeline.run(cls.cfg)

    def test_sw_hierarchy_maps_code(self):
        sw = self.p["sw_structure"]
        nodes = {n["id"]: n for n in sw["nodes"]}
        self.assertEqual(nodes["dl_pdsch"]["parent"], "dlphy")
        self.assertEqual(nodes["dl_pdsch"]["core"], 1)                      # inherited from the subsystem
        self.assertIn("dl_pdsch_run", nodes["dl_pdsch"]["functions"])
        self.assertEqual(nodes["pdsch_stages"]["variables"], ["k_pdsch_stages@dl_pdsch.c"])
        self.assertEqual(sw["fn_node"]["stage_crc@dl_pdsch.c"], "dl_pdsch")
        self.assertEqual(sw["var_node"]["g_track_state"], "g_track_state")
        # touch index: module (x) + variables with r / w / rw
        t = dict(sw["touch"]["sync_ttl_update@sync.c"])
        self.assertEqual(t["sync"], "x")
        self.assertEqual(t["g_chest_result"], "r")
        self.assertEqual(t["g_track_state"], "rw")
        self.assertEqual(dict(sw["touch"]["dl_fe_symbol_start"])["ASA"], "w")
        # declared + derived (IPC) relations
        kinds = {(r["from"], r["to"], r["kind"]) for r in sw["relations"]}
        self.assertIn(("dl_drv", "l1c_sched", "upcall"), kinds)
        self.assertIn(("dl_pdsch", "ul_pucch", "ipc"), kinds)
        # nothing left unassigned in the sample; detected cross-core variables get an implicit node
        self.assertFalse([n for n in sw["nodes"] if n["id"].startswith("_auto_core")])
        self.assertIn("_auto_shared/s_late_events@l1c_sched.c", sw["var_node"].values())

    def test_hw_hierarchy_blocks_links_and_deadlines(self):
        hw = self.p["hw_structure"]
        nodes = {n["id"]: n for n in hw["nodes"]}
        self.assertEqual(nodes["FFT"]["parent"], "rx_chain")
        self.assertTrue(nodes["FFT"]["block"])
        self.assertFalse(nodes["rx_chain"]["block"])
        self.assertIn(("RFIC", "DFE_RX"), {(l["from"], l["to"]) for l in hw["links"]})
        blocks = {b["id"]: b for b in self.p["hw"]["blocks"]}
        self.assertEqual(blocks["FFT"]["group"], "rx_chain")
        self.assertEqual({tuple(d["cores"]) for d in blocks["RFIC"]["deadlines"]}, {(1,), (2,), (3,)})
        self.assertEqual(self.p["hw"]["unknown_blocks"], [])

    def test_channels_and_references(self):
        ch = self.p["channels"]
        self.assertEqual(ch["tdd_pattern"], "DDDSU")
        items = {c["id"]: c for c in ch["items"]}
        self.assertEqual((items["PDCCH"]["sym_start"], items["PDCCH"]["sym_len"], items["PDCCH"]["slots"]), (0.0, 2.0, "dl"))
        self.assertEqual(items["SSB"]["period_slots"], 20)
        refs = {t["id"]: t for t in self.p["timing_items"]}
        self.assertIn("dl_rtg", refs)
        self.assertAlmostEqual(refs["ul_rtg"]["offset_us"], 2 * self.p["numerology"]["symbol_us"], places=2)
        isrs = {i["name"]: i for i in self.p["isrs"]}
        self.assertEqual(isrs["DL_SYMBOL_ISR"]["timing"], "dl_rtg")

    def test_unknown_reference_or_node_is_an_error(self):
        raw, meta = profile.load_raw("nr_modem", PROFILES)
        bad = json.loads(json.dumps(raw))
        bad["timing"]["isrs"][0]["timing"] = "nope"
        with self.assertRaises(config.ConfigError):
            config.build_config(bad, meta)
        bad = json.loads(json.dumps(raw))
        bad["sw_structure"]["relations"].append({"from": "dlphy", "to": "missing"})
        with self.assertRaises(config.ConfigError):
            config.build_config(bad, meta)

    def test_array_declarations_keep_the_variable_name(self):
        names = {v["name"] for v in self.p["memory"]["variables"]}
        self.assertIn("g_ul_tb_queue", names)
        self.assertIn("g_harq_soft", names)
        self.assertNotIn("TB_QUEUE_LEN", names)
        self.assertNotIn("NUM_HARQ", names)

    def test_viewer_embeds_vendor_and_structures(self):
        html = render_html(self.p)
        self.assertIn("THREE", html)
        self.assertNotIn("cdnjs.cloudflare.com", html)
        self.assertIn('"sw_structure"', html)
        self.assertIn('"hw_structure"', html)


class ViewerSyntaxTests(unittest.TestCase):
    def test_js_parts_parse(self):
        try:
            import esprima  # noqa: F401
        except ImportError:
            self.skipTest("esprima not installed")
        r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "check_js.py")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
