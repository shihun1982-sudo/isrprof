// ================================================================== core: data, state, helpers
const P = JSON.parse(document.getElementById('profile-data').textContent);
const NUM = P.numerology, SYM = NUM.symbol_us, SLOT = NUM.slot_us, SPS = NUM.symbols_per_slot;
const W0 = P.window.start_us, W1 = P.window.end_us;
const CORES = [...P.cores].sort((a, b) => a.id - b.id);
const COREIDX = Object.fromEntries(CORES.map((c, i) => [c.id, i]));
const TI = P.timing_items, TIX = Object.fromEntries(TI.map((t, i) => [t.id, Object.assign({ idx: i }, t)]));
const F = P.functions;
const BLOCKS = P.hw.blocks, BX = Object.fromEntries(BLOCKS.map(b => [b.id, b]));
const ST = P.structure;
const MODULES = ST.modules.map(m => m.name).concat([...new Set(Object.values(F).map(f => f.module))].filter(m => !ST.modules.some(x => x.name === m)));
const MODIDX = Object.fromEntries(MODULES.map((m, i) => [m, i]));
const ISRX = Object.fromEntries(P.isrs.map(i => [i.name, i]));
const SLICE = {}; P.isrs.forEach(i => { SLICE[i.name] = new Set(i.functions); });
// variable lookup: "fid|name" -> variable key "name|file" (the key used by the SW panel and the strips)
const VKEY = {}; P.memory.variables.forEach(v => v.accessors.forEach(a => { VKEY[a.fid + '|' + v.name] = v.name + '|' + v.file; }));
const VARX = Object.fromEntries(P.memory.variables.map(v => [v.name + '|' + v.file, v]));

// ---- viewer appearance from the config (`viewer:` section; every value has a default in config.py)
const V = P.viewer || {}, VC = V.colors || {}, VG = V.groups || {};
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
const coreColor = id => cat(COREIDX[id] == null ? 0 : COREIDX[id]);
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = fid => String(fid).split('@')[0];
const fnOf = fid => F[fid] || null;

// ------------------------------------------------------------------ state
const S = {
  unit: V.unit === 'us' ? 'us' : 'sym', cores: new Set(CORES.map(c => c.id)), isr: 'ALL',
  expanded: new Set(),       // instance-agnostic call-tree paths ("ISR/0/2") that are expanded
  selPath: null, selFid: null, deep: true,
  swOpen: new Set(), dsmCollapsed: new Set(), lsmOpen: new Set(), block: null, tab: 'timing', hoverVar: null,
  inst: {},                  // ISR name -> instance index k shown in the call-graph panel / expanded in 3D
  allInst: false,            // draw the subtree for every periodic instance (expensive for long windows)
  tscale: 1,                 // row-height / time-axis stretch factor
  range: null,               // {start, end} in us (NW frame) -> the diagram shows only this part of the window
  view: V.default_view === '3d' ? 'persp' : (V.default_view === 'tilt' ? 'tilt' : 'aligned'),   // aligned | tilt | persp
  stripOpen: new Set(['modules', 'vars', 'ipc', 'heap', 'blocks'].filter(g => !VG[g] || VG[g].open !== false)),
  stripFn: new Set(), stripReg: new Set(), stripField: new Set(),   // modules -> functions, blocks -> registers, structures -> fields
  varsAll: !!(VG.vars && VG.vars.all),   // SW structure rows: show every touched variable (default: cross-core + related only)
};
const EXPAND_DEPTH = Math.max(1, +(V.expand_depth || 2));
P.isrs.forEach(i => walk(i.tree, i.name, (n, p) => { if (n.depth < EXPAND_DEPTH) S.expanded.add(p); }));
if (VG.modules && VG.modules.functions) MODULES.forEach(m => S.stripFn.add(m));
if (VG.blocks && VG.blocks.registers) BLOCKS.forEach(b => S.stripReg.add(b.id));
((V.sw_structure || {}).open_modules || []).forEach(m => CORES.forEach(c => S.swOpen.add(c.id + '|' + m)));
if (Array.isArray(V.window_range) && V.window_range.length === 2) S.range = { start: Math.max(W0, V.window_range[0] * SLOT), end: Math.min(W1, V.window_range[1] * SLOT) };

