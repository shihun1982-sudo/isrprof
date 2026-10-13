// ================================================================== 3D timing diagram (three.js)
// World axes: x = time (NW frame, -> later), y = rows (down), z = core plane (toward the viewer = core 0).
//   tilt view     orthographic front camera; every core plane is shifted right by tilt_dx_px per core and
//                 drawn a little behind the previous one, so the cores read as the diagonal axis while
//                 time stays pixel-aligned inside each plane
//   aligned view  the same without the shift (every core shares one time axis)
//   3D view       perspective, free rotation; the planes are stacked in real depth
// A plane holds a header, one row per ISR (rows inside = call depth, icicle style), ISR budget envelopes,
// register-access markers (●) on top of the boxes, shared-memory / IPC / heap touches (◆) below them and
// deadline ticks.  The ruler on top carries the NW slot / symbol grid and the 3GPP channel allocation.
// Everything is batched: one InstancedMesh per mark type, merged line segments per style, label sprites
// with cached textures — a selection change only recolours instances (recolor3D), no rebuild.
const STRIP_L = Math.max(80, +(V.label_margin_px || 200)), STRIP_R = 12;
const ROW_PX = Math.max(6, +(V.row_px || 15));
const TILT_DX_PX = +(V.tilt_dx_px == null ? 36 : V.tilt_dx_px);
const CH_ROW_PX = Math.max(6, +((V.channels || {}).row_px || 12));
const MAX_BOXES = Math.max(1000, +(V.max_boxes || 40000)), MAX_LABELS = Math.max(50, +(V.max_labels || 700));
// type scale (px): slot labels, symbol numbers, channel names, core header, ISR name, ISR sub line, box labels,
// deadline ticks, reference lines, axis captions - converted to world units per build with fh()
const FS = { slot: 12, sym: 10, ch: 10, plane: 13, isr: 12, sub: 10, box: 11, dl: 10, ref: 10, axis: 10 };
const LEVEL_H = 0.3, BOX_H = 0.24, LANE_PAD = 0.07, ISR_GAP = 0.04, PLANE_HDR = 0.3, PLANE_GAP = 0.3, RULER_GAP = 0.9, ZBACK = -0.7;
let SX = 0.5;                                      // world units per symbol (set per build)
const ortho = () => S.view !== 'persp';
const PLANE_DZ = () => (S.view === 'persp' ? 4.0 : 1.3);   // z step per core plane: a plane's backing plate (dz + ZBACK) must sit in front of the previous plane's boxes and labels   // z step per core plane: higher cores sit in front of the previous ones

// ------------------------------------------------------------------ layout
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
function channelRows() {               // one row per channel name (PDSCH / PDSCH_S share a row)
  if (!(V.channels || {}).show === false && !CH.items.length) return [];
  const rows = [], idx = {};
  CH.items.forEach(c => { const nm = c.name || c.id; if (idx[nm] == null) { idx[nm] = rows.length; rows.push({ name: nm, items: [], dir: c.dir }); } rows[idx[nm]].items.push(c); });
  return rows;
}
function slotType(s) { const p = CH.tdd_pattern || ''; if (!p) return 'F'; const i = ((s % p.length) + p.length) % p.length; return p[i].toUpperCase(); }
function channelActive(c, s) {
  const t = slotType(s), sl = c.slots;
  if (Array.isArray(sl)) { const base = c.period_slots ? (((s - c.offset_slot) % c.period_slots) + c.period_slots) % c.period_slots : s; return sl.includes(base) && (!c.period_slots || s >= c.offset_slot - 1e9); }
  if (c.period_slots && (((s - c.offset_slot) % c.period_slots) + c.period_slots) % c.period_slots !== 0) return false;
  if (sl === 'all') return true;
  if (sl === 'dl') return t === 'D' || t === 'F';
  if (sl === 'ul') return t === 'U' || t === 'F';
  if (sl === 'special') return t === 'S';
  return false;
}
function computeLayout(k) {
  const chRows = channelRows(), chH = CH_ROW_PX * k;
  let y = 0;
  const ruler = { yTop: 0.34, chTop: 0, chH, rows: chRows, yBot: -chRows.length * chH };
  y = ruler.yBot - RULER_GAP;
  const planes = [];
  const stacked = S.view === 'tilt', persp = S.view === 'persp', ov = stacked ? S.overlap : 0;
  let idx = 0, prevH = 0, yStart = y, yMin = y;
  for (const c of CORES) {
    if (!S.cores.has(c.id)) continue;
    const isrs = visibleIsrs().filter(i => i.core === c.id).sort((a, b) => (TIX[a.timing].priority - TIX[b.timing].priority) || (a.abs_start_us - b.abs_start_us));
    // stacked: this plane starts inside the previous one (covering its lower part), like a deck of cards;
    // 3D: every plane starts at the same place and the cores only differ in depth
    if (idx > 0) y = persp ? yStart : y + ov * prevH;
    const pl = { core: c, k: idx, isrs, rows: [], yTop: y, dx: 0, dz: 0 };
    y -= PLANE_HDR;
    for (const isr of isrs) {
      const vis = visibleNodes(isr), md = vis.length ? Math.max(...vis.map(r => r.depth)) : 0;
      const h = LANE_PAD * 2 + LEVEL_H * (md + 1);
      pl.rows.push({ isr, yTop: y, yBot: y - h, y: y - h / 2, maxDepth: md, h });
      y -= h + ISR_GAP;
    }
    if (!isrs.length) y -= LANE_PAD * 2;
    pl.yBot = y;
    prevH = pl.yTop - pl.yBot;
    y -= PLANE_GAP;
    yMin = Math.min(yMin, y);
    planes.push(pl); idx++;
  }
  if (persp) y = yMin;
  const dxw = stacked ? TILT_DX_PX * k : 0;
  planes.forEach(p => { p.dx = dxw * p.k; p.dz = p.k * PLANE_DZ(); });      // core 0 at the back, every next core closer to the viewer
  return { ruler, planes, height: -y, maxDx: dxw * Math.max(0, planes.length - 1), stacked };
}
const rowY = (row, depth) => row.yTop - LANE_PAD - LEVEL_H * depth - LEVEL_H / 2;

