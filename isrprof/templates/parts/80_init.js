// ================================================================== orchestration, controls, deep links, self-test
const ERRORS = [];
window.addEventListener('error', e => { ERRORS.push(String(e.message || e)); });
function renderAll(opts) {
  opts = opts || {};
  REL = computeRel();
  document.getElementById('focus-info').textContent = REL
    ? `${S.selFid ? short(S.selFid) : S.swNode ? (SWN[S.swNode] ? SWN[S.swNode].name : S.swNode) : S.selVar ? (VARX[S.selVar] ? VARX[S.selVar].name : S.selVar) + ' (users)' : S.selIpc ? S.selIpc + ' (users)' : ''} → ${REL.fids.size} fn · ${REL.blocks.size} HW block${REL.blocks.size === 1 ? '' : 's'} · ${[...REL.sw.values()].filter(t => t.rw !== 'c').length} SW node${REL.sw.size === 1 ? '' : 's'} · ${REL.vars.size} var${REL.vars.size === 1 ? '' : 's'} · ${REL.ipc.size} ipc`
    : (S.block ? `HW ${S.block} ← ${BX[S.block].accessors.length} functions` : 'nothing selected');
  document.getElementById('range-info').textContent = `${fmtAbs(R0())} → ${fmtAbs(R1())} · ${((R1() - R0()) / SLOT).toFixed(2)} slot${S.range ? '' : ' (full window)'}`;
  if (typeof syncSlotInputs === 'function') syncSlotInputs();
  const light = opts.light && renderAll.expV === EXPV && renderAll.built;
  if (!renderAll.built) { renderSW(); renderHW(); } else { applySWHighlight(); applyHWHighlight(); }   // the SVGs are rebuilt by their own handlers (depth, open / close, resize)
  renderTree(); renderDetail();
  if (S.tab === 'timing') { if (light && have3D) recolor3D(); else build3D(); } else renderStructure();
  renderAll.expV = EXPV; renderAll.built = true;
}

document.getElementById('proj').textContent = P.project.name;
document.getElementById('hdr-chips').innerHTML =
  `<span class="chip">µ=<b>${NUM.mu}</b></span><span class="chip">slot <b>${SLOT.toFixed(1)} µs</b></span><span class="chip">symbol <b>${SYM.toFixed(2)} µs</b></span>` +
  `<span class="chip">window <b>${((W1 - W0) / SLOT).toFixed(1)} slots</b></span><span class="chip">cores <b>${CORES.length}</b></span><span class="chip">files <b>${P.parse_stats.files}</b></span>` +
  `<span class="chip">functions <b>${P.parse_stats.functions}</b></span><span class="chip">ISRs <b>${P.isrs.length}</b></span><span class="chip">SW nodes <b>${SWS.nodes.length}</b></span><span class="chip">HW blocks <b>${BLOCKS.length}</b></span><span class="chip">LLM <b>${P.llm.enabled ? P.llm.model : 'off'}</b></span>`;
document.getElementById('foot').textContent =
  `isrprof ${P.tool.version} · profile ${P.project.profile || P.project.name} · window ${fmtAbs(W0)} … ${fmtAbs(W1)} · reference lines: ` +
  TI.map(t => `${t.name} (${t.offset_us >= 0 ? '+' : ''}${(t.offset_us / SYM).toFixed(2)} sym)`).join(', ') +
  (P.build && P.build.compile_commands ? ` · build: ${P.build.translation_units} TUs from compile_commands.json` : '') +
  (P.build && P.build.build_command ? ` · build command: ${P.build.build_command}` : '') +
  (P.llm.log.length ? ' · LLM: ' + P.llm.log.join('; ') : '');

