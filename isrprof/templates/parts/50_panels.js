// ================================================================== side panels: call graph of the selection, details
function renderTree() {
  const el = document.getElementById('tree-body');
  let html = '';
  if (S.selPath && nodeAt(S.selPath)) {
    const isr = isrOfPath(S.selPath), list = instancesOf(isr), inst = shownInst(isr), idx = list.findIndex(i => i.k === inst.k);
    const isrRoot = S.selPath.split('/')[0];
    // root of the tree: the pinned function (while the selection stays inside its subtree), otherwise the ISR entry;
    // the selection is only highlighted, it never re-roots the tree by itself
    if (S.pinPath && !(S.selPath === S.pinPath || S.selPath.startsWith(S.pinPath + '/'))) S.pinPath = null;
    const rootPath = S.pinPath || isrRoot;
    // every ancestor between the root and the selection is opened so the selected row is visible
    const parts = S.selPath.split('/'); let changed = false;
    for (let i = rootPath.split('/').length; i < parts.length; i++) { const p = parts.slice(0, i).join('/'); const n = nodeAt(p); if (n && n.children.length && !isExp(p)) { S.collapsed.delete(expKey(p)); S.expanded.add(expKey(p)); changed = true; } }
    if (changed) bumpExp();
    const crumbs = []; for (let i = 1; i < rootPath.split('/').length; i++) { const p = parts.slice(0, i).join('/'); const n = nodeAt(p); if (n) crumbs.push(`<span class="crumb" data-path="${esc(p)}">${esc(n.name)}</span>`); }
    const sel = nodeAt(S.selPath), hasParent = parts.length > 1, hasChild = sel.children.length > 0;
    const bar = `<div class="instbar">${esc(isr.name)} · instance ${idx + 1}/${list.length} (#${inst.k}) · ${fmtAbs(inst.start)}` +
      (list.length > 1 ? ` <button class="tog" data-isr="${esc(isr.name)}" data-step="-1" title="previous instance">◂</button><button class="tog" data-isr="${esc(isr.name)}" data-step="1" title="next instance">▸</button>` : '') +
      `<div class="cgnav"><label class="chk" title="keep the selected function as the top of this tree while you walk down its callees"><input type="checkbox" id="pin-root" ${S.pinPath ? 'checked' : ''}>pin <b>${esc(short(S.selFid))}</b> as root</label>` +
      `<button class="tog mini" id="nav-caller" ${hasParent ? '' : 'disabled'} title="move the selection to the caller (one level up)">▲ caller</button>` +
      `<button class="tog mini" id="nav-callee" ${hasChild ? '' : 'disabled'} title="move the selection to the first callee (one level down)">▼ callee</button>` +
      `<button class="tog mini" id="nav-prev" title="previous sibling call">◁</button><button class="tog mini" id="nav-next" title="next sibling call">▷</button></div>` +
      (crumbs.length ? `<div class="crumbs">${crumbs.join(' › ')} ›</div>` : '') + '</div>';
    html = `<ul>${treeItem(nodeAt(rootPath), rootPath, isr, rootPath === isrRoot, inst.k, bar, 0)}</ul>`;
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
  const pin = el.querySelector('#pin-root'); if (pin) pin.addEventListener('change', () => { S.pinPath = pin.checked ? S.selPath : null; renderTree(); });
  const nav = (id, fn) => { const b = el.querySelector('#' + id); if (b) b.addEventListener('click', e => { e.stopPropagation(); const p = fn(); if (p && nodeAt(p)) selectNode(p, nodeAt(p).fid); }); };
  nav('nav-caller', () => { const parts = S.selPath.split('/'); return parts.length > 1 ? parts.slice(0, -1).join('/') : null; });
  nav('nav-callee', () => { const n = nodeAt(S.selPath); if (!n || !n.children.length) return null; if (!isExp(S.selPath)) toggleExp(S.selPath); return S.selPath + '/0'; });
  const sib = d => { const parts = S.selPath.split('/'); if (parts.length < 2) return null; const parent = nodeAt(parts.slice(0, -1).join('/')); const i = +parts[parts.length - 1] + d; return parent && i >= 0 && i < parent.children.length ? parts.slice(0, -1).join('/') + '/' + i : null; };
  nav('nav-prev', () => sib(-1)); nav('nav-next', () => sib(1));
  el.querySelectorAll('.instbar button[data-isr]').forEach(b => b.addEventListener('click', () => {
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
    `<span class="nm">${isRoot ? esc(isr.name) + ' → ' : ''}${esc(n.name)}</span>${badges.join('')}<span class="t">${fmt(n.total_us)}</span></div>`;
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
// Details: the relations of the focus set as collapsible sections, SW structure first (as a hierarchy), then HW
// structure (chains › blocks › registers), then shared memory, IPC / heap and the related functions
const rwWord = rw => rw === 'x' ? 'executes' : rw === 'c' ? '' : rw === 'rw' ? 'read / write' : rw === 'w' ? 'write' : 'read';
const rwCls = rw => rw === 'x' ? 'x' : rw === 'rw' || rw === 'w' ? 'w' : rw === 'r' ? 'r' : '';
function section(id, title, count, body, open) {
  return `<details class="sub" id="${id}" ${open ? 'open' : ''}><summary>${title}<span class="cnt">${count}</span></summary><div class="sub-body">${body}</div></details>`;
}
function swTreeHtml(r) {
  // every touched node plus its ancestors, in the hierarchy's depth-first order (SWS.nodes is already that order)
  const rows = SWS.nodes.filter(n => r.sw.has(n.id));
  if (!rows.length) return '<div class="muted">no SW structure node touched</div>';
  return rows.map(n => {
    const t = r.sw.get(n.id), kind = t.rw, fns = [...t.fids].map(short);
    return `<div class="rel-row ${rwCls(kind)} ${kind === 'c' ? 'anc' : ''}" style="padding-left:${6 + n.depth * 14}px" data-node="${esc(n.id)}" title="${esc(n.kind)}${n.note ? ' · ' + esc(n.note) : ''}">` +
      `<span class="tw">${n.children.length ? '▾' : '·'}</span><span class="nm">${esc(n.name)}</span><span class="kd">${esc(n.kind)}</span>` +
      (kind !== 'c' ? `<span class="b ${rwCls(kind)}">${rwWord(kind)}</span><span class="by">${fns.join(', ')}</span>` : '') + '</div>';
  }).join('');
}
function hwTreeHtml(r) {
  const rows = HWS.nodes.filter(n => r.hw.has(n.id));
  if (!rows.length) return '<div class="muted">no HW register access in this set</div>';
  return rows.map(n => {
    const t = r.hw.get(n.id), isBlock = !!BX[n.id];
    let h = `<div class="rel-row ${t.c ? 'anc' : (t.miss ? 'miss' : (t.w ? 'w' : 'r'))}" style="padding-left:${6 + n.depth * 14}px" data-block="${isBlock ? esc(n.id) : ''}" data-hwnode="${esc(n.id)}" title="${esc(n.kind)}${n.note ? ' · ' + esc(n.note) : ''}">` +
      `<span class="tw">${n.children.length ? '▾' : '·'}</span><span class="nm">${esc(n.name)}</span><span class="kd">${isBlock ? esc(n.id) : esc(n.kind)}</span>` +
      (t.c ? '' : `${t.r ? `<span class="b r">R ${t.r}</span>` : ''}${t.w ? `<span class="b w">W ${t.w}</span>` : ''}${t.miss ? `<span class="b x">miss ${t.miss}</span>` : ''}`) + '</div>';
    if (!t.c && t.regs && t.regs.size) h += `<div class="rel-regs" style="padding-left:${26 + n.depth * 14}px">${[...t.regs].map(([rg, c]) => `<span class="reg ${c.miss ? 'miss' : ''}">${esc(rg)}<i>${c.r ? 'R' + c.r : ''}${c.w ? 'W' + c.w : ''}</i></span>`).join('')}</div>`;
    return h;
  }).join('');
}
function relatedHtml() {
  const r = REL, mode = S.deep ? 'incl. callees down to the leaves' : 'this function only';
  const swN = [...r.sw.values()].filter(t => t.rw !== 'c').length, hwN = r.blocks.size;
  let h = `<div class="rel-head">Related · ${r.fids.size} function${r.fids.size > 1 ? 's' : ''} <span class="muted">(${mode})</span></div>`;
  h += section('sec-sw', 'SW structure', `${swN} node${swN === 1 ? '' : 's'}`, swTreeHtml(r), true);
  h += section('sec-hw', 'HW structure', `${hwN} block${hwN === 1 ? '' : 's'}`, hwTreeHtml(r), true);
  let vars = '';
  if (r.vars.size) vars = `<table class="t"><tr><th>variable</th><th>kind</th><th>access</th><th>by</th></tr>` +
    [...r.vars.values()].map(({ v, rw, fids }) => {
      const fl = Object.entries(v.fields || {}).filter(([, fi]) => fi.fids.some(x => r.fids.has(x)));
      return `<tr><td><span class="varl" data-var="${esc(v.key)}" style="cursor:pointer">${esc(v.name)}</span>${v.registered ? ' <span class="b" title="registered in the config">®</span>' : ''}${v.shared_across_cores ? ' <span class="b x" title="touched from more than one core">cross-core</span>' : ''}${VNODE[v.key] ? ` <span class="muted">‹ ${esc(SWN[VNODE[v.key]] ? SWN[VNODE[v.key]].name : VNODE[v.key])}</span>` : ''}</td><td>${v.kind}</td><td>${rw.join('/')}</td><td>${fids.map(short).join(', ')}</td></tr>` +
        fl.map(([name, fi]) => `<tr><td style="padding-left:14px;color:var(--muted)">.${esc(name)}</td><td></td><td>${fi.r ? 'r' : ''}${fi.r && fi.w ? '/' : ''}${fi.w ? 'w' : ''}</td><td style="color:var(--muted)">${fi.fids.filter(x => r.fids.has(x)).map(short).join(', ')}</td></tr>`).join('');
    }).join('') + '</table>';
  else vars = '<div class="muted">no shared variable touched</div>';
  h += section('sec-vars', 'Shared memory / variables', `${r.vars.size}`, vars, r.vars.size > 0);
  let io = '';
  if (r.ipc.size) io += `<div><b>IPC</b> ${[...r.ipc].map(([ch, ops]) => `<code class="ipcl" data-ipc="${esc(ch)}" style="cursor:pointer">${esc(ch)}</code> (${ops.map(o => o.macro.replace('IPC_', '').toLowerCase() + ' in ' + short(o.fid)).join(', ')})`).join(' · ')}</div>`;
  if (r.heap.length) io += `<div><b>Heap</b> ${r.heap.map(u => `<code>${esc(short(u.fid))}</code> → ${u.calls.map(c => esc(c.fn)).join(', ')}`).join(' · ')}</div>`;
  if (io) h += section('sec-io', 'IPC / heap', `${r.ipc.size + r.heap.length}`, io, true);
  h += section('sec-fns', 'Functions', `${r.fids.size}`, `<div class="fnlist">${[...r.fids].map(f => `<span class="b ${f === S.selFid ? '' : 'ext'} fnb" data-fid="${esc(f)}">${esc(short(f))}</span>`).join(' ')}</div>` +
    `<div class="muted">modules: ${[...r.modules].map(m => esc(SWN[m] ? SWN[m].name : m)).join(', ')} · cores: ${[...r.cores].sort().join(', ') || '—'}</div>`, false);
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
  if (VNODE[key]) h += `<dt>SW node</dt><dd><span class="ndl" data-node="${esc(VNODE[key])}" style="cursor:pointer">${esc(SWN[VNODE[key]] ? SWN[VNODE[key]].name : VNODE[key])}</span></dd>`;
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
function ipcDetail(ch) {
  const c = P.memory.ipc_channels.find(x => x.id === ch), ops = P.memory.ipc_ops.filter(o => o.channel === ch);
  let h = `<div class="mono" style="font-weight:600;font-size:13px">${esc(ch)} <span class="b">ipc channel</span></div><dl class="kv">`;
  if (c) h += `<dt>direction</dt><dd>core ${c.from} → core ${c.to}</dd>`;
  h += `<dt>used by</dt><dd>${ops.length} call${ops.length === 1 ? '' : 's'}</dd></dl>`;
  h += `<table class="t"><tr><th>function</th><th>core</th><th>op</th><th>line</th></tr>${ops.map(o => `<tr><td><span class="fnb" data-fid="${esc(o.fid)}" style="cursor:pointer">${esc(short(o.fid))}</span></td><td>${o.core == null ? '?' : o.core}</td><td>${esc(o.macro)}</td><td>${o.line}</td></tr>`).join('')}</table>`;
  return h;
}
function renderDetail() {
  const el = document.getElementById('detail-body');
  let h = '';
  if (S.block) h = blockDetail(BX[S.block]);
  else if (S.swNode) h = swNodeDetail(S.swNode);
  else if (S.selVar) h = varDetail(S.selVar) + (REL ? relatedHtml() : '');
  else if (S.selIpc) h = ipcDetail(S.selIpc) + (REL ? relatedHtml() : '');
  else if (!S.selFid) h = '<span style="color:var(--muted)">Click a box in the timing diagram, a row in the call graph, a function in the SW structure or a HW block. The Focus toggle decides whether the selection relates only that function or its whole call subtree; the level control sets how deep the call graph unfolds; ◂ ▸ steps through periodic instances.</span>';
  else {
    const shownPath = S.selPath || findPath(S.selFid);
    const n = shownPath ? nodeAt(shownPath) : null, f = fnOf(S.selFid), sf = ST.functions[S.selFid];
    const isr = shownPath ? isrOfPath(shownPath) : null, k = shownPath ? instOfPath(shownPath) : 0, dt = isr ? k * (isr.period_us || 0) : 0;
    h = `<div class="mono" style="font-weight:600;font-size:13px">${esc(short(S.selFid))}${f && f.static ? ' <span class="b">static</span>' : ''}${f && f.kind && f.kind !== 'function' ? ' <span class="b">' + esc(f.kind) + (f.virtual ? ' · virtual' : '') + '</span>' : ''}${f && f.precise ? ' <span class="b ok" title="calls and references from the build-based (compiler) analysis">build-based</span>' : ''}${f && f.overrides && f.overrides.length ? ' <span class="b">overrides ' + f.overrides.map(short).map(esc).join(', ') + '</span>' : ''}</div><dl class="kv">`;
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
    if (f) h += section('sec-impact', 'Impact', (f.precise ? 'build-based' : 'token parser'), impactHtml(S.selFid), true);
    if (REL) h += relatedHtml();
  }
  el.innerHTML = h;
  wireImpact(el);
  el.querySelectorAll('.fnb').forEach(b => b.addEventListener('click', () => selectNode(findPath(b.dataset.fid), b.dataset.fid)));
  el.querySelectorAll('.blkl').forEach(b => b.addEventListener('click', () => selectBlock(b.dataset.block)));
  el.querySelectorAll('.ndl').forEach(b => b.addEventListener('click', () => selectSwNode(b.dataset.node)));
  el.querySelectorAll('.rel-row[data-node]').forEach(b => b.addEventListener('click', () => selectSwNode(b.dataset.node)));
  el.querySelectorAll('.varl').forEach(b => b.addEventListener('click', () => selectVariable(b.dataset.var)));
  el.querySelectorAll('.ipcl').forEach(b => b.addEventListener('click', () => selectIpc(b.dataset.ipc)));
  const hb = document.getElementById('hist-back'), hf = document.getElementById('hist-fwd'); if (hb) { hb.disabled = !canBack(); hf.disabled = !canForward(); }
  el.querySelectorAll('.rel-row[data-block]').forEach(b => { if (b.dataset.block) b.addEventListener('click', () => selectBlock(b.dataset.block)); });
  // remember which sections are open
  el.querySelectorAll('details.sub').forEach(d => { if (S.secOpen && d.id in S.secOpen) d.open = S.secOpen[d.id]; d.addEventListener('toggle', () => { S.secOpen = S.secOpen || {}; S.secOpen[d.id] = d.open; }); });
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