// ------------------------------------------------------------------ renderer / cameras / interaction
const sceneEl = document.getElementById('scene');
let renderer = null, scene, camera, camP, camO, root, pick3 = [], raycaster, pointer = null, hovered = null, have3D = false;
const cam = { theta: 0.35, phi: 1.25, radius: 20, target: null };
const ext = { x0: 0, x1: 1, yTop: 0.6, yBot: -5, vTop: 0.6, vBot: -5, k: 0.02, yShift: 0 };
const G = { boxes: null, env: null, ev: null, touch: null, ch: null, recs: [], evRecs: [], touchRecs: [], chRecs: [], selOutline: null, hovOutline: null, colors: null, labels: new Map() };
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
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const d = new THREE.DirectionalLight(0xffffff, 0.45); d.position.set(4, 6, 10); scene.add(d);
  root = new THREE.Group(); scene.add(root);
  raycaster = new THREE.Raycaster(); pointer = new THREE.Vector2(); cam.target = new THREE.Vector3();
  let drag = null, wheelT = null, pendingRange = null;
  const el = renderer.domElement;
  const pxToUs = px => R0() + (px - STRIP_L) * ext.k / SX * SYM;
  el.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey, moved: false, dx: 0 }; try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ } });
  el.addEventListener('pointermove', e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.dx += dx;
      if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
      if (ortho()) { root.position.x += dx * ext.k; ext.yShift += dy * ext.k; updateCamera(); return; }
      if (drag.b === 2 || drag.shift || S.panMode) pan(dx, dy); else { cam.theta -= dx * 0.006; cam.phi = Math.max(0.05, Math.min(Math.PI - 0.05, cam.phi - dy * 0.006)); }
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
  el.addEventListener('dblclick', e => { const h = pickAt(e); if (h && !ortho()) { cam.target.copy(h.point); cam.radius = Math.min(cam.radius, 12); updateCamera(); } });
  sceneEl.querySelectorAll('.views button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  // arrow keys move the view while the pointer is over the diagram (shift = bigger steps)
  document.addEventListener('keydown', e => {
    if (!sceneEl.matches(':hover') || e.target.closest('input, select, textarea')) return;
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (map[e.key]) { e.preventDefault(); nudge(map[e.key], e.shiftKey ? 3 : 1); }
  });
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
    const k = ext.k, W = Wc * k, H = Hc * k;
    if (!isFinite(ext.vTop) || !isFinite(ext.vBot)) { ext.vTop = ext.yTop; ext.vBot = ext.yBot; }
    const contentH = ext.vTop - ext.vBot;
    if (!isFinite(ext.yShift)) ext.yShift = 0;
    ext.yShift = Math.max(Math.min(ext.yShift, 0), Math.min(0, H - contentH));   // clamp the vertical scroll
    const cx = ext.x0 - STRIP_L * k + W / 2, topV = ext.vTop + ext.yShift;
    camO.left = -W / 2; camO.right = W / 2; camO.top = topV; camO.bottom = topV - H;
    camO.up.set(0, 1, 0); camO.position.set(cx, 0, 300); camO.lookAt(cx, 0, 0); camO.updateProjectionMatrix();
  } else {
    camera = camP; camP.aspect = Wc / Hc; camP.updateProjectionMatrix();
    const sp = Math.sin(cam.phi);
    camP.position.set(cam.target.x + cam.radius * sp * Math.sin(cam.theta), cam.target.y + cam.radius * Math.cos(cam.phi), cam.target.z + cam.radius * sp * Math.cos(cam.theta));
    camP.lookAt(cam.target);
  }
  draw();
}
// move the view by a fraction of the screen: time range / row scroll in the orthographic views, camera pan in 3D
function nudge(dir, mult) {
  mult = mult || 1;
  if (ortho()) {
    if (dir === 'left' || dir === 'right') { const d = (R1() - R0()) * 0.25 * mult; shiftRange(dir === 'left' ? -d : d); }
    else { ext.yShift += (dir === 'up' ? 1 : -1) * 120 * mult * ext.k; updateCamera(); }
    return;
  }
  const px = 140 * mult;
  if (dir === 'left') pan(px, 0); else if (dir === 'right') pan(-px, 0); else if (dir === 'up') pan(0, px); else pan(0, -px);
  updateCamera();
}
function setView(v) {
  if (!have3D) return;
  if (v === 'pan') { S.panMode = !S.panMode; markViews(); renderer.domElement.style.cursor = ortho() ? 'move' : (S.panMode ? 'move' : 'grab'); return; }
  if (v === 'left' || v === 'right' || v === 'up' || v === 'down') { nudge(v); return; }
  if (v === 'zin' || v === 'zout') {
    if (ortho()) { const span = R1() - R0(), ns = Math.max(SYM, Math.min(W1 - W0, span * (v === 'zin' ? 0.7 : 1.4))), mid = (R0() + R1()) / 2; const s = Math.max(W0, Math.min(W1 - ns, mid - ns / 2)); applyRange(ns >= (W1 - W0) - 1e-6 ? null : { start: s, end: s + ns }); }
    else { cam.radius = Math.max(1, Math.min(800, cam.radius * (v === 'zin' ? 0.8 : 1.25))); updateCamera(); }
    return;
  }
  if (v === 'aligned' || v === 'tilt') { S.view = v; ext.yShift = 0; markViews(); build3D(); return; }
  S.view = 'persp';
  if (v === 'iso') { cam.theta = 0.45; cam.phi = 1.2; }
  else if (v === 'front') { cam.theta = 0; cam.phi = Math.PI / 2 - 0.02; }
  else if (v === 'side') { cam.theta = Math.PI / 2 - 0.05; cam.phi = Math.PI / 2 - 0.05; }
  else if (v === 'top') { cam.theta = 0; cam.phi = 0.08; }
  const tv = performance.now(); markViews(); build3D(); const tb = performance.now(); fit(); const tf = performance.now(); updateCamera();
  if (build3D.stats) build3D.stats.view = { build: Math.round(tb - tv), fit: Math.round(tf - tb), camera: Math.round(performance.now() - tf) };
}
function markViews() {
  const active = S.view === 'persp' ? 'iso' : S.view;
  sceneEl.querySelectorAll('.views button').forEach(b => { if (['aligned', 'tilt', 'iso'].includes(b.dataset.view)) b.setAttribute('aria-pressed', b.dataset.view === active); if (b.dataset.view === 'pan') { b.setAttribute('aria-pressed', !!S.panMode); b.hidden = S.view !== 'persp'; } });
}
function fit() {                 // perspective framing: the focused boxes when there are some, otherwise everything
  if (ortho()) return;
  const box = new THREE.Box3();
  const focus = (S.selFid || S.swNode) ? G.recs.filter(r => r.foc) : [];
  if (focus.length) { focus.forEach(r => box.expandByPoint(new THREE.Vector3(r.x, r.y, r.z)).expandByPoint(new THREE.Vector3(r.x + r.w, r.y, r.z))); box.expandByScalar(0.8); }
  else box.set(new THREE.Vector3(ext.x0, ext.yBot, -0.5), new THREE.Vector3(ext.x1, ext.yTop, PLANE_DZ() * CORES.length + 0.5));
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  cam.target.copy(c);
  const fov = camP.fov * Math.PI / 180, h = Math.max(size.y, size.x / camP.aspect) / 2;
  cam.radius = Math.max(4, h / Math.tan(fov / 2) * 1.15 + size.z * 0.6);
}
function sizeCanvas() { renderer.setSize(sceneEl.clientWidth, sceneEl.clientHeight); }
function resize3D() { if (!have3D) return; sizeCanvas(); updateCamera(); }
let _drawReq = false;
function draw() { if (!have3D || _drawReq) return; _drawReq = true; requestAnimationFrame(() => { _drawReq = false; renderer.render(scene, camera); }); }
// text sprite with a cached texture (text + style); opt.h is the final height in world units
function label(text, opt) {
  opt = opt || {};
  const h = opt.h || 0.24, px = Math.max(10, Math.round(h / ext.k)), key = `${text}|${px}|${opt.bold ? 1 : 0}|${opt.color || ''}|${opt.bg || ''}`;
  let ent = G.labels.get(key);
  if (!ent) {
    const size = px * 2, c = document.createElement('canvas'), ctx = c.getContext('2d');
    const font = `${opt.bold ? '600' : '400'} ${size}px "IBM Plex Mono", Consolas, monospace`;
    ctx.font = font; const w = Math.ceil(ctx.measureText(text).width) + 12;
    c.width = w; c.height = Math.round(size * 1.3); ctx.font = font;
    if (opt.bg) { ctx.fillStyle = opt.bg; ctx.fillRect(0, 0, w, c.height); }
    ctx.fillStyle = opt.color || cssVar('--fg'); ctx.textBaseline = 'middle'; ctx.fillText(text, 6, c.height / 2);
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter;
    ent = { tex, w, ch: c.height };
    if (G.labels.size > 3000) { G.labels.forEach(e => e.tex.dispose()); G.labels.clear(); }
    G.labels.set(key, ent);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ent.tex, transparent: true, depthTest: S.view !== 'aligned', opacity: opt.opacity == null ? 1 : opt.opacity }));
  const hh = h * 1.3; s.scale.set(hh * ent.w / ent.ch, hh, 1); s.renderOrder = 10; return s;
}
function clearGroup(g) { while (g.children.length) { const o = g.children.pop(); g.remove(o); if (o.geometry) o.geometry.dispose(); if (o.material && !o.isSprite) o.material.dispose(); if (o.isSprite) o.material.dispose(); } }
function segs(points, color, opts) {          // merged line segments: points = flat [x,y,z, x,y,z, ...] pairs
  if (!points.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const o = opts || {};
  const m = o.dashed ? new THREE.LineDashedMaterial({ color, dashSize: o.dash || 0.09, gapSize: o.gap || 0.06, transparent: true, opacity: o.opacity == null ? 1 : o.opacity })
                     : new THREE.LineBasicMaterial({ color, transparent: true, opacity: o.opacity == null ? 1 : o.opacity });
  const l = new THREE.LineSegments(g, m); if (o.dashed) l.computeLineDistances(); return l;
}
// slot boundaries drawn as thin bars (WebGL lines are always 1 px): xs = world x positions, widthPx in pixels
function bars(xs, y0, y1, z, color, opacity, widthPx, k) {
  if (!xs.length) return null;
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 0.01), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }), xs.length);
  const mat = new THREE.Matrix4(), w = widthPx * k;
  xs.forEach((x, i) => { mat.makeScale(w, Math.abs(y1 - y0), 1); mat.setPosition(x, (y0 + y1) / 2, z); m.setMatrixAt(i, mat); });
  m.instanceMatrix.needsUpdate = true; m.frustumCulled = false; return m;
}
// faint band over every other slot so the slot rhythm is visible even when the symbol grid is dense
function slotBands(tx, x0, x1, y0, y1, z, color, slotA, slotB, dx) {
  const xs = [], ws = [];
  for (let sIdx = slotA - 1; sIdx <= slotB; sIdx++) { if (((sIdx % 2) + 2) % 2 !== 1) continue; const a = Math.max(tx(sIdx * SLOT), x0), b = Math.min(tx((sIdx + 1) * SLOT), x1); if (b <= a) continue; xs.push((a + b) / 2 + dx); ws.push(b - a); }
  if (!xs.length) return null;
  const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.045, depthWrite: false }), xs.length);
  const mat = new THREE.Matrix4();
  xs.forEach((x, i) => { mat.makeScale(ws[i], Math.abs(y1 - y0), 1); mat.setPosition(x, (y0 + y1) / 2, z); m.setMatrixAt(i, mat); });
  m.instanceMatrix.needsUpdate = true; m.frustumCulled = false; return m;
}
function instanced(geo, n, opts) {
  const mat = opts.lambert ? new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: !!opts.opacity, opacity: opts.opacity || 1, depthWrite: !opts.opacity })
                           : new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: !!opts.opacity, opacity: opts.opacity || 1, depthWrite: !opts.opacity });
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n)); m.count = n; m.frustumCulled = false; return m;
}

