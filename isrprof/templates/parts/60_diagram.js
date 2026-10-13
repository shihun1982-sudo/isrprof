// ================================================================== nested structure diagrams (SW structure / HW structure)
// One layout engine draws both: the hierarchy becomes nested boxes down to a depth (per-node open / close
// on top), leaves list their items (functions / registers) when open, and relations / links are arrows.
// The SVG is rebuilt only when the structure changes (depth, open / close, size); a selection change just
// toggles classes and badge texts on the existing elements, so focusing stays instant on big trees.
const DG = {};   // host id -> {layout, svg, pz, items, boxes}
const DIAG_MAX_VH = Math.max(0.15, Math.min(0.8, +((V.diagram || {}).max_vh || 0.38)));   // a structure window grows with its content up to this share of the screen
const DIAG_MIN_K = Math.max(0.3, Math.min(1, +((V.diagram || {}).min_scale || 0.7)));      // below this scale the diagram is not shrunk further (pan / zoom instead)
// clip a label to a pixel width (average glyph widths of the two fonts used in the diagrams)
function fitText(str, maxPx, cw) { str = String(str == null ? '' : str); const n = Math.max(1, Math.floor(maxPx / (cw || 6.4))); return str.length <= n ? str : (n > 2 ? str.slice(0, n - 1) + '…' : str.slice(0, n)); }

