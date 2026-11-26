// Replay the planner against what actually traded afterwards.
//
//   python3 scripts/fetch_history.py hist 21      (downloads ~3 weeks of hourly prices, a few minutes)
//   node scripts/backtest.js hist                 (prints the tables)
//   SHARE=0.25 node scripts/backtest.js hist      (same, assuming you only catch a quarter of the flow)
//
// For every 4 hours in the history it rebuilds the exact data the site would have had at that moment,
// asks site/core.js for its options and plans, then walks forward hour by hour:
//   * a buy offer fills in an hour only if that hour's average instant-sell price was at or below it,
//     and then only for SHARE of that hour's volume, within the 4-hour buy limit;
//   * you "check in" every H hours: pack or unpack what has filled and list it at the price the site
//     would show at that moment;
//   * a sell offer fills in an hour only if that hour's average instant-buy price was at or above it,
//     again for SHARE of the volume;
//   * unfilled buy offers are cancelled after 2 check-ins, and anything still unsold after 5 is dumped
//     at the instant-sell price, tax included.
// Realised profit is money in minus money out. Nothing here looks at prices from the future when deciding.
const fs = require('fs'), path = require('path');
const GE = require('../site/core.js');

const HIST = process.argv[2] || path.join(__dirname, '..', 'hist');
const SHARE = +(process.env.SHARE || 0.5);
const HOUR = 3600;
const read = f => JSON.parse(fs.readFileSync(path.join(HIST, f), 'utf8'));
const mapping = read('mapping.json');
const sets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sets.json'), 'utf8'));
const stamps = prefix => fs.readdirSync(HIST).filter(f => f.startsWith(prefix + '_')).map(f => +f.slice(prefix.length + 1, -5)).sort((a, b) => a - b);
const hourStamps = stamps('1h'), dayStamps = stamps('24h');

// Keep every set, every piece, and anything that could pass the plain-flip filter.
const keep = new Set();
sets.forEach(s => { keep.add(s.id); s.parts.forEach(p => keep.add(p.id)); });
const lastDayData = read(`24h_${dayStamps[dayStamps.length - 1]}.json`).data;
mapping.forEach(m => { const d = lastDayData[m.id]; if (m.limit != null && d && (d.avgHighPrice || 0) >= 80000) keep.add(m.id); });
const limitOf = new Map(mapping.map(m => [m.id, m.limit == null ? null : m.limit]));

function slim(file) {
  const d = read(file).data, m = new Map();
  for (const id of keep) { const x = d[id]; if (x) m.set(id, [x.avgHighPrice || 0, x.highPriceVolume || 0, x.avgLowPrice || 0, x.lowPriceVolume || 0]); }
  return m;
}
const H = new Map(hourStamps.map(t => [t, slim(`1h_${t}.json`)]));
const D = new Map(dayStamps.map(t => [t, slim(`24h_${t}.json`)]));

// ---- The same summary scripts/scrape.py writes, rebuilt for any past hour T ------------------
function vwap(bs, pi, vi) {
  let vol = 0, tot = 0;
  for (const b of bs) if (b) { vol += b[vi]; tot += b[pi] * b[vi]; }
  return vol ? [Math.round(tot / vol), vol] : [0, 0];
}
const med = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };

