// ================================================================== orchestration, controls, deep links
function renderAll() {
  REL = computeRel();
  document.getElementById('focus-info').textContent = REL
    ? `${short(S.selFid)} → ${REL.fids.size} fn · ${REL.blocks.size} HW block${REL.blocks.size === 1 ? '' : 's'} · ${REL.vars.size} var${REL.vars.size === 1 ? '' : 's'} · ${REL.ipc.size} ipc`
    : (S.block ? `HW ${S.block} ← ${BX[S.block].accessors.length} functions` : 'nothing selected');
  document.getElementById('range-info').textContent = `${fmtAbs(R0())} → ${fmtAbs(R1())} · ${((R1() - R0()) / SLOT).toFixed(2)} slot${S.range ? '' : ' (full window)'}`;
  renderSW(); renderTree(); renderDetail(); renderHW();
  if (S.tab === 'timing') build3D(); else renderStructure();
}

document.getElementById('proj').textContent = P.project.name;
document.getElementById('hdr-chips').innerHTML =
  `<span class="chip">µ=<b>${NUM.mu}</b></span><span class="chip">slot <b>${SLOT.toFixed(1)} µs</b></span><span class="chip">symbol <b>${SYM.toFixed(2)} µs</b></span>` +
  `<span class="chip">window <b>${((W1 - W0) / SLOT).toFixed(1)} slots</b></span><span class="chip">files <b>${P.parse_stats.files}</b></span>` +
  `<span class="chip">functions <b>${P.parse_stats.functions}</b></span><span class="chip">ISRs <b>${P.isrs.length}</b></span><span class="chip">LLM <b>${P.llm.enabled ? P.llm.model : 'off'}</b></span>`;
document.getElementById('foot').textContent =
  `isrprof ${P.tool.version} · window ${fmtAbs(W0)} … ${fmtAbs(W1)} · timing lanes: ` +
  TI.map(t => `${t.name} (${t.offset_us >= 0 ? '+' : ''}${(t.offset_us / SYM).toFixed(2)} sym)`).join(', ') + (P.llm.log.length ? ' · LLM: ' + P.llm.log.join('; ') : '');

const ct = document.getElementById('core-toggles');
ct.innerHTML = CORES.map(c => `<button class="tog" data-core="${c.id}" aria-pressed="true"><i class="sw" style="background:${coreColor(c.id)}"></i>${esc(c.name)}</button>`).join(' ');
ct.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = +b.dataset.core;
  if (S.cores.has(id)) { if (S.cores.size > 1) S.cores.delete(id); } else S.cores.add(id);
  b.setAttribute('aria-pressed', S.cores.has(id)); build3D.fitted = false; renderAll();
});
const sel = document.getElementById('isr-sel');
sel.innerHTML = '<option value="ALL">All ISRs</option>' + P.isrs.map(i => `<option value="${esc(i.name)}">core${i.core} · ${esc(i.name)}</option>`).join('');
sel.addEventListener('change', () => { S.isr = sel.value; build3D.fitted = false; renderAll(); });
function setUnit(u) { S.unit = u; document.getElementById('unit-sym').setAttribute('aria-pressed', u === 'sym'); document.getElementById('unit-us').setAttribute('aria-pressed', u === 'us'); renderAll(); }
document.getElementById('unit-sym').onclick = () => setUnit('sym');
document.getElementById('unit-us').onclick = () => setUnit('us');
document.getElementById('exp-all').onclick = () => { visibleIsrs().forEach(i => walk(i.tree, i.name, (n, p) => S.expanded.add(p))); renderAll(); };
document.getElementById('col-all').onclick = () => { visibleIsrs().forEach(i => walk(i.tree, i.name, (n, p) => { if (p !== i.name) S.expanded.delete(p); })); renderAll(); };
document.getElementById('inst-all').onclick = () => { S.allInst = !S.allInst; document.getElementById('inst-all').setAttribute('aria-pressed', S.allInst); renderAll(); };
document.getElementById('focus-self').onclick = () => setDeep(false);
document.getElementById('focus-deep').onclick = () => setDeep(true);
document.getElementById('focus-clear').onclick = clearFocus;
document.getElementById('range-full').onclick = () => applyRange(null);
document.getElementById('tscale').addEventListener('input', e => { S.tscale = Math.pow(2, +e.target.value); build3D.fitted = false; if (S.tab === 'timing') build3D(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') clearFocus(); });
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  S.tab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
  document.getElementById('tab-timing').hidden = S.tab !== 'timing';
  document.getElementById('tab-structure').hidden = S.tab !== 'structure';
  if (S.tab === 'structure') renderStructure(); else { resize3D(); build3D(); }
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
document.getElementById('panels-collapse').onclick = () => panels.forEach(d => { d.open = false; });
document.getElementById('panels-expand').onclick = () => panels.forEach(d => { d.open = true; });

init3D();
if (have3D) resize3D();
// deep links (tokens joined with "--"):  structure | sel-<function or ISR> (callees included) | selonly-<name>
//   | range-<startSlot>~<endSlot> | view-3d      e.g.  #sel-DL_PDSCH_ISR--range-0.9~1.3--view-3d
location.hash.replace(/^#/, '').split('--').forEach(tok => {
  if (tok === 'debug') window.ISRPROF_DEBUG = 1;        // console diagnostics for the scene / camera
  if (tok === 'structure') document.querySelector('.tabs button[data-tab="structure"]').click();
  if (tok === 'view-3d') { S.view = 'persp'; cam.theta = 0.35; cam.phi = 1.25; }
  if (tok === 'view-tilt') S.view = 'tilt';
  if (tok === 'view-aligned') S.view = 'aligned';
  const m = /^sel(only)?-([A-Za-z0-9_.~]+)$/.exec(tok);
  if (m) {
    S.deep = !m[1]; document.getElementById('focus-self').setAttribute('aria-pressed', !S.deep); document.getElementById('focus-deep').setAttribute('aria-pressed', S.deep);
    const name = m[2], isr = ISRX[name] || P.isrs.find(i => i.entry === name);
    const fid = isr ? isr.tree.fid : (F[name] ? name : Object.keys(F).find(k => short(k) === name));
    if (fid) { S.selFid = fid; S.selPath = isr ? isr.name + '#' + shownInst(isr).k : findPath(fid); REL = computeRel(); autoOpenModules(); }
  }
  const r = /^range-(-?[\d.]+)~(-?[\d.]+)$/.exec(tok);
  if (r) S.range = { start: Math.max(W0, +r[1] * SLOT), end: Math.min(W1, +r[2] * SLOT) };
});
if (have3D) markViews();
renderAll();
if (have3D) { resize3D(); build3D(); }
const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
if (mq && mq.addEventListener) mq.addEventListener('change', renderAll);
new MutationObserver(renderAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { renderSW(); if (S.tab === 'structure') renderStructure(); else build3D(); }, 150); });