const fmt = us => S.unit === 'sym' ? (us / SYM).toFixed(2) + ' sym' : us.toFixed(1) + ' µs';
// absolute time in the NW frame as slot index + offset inside the slot
const fmtAbs = us => { const s = Math.floor(us / SLOT + 1e-9), r = us - s * SLOT; return S.unit === 'us' ? `s${s} +${r.toFixed(1)} µs` : `s${s} +${(r / SYM).toFixed(2)} sym`; };
const visibleIsrs = () => P.isrs.filter(i => S.cores.has(i.core) && (S.isr === 'ALL' || i.name === S.isr));
const inSlice = fid => S.isr === 'ALL' ? true : SLICE[S.isr].has(fid);
const R0 = () => S.range ? S.range.start : W0, R1 = () => S.range ? S.range.end : W1;

// ------------------------------------------------------------------ call-tree paths & periodic instances
// A path is "ISR#k/i/j": ISR name, instance k (periodic repeat), child indices.  Expansion state ignores k.
// (walk is a function declaration so the state block above can already use it)
function walk(node, path, fn) { fn(node, path); (node.children || []).forEach((c, k) => walk(c, path + '/' + k, fn)); }
const expKey = p => p.replace(/#-?\d+/, '');
const isExp = p => S.expanded.has(expKey(p));
function toggleExp(p) { const k = expKey(p); if (S.expanded.has(k)) S.expanded.delete(k); else S.expanded.add(k); }
const isrOfPath = p => ISRX[p.split('/')[0].split('#')[0]];
const instOfPath = p => { const m = /#(-?\d+)/.exec(p.split('/')[0]); return m ? +m[1] : 0; };
function nodeAt(path) {
  const parts = path.split('/'); const isr = isrOfPath(path); let n = isr && isr.tree;
  for (let i = 1; n && i < parts.length; i++) n = n.children[+parts[i]];
  return n || null;
}
function nodeVisible(p) {   // every ancestor expanded?
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) if (!isExp(parts.slice(0, i).join('/'))) return false;
  return true;
}
const MAX_INST = Math.max(1, +(V.max_instances || 1500));
function instancesOf(isr) {              // periodic repeats of the ISR inside the configured window
  const base = isr.abs_start_us, span = Math.max(isr.computed_us, isr.length_us || 0);
  if (!isr.period_us) return [{ k: 0, start: base }];
  const out = [], kmin = Math.ceil((W0 - base - span) / isr.period_us), kmax = Math.floor((W1 - base) / isr.period_us);
  for (let k = kmin; k <= kmax && out.length < MAX_INST; k++) out.push({ k, start: base + k * isr.period_us });
  return out.length ? out : [{ k: 0, start: base }];
}
function shownInst(isr) { const list = instancesOf(isr), k = S.inst[isr.name]; return list.find(i => i.k === k) || list.find(i => i.k === 0) || list[0]; }
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

// ------------------------------------------------------------------ focus / relations
// The selected function (S.selFid, optionally with a call-tree path) defines a focus set: itself, or in
// deep mode its static call closure down to the leaves.  Every panel highlights what that set touches.
function closure(fid) {
  const set = new Set([fid]), q = [fid];
  while (q.length) {
    const f = fnOf(q.pop()); if (!f) continue;
    for (const c of f.calls) {
      const ids = c.indirect ? (c.callee_ids || []) : [c.callee_id || c.callee];
      ids.forEach(id => { if (id && !set.has(id)) { set.add(id); q.push(id); } });
    }
  }
  return set;
}
const focusFids = () => S.selFid ? (S.deep ? closure(S.selFid) : new Set([S.selFid])) : null;
function inFocus(path, fid) {            // instance-agnostic: the same subtree in every periodic instance
  if (!S.selFid) return true;
  if (S.selPath && path) { const a = expKey(path), b = expKey(S.selPath); return S.deep ? (a === b || a.startsWith(b + '/')) : a === b; }
  return focusFids().has(fid);
}
let REL = null;
function computeRel() {
  const fs = focusFids(); if (!fs) return null;
  const events = [], selIsr = S.selPath ? isrOfPath(S.selPath) : null;
  visibleIsrs().forEach(isr => {
    const k = (selIsr && selIsr.name === isr.name) ? instOfPath(S.selPath) : shownInst(isr).k;
    walk(isr.tree, isr.name + '#' + k, (n, p) => { if (inFocus(p, n.fid)) events.push(...nodeEvents(n, isr, k)); });
  });
  const r = { fids: fs, events, evKeys: new Set(events.map(evKey)), blocks: new Map(), vars: new Map(), ipc: new Map(), heap: [], modules: new Set(), cores: new Set() };
  const acc = (block, reg, kind, viol) => { const b = r.blocks.get(block) || { r: 0, w: 0, miss: 0, regs: new Map() }; if (kind === 'read') b.r++; else b.w++; if (viol) b.miss++; b.regs.set(reg, (b.regs.get(reg) || 0) + 1); r.blocks.set(block, b); };
  if (events.length) events.forEach(e => acc(e.block, e.reg, e.kind, e.violation));
  else fs.forEach(f => { const fn = fnOf(f); if (fn) fn.hw.forEach(h => acc(h.block, h.reg, h.kind, false)); });   // not reached by a visible ISR: static view
  fs.forEach(f => { const fn = fnOf(f); if (!fn) return; r.modules.add(fn.module); if (fn.core != null) r.cores.add(fn.core); });
  P.memory.variables.forEach(v => { const a = v.accessors.filter(x => fs.has(x.fid)); if (a.length) r.vars.set(v.name + '|' + v.file, { v, rw: [...new Set(a.map(x => x.rw))], fids: [...new Set(a.map(x => x.fid))] }); });
  P.memory.ipc_ops.forEach(o => { if (fs.has(o.fid)) { const c = r.ipc.get(o.channel) || []; c.push(o); r.ipc.set(o.channel, c); } });
  P.memory.heap_users.forEach(u => { if (fs.has(u.fid)) r.heap.push(u); });
  return r;
}
// "is this function related to the current selection" (focus set, or the selected HW block's accessors)
const hl = fid => (!REL || REL.fids.has(fid)) && (!S.block || (BX[S.block] && BX[S.block].accessors.includes(fid)));
function autoOpenModules() { if (REL) REL.fids.forEach(f => { const fn = fnOf(f); if (fn) S.swOpen.add((fn.core == null ? CORES[0].id : fn.core) + '|' + fn.module); }); }
function clearFocus() { S.selFid = null; S.selPath = null; S.block = null; S.selVar = null; renderAll(); }
function selectNode(path, fid) { S.selPath = path; S.selFid = fid; S.block = null; S.selVar = null; if (path) S.inst[isrOfPath(path).name] = instOfPath(path); REL = computeRel(); autoOpenModules(); renderAll(); }
function selectBlock(id) { S.block = S.block === id ? null : id; S.selFid = null; S.selPath = null; S.selVar = null; renderAll(); }
// variable / structure selection: pin its edges in the SW structure, open the modules of its users, show it in Details
function selectVar(key) {
  S.selVar = key; S.hoverVar = key;
  if (key && VARX[key]) VARX[key].accessors.forEach(a => { const f = fnOf(a.fid); if (f) S.swOpen.add((f.core == null ? CORES[0].id : f.core) + '|' + f.module); });
  renderAll();
}
function setDeep(d) { S.deep = d; document.getElementById('focus-self').setAttribute('aria-pressed', !d); document.getElementById('focus-deep').setAttribute('aria-pressed', d); REL = computeRel(); autoOpenModules(); renderAll(); }
function applyRange(r) { S.range = r; build3D.fitted = false; renderAll(); }
function findPath(fid) {                 // first visible instance path of a function
  let found = null;
  visibleIsrs().forEach(i => { if (found) return; const k = shownInst(i).k; walk(i.tree, i.name + '#' + k, (n, p) => { if (!found && n.fid === fid) found = p; }); });
  return found;
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
  return `<span class="mono"><b>${esc(node.name)}</b>${node.external ? ' <span class="b ext">external</span>' : ''}${node.recursive ? ' <span class="b x">recursion cut</span>' : ''}${node.via_table ? ' <span class="b">via ' + esc(node.via_table) + ' table</span>' : ''}</span>` +
    `<span class="m">${esc(isr.name)}${nInst > 1 ? ` · instance ${k} of ${nInst}` : ''} · depth ${node.depth}${f ? ' · ' + esc(f.module) + ' · ' + esc(f.file) + ':' + f.line : ''}</span>` +
    (f && f.note ? `<span class="m">📝 ${esc(f.note)}</span>` : '') +
    `<span class="mono">start ${fmtAbs(node.start_us + dt)} · self ${fmt(node.self_us)} · total ${fmt(node.total_us)}</span>` +
    (evs.length ? `<span class="mono">HW: ${evs.map(e => `${e.block}.${e.reg} ${e.kind[0].toUpperCase()}`).join(', ')}${viol ? ` <span class="b x">${viol} deadline miss</span>` : ''}</span>` : '') +
    (node.children.length ? `<span class="m">${node.children.length} callee${node.children.length > 1 ? 's' : ''} · click to ${isExp(path) ? 'collapse' : 'expand'} · double-click to centre</span>` : '');
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
