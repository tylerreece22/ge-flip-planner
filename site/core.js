/* Trade maths for the GE flip planner. No DOM here, so the same file runs in
   the browser (window.GE) and in Node for the tests (require('./core.js')).

   Vocabulary used throughout:
     hi  = instant-buy price: what impatient buyers pay. A SELL offer fills here.
     lo  = instant-sell price: what impatient sellers accept. A BUY offer fills here.
     lv  = how many were sold into buy offers (dumps); hv = how many were bought from sell offers.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Grand Exchange tax: 2% of the sale price, rounded down, capped at 5m, none under 50 gp.
  const tax = p => (p < 50 ? 0 : Math.min(Math.floor(p * 0.02), 5000000));
  const net = p => p - tax(p);
  function breakEven(paid) {
    let p = Math.ceil(paid / 0.98);
    while (net(p) < paid) p++;
    while (p > 1 && net(p - 1) >= paid) p--;
    return p;
  }

  // ---- Offer prices are rounded to a tidy step so they are easy to type in game.
  const step = p => (p >= 500000 ? 1000 : p >= 50000 ? 100 : p >= 5000 ? 10 : 1);
  const roundUp = p => { const s = step(p); return Math.ceil(p / s) * s; };
  const roundDown = p => { const s = step(p); return Math.floor(p / s) * s; };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  const FRESH = 3 * 3600;          // a "latest" trade older than this is ignored
  const SPIKE = 0.04;              // output price this far above its 7-day median counts as spiked
  const SHARE = 0.5;               // assume you capture half of the market's flow while your offer is best
  const MIN_PICK = 100000;         // a pick that cannot make this much in a round is not worth a slot
  const TIME_SHARE = 0.3;          // for time estimates only: in the replay, orders filled at about this share of the flow

  function median(a) {
    const s = a.filter(x => x > 0).sort((x, y) => x - y);
    if (!s.length) return 0;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }

  function makeItem(id, r) {
    return {
      id: +id, name: r.n, limit: r.l == null ? null : r.l,
      w: r.w.map(a => ({ lo: a[0], hi: a[1], lv: a[2], hv: a[3] })),
      medHi: r.m[0], medLo: r.m[1],
      hiMin: r.r[0], hiMax: r.r[1], loMin: r.r[2], loMax: r.r[3],
      lv24: r.v[0], hv24: r.v[1],
      dHi: r.d, dLo: r.e, lvDay: r.dv[0], hvDay: r.dv[1],
      hi: r.p[0], hiT: r.p[1], lo: r.p[2], loT: r.p[3],
      weekHi: median(r.d.slice(-7)), weekLo: median(r.e.slice(-7)),
    };
  }

  /** Turn data.json into a model. `now` is seconds since the epoch. */
  function load(data, now) {
    const items = new Map();
    for (const id in data.items) items.set(+id, makeItem(id, data.items[id]));
    return { generated: data.generated, now: now || data.generated, pricesAt: data.generated, live: false, items, sets: data.sets };
  }

  /** Overlay the API's live /latest response on top of the scraped data. */
  function applyLive(model, latest, now) {
    for (const id in latest) {
      const it = model.items.get(+id), l = latest[id];
      if (!it || !l) continue;
      if (l.high && l.highTime >= it.hiT) { it.hi = l.high; it.hiT = l.highTime; }
      if (l.low && l.lowTime >= it.loT) { it.lo = l.low; it.loT = l.lowTime; }
    }
    model.now = now; model.pricesAt = now; model.live = true;
  }

  // ---- Volume per day. The lower of "last 24 hours" and "7-day average" so one busy day does not flatter it.
  const dumpsPerDay = it => (it.lvDay > 0 ? Math.min(it.lv24, it.lvDay) : it.lv24);
  const buysPerDay = it => (it.hvDay > 0 ? Math.min(it.hv24, it.hvDay) : it.hv24);

  // ---- The three price rules -------------------------------------------------

  /** Buy-offer price: just above where sellers have actually been dumping over the last few hours. */
  function bidPrice(it, now) {
    let base = it.w[0].lv > 0 ? it.w[0].lo : it.w[1].lv > 0 ? it.w[1].lo : it.medLo;
    if (!base) return 0;
    if (it.lo && now - it.loT <= FRESH) {
      const l = clamp(it.lo, base * 0.97, base * 1.03);   // one odd trade cannot drag it far
      if (l > base) base = (base + l) / 2;                // dumps are rising: meet them halfway
    }
    return roundUp(base * 1.0015);
  }

  /** Sell-offer price: just under the cheapest current seller, never above the last 6 hours' median. */
  function askPrice(it, now) {
    let base = it.medHi || it.w[0].hi || it.w[1].hi;
    if (!base) return 0;
    if (it.hi && now - it.hiT <= FRESH) base = clamp(it.hi, base * 0.985, base);
    return roundDown(base * 0.9995);
  }

  /** Price that buys straight away: the going sell-offer price, used when unpacking a set. */
  function payPrice(it, now) {
    let base = it.medHi || it.w[0].hi || it.w[1].hi;
    if (!base) return 0;
    if (it.hi && now - it.hiT <= FRESH) base = clamp(it.hi, base * 0.99, base * 1.01);
    return roundUp(base);
  }

  /** What selling straight into buy offers pays. One freak trade cannot move it more than 10% off the recent median. */
  function quickSell(it, now) {
    const base = it.medLo || it.w[0].lo || it.w[1].lo || 0;
    if (it.lo && now - it.loT <= FRESH) return base ? Math.round(clamp(it.lo, base * 0.9, base * 1.03)) : it.lo;
    return base;
  }

  // ---- Opportunities ----------------------------------------------------------

  // What the three-week replay (scripts/backtest.js) showed, and the rules that follow from it:
  //   * Today's gap overstates what you keep. The lowest of today's gap, the gap in each recent time
  //     window and the gap at the 7-day price predicted the replay's result well, so that is "profit".
  //   * Under a 5% return on that measure, trades lost money on average: the price moves between
  //     buying and selling are as big as the margin. Nothing under FLOOR goes into a plan.
  //   * Packing sets kept its margin. Plain flips kept about 60% of it and unpacking about half, on few
  //     cases, so they are weighted down when the plan chooses between options.
  const FLOOR = 0.05;
  const TYPE_WEIGHT = { pack: 1, flip: 0.6, unpack: 0.5 };

  function grade(o) {
    const ws = o.windows, seen = ws.filter(x => x !== null);
    o.pos = ws.filter(x => x !== null && x > 0).length;
    o.neg = ws.filter(x => x !== null && x <= 0).length;
    o.profitNow = o.profit;                                           // at the offer prices shown, right now
    o.profit = Math.max(0, Math.min(o.profitNow, o.fade, ...seen));   // the conservative figure everything else uses
    o.roi = o.unitCost ? o.profit / o.unitCost : 0;
    o.roiNow = o.unitCost ? o.profitNow / o.unitCost : 0;
    o.flags = [];
    let conf = TYPE_WEIGHT[o.type];
    if (o.pos === 3) { /* solid */ }
    else if (o.pos === 2 && o.neg === 0) { conf *= 0.8; o.flags.push({ level: 'info', text: 'Too few trades in one of the three time windows to confirm the gap there.' }); }
    else { conf = 0; o.flags.push({ level: 'warn', text: 'The gap does not show up consistently across the last 24 hours. Likely a one-off trade.' }); }
    if (o.fade <= 0) {
      conf = 0;
      o.flags.push({ level: 'warn', text: `At the 7-day price this would ${o.fade < 0 ? 'lose about ' + fmt(-o.fade) + ' each' : 'make nothing'}, so the gap depends on a price that has just moved. In the replay these lost money about a third of the time.` });
    } else if (o.trend > SPIKE) {
      o.flags.push({ level: 'info', text: `${o.outputLabel} ${o.outputPlural ? 'are' : 'is'} ${(o.trend * 100).toFixed(0)}% above the 7-day price. The profit shown already assumes that fades.` });
    } else if (o.trend < -SPIKE) {
      o.flags.push({ level: 'info', text: `${o.outputLabel} ${o.outputPlural ? 'have' : 'has'} dropped ${(Math.abs(o.trend) * 100).toFixed(0)}% against the 7-day price. Sell the same day and do not stockpile.` });
    }
    if (conf > 0 && o.roi < FLOOR) {
      conf = 0;
      o.flags.push({ level: 'warn', text: `Returns ${(o.roi * 100).toFixed(1)}% once prices slipping back is allowed for, under the 5% floor. In the replay, margins this thin lost money on average.` });
    }
    if (o.roiNow > 0.4) o.flags.push({ level: 'info', text: 'Very wide gap, which usually means a tiny market. Check the prices in game before committing.' });
    if (o.type === 'unpack') o.flags.push({ level: 'info', text: 'Unpacking has few past cases to check against, and those did worse than packing. Treat the figure as less certain.' });
    if (o.limit === null) o.flags.push({ level: 'info', text: 'No buy limit is listed for this. If an offer stops filling at a fixed number, that is the limit.' });
    if (o.profit <= 0) conf = 0;
    o.confidence = conf;
    return o;
  }

  function packOpp(model, set) {
    const now = model.now, S = model.items.get(set.id);
    const parts = set.parts.map(p => ({ it: model.items.get(p.id), qty: p.qty }));
    if (!S || parts.some(p => !p.it)) return null;
    const buys = parts.map(p => ({ id: p.it.id, name: p.it.name, per: p.qty, price: bidPrice(p.it, now) }));
    const ask = askPrice(S, now);
    if (!ask || buys.some(b => !b.price)) return null;
    const unitCost = buys.reduce((a, b) => a + b.per * b.price, 0);
    const windows = [0, 1, 2].map(i => (S.w[i].hv > 0 && parts.every(p => p.it.w[i].lv > 0)
      ? net(S.w[i].hi) - parts.reduce((a, p) => a + p.qty * p.it.w[i].lo, 0) : null));
    const limits = parts.map(p => (p.it.limit === null ? null : Math.floor(p.it.limit / p.qty)));
    return grade({
      key: 'pack:' + set.id, type: 'pack', name: set.name, title: 'Pack ' + set.name,
      ids: [set.id, ...parts.map(p => p.it.id)], slots: parts.length,
      buys, sells: [{ id: S.id, name: S.name, per: 1, price: ask }],
      unitCost, profit: net(ask) - unitCost, breakEven: breakEven(unitCost), windows,
      buyPerDay: Math.min(...parts.map(p => dumpsPerDay(p.it) / p.qty)), sellPerDay: buysPerDay(S),
      limit: limits.includes(null) ? null : Math.min(...limits),
      trend: S.weekHi ? ask / S.weekHi - 1 : 0, fade: S.weekHi ? net(S.weekHi) - unitCost : 0,
      quick: net(quickSell(S, now)) - unitCost,
      outputLabel: 'The set', outputPlural: false,
      chart: { a: { label: 'Set sells for', days: S.dHi }, b: { label: 'Pieces cost', days: sumDays(parts, 'dLo') } },
    });
  }

  function unpackOpp(model, set) {
    const now = model.now, S = model.items.get(set.id);
    const parts = set.parts.map(p => ({ it: model.items.get(p.id), qty: p.qty }));
    if (!S || parts.some(p => !p.it)) return null;
    const pay = payPrice(S, now);
    const sells = parts.map(p => ({ id: p.it.id, name: p.it.name, per: p.qty, price: askPrice(p.it, now) }));
    if (!pay || sells.some(s => !s.price)) return null;
    const revenue = sells.reduce((a, s) => a + s.per * net(s.price), 0);
    const windows = [0, 1, 2].map(i => (S.w[i].hv > 0 && parts.every(p => p.it.w[i].hv > 0)
      ? parts.reduce((a, p) => a + p.qty * net(p.it.w[i].hi), 0) - S.w[i].hi : null));
    const weekRev = parts.reduce((a, p) => a + p.qty * net(p.it.weekHi), 0);
    const weekGross = parts.reduce((a, p) => a + p.qty * p.it.weekHi, 0);
    const gross = sells.reduce((a, s) => a + s.per * s.price, 0);
    const haveWeek = parts.every(p => p.it.weekHi > 0);
    return grade({
      key: 'unpack:' + set.id, type: 'unpack', name: set.name, title: 'Unpack ' + set.name,
      ids: [set.id, ...parts.map(p => p.it.id)], slots: 1,
      buys: [{ id: S.id, name: S.name, per: 1, price: pay }], sells,
      unitCost: pay, profit: revenue - pay, breakEven: null, windows,
      buyPerDay: S.lv24 + S.hv24, sellPerDay: Math.min(...parts.map(p => buysPerDay(p.it) / p.qty)),
      limit: S.limit,
      trend: haveWeek ? gross / weekGross - 1 : 0, fade: haveWeek ? weekRev - pay : 0,
      quick: parts.reduce((a, p) => a + p.qty * net(quickSell(p.it, now)), 0) - pay,
      outputLabel: 'The pieces', outputPlural: true,
      chart: { a: { label: 'Pieces sell for', days: sumDays(parts, 'dHi') }, b: { label: 'Set costs', days: S.dHi } },
    });
  }

  function flipOpp(model, it) {
    const now = model.now;
    if (it.w.some(w => !w.lv || !w.hv)) return null;
    const bid = bidPrice(it, now), ask = askPrice(it, now);
    if (!bid || !ask || net(ask) <= bid) return null;
    const o = grade({
      key: 'flip:' + it.id, type: 'flip', name: it.name, title: 'Flip ' + it.name,
      ids: [it.id], slots: 1,
      buys: [{ id: it.id, name: it.name, per: 1, price: bid }], sells: [{ id: it.id, name: it.name, per: 1, price: ask }],
      unitCost: bid, profit: net(ask) - bid, breakEven: breakEven(bid),
      windows: it.w.map(w => net(w.hi) - w.lo),
      buyPerDay: dumpsPerDay(it), sellPerDay: buysPerDay(it), limit: it.limit,
      trend: it.weekHi ? ask / it.weekHi - 1 : 0, fade: it.weekHi ? net(it.weekHi) - bid : 0,
      quick: net(quickSell(it, now)) - bid,
      outputLabel: 'The price', outputPlural: false,
      chart: { a: { label: 'Buyers pay', days: it.dHi }, b: { label: 'Sellers accept', days: it.dLo } },
    });
    // A plain flip has no structural edge, so it must be calm: not moving against its week or within the day.
    const dayMove = it.w[2].hi ? it.w[0].hi / it.w[2].hi - 1 : 0;
    if (Math.abs(o.trend) > 0.05 || Math.abs(dayMove) > 0.03) {
      o.confidence = 0;
      o.flags.unshift({ level: 'warn', text: 'The price is moving (more than 5% against its week or 3% within the day), so this is a bet on direction, not a flip.' });
    }
    return o;
  }

  function sumDays(parts, key) {
    const n = parts[0].it[key].length, out = [];
    for (let i = 0; i < n; i++) out.push(parts.every(p => p.it[key][i] > 0) ? parts.reduce((a, p) => a + p.qty * p.it[key][i], 0) : 0);
    return out;
  }

  const EXCLUDE_FLIP = new Set([13190]);   // Old school bond: untradeable once bought
  // Plain flips are held to a higher bar than sets, because nothing structural protects the margin:
  // a known buy limit, a price worth a slot, and at least two trades an hour on each side.
  const FLIP_MIN_PRICE = 100000, FLIP_MIN_PER_DAY = 48;

  /** Every opportunity the data supports, unsized. */
  function opportunities(model) {
    const out = [];
    for (const s of model.sets) {
      const a = packOpp(model, s), b = unpackOpp(model, s);
      if (a && a.profitNow > 0) out.push(a);
      if (b && b.profitNow > 0) out.push(b);
    }
    for (const it of model.items.values()) {
      if (EXCLUDE_FLIP.has(it.id) || it.limit === null || it.medLo < FLIP_MIN_PRICE) continue;
      if (Math.min(dumpsPerDay(it), buysPerDay(it)) < FLIP_MIN_PER_DAY) continue;
      const f = flipOpp(model, it);
      if (f) out.push(f);
    }
    return out;
  }

  /** How many to do in one round: bounded by the buy limit and by a share of what the market trades
      between check-ins, so both the buy and the sell can finish before you next look. */
  function sizeFor(o, hours) {
    const frac = (hours / 24) * SHARE;
    let cap = Math.floor(Math.min(o.buyPerDay, o.sellPerDay) * frac);
    // The buy limit resets every 4 hours and an offer keeps filling after the reset,
    // so a longer gap between check-ins can absorb more than one limit's worth.
    if (o.limit !== null) cap = Math.min(cap, o.limit * Math.max(1, Math.floor(hours / 4)));
    return Math.max(0, cap);
  }
  const hoursToFill = (qty, perDay) => (perDay > 0 ? qty / ((perDay / 24) * TIME_SHARE) : Infinity);

  /** Size each opportunity for this player and keep the ones worth showing. */
  function sized(opps, { cash, hours }) {
    return opps.map(o => {
      const cap = sizeFor(o, hours);
      const qty = Math.min(cap, Math.floor(cash / o.unitCost));
      return Object.assign({}, o, {
        cap, qty, cost: qty * o.unitCost, total: qty * o.profit, expected: qty * o.profit * o.confidence,
        capTotal: cap * o.profit,
        buyHours: hoursToFill(qty || cap, o.buyPerDay), sellHours: hoursToFill(qty || cap, o.sellPerDay),
      });
    }).filter(o => o.cap >= 1);
  }

  /** Best combination for the cash and slots: maximise expected profit, never using one item twice.
      `minRoi` is the lowest return per trade (profit / cost, after tax) allowed into the plan, e.g. 0.08.
      It keeps cash out of big low-margin trades that only win on size.
      There is deliberately no "use the most cash" goal: tested on live data it gave up most of the profit
      just to have more gp tied up (10m, 4 slots: 9.9m working for 195k, against 6.3m working for 1.34m).
      Idle cash is controlled by lowering `minRoi` or lengthening `hours`, both of which raise profit. */
  function plan(opps, { cash, slots, hours, types, hidden, minRoi }) {
    const worth = o => o.profit * o.confidence;
    const allow = o => o.confidence > 0 && o.roi >= Math.max(FLOOR, minRoi || 0) && (!types || types[o.type]) && !(hidden && hidden.has(o.key)) && o.slots <= slots;
    let pool = sized(opps.filter(allow), { cash: Infinity, hours }).filter(o => o.unitCost <= cash);
    pool.forEach(o => { o.perSlot = (Math.min(o.cap, Math.floor(cash / o.unitCost)) * worth(o)) / o.slots; });
    pool = pool.filter(o => o.perSlot > 0).sort((a, b) => b.perSlot - a.perSlot).slice(0, 40);
    const bound = pool.map((_, i) => Math.max(0, ...pool.slice(i).map(o => o.perSlot)));
    const minPick = MIN_PICK;
    let best = { expected: 0, picks: [] }, nodes = 0;
    (function rec(i, cashLeft, slotsLeft, picks, expected, used) {
      if (expected > best.expected) best = { expected, picks: picks.slice() };
      if (i >= pool.length || slotsLeft === 0 || ++nodes > 400000) return;
      if (expected + slotsLeft * bound[i] <= best.expected) return;
      for (let j = i; j < pool.length; j++) {
        const o = pool[j];
        if (o.slots > slotsLeft || o.ids.some(id => used.has(id))) continue;
        const qty = Math.min(o.cap, Math.floor(cashLeft / o.unitCost));
        if (qty < 1 || qty * o.profit < minPick) continue;    // not worth a slot
        o.ids.forEach(id => used.add(id));
        picks.push({ o, qty });
        rec(j + 1, cashLeft - qty * o.unitCost, slotsLeft - o.slots, picks, expected + qty * worth(o), used);
        picks.pop();
        o.ids.forEach(id => used.delete(id));
      }
    })(0, cash, slots, [], 0, new Set());
    const picks = best.picks.map(({ o, qty }) => Object.assign({}, o, {
      qty, cost: qty * o.unitCost, total: qty * o.profit, expected: qty * o.profit * o.confidence,
      buyHours: hoursToFill(qty, o.buyPerDay), sellHours: hoursToFill(qty, o.sellPerDay),
    })).sort((a, b) => b.total - a.total);
    return {
      picks,
      cost: picks.reduce((a, p) => a + p.cost, 0), profit: picks.reduce((a, p) => a + p.total, 0),
      slots: picks.reduce((a, p) => a + p.slots, 0),
    };
  }

  /** A plan built from options the player ticked themselves. Every tick is honoured where it can be:
      cash goes to the highest return first, and each is sized by the same volume and buy-limit caps
      as the automatic plan. `unfunded` lists ticks that got nothing, `missing` ticks whose gap has gone. */
  function pickPlan(opps, keys, { cash, hours }) {
    const byKey = new Map(opps.map(o => [o.key, o]));
    const chosen = keys.map(k => byKey.get(k)).filter(Boolean).sort((a, b) => b.roi - a.roi);
    let left = cash;
    const picks = [], unfunded = [];
    for (const o of chosen) {
      const cap = sizeFor(o, hours), qty = Math.min(cap, Math.floor(left / o.unitCost));
      if (qty < 1) { unfunded.push({ o, reason: cap < 1 ? 'thin' : 'cash' }); continue; }
      left -= qty * o.unitCost;
      picks.push(Object.assign({}, o, {
        qty, cost: qty * o.unitCost, total: qty * o.profit, expected: qty * o.profit * o.confidence,
        buyHours: hoursToFill(qty, o.buyPerDay), sellHours: hoursToFill(qty, o.sellPerDay),
      }));
    }
    // A pick that failed the checks has a conservative profit of zero, so it adds cost but no expected profit.
    return {
      picks, unfunded, missing: keys.filter(k => !byKey.has(k)),
      cost: picks.reduce((a, p) => a + p.cost, 0), profit: picks.reduce((a, p) => a + p.total, 0),
      slots: picks.reduce((a, p) => a + p.slots, 0),
    };
  }

  /** Everything the price-check tab shows for one item. */
  function priceCheck(model, it) {
    const now = model.now;
    return {
      sell: askPrice(it, now), quickSell: quickSell(it, now), buy: bidPrice(it, now), buyNow: payPrice(it, now),
      lastSoldAgo: it.hiT ? now - it.hiT : null, dumpsPerDay: dumpsPerDay(it), buysPerDay: buysPerDay(it),
    };
  }

  // ---- Formatting ---------------------------------------------------------------
  function fmt(n) {
    if (n === null || n === undefined || !isFinite(n)) return '–';
    const a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'b';
    if (a >= 1e7) return s + (a / 1e6).toFixed(1) + 'm';
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'm';
    if (a >= 1e4) return s + Math.round(a / 1e3) + 'k';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'k';
    return s + Math.round(a);
  }
  const gp = n => (n === null || n === undefined || !isFinite(n) ? '–' : Math.round(n).toLocaleString('en-US'));

  /** "46m", "1.2b", "800k", "46,000,000". A bare number under 100,000 is read as millions. */
  function parseCash(text) {
    const m = String(text || '').trim().toLowerCase().replace(/,|\s|gp/g, '').match(/^(\d*\.?\d+)([kmb]?)$/);
    if (!m) return null;
    const x = parseFloat(m[1]);
    const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : x < 100000 ? 1e6 : 1;
    return Math.round(x * mult);
  }

  return { FLOOR, tax, net, breakEven, load, applyLive, opportunities, sized, plan, pickPlan, priceCheck, bidPrice, askPrice, payPrice, quickSell, fmt, gp, parseCash, median };
});
