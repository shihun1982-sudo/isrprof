// ================================================================== impact analysis (Structure101-style "what depends on this")
// Built on the static call graph (incl. resolved indirect / virtual targets), the variable accessors and the
// timed HW events: callers (used by), producers / consumers of the variables a function touches, what breaks
// or becomes unreachable when a function is removed, and what changes when a function moves to another ISR
// (register-write deadlines re-checked at the new time, variable update order before / after).
const IX = { built: false, callers: {}, times: {}, varTimes: {}, roots: [] };
function buildIndexes() {
  if (IX.built) return;
  IX.callers = {}; IX.times = {}; IX.varTimes = {};
  Object.values(F).forEach(f => f.calls.forEach(c => { const ids = c.indirect ? c.callee_ids : (c.callee_id ? [c.callee_id] : []); ids.forEach(id => { (IX.callers[id] = IX.callers[id] || []).push({ fid: f.id, line: c.line, kind: c.kind || (c.indirect ? 'indirect' : 'direct') }); }); }));
  P.isrs.forEach(isr => isr.flat.forEach(r => { (IX.times[r.n.fid] = IX.times[r.n.fid] || []).push({ isr, path: isr.name + '#0' + r.key.slice(isr.name.length), t0: r.n.start_us, t1: r.n.start_us + r.n.total_us, self: r.n.self_us, n: r.n, depth: r.depth }); }));
  Object.values(F).forEach(f => (IX.times[f.id] || []).forEach(tm => f.vars.forEach(v => { const key = VKEY[f.id + '|' + v.name]; if (!key) return; (IX.varTimes[key] = IX.varTimes[key] || []).push({ fid: f.id, rw: v.rw, member: v.member, t: evTimeInFn(tm.n, 0, v.seq), isr: tm.isr, core: tm.isr.core }); })));
  IX.roots = P.isrs.map(i => i.tree.fid);
  IX.built = true;
}
const callersOf = fid => IX.callers[fid] || [];
function transitiveCallers(fid) {        // every function that can reach fid, grouped by ISR root
  const seen = new Set(), q = [fid];
  while (q.length) { const x = q.pop(); callersOf(x).forEach(c => { if (!seen.has(c.fid)) { seen.add(c.fid); q.push(c.fid); } }); }
  return seen;
}
function reachableWithout(removed) {     // functions reachable from the ISR entries when `removed` is gone
  const seen = new Set(), q = IX.roots.filter(r => r !== removed);
  q.forEach(r => seen.add(r));
  while (q.length) { const f = fnOf(q.pop()); if (!f) continue; f.calls.forEach(c => (c.indirect ? c.callee_ids : (c.callee_id ? [c.callee_id] : [])).forEach(id => { if (id !== removed && !seen.has(id)) { seen.add(id); q.push(id); } })); }
  return seen;
}
const inSlot = t => ((t % SLOT) + SLOT) % SLOT;     // time inside the slot (every periodic instance repeats the same order)
const fnLink = fid => `<span class="fnb" data-fid="${esc(fid)}" style="cursor:pointer"><b>${esc(short(fid))}</b></span>`;
const isrOfFn = fid => [...new Set((IX.times[fid] || []).map(t => t.isr.name))];

