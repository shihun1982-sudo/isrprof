// ================================================================== Structure101-style tab: DSM, LSM, tangles, violations
function dsmEdges() { return ST.matrix.map(([r, c, n]) => [ST.order[r], ST.order[c], n]); }
function tile(v, l, s, cls) { if (s && s.length > 160) s = s.slice(0, 150) + ' …'; return `<div class="tile ${cls || ''}"><div class="v">${v}</div><div class="l">${l}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`; }
const DSM_TABLE_MAX = 160;      // above this many rows the matrix is drawn on a canvas (a 700x700 table is slow)
let _dsmInit = false;
const nodeName = id => (SWN[id] ? SWN[id].name : id);
function renderStructure() {
  const t0 = performance.now();
  const sl = sliceSet(), fids = ST.order.filter(f => !sl || sl.has(f)), fset = new Set(fids);
  // big trees: start with every module collapsed so the matrix stays small (expand the modules you look at)
  if (!_dsmInit) { _dsmInit = true; if (ST.order.length > +(V.dsm_max_functions || 400)) ST.modules.forEach(m => S.dsmCollapsed.add(m.name)); }
  const edges = dsmEdges().filter(([a, b]) => fset.has(a) && fset.has(b));
  const items = [];
  for (const m of ST.modules) {
    const fns = m.functions.filter(f => fset.has(f)); if (!fns.length) continue;
    if (S.dsmCollapsed.has(m.name)) items.push({ kind: 'mod', id: m.name, module: m.name, set: new Set(fns), level: ST.module_levels[m.name], first: true });
    else fns.forEach((f, k) => items.push({ kind: 'fn', id: f, module: m.name, set: new Set([f]), level: ST.functions[f].level, first: k === 0 }));
  }
  const idx = {}; items.forEach((it, i) => it.set.forEach(f => { idx[f] = i; }));
  const cells = new Map();          // i*N+j -> n   (sparse: only the dependencies that exist)
  const N = items.length;
  edges.forEach(([a, b, n]) => { const key = idx[a] * N + idx[b]; cells.set(key, (cells.get(key) || 0) + n); });
  let fb = 0, tot = 0; edges.forEach(([a, b]) => { tot++; if (idx[a] > idx[b]) fb++; });
  const m = ST.metrics, viol = ST.violations.filter(v => fset.has(v.from) && fset.has(v.to)), tangles = ST.tangles.filter(t => t.some(f => fset.has(f)));
  document.getElementById('tiles').innerHTML =
    tile(fids.length, 'functions', sl ? 'reachable from ' + [...S.isrs].slice(0, 3).join(', ') + (S.isrs.size > 3 ? ' +' + (S.isrs.size - 3) : '') : 'reachable from all ISRs') +
    tile(edges.length, 'dependencies', `${N} rows × ${N} cols in the matrix`) +
    tile((tot ? (100 * fb / tot).toFixed(1) : '0.0') + '%', 'tangled', `${fb} feedback dependenc${fb === 1 ? 'y' : 'ies'}`, fb ? 'bad' : 'ok') +
    tile(tangles.length, 'tangles', tangles.slice(0, 4).map(t => t.map(short).join(' ↔ ')).join('; ') + (tangles.length > 4 ? ` … +${tangles.length - 4}` : '') || 'no cycles', tangles.length ? 'bad' : 'ok') +
    tile(viol.length, 'rule violations', viol.length ? Object.entries(viol.reduce((a, v) => { a[v.kind] = (a[v.kind] || 0) + 1; return a; }, {})).map(([k, n]) => `${n} ${k}`).join(', ') : 'layering holds', viol.length ? 'bad' : 'ok') +
    tile(m.overweight_modules.length, 'overweight modules', `fat > ${m.fat_threshold}: ${m.overweight_modules.map(nodeName).join(', ') || '—'}`, m.overweight_modules.length ? 'bad' : 'ok') +
    tile(m.max_level, 'max level', 'levels in the levelized structure map');
  const dsm = document.getElementById('dsm');
  if (N > DSM_TABLE_MAX) renderDSMCanvas(dsm, items, cells, N); else renderDSMTable(dsm, items, cells, N);
  renderLSM(fset);
  let v = '';
  if (tangles.length) v += `<p style="margin:0 0 6px"><b>Tangles</b> (strongly connected groups): ${tangles.map(t => `<code>${t.map(short).join(' ↔ ')}</code>`).join(' · ')}</p>`;
  if (ST.module_tangles.length) v += `<p style="margin:0 0 6px"><b>Module-level tangles</b>: ${ST.module_tangles.map(t => `<code>${t.map(nodeName).join(' ↔ ')}</code>`).join(' · ')}</p>`;
  v += `<p style="margin:0 0 6px;color:var(--muted)">Layers (top → bottom): ${ST.layers.map(esc).join(' › ') || 'none configured'}</p>`;
  const vshow = viol.slice(0, 500);
  v += viol.length ? `<table class="t"><tr><th>kind</th><th>from</th><th>to</th><th>detail</th><th>n</th></tr>` + vshow.map(x => `<tr><td><span class="viol-k ${x.kind}">${x.kind}</span></td><td>${esc(short(x.from))}</td><td>${esc(short(x.to))}</td><td>${x.kind === 'rule' ? esc(x.rule) : esc(x.from_layer) + ' → ' + esc(x.to_layer)}</td><td>${x.n}</td></tr>`).join('') + '</table>' + (viol.length > vshow.length ? `<p style="color:var(--muted)">… ${viol.length - vshow.length} more</p>` : '') : '<p style="margin:0;color:var(--good)">No layer or rule violations in this slice.</p>';
  document.getElementById('viol').innerHTML = v;
  renderStructure.ms = Math.round(performance.now() - t0);
}
function dsmLabel(it) { return it.kind === 'mod' ? nodeName(it.id) : short(it.id); }
function renderDSMTable(dsm, items, cells, N) {
  let h = '<table class="dsm"><thead><tr><th class="rh"></th>';
  items.forEach(it => { h += `<th class="ch ${it.kind === 'mod' ? 'mod' : ''}" data-mod="${esc(it.module)}" title="${esc(it.id)}"><span>${it.kind === 'mod' ? '▸ ' : ''}${esc(dsmLabel(it))}</span></th>`; });
  h += '</tr></thead><tbody>';
  items.forEach((it, i) => {
    const lay = it.kind === 'fn' ? (ST.functions[it.id].layer || '') : (ST.modules.find(z => z.name === it.module).layer || '');
    const relRow = REL && (it.kind === 'mod' ? REL.modules.has(it.module) : REL.fids.has(it.id));
    h += `<tr class="${it.first ? 'mg' : ''}"><th class="rh ${it.kind === 'mod' ? 'mod' : ''} ${relRow ? 'rel' : ''}" data-mod="${esc(it.module)}"><span class="lv" title="level">${it.level}</span><i class="sw" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${modColor(it.module)};margin-right:6px;vertical-align:-1px"></i>${it.kind === 'mod' ? '<span class="car">▸</span>' : ''}${esc(dsmLabel(it))}${lay ? `<span class="ly">${esc(lay)}</span>` : ''}${it.kind === 'fn' && ST.functions[it.id].tangled ? ' <span class="b x">↻</span>' : ''}</th>`;
    for (let j = 0; j < N; j++) {
      const n = cells.get(i * N + j) || 0;
      if (i === j) h += `<td class="d" title="${esc(it.id)}: ${it.kind === 'mod' ? 'internal deps ' + n : 'self'}">${it.kind === 'mod' && n ? n : ''}</td>`;
      else if (!n) h += '<td></td>';
      else h += `<td class="${i > j ? 'fb' : 'n'}" data-tip="${esc(dsmLabel(it) + ' → ' + dsmLabel(items[j]) + ' (' + n + (i > j ? ', feedback)' : ')'))}">${n}</td>`;
    }
    h += '</tr>';
  });
  h += '</tbody></table>';
  dsm.innerHTML = h;
  dsm.querySelectorAll('th[data-mod]').forEach(th => th.addEventListener('click', () => { const mname = th.dataset.mod; if (S.dsmCollapsed.has(mname)) S.dsmCollapsed.delete(mname); else S.dsmCollapsed.add(mname); renderStructure(); }));
  dsm.querySelectorAll('td[data-tip]').forEach(td => { td.addEventListener('mouseenter', e => showTip(`<span class="mono">${td.dataset.tip}</span>`, e.clientX, e.clientY)); td.addEventListener('mouseleave', hideTip); });
}
// canvas DSM for big matrices: one pixel block per dependency, labels on hover, click a row to expand / collapse its module
function renderDSMCanvas(dsm, items, cells, N) {
  const cell = Math.max(2, Math.min(10, Math.floor(1200 / N))), labelW = cell >= 8 ? 170 : 0, W = labelW + N * cell, H = labelW + N * cell;
  dsm.innerHTML = `<p style="margin:0 0 6px;color:var(--muted);font-size:11.5px">${N} × ${N} matrix drawn as a bitmap (rows call columns, levelized order; red = feedback). Hover a cell for the names, click a row to expand / collapse its module, use the ISR filter to slice.</p><canvas width="${W}" height="${H}" style="max-width:none;display:block"></canvas>`;
  const cv = dsm.querySelector('canvas'), ctx = cv.getContext('2d');
  const dark = isDark(), bg = cssVar('--panel'), line = cssVar('--line'), accent = cssVar('--accent'), crit = cssVar('--critical'), fg = cssVar('--fg'), muted = cssVar('--muted');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = dark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.03)';
  items.forEach((it, i) => { if (it.first && (i & 1)) { ctx.fillRect(labelW, labelW + i * cell, N * cell, cell); } });
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  items.forEach((it, i) => { if (it.first) { ctx.beginPath(); ctx.moveTo(labelW, labelW + i * cell + 0.5); ctx.lineTo(W, labelW + i * cell + 0.5); ctx.moveTo(labelW + i * cell + 0.5, labelW); ctx.lineTo(labelW + i * cell + 0.5, H); ctx.stroke(); } });
  ctx.fillStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)';
  for (let i = 0; i < N; i++) ctx.fillRect(labelW + i * cell, labelW + i * cell, cell, cell);
  cells.forEach((n, key) => { const i = Math.floor(key / N), j = key % N; if (i === j) return; ctx.fillStyle = i > j ? crit : accent; ctx.fillRect(labelW + j * cell, labelW + i * cell, cell, cell); });
  if (labelW) {
    ctx.font = `${Math.min(11, cell + 1)}px "IBM Plex Mono", Consolas, monospace`; ctx.textBaseline = 'middle';
    items.forEach((it, i) => { ctx.fillStyle = it.kind === 'mod' ? fg : muted; ctx.fillText((it.kind === 'mod' ? '▸ ' : '') + dsmLabel(it).slice(0, 24), 2, labelW + i * cell + cell / 2); });
    ctx.save(); ctx.translate(0, labelW); ctx.rotate(-Math.PI / 2);
    items.forEach((it, j) => { ctx.fillStyle = it.kind === 'mod' ? fg : muted; ctx.fillText(dsmLabel(it).slice(0, 24), 2, labelW + j * cell + cell / 2); });
    ctx.restore();
  }
  const at = e => { const r = cv.getBoundingClientRect(); const x = (e.clientX - r.left) * cv.width / r.width - labelW, y = (e.clientY - r.top) * cv.height / r.height - labelW; return { i: Math.floor(y / cell), j: Math.floor(x / cell), x, y }; };
  cv.addEventListener('mousemove', e => {
    const { i, j, x, y } = at(e);
    if (y >= 0 && y < N * cell && x < 0 && labelW) { showTip(`<span class="mono">${esc(dsmLabel(items[i]))}</span><span class="m">level ${items[i].level} · ${esc(nodeName(items[i].module))} · click to ${S.dsmCollapsed.has(items[i].module) ? 'expand' : 'collapse'}</span>`, e.clientX, e.clientY); return; }
    if (i < 0 || j < 0 || i >= N || j >= N) { hideTip(); return; }
    const n = cells.get(i * N + j) || 0;
    showTip(`<span class="mono">${esc(dsmLabel(items[i]))} → ${esc(dsmLabel(items[j]))}</span><span class="m">${n ? n + (i > j ? ' (feedback)' : '') : 'no dependency'}</span>`, e.clientX, e.clientY);
  });
  cv.addEventListener('mouseleave', hideTip);
  cv.addEventListener('click', e => { const { i, y } = at(e); if (y < 0 || i >= N) return; const mname = items[i].module; if (S.dsmCollapsed.has(mname)) S.dsmCollapsed.delete(mname); else S.dsmCollapsed.add(mname); renderStructure(); });
}
function renderLSM(fset) {
  const host = document.getElementById('lsm'), mods = ST.modules.filter(m => m.functions.some(f => fset.has(f)));
  const lv = {}; mods.forEach(m => { lv[m.name] = ST.module_levels[m.name]; });
  const maxL = Math.max(0, ...mods.map(m => lv[m.name])), rows = [];
  for (let L = maxL; L >= 0; L--) rows.push(mods.filter(m => lv[m.name] === L));
  const Wd = Math.max(host.clientWidth || 900, 320), left = 60, BOXH = 38, FROW = 15, ROWGAP = 46, box = {};
  let y = 10, out = '';
  rows.forEach((r, ri) => {
    const L = maxL - ri; if (!r.length) return;
    const perRow = Math.max(1, Math.floor((Wd - left) / 150)), nrows = Math.ceil(r.length / perRow);
    for (let rr = 0; rr < nrows; rr++) {
      const slice = r.slice(rr * perRow, (rr + 1) * perRow);
      const bw = Math.min(260, (Wd - left - 10 * (slice.length - 1)) / slice.length); let maxH = BOXH;
      slice.forEach((m, k) => {
        const fns = m.functions.filter(f => fset.has(f)), open = S.lsmOpen.has(m.name), hgt = BOXH + (open ? fns.length * FROW + 6 : 0); maxH = Math.max(maxH, hgt);
        const x = left + k * (bw + 10); box[m.name] = { x, y, w: bw, h: hgt };
        const tangled = ST.module_tangles.some(t => t.includes(m.name)) || m.tangled > 0;
        out += `<g class="lsm-node ${m.overweight ? 'over' : ''} ${tangled ? 'tangled' : ''}" data-mod="${esc(m.name)}"><rect class="box" x="${x}" y="${y}" width="${bw}" height="${hgt}" rx="6"/><rect x="${x}" y="${y}" width="4" height="${hgt}" rx="2" fill="${modColor(m.name)}"/>` +
          `<text class="nm" x="${x + 12}" y="${y + 16}">${open ? '▾' : '▸'} ${esc(nodeName(m.name).slice(0, Math.floor(bw / 7.5)))}</text><text class="mt" x="${x + 12}" y="${y + 30}">fat ${m.fat}${m.overweight ? ' ⚠' : ''} · in ${m.fan_in} · out ${m.fan_out} · ${fns.length} fn${m.layer ? ' · ' + esc(m.layer) : ''}</text>`;
        if (open) fns.forEach((f, i) => { const sf = ST.functions[f]; out += `<g class="lsm-fn ${sf.tangled ? 'tg' : ''} ${REL && REL.fids.has(f) ? 'rel' : ''}"><rect x="${x + 8}" y="${y + BOXH + i * FROW}" width="${bw - 16}" height="${FROW - 2}" rx="3"/><text x="${x + 12}" y="${y + BOXH + i * FROW + 10}">L${sf.level} ${esc(short(f))}${sf.layer ? ` · ${esc(sf.layer)}` : ''}</text></g>`; });
        out += '</g>';
      });
      if (rr === 0) out += `<text class="lsm-lv" x="4" y="${y + 14}">level ${L}</text>`;
      y += maxH + (rr === nrows - 1 ? ROWGAP : 10);
    }
  });
  let e = '';
  const edgesShown = ST.module_edges.length > 2500 ? [] : ST.module_edges;
  edgesShown.forEach(([a, b, n]) => {
    const A = box[a], B = box[b]; if (!A || !B) return;
    const fbk = lv[b] >= lv[a], x1 = A.x + A.w / 2, y1 = A.y + A.h, x2 = B.x + B.w / 2, y2 = B.y;
    if (fbk) { const xl = Math.min(A.x, B.x) - 16; e += `<path class="lsm-edge fb" d="M${A.x},${A.y + A.h / 2} C${xl},${A.y + A.h / 2} ${xl},${B.y + B.h / 2} ${B.x},${B.y + B.h / 2}" marker-end="url(#arr2)"><title>${esc(nodeName(a))} → ${esc(nodeName(b))} (${n}) upward</title></path>`; }
    else e += `<path class="lsm-edge" d="M${x1},${y1} C${x1},${y1 + 24} ${x2},${y2 - 24} ${x2},${y2}" marker-end="url(#arr1)"><title>${esc(nodeName(a))} → ${esc(nodeName(b))} (${n})</title></path>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${Wd} ${y}" width="${Wd}" height="${y}"><defs><marker id="arr1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-strong)"/></marker><marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--critical)"/></marker></defs>${e}${out}</svg>` + (ST.module_edges.length > 2500 ? '<p style="color:var(--muted);font-size:11.5px">module edges hidden (too many); use the ISR filter</p>' : '');
  host.querySelectorAll('.lsm-node').forEach(g => g.addEventListener('click', () => { const mname = g.dataset.mod; if (S.lsmOpen.has(mname)) S.lsmOpen.delete(mname); else S.lsmOpen.add(mname); renderStructure(); }));
}
