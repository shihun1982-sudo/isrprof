// ================================================================== unified timing diagram (three.js)
// World axes: x = time (NW frame, -> later), y = rows, z = call depth (toward the viewer).
// Row groups, top to bottom:   SW structure touch rows  |  cores -> timing lanes with the call graph
// (one row per call depth, icicle style)  |  HW block rows grouped by HW timing line.
// The default "aligned" view is an orthographic front view: time is horizontal and every row group
// shares the same axis, so a function box, the variables it touches (above) and the registers it
// writes (below) sit in the same vertical slice; connectors make the links explicit.
const STRIP_L = Math.max(80, +(V.label_margin_px || 215)), STRIP_R = 12;   // left label margin / right margin (px)
const ROW_PX = Math.max(6, +(V.row_px || 15));                              // pixel height of one call-depth row at scale 1
const CONN = V.connectors || 'all';                                         // all | focus | none
const TILT = (+(V.tilt_deg || 18)) * Math.PI / 180;
const LEVEL_H = 0.3, BOX_H = 0.24, ROW_H = 0.3, GRP_H = 0.34, LANE_PAD = 0.2, LANE_GAP = 0.22, CORE_GAP = 0.45, GROUP_GAP = 0.5, DZ = 0.8, ZBACK = -0.7;
let SX = 0.5;                                      // world units per symbol (set per build)
const ortho = () => S.view !== 'persp';            // aligned and tilt views are orthographic (time axis pixel-aligned)
const tiltA = () => (S.view === 'tilt' ? TILT : 0);