function impactUsedBy(fid) {
  const direct = callersOf(fid), trans = transitiveCallers(fid), f = fnOf(fid);
  let h = `<div class="imp-h">Direct callers <span class="cnt">${direct.length}</span></div>`;
  h += direct.length ? `<table class="t"><tr><th>caller</th><th>kind</th><th>line</th><th>runs in</th></tr>${direct.map(c => `<tr><td>${fnLink(c.fid)}</td><td>${esc(c.kind)}</td><td>${c.line}</td><td>${isrOfFn(c.fid).join(', ') || '—'}</td></tr>`).join('')}</table>` : '<div class="muted">no caller (ISR entry or dead code)</div>';
  h += `<div class="imp-h">Reached from <span class="cnt">${trans.size} functions · ${isrOfFn(fid).length} ISRs</span></div><div class="fnlist">${[...trans].filter(x => IX.roots.includes(x)).map(fnLink).join(' ')}${[...trans].filter(x => !IX.roots.includes(x)).map(x => `<span class="b ext fnb" data-fid="${esc(x)}" style="cursor:pointer">${esc(short(x))}</span>`).join(' ')}</div>`;
  // producers / consumers through shared variables
  const rows = [];
  f.vars.forEach(v => { const key = VKEY[f.id + '|' + v.name]; if (!key) return; const w = v.rw !== 'r' && v.rw !== 'addr'; (IX.varTimes[key] || []).filter(o => o.fid !== fid && (w ? o.rw === 'r' || o.rw === 'rw' : o.rw !== 'r' && o.rw !== 'addr')).forEach(o => rows.push({ var: v.name + (v.member ? '.' + v.member : ''), role: w ? 'consumer' : 'producer', other: o.fid, isr: o.isr.name, core: o.core, t: o.t })); });
  const seen = new Set(), uniq = rows.filter(r => { const k = r.var + '|' + r.role + '|' + r.other + '|' + r.isr; if (seen.has(k)) return false; seen.add(k); return true; });
  h += `<div class="imp-h">Data dependencies <span class="cnt">${uniq.length}</span></div>`;
  h += uniq.length ? `<table class="t"><tr><th>variable</th><th>this function is</th><th>other side</th><th>ISR · core</th><th>at</th></tr>${uniq.map(r => `<tr><td>${esc(r.var)}</td><td>${r.role === 'consumer' ? 'writer → consumer:' : 'reader ← producer:'}</td><td>${fnLink(r.other)}</td><td>${esc(r.isr)} · c${r.core}</td><td>${fmtAbs(r.t)}</td></tr>`).join('')}</table>` : '<div class="muted">no other function shares its variables</div>';
  return h;
}

function impactRemove(fid) {
  const f = fnOf(fid), direct = callersOf(fid), before = reachableWithout(null), after = reachableWithout(fid);
  const dead = [...before].filter(x => x !== fid && !after.has(x));
  let h = `<div class="imp-h">If <b>${esc(short(fid))}</b> is removed</div>`;
  h += `<div class="imp-row"><span class="b x">${direct.length}</span> caller${direct.length === 1 ? '' : 's'} break: ${direct.map(c => fnLink(c.fid)).join(', ') || '—'}</div>`;
  h += `<div class="imp-row"><span class="b ${dead.length ? 'x' : 'ok'}">${dead.length}</span> function${dead.length === 1 ? '' : 's'} become unreachable from every ISR: ${dead.map(fnLink).join(', ') || '—'}</div>`;
  // variables / registers that lose their only writer or reader
  const closure_ = S.deep ? closure(fid) : new Set([fid]);
  const gone = new Set([fid, ...dead]);
  const lost = [];
  P.memory.variables.forEach(v => {
    const acc = v.accessors, mine = acc.filter(a => gone.has(a.fid)); if (!mine.length) return;
    const rest = acc.filter(a => !gone.has(a.fid));
    const w = rest.some(a => a.rw !== 'r' && a.rw !== 'addr'), r = rest.some(a => a.rw === 'r' || a.rw === 'rw');
    const mw = mine.some(a => a.rw !== 'r' && a.rw !== 'addr'), mr = mine.some(a => a.rw === 'r' || a.rw === 'rw');
    if (mw && !w && rest.length) lost.push({ v, what: 'loses its only writer', who: rest.map(a => a.fid) });
    else if (mr && !r && rest.length) lost.push({ v, what: 'loses its only reader', who: rest.map(a => a.fid) });
    else if (!rest.length) lost.push({ v, what: 'becomes unused', who: [] });
  });
  h += `<div class="imp-h">Shared memory <span class="cnt">${lost.length}</span></div>` + (lost.length ? `<table class="t"><tr><th>variable</th><th>effect</th><th>remaining users</th></tr>${lost.map(l => `<tr><td>${esc(l.v.name)}${l.v.shared_across_cores ? ' <span class="b x">cross-core</span>' : ''}</td><td>${l.what}</td><td>${[...new Set(l.who)].map(short).join(', ') || '—'}</td></tr>`).join('')}</table>` : '<div class="muted">no variable loses a writer or reader</div>');
  const regs = new Map();
  P.isrs.forEach(isr => isr.hw_events.forEach(e => { const k = e.block + '.' + e.reg; const r = regs.get(k) || { mine: 0, rest: 0, kinds: new Set() }; if (gone.has(e.fid)) { r.mine++; r.kinds.add(e.kind); } else r.rest++; regs.set(k, r); }));
  const noCfg = [...regs].filter(([k, r]) => r.mine && !r.rest);
  h += `<div class="imp-h">HW registers <span class="cnt">${noCfg.length}</span></div>` + (noCfg.length ? `<div class="imp-row">no longer accessed by any ISR: ${noCfg.map(([k, r]) => `<code>${esc(k)}</code> (${[...r.kinds].join('/')})`).join(', ')}</div>` : '<div class="muted">every register it touches is still accessed elsewhere</div>');
  // ISR budgets
  const rows = [];
  P.isrs.forEach(isr => { const nodes = isr.flat.filter(r => r.n.fid === fid); if (!nodes.length) return; const saved = nodes.reduce((a, r) => a + r.n.total_us, 0); rows.push({ isr, saved, after: isr.computed_us - saved }); });
  h += `<div class="imp-h">ISR time <span class="cnt">${rows.length}</span></div>` + (rows.length ? `<table class="t"><tr><th>ISR</th><th>computed</th><th>after removal</th><th>budget</th></tr>${rows.map(r => `<tr><td>${esc(r.isr.name)}</td><td>${fmt(r.isr.computed_us)}</td><td>${fmt(r.after)} <span class="muted">(−${fmt(r.saved)})</span></td><td>${r.isr.length_us == null ? '—' : fmt(r.isr.length_us) + (r.after > r.isr.length_us ? ' <span class="b x">still over</span>' : r.isr.over_budget ? ' <span class="b ok">now within</span>' : '')}</td></tr>`).join('')}</table>` : '<div class="muted">not executed by any configured ISR</div>');
  return h;
}