// Skyline packer: items {span (columns), h} placed in order into `ncols` columns, each at the lowest free
// position (ties: leftmost).  Later short items fill the gaps left under earlier tall ones, so a page or a
// container is filled instead of showing holes next to its tallest member.  Order is kept, positions are not
// strictly row-major.
function packSkylineOrder(items, order, ncols, gap) {
  const sky = new Array(ncols).fill(0), pos = new Array(items.length);
  for (const i of order) {
    const it = items[i], span = Math.max(1, Math.min(ncols, it.span | 0));
    let best = null;
    for (let c = 0; c + span <= ncols; c++) {
      let y = 0; for (let j = c; j < c + span; j++) y = Math.max(y, sky[j]);
      if (!best || y < best.y - 1e-6) best = { c, y };
    }
    pos[i] = { col: best.c, y: best.y, span };
    for (let j = best.c; j < best.c + span; j++) sky[j] = best.y + it.h + gap;
  }
  return { pos, height: items.length ? Math.max(...sky) - gap : 0 };
}
function packSkyline(items, ncols, gap) {
  // document order first; when placing the tall members first packs clearly tighter (classic first-fit
  // decreasing), that order is used instead - the hierarchy is unchanged, only siblings move
  const idx = items.map((_, i) => i), a = packSkylineOrder(items, idx, ncols, gap);
  if (items.length < 3 || ncols < 2) return a;
  const b = packSkylineOrder(items, [...idx].sort((i, j) => (items[j].h * items[j].span) - (items[i].h * items[i].span) || i - j), ncols, gap);
  return b.height < a.height * 0.92 ? b : a;
}
// items (functions / registers) flow into as many columns as the widest label allows
function itemGrid(items, w, opt) {
  if (!items.length) return { cols: 1, rows: 0, h: 0, colW: w - 8 };
  const maxPx = Math.max(...items.map(it => String(it.label).length)) * opt.itemCw + 18;
  const cols = Math.max(1, Math.min(items.length, Math.floor((w - 8 + 4) / (maxPx + 4))));
  const rows = Math.ceil(items.length / cols);
  return { cols, rows, h: rows * opt.itemH + 5, colW: (w - 8 - 4 * (cols - 1)) / cols };
}
function nestedLayout(byId, roots, opt) {
  // opt: {depth, open, closed, pageW, aspect, maxCols, leafW, leafH, pad, header, itemsOf(node)->[{id,label}], itemH, itemCw}
  // The page is a grid of NC columns (pitch = leaf width + pad, stretched so the columns fill the page
  // width exactly).  A container spans c columns, c chosen so that its aspect ratio approaches `aspect`
  // (= host aspect), and its children are skyline-packed into c sub-columns; leaves span one column.
  const boxes = new Map(), pad = opt.pad;
  // depth = number of nested levels drawn: a node is open by default while its children are still inside that depth
  const isOpenNode = n => n.children.length && (opt.closed.has(n.id) ? false : (opt.open.has(n.id) ? true : n.depth < opt.depth - 1));
  const memo = new Map();
  function measure(n, pitch, maxSpan, forceSpan) {
    const key = n.id + '|' + Math.round(pitch) + '|' + maxSpan + '|' + (forceSpan == null ? '' : forceSpan);
    if (memo.has(key)) return memo.get(key);
    const items = opt.itemsOf(n), showItems = items.length && (opt.open.has(n.id) || (!n.children.length && opt.itemsDefault && n.depth < opt.depth - 1));
    let res;
    if (!isOpenNode(n)) {
      const ig = itemGrid(showItems ? items : [], pitch - pad, opt);
      res = { span: 1, h: opt.leafH + ig.h, open: false, items: showItems ? items : [], ig };
    } else {
      const kids = n.children.map(id => byId[id]).filter(Boolean), cp = pitch - pad;   // child pitch (estimate; the exact one is set at placement)
      const ms = kids.map(k => measure(k, cp, maxSpan));
      const area = ms.reduce((a, m) => a + m.span * cp * m.h, 0), spans = ms.reduce((a, m) => a + m.span, 0);
      let c = forceSpan != null ? forceSpan : Math.round(Math.sqrt(opt.aspect * area) / cp);
      c = Math.max(1, ...ms.map(m => m.span), Math.min(c, maxSpan, spans));
      const pk = packSkyline(ms.map(m => ({ span: m.span, h: m.h })), c, pad);
      res = { span: c, c, h: opt.header + pad + pk.height + pad, open: true, kids, ms, pk, items: [] };
    }
    memo.set(key, res); return res;
  }
  function place(n, m, x, y, pitch) {
    const w = m.span * pitch - pad;
    boxes.set(n.id, { id: n.id, x, y, w, h: m.h, open: m.open, items: m.items, ig: m.ig, node: n });
    if (!m.open) return;
    const cp = (w - pad) / m.c;
    m.pk.pos.forEach((p, i) => place(m.kids[i], m.ms[i], x + pad + p.col * cp, y + opt.header + pad + p.y, cp));
  }
  const rootNodes = roots.map(id => byId[id]).filter(Boolean);
  const NC = Math.max(1, Math.min(opt.maxCols, Math.floor((opt.pageW + pad) / (opt.leafW + pad)))), pitch = (opt.pageW + pad) / NC;
  // root spans: the aspect heuristic, and alternatives where every root gets the width that makes it as tall as
  // the others when the page is tiled in 1, 2, 3 ... rows; the candidate packing with the lowest height wins
  const base = rootNodes.map(r => measure(r, pitch, NC)), area = base.map(m => m.span * pitch * m.h), total = area.reduce((a, b) => a + b, 0);
  const cands = [base];
  for (let rows = 1; rows <= Math.min(4, rootNodes.length); rows++) {
    const H = total / (rows * NC * pitch); if (!(H > 0)) break;
    const spans = area.map(a => Math.max(1, Math.min(NC, Math.round(a / (H * pitch)))));
    if (spans.reduce((a, b) => a + b, 0) > rows * NC + Math.ceil(NC / 2)) continue;
    cands.push(rootNodes.map((r, i) => measure(r, pitch, NC, spans[i])));
  }
  let ms = null, pk = null;
  cands.forEach(cm => { const p = packSkyline(cm.map(m => ({ span: m.span, h: m.h })), NC, pad); if (!pk || p.height < pk.height * 0.97) { ms = cm; pk = p; } });
  let maxW = 0;
  pk.pos.forEach((p, i) => { place(rootNodes[i], ms[i], p.col * pitch, p.y, pitch); maxW = Math.max(maxW, (p.col + p.span) * pitch - pad); });
  return { boxes, width: Math.max(maxW, 10), height: pk.height + 4, columns: NC };
}
const visibleBox = (layout, byIdAnc, id) => { if (layout.boxes.has(id)) return layout.boxes.get(id); for (const a of (byIdAnc[id] || [])) if (layout.boxes.has(a)) return layout.boxes.get(a); return null; };