// ------------------------------------------------------------------ build
function build3D() {
  if (!have3D) { build2D(); return; }
  const t0 = performance.now();
  clearGroup(root); pick3 = []; hovered = null; root.position.x = 0;
  const Wc = Math.max(sceneEl.clientWidth, 400), plotPx = Math.max(Wc - STRIP_L - STRIP_R, 200);
  ext.k = LEVEL_H / (ROW_PX * S.tscale);
  const k = ext.k, L = computeLayout(k), { ruler, planes, height } = L, tm = { layout: Math.round(performance.now() - t0) };
  const fh = px => px * k;                            // font height in world units for a pixel size
  const r0 = R0(), r1 = R1(), nSym = Math.max((r1 - r0) / SYM, 0.5);
  SX = (plotPx - L.maxDx / k) * k / nSym;              // the time range fills the plot width (minus the diagonal shift)
  const tx = us => (us - r0) / SYM * SX;
  const x0 = 0, x1 = tx(r1), yTop = ruler.yTop, yBot = -height - 0.2;
  Object.assign(ext, { x0, x1, yTop: yTop + 0.3 + 24 * k, yBot: yBot - 0.3, vTop: yTop + 0.3 + 24 * k, vBot: yBot - 0.3 });
  const panelC = new THREE.Color(cssVar('--panel')), panel2C = new THREE.Color(cssVar('--panel-2')), lineC = new THREE.Color(cssVar('--line-strong')), gridC = new THREE.Color(cssVar('--line')), fg = new THREE.Color(cssVar('--fg'));
  const critC = new THREE.Color(cssVar('--critical')), readC = new THREE.Color(cssVar('--read')), writeC = new THREE.Color(cssVar('--write')), accentC = new THREE.Color(cssVar('--accent')), mutedC = cssVar('--muted'), seriousC = new THREE.Color(cssVar('--serious'));
  const persp = S.view === 'persp', dzStep = persp ? 0.35 : 0.02;
  const pxPerSym = SX / k, symLines = pxPerSym >= 4, symLabels = pxPerSym >= 34, labelMinW = 40 * k;
  const emphasis = !!(REL || S.block);
  if (V.legend === false) document.getElementById('legend').hidden = true;
  const slotA = Math.ceil(r0 / SLOT - 1e-9), slotB = Math.floor(r1 / SLOT + 1e-9);

  // --- ruler: slot / symbol labels + channel allocation band (drawn at plane 0's offset)
  const gridStrong = [], gridWeak = [], slotXs = [];
  for (let i = Math.ceil(r0 / SYM - 1e-9); i <= Math.floor(r1 / SYM + 1e-9); i++) {
    const isSlot = ((i % SPS) + SPS) % SPS === 0; if (!isSlot && !symLines) continue;
    const x = tx(i * SYM);
    if (isSlot) slotXs.push(x); else gridWeak.push(x, ruler.yBot, ZBACK, x, ruler.yTop, ZBACK);
    if (isSlot || symLabels) {
      const txt = isSlot ? `s${i / SPS}${i === 0 ? ' (NW)' : ''}${isSlot && CH.tdd_pattern ? ' ' + slotType(i / SPS) : ''}` : `${((i % SPS) + SPS) % SPS}`;
      const lb = label(txt, { color: isSlot ? cssVar('--fg') : mutedC, h: fh(isSlot ? FS.slot : FS.sym), bold: isSlot });
      lb.position.set(x + lb.scale.x / 2 + 0.03, ruler.yTop + 0.14, ZBACK); root.add(lb);
    }
  }
  const chRecs = [];
  ruler.rows.forEach((row, ri) => {
    const yc = ruler.chTop - ri * ruler.chH - ruler.chH / 2;
    const lb = label(row.name, { h: Math.min(fh(FS.ch), ruler.chH * 0.8), color: chColor(row.items[0]), bold: true });
    lb.position.set(x0 - 0.1 - lb.scale.x / 2, yc, 0.3); root.add(lb);
    gridWeak.push(x0, yc - ruler.chH / 2, ZBACK, x1, yc - ruler.chH / 2, ZBACK);
    for (let s = slotA - 1; s <= slotB; s++) row.items.forEach(c => {
      if (!channelActive(c, s)) return;
      const ta = s * SLOT + c.sym_start * SYM, tb = ta + c.sym_len * SYM;
      if (tb < r0 || ta > r1) return;
      chRecs.push({ c, s, x: tx(Math.max(ta, r0)), w: Math.max(tx(Math.min(tb, r1)) - tx(Math.max(ta, r0)), 2 * k), y: yc, h: ruler.chH * 0.72, ta, tb });
    });
  });
  if (chRecs.length) {
    const m = instanced(new THREE.BoxGeometry(1, 1, 0.12), chRecs.length, { opacity: 0.85 });
    const mat = new THREE.Matrix4(), col = new THREE.Color();
    chRecs.forEach((r, i) => { mat.makeScale(r.w, r.h, 1); mat.setPosition(r.x + r.w / 2, r.y, ZBACK + 0.05); m.setMatrixAt(i, mat); col.set(chColor(r.c)); m.setColorAt(i, col); });
    m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; m.userData = { kind: 'ch' }; root.add(m); pick3.push(m); G.ch = m; G.chRecs = chRecs;
    chRecs.forEach(r => { if (r.w > labelMinW * 1.4 && pxPerSym >= 10) { const lb = label(r.c.name || r.c.id, { h: Math.min(fh(FS.ch), ruler.chH * 0.7), color: '#ffffff' }); if (lb.scale.x < r.w - 0.02) { lb.position.set(r.x + 0.02 + lb.scale.x / 2, r.y, ZBACK + 0.2); root.add(lb); } } });
  }
  const refIds = TI.filter(t => t.id !== 'nw' && !S.refHidden.has(t.id));
  const refColor = t => t.color || cat(TIX[t.id].idx + 2);
  // reference lines on the NW ruler: from the slot-label row through the channel band to the first core plane,
  // labelled once (name + offset vs NW) at their first occurrence - the per-plane lines continue them below
  {
    const continuous = S.view === 'aligned';     // no per-plane shift: one unbroken line down to the last plane
    const refTop = ruler.yTop + 0.3, refBot = !planes.length ? ruler.yBot - RULER_GAP : (continuous ? planes[planes.length - 1].yBot : planes[0].yTop + 0.02);
    const usedAll = new Set(visibleIsrs().map(i => i.timing)), hwLines = new Set(BLOCKS.map(b => b.line));
    const strongOf = t => usedAll.has(t.id) || hwLines.has(t.id);
    refIds.forEach(t => {
      const pts = [];
      for (let s = slotA - 1; s <= slotB; s++) { const x = tx(s * SLOT + t.offset_us); if (x < -1e-6 || x > x1 + 1e-6) continue; pts.push(x, refBot, ZBACK + 0.01, x, refTop, ZBACK + 0.01); }
      const l = segs(pts, new THREE.Color(refColor(t)), { dashed: true, dash: 0.05, gap: 0.045, opacity: strongOf(t) ? 0.6 : 0.2 }); if (l) root.add(l);
    });
    // one label per distinct offset (lines that share an offset share the label), staggered over three rows
    const groups = new Map();
    refIds.filter(strongOf).forEach(t => { const key = t.offset_us.toFixed(3); const g = groups.get(key) || { off: t.offset_us, names: [], t }; g.names.push(t.name); groups.set(key, g); });
    [...groups.values()].sort((a, b) => a.off - b.off).forEach((g, gi) => {
      let first = null; for (let s = slotA - 1; s <= slotB; s++) { const x = tx(s * SLOT + g.off); if (x >= -1e-6 && x <= x1 + 1e-6) { first = x; break; } }
      if (first == null) return;
      const lb = label(`${g.names.join(' / ')} ${g.off >= 0 ? '+' : ''}${(g.off / SYM).toFixed(2)}`, { h: fh(FS.ref), color: refColor(g.t) });
      lb.position.set(first + lb.scale.x / 2 + 0.02, ruler.yBot - 0.08 - (gi % 3) * fh(FS.ref) * 1.3 - fh(FS.ref) * 0.6, 0.3); root.add(lb);
    });
  }

  // --- planes: one per core
  const recs = [], evRecs = [], touchRecs = [], envRecs = [], dlPts = [], labelCands = [];
  let boxBudget = MAX_BOXES, lod = false;
  // LOD estimate: boxes if every instance drew its visible subtree
  const est = planes.reduce((a, p) => a + p.rows.reduce((b, row) => b + instancesOf(row.isr).length * visibleNodes(row.isr).length, 0), 0);
  if (est > MAX_BOXES) lod = true;
  const nRows = planes.reduce((a, p) => a + p.rows.length, 0), manyRows = nRows > 150, labelCap = manyRows ? Math.min(MAX_LABELS, 300) : MAX_LABELS;
  for (const pl of planes) {
    const dx = pl.dx, dz = pl.dz, cC = new THREE.Color(coreColor(pl.core.id));
    const px0 = x0 + dx, px1 = x1 + dx;
    // plane plate + header
    if (L.stacked || persp) {       // opaque backing so a plane in front really covers the one behind it
      const back = new THREE.Mesh(new THREE.PlaneGeometry(px1 - px0 + STRIP_L * k, pl.yTop - pl.yBot), new THREE.MeshBasicMaterial({ color: panelC }));
      back.position.set((px0 + px1) / 2 - STRIP_L * k / 2, (pl.yTop + pl.yBot) / 2, dz + ZBACK - 0.03); root.add(back);
      const rim = new THREE.LineSegments(new THREE.EdgesGeometry(back.geometry), new THREE.LineBasicMaterial({ color: lineC, transparent: true, opacity: 0.9 })); rim.position.copy(back.position); rim.position.z += 0.005; root.add(rim);
    }
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(px1 - px0 + STRIP_L * k, pl.yTop - pl.yBot), new THREE.MeshBasicMaterial({ color: cC, transparent: true, opacity: 0.07, depthWrite: false }));
    plate.position.set((px0 + px1) / 2 - STRIP_L * k / 2, (pl.yTop + pl.yBot) / 2, dz + ZBACK - 0.02); root.add(plate);
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.05, pl.yTop - pl.yBot), new THREE.MeshBasicMaterial({ color: cC })); edge.position.set(px0 - STRIP_L * k, (pl.yTop + pl.yBot) / 2, dz + 0.1); root.add(edge);
    const hdr = label(`${pl.core.name} · ${pl.core.clock_mhz} MHz`, { bold: true, h: fh(FS.plane), color: coreColor(pl.core.id) }); hdr.position.set(px0 - STRIP_L * k + 0.1 + hdr.scale.x / 2, pl.yTop - PLANE_HDR / 2, dz + 0.3); hdr.userData = { core: pl.core.id, title: pl.core.description || pl.core.name }; root.add(hdr); pick3.push(hdr);
    // grid per plane
    const gS = [], gW = [], pSlotXs = [];
    for (let i = Math.ceil(r0 / SYM - 1e-9); i <= Math.floor(r1 / SYM + 1e-9); i++) {
      const isSlot = ((i % SPS) + SPS) % SPS === 0; if (!isSlot && !symLines) continue;
      const x = tx(i * SYM) + dx; if (isSlot) pSlotXs.push(x); else gW.push(x, pl.yBot, dz + ZBACK, x, pl.yTop, dz + ZBACK);
    }
    { const sb = bars(pSlotXs, pl.yBot, pl.yTop, dz + ZBACK + 0.005, fg, 0.45, 2, k); if (sb) root.add(sb); const bd = slotBands(tx, x0, x1, pl.yBot, pl.yTop, dz + ZBACK - 0.01, fg, slotA, slotB, dx); if (bd) root.add(bd); }
    const gw = segs(gW, gridC, { opacity: 0.18 }); if (gw) root.add(gw);
    // reference lines (dashed) repeated per slot; the ones used by this plane's ISRs are stronger
    const used = new Set(pl.isrs.map(i => i.timing));
    if (S.view !== 'aligned') refIds.forEach(t => {        // per plane (planes are shifted / in depth): through the plane and the gap under it, so the line never breaks
      const yEnd = pl.k < planes.length - 1 ? Math.min(pl.yBot, planes[pl.k + 1].yTop) - 0.02 : pl.yBot;
      const pts = []; for (let s = slotA - 1; s <= slotB; s++) { const x = tx(s * SLOT + t.offset_us); if (x < -1e-6 || x > x1 + 1e-6) continue; pts.push(x + dx, yEnd, dz + ZBACK + 0.01, x + dx, pl.yTop, dz + ZBACK + 0.01); }
      const l = segs(pts, new THREE.Color(refColor(t)), { dashed: true, dash: 0.05, gap: 0.045, opacity: used.has(t.id) ? 0.5 : 0.14 }); if (l) root.add(l);
    });
    for (const row of pl.rows) {
      const isr = row.isr, ref = TIX[isr.timing], coreC = new THREE.Color(coreColor(isr.core));
      gW.length = 0;
      root.add(segs([px0, row.yBot, dz + ZBACK, px1, row.yBot, dz + ZBACK], gridC, { opacity: 0.45 }));
      const twoLines = row.h >= fh(FS.isr + FS.sub) * 1.45 && !manyRows;
      const t1 = label(isr.name, { bold: true, h: fh(FS.isr), color: (S.selPath && isrOfPath(S.selPath) === isr) ? cssVar('--accent') : cssVar('--fg') });
      t1.position.set(px0 - 0.1 - t1.scale.x / 2, twoLines ? row.y + fh(FS.sub) * 0.65 : row.y, dz + 0.3); t1.userData = { isrRow: isr, title: `${isr.name}: ${ref.name} +${(isr.start_us / SYM).toFixed(2)} sym · ${isr.length_us ? (isr.length_us / SYM).toFixed(2) + ' sym budget' : 'no budget'}${isr.period_us ? ' · every ' + fmt(isr.period_us) : ''} · click to focus the ISR` }; root.add(t1); pick3.push(t1);
      if (twoLines) {
        const t2 = label(`${ref.name} +${(isr.start_us / SYM).toFixed(2)} · ${isr.length_us ? (isr.length_us / SYM).toFixed(2) + ' sym' : 'no budget'}${isr.period_us ? ' · /' + fmt(isr.period_us).replace(' ', '') : ''}`, { h: fh(FS.sub), color: mutedC });
        if (t2.scale.x > STRIP_L * k - 0.3) t2.scale.multiplyScalar((STRIP_L * k - 0.3) / t2.scale.x);
        t2.position.set(px0 - 0.1 - t2.scale.x / 2, row.y - fh(FS.isr) * 0.7, dz + 0.3); root.add(t2);
      }
      const span = Math.max(isr.computed_us, isr.length_us || 0);
      const insts = instancesOf(isr).filter(i => i.start + span >= r0 && i.start <= r1), shown = shownInst(isr), vis = visibleNodes(isr);
      for (const inst of insts) {
        const dt = inst.k * (isr.period_us || 0), base = inst.start, sub = showSub(isr, inst.k) && (!lod || inst.k === shown.k), pfx = isr.name + '#' + inst.k;
        if (isr.length_us && base + isr.length_us >= r0 && base <= r1) {
          const ea = Math.max(base, r0), eb = Math.min(base + isr.length_us, r1), w = Math.max(tx(eb) - tx(ea), 0.02);
          envRecs.push({ x: tx(ea) + dx, w, y: row.y, h: row.h - 0.04, z: dz - 0.15, c: isr.over_budget ? critC : coreC });
        }
        if (sub && S.showDeadlines) instDeadlines(isr, base).forEach(dl => { if (dl.t < r0 || dl.t > r1) return; const x = tx(dl.t) + dx; dlPts.push(x, row.yBot + 0.02, dz + 0.25, x, row.yTop - 0.02, dz + 0.25); if (inst.k === shown.k && !manyRows && (!REL || REL.blocks.has(dl.block))) { labelCands.push({ pri: 1e9, txt: `${dl.block} ≤${(dl.d.at_us / SYM).toFixed(1)}`, x: x + 0.02, y: row.yTop - 0.09, z: dz + 0.3, color: cssVar('--critical'), h: fh(FS.dl), left: true }); } });
        const list = sub ? vis : [vis[0]];
        for (const rr of list) {
          const n = rr.n, ta = n.start_us + dt, tb = ta + n.total_us;
          if (tb < r0 || ta > r1 || boxBudget <= 0) continue;
          const path = pfx + rr.key.slice(isr.name.length), f = fnOf(n.fid), bx = tx(Math.max(ta, r0)) + dx, w = Math.max(tx(Math.min(tb, r1)) - bx + dx, 2 * k), yc = rowY(row, n.depth);
          const foc = S.block ? hl(n.fid) : inFocus(path, n.fid);
          const col = new THREE.Color(f ? modColor(f.module) : mutedC);
          recs.push({ n, isr, path, k: inst.k, x: bx, w, y: yc, z: dz + n.depth * dzStep, col, foc, root: rr.parent < 0, ext: n.external, rec: n.recursive, via: !!n.via_table, sel: S.selPath === path });
          boxBudget--;
          if (w > labelMinW || S.selPath === path) labelCands.push({ pri: w, txt: n.name + (rr.parent < 0 && insts.length > 1 ? ` #${inst.k}` : '') + (rr.kids && !isOpen(rr.key, n.depth) ? ' ▸' : ''), x: bx + 0.02, y: yc, z: dz + n.depth * dzStep + 0.33, h: fh(FS.box), bold: rr.parent < 0, maxW: w - 0.02, dim: !foc, force: S.selPath === path });
          if (!sub) continue;
          const zm = dz + n.depth * dzStep + 0.2;
          nodeEvents(n, isr, inst.k).forEach(e => { if (e.t_us < r0 || e.t_us > r1) return; evRecs.push({ e, n, isr, path, x: tx(e.t_us) + dx, y: yc + BOX_H / 2 + 0.06, z: zm, c: e.violation ? critC : (e.kind === 'read' ? readC : writeC), foc, big: e.violation }); });
          if (f) {
            f.vars.forEach(v => { const key = VKEY[f.id + '|' + v.name]; if (!key) return; const t = evTimeInFn(n, dt, v.seq); if (t < r0 || t > r1) return; touchRecs.push({ n, isr, path, x: tx(t) + dx, y: yc - BOX_H / 2 - 0.05, z: zm, c: v.rw === 'r' ? readC : (v.rw === 'addr' ? new THREE.Color(mutedC) : writeC), foc, varTip: { name: v.name + (v.member ? '.' + v.member : ''), rw: v.rw, line: v.line, key, via: v.via_macro } }); });
            f.ipc.forEach(i => { const t = evTimeInFn(n, dt, i.seq); if (t < r0 || t > r1) return; touchRecs.push({ n, isr, path, x: tx(t) + dx, y: yc - BOX_H / 2 - 0.05, z: zm, c: i.macro === 'IPC_RECV' ? readC : writeC, foc, ipcTip: i }); });
            f.heap.forEach(h => { const t = evTimeInFn(n, dt, h.seq); if (t < r0 || t > r1) return; touchRecs.push({ n, isr, path, x: tx(t) + dx, y: yc - BOX_H / 2 - 0.05, z: zm, c: seriousC, foc, heapTip: h }); });
          }
        }
      }
    }
  }
  tm.planes = Math.round(performance.now() - t0);
  { const sb = bars(slotXs, ruler.yBot, ruler.yTop + 0.3, ZBACK + 0.005, fg, 0.55, 2, k); if (sb) root.add(sb); const bd = slotBands(tx, x0, x1, ruler.yBot, ruler.yTop, ZBACK - 0.01, fg, slotA, slotB, 0); if (bd) root.add(bd); }
  const gw2 = segs(gridWeak, gridC, { opacity: 0.18 }); if (gw2) root.add(gw2);
  const dls = segs(dlPts, critC, { dashed: true, dash: 0.05, gap: 0.045, opacity: 0.65 }); if (dls) root.add(dls);
  // --- instanced marks
  const mat = new THREE.Matrix4(), col = new THREE.Color();
  if (envRecs.length) {
    const m = instanced(new THREE.BoxGeometry(1, 1, 0.22), envRecs.length, { opacity: 0.09 });
    envRecs.forEach((r, i) => { mat.makeScale(r.w, r.h, 1); mat.setPosition(r.x + r.w / 2, r.y, r.z); m.setMatrixAt(i, mat); m.setColorAt(i, r.c); });
    m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; root.add(m); G.env = m;
  }
  G.recs = recs; G.evRecs = evRecs; G.touchRecs = touchRecs;
  if (recs.length) {
    const m = instanced(new THREE.BoxGeometry(1, BOX_H, persp ? 0.5 : 0.3), recs.length, { lambert: true });
    recs.forEach((r, i) => { mat.makeScale(r.w, 1, 1); mat.setPosition(r.x + r.w / 2, r.y, r.z); m.setMatrixAt(i, mat); });
    m.instanceMatrix.needsUpdate = true; m.userData = { kind: 'box' }; root.add(m); pick3.push(m); G.boxes = m;
  } else G.boxes = null;
  if (evRecs.length) {
    const m = instanced(new THREE.SphereGeometry(1, 8, 6), evRecs.length, {});
    evRecs.forEach((r, i) => { const s = r.big ? 0.075 : 0.055; mat.makeScale(s, s, s); mat.setPosition(r.x, r.y, r.z); m.setMatrixAt(i, mat); });
    m.instanceMatrix.needsUpdate = true; m.userData = { kind: 'ev' }; root.add(m); pick3.push(m); G.ev = m;
  } else G.ev = null;
  if (touchRecs.length) {
    const m = instanced(new THREE.BoxGeometry(0.075, 0.075, 0.075), touchRecs.length, {});
    const rot = new THREE.Matrix4().makeRotationZ(Math.PI / 4);
    touchRecs.forEach((r, i) => { mat.copy(rot); mat.setPosition(r.x, r.y, r.z); m.setMatrixAt(i, mat); });
    m.instanceMatrix.needsUpdate = true; m.userData = { kind: 'touch' }; root.add(m); pick3.push(m); G.touch = m;
  } else G.touch = null;
  // outlines for the selected / hovered box
  G.selOutline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, BOX_H + 0.02, persp ? 0.52 : 0.32)), new THREE.LineBasicMaterial({ color: accentC, linewidth: 2 })); G.selOutline.visible = false; root.add(G.selOutline);
  G.hovOutline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, BOX_H + 0.02, persp ? 0.52 : 0.32)), new THREE.LineBasicMaterial({ color: fg, transparent: true, opacity: 0.8 })); G.hovOutline.visible = false; root.add(G.hovOutline);
  tm.marks = Math.round(performance.now() - t0);
  // --- labels (capped, widest first; forced ones always)
  labelCands.sort((a, b) => (b.force ? 1e12 : b.pri) - (a.force ? 1e12 : a.pri));
  let nl = 0;
  for (const c of labelCands) {
    if (nl >= labelCap && !c.force) break;
    if (persp && c.dim && emphasis) continue;
    const lb = label(c.txt, { h: c.h, bold: c.bold, color: c.color, opacity: c.dim && emphasis ? 0.35 : 1 });
    if (c.maxW != null && lb.scale.x > c.maxW && !c.force) continue;
    lb.position.set(c.x + lb.scale.x / 2, c.y, c.z); root.add(lb); nl++;
  }
  const ax = label('time →', { color: mutedC, h: fh(FS.axis) }); ax.position.set(x1 - ax.scale.x / 2, yTop + 0.4, ZBACK); root.add(ax);
  if (L.stacked && planes.length > 1) { const dg = label('cores ↘ (front = higher core)', { color: mutedC, h: fh(FS.axis) }); dg.position.set(x1 + L.maxDx - dg.scale.x / 2 + 0.3, ruler.yBot - RULER_GAP / 2, PLANE_DZ() * planes.length + 0.3); root.add(dg); }
  tm.labels = Math.round(performance.now() - t0);
  G.colors = { panelC, panel2C };
  recolor3D();
  tm.recolor = Math.round(performance.now() - t0);
  // canvas height follows the content in the orthographic views (capped; shift+wheel / drag scrolls rows)
  if (S.sceneH) { if (sceneEl.style.height !== S.sceneH + 'px') sceneEl.style.height = S.sceneH + 'px'; }
  else if (ortho()) {
    const hPx = Math.round((ext.vTop - ext.vBot) / k) + 34, newH = Math.max(240, Math.min(Math.round(window.innerHeight * 0.46), hPx)) + 'px';
    if (sceneEl.style.height !== newH) sceneEl.style.height = newH;
  } else { const ph = Math.round(window.innerHeight * 0.46) + 'px'; if (sceneEl.style.height !== ph) sceneEl.style.height = ph; }
  tm.height = Math.round(performance.now() - t0);
  sizeCanvas();
  tm.size = Math.round(performance.now() - t0);
  if (!ortho() && !build3D.fitted) { fit(); build3D.fitted = true; }
  tm.fit = Math.round(performance.now() - t0);
  updateCamera();
  tm.camera = Math.round(performance.now() - t0);
  renderLegend(); renderOverview();
  build3D.stats = { refs: refIds.length, deadlineTicks: dlPts.length / 6, boxes: recs.length, events: evRecs.length, touches: touchRecs.length, labels: nl, lod, ms: Math.round(performance.now() - t0), objects: root.children.length, t: tm, contentPx: Math.round((ext.vTop - ext.vBot) / k), planes: planes.length };
  if (window.ISRPROF_DEBUG) console.log('BUILD', S.view, build3D.stats);
}
// selection-only update: recolour the instanced marks, move the selection outline, no geometry rebuild
function recolor3D() {
  if (!have3D || !G.colors) return;
  const dimTo = G.colors.panel2C, col = new THREE.Color(), mat = new THREE.Matrix4();
  const emphasis = !!(REL || S.block);
  if (G.boxes) {
    G.selOutline.visible = false;
    G.recs.forEach((r, i) => {
      r.foc = S.block ? hl(r.n.fid) : inFocus(r.path, r.n.fid); r.sel = S.selPath === r.path;
      col.copy(r.col); if (r.ext) col.lerp(dimTo, 0.45); if (!r.foc && emphasis) col.lerp(dimTo, 0.8);
      G.boxes.setColorAt(i, col);
      if (r.sel) { mat.makeScale(r.w, 1, 1); mat.setPosition(r.x + r.w / 2, r.y, r.z); G.selOutline.matrix.copy(mat); G.selOutline.matrixAutoUpdate = false; G.selOutline.visible = true; }
    });
    G.boxes.instanceColor.needsUpdate = true;
  }
  if (G.ev) { G.evRecs.forEach((r, i) => { r.foc = S.block ? hl(r.n.fid) : inFocus(r.path, r.n.fid); col.copy(r.c); if (!r.foc && emphasis) col.lerp(dimTo, 0.75); G.ev.setColorAt(i, col); }); G.ev.instanceColor.needsUpdate = true; }
  if (G.touch) { G.touchRecs.forEach((r, i) => { r.foc = S.block ? hl(r.n.fid) : inFocus(r.path, r.n.fid); col.copy(r.c); if (!r.foc && emphasis) col.lerp(dimTo, 0.75); G.touch.setColorAt(i, col); }); G.touch.instanceColor.needsUpdate = true; }
  draw();
}
function renderLegend() {
  const mods = [...new Set(visibleIsrs().flatMap(i => i.functions.map(f => fnOf(f) ? fnOf(f).module : null).filter(Boolean)))];
  const st = build3D.stats || {};
  document.getElementById('legend').innerHTML =
    mods.map(m => `<span><i style="background:${modColor(m)}"></i>${esc(SWN[m] ? SWN[m].name : m)}</span>`).join('') +
    `<span><i style="background:var(--read)"></i>read / recv</span><span><i style="background:var(--write)"></i>write / send</span><span><i style="background:var(--critical)"></i>deadline miss</span>` +
    TI.filter(t => t.id !== 'nw' && !S.refHidden.has(t.id)).map(t => `<span style="color:${t.color || cat(TIX[t.id].idx + 2)}"><i class="dash"></i>${esc(t.name)} ${t.offset_us >= 0 ? '+' : ''}${(t.offset_us / SYM).toFixed(2)} sym</span>`).join('') +
    (S.showDeadlines ? `<span style="color:var(--critical)"><i class="dash"></i>HW block deadline (per ISR instance)</span>` : '') +
    `<span style="opacity:.8">● on a box = register access · ◆ below = shared-memory / IPC / heap touch · rows inside an ISR = call depth · ▭ = ISR budget · #k = periodic instance · reference lines = timing.yaml references (NW ± offset), toggle them in the controls${st.lod ? ' · <b>LOD: subtrees only on the shown instance</b>' : ''}</span>`;
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
  hit.addEventListener('pointerdown', e => { b = { t0: toUs(e) }; try { hit.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ } });
  hit.addEventListener('pointerup', e => { if (!b) return; const t1 = toUs(e), s0 = Math.min(b.t0, t1), s1 = Math.max(b.t0, t1); b = null; if (s1 - s0 > (W1 - W0) * 0.004) applyRange({ start: s0, end: s1 }); });
  hit.addEventListener('dblclick', () => applyRange(null));
  ov.title = `window ${fmtAbs(W0)} … ${fmtAbs(W1)} · drag to zoom the diagram into a range, double-click for the full window`;
}
function pickAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pick3, false);
  return hits.length ? hits[0] : null;
}
function hitRec(h) {
  const u = h.object.userData;
  if (u.kind === 'box') return { kind: 'box', r: G.recs[h.instanceId] };
  if (u.kind === 'ev') return { kind: 'ev', r: G.evRecs[h.instanceId] };
  if (u.kind === 'touch') return { kind: 'touch', r: G.touchRecs[h.instanceId] };
  if (u.kind === 'ch') return { kind: 'ch', r: G.chRecs[h.instanceId] };
  return { kind: 'label', u };
}
function setHover(h) {
  const r = h && h.kind === 'box' ? h.r : null;
  if (G.hovOutline) { if (r && !r.sel) { const mat = new THREE.Matrix4(); mat.makeScale(r.w, 1, 1); mat.setPosition(r.x + r.w / 2, r.y, r.z); G.hovOutline.matrix.copy(mat); G.hovOutline.matrixAutoUpdate = false; G.hovOutline.visible = true; } else G.hovOutline.visible = false; }
  renderer.domElement.style.cursor = h ? 'pointer' : (ortho() || S.panMode ? 'move' : 'grab'); draw();
}
function pick(e) {
  const h = pickAt(e);
  if (!h) { hideTip(); setHover(null); return; }
  const x = hitRec(h); setHover(x);
  if (x.kind === 'box') showTip(nodeTip(x.r.n, x.r.isr, x.r.path), e.clientX, e.clientY);
  else if (x.kind === 'ev') showTip(evTip(x.r.e), e.clientX, e.clientY);
  else if (x.kind === 'touch') { const r = x.r; showTip(r.varTip ? `<span class="mono"><b>${esc(r.varTip.name)}</b> [${r.varTip.rw}] <span class="m">line ${r.varTip.line}${r.varTip.via ? ' · via ' + esc(r.varTip.via) : ''}</span></span><span class="m">${esc(r.n.name)} · ${esc(r.isr.name)}</span>` : r.ipcTip ? `<span class="mono"><b>${esc(r.ipcTip.channel)}</b> ${r.ipcTip.macro} <span class="m">line ${r.ipcTip.line}</span></span><span class="m">${esc(r.n.name)} · ${esc(r.isr.name)}</span>` : `<span class="mono"><b>${esc(r.heapTip.fn)}</b> <span class="m">heap · line ${r.heapTip.line}</span></span><span class="m">${esc(r.n.name)} · ${esc(r.isr.name)}</span>`, e.clientX, e.clientY); }
  else if (x.kind === 'ch') { const r = x.r; showTip(`<span class="mono"><b>${esc(r.c.name || r.c.id)}</b> <span class="m">${r.c.dir.toUpperCase()} · slot ${r.s} (${slotType(r.s)})</span></span><span class="mono">symbols ${r.c.sym_start} … ${r.c.sym_start + r.c.sym_len} · ${fmtAbs(r.ta)} → ${fmtAbs(r.tb)}</span>${r.c.note ? `<span class="m">${esc(r.c.note)}</span>` : ''}`, e.clientX, e.clientY); }
  else showTip(`<span class="m">${esc(x.u.title || '')}</span>`, e.clientX, e.clientY);
}
function click(e) {
  const h = pickAt(e); if (!h) return;
  const x = hitRec(h);
  if (x.kind === 'box') { const r = x.r; if (r.n.children.length) toggleExp(r.path); selectNode(r.path, r.n.fid); return; }
  if (x.kind === 'ev' || x.kind === 'touch') { selectNode(x.r.path, x.r.n.fid); return; }
  if (x.kind === 'label' && x.u.isrRow) { const isr = x.u.isrRow; selectNode(isr.name + '#' + shownInst(isr).k, isr.tree.fid); return; }
}