function snapshot(T) {
  const hs = []; for (let i = 1; i <= 24; i++) hs.push(H.get(T - i * HOUR));
  const lastDay = Math.floor(T / 86400) * 86400 - 86400, ds = [];
  for (let i = 9; i >= 0; i--) ds.push(D.get(lastDay - i * 86400));
  if (hs.some(x => !x) || ds.some(x => !x)) return null;
  const items = {};
  for (const m of mapping) {
    if (!keep.has(m.id)) continue;
    const b = hs.map(h => h.get(m.id));
    if (!b.some(Boolean)) continue;
    const w = [[0, 4], [4, 12], [12, 24]].map(([a, c]) => { const [lo, lv] = vwap(b.slice(a, c), 2, 3), [hi, hv] = vwap(b.slice(a, c), 0, 1); return [lo, hi, lv, hv]; });
    const his = b.filter(x => x && x[0]).map(x => x[0]), los = b.filter(x => x && x[2]).map(x => x[2]);
    const dd = ds.map(d => d.get(m.id)), week = dd.slice(-7);
    const ih = b.findIndex(x => x && x[0]), il = b.findIndex(x => x && x[2]);   // newest hour that traded
    items[m.id] = {
      n: m.name, l: m.limit == null ? null : m.limit, w,
      m: [med(his.slice(0, 6)), med(los.slice(0, 6))],
      r: [his.length ? Math.min(...his) : 0, his.length ? Math.max(...his) : 0, los.length ? Math.min(...los) : 0, los.length ? Math.max(...los) : 0],
      v: [b.reduce((a, x) => a + (x ? x[3] : 0), 0), b.reduce((a, x) => a + (x ? x[1] : 0), 0)],
      d: dd.map(x => (x ? x[0] : 0)), e: dd.map(x => (x ? x[2] : 0)),
      dv: [Math.round(week.reduce((a, x) => a + (x ? x[3] : 0), 0) / 7), Math.round(week.reduce((a, x) => a + (x ? x[1] : 0), 0) / 7)],
      p: [ih < 0 ? 0 : b[ih][0], ih < 0 ? 0 : T - ih * HOUR, il < 0 ? 0 : b[il][2], il < 0 ? 0 : T - il * HOUR],
    };
  }
  return { generated: T, items, sets: sets.filter(s => items[s.id] && s.parts.every(p => items[p.id])) };
}
const modelCache = new Map();
function modelAt(T) {
  if (!modelCache.has(T)) { const s = snapshot(T); modelCache.set(T, s ? GE.load(s, T) : null); }
  return modelCache.get(T);
}

