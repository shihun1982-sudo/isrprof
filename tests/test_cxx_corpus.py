"""C / C++ coverage: a corpus of hand-written constructs plus randomly generated programs with a known
call graph.  Every program is run through the token parser and, when libclang is installed, through the
deep (clang) backend; the recovered call graph is compared with the ground truth.

    python -m unittest tests.test_cxx_corpus -v
    ISRPROF_CORPUS_SEEDS=200 python -m unittest tests.test_cxx_corpus     # more random programs
"""
import os
import random
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from isrprof import config, pipeline, profile  # noqa: E402

try:
    from isrprof.deep import clang_backend  # noqa: E402
    HAVE_CLANG = clang_backend.available()[0]
except Exception:  # pragma: no cover
    HAVE_CLANG = False

PROFILE = """name: t
inputs: {}
build:
  root: src
  sources: ['**/*.cpp', '**/*.c', '**/*.h']
  parser: {ignore_calls: [sizeof, memcpy, memset, HW_REG]}
  deep: {enabled: %s, backend: clang, target: arm-none-eabi, std_cxx: c++17, cache: false, jobs: 1}
timing:
  numerology: {mu: 1}
  cores: [{id: 0, name: c0}]
  references: [{id: nw, name: NW, offset: 0}]
  isrs:
%s
hw_structure:
  macros: {read: [HW_RD], write: [HW_WR], rmw: [], block_arg: 0, reg_arg: 1}
  nodes: [{id: FFT, regs: [CTRL, START]}, {id: DMA, regs: [SRC, CTRL]}]
sw_structure:
  touch: {heap_functions: [malloc, free, new, delete]}
"""
HAL = """#pragma once
#include <stdint.h>
#define HW_REG(b, r) (*(volatile uint32_t *)(0x1000u))
#define HW_WR(b, r, v) (HW_REG(b, r) = (uint32_t)(v))
#define HW_RD(b, r) (HW_REG(b, r))
"""


def run_program(files: dict, isrs: list, deep: bool):
    td = tempfile.mkdtemp(prefix="isrprof-cxx-")
    try:
        src = os.path.join(td, "src")
        os.makedirs(src)
        with open(os.path.join(src, "hal.h"), "w", encoding="utf-8") as fh:
            fh.write(HAL)
        for name, text in files.items():
            with open(os.path.join(src, name), "w", encoding="utf-8") as fh:
                fh.write(text)
        isr_yaml = "".join(f"    - {{name: {n.upper()}, core: 0, timing: nw, entry: {n}, start: 0, length: 2}}\n" for n in isrs)
        with open(os.path.join(td, "profile.yaml"), "w", encoding="utf-8") as fh:
            fh.write(PROFILE % ("true" if deep else "false", isr_yaml))
        cfg = config.load(td)
        return pipeline.run(cfg)
    finally:
        shutil.rmtree(td, ignore_errors=True)


def edges(p):
    """{(caller short, callee short)} from the function table (direct + resolved indirect)."""
    out = set()
    F = p["functions"]
    short = lambda fid: fid.split("@")[0]
    for fid, f in F.items():
        for c in f["calls"]:
            if c["callee_id"]:
                out.add((short(fid), short(c["callee_id"])))
            for cid in c.get("callee_ids", []):
                out.add((short(fid), short(cid)))
    return out


def reach(p, isr):
    return {fid.split("@")[0] for fid in next(i for i in p["isrs"] if i["name"] == isr)["functions"]}


