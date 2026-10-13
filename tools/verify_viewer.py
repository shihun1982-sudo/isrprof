"""Drive the generated viewer through its interactions in a headless browser and report the results.

    python tools/verify_viewer.py output/nr_modem/profile.html [--browser msedge|chrome|<path>] [--screenshot out.png]

The page's built-in self-test (``#selftest`` deep link, see templates/parts/80_init.js) selects ISRs,
nested boxes, HW blocks and SW nodes, changes the call-graph level, the diagram depths, the views and the
time range, and writes a JSON report (per-step results, timings, JS errors) into ``<pre id="selftest-out">``.
This script loads the page with Chromium/Edge ``--headless --dump-dom``, extracts that report and exits
non-zero when a step failed, an error was thrown, or an expectation below does not hold.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
]


def find_browser(pref: str | None) -> str | None:
    if pref and os.path.isfile(pref):
        return pref
    if pref:
        p = shutil.which(pref)
        if p:
            return p
    for c in CANDIDATES:
        if os.path.isfile(c):
            return c
    for name in ("msedge", "chrome", "google-chrome", "chromium"):
        p = shutil.which(name)
        if p:
            return p
    return None


def browser_env() -> dict:
    """Chromium inherits CHROME_* / ELECTRON_* (VS Code / Electron parent) and __COMPAT_LAYER (Windows compat shim) and then behaves as a
    child of that browser (no DOM dump, no screenshot).  Strip them so the tool works from any shell."""
    return {k: v for k, v in os.environ.items() if not k.upper().startswith(("CHROME_", "ELECTRON_")) and k.upper() != "__COMPAT_LAYER"}


def run_browser(browser: str, url: str, budget_ms: int, screenshot: str | None, width: int, height: int) -> str:
    prof = tempfile.mkdtemp(prefix="isrprof-verify-")
    args = [browser, "--headless=new", "--disable-gpu-sandbox", "--no-sandbox", "--no-first-run", "--disable-extensions",
            f"--user-data-dir={prof}", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
            "--allow-file-access-from-files", f"--window-size={width},{height}", f"--virtual-time-budget={budget_ms}",
            "--hide-scrollbars", "--log-level=3"]
    if screenshot:
        args += [f"--screenshot={os.path.abspath(screenshot)}"]
    else:
        args += ["--dump-dom"]
    args.append(url)
    res = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240, env=browser_env())
    shutil.rmtree(prof, ignore_errors=True)
    return res.stdout


def extract_report(dom: str) -> dict | None:
    m = re.search(r'<pre id="selftest-out"[^>]*>(.*?)</pre>', dom, re.DOTALL)
    if not m or not m.group(1).strip():
        return None
    return json.loads(html.unescape(m.group(1)))


# controls whose click may legitimately change nothing in the state the sweep runs in (already at that state / edge of a range)
SWEEP_MAY_IDLE = {"button:cores-all", "button:isr-all", "button:range-full", "button:slot-prev", "button:left", "button:zout", "button:nav-prev", "button:nav-caller", "button:nav-callee", "button:nav-next",
                  "button:hist-fwd", "button:hist-back", "button:fit@sw", "button:fit@hw", "button:focus-clear", "button:dsm-exp", "button:arr1", "button:arr2", "button:aligned", "button:unit-sym",
                  "button:focus-deep", "button:impact@usedby", "button:lvl-dec", "button:col-all", "button:timing", "button:isr-none", "button:pan", "button:imp-apply", "button:only@0"}


def sweep(report: dict, st: dict, bad: list, notes: list) -> None:
    """The control sweep: every window / checkbox / input / select / button must act and recover."""
    steps = [s for s in report["steps"] if s["name"].startswith("sweep:")]
    summ = st.get("sweep summary")
    if not steps or not summ:
        bad.append("control sweep did not run")
        return
    for s in steps:
        if s.get("error"):
            bad.append(f"sweep {s['name'][6:]} threw: {s['error'][:200]}")
    for s in steps:
        n = s["name"][6:]
        if n.startswith("panel:") and not s.get("ok") and not s.get("hidden"):
            bad.append(f"window {n[6:]} did not close / open: {s}")
        if n.startswith("checkbox:") and not (s.get("toggled") and s.get("effect")):
            bad.append(f"{n} had no visible effect when toggled: {s}")
        if n.startswith("checkbox:") and not s.get("restored"):
            bad.append(f"{n} did not come back to its initial picture after toggling twice: {s}")
        if n.startswith(("number:", "range:")) and not s.get("effect"):
            bad.append(f"{n} had no visible effect across its range: {s}")
        if n.startswith(("number:", "range:")) and not s.get("restored"):
            bad.append(f"{n} did not come back after restoring its value: {s}")
        if n.startswith("number:") and any(str(t.get("got")) != str(t.get("set")) for t in s.get("tried", []) if t.get("set") is not None and float(t.get("set")) >= 0):
            notes.append(f"{n}: a value was clamped: {s.get('tried')}")
        if n == "search:isr-filter" and not s.get("effect"):
            bad.append(f"ISR filter box did not narrow the list: {s}")
        if n.startswith("select:") and not s.get("effect"):
            bad.append(f"{n} options had no effect: {s}")
        if n.startswith("button:") and s.get("skipped"):
            continue
        if n.startswith("button:") and n not in SWEEP_MAY_IDLE and not s.get("effect") and not (s.get("pressed") and s["pressed"][0] != s["pressed"][1]) and not (s.get("selected") and s["selected"][0] != s["selected"][1]):
            bad.append(f"{n} click changed nothing: {s}")
        if n.startswith("button:") and s.get("pressedUnchanged") and n not in SWEEP_MAY_IDLE:
            bad.append(f"{n} is a toggle button but aria-pressed did not flip: {s}")
    if summ.get("checkboxes", 0) < 4 or summ.get("buttons", 0) < 15 or summ.get("ranges", 0) < 3 or summ.get("numbers", 0) < 2 or summ.get("panels", 0) < 4:
        bad.append(f"control sweep covered too little: {summ}")
    idle = [n for n in summ.get("noEffect", []) if n not in SWEEP_MAY_IDLE and not n.startswith(("checkbox:", "number:", "range:", "select:"))]
    if idle:
        notes.append("buttons without a visible effect in the sweep state: " + ", ".join(idle))
    notes.append(f"control sweep: {summ.get('panels')} windows, {summ.get('checkboxes')} checkboxes, {summ.get('numbers')} number inputs, {summ.get('ranges')} sliders, {summ.get('selects')} selects, {summ.get('buttons')} buttons exercised")


def check(report: dict) -> list[str]:
    """Expectations on the self-test report (the viewer must really react, not just not crash)."""
    bad: list[str] = []
    notes: list[str] = []
    check.notes = notes                     # informational findings, printed after the result
    st = {s["name"]: s for s in report["steps"]}
    if report.get("errors"):
        bad.append(f"JS errors: {report['errors']}")
    for s in report["steps"]:
        if s.get("error"):
            bad.append(f"step {s['name']!r} threw: {s['error'][:300]}")
    ini = st.get("initial", {})
    if not ini.get("stats", {}).get("boxes"):
        bad.append("no boxes drawn in the timing diagram")
    if not ini.get("swBoxes"):
        bad.append("SW structure diagram is empty")
    if not ini.get("hwBoxes"):
        bad.append("HW structure diagram is empty")
    sel = next((s for s in report["steps"] if s["name"].startswith("select ISR root")), {})
    if sel.get("fids", 0) < 2:
        bad.append("selecting an ISR root did not produce a call closure")
    if not sel.get("swRelX"):
        bad.append("selecting an ISR did not highlight any SW node as executing")
    if not sel.get("hwRel"):
        bad.append("selecting an ISR did not highlight any HW block")
    if (not sel.get("swDim") and ini.get("swBoxes", 0) > sel.get("swRelX", 0) + 2) or (not sel.get("hwDim") and ini.get("hwBoxes", 0) > sel.get("hwRel", 0) + 2):
        bad.append("unrelated SW / HW boxes were not dimmed")
    if sel.get("outline") is False:
        bad.append("selection outline not shown in the 3D diagram")
    sc = st.get("side column clipping", {})
    if sc and not (sc.get("overlap", 1) <= 0 and sc.get("treeBodyBottom", 0) <= sc.get("treeBottom", 0) + 1 and (sc.get("treeScrolls") or sc.get("lastRowBottom", 0) <= sc.get("treeBodyBottom", 0) + 1)):
        bad.append(f"call graph overflows into the details panel instead of scrolling: {sc}")
    hb = st.get("history back / forward + variable / ipc links", {})
    if hb and not (hb.get("back1", {}).get("sel") and not hb.get("back1", {}).get("block") and hb.get("back2", {}).get("sel") is None
                   and hb.get("fwd", {}).get("sel") and hb.get("fwd2", {}).get("block") == hb.get("atBlock")):
        bad.append(f"selection history back / forward did not restore the selections: {hb}")
    vr, ir = hb.get("vr", {}), hb.get("ir", {})
    if hb and not vr.get("skipped") and not (vr.get("fids", 0) >= 1 and vr.get("detailHasUsers") and hb.get("backVar") == vr.get("selVar")):
        bad.append(f"variable selection did not focus its users: {hb}")
    if hb and not ir.get("skipped") and not ir.get("fids", 0) > 0:
        bad.append(f"IPC selection did not focus its users: {hb}")
    pr = st.get("pin rows", {})
    if pr and not (pr.get("after", 0) == pr.get("before", 0) + 1 and pr.get("boxesAfter", 0) > pr.get("boxesBefore", 0) and pr.get("listPressed") == 1
                   and pr.get("pinnedBoxesInSticky", 0) > 0 and pr.get("afterClick") == pr.get("before") and pr.get("stored") == "[]"):
        bad.append(f"pinning an ISR row did not add a sticky copy / toggle back: {pr}")
    if pr and pr.get("shift", 0) < 0 and abs(pr.get("stickyY1", 0) + pr.get("shift", 0)) > 1e-3:
        bad.append(f"pinned rows did not stay on top while scrolling: {pr}")
    if pr and pr.get("shift", 0) >= 0:
        notes.append(f"pin rows: the window held every row even at 220 px, scrolling not exercised ({pr.get('contentPx')} px content)")
    sweep(report, st, bad, notes)
    im = st.get("impact modes", {})
    if im and not (im.get("usedbyRows", 0) >= 2 and im.get("removeHeads", 0) >= 4 and im.get("moveSelect") and im.get("moveHeads", 0) >= 3 and im.get("targetAfter") and im.get("targetAfter") != im.get("target")):
        bad.append(f"impact analysis modes did not render: {im}")
    ds = st.get("details sections", {})
    if ds and not (ds.get("swFirst") and ds.get("swRows", 0) > 0 and ds.get("swAncestors", 0) > 0 and ds.get("hwRows", 0) > 0 and ds.get("regs", 0) > 0 and ds.get("collapsible")):
        bad.append(f"details sections (SW hierarchy first, HW second, collapsible) not as expected: {ds}")
    only = st.get("focus: this function only", {})
    if only.get("fids") != 1:
        bad.append(f"'this function only' should relate exactly one function, got {only.get('fids')}")
    l0, l6, l2 = st.get("level 0", {}), st.get("level 6", {}), st.get("level 2", {})
    if not (l0.get("treeRows", 0) < l2.get("treeRows", 0) <= l6.get("treeRows", 0)):
        bad.append(f"call-graph level did not change the tree: {l0.get('treeRows')} / {l2.get('treeRows')} / {l6.get('treeRows')}")
    if not (l0.get("boxes", 0) < l6.get("boxes", 0)):
        bad.append(f"call-graph level did not change the boxes drawn: {l0.get('boxes')} / {l6.get('boxes')}")
    pc = st.get("call graph: pin / caller / callee", {})
    if pc and (pc.get("selectedIsRoot") or not pc.get("selVisible")):
        bad.append(f"selecting a nested function re-rooted the call graph (or hid the selection): {pc}")
    if pc and not pc.get("pinnedOk"):
        bad.append(f"pinning did not make the selected function the root: {pc}")
    if pc and not (pc.get("pinDroppedOnCaller") and pc.get("calleeDepth") == 1 and (pc.get("afterNext", "").endswith("/1") or pc.get("rootKids", 2) < 2) and pc.get("rootStill") == pc.get("rootUnpinned")):
        bad.append(f"caller / callee / sibling navigation did not behave: {pc}")
    cg = st.get("click call-graph row", {})
    if cg and not (cg.get("treeRows") == cg.get("treeNodes") and cg.get("leafRows", 0) > 0):
        bad.append(f"call graph at 'all levels' does not list every node down to the leaves: {cg}")
    if cg and not (cg.get("selFid") == cg.get("clicked") and cg.get("swRel", 0) > 0 and cg.get("hwRel", 0) > 0 and cg.get("swDim", 0) > 0):
        bad.append(f"clicking a call-graph row did not highlight the SW / HW structures: {cg}")
    if cg and not (cg.get("detailsSW") and cg.get("detailsHW")):
        bad.append(f"details did not list the SW / HW relations of the clicked function: {cg}")
    nested = next((s for s in report["steps"] if s["name"].startswith("select nested box")), {})
    if nested.get("crumbs", 0) != 0:
        bad.append("breadcrumbs shown although no function is pinned as root")
    tog = st.get("toggle expand on a box with callees", {})
    if tog.get("boxesBefore") == tog.get("boxesAfter") or tog.get("boxesRestored") != tog.get("boxesBefore"):
        bad.append(f"expand / collapse on a box did not change (and restore) the diagram: {tog}")
    d1, d4 = st.get("sw depth 1", {}), st.get("sw depth 4", {})
    if not (d1.get("swBoxes", 0) < d4.get("swBoxes", 0)):
        bad.append(f"SW depth did not change the diagram: {d1.get('swBoxes')} / {d4.get('swBoxes')}")
    h1, h3 = st.get("hw depth 1", {}), st.get("hw depth 3", {})
    if not (h1.get("hwBoxes", 0) < h3.get("hwBoxes", 0)):
        bad.append(f"HW depth did not change the diagram: {h1.get('hwBoxes')} / {h3.get('hwBoxes')}")
    blk = next((s for s in report["steps"] if s["name"].startswith("select HW block")), {})
    if blk and not blk.get("hwSel"):
        bad.append("selecting a HW block did not mark it selected")
    swn = next((s for s in report["steps"] if s["name"].startswith("select SW node")), {})
    if swn and not swn.get("fids"):
        bad.append("selecting a SW node did not focus its functions")
    clr = st.get("clear", {})
    if not clr.get("rel") or clr.get("swDim") or clr.get("hwDim"):
        bad.append("clear did not reset the highlighting")
    r1, rf = st.get("range 1 slot", {}), st.get("range full", {})
    if not (r1.get("boxes", 0) < rf.get("boxes", 0)):
        bad.append(f"time range did not reduce the boxes drawn: {r1.get('boxes')} / {rf.get('boxes')}")
    pn = st.get("pan 3d", {})
    if pn and (pn.get("x0") == pn.get("x1") or not pn.get("panMode")):
        bad.append(f"3D view did not pan: {pn}")
    rl = st.get("reference lines off/on", {})
    if rl and not (rl.get("refsNone") == 0 and rl.get("refsBack", 0) > 0 and rl.get("ticksOff") == 0 and rl.get("legend", 0) > 0):
        bad.append(f"reference line / deadline toggles did not apply: {rl}")
    if rl and rl.get("ticks", 0) == 0:
        notes.append("no HW deadline instant falls inside a shown ISR window (data, not a viewer fault)")
    nd = st.get("nudge 2d", {})
    if nd and not (nd.get("r1", 0) > nd.get("r0", 0) and abs(nd.get("back", 0) - nd.get("r0", 0)) < 0.5):
        bad.append(f"2D nudge did not move the time range: {nd}")
    for v in ("view aligned", "view 3d", "view tilt"):
        if not st.get(v, {}).get("boxes"):
            bad.append(f"{v}: nothing drawn")
    co = st.get("core off/on", {})
    if not (co.get("boxesWithCoreOff", 0) < co.get("boxesAll", 0)):
        bad.append("switching a core off did not remove its boxes")
    isf = st.get("isr filter", {})
    if not (isf.get("boxesOne", 0) < isf.get("boxesAll", 0)):
        bad.append("ISR filter did not reduce the boxes")
    sl = st.get("slots 2 from 1", {})
    if sl.get("from") != "1" or sl.get("count") != "2" or not str(sl.get("range", "")).startswith("s1 "):
        bad.append(f"slot selection did not apply: {sl}")
    elif not sl.get("boxes"):
        notes.append("slots 1-3 hold no ISR instance in this profile (data, the range itself applied)")
    sn = st.get("slots next", {})
    if sn and sn.get("from") != str(min(3, int(sn.get("max", 3)) - 2)):      # steps by `count`, clamped to the window
        bad.append(f"slot stepping did not advance: {sn}")
    if isf.get("boxesNone", 1) != 0:
        bad.append("ISR 'none' still draws boxes")
    ov = st.get("overlap 0 / 70", {})
    if ov and ov.get("planes", 0) > 1 and not (ov.get("contentOverlap70", 0) < ov.get("contentNoOverlap", 0)):
        bad.append(f"core overlap did not change the stacked layout: {ov}")
    rs = st.get("resize side / windows", {})
    if rs and (abs(rs.get("sideW", 0) - 500) > 2 or rs.get("handles", 0) < 3 or abs(rs.get("sideDrag", 0) - 150) > 3
               or abs(rs.get("treeAfter", 0) - rs.get("treeBefore", 0) - 120) > 3
               or abs(rs.get("swAfter", 0) - rs.get("swBefore", 0) - 60) > 3
               or abs(rs.get("sceneAfter", 0) - rs.get("sceneBefore", 0) - 90) > 3):
        bad.append(f"dragging a window handle did not resize it: {rs}")
    if "µs" not in st.get("unit us", {}).get("text", ""):
        bad.append("unit switch to µs not reflected")
    stt = st.get("structure tab", {})
    if not (stt.get("dsmRows") or stt.get("dsmCanvas")) or not stt.get("tiles"):
        bad.append("structure tab did not render")
    return bad


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # the report contains µ / → whatever the console code page is
    except Exception:
        pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("html")
    ap.add_argument("--browser", help="browser executable (default: Edge / Chrome found on this machine)")
    ap.add_argument("--screenshot", help="also write a full-page screenshot (separate browser run)")
    ap.add_argument("--budget", type=int, default=20000, help="virtual time budget in ms")
    ap.add_argument("--hash", default="selftest", help="deep-link tokens appended to the URL (default: selftest)")
    ap.add_argument("--json", help="write the raw report here")
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=2400)
    args = ap.parse_args(argv)
    browser = find_browser(args.browser)
    if not browser:
        print("no Chromium-based browser found; pass --browser <path>")
        return 2
    path = os.path.abspath(args.html)
    if not os.path.isfile(path):
        print(f"not found: {path}")
        return 2
    url = "file:///" + path.replace("\\", "/") + ("#" + args.hash if args.hash else "")
    dom = run_browser(browser, url, args.budget, None, args.width, args.height)
    report = extract_report(dom)
    if report is None:
        print("self-test report not found in the page (did the scripts run?)")
        sys.stdout.write(dom[-2000:])
        return 1
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=1)
    bad = check(report)
    print(f"viewer: {path}\nbrowser: {browser}\nWebGL: {'yes' if report.get('have3D') else 'no (2D fallback)'}")
    for s in report["steps"]:
        d = {k: v for k, v in s.items() if k not in ("name", "ms")}
        print(f"  {'FAIL' if s.get('error') else 'ok  '} {s['name']:<34} {s['ms']:>5} ms  {json.dumps(d, ensure_ascii=False)[:230]}")
    if report.get("errors"):
        print("  JS errors:", report["errors"])
    for n in getattr(check, "notes", []):
        print(f"  note: {n}")
    if args.screenshot:
        run_browser(browser, "file:///" + path.replace("\\", "/") + "#sel-" + (report["steps"][1]["name"].split()[-1]), args.budget, args.screenshot, args.width, args.height)
        print(f"  screenshot: {args.screenshot}")
    if bad:
        print("\nFAILED expectations:")
        for b in bad:
            print("  -", b)
        return 1
    print(f"\nall {len(report['steps'])} steps ok, no JS errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
