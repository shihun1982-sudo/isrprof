// ================================================================== core: data, state, helpers
// Performance notes: every derived structure that does not depend on the selection (flattened call
// trees, call closures, periodic instances per range, label textures) is computed once and cached;
// selection changes only recompute the related set and re-colour what is already on screen.
const P = JSON.parse(document.getElementById('profile-data').textContent);
const NUM = P.numerology, SYM = NUM.symbol_us, SLOT = NUM.slot_us, SPS = NUM.symbols_per_slot;
const W0 = P.window.start_us, W1 = P.window.end_us;
const CORES = [...P.cores].sort((a, b) => a.id - b.id);
const COREIDX = Object.fromEntries(CORES.map((c, i) => [c.id, i]));
const TI = P.timing_items, TIX = Object.fromEntries(TI.map((t, i) => [t.id, Object.assign({ idx: i }, t)]));
const F = P.functions;
const BLOCKS = P.hw.blocks, BX = Object.fromEntries(BLOCKS.map(b => [b.id, b]));
const ST = P.structure;
const SWS = P.sw_structure, SWN = Object.fromEntries(SWS.nodes.map(n => [n.id, n])), TOUCH = SWS.touch || {};
const HWS = P.hw_structure, HWN = Object.fromEntries(HWS.nodes.map(n => [n.id, n]));
const CH = P.channels || { items: [] };
const MODULES = ST.modules.map(m => m.name).concat([...new Set(Object.values(F).map(f => f.module))].filter(m => !ST.modules.some(x => x.name === m)));
const MODIDX = Object.fromEntries(MODULES.map((m, i) => [m, i]));
const ISRX = Object.fromEntries(P.isrs.map(i => [i.name, i]));
const SLICE = {}; P.isrs.forEach(i => { SLICE[i.name] = new Set(i.functions); });
const VARX = Object.fromEntries(P.memory.variables.map(v => [v.key, v]));
// variable lookup: "fid|name" -> variable key
const VKEY = {}; P.memory.variables.forEach(v => v.accessors.forEach(a => { VKEY[a.fid + '|' + v.name] = v.key; }));
// sw node of a function / variable
const FNODE = SWS.fn_node || {}, VNODE = SWS.var_node || {};
// descendants / ancestors of structure nodes (computed once)
function lineage(byId) {
  const anc = {}, desc = {};
  const up = id => { if (anc[id]) return anc[id]; const n = byId[id]; const a = n && n.parent ? [n.parent, ...up(n.parent)] : []; anc[id] = a; return a; };
  Object.keys(byId).forEach(up);
  Object.keys(byId).forEach(id => { desc[id] = []; });
  Object.keys(byId).forEach(id => anc[id].forEach(a => desc[a].push(id)));
  return { anc, desc };
}
const SWL = lineage(SWN), HWL = lineage(HWN);
// functions under a sw node (own + descendants)
const NODE_FIDS = {}; SWS.nodes.forEach(n => { NODE_FIDS[n.id] = new Set(n.functions); SWL.desc[n.id].forEach(d => SWN[d].functions.forEach(f => NODE_FIDS[n.id].add(f))); });