# ------------------------------------------------------------------------------ hand-written corpus
CORPUS = {
    "classes_virtual": {
        "files": {"a.cpp": """
#include "hal.h"
namespace ns {
struct Base { virtual void run() { HW_WR(FFT, CTRL, 1); } virtual ~Base() {} void helper() { run(); } };
struct D1 : Base { void run() override { HW_WR(FFT, START, 1); } };
struct D2 : Base { void run() override { HW_WR(DMA, CTRL, 1); } };
static Base *g_obj;
void dispatch(Base &b) { b.run(); }
}
static int g_cnt;
extern "C" void isr_a(void) { ns::D1 d; ns::dispatch(d); ns::g_obj->helper(); g_cnt++; }
"""},
        "isrs": ["isr_a"],
        "expect_reach": {"isr_a": {"ns::dispatch", "ns::Base::helper", "ns::Base::run", "ns::D1::run", "ns::D2::run"}},
        "token_reach": {"isr_a": {"dispatch", "helper", "run"}},
    },
    "templates_lambdas_fnptr": {
        "files": {"b.cpp": """
#include "hal.h"
template <typename F> void apply(F f) { f(); }
template <typename T> T twice(T x) { return x + x; }
static void step_a() { HW_WR(FFT, CTRL, 2); }
static void step_b() { HW_WR(DMA, SRC, 3); }
typedef void (*step_fn)(void);
static const step_fn k_steps[] = { step_a, step_b };
struct Ctl { void (*cb)(void); int n; };
static Ctl g_ctl = { step_b, 0 };
extern "C" void isr_b(void) {
    for (unsigned i = 0; i < 2; i++) { k_steps[i](); }
    g_ctl.cb();
    apply([]() { step_a(); });
    g_ctl.n = twice(g_ctl.n);
}
"""},
        "isrs": ["isr_b"],
        "expect_reach": {"isr_b": {"step_a", "step_b", "apply", "twice"}},
        "token_reach": {"isr_b": {"step_a", "step_b", "apply", "twice"}},
    },
    "ctor_dtor_static_members_operators": {
        "files": {"c.cpp": """
#include "hal.h"
class Vec { public: Vec(int a, int b) : m_a(a), m_b(b) { init(); } ~Vec() { fini(); }
  Vec operator+(const Vec &o) const { return Vec(m_a + o.m_a, m_b + o.m_b); }
  static int count; static void bump() { count++; }
  private: void init() { HW_WR(FFT, CTRL, m_a); } void fini() { HW_WR(FFT, START, 0); } int m_a, m_b; };
int Vec::count;
namespace { int s_anon; void anon_fn() { s_anon++; Vec::bump(); } }
extern "C" void isr_c(void) { Vec v(1, 2); Vec w = v + v; anon_fn(); (void)w; }
"""},
        "isrs": ["isr_c"],
        "expect_reach": {"isr_c": {"Vec::Vec", "Vec::init", "Vec::operator+", "anon_fn", "Vec::bump"}},
        "token_reach": {"isr_c": {"Vec::Vec", "Vec::init", "anon_fn", "Vec::bump"}},
    },
    "c_style_tables_switch_goto": {
        "files": {"d.c": """
#include "hal.h"
static void h0(void) { HW_WR(FFT, CTRL, 0); }
static void h1(void) { HW_WR(DMA, SRC, 1); }
static void (*const tbl[2])(void) = { h0, h1 };
static int g_state;
void isr_d(void) {
    switch (g_state) { case 0: tbl[0](); break; default: tbl[1](); break; }
    if (g_state > 3) goto done;
    g_state++;
done:
    return;
}
"""},
        "isrs": ["isr_d"],
        "expect_reach": {"isr_d": {"h0", "h1"}},
        "token_reach": {"isr_d": {"h0", "h1"}},
    },
    "multiple_inheritance_crtp_variadic": {
        "files": {"e.cpp": """
#include "hal.h"
struct A { virtual void fa() { HW_WR(FFT, CTRL, 1); } };
struct B { virtual void fb() { HW_WR(DMA, CTRL, 1); } };
struct C : A, B { void fa() override { fb(); } };
template <class Derived> struct Crtp { void go() { static_cast<Derived *>(this)->impl(); } };
struct Impl : Crtp<Impl> { void impl() { HW_WR(FFT, START, 1); } };
template <typename... Ts> void log_all(Ts... ts) { int arr[] = { (ts, 0)... }; (void)arr; }
static void sink(int) {}
extern "C" void isr_e(void) { C c; A &a = c; a.fa(); Impl i; i.go(); log_all(1, 2, 3); sink(4); }
"""},
        "isrs": ["isr_e"],
        "expect_reach": {"isr_e": {"A::fa", "C::fa", "B::fb", "Crtp::go", "Impl::impl", "log_all", "sink"}},
        "token_reach": {"isr_e": {"fa", "go", "sink"}},
    },
    "nested_classes_enums_bitfields_unions": {
        "files": {"f.cpp": """
#include "hal.h"
struct Outer { enum class Mode : uint8_t { A, B }; union { uint32_t raw; struct { uint32_t lo : 16, hi : 16; } f; } u;
  struct Inner { void tick() { HW_WR(FFT, CTRL, 7); } } inner; Mode mode = Mode::A; void poke() { inner.tick(); u.f.lo = 1; } };
static Outer g_o;
extern "C" void isr_f(void) { g_o.poke(); if (g_o.mode == Outer::Mode::B) { g_o.u.raw = 0; } }
"""},
        "isrs": ["isr_f"],
        "expect_reach": {"isr_f": {"Outer::poke", "Outer::Inner::tick"}},
        "token_reach": {"isr_f": {"poke", "tick"}},
    },
}