const ct = document.getElementById('core-toggles');
ct.innerHTML = CORES.map(c => `<label><input type="checkbox" data-core="${c.id}" checked><i class="sw" style="background:${coreColor(c.id)}"></i>${esc(c.name)}</label>`).join('');
function setCores(ids) { S.cores = new Set(ids); ct.querySelectorAll('input').forEach(i => { i.checked = S.cores.has(+i.dataset.core); }); build3D.fitted = false; renderAll(); }
ct.addEventListener('change', e => { const i = e.target; if (!i.dataset) return; const id = +i.dataset.core; const next = new Set(S.cores); if (i.checked) next.add(id); else next.delete(id); setCores(next); });
document.getElementById('cores-all').onclick = () => setCores(CORES.map(c => c.id));
// ISR selection: checkboxes grouped by core (null = every ISR)
const isrList = document.getElementById('isr-list'), isrSummary = document.getElementById('isr-summary');
function renderIsrList() {
  const filt = (document.getElementById('isr-filter').value || '').toLowerCase();
  isrList.innerHTML = CORES.map(c => {
    const rows = P.isrs.filter(i => i.core === c.id && (!filt || i.name.toLowerCase().includes(filt)));
    if (!rows.length) return '';
    return `<div class="core-h"><i class="sw" style="background:${coreColor(c.id)}"></i>${esc(c.name)} <button class="tog mini" data-core-only="${c.id}" title="only this core's ISRs">only</button></div>` +
      rows.map(i => `<label><input type="checkbox" data-isr="${esc(i.name)}" ${!S.isrs || S.isrs.has(i.name) ? 'checked' : ''}>${esc(i.name)} <span class="info">${esc(TIX[i.timing].name)} +${(i.start_us / SYM).toFixed(1)}</span></label>`).join('');
  }).join('');
  const n = S.isrs ? S.isrs.size : P.isrs.length;
  isrSummary.textContent = !S.isrs ? `all ISRs (${P.isrs.length})` : n === 0 ? 'no ISR' : n <= 2 ? [...S.isrs].join(', ') : `${n} of ${P.isrs.length} ISRs`;
}
function setIsrs(names) {            // names: null (all) or iterable of ISR names
  S.isrs = names == null ? null : new Set(names);
  if (S.isrs && S.isrs.size === P.isrs.length) S.isrs = null;
  renderIsrList(); build3D.fitted = false; renderAll();
}
isrList.addEventListener('change', e => { const i = e.target; if (!i.dataset || !i.dataset.isr) return; const cur = new Set(S.isrs || P.isrs.map(x => x.name)); if (i.checked) cur.add(i.dataset.isr); else cur.delete(i.dataset.isr); setIsrs(cur); });
isrList.addEventListener('click', e => { const b = e.target.closest('button[data-core-only]'); if (!b) return; e.preventDefault(); setIsrs(P.isrs.filter(i => i.core === +b.dataset.coreOnly).map(i => i.name)); });
document.getElementById('isr-all').onclick = e => { e.preventDefault(); setIsrs(null); };
document.getElementById('isr-none').onclick = e => { e.preventDefault(); setIsrs([]); };
document.getElementById('isr-filter').addEventListener('input', renderIsrList);
document.addEventListener('click', e => { const dd = document.getElementById('isr-dd'); if (dd.open && !dd.contains(e.target)) dd.open = false; });
renderIsrList();
// slots shown: from / count (the data window stays what the profile configured)
const slotFrom = document.getElementById('slot-from'), slotCount = document.getElementById('slot-count');
const slotMin = Math.floor(W0 / SLOT + 1e-9), slotMax = Math.ceil(W1 / SLOT - 1e-9);
slotFrom.min = slotMin; slotFrom.max = slotMax - 1; slotCount.max = Math.max(1, slotMax - slotMin);
function setSlots(from, count) {
  count = Math.max(1, Math.min(slotMax - slotMin, count | 0)); from = Math.max(slotMin, Math.min(slotMax - count, from | 0));
  const start = Math.max(W0, from * SLOT), end = Math.min(W1, (from + count) * SLOT);
  applyRange(start <= W0 + 1e-6 && end >= W1 - 1e-6 ? null : { start, end });
}
function syncSlotInputs() { const a = R0() / SLOT, b = R1() / SLOT; slotFrom.value = Math.floor(a + 1e-9); slotCount.value = Math.max(1, Math.round(b - a)); }
slotFrom.addEventListener('change', () => setSlots(+slotFrom.value, +slotCount.value));
slotCount.addEventListener('change', () => setSlots(+slotFrom.value, +slotCount.value));
document.getElementById('slot-prev').onclick = () => setSlots(+slotFrom.value - +slotCount.value, +slotCount.value);
document.getElementById('slot-next').onclick = () => setSlots(+slotFrom.value + +slotCount.value, +slotCount.value);
const refTog = document.getElementById('ref-toggles');
refTog.innerHTML = TI.filter(t => t.id !== 'nw').map(t => `<label title="${esc(t.description || '')} · ${esc(t.kind)} line, NW ${t.offset_us >= 0 ? '+' : ''}${(t.offset_us / SYM).toFixed(2)} sym (timing.yaml references)" style="color:${t.color || cat(TIX[t.id].idx + 2)}"><input type="checkbox" data-ref="${esc(t.id)}" checked><i class="dash"></i>${esc(t.name)} <span class="info">${t.offset_us >= 0 ? '+' : ''}${(t.offset_us / SYM).toFixed(2)}</span></label>`).join('');
function setRefs(hidden) { S.refHidden = new Set(hidden); refTog.querySelectorAll('input').forEach(i => { i.checked = !S.refHidden.has(i.dataset.ref); }); if (S.tab === 'timing') build3D(); }
refTog.addEventListener('change', e => { const i = e.target; if (!i.dataset || !i.dataset.ref) return; const h = new Set(S.refHidden); if (i.checked) h.delete(i.dataset.ref); else h.add(i.dataset.ref); setRefs(h); });
document.getElementById('dl-toggle').addEventListener('change', e => { S.showDeadlines = e.target.checked; if (S.tab === 'timing') build3D(); });
const ovEl = document.getElementById('overlap'); ovEl.value = Math.round(S.overlap * 100); document.getElementById('overlap-v').textContent = ovEl.value + '%';
ovEl.addEventListener('input', () => { S.overlap = +ovEl.value / 100; document.getElementById('overlap-v').textContent = ovEl.value + '%'; if (S.tab === 'timing' && S.view === 'tilt') build3D(); });
function setUnit(u) { S.unit = u; document.getElementById('unit-sym').setAttribute('aria-pressed', u === 'sym'); document.getElementById('unit-us').setAttribute('aria-pressed', u === 'us'); renderAll(); }
document.getElementById('unit-sym').onclick = () => setUnit('sym');
document.getElementById('unit-us').onclick = () => setUnit('us');
const levelEl = document.getElementById('level'); levelEl.value = S.level;
levelEl.addEventListener('change', () => setLevel(+levelEl.value));
document.getElementById('lvl-inc').onclick = () => setLevel(S.level + 1);
document.getElementById('lvl-dec').onclick = () => setLevel(S.level - 1);
document.getElementById('exp-all').onclick = () => setLevel(30);
document.getElementById('col-all').onclick = () => setLevel(0);
document.getElementById('inst-all').onclick = () => { S.allInst = !S.allInst; document.getElementById('inst-all').setAttribute('aria-pressed', S.allInst); renderAll(); };
document.getElementById('focus-self').onclick = () => setDeep(false);
document.getElementById('focus-deep').onclick = () => setDeep(true);
document.getElementById('focus-clear').onclick = clearFocus;
document.getElementById('range-full').onclick = () => applyRange(null);
document.getElementById('tscale').addEventListener('input', e => { S.tscale = Math.pow(2, +e.target.value); build3D.fitted = false; if (S.tab === 'timing') build3D(); });
function setSwDepth(d) { S.swDepth = Math.max(1, d | 0); S.swOpen.clear(); S.swClosed.clear(); document.getElementById('sw-depth').value = S.swDepth; document.getElementById('sw-depth-v').textContent = S.swDepth; renderSW(); }
function setHwDepth(d) { S.hwDepth = Math.max(1, d | 0); S.hwOpen.clear(); S.hwClosed.clear(); document.getElementById('hw-depth').value = S.hwDepth; document.getElementById('hw-depth-v').textContent = S.hwDepth; renderHW(); }
const swMax = Math.max(1, ...SWS.nodes.map(n => n.depth + 1)), hwMax = Math.max(1, ...HWS.nodes.map(n => n.depth + 1));
document.getElementById('sw-depth').max = swMax; document.getElementById('hw-depth').max = hwMax;
S.swDepth = Math.min(S.swDepth, swMax); S.hwDepth = Math.min(S.hwDepth, hwMax);
document.getElementById('sw-depth').value = S.swDepth; document.getElementById('sw-depth-v').textContent = S.swDepth;
document.getElementById('hw-depth').value = S.hwDepth; document.getElementById('hw-depth-v').textContent = S.hwDepth;
document.getElementById('sw-depth').addEventListener('input', e => setSwDepth(+e.target.value));
document.getElementById('hw-depth').addEventListener('input', e => setHwDepth(+e.target.value));
document.querySelectorAll('.pz .tog').forEach(b => b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); const d = DG[b.dataset.host]; if (!d) return; const host = document.getElementById(b.dataset.host); if (b.dataset.pz === 'fit') d.pz.fit(); else d.pz.zoom(b.dataset.pz === 'in' ? 1.3 : 1 / 1.3, host.clientWidth / 2, host.clientHeight / 2); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') clearFocus(); if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); histBack(); } if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); histForward(); } });
document.getElementById('hist-back').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); histBack(); });
document.getElementById('hist-fwd').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); histForward(); });
document.querySelectorAll('.tabs button[role="tab"]').forEach(b => b.addEventListener('click', () => {
  S.tab = b.dataset.tab;
  document.querySelectorAll('.tabs button[role="tab"]').forEach(x => x.setAttribute('aria-selected', x === b));
  document.getElementById('tab-timing').hidden = S.tab !== 'timing';
  document.getElementById('tab-structure').hidden = S.tab !== 'structure';
  if (S.tab === 'structure') renderStructure(); else { renderSW(); renderHW(); resize3D(); build3D(); }
}));
document.getElementById('dsm-col').onclick = () => { ST.modules.forEach(m => S.dsmCollapsed.add(m.name)); renderStructure(); };
document.getElementById('dsm-exp').onclick = () => { S.dsmCollapsed.clear(); renderStructure(); };