function impactMove(fid, target, pos) {
  const isr = ISRX[target]; if (!isr) return '<div class="muted">pick a target ISR</div>';
  const sub = S.deep ? closure(fid) : new Set([fid]);
  const cur = (IX.times[fid] || [])[0];
  const span = cur ? cur.t1 - cur.t0 : fnOf(fid).self_us;
  const newStart = isr.abs_start_us + (pos === 'start' ? 0 : isr.computed_us), shift = cur ? newStart - cur.t0 : 0;
  let h = `<div class="imp-h">If <b>${esc(short(fid))}</b> moves to <b>${esc(isr.name)}</b> (core ${isr.core}, ${pos === 'start' ? 'first' : 'last'} in the ISR)</div>`;
  h += `<div class="imp-row">currently ${cur ? `in ${esc(cur.isr.name)} (core ${cur.isr.core}) at ${fmtAbs(cur.t0)}` : 'not executed by an ISR'} · new start ${fmtAbs(newStart)} · subtree ${fmt(span)} · target ISR ${fmt(isr.computed_us)} → ${fmt(isr.computed_us + span)}${isr.length_us != null ? (isr.computed_us + span > isr.length_us ? ' <span class="b x">over budget ' + fmt(isr.length_us) + '</span>' : ' <span class="b ok">within budget</span>') : ''}</div>`;
  // HW deadlines at the new time
  const evs = [];
  if (cur) cur.isr.flat.filter(r => sub.has(r.n.fid) && r.key.startsWith(cur.path.split('#')[0] + cur.path.split('#')[1].replace(/^0/, '') )).length;   // (kept simple below)
  P.isrs.forEach(src => src.flat.forEach(r => { if (!sub.has(r.n.fid)) return; r.n.hw_events.forEach(e => evs.push({ e, src })); }));
  const seenE = new Set(), rows = [];
  evs.forEach(({ e, src }) => { const k = e.fid + '|' + e.line; if (seenE.has(k)) return; seenE.add(k); const nt = e.t_us + shift; const c = dlCheck(e.block, nt, isr.core, isr.name); rows.push({ e, nt, c, was: e.violation }); });
  const worse = rows.filter(r => r.c.violation && !r.was).length, better = rows.filter(r => !r.c.violation && r.was).length;
  h += `<div class="imp-h">HW register timing <span class="cnt">${rows.length} accesses · ${worse ? `<span class="b x">${worse} new miss</span>` : ''} ${better ? `<span class="b ok">${better} resolved</span>` : ''}</span></div>`;
  h += rows.length ? `<table class="t"><tr><th>register</th><th>op</th><th>now</th><th>after</th><th>deadline</th></tr>${rows.map(r => `<tr class="${r.c.violation ? 'viol' : ''}"><td>${r.e.block}.${r.e.reg}</td><td>${r.e.kind}</td><td>${fmtAbs(r.e.t_us)}${r.was ? ' ✗' : ''}</td><td>${fmtAbs(r.nt)}${r.c.violation ? ' ✗' : ' ✓'}</td><td>${r.c.deadline_us == null ? '—' : fmtAbs(r.c.deadline_us)}</td></tr>`).join('')}</table>` : '<div class="muted">no register access in the moved subtree</div>';
  // variable update order before / after
  const order = [];
  sub.forEach(x => { const f = fnOf(x); if (!f) return; f.vars.forEach(v => { const key = VKEY[x + '|' + v.name]; if (!key) return; const mine = (IX.varTimes[key] || []).find(o => o.fid === x); if (!mine) return; const others = (IX.varTimes[key] || []).filter(o => !sub.has(o.fid)); others.forEach(o => {
    const w1 = mine.rw !== 'r' && mine.rw !== 'addr', w2 = o.rw !== 'r' && o.rw !== 'addr'; if (!w1 && !w2) return;
    const before = inSlot(mine.t) < inSlot(o.t), after = inSlot(mine.t + shift) < inSlot(o.t);
    const crossBefore = (cur ? cur.isr.core : null) !== o.core, crossAfter = isr.core !== o.core;
    order.push({ var: v.name + (v.member ? '.' + v.member : ''), me: x, rw: mine.rw, other: o.fid, orw: o.rw, oisr: o.isr.name, ocore: o.core, before, after, flip: before !== after, crossBefore, crossAfter, ot: o.t, nt: mine.t + shift });
  }); }); });
  const flips = order.filter(r => r.flip).length;
  h += `<div class="imp-h">Variable update order <span class="cnt">${order.length} pairs · ${flips ? `<span class="b x">${flips} change order</span>` : '<span class="b ok">unchanged</span>'}</span></div>`;
  h += order.length ? `<table class="t"><tr><th>variable</th><th>moved access</th><th>other access</th><th>now</th><th>after</th></tr>${order.map(r => `<tr class="${r.flip ? 'viol' : ''}"><td>${esc(r.var)}${(r.crossAfter && !r.crossBefore) ? ' <span class="b x">becomes cross-core</span>' : (!r.crossAfter && r.crossBefore) ? ' <span class="b ok">same core now</span>' : ''}</td><td>${fnLink(r.me)} [${r.rw}]</td><td>${fnLink(r.other)} [${r.orw}] · ${esc(r.oisr)} c${r.ocore} ${fmtAbs(r.ot)}</td><td>${r.before ? 'moved first' : 'other first'}</td><td>${r.after ? 'moved first' : 'other first'}${r.flip ? ' ⚠' : ''}</td></tr>`).join('')}</table>` : '<div class="muted">no shared variable is involved</div>';
  return h;
}