class CorpusTests(unittest.TestCase):
    def check(self, name, case, deep):
        p = run_program(case["files"], case["isrs"], deep)
        exp = case["expect_reach"] if deep else case["token_reach"]
        for isr, fns in exp.items():
            got = reach(p, isr.upper())
            missing = {f for f in fns if not any(g == f or g.endswith("::" + f) or f.endswith("::" + g.split("::")[-1]) and g.split("::")[-1] == f.split("::")[-1] for g in got)}
            self.assertFalse(missing, f"{name} ({'deep' if deep else 'token'}): {isr} should reach {sorted(missing)}; reached {sorted(got)}")
        # HW accesses must land on some reachable function
        hw = [h for isr in p["isrs"] for h in isr["hw_events"]]
        self.assertTrue(hw, f"{name}: no HW access reached from the ISRs")
        return p

    def test_corpus_token_parser(self):
        for name, case in CORPUS.items():
            with self.subTest(case=name):
                self.check(name, case, deep=False)

    @unittest.skipUnless(HAVE_CLANG, "libclang not installed")
    def test_corpus_deep(self):
        for name, case in CORPUS.items():
            with self.subTest(case=name):
                p = self.check(name, case, deep=True)
                self.assertTrue(p["deep"] and p["deep"]["files"] >= 1)


