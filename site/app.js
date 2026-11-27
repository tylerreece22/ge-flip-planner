/* Page behaviour for the GE flip planner. All trade maths lives in core.js. */
(function () {
  'use strict';
  const API = 'https://prices.runescape.wiki/api/v1/osrs';
  const HOUR = 3600;
  const POLL = 60;              // seconds between live price checks while the page is on screen
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const { fmt, gp } = GE;
  const KIND = { pack: 'Pack', unpack: 'Unpack', flip: 'Flip' };
  const MIN_ROUND = 50000;      // options that cannot make this much in one round are noise
  const WINDOWS = ['Last 4 hours', '4–12 hours ago', '12–24 hours ago'];
  // Columns of the option list. Click a heading to sort by it; `asc` marks the one that starts A to Z.
  const COLS = [
    { k: 'name', t: 'Option', get: o => o.name.toLowerCase(), asc: true },
    { k: 'slots', t: 'Slots', r: true, get: o => o.slots },
    { k: 'cost', t: 'Cost each', r: true, get: o => o.unitCost },
    { k: 'profit', t: 'Profit each', r: true, get: o => o.shownProfit, tip: 'After tax, and conservative: the lowest of the gap today, in each recent time window, and at the 7-day price.' },
    { k: 'roi', t: 'Return', r: true, get: o => o.shownRoi, tip: 'Conservative profit each divided by cost each.' },
    { k: 'vol', t: 'Volume per day', r: true, get: o => o.vol, tip: 'How many trade per day on the slower of the buy side and the sell side. The smaller figure is the same volume in gp.' },
    { k: 'qty', t: 'Quantity', r: true, get: o => o.shownQty },
    { k: 'total', t: 'Profit this round', get: o => o.shownTotal },
    { k: 'pos', t: 'Gap confirmed', get: o => o.pos },
  ];

  // ---- Settings remembered on this device only ---------------------------------
  const defaults = { cash: '36m', slots: 3, hours: 8, minRoi: 8, sort: { col: 'total', dir: 'desc' }, picks: [], types: { pack: true, unpack: true, flip: true }, hidden: [], tab: 'buy', filter: 'all' };
  let state = Object.assign({}, defaults);
  try { Object.assign(state, JSON.parse(localStorage.getItem('ge-flips') || '{}')); } catch (e) { /* private window: fine */ }
  state.types = Object.assign({}, defaults.types, state.types);
  if (!state.sort || typeof state.sort !== 'object') state.sort = state.sort === 'roi' ? { col: 'roi', dir: 'desc' } : { col: 'total', dir: 'desc' };
  if (!Array.isArray(state.picks)) state.picks = [];
  if (!(+state.minRoi >= 5)) state.minRoi = 5;   // nothing under 5% is offered any more
  const save = () => { try { localStorage.setItem('ge-flips', JSON.stringify(state)); } catch (e) { /* ignore */ } };

  let data = null, model = null, opps = [], liveError = false, shown = 40, picked = null;
  let busy = false, lastRun = 0, dataTried = 0;
  const open = new Set();

  // ---- Loading -------------------------------------------------------------------
  const getJson = async (url, cache) => { const r = await fetch(url, { cache }); if (!r.ok) throw new Error(r.status); return r.json(); };

  async function boot() {
    wire();
    try {
      data = await getJson('data.json', 'no-cache');
    } catch (e) {
      $('#status').textContent = 'Could not load the price data.';
      $('#plan').innerHTML = '<div class="empty">The price data file did not load. Try again in a minute.</div>';
      return;
    }
    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, POLL * 1000);
    setInterval(status, 20 * 1000);
    // Coming back to the tab (or unlocking the phone) should never show old prices.
    const back = () => { if (!document.hidden && Date.now() / 1000 - lastRun > 15) refresh(); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    window.addEventListener('pageshow', back);
  }

  // The scheduled rebuild of data.json can run late or miss a run, so the page does not rely on it for
  // anything time-sensitive: it picks up a newer data.json when there is one, and adds any hours the
  // file is missing straight from the API.
  async function syncHistory(now) {
    if (now - data.generated > 70 * 60 && now - dataTried > 10 * 60) {
      dataTried = now;
      try { const d = await getJson('data.json', 'no-cache'); if (d.generated > data.generated) data = d; } catch (e) { /* keep what we have */ }
    }
    if (!data.hours) return;
    const newest = Math.floor(now / HOUR) * HOUR - HOUR;            // start of the last complete hour
    const starts = [];
    for (let t = Math.max(data.lastHour, newest - 23 * HOUR); t <= newest; t += HOUR) starts.push(t);
    if (!starts.length) return;
    const got = await Promise.all(starts.map(t => getJson(`${API}/1h?timestamp=${t}`, 'no-store').then(j => j.data, () => null)));
    for (let i = 0; i < starts.length; i++) {
      // An hour is published a few minutes after it ends. Stop at the first one that is missing; the next check tries again.
      if (!got[i] || Object.keys(got[i]).length < 500) break;
      GE.addHour(data, starts[i], got[i]);
    }
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      lastRun = now;
      const [live] = await Promise.all([getJson(API + '/latest', 'no-store').then(j => j.data, () => null), syncHistory(now)]);
      model = GE.load(data, now);
      if (live) GE.applyLive(model, live, now);
      liveError = !live;
      opps = GE.opportunities(model);
      render();
    } finally { busy = false; }
  }

  const ago = s => (s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' hours ago' : Math.round(s / 86400) + ' days ago');
  const clock = t => new Date(t * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  function status() {
    if (!model) return;
    const now = Date.now() / 1000;
    const prices = liveError ? `Live prices unavailable, using prices from ${ago(now - model.generated)}` : `Prices live, checked ${ago(now - model.pricesAt)}`;
    $('#status').innerHTML = `${esc(prices)} · hourly history up to ${esc(clock(model.historyAt))} · <button id="reload">Refresh</button>`;
    const behind = now - model.historyAt;                           // normally under an hour and a bit
    $('#banner').innerHTML = behind > 3 * HOUR
      ? `<div class="banner">⚠ The hourly history behind these checks stops ${esc(ago(behind))}, because neither the scheduled update nor this page could fetch anything newer. Live prices are still current, but treat the picks with more care.</div>` : '';
  }

  // ---- Controls ------------------------------------------------------------------
  function seg(el, options, value, onPick) {
    el.innerHTML = options.map(o => `<button type="button" role="radio" aria-checked="${o.v === value}" data-v="${esc(o.v)}">${esc(o.t)}</button>`).join('');
    el.onclick = e => { const b = e.target.closest('button'); if (b) onPick(b.dataset.v); };
  }

  function wire() {
    $('#cash').value = state.cash;
    $('#cash').addEventListener('input', e => { state.cash = e.target.value; save(); render(); });
    document.querySelectorAll('[data-type]').forEach(c => {
      c.checked = !!state.types[c.dataset.type];
      c.addEventListener('change', () => { state.types[c.dataset.type] = c.checked; save(); render(); });
    });
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; save(); tabs(); }));
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-act]');
      if (e.target.id === 'reload') { refresh(); return; }
      if (!t) return;
      const k = t.dataset.key, act = t.dataset.act;
      if (act === 'hide') { state.hidden.push(k); save(); render(); }
      else if (act === 'unhide') { state.hidden = state.hidden.filter(x => x !== k); save(); render(); }
      else if (act === 'unhide-all') { state.hidden = []; save(); render(); }
      else if (act === 'toggle') { open.has(k) ? open.delete(k) : open.add(k); renderList(); }
      else if (act === 'more') { shown += 40; renderList(); }
      else if (act === 'select') {
        // Ticking rebuilds the plan above the table, so hold the table where it was on screen.
        const inTable = !!t.closest('#opts'), before = $('#opts').getBoundingClientRect().top;
        state.picks = state.picks.includes(k) ? state.picks.filter(x => x !== k) : state.picks.concat(k);
        save(); render();
        if (inTable) window.scrollBy(0, $('#opts').getBoundingClientRect().top - before);
      }
      else if (act === 'clear-picks') { state.picks = []; save(); render(); }
      else if (act === 'floor') { state.minRoi = +t.dataset.v; save(); render(); }
      else if (act === 'how') { state.tab = 'how'; save(); tabs(); const h = document.getElementById('tested'); if (h) h.scrollIntoView(); }
      else if (act === 'sort') {
        const col = COLS.find(c => c.k === t.dataset.col);
        state.sort = state.sort.col === col.k ? { col: col.k, dir: state.sort.dir === 'desc' ? 'asc' : 'desc' } : { col: col.k, dir: col.asc ? 'asc' : 'desc' };
        shown = 40; save(); renderList();
      }
      else if (act === 'pick') { picked = +t.dataset.id; $('#q').value = model.items.get(picked).name; renderCheck(); }
      else if (act === 'check') { picked = +t.dataset.id; state.tab = 'check'; save(); tabs(); $('#q').value = model.items.get(picked).name; renderCheck(); window.scrollTo(0, 0); }
    });
    ['q', 'paid', 'qty'].forEach(id => $('#' + id).addEventListener('input', () => { if (id === 'q') picked = null; renderCheck(); }));
    document.addEventListener('mousemove', hover);
    document.addEventListener('touchstart', hover, { passive: true });
    window.addEventListener('scroll', () => { $('#tip').hidden = true; }, { passive: true });
    tabs();
  }

  function tabs() {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
    ['buy', 'check', 'how'].forEach(t => { $('#tab-' + t).hidden = t !== state.tab; });
    $('#tip').hidden = true;
  }

  // ---- Shared pieces -------------------------------------------------------------
  const itemLink = (id, name) => `<a href="https://prices.runescape.wiki/osrs/item/${id}" target="_blank" rel="noopener">${esc(name)}</a>`;
  const hoursText = h => (!isFinite(h) ? 'unknown' : h < 1 ? 'under an hour' : h <= 36 ? `about ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}` : 'over a day');
  const signed = n => `<span class="${n > 0 ? 'pos' : 'negv'}">${n > 0 ? '+' : ''}${gp(n)}</span>`;

  function offers(rows, act, qty) {
    return `<table class="offers">${rows.map(r => `<tr><td class="act">${act}</td><td>${itemLink(r.id, r.name)}</td><td class="num">× ${gp(qty * r.per)}</td><td class="num price">${gp(r.price)} each</td></tr>`).join('')}</table>`;
  }

  function steps(o, qty) {
    const s = [];
    if (o.type === 'pack') {
      s.push(`Place these buy offers.${offers(o.buys, 'Buy', qty)}`);
      s.push('Collect the pieces, right-click a Grand Exchange clerk, choose Sets, and pack them.');
      s.push(`Sell the sets.${offers(o.sells, 'Sell', qty)}`);
    } else if (o.type === 'unpack') {
      s.push(`Buy the sets. This price should fill almost at once.${offers(o.buys, 'Buy', qty)}`);
      s.push('Right-click a Grand Exchange clerk, choose Sets, and unpack them.');
      s.push(`Sell the pieces. They can share one slot, one after another.${offers(o.sells, 'Sell', qty)}`);
    } else {
      s.push(`Place the buy offer.${offers(o.buys, 'Buy', qty)}`);
      s.push(`When it fills, sell.${offers(o.sells, 'Sell', qty)}`);
    }
    return `<ol class="steps">${s.map(x => `<li>${x}</li>`).join('')}</ol>`;
  }

  function flags(o) {
    return o.flags.length ? `<ul class="flags">${o.flags.map(f => `<li class="${f.level}">${esc(f.text)}</li>`).join('')}</ul>` : '';
  }

  function dots(o) {
    const label = o.windows.map((w, i) => `${WINDOWS[i]}: ${w === null ? 'too few trades' : gp(w)}`).join('\n');
    return `<span class="dots" title="${esc(label)}">${o.windows.map(w => `<i class="${w === null ? '' : w > 0 ? 'y' : 'n'}"></i>`).join('')}</span> <span class="small">${o.pos}/3</span>`;
  }

  function chart(o) {
    const A = o.chart.a.days, B = o.chart.b.days, n = A.length;
    const vals = A.concat(B).filter(v => v > 0);
    if (vals.length < 6) return '<p class="muted small">Not enough daily history for a chart.</p>';
    let min = Math.min(...vals), max = Math.max(...vals);
    const pad = (max - min) * 0.15 || max * 0.02; min -= pad; max += pad;
    const W = 560, H = 210, L = 8, R = 96, T = 10, Bm = 24;
    const x = i => L + ((W - L - R) * i) / (n - 1), y = v => T + (H - T - Bm) * (1 - (v - min) / (max - min));
    const line = s => { let d = '', pen = false; s.forEach((v, i) => { if (v > 0) { d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; } else pen = false; }); return d; };
    const day = i => new Date((model.generated - (n - i) * 86400) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const lastIdx = s => { for (let i = n - 1; i >= 0; i--) if (s[i] > 0) return i; return -1; };
    const ia = lastIdx(A), ib = lastIdx(B);
    let ya = y(A[ia]), yb = y(B[ib]);
    if (Math.abs(ya - yb) < 26) { const mid = (ya + yb) / 2, up = ya <= yb ? -13 : 13; ya = mid + up; yb = mid - up; }
    const grid = [0.1, 0.5, 0.9].map(f => { const v = min + (max - min) * f; return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L + 2}" y="${y(v) - 3}">${fmt(v)}</text>`; }).join('');
    const pts = JSON.stringify({ a: A, b: B, la: o.chart.a.label, lb: o.chart.b.label, days: A.map((_, i) => day(i)), L, R, W });
    return `<div class="legend"><span><i class="a"></i>${esc(o.chart.a.label)}</span><span><i class="b"></i>${esc(o.chart.b.label)}</span><span>daily average, last ${n} days</span></div>
      <div class="chart" data-pts="${esc(pts)}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.chart.a.label)} against ${esc(o.chart.b.label)} over the last ${n} days">
      ${grid}<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - Bm}" visibility="hidden"/>
      <path class="b" d="${line(B)}"/><path class="a" d="${line(A)}"/>
      <circle class="b" r="4" cx="${x(ib)}" cy="${y(B[ib])}"/><circle class="a" r="4" cx="${x(ia)}" cy="${y(A[ia])}"/>
      <text class="lab" x="${W - R + 8}" y="${ya - 1}">${esc(o.chart.a.label)}</text><text x="${W - R + 8}" y="${ya + 11}">${fmt(A[ia])}</text>
      <text class="lab" x="${W - R + 8}" y="${yb - 1}">${esc(o.chart.b.label)}</text><text x="${W - R + 8}" y="${yb + 11}">${fmt(B[ib])}</text>
      <text x="${L}" y="${H - 6}">${day(0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${day(n - 1)}</text>
      </svg></div>`;
  }

  function hover(e) {
    const tip = $('#tip'), box = e.target.closest ? e.target.closest('.chart') : null;
    document.querySelectorAll('.chart .cross').forEach(c => c.setAttribute('visibility', 'hidden'));
    if (!box) { tip.hidden = true; return; }
    const p = JSON.parse(box.dataset.pts), svg = box.querySelector('svg'), r = svg.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    const sx = ((pt.clientX - r.left) / r.width) * p.W, n = p.a.length;
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - p.L) / (p.W - p.L - p.R)) * (n - 1))));
    const cx = p.L + ((p.W - p.L - p.R) * i) / (n - 1);
    const cross = box.querySelector('.cross');
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    const gap = p.a[i] > 0 && p.b[i] > 0 ? `<br>Gap before tax <b>${gp(p.a[i] - p.b[i])}</b>` : '';
    tip.innerHTML = `${esc(p.days[i])}<br>${esc(p.la)} <b>${p.a[i] ? gp(p.a[i]) : 'no trades'}</b><br>${esc(p.lb)} <b>${p.b[i] ? gp(p.b[i]) : 'no trades'}</b>${gap}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(window.innerWidth - tw - 8, pt.clientX + 14) + 'px';
    tip.style.top = Math.max(8, pt.clientY - 10 - tip.offsetHeight) + 'px';
  }

  function detail(o) {
    const sellWord = o.type === 'unpack' ? 'pieces' : o.type === 'pack' ? 'set' : 'item';
    const rows = o.windows.map((w, i) => `<tr><th>${WINDOWS[i]}</th><td class="num">${w === null ? '<span class="muted">too few trades</span>' : signed(w)}</td></tr>`).join('');
    return `<div class="detail-grid"><div>
        <table class="mini">
          <tr><th colspan="2"><b>Profit each, by time window</b></th></tr>${rows}
          <tr><th>At the offer prices shown, now</th><td class="num">${signed(o.profitNow)}</td></tr>
          <tr><th>If prices returned to the 7-day level</th><td class="num">${signed(o.fade)}</td></tr>
          <tr><th><b>Counted in your plan: the lowest of those</b></th><td class="num"><b>${signed(o.profit)}</b></td></tr>
          <tr><th>If you sold the ${sellWord} instantly instead</th><td class="num">${signed(o.quick)}</td></tr>
          <tr><th>${o.type === 'unpack' ? 'Sets traded per day' : 'Sold into buy offers per day (slowest piece)'}</th><td class="num">${gp(o.buyPerDay)}</td></tr>
          <tr><th>${o.type === 'unpack' ? 'Bought per day (slowest piece)' : 'Bought from sell offers per day'}</th><td class="num">${gp(o.sellPerDay)}</td></tr>
          <tr><th>Buy limit per 4 hours</th><td class="num">${o.limit === null ? 'not listed' : gp(o.limit)}</td></tr>
        </table></div><div>${chart(o)}</div></div>`;
  }

  // ---- Your plan -----------------------------------------------------------------
  function settings() {
    const cash = GE.parseCash(state.cash);
    return { cash, slots: +state.slots, hours: +state.hours, minRoi: Math.max(5, +state.minRoi || 0) / 100, types: state.types, hidden: new Set(state.hidden) };
  }

  function card(o, manual) {
    return `<article class="card">
        <div class="card-head"><h3><span class="kind">${KIND[o.type]}</span>${esc(o.name)} × ${gp(o.qty)}</h3>
          <span class="gain">${o.confidence > 0 ? `about ${fmt(o.total)} profit` : `<span class="warnmark">⚠ failed the checks</span> · ${fmt(o.qty * o.profitNow)} only if today's prices hold`}</span></div>
        ${steps(o, o.qty)}
        <div class="stats">
          <div><span>Cost each</span><b>${gp(o.unitCost)}</b></div>
          <div><span>Profit each, conservative</span><b>${gp(o.profit)} <small>(${(o.roi * 100).toFixed(1)}%)</small></b></div>
          <div><span>If today's prices hold</span><b>${gp(o.profitNow)} <small>(${(o.roiNow * 100).toFixed(1)}%)</small></b></div>
          ${o.breakEven ? `<div><span>Break-even sell price</span><b>${gp(o.breakEven)}</b></div>` : ''}
          <div><span>Buying takes</span><b>${hoursText(o.buyHours)}</b></div>
          <div><span>Selling takes</span><b>${hoursText(o.sellHours)}</b></div>
          <div><span>Volume per day</span><b>${gp(Math.min(o.buyPerDay, o.sellPerDay))}</b></div>
          <div><span>Gap confirmed</span><b>${dots(o)}</b></div>
        </div>
        ${flags(o)}
        <details class="evidence"><summary>
          <span class="link">Show the evidence</span>
          ${manual
            ? `<button class="link" data-act="select" data-key="${o.key}">Remove from my picks</button>`
            : `<button class="link" data-act="hide" data-key="${o.key}" title="Use this if you are already doing it or are not interested">Hide this option</button>`}
        </summary>${detail(o)}</details>
      </article>`;
  }

  function tiles(p, s, rp) {
    const over = p.slots > s.slots;
    const likely = rp ? [`${fmt(p.profit * rp.lo)} to ${fmt(p.profit * rp.hi)}`, 'likely profit after tax, from the replay'] : null;
    return `<div class="tiles">${[
      [fmt(p.cost), `to spend of ${fmt(s.cash)}`], [fmt(Math.max(0, s.cash - p.cost)), 'left idle'],
      likely, [fmt(p.profit), `profit if everything fills${p.cost ? ` (${((p.profit / p.cost) * 100).toFixed(1)}%)` : ''}`],
      [`${p.slots} of ${s.slots}`, over ? '⚠ slots needed to buy, more than you have free' : 'slots used to buy'],
    ].filter(Boolean).map(t => `<div class="tile"><b>${t[0]}</b><span>${t[1]}</span></div>`).join('')}</div>`;
  }

  /** What to do each time you come back. In the replay this routine was the difference between keeping
      about three quarters of the profit and keeping under half. */
  function routine() {
    return `<details class="compare routine"><summary><b>What to do at each check-in</b> <span class="muted">(this roughly doubled the profit in the replay)</span></summary>
      <ol>
        <li>Pack or unpack whatever has filled and list it at the sell price this page shows <i>then</i>, not the one from earlier.</li>
        <li>Move any buy offer that has not filled to the buy price shown then.</li>
        <li>By your second check-in, cancel what still has not filled. If a set is short of one piece, look that piece up in Price check and buy it at "Buy right now" to finish the sets you have started.</li>
        <li>Sell any spare pieces on their own at their Price check sell price.</li>
      </ol></details>`;
  }

  const FLOORS = [5, 8, 12, 15];
  // From scripts/backtest.js over 5-26 Nov 2026: across the cash, slot and check-in settings on this page,
  // how much of the plan's headline profit the replay actually made, and how often a round lost money.
  // `lo` assumes you catch a quarter of the market's flow, `hi` half. `lost` covers the same range.
  const REPLAY = {
    5: { lo: 0.5, hi: 0.7, lost: '1 in 10 to 1 in 20', worst: '2.3m to 3.7m' },
    8: { lo: 0.55, hi: 0.8, lost: 'about 1 in 20', worst: '0.2m to 1.1m' },
    12: { lo: 0.6, hi: 0.8, lost: 'about 1 in 30', worst: 'about 0.2m' },
    15: { lo: 0.7, hi: 0.85, lost: 'about 1 in 50', worst: 'about 0.2m' },
  };
  const range = r => `${Math.round(r.lo * 100)}–${Math.round(r.hi * 100)}%`;
  /** What the plan would look like at each minimum return, so the idle-cash trade-off is visible. */
  function compare(s) {
    const rows = FLOORS.map(f => {
      const p = GE.plan(opps, Object.assign({}, s, { minRoi: f / 100 })), idle = Math.max(0, s.cash - p.cost), cur = f === +state.minRoi;
      return `<tr class="${cur ? 'cur' : ''}" data-act="floor" data-v="${f}" title="Use this minimum return">
        <td>${f}%${cur ? ' <span class="cur-word">(current)</span>' : ''}</td><td class="num">${fmt(p.cost)}</td><td class="num">${fmt(idle)} (${Math.round((idle / s.cash) * 100)}%)</td>
        <td class="num">${fmt(p.profit)}</td><td class="num">${p.cost ? ((p.profit / p.cost) * 100).toFixed(1) + '%' : '–'}</td>
        <td class="num">${range(REPLAY[f])} of it</td><td class="num">${REPLAY[f].lost}</td></tr>`;
    }).join('');
    return `<details class="compare" open><summary>Tune it: minimum return against idle cash <span class="muted">(click a row to use it)</span></summary>
      <table class="compare"><thead><tr><th>Minimum return</th><th>Cash working</th><th>Left idle</th><th>Profit</th><th>Return</th><th title="How much of the profit figure a three-week replay of past prices actually made">Replay made</th><th title="How often a round lost money in that replay">Rounds lost</th></tr></thead><tbody>${rows}</tbody></table></details>`;
  }

  function nameOf(key) {
    const [type, id] = key.split(':'), it = model.items.get(+id);
    return `${KIND[type] || ''} ${it ? it.name : 'an option'}`.trim();
  }

  function renderPlan(s) {
    const el = $('#plan');
    if (!s.cash) { el.innerHTML = '<div class="empty">Enter how much cash you have, for example <b>46m</b>.</div>'; return; }
    if (state.picks.length) {
      // The player ticked options: build the plan from exactly those.
      const p = GE.pickPlan(opps, state.picks, s), n = state.picks.length;
      const notes = [];
      p.unfunded.forEach(u => notes.push(u.reason === 'cash'
        ? `${esc(u.o.title)} got nothing: there is not enough cash left for one (${fmt(u.o.unitCost)} each).`
        : `${esc(u.o.title)} got nothing: it trades too rarely to finish between check-ins.`));
      p.missing.forEach(k => notes.push(`${esc(nameOf(k))} is ticked but its gap has closed, so there is nothing to do there right now.`));
      const failed = p.picks.filter(o => o.confidence === 0).length;
      if (failed) notes.push(`${failed} of your picks failed the checks. In the replay, trades that failed lost money more than 4 times in 10 and lost overall, so the profit shown for them is not counted.`);
      if (p.slots > s.slots) notes.push(`These picks need ${p.slots} slots to buy and you entered ${s.slots}. Start the ones at the top and add the rest as slots free up.`);
      el.innerHTML = `<p class="mode"><b>Built from the ${n} option${n === 1 ? '' : 's'} you ticked</b>, with cash going to the highest return first. The minimum return is not applied to your own picks. <button class="link" data-act="clear-picks">Back to the automatic plan</button></p>
        ${p.picks.length ? tiles(p, s, p.picks.every(o => o.confidence > 0) ? { lo: 0.5, hi: 0.8 } : null) : ''}${notes.length ? `<ul class="flags" style="margin:0 0 12px">${notes.map(x => `<li class="warn">${x}</li>`).join('')}</ul>` : ''}
        ${p.picks.map(o => card(o, true)).join('')}`;
      return;
    }
    const p = GE.plan(opps, s);
    if (!p.picks.length) {
      const on = Object.keys(WORD).filter(t => s.types[t]);
      if (!on.length) { el.innerHTML = '<div class="empty">Tick at least one kind of trade under Include.</div>'; return; }
      const kinds = on.length === 3 ? '' : on.map(t => WORD[t]).join(' or ') + ' ';
      const failed = listable(s).filter(o => s.types[o.type] && o.confidence === 0).length;
      const usable = listable(s).some(o => s.types[o.type] && o.confidence > 0);
      const why = usable
        ? `${s.types.pack ? 'Sets need 3 to 5 free slots to pack. ' : ''}Try more slots, a lower minimum return, or tick options yourself in the list below.`
        : failed ? `${failed === 1 ? 'One' : failed} ${kinds}gap${failed === 1 ? ' is' : 's are'} open at today's prices but failed a check. ${failed === 1 ? 'It is' : 'They are'} listed under "Every option" below with the reason, and you can tick one to use it anyway.`
          : `No ${kinds}gap worth a slot is open at the moment.`;
      el.innerHTML = `<div class="empty">${usable ? `No ${kinds}option fits` : `No ${kinds}option passes the checks for`} ${esc(fmt(s.cash))} and ${s.slots} slot${s.slots === 1 ? '' : 's'} right now${usable && s.minRoi ? ` at a return of ${state.minRoi}% or more` : ''}. ${why}</div>${compare(s)}`;
      return;
    }
    const left = s.cash - p.cost;
    const rp = REPLAY[state.minRoi] || REPLAY[5];
    el.innerHTML = `${tiles(p, s, rp)}<p class="replay-note">Replayed against three weeks of real trades, plans at this ${state.minRoi}% setting made <b>${range(rp)}</b> of the all-fills figure. A round lost money ${rp.lost} times, and the worst lost ${rp.worst}. <button class="link" data-act="how">How it was tested</button></p>${routine()}${p.picks.map(o => card(o, false)).join('')}${left > 0 && p.slots < s.slots ? `<p class="muted small">${fmt(left)} and ${s.slots - p.slots} slot${s.slots - p.slots === 1 ? '' : 's'} are left over because nothing else passes the checks at that size.</p>` : ''}${compare(s)}`;
  }

  // ---- Every option --------------------------------------------------------------
  const WORD = { pack: 'packing', unpack: 'unpacking', flip: 'plain flip' };
  /** Every open gap big enough to matter, sized for these settings. */
  const listable = s => GE.sized(opps, { cash: s.cash || Infinity, hours: s.hours }).filter(o => !s.hidden.has(o.key) && o.cap * o.profitNow >= MIN_ROUND);

  function renderList() {
    const s = settings(), f = state.filter;
    seg($('#filter'), [{ v: 'all', t: 'All' }, { v: 'pack', t: 'Packing' }, { v: 'unpack', t: 'Unpacking' }, { v: 'flip', t: 'Flips' }, { v: 'weak', t: 'Failed checks' }], state.filter,
      v => { state.filter = v; shown = 40; save(); renderList(); });
    const all = listable(s), on = Object.keys(WORD).filter(t => s.types[t]);
    let list, passing = 0, alsoFailed = 0;
    if (f === 'weak') list = all.filter(o => o.confidence === 0);
    else {
      // "All" follows the Include ticks; a kind's own tab shows that kind whatever is ticked.
      const scoped = all.filter(o => (f === 'all' ? s.types[o.type] : o.type === f));
      const pass = scoped.filter(o => o.confidence > 0), fail = scoped.filter(o => o.confidence === 0);
      // Looking at one kind, or with nothing passing, list what failed as well: an empty table hides that the gaps exist.
      const showFailed = f !== 'all' || on.length === 1 || !pass.length;
      list = showFailed ? pass.concat(fail) : pass;
      passing = pass.length; alsoFailed = showFailed ? fail.length : 0;
    }
    const picks = new Set(state.picks), sort = state.sort, col = COLS.find(c => c.k === sort.col) || COLS[6];
    list.forEach(o => {
      const failed = o.failed = o.confidence === 0;            // failed rows show today's gap, since nothing is counted for them
      o.low = !failed && o.roi < s.minRoi;
      o.fits = !failed && o.qty >= 1 && o.slots <= s.slots && !o.low;
      o.vol = Math.min(o.buyPerDay, o.sellPerDay);
      o.shownProfit = failed ? o.profitNow : o.profit;
      o.shownRoi = failed ? o.roiNow : o.roi;
      o.shownQty = o.fits ? o.qty : o.cap;
      o.shownTotal = failed ? o.cap * o.profitNow : o.fits ? o.total : o.capTotal;
      o.picked = picks.has(o.key);
    });
    // Ticked rows stay on top. The default order also keeps what fits you above what does not.
    const byDefault = col.k === 'total' && sort.dir === 'desc', dir = sort.dir === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      if (a.picked !== b.picked) return b.picked - a.picked;
      if (a.failed !== b.failed) return a.failed - b.failed;   // today's gap on a failed row is not comparable, so they go last
      if (byDefault) return (b.fits - a.fits) || (b.shownTotal * (b.confidence || 1) - a.shownTotal * (a.confidence || 1));
      const x = col.get(a), y = col.get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || b.shownTotal - a.shownTotal;
    });
    const max = Math.max(1, ...list.map(o => (o.fits ? o.total : 0)));
    const scope = f !== 'all' ? WORD[f] : on.length === 1 ? WORD[on[0]] : '';
    const failNote = !alsoFailed ? ''
      : passing ? `The ${alsoFailed} marked "failed the checks" at the bottom ${alsoFailed === 1 ? 'is' : 'are'} never put in the automatic plan. `
        : `No ${scope ? scope + ' ' : ''}option passes the checks right now. The ${alsoFailed === 1 ? 'one' : alsoFailed} below ${alsoFailed === 1 ? 'has' : 'have'} a gap at today's prices but failed a check, so ${alsoFailed === 1 ? 'it is' : 'they are'} never put in the automatic plan. Open one to see which check. `;
    $('#list-note').textContent = f === 'weak'
      ? 'These show a gap at today\'s prices but failed a check, so they are never put in your plan. In a three-week replay they lost money more than 4 times in 10, and lost overall. The figures here assume today\'s prices hold.'
      : failNote + `Tick options to build the plan from your own picks. Tap an option for its offers and evidence. Greyed options do not fit the cash, slots or minimum return you entered.`;
    const rows = list.slice(0, shown).map(o => {
      const need = o.failed && f !== 'weak' ? 'failed the checks' : o.slots > s.slots ? `needs ${o.slots} slots` : o.qty < 1 ? `needs ${fmt(o.unitCost)}` : o.low ? `below your ${state.minRoi}% minimum return` : '';
      const warn = o.flags.some(f => f.level === 'warn') ? '&nbsp;<span class="warnmark" title="Has a warning: open it to read why">⚠</span>' : '';
      const isOpen = open.has(o.key);
      return `<tr class="row${o.fits ? '' : ' dim'}${isOpen ? ' open' : ''}${o.picked ? ' picked' : ''}" data-act="toggle" data-key="${o.key}">
          <td class="tickcell" data-act="select" data-key="${o.key}"><input type="checkbox" ${o.picked ? 'checked' : ''} aria-label="Use ${esc(o.title)} in my plan"></td>
          <td class="namecol"><div class="name-cell"><button class="rowbtn" aria-expanded="${isOpen}"><span class="caret">${isOpen ? '▾' : '▸'}</span><span class="kind">${KIND[o.type]}</span>${esc(o.name)}${warn}</button>${need ? `<span class="why">${need}</span>` : ''}</div></td>
          <td class="r num" data-label="Slots">${o.slots}</td><td class="r num" data-label="Cost each">${fmt(o.unitCost)}</td><td class="r num" data-label="Profit each">${fmt(o.shownProfit)}</td><td class="r num" data-label="Return">${(o.shownRoi * 100).toFixed(1)}%</td>
          <td class="r num" data-label="Volume per day">${gp(o.vol)}<span class="sub">${fmt(o.vol * o.unitCost)} gp</span></td>
          <td class="r num" data-label="Quantity">${gp(o.shownQty)}</td>
          <td class="bar-cell" data-label="Profit this round"><div class="bar"><i style="width:${o.fits ? Math.max(1, (o.total / max) * 60) : 0}%"></i><span class="num">${fmt(o.shownTotal)}</span></div></td>
          <td class="gapcol" data-label="Gap confirmed">${dots(o)}</td></tr>${isOpen ? `<tr class="detail-row"><td class="detail" colspan="10"><div class="detail-inner">${steps(o, o.shownQty)}${flags(o)}${detail(o)}
          <div class="card-foot"><button class="link" data-act="hide" data-key="${o.key}">Hide this option</button></div></div></td></tr>` : ''}`;
    }).join('');
    const heads = COLS.map(c => {
      const on = c.k === col.k;
      return `<th class="${c.r ? 'r' : ''}"${on ? ` aria-sort="${sort.dir === 'desc' ? 'descending' : 'ascending'}"` : ''}><button class="th" data-act="sort" data-col="${c.k}" title="${esc(c.tip || 'Sort by ' + c.t.toLowerCase())}">${esc(c.t)}<span class="arrow">${on ? (sort.dir === 'desc' ? '▼' : '▲') : ''}</span></button></th>`;
    }).join('');
    const SORTS = [['total:desc', 'Most profit this round'], ['roi:desc', 'Highest return'], ['vol:desc', 'Highest volume'], ['profit:desc', 'Most profit each'], ['cost:asc', 'Cheapest each'], ['cost:desc', 'Most expensive each'], ['slots:asc', 'Fewest slots'], ['name:asc', 'Name, A to Z']];
    const curSort = sort.col + ':' + sort.dir, sel = $('#sortsel');
    sel.innerHTML = (SORTS.some(x => x[0] === curSort) ? SORTS : SORTS.concat([[curSort, `${col.t}, ${sort.dir === 'desc' ? 'high to low' : 'low to high'}`]]))
      .map(x => `<option value="${x[0]}"${x[0] === curSort ? ' selected' : ''}>${esc(x[1])}</option>`).join('');
    sel.onchange = () => { const [c, d] = sel.value.split(':'); state.sort = { col: c, dir: d }; shown = 40; save(); renderList(); };
    $('#opts').innerHTML = `<thead><tr><th><span class="pickhead">Pick</span></th>${heads}</tr></thead>
      <tbody>${rows || `<tr><td colspan="10" class="muted">${f === 'weak' ? 'Nothing has failed the checks right now.' : !on.length && f === 'all' ? 'Tick at least one kind of trade under Include.' : `No ${scope ? scope + ' ' : ''}gap worth a slot is open right now.`}</td></tr>`}</tbody>`;
    $('#more').innerHTML = list.length > shown ? `<button class="link" data-act="more">Show more (${list.length - shown} left)</button>` : '';
    const names = state.hidden.map(k => { const o = opps.find(x => x.key === k); return o ? `<button class="link" data-act="unhide" data-key="${k}">${esc(o.title)}</button>` : ''; }).filter(Boolean);
    $('#hidden').innerHTML = state.hidden.length ? `Hidden: ${names.join(', ') || state.hidden.length + ' not currently available'} · <button class="link" data-act="unhide-all">Show all again</button>` : '';
  }

  // ---- Price check ---------------------------------------------------------------
  function renderCheck() {
    if (!model) return;
    const q = $('#q').value.trim().toLowerCase(), sug = $('#suggest'), out = $('#check');
    if (picked === null) {
      const hits = q.length < 2 ? [] : [...model.items.values()].filter(i => i.name.toLowerCase().includes(q))
        .sort((a, b) => (b.name.toLowerCase() === q) - (a.name.toLowerCase() === q) || (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || (b.hv24 + b.lv24) * b.medHi - (a.hv24 + a.lv24) * a.medHi).slice(0, 12);
      sug.innerHTML = hits.map(i => `<button data-act="pick" data-id="${i.id}">${esc(i.name)}</button>`).join('');
      out.innerHTML = q.length >= 2 && !hits.length ? '<div class="empty">No traded item matches that name.</div>' : '';
      if (hits.length === 1 || (hits[0] && hits[0].name.toLowerCase() === q)) picked = hits[0].id; else return;
    }
    sug.innerHTML = '';
    const it = model.items.get(picked), c = GE.priceCheck(model, it);
    const paidEach = parsePrice($('#paid').value), qty = Math.max(1, parseInt($('#qty').value.replace(/\D/g, ''), 10) || 1);
    let mine = '';
    if (paidEach) {
      const be = GE.breakEven(paidEach), each = GE.net(c.sell) - paidEach, quick = GE.net(c.quickSell) - paidEach;
      mine = `<div class="facts"><span>Break-even sell price <b>${gp(be)}</b></span>
        <span>At the sell offer price <b>${signed(each)}</b> each${qty > 1 ? `, <b>${signed(each * qty)}</b> for ${gp(qty)}` : ''}</span>
        <span>Selling instantly <b>${signed(quick)}</b> each${qty > 1 ? `, <b>${signed(quick * qty)}</b> for ${gp(qty)}` : ''}</span></div>`;
    }
    const set = model.sets.find(s => s.id === it.id), inSets = model.sets.filter(s => s.parts.some(p => p.id === it.id));
    let setNote = '';
    if (set) {
      const parts = set.parts.map(p => ({ it: model.items.get(p.id), qty: p.qty }));
      const asPieces = parts.reduce((a, p) => a + p.qty * GE.net(GE.askPrice(p.it, model.now)), 0), asSet = GE.net(c.sell);
      setNote = `<ul class="flags"><li class="info">Sold as a set you keep ${gp(asSet)} after tax. Unpacked and sold as pieces at their sell offer prices you would keep ${gp(asPieces)}, which is ${asPieces > asSet ? gp(asPieces - asSet) + ' more' : gp(asSet - asPieces) + ' less'}.</li></ul>
        <table class="offers">${parts.map(p => `<tr><td class="act">Piece</td><td><button class="link" data-act="check" data-id="${p.it.id}">${esc(p.it.name)}</button></td><td class="num price">${gp(GE.askPrice(p.it, model.now))} each</td></tr>`).join('')}</table>`;
    } else if (inSets.length) {
      setNote = `<ul class="flags"><li class="info">Part of ${inSets.map(s => `<button class="link" data-act="check" data-id="${s.id}">${esc(s.name)}</button>`).join(', ')}.</li></ul>`;
    }
    const o = { chart: { a: { label: 'Buyers pay', days: it.dHi }, b: { label: 'Sellers accept', days: it.dLo } } };
    out.innerHTML = `<article class="card">
      <div class="card-head"><h3>${itemLink(it.id, it.name)}</h3><span class="small">last sale ${c.lastSoldAgo === null ? 'unknown' : ago(c.lastSoldAgo)}</span></div>
      <div class="big-prices">
        <div><b>${gp(c.sell)}</b><span>Sell offer: just under the cheapest recent seller</span></div>
        <div><b>${gp(c.quickSell)}</b><span>Sell right now: what buy offers are paying</span></div>
        <div><b>${gp(c.buy)}</b><span>Buy offer: just above where dumps have been filling</span></div>
        <div><b>${gp(c.buyNow)}</b><span>Buy right now: the going sell-offer price</span></div>
      </div>
      ${mine}
      <div class="facts"><span>Buyers paid <b>${gp(it.hiMin)}</b> to <b>${gp(it.hiMax)}</b> in the last 24 hours</span>
        <span>Bought per day <b>${gp(c.buysPerDay)}</b></span><span>Dumped per day <b>${gp(c.dumpsPerDay)}</b></span>
        <span>Buy limit <b>${it.limit === null ? 'not listed' : gp(it.limit)}</b></span></div>
      ${setNote}
      <div style="margin-top:14px;max-width:620px">${chart(o)}</div></article>`;
  }

  // "1.95m", "949k" or "949,000". Unlike cash, a bare number here is taken literally.
  function parsePrice(text) {
    const m = String(text || '').trim().toLowerCase().replace(/,|\s|gp/g, '').match(/^(\d*\.?\d+)([kmb]?)$/);
    if (!m) return 0;
    return Math.round(parseFloat(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1));
  }

  // ---- Render --------------------------------------------------------------------
  function render() {
    if (!model) return;
    $('#tip').hidden = true;
    status();
    const s = settings();
    $('#cash-read').textContent = s.cash ? `= ${gp(s.cash)} gp` : 'Type an amount like 46m or 800k';
    seg($('#slots'), [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ v: String(n), t: String(n) })), String(state.slots), v => { state.slots = +v; save(); render(); });
    seg($('#hours'), [4, 8, 12].map(n => ({ v: String(n), t: n + ' hours' })), String(state.hours), v => { state.hours = +v; save(); render(); });
    seg($('#minroi'), [5, 8, 12, 15].map(n => ({ v: String(n), t: n + '%' })), String(state.minRoi), v => { state.minRoi = +v; save(); render(); });
    renderPlan(s);
    renderList();
    if (state.tab === 'check' || picked !== null) renderCheck();
  }

  boot();
})();
