// ================================================================== side panels: call graph of the selection, details
function renderTree() {
  const el = document.getElementById('tree-body');
  let html = '';
  if (S.selPath && nodeAt(S.selPath)) {
    const isr = isrOfPath(S.selPath), list = instancesOf(isr), inst = shownInst(isr), idx = list.findIndex(i => i.k === inst.k);
    const crumbs = []; const parts = S.selPath.split('/'); for (let i = 1; i < parts.length; i++) { const p = parts.slice(0, i).join('/'); const n = nodeAt(p); if (n) crumbs.push(`<span class="crumb" data-path="${esc(p)}">${esc(n.name)}</span>`); }
    const bar = `<div class="instbar">${esc(isr.name)} · instance ${idx + 1}/${list.length} (#${inst.k}) · ${fmtAbs(inst.start)}` +
      (list.length > 1 ? ` <button class="tog" data-isr="${esc(isr.name)}" data-step="-1" title="previous instance">◂</button><button class="tog" data-isr="${esc(isr.name)}" data-step="1" title="next instance">▸</button>` : '') +
      (crumbs.length ? `<div class="crumbs">${crumbs.join(' › ')} ›</div>` : '') + '</div>';
    html = `<ul>${treeItem(nodeAt(S.selPath), S.selPath, isr, parts.length === 1, inst.k, bar, 0)}</ul>`;
  } else if (S.selFid && fnOf(S.selFid)) {
    html = `<div class="instbar">${esc(short(S.selFid))} · static call tree (not reached by a visible ISR)</div><ul>${staticItem(S.selFid, S.selFid, 0, new Set())}</ul>`;
  } else {
    html = visibleIsrs().map(isr => {
      const list = instancesOf(isr), inst = shownInst(isr), idx = list.findIndex(i => i.k === inst.k);
      const bar = list.length > 1 ? `<div class="instbar">instance ${idx + 1}/${list.length} (#${inst.k}) · ${fmtAbs(inst.start)}` +
        ` <button class="tog" data-isr="${esc(isr.name)}" data-step="-1" title="previous instance">◂</button><button class="tog" data-isr="${esc(isr.name)}" data-step="1" title="next instance">▸</button></div>` : '';
      return `<ul>${treeItem(isr.tree, isr.name + '#' + inst.k, isr, true, inst.k, bar, 0)}</ul>`;
    }).join('');
  }
  el.innerHTML = html || '<span style="color:var(--muted)">no ISR selected</span>';
  el.querySelectorAll('.car').forEach(c => c.addEventListener('click', e => { e.stopPropagation(); toggleExp(c.parentElement.dataset.path); renderAll(); }));
  el.querySelectorAll('.row').forEach(r => {
    r.addEventListener('click', () => selectNode(r.dataset.path, r.dataset.fid));
    r.addEventListener('mouseenter', e => { const n = nodeAt(r.dataset.path); if (n) showTip(nodeTip(n, isrOfPath(r.dataset.path), r.dataset.path), e.clientX, e.clientY); });
    r.addEventListener('mouseleave', hideTip);
  });
  el.querySelectorAll('.srow').forEach(r => r.addEventListener('click', () => selectNode(findPath(r.dataset.fid), r.dataset.fid)));
  el.querySelectorAll('.crumb').forEach(c => c.addEventListener('click', () => { const n = nodeAt(c.dataset.path); selectNode(c.dataset.path, n.fid); }));
  el.querySelectorAll('.instbar button').forEach(b => b.addEventListener('click', () => {
    const isr = ISRX[b.dataset.isr], list = instancesOf(isr), idx = list.findIndex(i => i.k === shownInst(isr).k);
    const nk = list[(idx + (+b.dataset.step) + list.length) % list.length].k;
    S.inst[isr.name] = nk;
    if (S.selPath && isrOfPath(S.selPath) === isr) S.selPath = S.selPath.replace(/#-?\d+/, '#' + nk);
    renderAll();
  }));
  const selRow = el.querySelector('.row.sel'), box = document.getElementById('tree');
  if (selRow && box) { const top = selRow.offsetTop - box.offsetTop; if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 24) box.scrollTop = Math.max(0, top - box.clientHeight / 2); }
}
function treeItem(n, path, isr, isRoot, k, extra, rel) {
  const f = fnOf(n.fid), open = isExp(path), kids = n.children || [], evs = nodeEvents(n, isr, k);
  const viol = evs.filter(e => e.violation).length, badges = [];
  if (evs.length) { const r = evs.filter(e => e.kind === 'read').length, w = evs.length - r; if (r) badges.push(`<span class="b r">R${r}</span>`); if (w) badges.push(`<span class="b w">W${w}</span>`); }
  if (viol) badges.push(`<span class="b x">miss ${viol}</span>`);
  const sw = (TOUCH[n.fid] || []).filter(([id, rw]) => rw !== 'x');
  if (sw.length) badges.push(`<span class="b" title="${esc(sw.map(([id, rw]) => (SWN[id] ? SWN[id].name : id) + ' [' + rw + ']').join(', '))}">sw ${sw.length}</span>`);
  if (f && f.ipc.length) badges.push('<span class="b">ipc</span>');
  if (f && f.heap.length) badges.push('<span class="b w">heap</span>');
  if (n.external) badges.push('<span class="b ext">ext</span>');
  if (n.recursive) badges.push('<span class="b x">rec</span>');
  if (n.via_table) badges.push('<span class="b">via table</span>');
  if (isRoot && isr.over_budget) badges.push('<span class="b x">over budget</span>');
  const dim = S.block ? !hl(n.fid) : !inFocus(path, n.fid);
  const row = `<div class="row ${isRoot ? 'isr' : ''} ${S.selPath === path ? 'sel' : ''} ${dim ? 'dim' : ''}" data-path="${esc(path)}" data-fid="${esc(n.fid)}">` +
    `<span class="car">${kids.length ? (open ? '▾' : '▸') : '·'}</span><i class="sw" style="background:${f ? modColor(f.module) : 'var(--muted)'}"></i>` +
    `<span class="nm">${isRoot ? '⚡ ' + esc(isr.name) + ' → ' : ''}${esc(n.name)}</span>${badges.join('')}<span class="t">${fmt(n.total_us)}</span></div>`;
  return `<li>${row}${extra || ''}${open && kids.length ? `<ul>${kids.map((c, i) => treeItem(c, path + '/' + i, isr, false, k, '', rel + 1)).join('')}</ul>` : ''}</li>`;
}
function staticItem(fid, path, depth, seen) {     // call tree from the static call graph (functions not reached by a visible ISR)
  const f = fnOf(fid); if (!f) return `<li><div class="row dim"><span class="car">·</span><span class="nm">${esc(short(fid))}</span><span class="b ext">ext</span></div></li>`;
  const callees = []; f.calls.forEach(c => (c.indirect ? c.callee_ids : [c.callee_id || c.callee]).forEach(id => { if (id && !callees.includes(id)) callees.push(id); }));
  const open = depth < S.level && !seen.has(fid), badges = [];
  if (f.hw.length) badges.push(`<span class="b w">▣${f.hw.length}</span>`);
  const sw = (TOUCH[fid] || []).filter(([id, rw]) => rw !== 'x'); if (sw.length) badges.push(`<span class="b">sw ${sw.length}</span>`);
  const next = new Set(seen); next.add(fid);
  return `<li><div class="row srow ${S.selFid === fid ? 'sel' : ''}" data-fid="${esc(fid)}"><span class="car">${callees.length ? (open ? '▾' : '▸') : '·'}</span><i class="sw" style="background:${modColor(f.module)}"></i><span class="nm">${esc(f.name)}</span>${badges.join('')}<span class="t">${fmt(f.self_us)}</span></div>` +
    (open && callees.length ? `<ul>${callees.map(c => staticItem(c, path + '/' + c, depth + 1, next)).join('')}</ul>` : '') + '</li>';
}