# ------------------------------------------------------------------------------ random programs with a known call graph
class Gen:
    """Random C++ program: N functions of mixed kinds (free, static, method, virtual override, template,
    lambda-wrapped, fn-pointer table) with random calls, HW writes and global accesses; the generator
    remembers which callees every function reaches."""

    def __init__(self, seed: int, n: int = 14):
        self.r = random.Random(seed)
        self.n = n
        self.kinds = [self.r.choice(["free", "static", "method", "virtual", "template", "fnptr"]) for _ in range(n)]
        self.calls = {i: sorted(self.r.sample(range(i + 1, n), min(len(range(i + 1, n)), self.r.randint(0, 3)))) for i in range(n)}

    def name(self, i):
        k = self.kinds[i]
        return {"free": f"f{i}", "static": f"s{i}", "method": f"M{i}::m{i}", "virtual": f"V{i}::v{i}", "template": f"t{i}", "fnptr": f"p{i}"}[k]

    def short(self, i):
        return self.name(i).split("::")[-1]

    def call_expr(self, j):
        k = self.kinds[j]
        if k == "method":
            return f"g_m{j}.m{j}();"
        if k == "virtual":
            return f"g_v{j}->v{j}();"
        if k == "template":
            return f"t{j}<int>(1);"
        if k == "fnptr":
            return f"k_p{j}();"
        return f"{self.short(j)}();"

    def body(self, i):
        lines = []
        if self.r.random() < 0.6:
            lines.append(f"HW_WR({self.r.choice(['FFT', 'DMA'])}, {self.r.choice(['CTRL', 'START'])}, {i});")
        if self.r.random() < 0.5:
            lines.append(f"g_var{i % 4} {self.r.choice(['= 1', '+= 2', '++'])};")
        for j in self.calls[i]:
            lines.append(self.call_expr(j))
        return "\n    ".join(lines) or "(void)0;"

    def source(self):
        out = ['#include "hal.h"', "static int g_var0, g_var1, g_var2, g_var3;"]
        # declarations first (so any order of definition works)
        for i in range(self.n):
            k = self.kinds[i]
            if k in ("free",):
                out.append(f"void f{i}();")
            elif k == "static":
                out.append(f"static void s{i}();")
            elif k == "template":
                out.append(f"template <typename T> void t{i}(T);")
            elif k == "fnptr":
                out.append(f"static void p{i}_impl(); typedef void (*p{i}_t)(); static const p{i}_t k_p{i} = p{i}_impl;")
            elif k == "method":
                out.append(f"struct M{i} {{ void m{i}(); }}; static M{i} g_m{i};")
            elif k == "virtual":
                out.append(f"struct VB{i} {{ virtual void v{i}() = 0; virtual ~VB{i}() {{}} }}; struct V{i} : VB{i} {{ void v{i}() override; }}; static V{i} g_v{i}_obj; static VB{i} *g_v{i} = &g_v{i}_obj;")
        for i in range(self.n):
            k, b = self.kinds[i], self.body(i)
            if k == "free":
                out.append(f"void f{i}() {{\n    {b}\n}}")
            elif k == "static":
                out.append(f"static void s{i}() {{\n    {b}\n}}")
            elif k == "template":
                out.append(f"template <typename T> void t{i}(T) {{\n    {b}\n}}")
            elif k == "fnptr":
                out.append(f"static void p{i}_impl() {{\n    {b}\n}}")
            elif k == "method":
                out.append(f"void M{i}::m{i}() {{\n    {b}\n}}")
            elif k == "virtual":
                out.append(f"void V{i}::v{i}() {{\n    {b}\n}}")
        out.append("extern \"C\" void isr_g(void) {\n    " + "\n    ".join(self.call_expr(j) for j in range(self.n) if self.r.random() < 0.4 or j == 0) + "\n}")
        return "\n".join(out)

    def truth(self):
        """functions reachable from isr_g (indices)."""
        roots = [j for j in range(self.n) if (f"{self.call_expr(j)}" in self._isr_calls)]
        seen, stack = set(), list(roots)
        while stack:
            i = stack.pop()
            if i in seen:
                continue
            seen.add(i)
            stack.extend(self.calls[i])
        return seen

    def build(self):
        src = self.source()
        self._isr_calls = src[src.index('void isr_g(void)'):]
        return src


class RandomProgramTests(unittest.TestCase):
    SEEDS = int(os.environ.get("ISRPROF_CORPUS_SEEDS", "25"))

    def _expected_short(self, g, idx):
        k = g.kinds[idx]
        return {"free": f"f{idx}", "static": f"s{idx}", "method": f"m{idx}", "virtual": f"v{idx}", "template": f"t{idx}", "fnptr": f"p{idx}_impl"}[k]

    def run_seed(self, seed, deep):
        g = Gen(seed)
        src = g.build()
        p = run_program({"gen.cpp": src}, ["isr_g"], deep)
        got = {fid.split("@")[0].split("::")[-1] for fid in reach(p, "ISR_G")}
        truth = {self._expected_short(g, i) for i in g.truth()}
        missing = truth - got
        return p, missing, truth, got, src

    def test_random_programs_token_parser(self):
        for seed in range(self.SEEDS):
            with self.subTest(seed=seed):
                p, missing, truth, got, src = self.run_seed(seed, deep=False)
                # the token parser resolves fn-pointer tables through address-taken functions of the file and
                # methods by name; everything generated here is within its reach
                self.assertFalse(missing, f"seed {seed}: token parser missed {sorted(missing)} of {sorted(truth)}\n{src}")

    @unittest.skipUnless(HAVE_CLANG, "libclang not installed")
    def test_random_programs_deep(self):
        for seed in range(self.SEEDS):
            with self.subTest(seed=seed):
                p, missing, truth, got, src = self.run_seed(seed, deep=True)
                self.assertFalse(missing, f"seed {seed}: deep backend missed {sorted(missing)} of {sorted(truth)}\n{src}")
                # and nothing unrelated is pulled in (no over-approximation beyond the generated edges)
                allowed = truth | {"isr_g"}
                extra = {x for x in got if x not in allowed and not x.startswith(("VB", "~"))}
                self.assertFalse(extra, f"seed {seed}: deep backend reached unexpected {sorted(extra)}")


if __name__ == "__main__":
    unittest.main()