function laneMaxDepth(isrs) { let d = 0; for (const isr of isrs) walk(isr.tree, isr.name, (n, p) => { if (p === isr.name || nodeVisible(p)) d = Math.max(d, n.depth); }); return d; }
function computeLanes() {
  const lanes = [], groups = [];
  for (const c of CORES) {
    if (!S.cores.has(c.id)) continue;
    const isrs = visibleIsrs().filter(i => i.core === c.id);
    const tids = [...new Set(isrs.map(i => i.timing))].sort((a, b) => TIX[a].idx - TIX[b].idx);
    if (!tids.length) continue;
    const g = { core: c, lanes: [] };
    for (const t of tids) { const li = isrs.filter(i => i.timing === t), md = laneMaxDepth(li); g.lanes.push({ core: c, timing: TIX[t], isrs: li, maxDepth: md, h: LANE_PAD * 2 + LEVEL_H * (md + 1) }); }
    groups.push(g); lanes.push(...g.lanes);
  }
  return { lanes, groups };
}
function computeLayout() {              // assign y to every row / lane; returns everything build3D needs
  const T = collectTouches(), top = swRows(T), bottom = hwRows(T), { lanes, groups } = computeLanes();
  let y = 0;
  const place = rows => rows.forEach(r => { const h = r.group ? GRP_H : ROW_H; r.yTop = y; r.yBot = y - h; r.y = y - h / 2; r.h = h; y -= h; });
  place(top); y -= GROUP_GAP;
  for (const g of groups) { g.yTop = y; for (const ln of g.lanes) { ln.yTop = y; ln.yBot = y - ln.h; ln.y = y - ln.h / 2; y -= ln.h + LANE_GAP; } y += LANE_GAP; g.yBot = y; y -= CORE_GAP; }
  y -= GROUP_GAP - CORE_GAP;
  place(bottom);
  return { T, top, bottom, lanes, groups, height: -y };
}
const rowY = (ln, depth) => ln.yTop - LANE_PAD - LEVEL_H * depth - LEVEL_H / 2;
function instDeadlines(isr, start) {    // deadline instants for one ISR instance inside its activity window
  const out = [], a0 = start - 0.2 * SYM, a1 = start + Math.max(isr.computed_us, isr.length_us || 0) + 0.6 * SYM;
  for (const b of new Set(isr.hw_events.map(e => e.block))) {
    for (const d of (BX[b] ? BX[b].deadlines : [])) {
      if (d.cores && !d.cores.includes(isr.core)) continue;
      if (d.isrs && !d.isrs.includes(isr.name)) continue;
      if (d.period_us) { for (let k = Math.floor((a0 - d.offset_us) / d.period_us) - 1; ; k++) { const t = d.offset_us + k * d.period_us + d.at_us; if (t > a1) break; if (t >= a0) out.push({ block: b, t, d }); } }
      else if (d.abs_us >= a0 && d.abs_us <= a1) out.push({ block: b, t: d.abs_us, d });
    }
  }
  const seen = new Set();
  return out.filter(o => { const k = o.block + '|' + o.t.toFixed(2); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ------------------------------------------------------------------ renderer / cameras / interaction
const sceneEl = document.getElementById('scene');
let renderer = null, scene, camera, camP, camO, root, meshes = [], raycaster, pointer = null, hovered = null, have3D = false;
const cam = { theta: 0.35, phi: 1.25, radius: 20, target: null };
const ext = { x0: 0, x1: 1, yTop: 0.6, yBot: -5, vTop: 0.6, vBot: -5, k: 0.02, yShift: 0, zFront: 3 };
function init3D() {
  if (typeof THREE === 'undefined') return false;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch (e) { return false; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  sceneEl.insertBefore(renderer.domElement, sceneEl.firstChild);
  scene = new THREE.Scene();
  camP = new THREE.PerspectiveCamera(38, 1, 0.1, 4000);
  camO = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
  camera = camO;
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const d = new THREE.DirectionalLight(0xffffff, 0.5); d.position.set(4, 6, 10); scene.add(d);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.25); d2.position.set(-6, 3, -4); scene.add(d2);
  root = new THREE.Group(); scene.add(root);
  raycaster = new THREE.Raycaster(); pointer = new THREE.Vector2(); cam.target = new THREE.Vector3();
  let drag = null, wheelT = null, pendingRange = null;
  const el = renderer.domElement;
  const pxToUs = px => R0() + (px - STRIP_L) * ext.k / SX * SYM;
  el.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey, moved: false, dx: 0 }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.dx += dx;
      if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
      if (ortho()) { root.position.x += dx * ext.k; ext.yShift += dy * ext.k; updateCamera(); return; }
      if (drag.b === 2 || drag.shift) pan(dx, dy); else { cam.theta -= dx * 0.006; cam.phi = Math.max(0.05, Math.min(Math.PI - 0.05, cam.phi - dy * 0.006)); }
      updateCamera(); return;
    }
    pick(e);
  });
  el.addEventListener('pointerup', e => {
    if (!drag) return;
    if (!drag.moved) click(e);
    else if (ortho() && Math.abs(drag.dx) > 2) { const shift = -drag.dx * ext.k / SX * SYM; root.position.x = 0; shiftRange(shift); }
    drag = null;
  });
  el.addEventListener('pointerleave', () => { hideTip(); setHover(null); });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('wheel', e => {
    e.preventDefault();
    if (ortho()) {
      if (e.shiftKey) { ext.yShift += e.deltaY * ext.k * 0.5; updateCamera(); return; }    // shift+wheel scrolls rows
      const r = el.getBoundingClientRect(), t = pxToUs(e.clientX - r.left), f = Math.exp(e.deltaY * 0.0012);
      const span = Math.max(SYM, Math.min(W1 - W0, (R1() - R0()) * f));
      let s = t - (t - R0()) * (span / (R1() - R0())); s = Math.max(W0, Math.min(W1 - span, s));
      pendingRange = span >= (W1 - W0) - 1e-6 ? null : { start: s, end: s + span };
      clearTimeout(wheelT); wheelT = setTimeout(() => applyRange(pendingRange), 80);
      return;
    }
    cam.radius *= Math.exp(e.deltaY * 0.0012); cam.radius = Math.max(1, Math.min(800, cam.radius)); updateCamera();
  }, { passive: false });
  el.addEventListener('dblclick', e => { const h = pickAt(e); if (h && !ortho()) { cam.target.copy(h.object.position); cam.radius = Math.min(cam.radius, 12); updateCamera(); } });
  sceneEl.querySelectorAll('.views button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  window.addEventListener('resize', resize3D);
  have3D = true; return true;
}
function shiftRange(dUs) {
  const span = R1() - R0(); let s = R0() + dUs; s = Math.max(W0, Math.min(W1 - span, s));
  if (Math.abs(s - R0()) < 1e-6 || span >= (W1 - W0) - 1e-6) { draw(); return; }
  applyRange({ start: s, end: s + span });
}
function pan(dx, dy) {
  const right = new THREE.Vector3(), up = new THREE.Vector3();
  camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
  const k = cam.radius * 0.0016;
  cam.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
}
function updateCamera() {
  if (!have3D) return;
  const Wc = Math.max(sceneEl.clientWidth, 100), Hc = Math.max(sceneEl.clientHeight, 100);
  if (ortho()) {
    camera = camO;
    // Orthographic camera looking at world (cx, 0, 0) from above by the tilt angle a (0 = aligned):
    // view-space y of a world point = y·cos a − z·sin a, so x (time) stays pixel-aligned while depth
    // (call depth, SW rows behind, HW rows in front) shows as a downward shift.  Frustum is camera-relative.
    const k = ext.k, W = Wc * k, H = Hc * k, a = tiltA();
    if (!isFinite(ext.vTop) || !isFinite(ext.vBot)) { ext.vTop = ext.yTop; ext.vBot = ext.yBot; }   // before the first build
    const contentH = ext.vTop - ext.vBot;
    if (!isFinite(ext.yShift)) ext.yShift = 0;
    ext.yShift = Math.max(Math.min(ext.yShift, 0), Math.min(0, H - contentH));   // clamp the vertical scroll
    const cx = ext.x0 - STRIP_L * k + W / 2, topV = ext.vTop + ext.yShift;
    camO.left = -W / 2; camO.right = W / 2; camO.top = topV; camO.bottom = topV - H;
    camO.up.set(0, 1, 0); camO.position.set(cx, 300 * Math.sin(a), 300 * Math.cos(a)); camO.lookAt(cx, 0, 0); camO.updateProjectionMatrix();
    if (window.ISRPROF_DEBUG) console.log('CAM', S.view, camO.left, camO.right, camO.top, camO.bottom, camO.position.toArray().join(','), 'ext', ext.vTop, ext.vBot, ext.x0, ext.x1, Wc, Hc, 'root', root.children.length);
  } else {
    camera = camP; camP.aspect = Wc / Hc; camP.updateProjectionMatrix();
    const sp = Math.sin(cam.phi);
    camP.position.set(cam.target.x + cam.radius * sp * Math.sin(cam.theta), cam.target.y + cam.radius * Math.cos(cam.phi), cam.target.z + cam.radius * sp * Math.cos(cam.theta));
    camP.lookAt(cam.target);
  }
  draw();
}
function setView(v) {
  if (!have3D) return;
  if (v === 'zin' || v === 'zout') {
    if (ortho()) { const span = R1() - R0(), ns = Math.max(SYM, Math.min(W1 - W0, span * (v === 'zin' ? 0.7 : 1.4))), mid = (R0() + R1()) / 2; const s = Math.max(W0, Math.min(W1 - ns, mid - ns / 2)); applyRange(ns >= (W1 - W0) - 1e-6 ? null : { start: s, end: s + ns }); }
    else { cam.radius = Math.max(1, Math.min(800, cam.radius * (v === 'zin' ? 0.8 : 1.25))); updateCamera(); }
    return;
  }
  if (v === 'aligned' || v === 'tilt') { S.view = v; ext.yShift = 0; markViews(); build3D(); return; }
  S.view = 'persp';
  if (v === 'iso') { cam.theta = 0.35; cam.phi = 1.25; }
  else if (v === 'front') { cam.theta = 0; cam.phi = Math.PI / 2 - 0.02; }
  else if (v === 'side') { cam.theta = Math.PI / 2 - 0.05; cam.phi = Math.PI / 2 - 0.05; }
  else if (v === 'top') { cam.theta = 0; cam.phi = 0.08; }
  markViews(); build3D(); fit(); updateCamera();
}
function markViews() {
  const active = S.view === 'persp' ? 'iso' : S.view;
  sceneEl.querySelectorAll('.views button').forEach(b => { if (['aligned', 'tilt', 'iso'].includes(b.dataset.view)) b.setAttribute('aria-pressed', b.dataset.view === active); });
}
// perspective framing: the focused call subtree when there is one, otherwise the core lanes
// (the SW / HW row groups stay in the picture as context behind / in front of the lanes)
function fit() {
  if (ortho()) return;
  const box = new THREE.Box3();
  const focus = S.selFid ? meshes.filter(m => m.userData.node && !m.userData.ev && !m.userData.varTip && !m.userData.ipcTip && !m.userData.heapTip && inFocus(m.userData.path, m.userData.node.fid)) : [];
  if (focus.length) { focus.forEach(m => box.expandByObject(m)); box.expandByScalar(0.8); }
  else box.set(new THREE.Vector3(ext.x0, ext.lanesBot || ext.yBot, -0.5), new THREE.Vector3(ext.x1, ext.lanesTop || ext.yTop, ext.zFront || 3));
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  cam.target.copy(c);
  const fov = camP.fov * Math.PI / 180, h = Math.max(size.y, size.x / camP.aspect) / 2;
  cam.radius = Math.max(4, h / Math.tan(fov / 2) * 1.15 + size.z * 0.6);
}
// setSize with updateStyle=true: the canvas gets an explicit CSS size, so a device pixel ratio != 1
// does not stretch the drawing buffer and the time axis stays pixel-aligned with the margins
function sizeCanvas() { renderer.setSize(sceneEl.clientWidth, sceneEl.clientHeight); }
function resize3D() { if (!have3D) return; sizeCanvas(); updateCamera(); }
function draw() { if (have3D) renderer.render(scene, camera); }
// text sprite; opt.h is the final height in world units (0.22 = 11 px in the aligned view), the texture
// is rasterised at 2x for crispness
function label(text, opt) {
  opt = opt || {};
  const h = opt.h || 0.24, px = Math.max(10, Math.round(h / ext.k)), size = px * 2, c = document.createElement('canvas'), ctx = c.getContext('2d');
  const font = `${opt.bold ? '600' : '400'} ${size}px "IBM Plex Mono", Consolas, monospace`;
  ctx.font = font; const w = Math.ceil(ctx.measureText(text).width) + 12;
  c.width = w; c.height = Math.round(size * 1.3); ctx.font = font;
  if (opt.bg) { ctx.fillStyle = opt.bg; ctx.fillRect(0, 0, w, c.height); }
  ctx.fillStyle = opt.color || cssVar('--fg'); ctx.textBaseline = 'middle'; ctx.fillText(text, 6, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, opacity: opt.opacity == null ? 1 : opt.opacity }));
  const hh = h * 1.3; s.scale.set(hh * w / c.height, hh, 1); s.renderOrder = 10; return s;
}
function line(points, color, dashed, opacity) {
  const g = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
  const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.1, gapSize: 0.07, transparent: true, opacity: opacity == null ? 1 : opacity })
                   : new THREE.LineBasicMaterial({ color, transparent: true, opacity: opacity == null ? 1 : opacity });
  const l = new THREE.Line(g, m); if (dashed) l.computeLineDistances(); return l;
}
function clearGroup(g) { while (g.children.length) { const o = g.children.pop(); g.remove(o); if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } } }
// one InstancedMesh per row for its marks (thousands of marks stay cheap); per-instance colour, dim = blended
function markMesh(row, tx, zc, k, dimColor) {
  const marks = row.tick ? (row.marks || []) : mergeMarks((row.marks || []).slice());
  if (!marks.length) return null;
  const h = row.tick ? BOX_H * 0.8 : BOX_H * 0.62, geo = new THREE.BoxGeometry(1, h, 0.18);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), marks.length);
  const mat = new THREE.Matrix4(), col = new THREE.Color(), r0 = R0(), r1 = R1();
  marks.forEach((m, i) => {
    const ta = Math.max(m.t0, r0), tb = Math.min(m.t1, r1);
    if (tb < ta || m.t1 < r0 || m.t0 > r1) { mat.makeScale(0, 0, 0); mesh.setMatrixAt(i, mat); return; }   // outside the time range: hidden
    const x0 = tx(ta), w = row.tick ? Math.max(2.4 * k, 0.012) : Math.max(tx(tb) - x0, 2 * k);
    mat.makeScale(w, 1, 1); mat.setPosition(x0 + w / 2 - (row.tick ? w / 2 : 0), row.y, zc);
    mesh.setMatrixAt(i, mat);
    col.set(m.c); if (!m.foc) col.lerp(dimColor, 0.78); mesh.setColorAt(i, col);
  });
  mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.userData = { row, marks }; return mesh;
}

