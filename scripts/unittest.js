/* Deterministic unit tests — no network, no server. Verifies the analysis maths
 * (indicators, SMC rules, Black-Scholes, payoff, max pain, data-quality labels).
 *   node scripts/unittest.js
 */
const assert = require('assert');
const { sma, ema, rsi, atr, resample4h } = require('../src/indicators');
const strategy = require('../src/strategy');
const oa = require('../src/optionsAnalytics');
const dq = require('../src/dataquality');
const research = require('../src/research');
const costs = require('../src/costs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.log(`❌ ${name}\n     ${e.message}`); }
}
const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `expected ${b} ±${tol}, got ${a}`);

const c = (o, h, l, cl, v = 1, t = 0) => ({ o, h, l, c: cl, v, t });

// ── indicators ───────────────────────────────────────────────────────────
test('SMA(3) of 1..5 is 4 at the last index', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.strictEqual(out[4], 4); assert.strictEqual(out[1], null);
});
test('EMA seeds at SMA and reacts to the newest value', () => {
  const out = ema([1, 2, 3, 4, 5, 6], 3);
  assert.strictEqual(out[2], 2); assert.ok(out[5] > out[2]);
});
test('RSI(14) of a monotonic rise is 100', () => {
  const vals = Array.from({ length: 20 }, (_, i) => 100 + i);
  near(rsi(vals, 14)[19], 100, 0.001);
});
test('ATR(14) of flat 1-wide candles equals 1', () => {
  const candles = Array.from({ length: 20 }, (_, i) => c(100, 101, 99, 100, 1, i));
  near(atr(candles, 14)[19], 2, 0.001); // TR = high-low = 2
});
test('resample4h buckets 1H candles into 4H bars', () => {
  const hourly = [
    c(1, 2, 1, 1, 1, Date.UTC(2025, 0, 2, 4)),
    c(1, 2, 1, 1, 1, Date.UTC(2025, 0, 2, 5)),
    c(1, 3, 1, 2, 1, Date.UTC(2025, 0, 2, 6)),
    c(2, 4, 2, 3, 1, Date.UTC(2025, 0, 2, 8)),
  ];
  const r = resample4h(hourly);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].h, 3); assert.strictEqual(r[0].v, 3);
});

// ── SMC: structure, FVG, liquidity ───────────────────────────────────────
test('marketStructure emits BOS (bull) then CHoCH (bear)', () => {
  const t = (i) => Date.UTC(2025, 0, 2 + i);
  const closes = [95, 96, 97, 101, 98, 92, 89, 88];
  const candles = closes.map((cl, i) => c(cl, cl + 1, cl - 1, cl, 1, t(i)));
  const swings = { highs: [{ idx: 2, t: t(2), price: 100 }], lows: [{ idx: 5, t: t(5), price: 90 }] };
  const st = strategy.marketStructure(candles, 1, swings);
  assert.strictEqual(st.lastBOS.type, 'BOS');
  assert.strictEqual(st.lastBOS.dir, 'BULL');
  assert.strictEqual(st.lastCHoCH.type, 'CHoCH');
  assert.strictEqual(st.trend, 'DOWN');
});
test('fairValueGaps detects an unfilled bullish 3-candle imbalance', () => {
  const candles = [c(98, 100, 95, 99, 1, 0), c(99, 104, 99, 103, 1, 1), c(102, 105, 102, 104, 1, 2)];
  const gaps = strategy.fairValueGaps(candles);
  const bull = gaps.find((g) => g.dir === 'BULL');
  assert.ok(bull, 'expected a bullish FVG');
  assert.strictEqual(bull.bottom, 100); assert.strictEqual(bull.top, 102);
  assert.strictEqual(bull.filled, false);
});
test('liquidityPools clusters equal highs within ATR tolerance', () => {
  const candles = Array.from({ length: 6 }, (_, i) => c(100, 101, 99, 100, 1, i));
  const swings = { highs: [{ idx: 1, t: 1, price: 120 }, { idx: 4, t: 4, price: 120.4 }], lows: [] };
  const liq = strategy.liquidityPools(candles, swings, Array(6).fill(4), 0.25);
  assert.strictEqual(liq.buyside.length, 1);
  assert.strictEqual(liq.buyside[0].touches, 2);
});
test('premiumDiscount classifies price above equilibrium as PREMIUM', () => {
  const n = 5;
  const candles = Array.from({ length: n }, (_, i) => c(100, 116, 99, 100, 1, i));
  candles[n - 1].c = 115;
  const swings = { highs: [{ idx: 1, t: 1, price: 120 }], lows: [{ idx: 3, t: 3, price: 100 }] };
  const pd = strategy.premiumDiscount(candles, swings, 60);
  assert.strictEqual(pd.zone, 'PREMIUM'); assert.strictEqual(pd.equilibrium, 110);
});
test('displacement flags a large-body candle', () => {
  const candles = [c(100, 101, 99, 100, 1, 0), c(100, 111, 99.5, 110, 1, 1)];
  const d = strategy.displacement(candles, [4, 4], 1.5);
  assert.ok(d.last); assert.strictEqual(d.last.dir, 'BULL');
});
test('vwap of constant candles equals the typical price', () => {
  const t0 = Date.UTC(2025, 0, 2, 4);
  const candles = [c(100, 101, 99, 100, 10, t0), c(100, 101, 99, 100, 10, t0 + 3600000), c(100, 101, 99, 100, 10, t0 + 7200000)];
  const v = strategy.vwap(candles, 20);
  near(v.session, 100, 0.01);
});
test('swingStructure labels HH/HL for an uptrend', () => {
  const swings = {
    highs: [{ idx: 0, t: 1, price: 100 }, { idx: 4, t: 4, price: 110 }],
    lows: [{ idx: 2, t: 2, price: 90 }, { idx: 6, t: 6, price: 95 }],
  };
  const s = strategy.swingStructure(swings);
  assert.strictEqual(s.bias, 'UP');
  assert.ok(s.labels.includes('HH') && s.labels.includes('HL'));
});

