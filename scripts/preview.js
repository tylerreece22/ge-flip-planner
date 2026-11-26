// Print what the site would recommend, straight from site/data.json.
//   node scripts/preview.js 36m 5 8 8    (cash, free slots, hours between check-ins, minimum return %)
const GE = require('../site/core.js');
const data = require('../site/data.json');
const [cashArg = '36m', slotsArg = '5', hoursArg = '8', minArg = '8'] = process.argv.slice(2);
const cash = GE.parseCash(cashArg), slots = +slotsArg, hours = +hoursArg, minRoi = +minArg / 100;
const model = GE.load(data);
const opps = GE.opportunities(model);
const list = GE.sized(opps, { cash: Infinity, hours });
const row = o => `${o.title.padEnd(42)} cost ${GE.fmt(o.unitCost).padStart(7)} profit ${GE.fmt(o.profit).padStart(6)} roi ${(o.roi * 100).toFixed(1).padStart(5)}% cap ${String(o.cap).padStart(4)} conf ${o.confidence.toFixed(2)} win ${o.windows.map(w => (w === null ? 'n/a' : GE.fmt(w))).join('/')} buy/day ${Math.round(o.buyPerDay)} sell/day ${Math.round(o.sellPerDay)} fade ${GE.fmt(o.fade)}`;
for (const t of ['pack', 'unpack', 'flip']) {
  const xs = list.filter(o => o.type === t && o.confidence > 0).sort((a, b) => b.capTotal * b.confidence - a.capTotal * a.confidence);
  console.log(`\n== ${t}: ${xs.length} usable (of ${list.filter(o => o.type === t).length})`);
  xs.slice(0, 14).forEach(o => console.log(row(o)));
}
const p = GE.plan(opps, { cash, slots, hours, minRoi });
console.log(`\n== PLAN for ${GE.gp(cash)} gp, ${slots} slots, checking every ${hours}h, minimum return ${minArg}%: cost ${GE.fmt(p.cost)}, profit ${GE.fmt(p.profit)}, slots ${p.slots}`);
for (const k of p.picks) {
  console.log(`${k.title} x${k.qty}: cost ${GE.fmt(k.cost)} profit ${GE.fmt(k.total)} return ${(k.roi * 100).toFixed(1)}% (~${k.buyHours.toFixed(1)}h to buy, ~${k.sellHours.toFixed(1)}h to sell)`);
  k.buys.forEach(b => console.log(`    BUY  ${b.name} x${k.qty * b.per} @ ${GE.gp(b.price)}`));
  k.sells.forEach(b => console.log(`    SELL ${b.name} x${k.qty * b.per} @ ${GE.gp(b.price)}`));
  k.flags.forEach(f => console.log(`    [${f.level}] ${f.text}`));
}