// ---- windows: every panel is a <details> that can be collapsed / expanded; the state is remembered
//      per viewer (browser storage, best effort) and a re-opened panel re-renders at its real width
const PANEL_KEY = 'isrprof.panels';
function panelState() { try { return JSON.parse(localStorage.getItem(PANEL_KEY) || '{}'); } catch (e) { return {}; } }
function savePanel(id, open) { try { const s = panelState(); s[id] = open; localStorage.setItem(PANEL_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ } }
const panels = [...document.querySelectorAll('details.panel')];
const saved = panelState();
panels.forEach((d, i) => {
  if (!d.id) d.id = 'panel-' + i;
  if (typeof saved[d.id] === 'boolean') d.open = saved[d.id];
  d.addEventListener('toggle', () => {
    savePanel(d.id, d.open);
    if (!d.open) return;
    if (d.id === 'scene-panel') { if (have3D) { resize3D(); build3D(); } else build2D(); }
    else if (d.id === 'sw-panel') renderSW();
    else if (d.id === 'hw-panel') renderHW();
    else if (d.closest('#tab-structure')) renderStructure();
  });
});
const SIZE_KEY = 'isrprof.sizes';
function sizeState() { try { return JSON.parse(localStorage.getItem(SIZE_KEY) || '{}'); } catch (e) { return {}; } }
function saveSize(id, v) { try { const s = sizeState(); s[id] = v; localStorage.setItem(SIZE_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ } }
// the element whose height a window's handle controls
function sizeTarget(body) {
  if (body.classList.contains('scene-body')) return sceneEl;
  const inner = body.querySelector(':scope > #tree, :scope > #detail') || (body.id === 'tree' || body.id === 'detail' ? body : null);
  return inner || body;
}
function applyHeight(body, h) {
  h = Math.max(80, Math.round(h));
  const t = sizeTarget(body);
  if (t === sceneEl) { S.sceneH = h; sceneEl.style.height = h + 'px'; if (have3D) resize3D(); return; }
  t.style.height = h + 'px'; t.style.maxHeight = 'none'; t.dataset.userH = '1';
  if (t.classList.contains('diagram')) { const d = DG[t.id]; if (d) d.pz.apply(); }
}
function resetHeight(body) {
  const t = sizeTarget(body);
  if (t === sceneEl) { S.sceneH = null; if (S.tab === 'timing') build3D(); return; }
  t.style.height = ''; t.style.maxHeight = ''; delete t.dataset.userH;
  if (t.id === 'sw') renderSW(); else if (t.id === 'hw') renderHW();
}
const sizes = sizeState();
panels.forEach(d => {
  const body = d.querySelector(':scope > .body'); if (!body) return;
  if (d.closest('#side')) return;          // the side column is sized by the two splitters
  const key = 'h:' + d.id;
  if (sizes[key]) applyHeight(body, sizes[key]);
  // a grab bar right under the window (sibling of the body, so overflow / pan handlers never swallow it)
  const h = document.createElement('div'); h.className = 'rz'; h.title = 'drag to resize this window · double-click resets'; h.innerHTML = '<i></i>';
  body.insertAdjacentElement('afterend', h);
  h.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); try { h.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ } h.classList.add('on'); document.body.style.cursor = 'ns-resize';
    const y0 = e.clientY, h0 = sizeTarget(body).getBoundingClientRect().height;
    const move = ev => { ev.preventDefault(); applyHeight(body, h0 + ev.clientY - y0); };
    const up = ev => { h.classList.remove('on'); document.body.style.cursor = ''; h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
      saveSize(key, Math.max(80, Math.round(h0 + ev.clientY - y0))); if (sizeTarget(body) === sceneEl && S.tab === 'timing') build3D(); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  });
  h.addEventListener('dblclick', e => { e.preventDefault(); resetHeight(body); saveSize(key, null); });
});
const wrap = document.querySelector('.stack-wrap'), splitter = document.getElementById('splitter');
if (sizes['side-w']) wrap.style.setProperty('--side-w', sizes['side-w'] + 'px');
splitter.addEventListener('pointerdown', e => {
  e.preventDefault(); try { splitter.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ } splitter.classList.add('on');
  const x0 = e.clientX, w0 = document.getElementById('side').getBoundingClientRect().width;
  const move = ev => { const w = Math.max(240, Math.min(window.innerWidth * 0.6, Math.round(w0 - (ev.clientX - x0)))); wrap.style.setProperty('--side-w', w + 'px'); };
  const up = ev => { splitter.classList.remove('on'); splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up); saveSize('side-w', parseInt(getComputedStyle(wrap).getPropertyValue('--side-w')) || null); renderSW(); renderHW(); if (have3D && S.tab === 'timing') { resize3D(); build3D(); } };
  splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', up);
});
splitter.addEventListener('dblclick', () => { wrap.style.removeProperty('--side-w'); saveSize('side-w', null); renderSW(); renderHW(); if (have3D && S.tab === 'timing') { resize3D(); build3D(); } });
// horizontal splitter: call graph height vs details height
const side = document.getElementById('side'), hsplit = document.getElementById('hsplit'), treePanel = document.getElementById('tree-panel');
if (sizes['tree-h']) side.style.setProperty('--tree-h', sizes['tree-h'] + 'px');
hsplit.addEventListener('pointerdown', e => {
  if (e.button !== 0) return; e.preventDefault(); try { hsplit.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ } hsplit.classList.add('on');
  const y0 = e.clientY, h0 = treePanel.getBoundingClientRect().height, max = side.getBoundingClientRect().height - 120;
  const move = ev => { const h = Math.max(60, Math.min(max, Math.round(h0 + ev.clientY - y0))); treePanel.open = true; side.style.setProperty('--tree-h', h + 'px'); };
  const up = ev => { hsplit.classList.remove('on'); hsplit.removeEventListener('pointermove', move); hsplit.removeEventListener('pointerup', up); saveSize('tree-h', parseInt(getComputedStyle(side).getPropertyValue('--tree-h')) || null); };
  hsplit.addEventListener('pointermove', move); hsplit.addEventListener('pointerup', up);
});
hsplit.addEventListener('dblclick', () => { side.style.removeProperty('--tree-h'); saveSize('tree-h', null); });
document.getElementById('panels-collapse').onclick = () => panels.forEach(d => { d.open = false; });
document.getElementById('panels-expand').onclick = () => panels.forEach(d => { d.open = true; });

