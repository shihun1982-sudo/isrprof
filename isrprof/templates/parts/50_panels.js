// ================================================================== side panels: call graph, details, SW structure, HW cards
function renderTree() {
  const el = document.getElementById('tree-body');
  const html = visibleIsrs().map(isr => {
    const list = instancesOf(isr), inst = shownInst(isr), idx = list.findIndex(i => i.k === inst.k);
    const bar = list.length > 1 ? `<div class="instbar">instance ${idx + 1}/${list.length} (#${inst.k}) · ${fmtAbs(inst.start)}` +
      ` <button class="tog" data-isr="${esc(isr.name)}" data-step="-1" title="previous instance">◂</button><button class="tog" data-isr="${esc(isr.name)}" data-step="1" title="next instance">▸</button></div>` : '';
    return `<ul>${treeItem(isr.tree, isr.name + '#' + inst.k, isr, true, inst.k, bar)}</ul>`;
  }).join('');
  el.innerHTML = html || '<span style="color:var(--muted)">no ISR selected</span>';
  el.querySelectorAll('.car').forEach(c => c.addEventListener('click', e => { e.stopPropagation(); toggleExp(c.parentElement.dataset.path); renderAll(); }));
  el.querySelectorAll('.row').forEach(r => {
    r.addEventListener('click', () => selectNode(r.dataset.path, r.dataset.fid));
    r.addEventListener('mouseenter', e => { const n = nodeAt(r.dataset.path); if (n) showTip(nodeTip(n, isrOfPath(r.dataset.path), r.dataset.path), e.clientX, e.clientY); });
    r.addEventListener('mouseleave', hideTip);
  });
  el.querySelectorAll('.instbar button').forEach(b => b.addEventListener('click', () => {
    const isr = ISRX[b.dataset.isr], list = instancesOf(isr), idx = list.findIndex(i => i.k === shownInst(isr).k);
    const nk = list[(idx + (+b.dataset.step) + list.length) % list.length].k;
    S.inst[isr.name] = nk;
    if (S.selPath && isrOfPath(S.selPath) === isr) S.selPath = S.selPath.replace(/#-?\d+/, '#' + nk);
    renderAll();
  }));
  // keep the selected row visible inside the panel without scrolling the page itself
  const selRow = el.querySelector('.row.sel'), box = document.getElementById('tree');
  if (selRow && box) { const top = selRow.offsetTop - box.offsetTop; if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 24) box.scrollTop = Math.max(0, top - box.clientHeight / 2); }
}
function treeItem(n, path, isr, isRoot, k, extra) {
  const f = fnOf(n.fid), open = isExp(path), kids = n.children || [], evs = nodeEvents(n, isr, k);
  const viol = evs.filter(e => e.violation).length, badges = [];
  if (evs.length) { const r = evs.filter(e => e.kind === 'read').length, w = evs.length - r; if (r) badges.push(`<span class="b r">R${r}</span>`); if (w) badges.push(`<span class="b w">W${w}</span>`); }
  if (viol) badges.push(`<span class="b x">miss ${viol}</span>`);
  if (f && f.ipc.length) badges.push('<span class="b">ipc</span>');
  if (f && f.heap.length) badges.push('<span class="b w">heap</span>');
  if (n.external) badges.push('<span class="b ext">ext</span>');
  if (n.recursive) badges.push('<span class="b x">rec</span>');
  if (isRoot && isr.over_budget) badges.push('<span class="b x">over budget</span>');
  const dim = S.block ? !hl(n.fid) : !inFocus(path, n.fid);
  const row = `<div class="row ${isRoot ? 'isr' : ''} ${S.selPath === path ? 'sel' : ''} ${dim ? 'dim' : ''}" data-path="${esc(path)}" data-fid="${esc(n.fid)}">` +
    `<span class="car">${kids.length ? (open ? '▾' : '▸') : '·'}</span><i class="sw" style="background:${f ? modColor(f.module) : 'var(--muted)'}"></i>` +
    `<span class="nm">${isRoot ? '⚡ ' + esc(isr.name) + ' → ' : ''}${esc(n.name)}</span>${badges.join('')}<span class="t">${fmt(n.total_us)}</span></div>`;
  return `<li>${row}${extra || ''}${open && kids.length ? `<ul>${kids.map((c, i) => treeItem(c, path + '/' + i, isr, false, k)).join('')}</ul>` : ''}</li>`;
}