function edgePath(a, b) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay;
  let x1, y1, x2, y2;
  if (Math.abs(dx) * a.h > Math.abs(dy) * a.w) { x1 = dx > 0 ? a.x + a.w : a.x; y1 = ay; x2 = dx > 0 ? b.x : b.x + b.w; y2 = by; const c = (x1 + x2) / 2; return { d: `M${x1},${y1} C${c},${y1} ${c},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }; }
  x1 = ax; y1 = dy > 0 ? a.y + a.h : a.y; x2 = bx; y2 = dy > 0 ? b.y : b.y + b.h; const c = (y1 + y2) / 2;
  return { d: `M${x1},${y1} C${x1},${c} ${x2},${c} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}

// pan / zoom on an SVG viewBox (drag, wheel around the cursor, double-click resets)
function panZoom(host, svg, w, h) {
  const st = DG[host.id] && DG[host.id].pz && DG[host.id].pz.keep ? DG[host.id].pz : { x: 0, y: 0, k: 1 };
  const apply = () => { const W = host.clientWidth || 800, H = host.clientHeight || 400; svg.setAttribute('viewBox', `${st.x} ${st.y} ${W / st.k} ${H / st.k}`); };
  // fit: the whole diagram in the window - scale to the width, and to the height when the window height is
  // fixed by the user; otherwise the window grows with the content up to a share of the screen, then the
  // diagram is scaled down (not below DIAG_MIN_K, so the labels stay legible; the rest is reached by panning)
  const fit = () => {
    const W = host.clientWidth || 800; st.k = Math.min(W / (w + 8), 1.4);
    if (!host.dataset.userH) {
      const cap = Math.max(140, Math.round(window.innerHeight * DIAG_MAX_VH));
      let hostH = Math.round(h * st.k + 12);
      if (hostH > cap) { st.k = Math.max(DIAG_MIN_K, Math.min(st.k, (cap - 12) / (h + 4))); hostH = Math.min(cap, Math.round(h * st.k + 12)); }
      host.style.height = Math.max(90, hostH) + 'px';
    } else { const H = host.clientHeight || 300; st.k = Math.max(DIAG_MIN_K, Math.min(st.k, (H - 8) / (h + 4))); }
    st.x = -4; st.y = -4; st.keep = false; apply();
  };
  const zoom = (f, cx, cy) => { const W = host.clientWidth || 800, H = host.clientHeight || 400; const px = st.x + cx / st.k, py = st.y + cy / st.k; st.k = Math.max(0.15, Math.min(6, st.k * f)); st.x = px - cx / st.k; st.y = py - cy / st.k; st.keep = true; apply(); void W; void H; };
  if (!st.keep) fit(); else apply();
  if (!host._pzBound) {
    host._pzBound = true; let drag = null;
    host.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, moved: false }; try { host.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ } });
    host.addEventListener('pointermove', e => { if (!drag) return; const s = DG[host.id].pz; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 2) { drag.moved = true; host.classList.add('dragging'); } s.x -= dx / s.k; s.y -= dy / s.k; s.keep = true; drag.x = e.clientX; drag.y = e.clientY; s.apply(); });
    host.addEventListener('pointerup', e => { if (drag && drag.moved) { host._suppressClick = true; setTimeout(() => { host._suppressClick = false; }, 0); } drag = null; host.classList.remove('dragging'); });
    host.addEventListener('wheel', e => { e.preventDefault(); const r = host.getBoundingClientRect(); DG[host.id].pz.zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    host.addEventListener('dblclick', e => { if (e.target.closest('.nd, .it')) return; DG[host.id].pz.fit(); });
  }
  return Object.assign(st, { apply, fit, zoom });
}