init3D();
if (have3D) resize3D();
// deep links (tokens joined with "--"):  structure | sel-<function or ISR> (callees included) | selonly-<name>
//   | range-<startSlot>~<endSlot> | view-3d | view-tilt | view-aligned | level-<n> | swdepth-<n> | hwdepth-<n> | selftest
//   e.g.  #sel-DL_PDSCH_ISR--range-0.9~1.3--view-3d
let SELFTEST = false;
location.hash.replace(/^#/, '').split('--').forEach(tok => {
  if (tok === 'debug') window.ISRPROF_DEBUG = 1;
  if (tok === 'selftest') SELFTEST = true;
  if (tok === 'structure') document.querySelector('.tabs button[data-tab="structure"]').click();
  if (tok === 'view-3d') { S.view = 'persp'; cam.theta = 0.45; cam.phi = 1.2; }
  if (tok === 'view-tilt') S.view = 'tilt';
  if (tok === 'view-aligned') S.view = 'aligned';
  let m = /^level-(\d+)$/.exec(tok); if (m) { S.level = +m[1]; levelEl.value = S.level; }
  m = /^swdepth-(\d+)$/.exec(tok); if (m) { S.swDepth = +m[1]; }
  m = /^hwdepth-(\d+)$/.exec(tok); if (m) { S.hwDepth = +m[1]; }
  m = /^isr-(.+)$/.exec(tok); if (m) { S.isrs = new Set(m[1].split(',').filter(n => ISRX[n])); renderIsrList(); }
  m = /^slots-(-?\d+)~(\d+)$/.exec(tok); if (m) { const from = +m[1], count = +m[2]; S.range = { start: Math.max(W0, from * SLOT), end: Math.min(W1, (from + count) * SLOT) }; }
  m = /^overlap-(\d+)$/.exec(tok); if (m) { S.overlap = Math.max(0, Math.min(0.85, +m[1] / 100)); ovEl.value = Math.round(S.overlap * 100); document.getElementById('overlap-v').textContent = ovEl.value + '%'; }
  m = /^sel(only)?-([A-Za-z0-9_.~]+)$/.exec(tok);
  if (m) {
    S.deep = !m[1]; document.getElementById('focus-self').setAttribute('aria-pressed', !S.deep); document.getElementById('focus-deep').setAttribute('aria-pressed', S.deep);
    const name = m[2], isr = ISRX[name] || P.isrs.find(i => i.entry === name);
    const fid = isr ? isr.tree.fid : (F[name] ? name : Object.keys(F).find(k => short(k) === name));
    if (fid) { S.selFid = fid; S.selPath = isr ? isr.name + '#' + shownInst(isr).k : findPath(fid); }
  }
  const r = /^range-(-?[\d.]+)~(-?[\d.]+)$/.exec(tok);
  if (r) S.range = { start: Math.max(W0, +r[1] * SLOT), end: Math.min(W1, +r[2] * SLOT) };
});
if (have3D) markViews();
renderAll();
if (have3D) { resize3D(); build3D(); }
const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
if (mq && mq.addEventListener) mq.addEventListener('change', () => { _cssCache = {}; renderAll(); });
new MutationObserver(() => { _cssCache = {}; renderAll(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { renderSW(); renderHW(); if (S.tab === 'structure') renderStructure(); else build3D(); }, 150); });