// ------------------------------------------------------------------ build
function build3D() {
  if (!have3D) { build2D(); return; }
  clearGroup(root); meshes = []; hovered = null; root.position.x = 0;
  const L = computeLayout(), { lanes, groups, height } = L;
  const r0 = R0(), r1 = R1(), nSym = Math.max((r1 - r0) / SYM, 0.5);
  const Wc = Math.max(sceneEl.clientWidth, 400), plotPx = Math.max(Wc - STRIP_L - STRIP_R, 200);
  ext.k = LEVEL_H / (ROW_PX * S.tscale);            // world units per pixel: one call-depth row = row_px × scale
  SX = plotPx * ext.k / nSym;                         // the time range fills the plot width exactly
  const k = ext.k, tx = us => (us - r0) / SYM * SX;
  const x0 = 0, x1 = tx(r1), yTop = 0.55, yBot = -height - 0.25;
  Object.assign(ext, { x0, x1, yTop: yTop + 0.32 + 24 * k, yBot: yBot - 0.3 });   // 24 px head room for the overview bar
  const panelC = new THREE.Color(cssVar('--panel')), panel2C = new THREE.Color(cssVar('--panel-2')), lineC = new THREE.Color(cssVar('--line-strong')), gridC = new THREE.Color(cssVar('--line')), fg = new THREE.Color(cssVar('--fg'));
  const critC = new THREE.Color(cssVar('--critical')), readC = new THREE.Color(cssVar('--read')), writeC = new THREE.Color(cssVar('--write')), accentC = new THREE.Color(cssVar('--accent')), mutedC = cssVar('--muted');
  const persp = S.view === 'persp', tilt = S.view === 'tilt', dz = persp ? 1.2 : DZ;      // deeper steps in the 3D view
  const maxDepth = Math.max(0, ...lanes.map(l => l.maxDepth)), zFront = maxDepth * dz + 0.8, hwMarks = [];
  const zSW = persp ? -1.1 : (tilt ? -0.6 : -0.35), zHW = persp ? zFront + 0.9 : (tilt ? zFront * 0.6 + 0.1 : zFront + 0.1);
  const a = tiltA();
  Object.assign(ext, { zFront, lanesTop: lanes.length ? lanes[0].yTop : 0, lanesBot: lanes.length ? lanes[lanes.length - 1].yBot : -1,
    vTop: ext.yTop * Math.cos(a) - zSW * Math.sin(a) + 0.2 * Math.sin(a), vBot: ext.yBot * Math.cos(a) - (zHW + 0.3) * Math.sin(a) });
  const pxPerSym = SX / k, symLines = pxPerSym >= 4, symLabels = pxPerSym >= 34, labelMinW = 44 * k;
  const emphasis = !!(REL || S.block), connectors = CONN === 'all' || (CONN === 'focus' && emphasis);
  if (V.legend === false) document.getElementById('legend').hidden = true;
  // --- NW grid: vertical slot / symbol lines across every row group, slot labels on top
  for (let i = Math.ceil(r0 / SYM - 1e-9); i <= Math.floor(r1 / SYM + 1e-9); i++) {
    const isSlot = ((i % SPS) + SPS) % SPS === 0; if (!isSlot && !symLines) continue;
    const x = tx(i * SYM);
    root.add(line([[x, yBot, ZBACK], [x, yTop, ZBACK]], isSlot ? lineC : gridC, false, isSlot ? 0.9 : 0.4));
    if (isSlot) root.add(line([[x, yTop, ZBACK], [x, yTop, zFront]], lineC, false, 0.3));
    if (isSlot || symLabels) {
      const txt = isSlot ? `s${i / SPS}${i === 0 ? ' (NW)' : ''}` : `${((i % SPS) + SPS) % SPS}`;
      const lb = label(txt, { size: isSlot ? 21 : 16, color: isSlot ? cssVar('--fg') : mutedC, h: 0.26, bold: isSlot });
      lb.position.set(x + lb.scale.x / 2 + 0.03, yTop + 0.16, ZBACK); root.add(lb);
    }
  }
  // --- generic rows (top: SW structure touch, drawn one layer behind the call graph; bottom: HW blocks,
  //     drawn in front of the deepest call level - so in the 3D view depth reads as SW structure -> calls -> HW)
  const rowOf = {};     // 'var:key' | 'block:id' | 'ipc:id' | 'heap' -> row (for connectors)
  const drawRows = (rows, kindTag) => {
    const zc = kindTag === 'hw' ? zHW : zSW;
    rows.forEach((r, idx) => {
      r.z = zc;
      if (r.group) {
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + STRIP_L * k, r.h - 0.04), new THREE.MeshBasicMaterial({ color: r.sub ? panelC : panel2C, transparent: true, opacity: r.sub ? 0.6 : 0.95, depthWrite: false }));
        plate.position.set((x0 + x1) / 2 - STRIP_L * k / 2, r.y, zc - 0.12); root.add(plate);
        const lb = label(`${r.open ? '▾' : '▸'} ${r.label}${r.count != null ? ' (' + r.count + ')' : ''}`, { size: r.sub ? 15 : 17, bold: !r.sub, h: r.sub ? 0.2 : 0.22, color: r.sub ? mutedC : cssVar('--fg') });
        lb.position.set(x0 - STRIP_L * k + 0.08 + lb.scale.x / 2 + (r.sub ? 0.25 : 0), r.y, zc + 0.2);
        lb.userData = { toggle: { kind: 'grp', id: r.group, hide: r.sub ? 'hide:' + r.group.slice(5) : null }, title: r.label }; root.add(lb); meshes.push(lb);
        return;
      }
      if (r.kind === 'var') rowOf['var:' + r.id] = r; else if (r.kind === 'block') rowOf['block:' + r.id] = r; else if (r.kind === 'ipc') rowOf['ipc:' + r.id] = r; else if (r.kind === 'heap') rowOf.heap = r;
      { const bg = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, r.h), new THREE.MeshBasicMaterial({ color: idx % 2 === 0 ? fg : panelC, transparent: true, opacity: idx % 2 === 0 ? 0.035 : 0.5, depthWrite: false })); bg.position.set((x0 + x1) / 2, r.y, zc - 0.11); root.add(bg); }
      root.add(line([[x0, r.yBot, zc - 0.1], [x1, r.yBot, zc - 0.1]], gridC, false, 0.45));
      if (r.color) { const sw = new THREE.Mesh(new THREE.BoxGeometry(0.06, r.h - 0.1, 0.04), new THREE.MeshBasicMaterial({ color: new THREE.Color(r.color) })); sw.position.set(x0 - STRIP_L * k + 0.12 + r.depth * 0.3, r.y, zc + 0.1); root.add(sw); }
      if (!(persp && r.dim)) {        // the 3D view drops labels of unrelated rows to stay legible
        const lb = label(`${r.car ? (r.open ? '▾ ' : '▸ ') : ''}${r.label}`, { size: 15, h: 0.2, color: r.sel ? cssVar('--accent') : (r.muted ? mutedC : cssVar('--fg')), bold: !!r.sel, opacity: r.dim ? 0.4 : 1 });
        if (lb.scale.x > STRIP_L * k - 0.3 - r.depth * 0.3) lb.scale.multiplyScalar((STRIP_L * k - 0.3 - r.depth * 0.3) / lb.scale.x);
        lb.position.set(x0 - STRIP_L * k + 0.22 + r.depth * 0.3 + lb.scale.x / 2, r.y, zc + 0.2);
        lb.userData = { toggle: { kind: r.kind, id: r.id }, title: r.title || r.label }; root.add(lb); meshes.push(lb);
      }
      if (r.line) {      // HW line local boundaries (dashed) and deadlines in that line's frame
        const off = r.line.offset_us, step = symLines ? SYM : SLOT;
        for (let i = Math.ceil((r0 - off) / step); i <= Math.floor((r1 - off) / step); i++) { const x = tx(off + i * step), strong = symLines ? ((((i % SPS) + SPS) % SPS) === 0) : true; root.add(line([[x, r.yBot + 0.02, zc - 0.09], [x, r.yTop - 0.02, zc - 0.09]], fg, true, strong ? 0.55 : 0.22)); }
      }
      (r.deadlines || []).forEach(d => { if (d.d.period_us && d.d.period_us < SLOT && !symLines) return; root.add(line([[tx(d.t), r.yBot + 0.01, zc - 0.05], [tx(d.t), r.yTop - 0.01, zc - 0.05]], critC, false, 0.55)); });
      const mm = markMesh(r, tx, zc, k, panelC); if (mm) { root.add(mm); meshes.push(mm); }
    });
  };
  drawRows(L.top, 'sw'); drawRows(L.bottom, 'hw');
  // --- cores -> timing lanes with the call graph
  for (const g of groups) {
    const cC = new THREE.Color(coreColor(g.core.id));
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, g.yTop - g.yBot, 0.06), new THREE.MeshBasicMaterial({ color: cC })); bar.position.set(x0 - 0.05, (g.yTop + g.yBot) / 2, 0.2); root.add(bar);
    const lb = label(g.core.name, { size: 19, bold: true, h: 0.25, color: coreColor(g.core.id) }); lb.position.set(x0 - STRIP_L * k + 0.08 + lb.scale.x / 2, g.yTop - 0.15, 0.25); root.add(lb);
  }
  for (const ln of lanes) {
    const off = ln.timing.offset_us, cC = new THREE.Color(coreColor(ln.core.id));
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, ln.h), new THREE.MeshBasicMaterial({ color: cC, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    plate.position.set((x0 + x1) / 2, ln.y, ZBACK - 0.01); root.add(plate);
    root.add(line([[x0, ln.yBot, ZBACK], [x1, ln.yBot, ZBACK]], gridC, false, 0.7));
    const step = symLines ? SYM : SLOT;
    for (let i = Math.ceil((r0 - off) / step); i <= Math.floor((r1 - off) / step); i++) { const x = tx(off + i * step), strong = symLines ? ((((i % SPS) + SPS) % SPS) === 0) : true; root.add(line([[x, ln.yBot + 0.03, ZBACK + 0.02], [x, ln.yTop - 0.03, ZBACK + 0.02]], fg, true, strong ? 0.7 : 0.3)); }
    const t1 = label(ln.timing.name, { size: 19, bold: true, h: 0.25 }); t1.position.set(x0 - 0.12 - t1.scale.x / 2, ln.y + 0.13, 0.25); root.add(t1);
    const t2 = label(`${off >= 0 ? '+' : ''}${(off / SYM).toFixed(2)} sym · ${ln.isrs.map(i => i.name).join(', ')}`, { size: 14, color: mutedC, h: 0.19 });
    if (t2.scale.x > STRIP_L * k - 0.4) t2.scale.multiplyScalar((STRIP_L * k - 0.4) / t2.scale.x);
    t2.position.set(x0 - 0.12 - t2.scale.x / 2, ln.y - 0.14, 0.25); root.add(t2);
    for (const isr of ln.isrs) {
      const span = Math.max(isr.computed_us, isr.length_us || 0), coreC = new THREE.Color(coreColor(isr.core));
      const insts = instancesOf(isr).filter(i => i.start + span >= r0 && i.start <= r1), many = insts.length > 16, shown = shownInst(isr);
      for (const inst of insts) {
        const dt = inst.k * (isr.period_us || 0), base = inst.start, sub = showSub(isr, inst.k), rootPath = isr.name + '#' + inst.k;
        if (isr.length_us && base + isr.length_us >= r0 && base <= r1) {
          const ea = Math.max(base, r0), eb = Math.min(base + isr.length_us, r1), w = Math.max(tx(eb) - tx(ea), 0.02);
          const env = new THREE.Mesh(new THREE.BoxGeometry(w, ln.h - 0.08, 0.26), new THREE.MeshBasicMaterial({ color: coreC, transparent: true, opacity: isr.over_budget ? 0.1 : 0.15, depthWrite: false }));
          env.position.set(tx(ea) + w / 2, ln.y, -0.3); root.add(env);
          const eg = new THREE.LineSegments(new THREE.EdgesGeometry(env.geometry), new THREE.LineBasicMaterial({ color: isr.over_budget ? critC : coreC, transparent: true, opacity: 0.8 })); eg.position.copy(env.position); root.add(eg);
        }
        if (sub) {
          const dls = instDeadlines(isr, base).sort((a, b) => a.t - b.t);
          dls.forEach((dl, di) => {
            if (dl.t < r0 || dl.t > r1) return;
            const x = tx(dl.t), relB = !REL || REL.blocks.has(dl.block);
            root.add(line([[x, ln.yBot, zFront], [x, ln.yTop, zFront]], critC, true, relB ? 0.95 : 0.25));
            if ((!many || inst.k === shown.k) && relB) {      // labels staggered over three heights so clustered deadlines stay readable
              const lb = label(`${dl.block} ≤${(dl.d.at_us / SYM).toFixed(1)}`, { color: cssVar('--critical'), h: 0.18 });
              lb.position.set(x + lb.scale.x / 2 + 0.02, ln.yTop - 0.1 - (di % 3) * 0.2, 0.35); root.add(lb);
            }
          });
        }
        walk(isr.tree, rootPath, (n, p) => {
          if (p !== rootPath && (!sub || !nodeVisible(p))) return;
          const ta = n.start_us + dt, tb = ta + n.total_us;
          if (tb < r0 || ta > r1) return;                                   // outside the time range
          const f = fnOf(n.fid), bx = tx(Math.max(ta, r0)), w = Math.max(tx(Math.min(tb, r1)) - bx, 2 * k), yc = rowY(ln, n.depth);
          const col = new THREE.Color(f ? modColor(f.module) : cssVar('--muted')), dim = S.block ? !hl(n.fid) : !inFocus(p, n.fid);
          const mat = new THREE.MeshLambertMaterial({ color: col, transparent: true, opacity: dim ? 0.18 : (n.external ? 0.55 : 0.94) });
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, BOX_H, persp ? 0.9 : 0.62), mat);
          m.position.set(bx + w / 2, yc, n.depth * dz); m.userData = { node: n, isr, path: p, lane: ln }; root.add(m); meshes.push(m);
          const eg = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: n.recursive ? critC : (n.via_table ? accentC : (isDark() ? 0xffffff : 0x000000)), transparent: true, opacity: dim ? 0.1 : (n.via_table ? 0.9 : 0.35) }));
          eg.position.copy(m.position); root.add(eg);
          if (S.selPath === p) { mat.emissive = accentC; mat.emissiveIntensity = 0.45; }
          if ((w > labelMinW || S.selPath === p) && !(persp && dim)) {
            const txt = (p === rootPath ? '⚡' : '') + n.name + (p === rootPath && insts.length > 1 ? ` #${inst.k}` : '') + (isExp(p) || !n.children.length ? '' : ' ▸');
            const lb = label(txt, { size: 16, bold: p === rootPath, h: 0.19, opacity: dim ? 0.3 : 1 });
            if (lb.scale.x < w - 0.02 || S.selPath === p) { lb.position.set(bx + 0.02 + lb.scale.x / 2, yc, n.depth * dz + (persp ? 0.47 : 0.33)); root.add(lb); }
          }
          if (!sub) return;
          const focusedNode = !dim, zm = n.depth * dz + (persp ? 0.3 : 0.2), inRange = t => t >= r0 && t <= r1;
          // register accesses: marker on the top edge + connector down to the HW block row
          nodeEvents(n, isr, inst.k).forEach(e => {
            if (!inRange(e.t_us)) return;
            const s = new THREE.Mesh(new THREE.SphereGeometry(e.violation ? 0.075 : 0.055, 10, 8), new THREE.MeshBasicMaterial({ color: e.violation ? critC : (e.kind === 'read' ? readC : writeC), transparent: true, opacity: dim ? 0.3 : 1 }));
            s.position.set(tx(e.t_us), yc + BOX_H / 2 + 0.06, zm); s.userData = { ev: e, node: n, isr, path: p }; root.add(s); meshes.push(s);
            const row = rowOf['block:' + e.block];
            if (connectors && row && (!emphasis || focusedNode)) root.add(line([[tx(e.t_us), yc - BOX_H / 2, zm], [tx(e.t_us), row.yTop, row.z]], e.violation ? critC : (e.kind === 'read' ? readC : writeC), false, emphasis ? 0.85 : 0.16));
          });
          // variable / IPC / heap touches: marker on the bottom edge + connector up to the row
          if (f) {
            const touch = (t, color, key, tipObj) => {
              if (!inRange(t)) return;
              const d = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.07), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: dim ? 0.3 : 1 }));
              d.position.set(tx(t), yc - BOX_H / 2 - 0.05, zm); d.rotation.z = Math.PI / 4; d.userData = Object.assign({ node: n, isr, path: p }, tipObj); root.add(d); meshes.push(d);
              const row = rowOf[key];
              if (connectors && row && (!emphasis || focusedNode)) root.add(line([[tx(t), yc + BOX_H / 2, zm], [tx(t), row.yBot, row.z]], color, false, emphasis ? 0.8 : 0.13));
            };
            f.vars.forEach(v => { const key = VKEY[f.id + '|' + v.name]; if (!key) return; touch(evTimeInFn(n, dt, v.seq), v.rw === 'r' ? readC : (v.rw === 'addr' ? new THREE.Color(mutedC) : writeC), 'var:' + key, { varTip: { name: v.name + (v.member ? '.' + v.member : ''), rw: v.rw, line: v.line, key, via: v.via_macro } }); });
            f.ipc.forEach(i => touch(evTimeInFn(n, dt, i.seq), i.macro === 'IPC_RECV' ? readC : writeC, 'ipc:' + i.channel, { ipcTip: i }));
            f.heap.forEach(h => touch(evTimeInFn(n, dt, h.seq), new THREE.Color(cssVar('--serious')), 'heap', { heapTip: h }));
          }
        });
      }
    }
  }
  const ax = label('time →', { size: 16, color: mutedC, h: 0.2 }); ax.position.set(x1 - ax.scale.x / 2, yTop + 0.42, ZBACK); root.add(ax);
  // canvas height follows the content in the orthographic views (capped; shift+wheel / drag scrolls rows)
  if (ortho()) {
    const hPx = Math.round((ext.vTop - ext.vBot) / k) + 34, newH = Math.max(360, Math.min(2600, hPx)) + 'px';
    if (sceneEl.style.height !== newH) sceneEl.style.height = newH;
  } else if (sceneEl.style.height !== '640px') sceneEl.style.height = '640px';
  sizeCanvas();
  if (!ortho() && !build3D.fitted) { fit(); build3D.fitted = true; }
  updateCamera();
  if (window.ISRPROF_DEBUG) console.log('BUILD', S.view, 'objects', root.children.length, 'pickable', meshes.length, 'k', k, 'SX', SX, 'range', r0, r1, 'canvas', sceneEl.clientWidth, sceneEl.clientHeight, 'ext', JSON.stringify(ext));
  renderLegend(); renderOverview();
}
function renderLegend() {
  const mods = [...new Set(visibleIsrs().flatMap(i => i.functions.map(f => fnOf(f) ? fnOf(f).module : null).filter(Boolean)))];
  document.getElementById('legend').innerHTML =
    mods.map(m => `<span><i style="background:${modColor(m)}"></i>${esc(m)}</span>`).join('') +
    `<span><i style="background:var(--read)"></i>read / recv</span><span><i style="background:var(--write)"></i>write / send</span><span><i style="background:var(--critical)"></i>deadline miss</span>` +
    `<span style="opacity:.8">● on a box top = register access, ◆ below = variable / IPC / heap touch, lines connect them to the HW rows below and SW rows above · rows inside a lane = call depth · ▭ = ISR budget · ┄ = deadline · #k = periodic instance · blue edge = call via function-pointer table</span>`;
}
// overview bar (top overlay): whole window with the current range band; drag to set the range
function renderOverview() {
  const ov = document.getElementById('ovw'); if (!ov) return;
  const Wc = sceneEl.clientWidth, plot = Math.max(Wc - STRIP_L - STRIP_R, 100), X = us => (us - W0) / (W1 - W0) * plot;
  let s = `<svg viewBox="0 0 ${plot} 14" width="${plot}" height="14" preserveAspectRatio="none">`;
  for (let i = Math.ceil(W0 / SYM); i <= Math.floor(W1 / SYM); i++) { const slot = ((i % SPS) + SPS) % SPS === 0; if (!slot && plot / ((W1 - W0) / SYM) < 4) continue; s += `<line x1="${X(i * SYM).toFixed(1)}" x2="${X(i * SYM).toFixed(1)}" y1="${slot ? 0 : 8}" y2="14" stroke="var(--line${slot ? '-strong' : ''})"/>`; }
  s += `<rect x="${X(R0())}" y="0" width="${Math.max(X(R1()) - X(R0()), 2)}" height="14" fill="var(--accent)" opacity=".28"/><rect class="hit" x="0" y="0" width="${plot}" height="14" fill="transparent" style="cursor:crosshair"/></svg>`;
  ov.style.left = STRIP_L + 'px'; ov.style.width = plot + 'px'; ov.innerHTML = s;
  const svg = ov.querySelector('svg'), hit = svg.querySelector('.hit'), toUs = e => { const r = svg.getBoundingClientRect(); return Math.max(W0, Math.min(W1, W0 + (e.clientX - r.left) / r.width * (W1 - W0))); };
  let b = null;
  hit.addEventListener('pointerdown', e => { b = { t0: toUs(e) }; hit.setPointerCapture(e.pointerId); });
  hit.addEventListener('pointerup', e => { if (!b) return; const t1 = toUs(e), s0 = Math.min(b.t0, t1), s1 = Math.max(b.t0, t1); b = null; if (s1 - s0 > (W1 - W0) * 0.004) applyRange({ start: s0, end: s1 }); });
  hit.addEventListener('dblclick', () => applyRange(null));
  ov.title = `window ${fmtAbs(W0)} … ${fmtAbs(W1)} · drag to zoom the diagram into a range, double-click for the full window`;
}
function pickAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? hits[0] : null;
}
function setHover(m) {
  if (hovered && hovered !== m && hovered.userData.node && hovered.material && hovered.material.emissive && !hovered.userData.ev && !hovered.userData.varTip && !hovered.userData.ipcTip && !hovered.userData.heapTip) { if (S.selPath !== hovered.userData.path) { hovered.material.emissive = new THREE.Color(0x000000); hovered.material.emissiveIntensity = 0; } }
  hovered = m;
  if (m && m.userData.node && m.material && m.material.emissive && !m.userData.ev && !m.userData.varTip && !m.userData.ipcTip && !m.userData.heapTip) { m.material.emissive = new THREE.Color(cssVar('--accent')); m.material.emissiveIntensity = 0.35; }
  renderer.domElement.style.cursor = m ? 'pointer' : (ortho() ? 'move' : 'grab'); draw();
}
function markTip(mk) {
  const f = fnOf(mk.fid);
  if (mk.e) return evTip(mk.e);
  const what = mk.name ? `<b>${esc(mk.name)}</b>${mk.rw ? ' [' + mk.rw + ']' : ''}${mk.via ? ` <span class="m">via ${esc(mk.via)}</span>` : ''}` : `<b>${esc(short(mk.fid))}</b>${mk.n > 1 ? ` <span class="m">+${mk.n - 1} more in this bar</span>` : ''}`;
  return `<span class="mono">${what}</span><span class="m">${esc(short(mk.fid))}${f ? ' · ' + esc(f.module) + (mk.line ? ' · line ' + mk.line : '') : ''} · ${esc(mk.isr)} #${mk.k}</span><span class="mono">${mk.t0 === mk.t1 ? 't = ' + fmtAbs(mk.t0) : fmtAbs(mk.t0) + ' → ' + fmtAbs(mk.t1)}</span><span class="m">click to focus the function</span>`;
}
function pick(e) {
  const h = pickAt(e);
  if (!h) { hideTip(); setHover(null); return; }
  const u = h.object.userData;
  setHover(h.object);
  if (u.toggle) showTip(`<span class="m">${esc(u.title)}</span>`, e.clientX, e.clientY);
  else if (u.row) { const mk = u.marks[h.instanceId]; if (mk) showTip(markTip(mk), e.clientX, e.clientY); }
  else if (u.block) showTip(blockTip(BX[u.block]), e.clientX, e.clientY);
  else if (u.ev) showTip(evTip(u.ev), e.clientX, e.clientY);
  else if (u.varTip) showTip(`<span class="mono"><b>${esc(u.varTip.name)}</b> [${u.varTip.rw}] <span class="m">line ${u.varTip.line}${u.varTip.via ? ' · via ' + esc(u.varTip.via) : ''}</span></span><span class="m">${esc(u.node.name)} · ${esc(u.isr.name)}</span>`, e.clientX, e.clientY);
  else if (u.ipcTip) showTip(`<span class="mono"><b>${esc(u.ipcTip.channel)}</b> ${u.ipcTip.macro} <span class="m">line ${u.ipcTip.line}</span></span><span class="m">${esc(u.node.name)} · ${esc(u.isr.name)}</span>`, e.clientX, e.clientY);
  else if (u.heapTip) showTip(`<span class="mono"><b>${esc(u.heapTip.fn)}</b> <span class="m">heap · line ${u.heapTip.line}</span></span><span class="m">${esc(u.node.name)} · ${esc(u.isr.name)}</span>`, e.clientX, e.clientY);
  else showTip(nodeTip(u.node, u.isr, u.path), e.clientX, e.clientY);
}
function click(e) {
  const h = pickAt(e); if (!h) return;
  const u = h.object.userData;
  if (u.toggle) { rowToggle(u.toggle); return; }
  if (u.row) { const mk = u.marks[h.instanceId]; if (mk) { if (mk.path && nodeAt(mk.path)) selectNode(mk.path, mk.fid); else selectNode(null, mk.fid); } return; }
  if (u.block) { selectBlock(u.block); return; }
  if (u.ev || u.varTip || u.ipcTip || u.heapTip) { selectNode(u.path, u.node.fid); return; }
  if (u.node.children.length) toggleExp(u.path);
  selectNode(u.path, u.node.fid);
}
function rowToggle(t) {
  const flip = (set, id) => { if (set.has(id)) set.delete(id); else set.add(id); };
  if (t.kind === 'grp') { if (t.hide) flip(S.stripOpen, t.hide); else flip(S.stripOpen, t.id); build3D(); }
  else if (t.kind === 'module') { flip(S.stripFn, t.id); build3D(); }
  else if (t.kind === 'block') { flip(S.stripReg, t.id); build3D(); }
  else if (t.kind === 'fn') { if (S.selFid === t.id) clearFocus(); else selectNode(null, t.id); }
  else if (t.kind === 'var') { flip(S.stripField, t.id); selectVar(S.stripField.has(t.id) ? t.id : null); }   // list the using functions (+ fields) and show the variable in Details
  else if (t.kind === 'varfn') { if (S.selFid === t.fid) clearFocus(); else selectNode(null, t.fid); }
  else if (t.kind === 'varsall') { S.varsAll = !S.varsAll; build3D(); }
  else if (t.kind === 'ipc' || t.kind === 'heap' || t.kind === 'reg') { /* informational rows */ }
}