// ------------------------------------------------------------------ 2D fallback (no WebGL): same layout, flat SVG
function build2D() {
  let host = sceneEl.querySelector('.nogl');
  if (!host) {
    host = document.createElement('div'); host.className = 'nogl'; sceneEl.insertBefore(host, sceneEl.firstChild);
    sceneEl.querySelector('.axes').hidden = true; sceneEl.querySelector('.views').hidden = true;
    sceneEl.style.height = 'auto';
  }
  const k = LEVEL_H / (ROW_PX * S.tscale), L = computeLayout(k), { ruler, planes, height } = L, r0 = R0(), r1 = R1();
  const Wd = Math.max(sceneEl.clientWidth, 480), plot = Wd - STRIP_L - STRIP_R - L.maxDx / k, PXU = 1 / k;
  const X = us => STRIP_L + (us - r0) / (r1 - r0) * plot, Y = yw => 22 + (ruler.yTop - yw) * PXU, H = Y(-height) + 16;
  let s = `<p style="margin:0 0 4px;color:var(--muted);font-size:11.5px">WebGL is unavailable: flat timing diagram (x = time; one band per core; rows = ISRs with call depth).</p><svg viewBox="0 0 ${Wd} ${H}" width="${Wd}" height="${H}" style="font-family:var(--mono);font-size:10px">`;
  for (let i = Math.ceil(r0 / SYM); i <= Math.floor(r1 / SYM); i++) { const slot = ((i % SPS) + SPS) % SPS === 0; if (!slot && plot / ((r1 - r0) / SYM) < 4) continue; const x = X(i * SYM); s += `<line x1="${x}" x2="${x}" y1="14" y2="${H - 10}" stroke="var(--line${slot ? '-strong' : ''})"/>${slot ? `<text x="${x + 2}" y="11" fill="var(--fg)" font-weight="600">s${i / SPS}</text>` : ''}`; }
  ruler.rows.forEach((row, ri) => { const yc = Y(ruler.chTop - ri * ruler.chH - ruler.chH / 2); s += `<text x="${STRIP_L - 6}" y="${yc + 3}" text-anchor="end">${esc(row.name)}</text>`; for (let sl = Math.floor(r0 / SLOT) - 1; sl <= Math.ceil(r1 / SLOT); sl++) row.items.forEach(c => { if (!channelActive(c, sl)) return; const ta = sl * SLOT + c.sym_start * SYM, tb = ta + c.sym_len * SYM; if (tb < r0 || ta > r1) return; s += `<rect x="${X(Math.max(ta, r0))}" y="${yc - ruler.chH * PXU * 0.36}" width="${Math.max(X(Math.min(tb, r1)) - X(Math.max(ta, r0)), 1.5)}" height="${ruler.chH * PXU * 0.72}" fill="${chColor(c)}" opacity=".85"/>`; }); });
  for (const pl of planes) {
    const dx = pl.dx / k;
    s += `<rect x="${STRIP_L + dx}" y="${Y(pl.yTop)}" width="${plot}" height="${(pl.yTop - pl.yBot) * PXU}" fill="${coreColor(pl.core.id)}" opacity=".07"/><text x="${4 + dx}" y="${Y(pl.yTop) + 12}" fill="${coreColor(pl.core.id)}" font-weight="600">${esc(pl.core.name)}</text>`;
    for (const row of pl.rows) {
      const isr = row.isr;
      s += `<text x="${STRIP_L - 6 + dx}" y="${Y(row.y) + 4}" text-anchor="end">${esc(isr.name)}</text>`;
      const vis = visibleNodes(isr);
      for (const inst of instancesOf(isr)) {
        if (inst.start > r1 || inst.start + Math.max(isr.computed_us, isr.length_us || 0) < r0) continue;
        const dt = inst.k * (isr.period_us || 0), sub = showSub(isr, inst.k), pfx = isr.name + '#' + inst.k;
        for (const rr of (sub ? vis : [vis[0]])) {
          const n = rr.n, f = fnOf(n.fid), p = pfx + rr.key.slice(isr.name.length), bx = X(n.start_us + dt) + dx, bw = Math.max(X(n.start_us + dt + n.total_us) - X(n.start_us + dt), 1.5), by = Y(rowY(row, n.depth) + BOX_H / 2), bh = BOX_H * PXU, dim = S.block ? !hl(n.fid) : !inFocus(p, n.fid);
          s += `<g class="n2d" data-path="${esc(p)}" style="cursor:pointer"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${f ? modColor(f.module) : 'var(--muted)'}" stroke="var(--fg)" stroke-opacity=".4" opacity="${dim ? .25 : .9}"/>${bw > 40 ? `<text x="${bx + 3}" y="${by + bh - 3}" fill="#fff">${esc(n.name)}</text>` : ''}</g>`;
          if (sub) nodeEvents(n, isr, inst.k).forEach(e => { s += `<circle cx="${X(e.t_us) + dx}" cy="${by - 3}" r="2.5" fill="${e.violation ? 'var(--critical)' : e.kind === 'read' ? 'var(--read)' : 'var(--write)'}"/>`; });
        }
      }
    }
  }
  s += '</svg>';
  host.innerHTML = s;
  host.querySelectorAll('.n2d').forEach(g => g.addEventListener('click', () => { const p = g.dataset.path, n = nodeAt(p); if (n && n.children.length) toggleExp(p); selectNode(p, n && n.fid); }));
  build3D.stats = { boxes: host.querySelectorAll('.n2d').length, fallback: true };
  renderLegend(); renderOverview();
}