function renderNested(host, spec) {
  // spec: {byId, roots, anc, depth, open, closed, cols, itemsOf, itemsDefault, kindOf, labelOf, subOf, edges:[{from,to,kind,label}], leafW, onToggle, onSelect, onItem, tipNode, tipItem, extraClass}
  const W = Math.max(host.clientWidth || 900, 320);
  const targetH = host.dataset.userH ? (host.clientHeight || 300) : Math.max(140, Math.round(window.innerHeight * DIAG_MAX_VH));
  const opt = { depth: spec.depth, open: spec.open, closed: spec.closed, pageW: W - 8, maxCols: Math.max(1, spec.maxCols || 12), aspect: Math.max(1.2, Math.min(5, (W - 8) / targetH)),
    leafW: spec.leafW || 190, leafH: 28, pad: 5, header: 20, itemsOf: spec.itemsOf, itemsDefault: spec.itemsDefault, itemH: 12, itemCw: 5.7 };
  const layout = nestedLayout(spec.byId, spec.roots, opt);
  const boxes = layout.boxes, out = [], items = new Map(), boxEl = new Map();
  const ordered = [...boxes.values()].sort((a, b) => a.node.depth - b.node.depth);
  for (const b of ordered) {
    const n = b.node, kind = spec.kindOf(n), cnt = spec.countOf ? spec.countOf(n) : '';
    out.push(`<g class="nd k-${esc(kind)} d${Math.min(n.depth, 2)} ${spec.extraClass ? spec.extraClass(n) : ''}" data-id="${esc(n.id)}"><rect class="bx" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5"/>` +
      `<text class="ttl" x="${b.x + 6}" y="${b.y + 12}">${b.node.children.length ? (b.open ? '▾ ' : '▸ ') : ''}${esc(fitText(spec.labelOf(n), b.w - 50, n.depth === 0 ? 6.4 : 6.1))}</text>` +
      `<text class="sub" x="${b.x + 6}" y="${b.y + 22}">${esc(fitText(spec.subOf(n, b), b.w - 10, 5.2))}</text><text class="cnt" x="${b.x + b.w - 4}" y="${b.y + 12}"></text>`);
    const ig = b.ig || itemGrid(b.items, b.w, opt);
    b.items.forEach((it, i) => {
      const col = i % ig.cols, row = Math.floor(i / ig.cols), ix = b.x + 4 + col * (ig.colW + 4), iy = b.y + opt.leafH + row * opt.itemH;
      out.push(`<g class="it ${it.cls || ''}" data-id="${esc(it.id)}" data-node="${esc(n.id)}"><rect x="${ix}" y="${iy}" width="${ig.colW}" height="${opt.itemH - 1}" rx="3"/><text x="${ix + 5}" y="${iy + 9.5}">${esc(fitText(it.label, ig.colW - 34, opt.itemCw))}</text><text class="itag" x="${ix + ig.colW - 3}" y="${iy + 9.5}" text-anchor="end"></text></g>`);
      items.set(it.id, { node: n.id, it });
    });
    out.push('</g>');
  }
  let edges = '';
  (spec.edges || []).forEach((e, i) => {
    const a = visibleBox(layout, spec.anc, e.from), b = visibleBox(layout, spec.anc, e.to); if (!a || !b || a === b) return;
    const p = edgePath(a, b);
    edges += `<path class="ed k-${esc(e.kind)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${p.d}" marker-end="url(#${host.id}-arr)"><title>${esc(e.from)} → ${esc(e.to)}${e.label ? ' · ' + esc(e.label) : ''}${e.kind ? ' (' + esc(e.kind) + ')' : ''}</title></path>`;
    if (e.label) edges += `<text class="edl" data-from="${esc(e.from)}" data-to="${esc(e.to)}" x="${p.mx}" y="${p.my - 3}" text-anchor="middle">${esc(e.label)}</text>`;
  });
  host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="${host.id}-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-strong)"/></marker></defs><g class="edges">${edges}</g><g class="nodes">${out.join('')}</g></svg>`;
  const svg = host.querySelector('svg');
  host.querySelectorAll('.nd').forEach(g => boxEl.set(g.dataset.id, g));
  const pz = panZoom(host, svg, layout.width, layout.height);
  DG[host.id] = { layout, svg, pz, items, boxEl, spec };
  host.querySelectorAll('.nd > rect.bx').forEach(r => {
    const g = r.parentElement, id = g.dataset.id;
    r.addEventListener('click', e => { if (host._suppressClick) return; e.stopPropagation(); spec.onToggle(id, e); });
    r.addEventListener('mouseenter', e => showTip(spec.tipNode(spec.byId[id]), e.clientX, e.clientY));
    r.addEventListener('mouseleave', hideTip);
  });
  host.querySelectorAll('.it').forEach(g => {
    g.addEventListener('click', e => { if (host._suppressClick) return; e.stopPropagation(); spec.onItem(g.dataset.id, g.dataset.node, e); });
    g.addEventListener('mouseenter', e => showTip(spec.tipItem(g.dataset.id, g.dataset.node), e.clientX, e.clientY));
    g.addEventListener('mouseleave', hideTip);
  });
  return DG[host.id];
}

// apply the selection to an existing diagram: node classes + count badges, item classes, edge emphasis
function highlightNested(hostId, nodeState, itemState, edgeState) {
  const d = DG[hostId]; if (!d) return;
  d.boxEl.forEach((g, id) => {
    const st = nodeState(id) || {};
    g.classList.remove('dim', 'sel', 'rel-x', 'rel-r', 'rel-w', 'rel-rw', 'rel-c', 'rel-miss');
    if (st.cls) st.cls.forEach(c => g.classList.add(c));
    const cnt = g.querySelector(':scope > text.cnt'); if (cnt) { cnt.textContent = st.badge || ''; cnt.style.fill = st.badgeColor || ''; }
  });
  d.svg.querySelectorAll('.it').forEach(g => {
    const st = itemState(g.dataset.id, g.dataset.node) || {};
    g.classList.remove('dim', 'sel', 'rel', 'rel-r', 'rel-w', 'rel-rw', 'hot', 'miss');
    if (st.cls) st.cls.forEach(c => g.classList.add(c));
    const tag = g.querySelector('.itag'); if (tag) tag.textContent = st.tag || '';
  });
  d.svg.querySelectorAll('.ed, .edl').forEach(p => { const st = edgeState(p.dataset.from, p.dataset.to) || ''; p.classList.remove('rel', 'dim'); if (st) p.classList.add(st); });
}

// ------------------------------------------------------------------ SW structure
const swRoots = () => SWS.nodes.filter(n => !n.parent).map(n => n.id);
const KIND_ABBR = { global: 'G', static: 'S', static_local: 'SL', extern: 'G' };
function swItemsOf(n) {
  const out = [];
  if (n.functions.length && !n.children.length) n.functions.forEach(f => { const fn = F[f]; const isIsr = P.isrs.some(i => i.entry === short(f)); out.push({ id: 'fn:' + f, label: (isIsr ? '▸ ' : '') + short(f) + (fn && fn.hw.length ? ' ▣' + fn.hw.length : '') + (fn && fn.heap.length ? ' H' : '') + (fn && fn.ipc.length ? ' ⇄' : '') }); });
  if (n.variables.length) n.variables.forEach(k => { const v = VARX[k]; out.push({ id: 'var:' + k, label: (v ? v.name : k) + (v ? ' · ' + (KIND_ABBR[v.kind] || v.kind) + (v.registered ? ' ®' : '') + (v.shared_across_cores ? ' ⚠' : '') + (Object.keys(v.fields || {}).length ? ' {' + Object.keys(v.fields).length + '}' : '') : ''), cls: v && v.shared_across_cores ? 'shared' : '' }); });
  return out;
}
function renderSW() {
  const host = document.getElementById('sw');
  if (!SWS.nodes.length) { host.innerHTML = '<div class="empty">No SW structure declared (sw_structure.yaml) and nothing detected.</div>'; return; }
  renderNested(host, {
    byId: SWN, roots: swRoots(), anc: SWL.anc, depth: S.swDepth, open: S.swOpen, closed: S.swClosed, maxCols: +((V.sw_structure || {}).columns || 12),
    itemsOf: swItemsOf, itemsDefault: true, leafW: +((V.sw_structure || {}).leaf_px || 196),
    kindOf: n => n.kind, labelOf: n => n.name,
    subOf: n => { const nf = NODE_FIDS[n.id].size, nv = n.variables.length + SWL.desc[n.id].reduce((a, d) => a + SWN[d].variables.length, 0); return [n.kind !== 'module' && n.kind !== 'subsystem' ? n.kind : '', n.type, nf ? nf + ' fn' : '', nv ? nv + ' var' : '', n.core != null && n.depth === 0 ? 'core ' + n.core : ''].filter(Boolean).join(' · '); },
    extraClass: n => (n.implicit ? 'implicit ' : '') + (S.swNode === n.id ? 'sel' : ''),
    edges: SWS.relations.map(r => ({ from: r.from, to: r.to, kind: r.kind, label: r.label })),
    onToggle: (id, e) => { const n = SWN[id]; if (e.shiftKey || !n.children.length && !swItemsOf(n).length) { selectSwNode(id); return; } if (n.children.length || swItemsOf(n).length) { const open = n.children.length ? (S.swClosed.has(id) ? false : (S.swOpen.has(id) ? true : n.depth < S.swDepth - 1)) : S.swOpen.has(id); if (open) { S.swOpen.delete(id); if (n.children.length && n.depth < S.swDepth - 1) S.swClosed.add(id); } else { S.swClosed.delete(id); S.swOpen.add(id); } renderSW(); applySWHighlight(); } },
    onItem: (id) => { if (id.startsWith('fn:')) { const f = id.slice(3); if (S.selFid === f) clearFocus(); else selectNode(findPath(f), f); } else if (id.startsWith('var:')) { selectVar(id.slice(4)); } },
    tipNode: n => `<span class="mono"><b>${esc(n.name)}</b> <span class="m">${esc(n.kind)}${n.type ? ' · ' + esc(n.type) : ''}${n.core != null ? ' · core ' + n.core : ''}</span></span>${n.note ? `<span class="m">📝 ${esc(n.note)}</span>` : ''}<span class="m">${NODE_FIDS[n.id].size} functions · ${n.variables.length} variables · ${n.children.length} children</span><span class="m">click: expand / collapse · shift+click: focus every function of this node</span>`,
    tipItem: (id) => {
      if (id.startsWith('fn:')) { const f = F[id.slice(3)]; if (!f) return esc(id); const sf = ST.functions[f.id]; return `<span class="mono"><b>${esc(f.name)}</b></span><span class="m">${esc(f.file)}:${f.line}${sf ? ` · level ${sf.level} · ${sf.layer || 'no layer'}` : ''}</span>${f.hw.length ? `<span class="mono">HW: ${f.hw.map(h => h.block + '.' + h.reg + ' ' + h.kind[0].toUpperCase()).join(', ')}</span>` : ''}${f.vars.length ? `<span class="mono">vars: ${[...new Set(f.vars.map(v => v.name + '[' + v.rw + ']'))].join(', ')}</span>` : ''}<span class="m">click to focus</span>`; }
      const v = VARX[id.slice(4)]; if (!v) return esc(id);
      return `<span class="mono"><b>${esc(v.name)}</b> <span class="m">${v.kind}${v.registered ? ' · registered' : ''} · cores ${v.cores.join(',') || '—'}</span></span><span class="m">${esc(v.decl)}</span>${v.note ? `<span class="m">📝 ${esc(v.note)}</span>` : ''}<span class="mono">${v.accessors.map(a => short(a.fid) + ' [' + a.rw + (a.member ? ' .' + a.member : '') + ']').join(', ')}</span><span class="m">click to show the users in Details</span>`;
    },
  });
  applySWHighlight();
}
const selectVar = selectVariable;
function applySWHighlight() {
  const rel = REL, sel = S.selFid, blk = S.block ? BX[S.block] : null;
  const rwCls = rw => rw === 'x' ? 'rel-x' : rw === 'c' ? 'rel-c' : rw === 'rw' ? 'rel-rw' : rw === 'w' ? 'rel-w' : 'rel-r';
  highlightNested('sw',
    id => {
      const cls = [];
      if (S.swNode === id || (S.selVar && VNODE[S.selVar] === id)) cls.push('sel');
      if (rel) { const t = rel.sw.get(id); if (t) { cls.push(rwCls(t.rw)); return { cls, badge: t.rw === 'x' ? '■ ' + t.fids.size : (t.rw === 'c' ? '' : t.rw + ' ' + t.fids.size), badgeColor: t.rw === 'w' || t.rw === 'rw' ? 'var(--write)' : t.rw === 'r' ? 'var(--read)' : 'var(--accent)' }; } cls.push('dim'); return { cls }; }
      if (blk) { const hit = [...NODE_FIDS[id]].some(f => blk.accessors.includes(f)); cls.push(hit ? 'rel-c' : 'dim'); return { cls }; }
      if (S.selVar) { const v = VARX[S.selVar], vn = VNODE[S.selVar]; const hit = vn === id || (SWL.anc[vn] || []).includes(id) || (v && [...NODE_FIDS[id]].some(f => v.accessors.some(a => a.fid === f))); cls.push(hit ? 'rel-c' : 'dim'); return { cls }; }
      return { cls };
    },
    (id, nid) => {
      const cls = [];
      if (id.startsWith('fn:')) {
        const f = id.slice(3);
        if (sel === f) cls.push('sel');
        if (rel || blk) { if (hl(f)) cls.push('rel'); else cls.push('dim'); }
        else if (S.selVar) { const v = VARX[S.selVar]; if (v && v.accessors.some(a => a.fid === f)) cls.push('rel'); else cls.push('dim'); }
        else if (!inSlice(f)) cls.push('dim');
        return { cls };
      }
      const k = id.slice(4);
      if (S.selVar === k) cls.push('sel');
      if (rel) { const t = rel.vars.get(k); if (t) { cls.push('rel', t.rw.includes('w') || t.rw.includes('rw') ? (t.rw.includes('r') ? 'rel-rw' : 'rel-w') : 'rel-r'); return { cls, tag: t.rw.join('/') }; } cls.push('dim'); }
      else if (blk) { const v = VARX[k]; if (!(v && v.accessors.some(a => blk.accessors.includes(a.fid)))) cls.push('dim'); else cls.push('rel'); }
      return { cls };
    },
    (from, to) => rel ? ((rel.sw.has(from) && rel.sw.has(to)) ? 'rel' : 'dim') : '');
}

// ------------------------------------------------------------------ HW structure
const hwRoots = () => HWS.nodes.filter(n => !n.parent).map(n => n.id);
function hwItemsOf(n) { const b = BX[n.id]; return b ? b.regs.map(r => ({ id: 'reg:' + n.id + '.' + r, label: r })) : []; }
function renderHW() {
  const host = document.getElementById('hw');
  if (!HWS.nodes.length) { host.innerHTML = '<div class="empty">No HW structure declared (hw_structure.yaml).</div>'; return; }
  renderNested(host, {
    byId: HWN, roots: hwRoots(), anc: HWL.anc, depth: S.hwDepth, open: S.hwOpen, closed: S.hwClosed, maxCols: +((V.hw_structure || {}).columns || 12),
    itemsOf: hwItemsOf, itemsDefault: false, leafW: +((V.hw_structure || {}).leaf_px || 176),
    kindOf: n => n.kind, labelOf: n => n.name,
    subOf: n => { const b = BX[n.id]; if (!b) return (n.kind || '') + (n.children.length ? ' · ' + n.children.length + ' blocks' : ''); return [b.id, b.base, b.deadlines.length ? '⏱' + b.deadlines.length : '', (TIX[b.line] || {}).name].filter(Boolean).join(' · '); },
    extraClass: n => (n.id.startsWith('_auto') ? 'implicit ' : '') + (S.block === n.id ? 'sel' : ''),
    edges: HWS.links.map(l => ({ from: l.from, to: l.to, kind: l.kind, label: l.label })),
    onToggle: (id, e) => { const n = HWN[id]; if (BX[id] && !e.shiftKey) { selectBlock(id); return; } if (n.children.length || hwItemsOf(n).length) { const open = n.children.length ? (S.hwClosed.has(id) ? false : (S.hwOpen.has(id) ? true : n.depth < S.hwDepth - 1)) : S.hwOpen.has(id); if (open) { S.hwOpen.delete(id); if (n.children.length && n.depth < S.hwDepth - 1) S.hwClosed.add(id); } else { S.hwClosed.delete(id); S.hwOpen.add(id); } renderHW(); applyHWHighlight(); } },
    onItem: (id, nid) => selectBlock(nid),
    tipNode: n => BX[n.id] ? blockTip(BX[n.id]) : `<span class="mono"><b>${esc(n.name)}</b> <span class="m">${esc(n.kind)}</span></span>${n.note ? `<span class="m">📝 ${esc(n.note)}</span>` : ''}<span class="m">${n.children.length} children · click to expand / collapse</span>`,
    tipItem: (id, nid) => { const reg = id.slice(nid.length + 5); const evs = visibleIsrs().flatMap(i => i.hw_events.filter(e => e.block === nid && e.reg === reg)); return `<span class="mono"><b>${esc(nid)}.${esc(reg)}</b></span><span class="m">${evs.length} access${evs.length === 1 ? '' : 'es'} per execution: ${[...new Set(evs.map(e => short(e.fid) + ' ' + e.kind[0].toUpperCase()))].join(', ') || '—'}</span>`; },
  });
  applyHWHighlight();
}
function applyHWHighlight() {
  const rel = REL;
  highlightNested('hw',
    id => {
      const cls = []; if (S.block === id) cls.push('sel');
      if (rel) { const t = rel.hw.get(id); if (!t) { cls.push('dim'); return { cls }; } if (t.c) { cls.push('rel-c'); return { cls }; } cls.push(t.miss ? 'rel-miss' : (t.w && t.r ? 'rel-rw' : t.w ? 'rel-w' : 'rel-r')); return { cls, badge: `${t.r ? 'R' + t.r : ''}${t.r && t.w ? ' ' : ''}${t.w ? 'W' + t.w : ''}${t.miss ? ' ✗' + t.miss : ''}`, badgeColor: t.miss ? 'var(--critical)' : t.w ? 'var(--write)' : 'var(--read)' }; }
      if (S.swNode) { const fids = NODE_FIDS[S.swNode]; const hit = BX[id] ? BX[id].accessors.some(f => fids.has(f)) : (HWL.desc[id] || []).some(d => BX[d] && BX[d].accessors.some(f => fids.has(f))); cls.push(hit ? 'rel-c' : 'dim'); }
      else if (S.block && S.block !== id && !(HWL.desc[id] || []).includes(S.block)) cls.push('dim');
      return { cls };
    },
    (id, nid) => { const cls = []; const reg = id.slice(nid.length + 5); if (rel) { const b = rel.blocks.get(nid); const rg = b && b.regs.get(reg); if (rg) { cls.push('hot'); if (rg.miss) cls.push('miss'); return { cls, tag: `${rg.r ? 'R' + rg.r : ''}${rg.w ? 'W' + rg.w : ''}` }; } cls.push('dim'); } return { cls }; },
    (from, to) => rel ? ((rel.hw.has(from) && rel.hw.has(to)) ? 'rel' : 'dim') : '');
}