// ── Black-Scholes & payoff ───────────────────────────────────────────────
test('Black-Scholes satisfies put-call parity', () => {
  const S = 100, K = 100, T = 1, sigma = 0.2, r = 0.065;
  const call = oa.bs({ S, K, T, sigma, r, type: 'CE' });
  const put = oa.bs({ S, K, T, sigma, r, type: 'PE' });
  near(call.price - put.price, S - K * Math.exp(-r * T), 0.05);
});
test('Greeks are in sane ranges', () => {
  const g = oa.bs({ S: 100, K: 100, T: 0.5, sigma: 0.25, type: 'CE' });
  assert.ok(g.delta > 0 && g.delta < 1, 'call delta in (0,1)');
  assert.ok(g.gamma > 0, 'gamma positive'); assert.ok(g.vega > 0, 'vega positive');
});
test('Long call payoff: max loss = premium, breakeven = strike + premium', () => {
  const p = oa.payoff([{ type: 'CE', strike: 100, qty: 1, premium: 5 }], { lotSize: 1 });
  assert.strictEqual(p.maxLoss, -5);
  assert.strictEqual(p.maxProfit, 'unlimited');
  assert.ok(p.breakevens.some((b) => Math.abs(b - 105) < 0.5), `breakevens ${p.breakevens}`);
});
test('Short put payoff: max profit = premium, limited max loss other side', () => {
  const p = oa.payoff([{ type: 'PE', strike: 100, qty: -1, premium: 4 }], { lotSize: 1 });
  assert.strictEqual(p.maxProfit, 4);
  assert.strictEqual(p.position.startsWith('CREDIT'), true);
});
test('Max pain settles at the strike minimising writer loss', () => {
  const strikes = [
    { strike: 100, ce: { oi: 100 }, pe: { oi: 0 } },
    { strike: 120, ce: { oi: 0 }, pe: { oi: 0 } },
  ];
  const mp = oa.maxPain(strikes);
  assert.strictEqual(mp.strike, 100);
});
test('expiryTs parses NSE "DD-Mon-YYYY"', () => {
  assert.strictEqual(oa.expiryTs('26-Dec-2025'), Date.UTC(2025, 11, 26, 10, 0, 0));
});

// ── Data quality ─────────────────────────────────────────────────────────
test('data-quality labels live vs delayed vs closed vs demo', () => {
  assert.strictEqual(dq.classify({ source: 'angelone', market: { state: 'OPEN' } }).status, 'LIVE');
  assert.strictEqual(dq.classify({ source: 'yahoo', market: { state: 'OPEN' } }).status, 'DELAYED');
  assert.strictEqual(dq.classify({ source: 'yahoo', market: { state: 'CLOSED' } }).status, 'CLOSED');
  assert.strictEqual(dq.classify({ source: 'demo', market: { state: 'OPEN' } }).status, 'DEMO');
});

// ── Research assistant ───────────────────────────────────────────────────
test('research.build produces evidence arrays without inventing a probability', () => {
  const a = {
    ok: true, price: 100, bars: 300,
    structure: { trend: 'UP', levels: { swingLow: { price: 90 }, swingHigh: { price: 120 } }, lastEvent: { type: 'BOS', dir: 'BULL', price: 110 } },
    mtf: { alignment: 'BULL', score: 40, bull: 3, bear: 0, timeframes: [{ tf: 'D', bias: 'UP' }, { tf: '4H', bias: 'UP' }] },
    premiumDiscount: { zone: 'DISCOUNT', positionPct: 0.4, equilibrium: 105, low: 90, high: 120 },
    lastSignal: { price: 99, confirmed: true, htfRsi: 45, reasons: ['wick'] },
    rsi4h: 45, rsiDaily: 60, volRatio: 1.3,
    vwap: { session: 98, aboveSession: true },
    fvgs: [{ dir: 'BULL', filled: false, bottom: 97, top: 101, t: 1 }],
    liquidity: { buyside: [{ level: 121, swept: false }], sellside: [{ level: 90, swept: true }] },
    displacement: { last: { dir: 'BULL', atrMult: 1.8 } },
    activeZones: [{ bottom: 95, top: 99 }],
    nearestFvg: { filled: false, top: 101 },
    stats: { trades: 12, winRate: 58, profitFactor: 1.6, avgTradePct: 1.2, maxDrawdownPct: 8 },
  };
  const r = research.build(a, { symbol: 'TEST' });
  assert.ok(r.ok); assert.ok(r.bullEvidence.length > 0);
  assert.strictEqual(r.probability.calibrated, false);
  assert.strictEqual(r.probability.historical.sampleSize, 12);
  assert.ok(r.levels.invalidation && r.levels.invalidation.price <= 100);
  assert.ok(typeof r.headline === 'string' && r.headline.length > 10);
});

