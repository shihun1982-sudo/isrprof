"""objects backend: the ELF reader on a real cross-compiled object (zig) and the binutils text parsers."""
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from isrprof import config, pipeline  # noqa: E402
from isrprof.deep import elf_reader, objects_backend  # noqa: E402

PROFILES = os.path.join(ROOT, "profiles")
HAVE_ZIG = objects_backend.zig_cmd() is not None


class DemangleTests(unittest.TestCase):
    def test_itanium_subset(self):
        d = elf_reader.demangle
        self.assertEqual(d("_ZN2dl8CrcStage3runERNS_3CtxE"), "dl::CrcStage::run")
        self.assertEqual(d("_ZN2dl9FftDriverC2Ev"), "dl::FftDriver::FftDriver")
        self.assertEqual(d("_ZN2dl5StageD2Ev"), "dl::Stage::~Stage")
        self.assertEqual(d("_ZL8ipc_postiPKv"), "ipc_post")
        self.assertEqual(d("_ZN2dl12_GLOBAL__N_19run_stageEPNS_5StageERNS_3CtxE"), "dl::(anonymous namespace)::run_stage")
        self.assertEqual(d("_ZN2ul4RingINS_7HarqAckELj4EE4pushERKS1_"), "ul::Ring::push")
        self.assertEqual(d("_ZZN2dl9FftDriver8instanceEvE4inst"), "inst@instance")
        self.assertEqual(d("_ZplRK3VecS1_"), "operator+")
        self.assertEqual(d("plain_c_symbol"), "plain_c_symbol")


class BinutilsTextTests(unittest.TestCase):
    def test_parse_objdump_and_nm(self):
        od = """
decoder.o:     file format elf32-littlearm

Disassembly of section .text:

00000000 <dl::CrcStage::run(dl::Ctx&)>:
   0:	push	{r4, lr}
   2:	bl	0 <ipc_post>
			2: R_ARM_THM_CALL	ipc_post
   6:	ldr	r0, [pc, #8]
   8:	str	r1, [r0, #4]
   c:	.word	0x00000000
			c: R_ARM_ABS32	shm::g_harq_ack

00000010 <dl_pdsch_isr>:
  10:	bl	0 <dl::pipeline_run()>
			10: R_ARM_THM_CALL	dl::pipeline_run()
"""
        nm = """00000000 00000038 T dl::CrcStage::run(dl::Ctx&)
00000010 00000020 T dl_pdsch_isr
00000000 00000003 B shm::g_harq_ack
00000004 00000004 b s_ipc_seq
"""
        fns = objects_backend.parse_objdump(od)
        self.assertEqual([c["callee"] for c in fns["dl::CrcStage::run"]["calls"]], ["ipc_post"])
        self.assertEqual([r["var"] for r in fns["dl::CrcStage::run"]["refs"]], ["shm::g_harq_ack"])
        self.assertEqual([c["callee"] for c in fns["dl_pdsch_isr"]["calls"]], ["dl::pipeline_run"])
        syms = objects_backend.parse_nm(nm)
        self.assertEqual(syms["dl::CrcStage::run"]["kind"], "function")
        self.assertTrue(syms["s_ipc_seq"]["local"])


@unittest.skipUnless(HAVE_ZIG, "ziglang not installed")
class ZigObjectsTests(unittest.TestCase):
    """The C++ sample is cross-compiled for ARM on this machine with zig and read back from the ELF objects."""

    def test_elf_reader_on_arm_object(self):
        with tempfile.TemporaryDirectory() as td:
            obj = os.path.join(td, "decoder.o")
            src = os.path.join(ROOT, "examples", "cxx_modem", "dl", "decoder.cpp")
            r = subprocess.run(objects_backend.zig_cmd() + ["c++", "-target", "arm-freestanding-eabi", "-mcpu=cortex_m4", "-std=c++17", "-O0", "-fno-inline",
                                                            "-fno-exceptions", "-fno-rtti", "-I", os.path.join(ROOT, "examples", "cxx_modem"), "-c", src, "-o", obj],
                               capture_output=True, text=True, timeout=600)
            self.assertEqual(r.returncode, 0, r.stderr)
            of = elf_reader.read_object(obj)
            self.assertEqual(of.machine, elf_reader.EM_ARM)
            self.assertIn("dl::CrcStage::run", of.functions)
            crc = of.functions["dl::CrcStage::run"]
            self.assertIn("ipc_post", crc.calls)
            self.assertIn("shm::g_harq_ack", crc.data)
            pr = of.functions["dl::pipeline_run"]
            self.assertTrue(any(c.endswith("run_stage") for c in pr.calls), pr.calls)      # -O0: the static helper is a real call
            self.assertIn("dl::s_stages", pr.data)
            self.assertIn("dl_symbol_isr", of.functions)
            self.assertTrue(any("instance" in c for c in of.functions["dl_symbol_isr"].calls))

    def test_objects_backend_end_to_end_on_windows(self):
        cfg = config.load("cxx_modem", PROFILES)
        cfg.build["deep"]["enabled"] = True
        cfg.build["deep"]["backend"] = "objects"
        cfg.build["deep"]["cache"] = False
        with tempfile.TemporaryDirectory() as td:
            cfg.output["dir"] = td
            p = pipeline.run(cfg)
        d = p["deep"]
        self.assertEqual(d["backend"], "objects")
        self.assertGreaterEqual(d.get("objects", 0), 3)
        self.assertGreaterEqual(d.get("compiled", 0), 0)
        f = p["functions"]
        self.assertIn("dl::CrcStage::run", f)
        self.assertTrue(f["dl::CrcStage::run"]["precise"])
        self.assertIn("ipc_post", [c["callee"] for c in f["dl::CrcStage::run"]["calls"]])
        isr = next(i for i in p["isrs"] if i["name"] == "DL_PDSCH_ISR")
        self.assertIn("dl::pipeline_run", isr["functions"])

    def test_both_backends_merge(self):
        cfg = config.load("cxx_modem", PROFILES)
        cfg.build["deep"]["enabled"] = True
        cfg.build["deep"]["backend"] = "both"
        cfg.build["deep"]["cache"] = False
        with tempfile.TemporaryDirectory() as td:
            cfg.output["dir"] = td
            p = pipeline.run(cfg)
        isr = next(i for i in p["isrs"] if i["name"] == "DL_PDSCH_ISR")
        # virtual stages from the frontend, linked edges confirmed by the objects
        self.assertTrue({"dl::LdpcDecoder::run", "dl::CrcStage::run", "dl::run_stage@decoder.cpp"} <= set(isr["functions"]), isr["functions"])
        self.assertIn("objects", p["deep"])


if __name__ == "__main__":
    unittest.main()
