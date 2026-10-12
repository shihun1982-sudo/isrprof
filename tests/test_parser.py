import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from isrprof import config, cparser, profile  # noqa: E402

SRC = r"""
#include <stdint.h>
#define HW_WR(b, r, v) (*(volatile uint32_t *)(0x1000) = (v))
#define HW_RD(b, r)    (*(volatile uint32_t *)(0x1000))
typedef struct { uint16_t len; uint8_t valid; } tb_t;
uint32_t g_count;
uint32_t g_shadow;
tb_t     g_queue[4];
int32_t  g_arr[NUM];
static uint32_t s_local_ctr;

static void helper(uint32_t g_shadow)            /* parameter shadows a global */
{
    g_shadow++;                                   /* must NOT count as a global access */
    g_count += g_shadow;                          /* global write (rw) */
}

void worker(const tb_t *tb, uint8_t idx)
{
    uint32_t g_shadow = 3u;                       /* local shadows the global */
    tb_t *q = &g_queue[idx];                      /* addr-of a global */
    int a = 1, g_count;                           /* second declarator shadows g_count */
    for (uint32_t i = 0u; i < 4u; i++) {
        g_shadow += i;
        g_count = (int)i;
    }
    q->len = tb->len;
    s_local_ctr = g_shadow + (uint32_t)a;         /* static write */
    HW_WR(FFT, CTRL, g_arr[1]);
}
"""


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        src = os.path.join(self.td.name, "src")
        os.makedirs(src)
        with open(os.path.join(src, "w.c"), "w", encoding="utf-8") as fh:
            fh.write(SRC)
        with open(os.path.join(self.td.name, "profile.yaml"), "w", encoding="utf-8") as fh:
            fh.write("name: t\ninputs: {}\n")
        with open(os.path.join(self.td.name, "build.yaml"), "w", encoding="utf-8") as fh:
            fh.write("root: src\nsources: ['*.c']\n")
        with open(os.path.join(self.td.name, "hw_structure.yaml"), "w", encoding="utf-8") as fh:
            fh.write("nodes:\n  - { id: FFT, regs: [CTRL] }\n")
        raw, meta = profile.load_raw(self.td.name)
        self.cfg = config.build_config(raw, meta)
        self.pr = cparser.parse(self.cfg)
        self.fns = {f.name: f for f in self.pr.functions}

    def tearDown(self):
        self.td.cleanup()

    def test_parameters_and_locals_shadow_globals(self):
        helper = self.fns["helper"]
        names = {(v.name, v.rw) for v in helper.vars}
        self.assertNotIn(("g_shadow", "rw"), names)
        self.assertNotIn(("g_shadow", "r"), names)
        self.assertIn(("g_count", "rw"), names)
        worker = self.fns["worker"]
        names = {v.name for v in worker.vars}
        self.assertNotIn("g_shadow", names)              # local declaration
        self.assertNotIn("g_count", names)               # second declarator of `int a = 1, g_count;`
        self.assertIn("g_queue", names)                  # addr-of
        self.assertEqual({v.rw for v in worker.vars if v.name == "g_queue"}, {"addr"})
        self.assertIn(("s_local_ctr", "w"), {(v.name, v.rw) for v in worker.vars})
        self.assertIn("g_arr", names)

    def test_array_declarators_and_hw_macro(self):
        names = {v.name for v in self.pr.variables}
        self.assertIn("g_queue", names)
        self.assertIn("g_arr", names)
        self.assertNotIn("NUM", names)
        hw = {(h.block, h.reg, h.kind) for h in self.fns["worker"].hw}
        self.assertEqual(hw, {("FFT", "CTRL", "write")})


if __name__ == "__main__":
    unittest.main()
