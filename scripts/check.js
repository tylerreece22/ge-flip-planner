// Quick sanity checks for the trade maths:  node scripts/check.js
const G = require('../site/core.js');
const eq = (a, b, m) => { if (a !== b) { console.error('FAIL', m, 'got', a, 'expected', b); process.exit(1); } };
eq(G.tax(49), 0, 'no tax under 50 gp');
eq(G.tax(100), 2, 'tax on 100');
eq(G.tax(949000), 18980, 'tax on 949k');
eq(G.tax(4e8), 5e6, 'tax cap');
eq(G.net(3915000), 3836700, 'net of 3.915m');
eq(G.breakEven(814000), 830612, 'break-even for 814k');
eq(G.net(G.breakEven(814000)) >= 814000 && G.net(G.breakEven(814000) - 1) < 814000, true, 'break-even is the lowest price that covers cost');
eq(G.parseCash('46m'), 46e6, '46m');
eq(G.parseCash('1.2b'), 1.2e9, '1.2b');
eq(G.parseCash('800k'), 8e5, '800k');
eq(G.parseCash('46'), 46e6, 'bare number means millions');
eq(G.parseCash('46,000,000'), 46e6, 'commas');
eq(G.parseCash('abc'), null, 'nonsense');
console.log('core checks pass');