// ------------------------------------------------------------------ 2D fallback (no WebGL): same layout, flat SVG
function build2D() {
  let host = sceneEl.querySelector('.nogl');
  if (!host) {
    host = document.createElement('div'); host.className = 'nogl'; sceneEl.insertBefore(host, sceneEl.firstChild);
    sceneEl.querySelector('.axes').hidden = true; sceneEl.querySelector('.views').hidden = true;
    sceneEl.style.height = 'auto';
  }
  const L = computeLayout(), { lanes, groups, height } = L, r0 = R0(), r1 = R1();
  const Wd = Math.max(sceneEl.clientWidth, 480), plot = Wd - STRIP_L - STRIP_R, PXU = ROW_PX * S.tscale / LEVEL_H;
  const X = us => STRIP_L + (us - r0) / (r1 - r0) * plot, Y = yw => 22 + (-yw) * PXU, H = Y(-height) + 16;
  let s = `<p style="margin:0 0 4px;color:var(--muted);font-size:11.5px">WebGL is unavailable: flat timing diagram (x = time; rows = SW structure touch / call depth per lane / HW blocks).</p><svg viewBox="0 0 ${Wd} ${H}" width="${Wd}" height="${H}" style="font-family:var(--mono);font-size:10px">`;
  for (let i = Math.ceil(r0 / SYM); i <= Math.floor(r1 / SYM); i++) { const slot = ((i % SPS) + SPS) % SPS === 0; if (!slot && plot / ((r1 - r0) / SYM) < 4) continue; const x = X(i * SYM); s += `<line x1="${x}" x2="${x}" y1="14" y2="${H - 10}" stroke="var(--line${slot ? '-strong' : ''})"/>${slot ? `<text x="${x + 2}" y="11" fill="var(--fg)" font-weight="600">s${i / SPS}</text>` : ''}`; }
  const rows2d = rows => rows.forEach(r => {
    if (r.group) { s += `<rect x="0" y="${Y(r.yTop)}" width="${Wd}" height="${r.h * PXU}" fill="var(--panel-2)"/><text class="lbl" x="6" y="${Y(r.y) + 4}" font-weight="600" data-grp="${esc(r.group)}" style="cursor:pointer">${r.open ? '▾' : '▸'} ${esc(r.label)}</text>`; return; }
    s += `<text x="${8 + r.depth * 12}" y="${Y(r.y) + 4}" opacity="${r.dim ? .4 : 1}">${esc(r.label)}</text>`;
    (r.deadlines || []).forEach(d => { s += `<line x1="${X(d.t)}" x2="${X(d.t)}" y1="${Y(r.yTop)}" y2="${Y(r.yBot)}" stroke="var(--critical)" opacity=".5"/>`; });
    (r.tick ? (r.marks || []) : mergeMarks((r.marks || []).slice())).forEach(m => { const x = X(m.t0), w = r.tick ? 2 : Math.max(X(m.t1) - x, 1.5); s += `<rect x="${x}" y="${Y(r.yTop) + 3}" width="${w}" height="${r.h * PXU - 6}" fill="${m.c}" opacity="${m.foc ? .95 : .2}"/>`; });
  });
  rows2d(L.top);
  for (const g of groups) s += `<text x="4" y="${Y(g.yTop) + 11}" fill="${coreColor(g.core.id)}" font-weight="600">${esc(g.core.name)}</text>`;
  for (const ln of lanes) {
    s += `<rect x="${STRIP_L}" y="${Y(ln.yTop)}" width="${plot}" height="${ln.h * PXU}" fill="${coreColor(ln.core.id)}" opacity=".08"/><text x="${STRIP_L - 6}" y="${Y(ln.y) + 4}" text-anchor="end">${esc(ln.timing.name)}</text>`;
    for (const isr of ln.isrs) for (const inst of instancesOf(isr)) {
      if (inst.start > r1 || inst.start + Math.max(isr.computed_us, isr.length_us || 0) < r0) continue;
      const dt = inst.k * (isr.period_us || 0), sub = showSub(isr, inst.k), rootPath = isr.name + '#' + inst.k;
      walk(isr.tree, rootPath, (n, p) => {
        if (p !== rootPath && (!sub || !nodeVisible(p))) return;
        const f = fnOf(n.fid), bx = X(n.start_us + dt), bw = Math.max(X(n.start_us + dt + n.total_us) - bx, 1.5), by = Y(rowY(ln, n.depth) + BOX_H / 2), bh = BOX_H * PXU, dim = S.block ? !hl(n.fid) : !inFocus(p, n.fid);
        s += `<g class="n2d" data-path="${esc(p)}" style="cursor:pointer"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${f ? modColor(f.module) : 'var(--muted)'}" stroke="var(--fg)" stroke-opacity=".4" opacity="${dim ? .25 : .9}"/>${bw > 40 ? `<text x="${bx + 3}" y="${by + bh - 3}" fill="#fff">${esc(n.name)}</text>` : ''}</g>`;
        if (sub) nodeEvents(n, isr, inst.k).forEach(e => { s += `<circle cx="${X(e.t_us)}" cy="${by - 3}" r="2.5" fill="${e.violation ? 'var(--critical)' : e.kind === 'read' ? 'var(--read)' : 'var(--write)'}"/>`; });
      });
    }
  }
  rows2d(L.bottom);
  s += '</svg>';
  host.innerHTML = s;
  host.querySelectorAll('.n2d').forEach(g => g.addEventListener('click', () => { const p = g.dataset.path, n = nodeAt(p); if (n && n.children.length) toggleExp(p); selectNode(p, n && n.fid); }));
  host.querySelectorAll('[data-grp]').forEach(t => t.addEventListener('click', () => rowToggle({ kind: 'grp', id: t.dataset.grp, hide: t.dataset.grp.startsWith('line:') ? 'hide:' + t.dataset.grp.slice(5) : null })));
  renderLegend(); renderOverview();
}
