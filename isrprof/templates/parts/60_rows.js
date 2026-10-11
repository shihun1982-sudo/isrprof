// ================================================================== row models for the unified timing diagram
// Top group  (SW structure touch): module / function execution bars, shared-variable read/write ticks,
//                                   IPC send/receive, heap calls - every ISR instance in the window.
// Bottom group (HW blocks)        : register access ticks per block / register, grouped by HW timing line,
//                                   with that line's deadlines.
// Each mark carries the function id + a short tip, so marks can be hovered and clicked.
function evTimeInFn(n, dt, seq) { const f = fnOf(n.fid); const ns = f ? f.n_seq : 1; return n.start_us + dt + n.self_us * Math.min(seq, ns) / Math.max(ns, 1); }
function mergeMarks(marks) {
  const out = []; marks.sort((a, b) => a.t0 - b.t0);
  for (const m of marks) { const l = out[out.length - 1]; if (l && m.t0 <= l.t1 + 1e-6 && l.c === m.c && l.foc === m.foc) { l.t1 = Math.max(l.t1, m.t1); l.n = (l.n || 1) + 1; } else out.push(Object.assign({ n: 1 }, m)); }
  return out;
}
function collectTouches() {
  const T = { mods: new Map(), fns: new Map(), vars: new Map(), ipc: new Map(), heap: [], blocks: new Map(), regs: new Map(), varTicks: [] };
  const push = (m, k, v) => { let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(v); };
  const cRead = cssVar('--read'), cWrite = cssVar('--write'), cCrit = cssVar('--critical'), cSer = cssVar('--serious'), cMuted = cssVar('--muted');
  const r0 = R0() - 2 * SLOT, r1 = R1() + 2 * SLOT;            // a little beyond the visible range is enough
  for (const isr of visibleIsrs()) for (const inst of instancesOf(isr)) {
    const dt = inst.k * (isr.period_us || 0);
    if (inst.start > r1 || inst.start + Math.max(isr.computed_us, isr.length_us || 0) < r0) continue;
    const sub = showSub(isr, inst.k);
    walk(isr.tree, isr.name + '#' + inst.k, (n, p) => {
      const f = fnOf(n.fid), t0 = n.start_us + dt, t1 = t0 + Math.max(n.total_us, SYM * 0.01), foc = S.block ? hl(n.fid) : inFocus(p, n.fid);
      const vis = p.indexOf('/') < 0 || (sub && nodeVisible(p));     // drawn as a box in the call-graph lanes?
      if (f) {
        const c = modColor(f.module);
        push(T.mods, f.module, { t0, t1, foc, c, fid: n.fid, isr: isr.name, k: inst.k, path: p });
        push(T.fns, f.id, { t0, t1, foc, c, fid: n.fid, isr: isr.name, k: inst.k, path: p });
        f.vars.forEach(v => {
          const key = VKEY[f.id + '|' + v.name]; if (!key) return;
          const t = evTimeInFn(n, dt, v.seq), mk = { t0: t, t1: t, foc, c: v.rw === 'r' ? cRead : (v.rw === 'addr' ? cMuted : cWrite), tick: true, fid: n.fid, isr: isr.name, k: inst.k, path: p, rw: v.rw, name: v.name + (v.member ? '.' + v.member : ''), member: v.member || '', via: v.via_macro || '', line: v.line, vis };
          push(T.vars, key, mk); if (vis) T.varTicks.push(Object.assign({ key }, mk));
        });
        f.ipc.forEach(i => { const t = evTimeInFn(n, dt, i.seq); push(T.ipc, i.channel, { t0: t, t1: t, foc, tick: true, c: i.macro === 'IPC_RECV' ? cRead : cWrite, fid: n.fid, isr: isr.name, k: inst.k, path: p, name: i.macro, line: i.line }); });
        f.heap.forEach(h => { const t = evTimeInFn(n, dt, h.seq); T.heap.push({ t0: t, t1: t, foc, tick: true, c: cSer, fid: n.fid, isr: isr.name, k: inst.k, path: p, name: h.fn, line: h.line }); });
      }
      nodeEvents(n, isr, inst.k).forEach(e => { const mk = { t0: e.t_us, t1: e.t_us, foc, tick: true, c: e.violation ? cCrit : (e.kind === 'read' ? cRead : cWrite), e, fid: n.fid, isr: isr.name, k: inst.k, path: p, vis }; push(T.blocks, e.block, mk); push(T.regs, e.block + '.' + e.reg, mk); });
    });
  }
  return T;
}
const KIND_ABBR = { global: 'G', static: 'S', static_local: 'SL', extern: 'G' };
// first-level users of a variable: {fid, core, rw[], members[], via[]} per accessing function, grouped by core
function varUsers(v) {
  const m = new Map();
  (v.accessors || []).forEach(a => {
    const f = fnOf(a.fid), u = m.get(a.fid) || { fid: a.fid, core: f ? f.core : null, rw: [], members: [], via: [] };
    if (!u.rw.includes(a.rw)) u.rw.push(a.rw);
    if (a.member && !u.members.includes(a.member)) u.members.push(a.member);
    if (a.via_macro && !u.via.includes(a.via_macro)) u.via.push(a.via_macro);
    m.set(a.fid, u);
  });
  return [...m.values()].sort((x, y) => ((x.core == null ? 99 : x.core) - (y.core == null ? 99 : y.core)) || x.fid.localeCompare(y.fid));
}
function swRows(T) {
  const rows = [], open = g => S.stripOpen.has(g), cores = CORES.filter(c => S.cores.has(c.id));
  rows.push({ group: 'modules', label: 'SW structure · modules per core (execution)', open: open('modules'), count: T.mods.size });
  if (open('modules')) for (const c of cores) {
    const mods = [...new Set(Object.values(F).filter(f => (f.core == null ? CORES[0].id : f.core) === c.id).map(f => f.module))].sort((a, b) => (MODIDX[a] || 0) - (MODIDX[b] || 0));
    for (const m of mods) {
      const marks = T.mods.get(m); if (!marks) continue;
      const isOpen = S.stripFn.has(m);
      rows.push({ id: m, kind: 'module', depth: 0, label: `${c.name.split(' ')[0]} · ${m}`, title: `${c.name} · module ${m} — click for its functions`, color: modColor(m), marks, car: true, open: isOpen, dim: !!(REL && !REL.modules.has(m)) });
      if (isOpen) Object.values(F).filter(f => f.module === m).forEach(f => { const fm = T.fns.get(f.id); if (fm) rows.push({ id: f.id, kind: 'fn', depth: 1, label: f.name, title: `${f.id} · ${f.file}:${f.line} — click to focus`, marks: fm, color: modColor(m), dim: !hl(f.id), sel: S.selFid === f.id }); });
    }
  }
  const allKeys = [...T.vars.keys()].sort((a, b) => ((VARX[b].shared_across_cores ? 1 : 0) - (VARX[a].shared_across_cores ? 1 : 0)) || a.localeCompare(b));
  const shownKeys = S.varsAll ? allKeys : allKeys.filter(k => VARX[k].shared_across_cores || (REL && REL.vars.has(k)) || S.hoverVar === k);
  rows.push({ group: 'vars', label: `shared variables · read (blue) / write (orange) at the access point${S.varsAll ? '' : ' · cross-core + related only'}`, open: open('vars'), count: allKeys.length });
  if (open('vars')) {
    shownKeys.forEach(key => {
      const v = VARX[key], fields = Object.keys(v.fields || {}), hasFields = fields.length > 0, isOpen = S.stripField.has(key);
      const users = varUsers(v);
      rows.push({ id: key, kind: 'var', depth: 0, label: `${v.name} · ${KIND_ABBR[v.kind] || v.kind}${v.registered ? ' ®' : ''}${v.shared_across_cores ? ' ⚠' : ''} (${users.length} fn)`,
        title: `${v.name} (${v.kind}${v.registered ? ', registered in config' : ''}) · cores ${v.cores.join(',')}${v.shared_across_cores ? ' · touched from more than one core' : ''} · used by ${users.length} function${users.length === 1 ? '' : 's'}${hasFields ? `, ${fields.length} field${fields.length > 1 ? 's' : ''}` : ''} — click to list the functions${v.note ? ' · ' + v.note : ''}`,
        marks: T.vars.get(key), tick: true, car: true, open: isOpen, dim: !!(REL && !REL.vars.has(key)) });
      if (isOpen) {
        // first-level users: one row per accessing function, grouped by core, with what it touches
        users.forEach(u => rows.push({ id: key + '>' + u.fid, kind: 'varfn', fid: u.fid, depth: 1,
          label: `c${u.core == null ? '?' : u.core} · ${short(u.fid)} [${u.rw.join('/')}]${u.members.length ? ' .' + u.members.join(' .') : ''}`,
          title: `${short(u.fid)} on core ${u.core == null ? '?' : u.core} · ${u.rw.join('/')}${u.members.length ? ' · fields ' + u.members.join(', ') : ''}${u.via.length ? ' · via ' + u.via.join(', ') : ''} — click to focus the function`,
          color: fnOf(u.fid) ? modColor(fnOf(u.fid).module) : null, marks: (T.vars.get(key) || []).filter(m => m.fid === u.fid), tick: true, dim: !hl(u.fid), sel: S.selFid === u.fid }));
        if (hasFields) fields.sort().forEach(fl => { const fi = v.fields[fl]; rows.push({ id: key + '.' + fl, kind: 'field', depth: 1, label: `.${fl} (${fi.r}r/${fi.w}w)`, title: `${v.name}.${fl} · ${fi.r} read${fi.r === 1 ? '' : 's'} / ${fi.w} write${fi.w === 1 ? '' : 's'} by ${fi.fids.map(short).join(', ')}`, marks: (T.vars.get(key) || []).filter(m => m.member === fl), tick: true, muted: true, dim: !!(REL && !REL.vars.has(key)) }); });
      }
    });
    if (allKeys.length > shownKeys.length || S.varsAll) rows.push({ id: 'varsall', kind: 'varsall', depth: 0, label: S.varsAll ? '▴ show cross-core / related only' : `▾ show all ${allKeys.length} variables`, marks: [], tick: true, muted: true });
  }
  const chans = P.memory.ipc_channels.map(c => c.id).concat([...T.ipc.keys()].filter(k => !P.memory.ipc_channels.some(c => c.id === k)));
  rows.push({ group: 'ipc', label: 'IPC channels · send (orange) / receive (blue)', open: open('ipc'), count: chans.length });
  if (open('ipc')) chans.forEach(id => { const ch = P.memory.ipc_channels.find(c => c.id === id); rows.push({ id, kind: 'ipc', depth: 0, label: ch ? `${id} (c${ch.from}→c${ch.to})` : id, marks: T.ipc.get(id) || [], tick: true, dim: !!(REL && !REL.ipc.has(id)) }); });
  rows.push({ group: 'heap', label: 'heap · allocation calls inside ISR paths', open: open('heap'), count: T.heap.length });
  if (open('heap')) rows.push({ id: 'heap', kind: 'heap', depth: 0, label: 'heap (' + P.memory.heap_users.flatMap(u => u.calls.map(c => c.fn)).filter((x, i, a) => a.indexOf(x) === i).join(', ') + ')', marks: T.heap, tick: true, dim: !!(REL && !REL.heap.length) });
  return rows;
}
function blockDeadlineTicks(b, r0, r1) {
  const out = [];
  for (const d of b.deadlines) {
    if (d.period_us) { for (let k = Math.floor((r0 - d.offset_us) / d.period_us) - 1; out.length < 800; k++) { const t = d.offset_us + k * d.period_us + d.at_us; if (t > r1) break; if (t >= r0) out.push({ t, d }); } }
    else if (d.abs_us >= r0 && d.abs_us <= r1) out.push({ t: d.abs_us, d });
  }
  return out;
}
function hwRows(T) {
  const rows = [], r0 = R0(), r1 = R1();
  const lines = [...new Set(BLOCKS.map(b => b.line || 'nw'))].sort((a, b) => TIX[a].idx - TIX[b].idx);
  const extra = [...T.blocks.keys()].filter(k => !BX[k]);
  rows.push({ group: 'blocks', label: `HW blocks · register access on their HW timing lines (${lines.map(l => TIX[l].name).join(', ')})`, open: S.stripOpen.has('blocks'), count: BLOCKS.length + extra.length });
  if (!S.stripOpen.has('blocks')) return rows;
  for (const lid of lines) {
    const ln = TIX[lid];
    rows.push({ group: 'line:' + lid, sub: true, label: `${ln.name} · ${ln.offset_us >= 0 ? '+' : ''}${(ln.offset_us / SYM).toFixed(2)} sym vs NW${ln.description ? ' · ' + ln.description : ''}`, open: !S.stripOpen.has('hide:' + lid), line: ln });
    if (S.stripOpen.has('hide:' + lid)) continue;
    for (const b of BLOCKS.filter(b => (b.line || 'nw') === lid)) {
      const marks = T.blocks.get(b.id) || [], isOpen = S.stripReg.has(b.id);
      rows.push({ id: b.id, kind: 'block', depth: 0, label: `${b.name} · ${b.id}`, title: `${b.name} ${b.id}${b.base ? ' @ ' + b.base : ''} — click for registers`, marks, tick: true, deadlines: blockDeadlineTicks(b, r0, r1), car: true, open: isOpen, line: ln, block: b,
        dim: REL ? !REL.blocks.has(b.id) : !!(S.block && S.block !== b.id), sel: S.block === b.id });
      if (isOpen) {
        const regs = b.regs.concat([...T.regs.keys()].filter(k => k.startsWith(b.id + '.')).map(k => k.slice(b.id.length + 1)).filter(r => !b.regs.includes(r)));
        regs.forEach(rg => { const m = T.regs.get(b.id + '.' + rg); rows.push({ id: b.id + '.' + rg, kind: 'reg', depth: 1, label: rg, marks: m || [], tick: true, line: ln, dim: !m || !!(REL && !(REL.blocks.get(b.id) && REL.blocks.get(b.id).regs.has(rg))) }); });
      }
    }
  }
  extra.forEach(id => rows.push({ id, kind: 'block', depth: 0, label: `${id} (not in config)`, marks: T.blocks.get(id), tick: true, deadlines: [], dim: !!REL }));
  return rows;
}
