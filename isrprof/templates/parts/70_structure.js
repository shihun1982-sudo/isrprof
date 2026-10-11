// ================================================================== Structure101-style tab: DSM, LSM, tangles, violations
function sliceSet() { return S.isr === 'ALL' ? null : SLICE[S.isr]; }
function dsmEdges() { return ST.matrix.map(([r, c, n]) => [ST.order[r], ST.order[c], n]); }
function tile(v, l, s, cls) { return `<div class="tile ${cls || ''}"><div class="v">${v}</div><div class="l">${l}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`; }
function renderStructure() {
  const sl = sliceSet(), fids = ST.order.filter(f => !sl || sl.has(f)), fset = new Set(fids);
  const edges = dsmEdges().filter(([a, b]) => fset.has(a) && fset.has(b));
  const items = [];
  for (const m of ST.modules) {
    const fns = m.functions.filter(f => fset.has(f)); if (!fns.length) continue;
    if (S.dsmCollapsed.has(m.name)) items.push({ kind: 'mod', id: m.name, module: m.name, set: new Set(fns), level: ST.module_levels[m.name], first: true });
    else fns.forEach((f, k) => items.push({ kind: 'fn', id: f, module: m.name, set: new Set([f]), level: ST.functions[f].level, first: k === 0 }));
  }
  const idx = {}; items.forEach((it, i) => it.set.forEach(f => { idx[f] = i; }));
  const cell = items.map(() => items.map(() => 0));
  edges.forEach(([a, b, n]) => { cell[idx[a]][idx[b]] += n; });
  let fb = 0, tot = 0; edges.forEach(([a, b]) => { tot++; if (idx[a] > idx[b]) fb++; });
  const m = ST.metrics, viol = ST.violations.filter(v => fset.has(v.from) && fset.has(v.to)), tangles = ST.tangles.filter(t => t.some(f => fset.has(f)));
  document.getElementById('tiles').innerHTML =
    tile(fids.length, 'functions', sl ? 'reachable from ' + S.isr : 'reachable from all ISRs') +
    tile(edges.length, 'dependencies', `${items.length} rows × ${items.length} cols in the matrix`) +
    tile((tot ? (100 * fb / tot).toFixed(1) : '0.0') + '%', 'tangled', `${fb} feedback dependenc${fb === 1 ? 'y' : 'ies'}`, fb ? 'bad' : 'ok') +
    tile(tangles.length, 'tangles', tangles.map(t => t.map(short).join(' ↔ ')).join('; ') || 'no cycles', tangles.length ? 'bad' : 'ok') +
    tile(viol.length, 'rule violations', viol.length ? viol.map(v => v.kind).join(', ') : 'layering holds', viol.length ? 'bad' : 'ok') +
    tile(m.overweight_modules.length, 'overweight modules', `fat > ${m.fat_threshold}: ${m.overweight_modules.join(', ') || '—'}`, m.overweight_modules.length ? 'bad' : 'ok') +
    tile(m.max_level, 'max level', 'levels in the levelized structure map');
  let h = '<table class="dsm"><thead><tr><th class="rh"></th>';
  items.forEach(it => { h += `<th class="ch ${it.kind === 'mod' ? 'mod' : ''}" data-mod="${esc(it.module)}" title="${esc(it.id)}"><span>${it.kind === 'mod' ? '▸ ' : ''}${esc(short(it.id))}</span></th>`; });
  h += '</tr></thead><tbody>';
  items.forEach((it, i) => {
    const lay = it.kind === 'fn' ? (ST.functions[it.id].layer || '') : (ST.modules.find(z => z.name === it.module).layer || '');
    const relRow = REL && (it.kind === 'mod' ? REL.modules.has(it.module) : REL.fids.has(it.id));
    h += `<tr class="${it.first ? 'mg' : ''}"><th class="rh ${it.kind === 'mod' ? 'mod' : ''} ${relRow ? 'rel' : ''}" data-mod="${esc(it.module)}"><span class="lv" title="level">${it.level}</span><i class="sw" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${modColor(it.module)};margin-right:6px;vertical-align:-1px"></i>${it.kind === 'mod' ? '<span class="car">▸</span>' : ''}${esc(short(it.id))}${lay ? `<span class="ly">${esc(lay)}</span>` : ''}${it.kind === 'fn' && ST.functions[it.id].tangled ? ' <span class="b x">↻</span>' : ''}</th>`;
    items.forEach((jt, j) => {
      const n = cell[i][j];
      if (i === j) h += `<td class="d" title="${esc(it.id)}: ${it.kind === 'mod' ? 'internal deps ' + n : 'self'}">${it.kind === 'mod' && n ? n : ''}</td>`;
      else if (!n) h += '<td></td>';
      else h += `<td class="${i > j ? 'fb' : 'n'}" data-tip="${esc(short(it.id) + ' → ' + short(jt.id) + ' (' + n + (i > j ? ', feedback)' : ')'))}">${n}</td>`;
    });
    h += '</tr>';
  });
  h += '</tbody></table>';
  const dsm = document.getElementById('dsm'); dsm.innerHTML = h;
  dsm.querySelectorAll('th[data-mod]').forEach(th => th.addEventListener('click', () => { const mname = th.dataset.mod; if (S.dsmCollapsed.has(mname)) S.dsmCollapsed.delete(mname); else S.dsmCollapsed.add(mname); renderStructure(); }));
  dsm.querySelectorAll('td[data-tip]').forEach(td => { td.addEventListener('mouseenter', e => showTip(`<span class="mono">${td.dataset.tip}</span>`, e.clientX, e.clientY)); td.addEventListener('mouseleave', hideTip); });
  renderLSM(fset);
  let v = '';
  if (tangles.length) v += `<p style="margin:0 0 6px"><b>Tangles</b> (strongly connected groups): ${tangles.map(t => `<code>${t.map(short).join(' ↔ ')}</code>`).join(' · ')}</p>`;
  if (ST.module_tangles.length) v += `<p style="margin:0 0 6px"><b>Module-level tangles</b>: ${ST.module_tangles.map(t => `<code>${t.join(' ↔ ')}</code>`).join(' · ')}</p>`;
  v += `<p style="margin:0 0 6px;color:var(--muted)">Layers (top → bottom): ${ST.layers.map(esc).join(' › ') || 'none configured'}</p>`;
  v += viol.length ? `<table class="t"><tr><th>kind</th><th>from</th><th>to</th><th>detail</th><th>n</th></tr>` + viol.map(x => `<tr><td><span class="viol-k ${x.kind}">${x.kind}</span></td><td>${esc(short(x.from))}</td><td>${esc(short(x.to))}</td><td>${x.kind === 'rule' ? esc(x.rule) : esc(x.from_layer) + ' → ' + esc(x.to_layer)}</td><td>${x.n}</td></tr>`).join('') + '</table>' : '<p style="margin:0;color:var(--good)">No layer or rule violations in this slice.</p>';
  document.getElementById('viol').innerHTML = v;
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
    const bw = Math.min(260, (Wd - left - 10 * (r.length - 1)) / r.length); let maxH = BOXH;
    r.forEach((m, k) => {
      const fns = m.functions.filter(f => fset.has(f)), open = S.lsmOpen.has(m.name), hgt = BOXH + (open ? fns.length * FROW + 6 : 0); maxH = Math.max(maxH, hgt);
      const x = left + k * (bw + 10); box[m.name] = { x, y, w: bw, h: hgt };
      const tangled = ST.module_tangles.some(t => t.includes(m.name)) || m.tangled > 0;
      out += `<g class="lsm-node ${m.overweight ? 'over' : ''} ${tangled ? 'tangled' : ''}" data-mod="${esc(m.name)}"><rect class="box" x="${x}" y="${y}" width="${bw}" height="${hgt}" rx="6"/><rect x="${x}" y="${y}" width="4" height="${hgt}" rx="2" fill="${modColor(m.name)}"/>` +
        `<text class="nm" x="${x + 12}" y="${y + 16}">${open ? '▾' : '▸'} ${esc(m.name)}</text><text class="mt" x="${x + 12}" y="${y + 30}">fat ${m.fat}${m.overweight ? ' ⚠' : ''} · in ${m.fan_in} · out ${m.fan_out} · ${fns.length} fn${m.layer ? ' · ' + esc(m.layer) : ''}</text>`;
      if (open) fns.forEach((f, i) => { const sf = ST.functions[f]; out += `<g class="lsm-fn ${sf.tangled ? 'tg' : ''} ${REL && REL.fids.has(f) ? 'rel' : ''}"><rect x="${x + 8}" y="${y + BOXH + i * FROW}" width="${bw - 16}" height="${FROW - 2}" rx="3"/><text x="${x + 12}" y="${y + BOXH + i * FROW + 10}">L${sf.level} ${esc(short(f))}${sf.layer ? ` · ${esc(sf.layer)}` : ''}</text></g>`; });
      out += '</g>';
    });
    out += `<text class="lsm-lv" x="4" y="${y + 14}">level ${L}</text>`;
    y += maxH + ROWGAP;
  });
  let e = '';
  ST.module_edges.forEach(([a, b, n]) => {
    const A = box[a], B = box[b]; if (!A || !B) return;
    const fbk = lv[b] >= lv[a], x1 = A.x + A.w / 2, y1 = A.y + A.h, x2 = B.x + B.w / 2, y2 = B.y;
    if (fbk) { const xl = Math.min(A.x, B.x) - 16; e += `<path class="lsm-edge fb" d="M${A.x},${A.y + A.h / 2} C${xl},${A.y + A.h / 2} ${xl},${B.y + B.h / 2} ${B.x},${B.y + B.h / 2}" marker-end="url(#arr2)"><title>${esc(a)} → ${esc(b)} (${n}) upward</title></path>`; }
    else e += `<path class="lsm-edge" d="M${x1},${y1} C${x1},${y1 + 24} ${x2},${y2 - 24} ${x2},${y2}" marker-end="url(#arr1)"><title>${esc(a)} → ${esc(b)} (${n})</title></path>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${Wd} ${y}" width="${Wd}" height="${y}"><defs><marker id="arr1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-strong)"/></marker><marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--critical)"/></marker></defs>${e}${out}</svg>`;
  host.querySelectorAll('.lsm-node').forEach(g => g.addEventListener('click', () => { const mname = g.dataset.mod; if (S.lsmOpen.has(mname)) S.lsmOpen.delete(mname); else S.lsmOpen.add(mname); renderStructure(); }));
}