// ── Trading cost model ───────────────────────────────────────────────────
test('cost model: round-trip cost is a sane fraction of notional', () => {
  const rt = costs.roundTrip({ entryPrice: 50000, exitPrice: 50000, qty: 1 });
  assert.ok(rt.costPct > 0.25 && rt.costPct < 0.7, `costPct ${rt.costPct}`);
  assert.ok(rt.breakdown.stt > 0 && rt.breakdown.slippage > 0 && rt.breakdown.gst > 0);
});
test('cost model: intraday has no STT on buy and no stamp on sell', () => {
  const buy = costs.sideCosts(100000, 'BUY', { mode: 'INTRADAY' });
  const sell = costs.sideCosts(100000, 'SELL', { mode: 'INTRADAY' });
  assert.strictEqual(buy.stt, 0);
  assert.strictEqual(sell.stamp, 0);
  assert.ok(sell.stt > 0);
});
test('cost model: delivery charges stamp on buy only', () => {
  const buy = costs.sideCosts(100000, 'BUY', { mode: 'DELIVERY' });
  const sell = costs.sideCosts(100000, 'SELL', { mode: 'DELIVERY' });
  assert.ok(buy.stamp > 0 && sell.stamp === 0);
});
test('cost model: breakeven % is positive', () => {
  assert.ok(costs.breakevenPct(1200) > 0);
});
test('analyze accepts useCosts + trainSplit and flags the cost model', () => {
  const candles = Array.from({ length: 260 }, (_, i) => c(100 + i, 101 + i, 99 + i, 100.5 + i, 1000, Date.UTC(2024, 0, 1 + i)));
  const a = strategy.analyze(candles, [], { useCosts: true, trainSplit: 0.7, costs: { mode: 'DELIVERY' } });
  assert.ok(a.ok, a.reason);
  assert.strictEqual(a.stats.costsApplied, true);
  assert.ok(a.stats.costModel && a.stats.costModel.mode === 'DELIVERY');
  assert.strictEqual(typeof a.stats.totalCostsPct, 'number');
});

// ── price alerts: pure matching + symbol normalisation ──────────────────
const priceAlerts = require('../src/priceAlerts');
test('price-alert symbols normalise to the right lookup form', () => {
  assert.strictEqual(priceAlerts.toLookup('reliance'), 'RELIANCE.NS');
  assert.strictEqual(priceAlerts.toLookup('TCS.NS'), 'TCS.NS');
  assert.strictEqual(priceAlerts.toLookup('^NSEI'), '^NSEI');
  assert.strictEqual(priceAlerts.normalizeSymbol('  infy '), 'INFY');
});
test('price-alert "above" fires only at or through the target', () => {
  const r = { condition: 'above', target: 100 };
  assert.strictEqual(priceAlerts.ruleMatches(r, 100), true);
  assert.strictEqual(priceAlerts.ruleMatches(r, 99.99), false);
  assert.strictEqual(priceAlerts.ruleMatches(r, 150), true);
});
test('price-alert "below" fires only at or through the target', () => {
  const r = { condition: 'below', target: 100 };
  assert.strictEqual(priceAlerts.ruleMatches(r, 100), true);
  assert.strictEqual(priceAlerts.ruleMatches(r, 100.01), false);
  assert.strictEqual(priceAlerts.ruleMatches(r, 40), true);
});
test('price-alert never fires on missing, zero or negative quotes', () => {
  assert.strictEqual(priceAlerts.ruleMatches({ condition: 'above', target: 10 }, null), false);
  assert.strictEqual(priceAlerts.ruleMatches({ condition: 'above', target: 10 }, undefined), false);
  assert.strictEqual(priceAlerts.ruleMatches({ condition: 'below', target: 10 }, 0), false);
  assert.strictEqual(priceAlerts.ruleMatches({ condition: 'below', target: 10 }, -5), false);
});

console.log(`\n${pass}/${pass + fail} unit checks passed`);
if (fail) { console.log('FAILED'); process.exit(1); }
console.log('ALL UNIT CHECKS PASSED ✅');