// ---- self-test (#selftest): drives the viewer through its interactions and reports what every step produced,
//      so a headless browser can verify the page without a human (python tools/verify_viewer.py)
function selfTest() {
  const out = { errors: ERRORS, steps: [], have3D, fallback: !have3D };
  const step = (name, fn) => { const t = performance.now(); let r; try { r = fn(); } catch (e) { r = { error: String(e && e.stack || e) }; } out.steps.push(Object.assign({ name, ms: Math.round(performance.now() - t) }, r)); };
  const swCount = cls => document.querySelectorAll(`#sw .nd.${cls}`).length, hwCount = cls => document.querySelectorAll(`#hw .nd.${cls}`).length;
  const stats = () => Object.assign({}, build3D.stats || {});
  step('initial', () => ({ stats: stats(), swBoxes: document.querySelectorAll('#sw .nd').length, hwBoxes: document.querySelectorAll('#hw .nd').length, swEdges: document.querySelectorAll('#sw .ed').length, hwEdges: document.querySelectorAll('#hw .ed').length, channels: G.chRecs ? G.chRecs.length : 0, treeRows: document.querySelectorAll('#tree-body .row').length }));
  const isr = P.isrs.find(i => i.hw_events.length) || P.isrs[0];
  step('select ISR root ' + isr.name, () => { selectNode(isr.name + '#' + shownInst(isr).k, isr.tree.fid); return { fids: REL.fids.size, blocks: REL.blocks.size, swNodes: [...REL.sw.values()].filter(t => t.rw !== 'c').length, vars: REL.vars.size, swRelX: swCount('rel-x'), swRelRW: swCount('rel-r') + swCount('rel-w') + swCount('rel-rw'), swDim: swCount('dim'), hwRel: hwCount('rel-r') + hwCount('rel-w') + hwCount('rel-rw') + hwCount('rel-miss'), hwDim: hwCount('dim'), treeRows: document.querySelectorAll('#tree-body .row').length, detailTables: document.querySelectorAll('#detail-body table').length, outline: G.selOutline ? G.selOutline.visible : null, focusInfo: document.getElementById('focus-info').textContent }; });
  step('side column clipping', () => { setLevel(30); const tp = document.getElementById('tree-panel').getBoundingClientRect(), dp = document.getElementById('detail-panel').getBoundingClientRect(), tb = document.getElementById('tree'), last = [...document.querySelectorAll('#tree-body .row')].pop().getBoundingClientRect(); setLevel(2); return { treeBottom: Math.round(tp.bottom), detailTop: Math.round(dp.top), overlap: Math.round(tp.bottom - dp.top), lastRowBottom: Math.round(last.bottom), treeScrolls: tb.scrollHeight > tb.clientHeight, treeClientH: tb.clientHeight }; });
  step('history back / forward + variable / ipc links', () => {
    clearFocus(); const root = isr.name + '#' + shownInst(isr).k; selectNode(root, isr.tree.fid);
    const blk = BLOCKS.find(b => b.accessors.length); selectBlock(blk.id); const atBlock = S.block;
    histBack(); const back1 = { sel: S.selFid, block: S.block }; histBack(); const back2 = { sel: S.selFid, block: S.block }; histForward(); const fwd = { sel: S.selFid }; histForward(); const fwd2 = { block: S.block };
    const v = P.memory.variables.find(x => x.accessors.length > 1); selectVariable(v.key);
    const vr = { selVar: S.selVar, fids: REL ? REL.fids.size : 0, detailHasUsers: document.querySelectorAll('#detail-body table tr').length > 1, swSel: document.querySelectorAll('#sw .nd.sel').length };
    const ch = P.memory.ipc_ops[0].channel; selectIpc(ch); const ir = { selIpc: S.selIpc, fids: REL ? REL.fids.size : 0 };
    histBack(); const backVar = S.selVar; selectNode(root, isr.tree.fid);          // leave the ISR root selected for the following steps
    return { atBlock, back1, back2, fwd, fwd2, vr, ir, backVar, buttons: !!document.getElementById('hist-back') }; });
  step('details sections', () => { const secs = [...document.querySelectorAll('#detail-body details.sub')].map(d => d.id); const swRows = [...document.querySelectorAll('#sec-sw .rel-row')], anc = swRows.filter(r => r.classList.contains('anc')).length; const hwRows = document.querySelectorAll('#sec-hw .rel-row').length, regs = document.querySelectorAll('#sec-hw .rel-regs .reg').length; const d = document.getElementById('sec-sw'); d.open = false; const closed = !d.open; d.open = true; return { sections: secs, swFirst: secs[0] === 'sec-sw' && secs[1] === 'sec-hw', swRows: swRows.length, swAncestors: anc, hwRows, regs, collapsible: closed }; });
  step('focus: this function only', () => { setDeep(false); return { fids: REL.fids.size, blocks: REL.blocks.size }; });
  step('focus: include callees', () => { setDeep(true); return { fids: REL.fids.size, blocks: REL.blocks.size }; });
  step('level 0', () => { setLevel(0); return { treeRows: document.querySelectorAll('#tree-body .row').length, boxes: stats().boxes }; });
  step('level 6', () => { setLevel(6); return { treeRows: document.querySelectorAll('#tree-body .row').length, boxes: stats().boxes }; });
  step('level 2', () => { setLevel(2); return { treeRows: document.querySelectorAll('#tree-body .row').length, boxes: stats().boxes }; });
  const deepNode = isr.flat.find(r => r.depth >= 2 && r.n.hw_events.length) || isr.flat[isr.flat.length - 1];
  step('select nested box ' + deepNode.n.name, () => { const p = isr.name + '#' + shownInst(isr).k + deepNode.key.slice(isr.name.length); selectNode(p, deepNode.n.fid); return { fids: REL.fids.size, blocks: REL.blocks.size, crumbs: document.querySelectorAll('#tree-body .crumb').length, swRel: swCount('rel-x') + swCount('rel-r') + swCount('rel-w') + swCount('rel-rw'), hwRel: hwCount('rel-r') + hwCount('rel-w') + hwCount('rel-rw') + hwCount('rel-miss') }; });
  const withKids = isr.flat.find(r => r.kids && r.depth >= 1) || isr.flat[0];
  step('click call-graph row', () => {
    clearFocus(); setLevel(30);                                   // every level open: the tree reaches the leaves
    const rows = [...document.querySelectorAll('#tree-body .row')], leafRows = rows.filter(r => r.querySelector('.car').textContent.trim() === '·');
    const nodes = P.isrs.filter(i => S.cores.has(i.core)).reduce((a, i) => a + i.flat.length, 0);
    const target = rows.find(r => { const f = F[r.dataset.fid]; return f && f.hw.length && r.dataset.path.split('/').length > 2; }) || rows[rows.length - 1];
    target.click();                                               // a real click on a nested function row
    const swRel = swCount('rel-x') + swCount('rel-r') + swCount('rel-w') + swCount('rel-rw'), hwRel = hwCount('rel-r') + hwCount('rel-w') + hwCount('rel-rw') + hwCount('rel-miss');
    const det = document.getElementById('detail-body').textContent;
    const r = { treeRows: rows.length, leafRows: leafRows.length, treeNodes: nodes, clicked: target.dataset.fid, selFid: S.selFid, swRel, hwRel, swDim: swCount('dim'), hwDim: hwCount('dim'),
      detailsSW: det.includes('SW STRUCTURE') || det.includes('SW structure'), detailsHW: det.includes('HW STRUCTURE') || det.includes('HW structure'), detailTables: document.querySelectorAll('#detail-body table').length };
    setLevel(2); clearFocus(); return r; });
  step('call graph: pin / caller / callee', () => {
    const root = isr.name + '#' + shownInst(isr).k, deep = isr.flat.find(r => r.depth >= 2) || isr.flat[isr.flat.length - 1];
    selectNode(root + deep.key.slice(isr.name.length), deep.n.fid);
    const first = () => document.querySelector('#tree-body .row').dataset.fid, selRow = () => document.querySelector('#tree-body .row.sel');
    const r = { rootUnpinned: first(), selectedIsRoot: first() === deep.n.fid, selVisible: !!selRow() };
    const pin = document.getElementById('pin-root'); pin.checked = true; pin.dispatchEvent(new Event('change'));
    r.rootPinned = first(); r.pinnedOk = r.rootPinned === deep.n.fid;
    document.getElementById('nav-caller').click(); r.afterCaller = S.selPath; r.pinDroppedOnCaller = S.pinPath === null;
    selectNode(root, isr.tree.fid); document.getElementById('nav-callee').click(); r.afterCallee = S.selPath; r.calleeDepth = S.selPath.split('/').length - 1;
    document.getElementById('nav-next').click(); r.afterNext = S.selPath; r.rootStill = first();
    clearFocus(); return r; });
  step('toggle expand on a box with callees', () => { const p = isr.name + '#' + shownInst(isr).k + withKids.key.slice(isr.name.length); selectNode(p, withKids.n.fid); const before = stats().boxes, wasOpen = isExp(p); toggleExp(p); renderAll(); const after = stats().boxes; toggleExp(p); renderAll(); return { node: withKids.n.name, wasOpen, boxesBefore: before, boxesAfter: after, boxesRestored: stats().boxes }; });
  step('sw depth 1', () => { setSwDepth(1); return { swBoxes: document.querySelectorAll('#sw .nd').length }; });
  step('sw depth 4', () => { setSwDepth(4); return { swBoxes: document.querySelectorAll('#sw .nd').length, swItems: document.querySelectorAll('#sw .it').length }; });
  step('hw depth 1', () => { setHwDepth(1); return { hwBoxes: document.querySelectorAll('#hw .nd').length }; });
  step('hw depth 3', () => { setHwDepth(3); return { hwBoxes: document.querySelectorAll('#hw .nd').length }; });
  const blk = BLOCKS.find(b => b.accessors.length) || BLOCKS[0];
  step('select HW block ' + (blk && blk.id), () => { if (!blk) return {}; selectBlock(blk.id); return { accessors: blk.accessors.length, swDim: swCount('dim'), hwSel: hwCount('sel'), detailRows: document.querySelectorAll('#detail-body table tr').length }; });
  const swn = SWS.nodes.find(n => n.depth === 0 && NODE_FIDS[n.id].size);
  step('select SW node ' + (swn && swn.id), () => { if (!swn) return {}; selectSwNode(swn.id); return { fids: REL.fids.size, blocks: REL.blocks.size, hwRel: hwCount('rel-r') + hwCount('rel-w') + hwCount('rel-rw') + hwCount('rel-c') }; });
  step('clear', () => { clearFocus(); return { rel: REL === null, swDim: swCount('dim'), hwDim: hwCount('dim') }; });
  step('range 1 slot', () => { applyRange({ start: 0, end: SLOT }); return { boxes: stats().boxes, range: document.getElementById('range-info').textContent }; });
  step('range full', () => { applyRange(null); return { boxes: stats().boxes, slots: slotCount.value }; });
  step('view aligned', () => { setView('aligned'); return stats(); });
  step('view 3d', () => { setView('iso'); return stats(); });
  step('pan 3d', () => { const x0 = cam.target.x; setView('right'); const x1 = cam.target.x; setView('pan'); const mode = S.panMode; setView('pan'); setView('up'); const y1 = cam.target.y; return { x0: +x0.toFixed(3), x1: +x1.toFixed(3), panMode: mode, movedY: Math.abs(y1 - cam.target.y) >= 0 }; });
  step('view tilt', () => { setView('tilt'); return stats(); });
  step('reference lines off/on', () => { const all = TI.filter(t => t.id !== 'nw').map(t => t.id); const n0 = stats().refs, d0 = stats().deadlineTicks; setRefs(all); const n1 = stats().refs; setRefs([]); document.getElementById('dl-toggle').checked = false; document.getElementById('dl-toggle').dispatchEvent(new Event('change')); const d1 = stats().deadlineTicks; document.getElementById('dl-toggle').checked = true; document.getElementById('dl-toggle').dispatchEvent(new Event('change')); return { refsAll: n0, refsNone: n1, refsBack: stats().refs, ticks: d0, ticksOff: d1, legend: document.querySelectorAll('#legend .dash').length }; });
  step('nudge 2d', () => { applyRange({ start: 0, end: 2 * SLOT }); const r0 = R0(); setView('right'); const r1 = R0(); setView('left'); const back = R0(); applyRange(null); return { r0: +r0.toFixed(1), r1: +r1.toFixed(1), back: +back.toFixed(1) }; });
  step('core off/on', () => { const cb = ct.querySelector('input'); cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); const a = stats().boxes; cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return { boxesWithCoreOff: a, boxesAll: stats().boxes, checked: S.cores.size }; });
  step('isr filter', () => { setIsrs([isr.name]); const a = stats().boxes, lbl = isrSummary.textContent; setIsrs([]); const none = stats().boxes; setIsrs(null); return { boxesOne: a, boxesNone: none, boxesAll: stats().boxes, summary: lbl }; });
  step('slots 2 from 1', () => { setSlots(1, 2); return { boxes: stats().boxes, from: slotFrom.value, count: slotCount.value, range: document.getElementById('range-info').textContent }; });
  step('slots next', () => { document.getElementById('slot-next').click(); return { from: slotFrom.value, count: slotCount.value, max: slotMax }; });
  step('slots default', () => { setSlots(0, 5); return { from: slotFrom.value, count: slotCount.value, boxes: stats().boxes }; });
  step('overlap 0 / 70', () => { const v = S.view; S.view = 'tilt'; S.overlap = 0; build3D(); const h0 = stats().contentPx; S.overlap = 0.7; build3D(); const h1 = stats().contentPx; S.overlap = 0.5; S.view = v; build3D(); return { contentNoOverlap: h0, contentOverlap70: h1, planes: stats().planes }; });
  step('resize side / windows', () => {
    wrap.style.setProperty('--side-w', '500px'); const w = document.getElementById('side').getBoundingClientRect().width; wrap.style.removeProperty('--side-w');
    const drag = (panelId, dy) => { const h = document.querySelector('#' + panelId + ' > .rz'); const r = h.getBoundingClientRect(); const o = { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 2 };
      h.dispatchEvent(new PointerEvent('pointerdown', o)); h.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, { clientY: r.top + 2 + dy }))); h.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { clientY: r.top + 2 + dy }))); };
    const dragEl = (el, dy) => { const r = el.getBoundingClientRect(); const o = { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 20, clientY: r.top + 2 }; el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, { clientY: r.top + 2 + dy }))); el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { clientY: r.top + 2 + dy }))); };
    const tree = document.getElementById('tree-panel'), t0 = tree.getBoundingClientRect().height; dragEl(document.getElementById('hsplit'), 120); const t1 = tree.getBoundingClientRect().height;
    const sideEl = document.getElementById('side'), sw0 = sideEl.getBoundingClientRect().width; const sp = document.getElementById('splitter'), spr = sp.getBoundingClientRect(); const o2 = { bubbles: true, pointerId: 1, button: 0, clientX: spr.left + 3, clientY: spr.top + 40 }; sp.dispatchEvent(new PointerEvent('pointerdown', o2)); sp.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o2, { clientX: spr.left - 150 }))); sp.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o2, { clientX: spr.left - 150 }))); const sw1 = sideEl.getBoundingClientRect().width; sp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const sw = document.getElementById('sw'), s0 = sw.getBoundingClientRect().height; drag('sw-panel', -40); const s1 = sw.getBoundingClientRect().height;
    const sc0 = sceneEl.getBoundingClientRect().height; drag('scene-panel', 90); const sc1 = sceneEl.getBoundingClientRect().height;
    document.getElementById('hsplit').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); document.querySelector('#sw-panel > .rz').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); document.querySelector('#scene-panel > .rz').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return { sideW: Math.round(w), sideDrag: Math.round(sw1 - sw0), treeBefore: Math.round(t0), treeAfter: Math.round(t1), swBefore: Math.round(s0), swAfter: Math.round(s1), sceneBefore: Math.round(sc0), sceneAfter: Math.round(sc1), handles: document.querySelectorAll('.rz').length }; });
  step('unit us', () => { setUnit('us'); const t = document.getElementById('range-info').textContent; setUnit('sym'); return { text: t }; });
  step('structure tab', () => { document.querySelector('.tabs button[data-tab="structure"]').click(); const r = { dsmRows: document.querySelectorAll('#dsm tbody tr').length, dsmCanvas: !!document.querySelector('#dsm canvas'), ms: renderStructure.ms, tiles: document.querySelectorAll('#tiles .tile').length, lsmNodes: document.querySelectorAll('#lsm .lsm-node').length }; document.querySelector('.tabs button[data-tab="timing"]').click(); return r; });
  step('deep link sel', () => { const f = Object.keys(F)[0]; selectNode(findPath(f), f); return { selFid: S.selFid, selPath: S.selPath }; });
  out.errors = ERRORS.slice();
  out.ok = !out.errors.length && out.steps.every(s => !s.error);
  const pre = document.getElementById('selftest-out'); pre.hidden = false; pre.textContent = JSON.stringify(out, null, 1);
  console.log('SELFTEST ' + JSON.stringify(out));
  return out;
}
window.isrprof = { S, P, REL: () => REL, setRefs, selectVariable, selectIpc, histBack, histForward, selectNode, selectBlock, selectSwNode, clearFocus, setLevel, setDeep, setView, applyRange, setSlots, setIsrs, setCores, setSwDepth, setHwDepth, build3D, renderAll, selfTest, stats: () => build3D.stats };
if (SELFTEST) setTimeout(selfTest, 0);