// ------------------------------------------------------------------ details
function relatedHtml() {
  const r = REL, mode = S.deep ? 'incl. callees down to the leaves' : 'this function only';
  let h = `<h3 style="margin-top:10px">Related · ${r.fids.size} function${r.fids.size > 1 ? 's' : ''} (${mode})</h3>`;
  h += `<div style="font-size:11.5px;line-height:1.9">${[...r.fids].map(f => `<span class="b ${f === S.selFid ? '' : 'ext'}">${esc(short(f))}</span>`).join(' ')}</div>`;
  if (r.blocks.size) h += `<table class="t"><tr><th>HW block</th><th>registers</th><th>R</th><th>W</th><th>miss</th></tr>` +
    [...r.blocks].map(([b, x]) => `<tr class="${x.miss ? 'viol' : ''}"><td>${esc(BX[b] ? BX[b].name : b)} <span style="color:var(--muted)">${esc(b)}</span></td><td>${[...x.regs].map(([rg, n]) => rg + (n > 1 ? '×' + n : '')).join(' ')}</td><td>${x.r}</td><td>${x.w}</td><td>${x.miss || ''}</td></tr>`).join('') + '</table>';
  else h += '<div style="color:var(--muted);font-size:11.5px;margin-top:4px">no HW register access in this set</div>';
  if (r.vars.size) h += `<table class="t"><tr><th>variable</th><th>kind</th><th>access</th><th>by</th></tr>` +
    [...r.vars.values()].map(({ v, rw, fids }) => {
      const fl = Object.entries(v.fields || {}).filter(([, fi]) => fi.fids.some(x => r.fids.has(x)));
      return `<tr><td>${esc(v.name)}${v.registered ? ' <span class="b" title="registered in the config">®</span>' : ''}${v.shared_across_cores ? ' <span class="b x" title="touched from more than one core">cross-core</span>' : ''}</td><td>${v.kind}</td><td>${rw.join('/')}</td><td>${fids.map(short).join(', ')}</td></tr>` +
        fl.map(([name, fi]) => `<tr><td style="padding-left:14px;color:var(--muted)">.${esc(name)}</td><td></td><td>${fi.r ? 'r' : ''}${fi.r && fi.w ? '/' : ''}${fi.w ? 'w' : ''}</td><td style="color:var(--muted)">${fi.fids.filter(x => r.fids.has(x)).map(short).join(', ')}</td></tr>`).join('');
    }).join('') + '</table>';
  if (r.ipc.size) h += `<div style="font-size:11.5px;margin-top:6px"><b>IPC</b> ${[...r.ipc].map(([ch, ops]) => `<code>${esc(ch)}</code> (${ops.map(o => o.macro.replace('IPC_', '').toLowerCase() + ' in ' + short(o.fid)).join(', ')})`).join(' · ')}</div>`;
  if (r.heap.length) h += `<div style="font-size:11.5px;margin-top:4px"><b>Heap</b> ${r.heap.map(u => `<code>${esc(short(u.fid))}</code> → ${u.calls.map(c => esc(c.fn)).join(', ')}`).join(' · ')}</div>`;
  h += `<div style="font-size:11.5px;margin-top:4px;color:var(--muted)">modules: ${[...r.modules].map(esc).join(', ')} · cores: ${[...r.cores].sort().join(', ') || '—'}</div>`;
  return h;
}
// variable / structure: who uses it (first-level functions, grouped by core), which fields, how
function varDetail(key) {
  const v = VARX[key]; if (!v) return '';
  const users = varUsers(v), byCore = new Map();
  users.forEach(u => { const c = u.core == null ? '?' : u.core; if (!byCore.has(c)) byCore.set(c, []); byCore.get(c).push(u); });
  let h = `<div class="mono" style="font-weight:600;font-size:13px">${esc(v.name)} <span class="b">${v.kind}</span>${v.registered ? ' <span class="b" title="registered in the config">registered</span>' : ''}${v.shared_across_cores ? ' <span class="b x">cross-core</span>' : ''}</div><dl class="kv">`;
  h += `<dt>where</dt><dd>${esc(v.file)}${v.line ? ':' + v.line : ''}</dd><dt>decl</dt><dd>${esc(v.decl)}</dd>`;
  if (v.note) h += `<dt>note</dt><dd>${esc(v.note)}</dd>`;
  h += `<dt>cores</dt><dd>${v.cores.join(', ') || '—'} · ${users.length} function${users.length === 1 ? '' : 's'}</dd></dl>`;
  h += `<table class="t"><tr><th>core</th><th>function</th><th>access</th><th>fields / via</th></tr>` +
    [...byCore].map(([c, list]) => list.map((u, i) => `<tr><td>${i === 0 ? 'core ' + c : ''}</td><td>${esc(short(u.fid))}</td><td>${u.rw.join('/')}</td><td>${u.members.map(m => '.' + esc(m)).join(' ')}${u.via.length ? ' <span class="b">' + u.via.map(esc).join(', ') + '</span>' : ''}</td></tr>`).join('')).join('') + '</table>';
  const fields = Object.entries(v.fields || {});
  if (fields.length) h += `<table class="t"><tr><th>field</th><th>reads</th><th>writes</th><th>by</th></tr>` + fields.sort().map(([n, fi]) => `<tr><td>.${esc(n)}</td><td>${fi.r}</td><td>${fi.w}</td><td>${fi.fids.map(short).join(', ')}</td></tr>`).join('') + '</table>';
  return h;
}
function renderDetail() {
  const el = document.getElementById('detail-body');
  if (S.block) { el.innerHTML = blockDetail(BX[S.block]); return; }
  if (S.selVar && !S.selFid) { el.innerHTML = varDetail(S.selVar); return; }
  if (!S.selFid) { el.innerHTML = '<span style="color:var(--muted)">Click a box in the 3D view, a row in the call graph, a function in the SW structure or a HW block. The Focus toggle decides whether the selection relates only that function or its whole call subtree; ◂ ▸ in the call graph steps through periodic instances.</span>'; return; }
  const shownPath = S.selPath || findPath(S.selFid);
  const n = shownPath ? nodeAt(shownPath) : null, f = fnOf(S.selFid), sf = ST.functions[S.selFid];
  const isr = shownPath ? isrOfPath(shownPath) : null, k = shownPath ? instOfPath(shownPath) : 0, dt = isr ? k * (isr.period_us || 0) : 0;
  let h = `<div class="mono" style="font-weight:600;font-size:13px">${esc(short(S.selFid))}${f && f.static ? ' <span class="b">static</span>' : ''}</div><dl class="kv">`;
  if (f) h += `<dt>where</dt><dd>${esc(f.file)}:${f.line}–${f.end_line} · ${esc(f.module)} · core ${f.core == null ? '?' : f.core}</dd><dt>signature</dt><dd>${esc(f.signature)}</dd>`;
  if (f && f.summary) h += `<dt>summary</dt><dd>${esc(f.summary)} <span class="b">llm</span></dd>`;
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
  el.innerHTML = h;
}
function blockEvents(b) {   // events of the shown instance of every visible ISR that touch block b
  const out = [];
  visibleIsrs().forEach(i => { const k = shownInst(i).k; walk(i.tree, i.name + '#' + k, n => { nodeEvents(n, i, k).forEach(e => { if (e.block === b.id) out.push(e); }); }); });
  return out.sort((a, c) => a.t_us - c.t_us);
}
function blockDetail(b) {
  const evs = blockEvents(b);
  let h = `<div style="font-weight:600;font-size:13px">${esc(b.name)} <span class="mono" style="color:var(--muted)">${b.id} @ ${esc(b.base)}</span></div>`;
  h += b.deadlines.map(d => `<div style="font-size:11.5px;color:var(--muted)">deadline: ${TIX[d.timing].name} ${(d.at_us / SYM).toFixed(2)} sym${d.period_us ? ' every ' + fmt(d.period_us) : ''}${d.cores ? ' · cores ' + d.cores.join(',') : ''}${d.note ? ' · ' + esc(d.note) : ''}</div>`).join('');
  h += `<table class="t"><tr><th>t</th><th>reg</th><th>op</th><th>function</th><th>ISR</th><th>deadline</th></tr>` + evs.map(e => `<tr class="${e.violation ? 'viol' : ''}"><td>${fmtAbs(e.t_us)}</td><td>${e.reg}</td><td>${e.kind}</td><td>${esc(e.func)}</td><td>${esc(e.isr)}</td><td>${e.deadline_us == null ? '—' : (e.violation ? 'MISS +' + fmt(e.t_us - e.deadline_us) : 'ok −' + fmt(e.deadline_us - e.t_us))}</td></tr>`).join('') + '</table>';
  return h;
}