// ---- One trade, walked forward hour by hour ---------------------------------------------------
// At each check-in the replay does what the site would tell you to do:
//   * moves any unfilled buy offer to the site's current buy price;
//   * packs or unpacks whatever has filled and lists it at the site's current sell price;
//   * at the second check-in, cancels what has not filled. For a set with some pieces ahead of others it
//     finishes the sets already started by buying the lagging pieces at the going price, but only if that
//     beats selling the spare pieces on their own. Spare pieces left after that are sold as pieces.
function simulate(o, qty, T, Hc) {
  const buyEnd = T + 2 * Hc * HOUR, completeEnd = T + 3 * Hc * HOUR, end = T + 5 * Hc * HOUR;
  if (!H.has(end - HOUR) || !modelAt(end)) return null;
  const buys = o.buys.map(b => ({ id: b.id, per: b.per, price: b.price, need: qty * b.per, want: qty * b.per, got: 0, lim: limitOf.get(b.id), win: null, winGot: 0, credit: 0, moved: 0, instant: o.type === 'unpack' }));
  const inv = new Map(), asks = new Map(), sellCredit = new Map();
  let cost = 0, revenue = 0, converted = 0, buyDoneAt = null, soldOutAt = null, dumped = 0, bought = null, slotHours = 0;
  const add = (id, n) => { if (n > 0) inv.set(id, (inv.get(id) || 0) + n); };

  function checkin(t) {
    const model = modelAt(t);
    if (model && t < buyEnd) for (const b of buys) {            // re-bid at the site's current price
      const it = model.items.get(b.id), p = it && (b.instant ? GE.payPrice(it, t) : GE.bidPrice(it, t));
      if (p && b.got < b.need) b.price = p;
    }
    if (t === buyEnd) {
      bought = Math.min(...buys.map(b => b.got / b.want));
      const counts = buys.map(b => Math.floor(b.got / b.per)), most = Math.max(...counts), S = model && o.type === 'pack' ? model.items.get(o.sells[0].id) : null;
      let finish = false;
      if (S && most > Math.min(...counts) && buys.every(b => model.items.get(b.id))) {
        let missing = 0, spare = 0;
        buys.forEach((b, i) => { const it = model.items.get(b.id); if (counts[i] < most) missing += GE.payPrice(it, t) * b.per; else spare += GE.net(GE.askPrice(it, t)) * b.per; });
        finish = GE.net(GE.askPrice(S, t)) - missing >= spare;
      }
      buys.forEach((b, i) => {
        if (finish && counts[i] < most) { b.need = most * b.per; b.instant = true; b.price = GE.payPrice(model.items.get(b.id), t); b.finishing = true; }
        else b.need = b.got;
      });
    }
    if (o.type === 'pack') {
      const made = Math.min(...buys.map(b => Math.floor(b.got / b.per))) - converted;
      add(o.sells[0].id, made); converted += made;
      if (t >= completeEnd) buys.forEach(b => { const left = b.got - converted * b.per - b.moved; add(b.id, left); b.moved += left; });   // spare pieces are sold on their own
    } else if (o.type === 'unpack') {
      const got = buys[0].got - converted;
      o.sells.forEach(s => add(s.id, got * s.per)); converted += got;
    } else { const got = buys[0].got - converted; add(o.buys[0].id, got); converted += got; }
    if (model) for (const [id, n] of inv) if (n > 0) { const it = model.items.get(id); if (it) { const a = GE.askPrice(it, t); if (a) asks.set(id, a); } }
  }

  for (let t = T; t < end; t += HOUR) {
    const hb = H.get(t);
    if (!hb) return null;
    if (t > T && (t - T) % (Hc * HOUR) === 0) checkin(t);
    // Slots in use this hour: every live buy offer, plus every item you have listed for sale.
    slotHours += buys.filter(b => b.got < b.need && (t < buyEnd || (b.finishing && t < completeEnd))).length + [...inv.values()].filter(n => n > 0).length;
    for (const b of buys) {
      if (b.got >= b.need || !(t < buyEnd || (b.finishing && t < completeEnd))) continue;
      const x = hb.get(b.id); if (!x) continue;
      let flow = 0;
      if (b.instant) { if (x[0] && x[0] <= b.price) flow += x[1]; if (x[2] && x[2] <= b.price) flow += x[3]; }   // paying the asking price
      else if (x[2] && x[2] <= b.price) flow = x[3];                                                           // sitting as a bid
      b.credit += flow * SHARE;
      let f = Math.min(b.need - b.got, Math.floor(b.credit));
      if (f > 0 && b.lim !== null) {
        if (b.win === null || t >= b.win + 4 * HOUR) { b.win = t; b.winGot = 0; }
        f = Math.min(f, b.lim - b.winGot); b.winGot += f;
      }
      if (f > 0) { b.got += f; b.credit -= f; cost += f * b.price; }
      if (flow === 0) b.credit = Math.min(b.credit, 1);
    }
    if (buyDoneAt === null && t < buyEnd && buys.every(b => b.got >= b.want)) buyDoneAt = t + HOUR - T;
    for (const [id, n] of inv) {
      if (n <= 0 || !asks.has(id)) continue;
      const x = hb.get(id), ask = asks.get(id);
      if (!x || !x[0] || x[0] < ask) continue;
      const c = (sellCredit.get(id) || 0) + x[1] * SHARE, f = Math.min(n, Math.floor(c));
      sellCredit.set(id, c - f);
      if (f > 0) { revenue += f * GE.net(ask); inv.set(id, n - f); }
    }
    if (soldOutAt === null && t >= buyEnd && converted > 0 && [...inv.values()].every(n => n === 0) && buys.every(b => b.got - b.moved <= converted * b.per)) soldOutAt = t + HOUR - T;
  }
  checkin(end);
  const model = modelAt(end);
  let stuck = 0;
  for (const [id, n] of inv) if (n > 0) {
    // Whatever is still unsold is valued at the instant-sell price; if nothing is trading, at 90% of the last known price.
    const it = model.items.get(id), q = it ? (GE.quickSell(it, end) || Math.round((it.weekLo || it.weekHi || asks.get(id) || 0) * 0.9)) : Math.round((asks.get(id) || 0) * 0.9);
    revenue += n * GE.net(q); dumped += n * GE.net(q); if (!it || !GE.quickSell(it, end)) stuck += n * GE.net(q);
  }
  return { predicted: qty * o.profit, realised: revenue - cost, cost, slotHours, bought: bought === null ? 0 : bought, dumped, stuck, buyHours: buyDoneAt === null ? null : buyDoneAt / HOUR, sellHours: soldOutAt === null ? null : soldOutAt / HOUR };
}