function impactHtml(fid) {
  buildIndexes();
  const mode = S.impactMode || 'usedby';
  const btn = (m, label, title) => `<button class="tog mini ${mode === m ? '' : ''}" data-imp="${m}" aria-pressed="${mode === m}" title="${esc(title)}">${label}</button>`;
  let h = `<div class="imp-bar">${btn('usedby', 'Used by', 'callers, ISRs that reach it, producers / consumers of its variables')}${btn('remove', 'Remove', 'what breaks or becomes unreachable if this function is removed')}${btn('move', 'Move to ISR', 'deadline and update-order changes if this function runs in another ISR')}`;
  if (mode === 'move') {
    const cur = (IX.times[fid] || [])[0];
    const tgt = S.impactTarget && ISRX[S.impactTarget] ? S.impactTarget : (P.isrs.find(i => !cur || i.name !== cur.isr.name) || P.isrs[0]).name;
    S.impactTarget = tgt;
    h += `<select id="imp-target" class="tog mini">${P.isrs.map(i => `<option value="${esc(i.name)}" ${i.name === tgt ? 'selected' : ''}>${esc(i.name)} · core ${i.core}</option>`).join('')}</select>` +
      `<select id="imp-pos" class="tog mini"><option value="end" ${S.impactPos !== 'start' ? 'selected' : ''}>at the end</option><option value="start" ${S.impactPos === 'start' ? 'selected' : ''}>at the start</option></select>`;
  }
  h += '</div><div class="imp-body">';
  h += mode === 'usedby' ? impactUsedBy(fid) : mode === 'remove' ? impactRemove(fid) : impactMove(fid, S.impactTarget, S.impactPos || 'end');
  return h + '</div>';
}
function wireImpact(el) {
  el.querySelectorAll('[data-imp]').forEach(b => b.addEventListener('click', () => { S.impactMode = b.dataset.imp; renderDetail(); }));
  const t = el.querySelector('#imp-target'); if (t) t.addEventListener('change', () => { S.impactTarget = t.value; renderDetail(); });
  const p = el.querySelector('#imp-pos'); if (p) p.addEventListener('change', () => { S.impactPos = p.value; renderDetail(); });
}