// ------------------------------------------------------------------ SW structure (SVG)
function renderSW() {
  const host = document.getElementById('sw');
  const cores = CORES.filter(c => S.cores.has(c.id));
  // any number of cores: columns wrap into rows of at most `viewer.sw_structure.columns` (default 4)
  const perRow = Math.max(1, Math.min(cores.length, +((V.sw_structure || {}).columns || 4)));
  const Wd = Math.max(host.clientWidth || 900, 320), colGap = 18, colW = (Wd - colGap * (perRow - 1)) / perRow;
  const ROW = 18, MODH = 24, chans = P.memory.ipc_channels, TOPBAND = chans.length ? 22 + chans.length * 15 : 0, HDR = TOPBAND + 56;
  const byCore = {};
  Object.values(F).forEach(f => { const c = f.core == null ? cores[0].id : f.core; (byCore[c] = byCore[c] || {}); (byCore[c][f.module] = byCore[c][f.module] || []).push(f); });
  const pos = {}; let maxY = 0, out = '', edges = '';
  const rowHeights = [], rowTop = [];        // per core row: tallest column decides where the next row starts
  cores.forEach((c, ci) => {
    const colIdx = ci % perRow, rowIdx = Math.floor(ci / perRow);
    if (colIdx === 0) rowTop[rowIdx] = rowIdx === 0 ? 0 : rowTop[rowIdx - 1] + rowHeights[rowIdx - 1] + 20;
    const x = colIdx * (colW + colGap), hy = TOPBAND + rowTop[rowIdx];
    out += `<rect x="${x}" y="${hy}" width="${colW}" height="46" rx="6" fill="${coreColor(c.id)}" opacity=".13"/><rect x="${x}" y="${hy}" width="4" height="46" rx="2" fill="${coreColor(c.id)}"/>`;
    out += `<text class="sw-hd" x="${x + 12}" y="${hy + 18}">${esc(c.name)}</text><text class="sw-sub" x="${x + 12}" y="${hy + 34}">${c.clock_mhz} MHz · ISRs: ${P.isrs.filter(i => i.core === c.id).map(i => i.name).join(', ') || '—'}</text>`;
    let y = hy + 56;
    const mods = Object.keys(byCore[c.id] || {}).sort((a, b) => (MODIDX[a] || 0) - (MODIDX[b] || 0));
    for (const m of mods) {
      const fns = byCore[c.id][m].slice().sort((a, b) => (ST.functions[b.id] ? ST.functions[b.id].level : -1) - (ST.functions[a.id] ? ST.functions[a.id].level : -1) || a.name.localeCompare(b.name));
      const open = S.swOpen.has(c.id + '|' + m);
      const anyIn = REL || S.block ? fns.some(f => hl(f.id)) : (S.selVar && VARX[S.selVar] ? fns.some(f => VARX[S.selVar].accessors.some(a => a.fid === f.id)) : fns.some(f => inSlice(f.id)));
      const h = MODH + (open ? fns.length * ROW + 6 : 0), mi = ST.modules.find(z => z.name === m);
      out += `<g class="sw-modg" data-key="${esc(c.id + '|' + m)}"><rect class="sw-mod ${anyIn ? '' : 'dim'} ${REL && REL.modules.has(m) ? 'rel' : ''}" x="${x}" y="${y}" width="${colW}" height="${h}" rx="5"/>` +
        `<rect x="${x}" y="${y}" width="4" height="${h}" rx="2" fill="${modColor(m)}"/>` +
        `<text x="${x + 12}" y="${y + 16}" font-weight="600" style="pointer-events:none">${open ? '▾' : '▸'} ${esc(m)} <tspan class="sw-sub">${fns.length} fn${fns.length > 1 ? 's' : ''}${mi && mi.overweight ? ' · overweight' : ''}</tspan></text></g>`;
      if (open) {
        fns.forEach((f, k) => {
          const fy = y + MODH + k * ROW, isIsr = P.isrs.some(i => i.entry === f.name && i.core === c.id), marks = [];
          if (isIsr) marks.push('⚡');
          if (f.hw.length) marks.push(`<tspan fill="var(--write)">▣${f.hw.length}</tspan>`);
          if (f.ipc.length) marks.push('<tspan fill="var(--accent)">⇄</tspan>');
          if (f.heap.length) marks.push('<tspan fill="var(--serious)">H</tspan>');
          if (ST.functions[f.id] && ST.functions[f.id].tangled) marks.push('<tspan fill="var(--critical)">↻</tspan>');
          const usesSel = !!(S.selVar && VARX[S.selVar] && VARX[S.selVar].accessors.some(a => a.fid === f.id));
          const related = REL || S.block ? hl(f.id) : (S.selVar ? usesSel : inSlice(f.id));
          out += `<g class="sw-fn ${S.selFid === f.id ? 'sel' : ''} ${related ? '' : 'dim'} ${(REL && REL.fids.has(f.id)) || usesSel ? 'rel' : ''}" data-fid="${esc(f.id)}"><rect x="${x + 6}" y="${fy}" width="${colW - 12}" height="${ROW - 1}" rx="3" stroke="none"/>` +
            `<text x="${x + 14}" y="${fy + 13}">${esc(f.name)}</text><text x="${x + colW - 10}" y="${fy + 13}" text-anchor="end" font-size="10">${marks.join(' ')}</text></g>`;
          pos[f.id] = { x: x + 6, y: fy + ROW / 2, w: colW - 12 };
        });
      } else fns.forEach(f => { pos[f.id] = { x, y: y + MODH / 2, w: colW, collapsed: true }; });
      y += h + 6;
    }
    rowHeights[rowIdx] = Math.max(rowHeights[rowIdx] || 0, y - hy);
    maxY = Math.max(maxY, y);
  });
  // IPC arcs in the band above the headers (first row of cores; arcs to lower rows start from their column)
  const cx = id => { const i = cores.findIndex(c => c.id === id); return i < 0 ? null : (i % perRow) * (colW + colGap) + colW / 2; };
  let ipc = chans.length ? `<text class="sw-sub" x="0" y="11">IPC CHANNELS (sender → receiver; hover for the functions involved)</text>` : '';
  chans.forEach((ch, k) => {
    const a = cx(ch.from), b = cx(ch.to); if (a == null || b == null) return;
    const y = TOPBAND, lift = TOPBAND - 16 - k * 15, dir = b > a ? 1 : -1, sx = a + dir * (40 + k * 18), ex = b - dir * (40 + k * 18);
    const senders = P.memory.ipc_ops.filter(o => o.channel === ch.id && o.macro !== 'IPC_RECV').map(o => short(o.fid)), receivers = P.memory.ipc_ops.filter(o => o.channel === ch.id && o.macro === 'IPC_RECV').map(o => short(o.fid));
    const relIpc = REL ? (REL.ipc.has(ch.id) ? 'rel' : 'dim') : '';
    ipc += `<g class="sw-ipcg ${relIpc}" data-tip="${esc(`IPC ${ch.id}: core${ch.from} → core${ch.to}\nsend: ${senders.join(', ') || '—'}\nrecv: ${receivers.join(', ') || '—'}`)}"><path class="sw-ipc" d="M${sx},${y} C${sx},${y - lift} ${ex},${y - lift} ${ex},${y}" marker-end="url(#arr)"/>` +
      `<text class="sw-ipc-t" x="${(sx + ex) / 2}" y="${y - lift * 0.75 - 3}" text-anchor="middle" fill="var(--accent)">${esc(ch.id)}</text></g>`;
  });
  // shared memory band
  const vars = P.memory.variables.filter(v => v.accessors.length), bandY = maxY + 26;
  out += `<text class="sw-sub" x="0" y="${bandY - 8}">SHARED MEMORY — heap · G global · S file-static · SL function-static · yellow border = touched from more than one core · lines: blue read / orange write, drawn for the focused function's variables or a hovered / clicked pill</text>`;
  let vx = 0, vy = bandY, vrow = 0; const vpos = {};
  const pills = [{ key: 'heap', name: 'heap (' + [...new Set(P.memory.heap_users.flatMap(u => u.calls.map(c => c.fn)))].join(', ') + ')', kind: 'heap', accessors: P.memory.heap_users.map(u => ({ fid: u.fid, rw: 'w' })), shared: false }]
    .concat(vars.map(v => ({ key: v.name + '|' + v.file, name: v.name, kind: v.kind, accessors: v.accessors, shared: v.shared_across_cores, cores: v.cores, decl: v.decl, registered: v.registered, fields: v.fields || {}, note: v.note })));
  pills.forEach(v => {
    const nf = Object.keys(v.fields || {}).length;
    const lab = `${v.name}${v.kind === 'heap' ? '' : ' · ' + ({ global: 'G', static: 'S', static_local: 'SL', extern: 'G' }[v.kind] || v.kind)}${v.registered ? ' ®' : ''}${nf ? ` {${nf}}` : ''}`, w = lab.length * 6.8 + 18;
    if (vx + w > Wd) { vx = 0; vrow++; vy = bandY + vrow * 26; }
    const rel = REL ? (v.kind === 'heap' ? REL.heap.length > 0 : REL.vars.has(v.key)) : (S.block ? v.accessors.some(a => hl(a.fid)) : false);
    const on = S.hoverVar === v.key || S.selVar === v.key || rel, dimv = (REL || S.block) && !rel && S.hoverVar !== v.key;
    const fieldsTip = Object.entries(v.fields || {}).map(([n, fi]) => `.${n} ${fi.r ? 'r' + fi.r : ''}${fi.w ? ' w' + fi.w : ''}`).join(', ');
    out += `<g class="sw-var ${v.shared ? 'shared' : ''} ${v.kind === 'heap' ? 'heap' : ''} ${rel ? 'rel' : ''} ${dimv ? 'dim' : ''}" data-key="${esc(v.key)}" data-tip="${esc(`${v.name} (${v.kind}${v.registered ? ', registered in config' : ''}${v.cores ? ', cores ' + v.cores.join(',') : ''})\n${v.decl || ''}${v.note ? '\n' + v.note : ''}${fieldsTip ? '\nfields: ' + fieldsTip : ''}\n${v.accessors.map(a => short(a.fid) + ' [' + a.rw + (a.member ? ' .' + a.member : '') + ']').join(', ')}`)}"><rect x="${vx}" y="${vy}" width="${w}" height="20" rx="10"/><text x="${vx + 9}" y="${vy + 14}">${esc(lab)}</text></g>`;
    vpos[v.key] = { x: vx + w / 2, y: vy, on };
    vx += w + 8;
  });
  const totalH = vy + 30;
  pills.forEach(v => {
    const vp = vpos[v.key], shown = vp.on;        // edges only for related / pinned / hovered variables (keeps big projects readable)
    v.accessors.forEach(a => {
      const p = pos[a.fid]; if (!p) return;
      const x1 = vp.x, y1 = vp.y, x2 = p.collapsed ? p.x + p.w / 2 : p.x + p.w, y2 = p.y;
      const col = a.rw === 'r' ? 'var(--read)' : (a.rw === 'addr' ? 'var(--muted)' : 'var(--write)');
      edges += `<path class="sw-edge ${shown ? '' : 'hid'} ${vp.on ? 'on' : ''}" data-var="${esc(v.key)}" d="M${x1},${y1} C${x1},${y1 - 40} ${x2},${y2 + 40} ${x2},${y2}" stroke="${col}"/>`;
    });
  });
  host.innerHTML = `<svg viewBox="0 0 ${Wd} ${totalH}" width="${Wd}" height="${totalH}"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/></marker></defs>${edges}${out}${ipc}</svg>`;
  host.querySelectorAll('.sw-modg').forEach(g => g.addEventListener('click', () => { const k = g.dataset.key; if (S.swOpen.has(k)) S.swOpen.delete(k); else S.swOpen.add(k); renderSW(); }));
  host.querySelectorAll('.sw-fn').forEach(g => {
    g.addEventListener('click', () => { if (S.selFid === g.dataset.fid) clearFocus(); else selectNode(null, g.dataset.fid); });
    g.addEventListener('mouseenter', e => { const f = fnOf(g.dataset.fid), sf = ST.functions[g.dataset.fid]; showTip(`<span class="mono"><b>${esc(f.name)}</b></span><span class="m">${esc(f.file)}:${f.line}${sf ? ` · level ${sf.level} · ${sf.layer || 'no layer'}` : ''}</span>${f.hw.length ? `<span class="mono">HW: ${f.hw.map(h => h.block + '.' + h.reg + ' ' + h.kind[0].toUpperCase()).join(', ')}</span>` : ''}${f.vars.length ? `<span class="mono">vars: ${f.vars.map(v => v.name + '[' + v.rw + ']').join(', ')}</span>` : ''}`, e.clientX, e.clientY); });
    g.addEventListener('mouseleave', hideTip);
  });
  const edgesOf = key => host.querySelectorAll(`.sw-edge[data-var="${CSS.escape(key)}"]`);
  host.querySelectorAll('.sw-var, .sw-ipcg').forEach(g => {
    g.addEventListener('mouseenter', e => { showTip(esc(g.dataset.tip).replace(/\n/g, '<br>'), e.clientX, e.clientY); if (g.dataset.key) edgesOf(g.dataset.key).forEach(p => p.classList.add('on')); });
    g.addEventListener('mouseleave', () => { hideTip(); if (g.dataset.key && S.hoverVar !== g.dataset.key) edgesOf(g.dataset.key).forEach(p => p.classList.remove('on')); });
    g.addEventListener('click', () => { if (!g.dataset.key) return; const k = g.dataset.key; if (S.selVar === k) { S.selVar = null; S.hoverVar = null; renderAll(); } else selectVar(k); });
  });
}