// ---- Run it -------------------------------------------------------------------------------
const first = hourStamps[0] + 24 * HOUR, last = hourStamps[hourStamps.length - 1] + HOUR;
const grid = []; for (let t = Math.ceil(first / (4 * HOUR)) * 4 * HOUR; t <= last; t += 4 * HOUR) grid.push(t);
const fmt = GE.fmt, pct = x => (x * 100).toFixed(0) + '%';
const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
const quant = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
function table(title, rows, groups) {
  console.log('\n' + title);
  console.log(pad('', 34) + lpad('trades', 7) + lpad('promised', 10) + lpad('realised', 10) + lpad('kept', 7) + lpad('lost $', 8) + lpad('worst', 9) + lpad('filled', 8) + lpad('dumped', 8));
  for (const [name, test] of groups) {
    const r = rows.filter(test); if (!r.length) continue;
    const p = r.reduce((a, x) => a + x.predicted, 0), z = r.reduce((a, x) => a + x.realised, 0);
    console.log(pad(name, 34) + lpad(r.length, 7) + lpad(fmt(p / r.length), 10) + lpad(fmt(z / r.length), 10) + lpad(pct(z / p), 7)
      + lpad(pct(r.filter(x => x.realised < 0).length / r.length), 8) + lpad(fmt(Math.min(...r.map(x => x.realised))), 9)
      + lpad(pct(r.reduce((a, x) => a + x.bought, 0) / r.length), 8) + lpad(pct(r.reduce((a, x) => a + x.dumped, 0) / Math.max(1, r.reduce((a, x) => a + x.cost, 0))), 8));
  }
}

console.log(`History: ${new Date(hourStamps[0] * 1000).toISOString().slice(0, 10)} to ${new Date(last * 1000).toISOString().slice(0, 10)}, ${grid.length} decision points, ${keep.size} items, share of flow assumed ${SHARE}`);
console.log('promised = profit the site would have shown; realised = what the replay made; kept = realised / promised;');
console.log('lost $ = share of trades that lost money; filled = share of the buy order that filled; dumped = share of cost that had to be sold at the instant price at the end.');

// 1) Every option on its own, at the size the site would suggest for an 8-hour check-in.
const each = [];
for (const T of grid) {
  const model = modelAt(T); if (!model) continue;
  for (const o of GE.sized(GE.opportunities(model), { cash: Infinity, hours: 8 })) {
    if (o.cap * o.profitNow < 50000) continue;
    const r = simulate(o, o.cap, T, 8); if (!r) continue;
    each.push(Object.assign(r, { type: o.type, roi: o.roi, conf: o.confidence, pos: o.pos, neg: o.neg, name: o.name, trend: o.trend, fade: o.fade, limit: o.limit, T,
      unit: o.unitCost, qty: o.cap, now: o.cap * o.profitNow, vol: Math.min(o.buyPerDay, o.sellPerDay), quick: o.quick, win: o.windows, slots: o.slots }));
  }
}
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(each));
if (process.env.ONLY_OPTIONS) process.exit(0);
const ok = x => x.conf > 0;
table('EVERY OPTION THAT PASSES THE CHECKS (8-hour check-in, suggested size)', each.filter(ok), [
  ['All', () => true], ['Packing sets', x => x.type === 'pack'], ['Unpacking sets', x => x.type === 'unpack'], ['Plain flips', x => x.type === 'flip'],
]);
table('BY RETURN THE SITE SHOWED (passing options)', each.filter(ok), [
  ['5% to 8%', x => x.roi >= 0.05 && x.roi < 0.08], ['8% to 12%', x => x.roi >= 0.08 && x.roi < 0.12],
  ['12% to 20%', x => x.roi >= 0.12 && x.roi < 0.2], ['20% to 40%', x => x.roi >= 0.2 && x.roi < 0.4], ['over 40% (flagged)', x => x.roi >= 0.4],
]);
table('BY WARNING', each, [
  ['Passed, no warning', x => x.conf === 1], ['Passed, gap in 2 of 3 windows', x => x.conf > 0 && x.pos === 2],
  ['Passed, spiked and fade loses', x => x.conf > 0 && x.trend > 0.04 && x.fade <= 0], ['Passed, spiked but fade still wins', x => x.conf > 0 && x.trend > 0.04 && x.fade > 0],
  ['Passed, output falling over 4%', x => x.conf > 0 && x.trend < -0.04],
  ['FAILED checks (never in a plan)', x => x.conf === 0], ['  failed: packing', x => x.conf === 0 && x.type === 'pack'], ['  failed: unpacking', x => x.conf === 0 && x.type === 'unpack'], ['  failed: flips', x => x.conf === 0 && x.type === 'flip'],
]);
const byName = new Map();
each.filter(ok).forEach(x => { const k = x.type + ' ' + x.name; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(x); });
const names = [...byName.entries()].map(([k, r]) => ({ k, n: r.length, p: r.reduce((a, x) => a + x.predicted, 0), z: r.reduce((a, x) => a + x.realised, 0), lose: r.filter(x => x.realised < 0).length / r.length })).filter(x => x.n >= 10);
console.log('\nBIGGEST EARNERS (passing, at least 10 appearances): total realised over the period, kept, share of rounds that lost');
names.sort((a, b) => b.z - a.z).slice(0, 15).forEach(x => console.log(pad(x.k, 40) + lpad(x.n, 5) + lpad(fmt(x.z), 9) + lpad(pct(x.z / x.p), 7) + lpad(pct(x.lose), 6)));
console.log('\nBIGGEST LOSERS (passing, at least 10 appearances)');
names.sort((a, b) => a.z - b.z).slice(0, 12).forEach(x => console.log(pad(x.k, 40) + lpad(x.n, 5) + lpad(fmt(x.z), 9) + lpad(pct(x.z / x.p), 7) + lpad(pct(x.lose), 6)));