// ------------------------------------------------------------------ details
function relatedHtml() {
  const r = REL, mode = S.deep ? 'incl. callees down to the leaves' : 'this function only';
  let h = `<h3 style="margin-top:10px">Related · ${r.fids.size} function${r.fids.size > 1 ? 's' : ''} (${mode})</h3>`;
  h += `<div style="font-size:11.5px;line-height:1.9">${[...r.fids].map(f => `<span class="b ${f === S.selFid ? '' : 'ext'} fnb" data-fid="${esc(f)}" style="cursor:pointer">${esc(short(f))}</span>`).join(' ')}</div>`;
  const swRows = [...r.sw].filter(([id, t]) => t.rw !== 'c').sort((a, b) => (a[1].rw === 'x' ? 0 : 1) - (b[1].rw === 'x' ? 0 : 1) || a[0].localeCompare(b[0]));
  if (swRows.length) h += `<h3 style="margin-top:8px">SW structure</h3><table class="t"><tr><th>node</th><th>kind</th><th>touch</th><th>by</th></tr>` +
    swRows.map(([id, t]) => { const n = SWN[id]; return `<tr><td><span class="ndl" data-node="${esc(id)}" style="cursor:pointer">${esc(n ? n.name : id)}</span>${n && n.parent ? ` <span style="color:var(--muted)">‹ ${esc(SWN[n.parent] ? SWN[n.parent].name : n.parent)}</span>` : ''}</td><td>${esc(n ? n.kind : '')}</td><td>${t.rw === 'x' ? 'executes' : t.rw}</td><td>${[...t.fids].map(short).join(', ')}</td></tr>`; }).join('') + '</table>';
  if (r.blocks.size) h += `<h3 style="margin-top:8px">HW structure</h3><table class="t"><tr><th>HW block</th><th>registers</th><th>R</th><th>W</th><th>miss</th></tr>` +
    [...r.blocks].map(([b, x]) => `<tr class="${x.miss ? 'viol' : ''}"><td><span class="blkl" data-block="${esc(b)}" style="cursor:pointer">${esc(BX[b] ? BX[b].name : b)}</span> <span style="color:var(--muted)">${esc(b)}</span></td><td>${[...x.regs].map(([rg, n]) => rg + (n.n > 1 ? '×' + n.n : '')).join(' ')}</td><td>${x.r}</td><td>${x.w}</td><td>${x.miss || ''}</td></tr>`).join('') + '</table>';
  else h += '<div style="color:var(--muted);font-size:11.5px;margin-top:4px">no HW register access in this set</div>';
  if (r.vars.size) h += `<h3 style="margin-top:8px">Shared memory / variables</h3><table class="t"><tr><th>variable</th><th>kind</th><th>access</th><th>by</th></tr>` +
    [...r.vars.values()].map(({ v, rw, fids }) => {
      const fl = Object.entries(v.fields || {}).filter(([, fi]) => fi.fids.some(x => r.fids.has(x)));
      return `<tr><td>${esc(v.name)}${v.registered ? ' <span class="b" title="registered in the config">®</span>' : ''}${v.shared_across_cores ? ' <span class="b x" title="touched from more than one core">cross-core</span>' : ''}</td><td>${v.kind}</td><td>${rw.join('/')}</td><td>${fids.map(short).join(', ')}</td></tr>` +
        fl.map(([name, fi]) => `<tr><td style="padding-left:14px;color:var(--muted)">.${esc(name)}</td><td></td><td>${fi.r ? 'r' : ''}${fi.r && fi.w ? '/' : ''}${fi.w ? 'w' : ''}</td><td style="color:var(--muted)">${fi.fids.filter(x => r.fids.has(x)).map(short).join(', ')}</td></tr>`).join('');
    }).join('') + '</table>';
  if (r.ipc.size) h += `<div style="font-size:11.5px;margin-top:6px"><b>IPC</b> ${[...r.ipc].map(([ch, ops]) => `<code>${esc(ch)}</code> (${ops.map(o => o.macro.replace('IPC_', '').toLowerCase() + ' in ' + short(o.fid)).join(', ')})`).join(' · ')}</div>`;
  if (r.heap.length) h += `<div style="font-size:11.5px;margin-top:4px"><b>Heap</b> ${r.heap.map(u => `<code>${esc(short(u.fid))}</code> → ${u.calls.map(c => esc(c.fn)).join(', ')}`).join(' · ')}</div>`;
  h += `<div style="font-size:11.5px;margin-top:4px;color:var(--muted)">modules: ${[...r.modules].map(m => esc(SWN[m] ? SWN[m].name : m)).join(', ')} · cores: ${[...r.cores].sort().join(', ') || '—'}</div>`;
  return h;
}
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
function varDetail(key) {
  const v = VARX[key]; if (!v) return '';
  const users = varUsers(v), byCore = new Map();
  users.forEach(u => { const c = u.core == null ? '?' : u.core; if (!byCore.has(c)) byCore.set(c, []); byCore.get(c).push(u); });
  let h = `<div class="mono" style="font-weight:600;font-size:13px">${esc(v.name)} <span class="b">${v.kind}</span>${v.registered ? ' <span class="b" title="registered in the config">registered</span>' : ''}${v.shared_across_cores ? ' <span class="b x">cross-core</span>' : ''}</div><dl class="kv">`;
  h += `<dt>where</dt><dd>${esc(v.file)}${v.line ? ':' + v.line : ''}</dd><dt>decl</dt><dd>${esc(v.decl)}</dd>`;
  if (VNODE[key]) h += `<dt>SW node</dt><dd>${esc(SWN[VNODE[key]] ? SWN[VNODE[key]].name : VNODE[key])}</dd>`;
  if (v.note) h += `<dt>note</dt><dd>${esc(v.note)}</dd>`;
  h += `<dt>cores</dt><dd>${v.cores.join(', ') || '—'} · ${users.length} function${users.length === 1 ? '' : 's'}</dd></dl>`;
  h += `<table class="t"><tr><th>core</th><th>function</th><th>access</th><th>fields / via</th></tr>` +
    [...byCore].map(([c, list]) => list.map((u, i) => `<tr><td>${i === 0 ? 'core ' + c : ''}</td><td><span class="fnb" data-fid="${esc(u.fid)}" style="cursor:pointer">${esc(short(u.fid))}</span></td><td>${u.rw.join('/')}</td><td>${u.members.map(m => '.' + esc(m)).join(' ')}${u.via.length ? ' <span class="b">' + u.via.map(esc).join(', ') + '</span>' : ''}</td></tr>`).join('')).join('') + '</table>';
  const fields = Object.entries(v.fields || {});
  if (fields.length) h += `<table class="t"><tr><th>field</th><th>reads</th><th>writes</th><th>by</th></tr>` + fields.sort().map(([n, fi]) => `<tr><td>.${esc(n)}</td><td>${fi.r}</td><td>${fi.w}</td><td>${fi.fids.map(short).join(', ')}</td></tr>`).join('') + '</table>';
  return h;
}
function swNodeDetail(id) {
  const n = SWN[id]; if (!n) return '';
  const fids = [...NODE_FIDS[id]], blocks = new Map();
  fids.forEach(f => (fnOf(f) ? fnOf(f).hw : []).forEach(hw => { const b = blocks.get(hw.block) || { r: 0, w: 0 }; if (hw.kind === 'read') b.r++; else b.w++; blocks.set(hw.block, b); }));
  let h = `<div class="mono" style="font-weight:600;font-size:13px">${esc(n.name)} <span class="b">${esc(n.kind)}</span>${n.implicit ? ' <span class="b ext">implicit</span>' : ''}</div><dl class="kv">`;
  if (n.parent) h += `<dt>in</dt><dd>${SWL.anc[id].map(a => esc(SWN[a] ? SWN[a].name : a)).reverse().join(' › ')}</dd>`;
  if (n.type) h += `<dt>type</dt><dd>${esc(n.type)}</dd>`;
  if (n.core != null) h += `<dt>core</dt><dd>${n.core}</dd>`;
  if (n.note) h += `<dt>note</dt><dd>${esc(n.note)}</dd>`;
  h += `<dt>contains</dt><dd>${n.children.length} nodes · ${fids.length} functions · ${n.variables.length} variables</dd></dl>`;
  if (fids.length) h += `<div style="font-size:11.5px;line-height:1.9">${fids.map(f => `<span class="b ext fnb" data-fid="${esc(f)}" style="cursor:pointer">${esc(short(f))}</span>`).join(' ')}</div>`;
  if (blocks.size) h += `<table class="t"><tr><th>HW block</th><th>R</th><th>W</th></tr>${[...blocks].map(([b, x]) => `<tr><td><span class="blkl" data-block="${esc(b)}" style="cursor:pointer">${esc(BX[b] ? BX[b].name : b)}</span></td><td>${x.r}</td><td>${x.w}</td></tr>`).join('')}</table>`;
  if (n.variables.length) h += `<table class="t"><tr><th>variable</th><th>kind</th><th>cores</th><th>users</th></tr>${n.variables.map(k => { const v = VARX[k]; return v ? `<tr><td>${esc(v.name)}</td><td>${v.kind}</td><td>${v.cores.join(',')}</td><td>${varUsers(v).map(u => short(u.fid)).join(', ')}</td></tr>` : ''; }).join('')}</table>`;
  const rels = SWS.relations.filter(r => r.from === id || r.to === id);
  if (rels.length) h += `<div style="font-size:11.5px;margin-top:6px"><b>Relations</b> ${rels.map(r => `${esc(SWN[r.from] ? SWN[r.from].name : r.from)} →<i>${esc(r.kind)}</i>→ ${esc(SWN[r.to] ? SWN[r.to].name : r.to)}${r.label ? ' (' + esc(r.label) + ')' : ''}`).join(' · ')}</div>`;
  return h;
}
function renderDetail() {
  const el = document.getElementById('detail-body');
  let h = '';
  if (S.block) h = blockDetail(BX[S.block]);
  else if (S.swNode) h = swNodeDetail(S.swNode);
  else if (S.selVar && !S.selFid) h = varDetail(S.selVar);
  else if (!S.selFid) h = '<span style="color:var(--muted)">Click a box in the timing diagram, a row in the call graph, a function in the SW structure or a HW block. The Focus toggle decides whether the selection relates only that function or its whole call subtree; the level control sets how deep the call graph unfolds; ◂ ▸ steps through periodic instances.</span>';
  else {
    const shownPath = S.selPath || findPath(S.selFid);
    const n = shownPath ? nodeAt(shownPath) : null, f = fnOf(S.selFid), sf = ST.functions[S.selFid];
    const isr = shownPath ? isrOfPath(shownPath) : null, k = shownPath ? instOfPath(shownPath) : 0, dt = isr ? k * (isr.period_us || 0) : 0;
    h = `<div class="mono" style="font-weight:600;font-size:13px">${esc(short(S.selFid))}${f && f.static ? ' <span class="b">static</span>' : ''}</div><dl class="kv">`;
    if (f) h += `<dt>where</dt><dd>${esc(f.file)}:${f.line}–${f.end_line} · ${esc(SWN[FNODE[f.id]] ? SWN[FNODE[f.id]].name : f.module)} · core ${f.core == null ? '?' : f.core}</dd><dt>signature</dt><dd>${esc(f.signature)}</dd>`;
    if (f && f.summary) h += `<dt>summary</dt><dd>${esc(f.summary)} <span class="b">llm</span></dd>`;
    if (f && f.note) h += `<dt>note</dt><dd>${esc(f.note)}</dd>`;
    if (n) h += `<dt>timing</dt><dd>start ${fmtAbs(n.start_us + dt)} · self ${fmt(n.self_us)} · total ${fmt(n.total_us)}${f ? ` · cost from ${f.cost_source}` : ''}</dd>`;
    if (isr && n === isr.tree) h += `<dt>ISR</dt><dd>${esc(isr.name)} on ${esc(TIX[isr.timing].name)} · budget ${isr.length_us == null ? '—' : fmt(isr.length_us)} · computed ${fmt(isr.computed_us)} ${isr.over_budget ? '<span class="b x">over</span>' : '<span class="b ok">ok</span>'}${isr.period_us ? ' · period ' + fmt(isr.period_us) + ' · ' + instancesOf(isr).length + ' instances in window' : ''}</dd>`;
    if (sf) h += `<dt>structure</dt><dd>level ${sf.level} · layer ${sf.layer || '—'} · fan-in ${sf.fan_in} · fan-out ${sf.fan_out}${sf.tangled ? ' · <span class="b x">in tangle</span>' : ''}</dd>`;
    h += '</dl>';
    const evs = n && isr ? nodeEvents(n, isr, k) : (f ? f.hw.map(x => Object.assign({ t_us: null }, x)) : []);
    if (evs.length) h += `<table class="t"><tr><th>HW</th><th>op</th><th>t</th><th>deadline</th></tr>` + evs.map(e => `<tr class="${e.violation ? 'viol' : ''}"><td>${e.block}.${e.reg}</td><td>${e.kind}</td><td>${e.t_us == null ? '' : fmtAbs(e.t_us)}</td><td>${e.deadline_us == null ? '—' : (e.violation ? 'MISS +' + fmt(e.t_us - e.deadline_us) : 'ok −' + fmt(e.deadline_us - e.t_us))}</td></tr>`).join('') + '</table>';
    if (f && (f.vars.length || f.ipc.length || f.heap.length)) {
      h += `<table class="t"><tr><th>memory / IPC</th><th>kind</th><th>access</th></tr>` +
        f.vars.map(v => `<tr><td>${esc(v.name)}${v.member ? '<span style="color:var(--muted)">.' + esc(v.member) + '</span>' : ''}</td><td>${v.kind}${v.via_macro ? ' <span class="b">' + esc(v.via_macro) + '</span>' : ''}</td><td>${v.rw}</td></tr>`).join('') +
        f.ipc.map(i => `<tr><td>${esc(i.channel)}</td><td>ipc</td><td>${i.macro}</td></tr>`).join('') +
        f.heap.map(x => `<tr><td>${esc(x.fn)}</td><td>heap</td><td>alloc</td></tr>`).join('') + '</table>';
    }
    if (f && f.calls.length) h += `<div style="margin-top:6px;font-size:11.5px;color:var(--muted)">calls: ${f.calls.map(c => `<code>${esc(c.callee)}</code>`).join(', ')}</div>`;
    if (REL) h += relatedHtml();
  }
  el.innerHTML = h;
  el.querySelectorAll('.fnb').forEach(b => b.addEventListener('click', () => selectNode(findPath(b.dataset.fid), b.dataset.fid)));
  el.querySelectorAll('.blkl').forEach(b => b.addEventListener('click', () => selectBlock(b.dataset.block)));
  el.querySelectorAll('.ndl').forEach(b => b.addEventListener('click', () => selectSwNode(b.dataset.node)));
}
function blockEvents(b) {   // events of the shown instance of every visible ISR that touch block b
  const out = [];
  visibleIsrs().forEach(i => { const k = shownInst(i).k; i.flat.forEach(r => { nodeEvents(r.n, i, k).forEach(e => { if (e.block === b.id) out.push(e); }); }); });
  return out.sort((a, c) => a.t_us - c.t_us);
}
function blockDetail(b) {
  const evs = blockEvents(b);
  let h = `<div style="font-weight:600;font-size:13px">${esc(b.name)} <span class="mono" style="color:var(--muted)">${b.id} @ ${esc(b.base)}</span></div>`;
  if (HWN[b.id] && HWN[b.id].parent) h += `<div style="font-size:11.5px;color:var(--muted)">in ${HWL.anc[b.id].map(a => esc(HWN[a] ? HWN[a].name : a)).reverse().join(' › ')}</div>`;
  if (b.note) h += `<div style="font-size:11.5px">📝 ${esc(b.note)}</div>`;
  h += b.deadlines.map(d => `<div style="font-size:11.5px;color:var(--muted)">deadline: ${TIX[d.timing].name} ${(d.at_us / SYM).toFixed(2)} sym${d.period_us ? ' every ' + fmt(d.period_us) : ''}${d.cores ? ' · cores ' + d.cores.join(',') : ''}${d.note ? ' · ' + esc(d.note) : ''}</div>`).join('');
  h += `<table class="t"><tr><th>t</th><th>reg</th><th>op</th><th>function</th><th>ISR</th><th>deadline</th></tr>` + evs.map(e => `<tr class="${e.violation ? 'viol' : ''}"><td>${fmtAbs(e.t_us)}</td><td>${e.reg}</td><td>${e.kind}</td><td><span class="fnb" data-fid="${esc(e.fid)}" style="cursor:pointer">${esc(e.func)}</span></td><td>${esc(e.isr)}</td><td>${e.deadline_us == null ? '—' : (e.violation ? 'MISS +' + fmt(e.t_us - e.deadline_us) : 'ok −' + fmt(e.deadline_us - e.t_us))}</td></tr>`).join('') + '</table>';
  return h;
}