// ---- viewer appearance from the config (`viewer:` section; every value has a default in config.py)
const V = P.viewer || {}, VC = V.colors || {};
const CAT = {
  light: VC.palette_light || ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark:  VC.palette_dark || ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
(function applyViewerStyle() {
  const r = document.documentElement.style;
  [['read', '--read'], ['write', '--write'], ['miss', '--critical'], ['heap', '--serious'], ['accent', '--accent']].forEach(([key, v]) => { if (VC[key]) r.setProperty(v, VC[key]); });
  if (V.theme === 'dark' || V.theme === 'light') document.documentElement.setAttribute('data-theme', V.theme);
})();
const isDark = () => {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
};
const cat = i => (isDark() ? CAT.dark : CAT.light)[((i % 8) + 8) % 8];
const modColor = m => cat(MODIDX[m] == null ? 7 : MODIDX[m]);
const coreColor = id => { const c = CORES[COREIDX[id]]; return c && c.color ? c.color : cat(COREIDX[id] == null ? 0 : COREIDX[id]); };
const chColor = ch => ch.color || (ch.dir === 'ul' ? cat(1) : cat(0));
let _cssCache = {};
const cssVar = n => { if (!(n in _cssCache)) _cssCache[n] = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return _cssCache[n]; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = fid => String(fid).split('@')[0];
const fnOf = fid => F[fid] || null;

// ------------------------------------------------------------------ state
const EXPAND_DEPTH = Math.max(0, +(V.expand_depth == null ? 2 : V.expand_depth));
const S = {
  unit: V.unit === 'us' ? 'us' : 'sym', cores: new Set(CORES.map(c => c.id)), isrs: null,   // isrs: null = all, else Set of ISR names
  refHidden: new Set(), showDeadlines: true,   // reference lines switched off in the controls; HW deadline ticks on / off
  overlap: Math.max(0, Math.min(0.85, +(V.stack_overlap == null ? 0.5 : V.stack_overlap))),   // stacked view: how much a core plane covers the one behind
  level: EXPAND_DEPTH,       // call-tree levels open below the entry (node at depth d is open iff d < level)
  expanded: new Set(),       // explicit opens beyond the level (instance-agnostic paths "ISR/0/2")
  collapsed: new Set(),      // explicit closes inside the level
  selPath: null, selFid: null, deep: true,
  block: null, swNode: null, tab: 'timing',
  inst: {},                  // ISR name -> instance index k shown in the call-graph panel / expanded in 3D
  allInst: false,            // draw the subtree for every periodic instance (expensive for long windows)
  tscale: 1,                 // row-height stretch factor
  range: null,               // {start, end} in us (NW frame) -> the diagram shows only this part of the window
  view: V.default_view === '3d' ? 'persp' : (V.default_view === 'aligned' ? 'aligned' : 'tilt'),   // tilt | aligned | persp
  swDepth: Math.max(1, +((V.sw_structure || {}).depth || SWS.depth || 3)),
  hwDepth: Math.max(1, +((V.hw_structure || {}).depth || HWS.depth || 2)),
  swOpen: new Set((V.sw_structure || {}).open || []), swClosed: new Set(),     // structure diagram: nodes opened beyond / closed inside the depth
  hwOpen: new Set((V.hw_structure || {}).open || []), hwClosed: new Set(),
  dsmCollapsed: new Set(), lsmOpen: new Set(),
};
const DEFAULT_SLOTS = Math.max(1, +(V.default_slots || 5));
if (Array.isArray(V.window_range) && V.window_range.length === 2) S.range = { start: Math.max(W0, V.window_range[0] * SLOT), end: Math.min(W1, V.window_range[1] * SLOT) };
else if ((W1 - W0) / SLOT > DEFAULT_SLOTS + 0.5) { const s0 = Math.max(W0, 0); S.range = { start: s0, end: Math.min(W1, s0 + DEFAULT_SLOTS * SLOT) }; }
let EXPV = 1;                                   // expansion version (cache key for visible-node lists)
const bumpExp = () => { EXPV++; };

const fmt = us => S.unit === 'sym' ? (us / SYM).toFixed(2) + ' sym' : us.toFixed(1) + ' µs';
// absolute time in the NW frame as slot index + offset inside the slot
const fmtAbs = us => { const s = Math.floor(us / SLOT + 1e-9), r = us - s * SLOT; return S.unit === 'us' ? `s${s} +${r.toFixed(1)} µs` : `s${s} +${(r / SYM).toFixed(2)} sym`; };
const visibleIsrs = () => P.isrs.filter(i => S.cores.has(i.core) && (!S.isrs || S.isrs.has(i.name)));
let _sliceAll = null;
function sliceSet() {               // functions reachable from the selected ISRs (null = no filter)
  if (!S.isrs) return null;
  const key = [...S.isrs].sort().join('|');
  if (_sliceAll && _sliceAll.key === key) return _sliceAll.set;
  const set = new Set(); S.isrs.forEach(n => SLICE[n] && SLICE[n].forEach(f => set.add(f)));
  _sliceAll = { key, set }; return set;
}
const inSlice = fid => { const sl = sliceSet(); return !sl || sl.has(fid); };
const R0 = () => S.range ? S.range.start : W0, R1 = () => S.range ? S.range.end : W1;

// ------------------------------------------------------------------ call trees: flattened once, visibility by level
// A path is "ISR#k/i/j": ISR name, instance k (periodic repeat), child indices.  Expansion state ignores k.
function walk(node, path, fn) { fn(node, path); (node.children || []).forEach((c, k) => walk(c, path + '/' + k, fn)); }
P.isrs.forEach(isr => {       // flat node records: {n, key (instance-agnostic path), depth, parent (index), idx}
  const flat = []; const stack = [];
  (function rec(n, key, parent) {
    const rec_ = { n, key, depth: n.depth, parent, idx: flat.length, kids: n.children ? n.children.length : 0 };
    flat.push(rec_);
    (n.children || []).forEach((c, k) => rec(c, key + '/' + k, rec_.idx));
  })(isr.tree, isr.name, -1);
  isr.flat = flat; isr.maxDepth = Math.max(0, ...flat.map(r => r.depth)); isr._vis = null; isr._visV = 0;
});
const expKey = p => p.replace(/#-?\d+/, '');
const isOpen = (key, depth) => S.collapsed.has(key) ? false : (S.expanded.has(key) ? true : depth < S.level);
const isExp = p => isOpen(expKey(p), (nodeAt(p) || { depth: 0 }).depth);
function toggleExp(p) {
  const k = expKey(p), n = nodeAt(p); if (!n) return;
  const open = isOpen(k, n.depth);
  if (open) { S.expanded.delete(k); if (n.depth < S.level) S.collapsed.add(k); }
  else { S.collapsed.delete(k); if (n.depth >= S.level) S.expanded.add(k); }
  bumpExp();
}
const isrOfPath = p => ISRX[p.split('/')[0].split('#')[0]];
const instOfPath = p => { const m = /#(-?\d+)/.exec(p.split('/')[0]); return m ? +m[1] : 0; };
function nodeAt(path) {
  const parts = path.split('/'); const isr = isrOfPath(path); let n = isr && isr.tree;
  for (let i = 1; n && i < parts.length; i++) n = n.children[+parts[i]];
  return n || null;
}
function visibleNodes(isr) {         // flat records whose every ancestor is open (cached per expansion version)
  if (isr._vis && isr._visV === EXPV) return isr._vis;
  const flat = isr.flat, openArr = new Uint8Array(flat.length), out = [];
  for (let i = 0; i < flat.length; i++) {
    const r = flat[i], vis = r.parent < 0 || (openArr[r.parent] === 2);
    if (!vis) { openArr[i] = 0; continue; }
    out.push(r); openArr[i] = (r.kids && isOpen(r.key, r.depth)) ? 2 : 1;
  }
  isr._vis = out; isr._visV = EXPV; return out;
}
const nodeVisible = p => { const isr = isrOfPath(p), k = expKey(p); return visibleNodes(isr).some(r => r.key === k); };
const MAX_INST = Math.max(1, +(V.max_instances || 1500));
function instancesOf(isr) {              // periodic repeats of the ISR inside the configured window
  const base = isr.abs_start_us, span = Math.max(isr.computed_us, isr.length_us || 0);
  if (!isr.period_us) return [{ k: 0, start: base }];
  if (isr._inst) return isr._inst;
  const out = [], kmin = Math.ceil((W0 - base - span) / isr.period_us), kmax = Math.floor((W1 - base) / isr.period_us);
  for (let k = kmin; k <= kmax && out.length < MAX_INST; k++) out.push({ k, start: base + k * isr.period_us });
  isr._inst = out.length ? out : [{ k: 0, start: base }];
  return isr._inst;
}
function shownInst(isr) {           // the instance the call graph / 3D subtree shows: chosen, else the first one inside the time range
  const list = instancesOf(isr), k = S.inst[isr.name];
  return list.find(i => i.k === k) || list.find(i => i.start >= R0() - 1e-6 && i.start <= R1()) || list.find(i => i.k === 0) || list[0];
}
function showSub(isr, k) { return S.allInst || instancesOf(isr).length <= 24 || shownInst(isr).k === k; }
function dlCheck(block, t, core, isrName) {   // same rule as callgraph.check_deadline, for shifted instances
  let best = null, viol = false, note = '';
  for (const d of (BX[block] ? BX[block].deadlines : [])) {
    if (d.cores && !d.cores.includes(core)) continue;
    if (d.isrs && !d.isrs.includes(isrName)) continue;
    const inst = d.period_us ? d.offset_us + Math.floor((t - d.offset_us) / d.period_us) * d.period_us + d.at_us : d.abs_us;
    const v = t > inst + 1e-6;
    if (best == null || inst < best || (v && !viol)) { best = inst; viol = viol || v; note = d.note; }
  }
  return { deadline_us: best, violation: viol, note };
}
function shiftEv(e, dt, isr) {
  if (!dt) return e;
  const t = e.t_us + dt, c = dlCheck(e.block, t, isr.core, isr.name);
  return Object.assign({}, e, { t_us: t, deadline_us: c.deadline_us, violation: c.violation, deadline_note: c.note });
}
const nodeEvents = (n, isr, k) => { const dt = k * (isr.period_us || 0); return n.hw_events.map(e => shiftEv(e, dt, isr)); };
const evKey = e => `${e.isr}|${e.fid}|${e.line}|${e.t_us.toFixed(3)}`;
// time of a sequenced event (variable / IPC / heap touch) inside a function instance
function evTimeInFn(n, dt, seq) { const f = fnOf(n.fid); const ns = f ? f.n_seq : 1; return n.start_us + dt + n.self_us * Math.min(seq, ns) / Math.max(ns, 1); }

// ------------------------------------------------------------------ focus / relations
// The selected function (S.selFid, optionally with a call-tree path) defines a focus set: itself, or in
// deep mode its static call closure down to the leaves.  Every panel highlights what that set touches.
const _closure = new Map();
function closure(fid) {
  if (_closure.has(fid)) return _closure.get(fid);
  const set = new Set([fid]), q = [fid];
  while (q.length) {
    const f = fnOf(q.pop()); if (!f) continue;
    for (const c of f.calls) {
      const ids = c.indirect ? (c.callee_ids || []) : [c.callee_id || c.callee];
      ids.forEach(id => { if (id && !set.has(id)) { set.add(id); q.push(id); } });
    }
  }
  _closure.set(fid, set); return set;
}
function focusFids() {
  if (S.selFid) return S.deep ? closure(S.selFid) : new Set([S.selFid]);
  if (S.swNode) return NODE_FIDS[S.swNode] || new Set();
  return null;
}
function inFocus(path, fid) {            // instance-agnostic: the same subtree in every periodic instance
  if (!S.selFid && !S.swNode) return true;
  if (S.selPath && path) { const a = expKey(path), b = expKey(S.selPath); return S.deep ? (a === b || a.startsWith(b + '/')) : a === b; }
  return focusFids().has(fid);
}
const mergeRw = (a, b) => { if (!a || a === 'x') return b; if (!b || b === 'x') return a; if (a === b) return a; if (a === 'c' || b === 'c') return a === 'c' ? b : a; return 'rw'; };
let REL = null;
function computeRel() {
  const fs = focusFids(); if (!fs) return null;
  const events = [], selIsr = S.selPath ? isrOfPath(S.selPath) : null;
  visibleIsrs().forEach(isr => {
    const k = (selIsr && selIsr.name === isr.name) ? instOfPath(S.selPath) : shownInst(isr).k;
    const pfx = isr.name + '#' + k;
    for (const r of isr.flat) if (inFocus(pfx + r.key.slice(isr.name.length), r.n.fid)) events.push(...nodeEvents(r.n, isr, k));
  });
  const r = { fids: fs, events, evKeys: new Set(events.map(evKey)), blocks: new Map(), sw: new Map(), vars: new Map(), ipc: new Map(), heap: [], modules: new Set(), cores: new Set() };
  const acc = (block, reg, kind, viol) => { const b = r.blocks.get(block) || { r: 0, w: 0, miss: 0, regs: new Map() }; if (kind === 'read') b.r++; else b.w++; if (viol) b.miss++; const rg = b.regs.get(reg) || { n: 0, r: 0, w: 0, miss: 0 }; rg.n++; if (kind === 'read') rg.r++; else rg.w++; if (viol) rg.miss++; b.regs.set(reg, rg); r.blocks.set(block, b); };
  if (events.length) events.forEach(e => acc(e.block, e.reg, e.kind, e.violation));
  else fs.forEach(f => { const fn = fnOf(f); if (fn) fn.hw.forEach(h => acc(h.block, h.reg, h.kind, false)); });   // not reached by a visible ISR: static view
  fs.forEach(f => {
    const fn = fnOf(f); if (!fn) return;
    r.modules.add(fn.module); if (fn.core != null) r.cores.add(fn.core);
    (TOUCH[f] || []).forEach(([nid, rw]) => { const t = r.sw.get(nid) || { rw: null, fids: new Set() }; t.rw = mergeRw(t.rw, rw); t.fids.add(f); r.sw.set(nid, t); });
  });
  // containing nodes of touched nodes light up as "contains" (so collapsed ancestors still show the hit)
  [...r.sw.keys()].forEach(nid => SWL.anc[nid].forEach(a => { if (!r.sw.has(a)) r.sw.set(a, { rw: 'c', fids: new Set() }); }));
  P.memory.variables.forEach(v => { const a = v.accessors.filter(x => fs.has(x.fid)); if (a.length) r.vars.set(v.key, { v, rw: [...new Set(a.map(x => x.rw))], fids: [...new Set(a.map(x => x.fid))] }); });
  P.memory.ipc_ops.forEach(o => { if (fs.has(o.fid)) { const c = r.ipc.get(o.channel) || []; c.push(o); r.ipc.set(o.channel, c); } });
  P.memory.heap_users.forEach(u => { if (fs.has(u.fid)) r.heap.push(u); });
  // HW ancestors
  r.hw = new Map();
  r.blocks.forEach((b, id) => { r.hw.set(id, b); (HWL.anc[id] || []).forEach(a => { if (!r.hw.has(a)) r.hw.set(a, { r: 0, w: 0, miss: 0, regs: new Map(), c: true }); }); });
  return r;
}
// "is this function related to the current selection" (focus set, or the selected HW block's accessors)
const hl = fid => (!REL || REL.fids.has(fid)) && (!S.block || (BX[S.block] && BX[S.block].accessors.includes(fid)));
function clearFocus() { S.selFid = null; S.selPath = null; S.block = null; S.swNode = null; renderAll({ light: true }); }
function selectNode(path, fid) { S.selPath = path; S.selFid = fid; S.block = null; S.swNode = null; if (path) S.inst[isrOfPath(path).name] = instOfPath(path); renderAll({ light: true }); }
function selectBlock(id) { S.block = S.block === id ? null : id; S.selFid = null; S.selPath = null; S.swNode = null; renderAll({ light: true }); }
function selectSwNode(id) { S.swNode = S.swNode === id ? null : id; S.selFid = null; S.selPath = null; S.block = null; renderAll({ light: true }); }
function setDeep(d) { S.deep = d; document.getElementById('focus-self').setAttribute('aria-pressed', !d); document.getElementById('focus-deep').setAttribute('aria-pressed', d); renderAll({ light: true }); }
function setLevel(l) { S.level = Math.max(0, Math.min(30, l | 0)); S.expanded.clear(); S.collapsed.clear(); bumpExp(); document.getElementById('level').value = S.level; renderAll(); }
function applyRange(r) { S.range = r; build3D.fitted = false; renderAll(); }
function findPath(fid) {                 // first visible instance path of a function
  for (const i of visibleIsrs()) { const k = shownInst(i).k; const r = i.flat.find(x => x.n.fid === fid); if (r) return i.name + '#' + k + r.key.slice(i.name.length); }
  return null;
}

// ------------------------------------------------------------------ tooltip
const tip = document.getElementById('tip');
function showTip(html, x, y) {
  tip.innerHTML = html; tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(x + 14, window.innerWidth - r.width - 8) + 'px';
  tip.style.top = Math.min(y + 14, window.innerHeight - r.height - 8) + 'px';
}
function hideTip() { tip.style.display = 'none'; }
function nodeTip(node, isr, path) {
  const k = instOfPath(path), dt = k * (isr.period_us || 0), f = fnOf(node.fid), evs = nodeEvents(node, isr, k);
  const viol = evs.filter(e => e.violation).length, nInst = instancesOf(isr).length;
  const sw = (TOUCH[node.fid] || []).filter(([id, rw]) => rw !== 'x').map(([id, rw]) => `${SWN[id] ? SWN[id].name : id} [${rw}]`);
  return `<span class="mono"><b>${esc(node.name)}</b>${node.external ? ' <span class="b ext">external</span>' : ''}${node.recursive ? ' <span class="b x">recursion cut</span>' : ''}${node.via_table ? ' <span class="b">via ' + esc(node.via_table) + ' table</span>' : ''}</span>` +
    `<span class="m">${esc(isr.name)}${nInst > 1 ? ` · instance ${k} of ${nInst}` : ''} · depth ${node.depth}${f ? ' · ' + esc(SWN[FNODE[node.fid]] ? SWN[FNODE[node.fid]].name : f.module) + ' · ' + esc(f.file) + ':' + f.line : ''}</span>` +
    (f && f.note ? `<span class="m">📝 ${esc(f.note)}</span>` : '') +
    `<span class="mono">start ${fmtAbs(node.start_us + dt)} · self ${fmt(node.self_us)} · total ${fmt(node.total_us)}</span>` +
    (evs.length ? `<span class="mono">HW: ${evs.map(e => `${e.block}.${e.reg} ${e.kind[0].toUpperCase()}`).join(', ')}${viol ? ` <span class="b x">${viol} deadline miss</span>` : ''}</span>` : '') +
    (sw.length ? `<span class="mono">SW: ${sw.map(esc).join(', ')}</span>` : '') +
    (node.children.length ? `<span class="m">${node.children.length} callee${node.children.length > 1 ? 's' : ''} · click to ${isExp(path) ? 'collapse' : 'expand'}</span>` : '');
}
function evTip(e) {
  return `<span class="mono"><b>${e.block}.${e.reg}</b> ${e.kind} <span class="m">(${e.macro})</span></span><span class="m">${esc(e.func)} line ${e.line} · ${esc(e.isr)}</span>` +
    `<span class="mono">t = ${fmtAbs(e.t_us)}</span>` +
    (e.deadline_us != null ? `<span class="mono" style="color:${e.violation ? 'var(--critical)' : 'var(--good)'}">deadline ${fmtAbs(e.deadline_us)} · ${e.violation ? 'MISSED by ' + fmt(e.t_us - e.deadline_us) : 'met, margin ' + fmt(e.deadline_us - e.t_us)}</span>` : '<span class="m">no deadline configured</span>') +
    (e.deadline_note ? `<span class="m">${esc(e.deadline_note)}</span>` : '');
}
function blockTip(b) {
  const evs = visibleIsrs().flatMap(i => i.hw_events.filter(e => e.block === b.id));
  return `<span class="mono"><b>${esc(b.name)}</b> <span class="m">${b.id} @ ${esc(b.base)} · ${esc((TIX[b.line] || TIX.nw || {}).name || '')}</span></span>` +
    (b.note ? `<span class="m">📝 ${esc(b.note)}</span>` : '') +
    `<span class="mono">per execution: ${evs.filter(e => e.kind === 'read').length} reads · ${evs.filter(e => e.kind !== 'read').length} writes · ${evs.filter(e => e.violation).length} deadline miss</span>` +
    `<span class="m">accessed by ${b.accessors.map(short).join(', ') || '—'}</span><span class="m">click to highlight its accessors everywhere</span>`;
}