// 2) Whole plans, across the settings on the page.
console.log('\nWHOLE PLANS: one plan every 4 hours, each replayed on its own');
console.log(pad('cash slots check-in min return', 34) + lpad('plans', 6) + lpad('spent', 9) + lpad('promised', 10) + lpad('realised', 10) + lpad('kept', 7) + lpad('lost $', 8) + lpad('worst', 9) + lpad('typical', 9) + lpad('return', 8));
for (const cash of [36e6, 95e6]) for (const slots of [2, 3, 5, 8]) for (const hours of [4, 8, 12]) for (const f of [5, 8, 12, 15]) {
  if ((slots === 2 && cash > 36e6) || (hours !== 8 && slots !== 5) || (slots === 3 && cash > 36e6)) continue;   // keep the table readable
  const rows = [];
  for (const T of grid) {
    const model = modelAt(T); if (!model) continue;
    const p = GE.plan(GE.opportunities(model), { cash, slots, hours, minRoi: f / 100 });
    if (!p.picks.length) { rows.push({ predicted: 0, realised: 0, cost: 0, empty: true }); continue; }
    let pr = 0, re = 0, co = 0, bad = false;
    for (const k of p.picks) { const r = simulate(k, k.qty, T, hours); if (!r) { bad = true; break; } pr += r.predicted; re += r.realised; co += r.cost; }
    if (!bad) rows.push({ predicted: pr, realised: re, cost: co });
  }
  const live = rows.filter(r => !r.empty); if (!live.length) continue;
  const P = live.reduce((a, r) => a + r.predicted, 0), Z = live.reduce((a, r) => a + r.realised, 0), C = live.reduce((a, r) => a + r.cost, 0);
  console.log(pad(`${fmt(cash)} ${slots} slots ${hours}h ${f ? f + '%' : 'Any'}`, 34) + lpad(live.length, 6) + lpad(fmt(C / live.length), 9) + lpad(fmt(P / live.length), 10) + lpad(fmt(Z / live.length), 10)
    + lpad(pct(Z / P), 7) + lpad(pct(live.filter(r => r.realised < 0).length / live.length), 8) + lpad(fmt(Math.min(...live.map(r => r.realised))), 9) + lpad(fmt(quant(live.map(r => r.realised), 0.5)), 9) + lpad((C ? (Z / C) * 100 : 0).toFixed(1) + '%', 8));
}

// 3) Are the time estimates honest?
const done = each.filter(x => ok(x) && x.buyHours !== null);
console.log(`\nFILL TIMES (passing options, 8-hour check-in): ${pct(done.length / each.filter(ok).length)} of buy orders filled completely within 16 hours; of those, half were done within ${quant(done.map(x => x.buyHours), 0.5)}h and 90% within ${quant(done.map(x => x.buyHours), 0.9)}h.`);
const sold = each.filter(x => ok(x) && x.sellHours !== null);
console.log(`${pct(sold.length / each.filter(ok).length)} bought and sold everything within 40 hours without dumping; half of those were finished within ${quant(sold.map(x => x.sellHours), 0.5)}h.`);