// ------------------------------------------------------------------ HW block cards
function renderHW() {
  const host = document.getElementById('hw'), vis = visibleIsrs(), evsAll = vis.flatMap(i => i.hw_events);
  const cols = Math.max(...BLOCKS.map(b => b.pos[0])) + 1, sorted = BLOCKS.slice().sort((a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0]);
  let h = `<div class="grid" style="grid-template-columns:repeat(${Math.min(cols, 4)}, minmax(200px, 1fr))">`;
  for (const b of sorted) {
    const evs = evsAll.filter(e => e.block === b.id);
    const fevs = REL ? evs.filter(e => REL.evKeys.has(evKey(e)) || REL.events.some(x => x.block === e.block && x.fid === e.fid && x.line === e.line)) : evs;
    const r = fevs.filter(e => e.kind === 'read').length, w = fevs.length - r, viol = fevs.filter(e => e.violation).length;
    const regCount = {}; fevs.forEach(e => { regCount[e.reg] = (regCount[e.reg] || 0) + 1; });
    const acc = [...new Set(evs.map(e => e.fid))], relB = REL ? REL.blocks.has(b.id) : (S.block ? S.block === b.id : true);
    const execs = vis.filter(i => i.hw_events.some(e => e.block === b.id)).map(i => `${i.name}×${instancesOf(i).length}`);
    h += `<div class="blk ${S.block === b.id ? 'sel' : ''} ${viol ? 'viol' : ''} ${REL && relB ? 'rel' : ''} ${relB ? '' : 'dim'}" data-block="${b.id}" tabindex="0">` +
      `<div class="hd"><b>${esc(b.name)}</b><span class="id">${b.id} · ${esc(b.base)}</span><span class="cnt">${REL && relB ? '<span class="b">focus</span>' : ''}${r ? `<span class="b r">R ${r}</span>` : ''}${w ? `<span class="b w">W ${w}</span>` : ''}${viol ? `<span class="b x">miss ${viol}</span>` : (b.deadlines.length && fevs.length ? '<span class="b ok">in time</span>' : '')}</span></div>` +
      `<div class="regs">${b.regs.map(rg => `<span class="${regCount[rg] ? 'hot' : ''}">${rg}${regCount[rg] ? ' ×' + regCount[rg] : ''}</span>`).join('')}</div>` +
      (b.deadlines.length ? `<div class="dl">${b.deadlines.map(d => `deadline <b>${TIX[d.timing].name} ≤ ${(d.at_us / SYM).toFixed(2)} sym${d.period_us ? ' / ' + fmt(d.period_us) : ''}</b>${d.cores ? ` <span class="b">core ${d.cores.join(',')}</span>` : ''}`).join('<br>')}</div>` : '<div class="dl">no deadline</div>') +
      `<div class="acc">${acc.length ? acc.map(a => `<code class="${REL && REL.fids.has(a) ? 'rel' : ''}">${esc(short(a))}</code>`).join(' ') : '<em>not accessed by the selected ISRs</em>'}${execs.length ? `<div>${execs.join(' · ')} executions in window</div>` : ''}</div></div>`;
  }
  h += '</div>';
  if (P.hw.unknown_blocks.length) h += `<p style="color:var(--serious);font-size:12px;margin:8px 0 0">Register macros reference blocks not in the config: ${P.hw.unknown_blocks.map(esc).join(', ')}</p>`;
  host.innerHTML = h;
  host.querySelectorAll('.blk').forEach(d => d.addEventListener('click', () => selectBlock(d.dataset.block)));
}
