// ═══════════════════════════════════════════════════════════════════════════
//  Monte Carlo — a MODEL-BASED estimate built only from a completed backtest's
//  real trade ledger. It is NOT a forecast of future returns.
//
//  Method: bootstrap resampling (with replacement) of the observed per-trade
//  net P&L. For each of `iterations` runs we draw as many trades as were
//  actually closed, accumulate them on the starting capital and record the
//  terminal equity and the intra-run peak-to-trough drawdown.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

function histogram(values, bins) {
  if (!values.length) return [];
  const min = Math.min(...values), max = Math.max(...values);
  if (max === min) return [{ from: round(min), to: round(max), count: values.length }];
  const w = (max - min) / bins;
  const out = [];
  for (let i = 0; i < bins; i++) out.push({ from: round(min + i * w), to: round(min + (i + 1) * w), count: 0 });
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / w)));
    out[idx].count++;
  }
  return out;
}

function simulate({ trades, capital = 100000, iterations = 2000, seed = 12345 }) {
  const closed = (trades || []).filter((t) => t.status === 'closed');
  if (closed.length < 5) {
    return { ok: false, error: 'Monte Carlo needs at least 5 closed trades from a completed backtest.' };
  }
  const pnls = closed.map((t) => t.netPnl);
  const rs = closed.map((t) => t.rMultiple).filter((v) => v != null && isFinite(v));
  const iters = Math.min(20000, Math.max(200, Math.round(iterations) || 2000));
  const rnd = mulberry32(seed);
  const finals = [];
  const ddPcts = [];
  let ruinCount = 0;
  const ruinLevel = capital * 0.5;

  for (let it = 0; it < iters; it++) {
    let eq = capital, peak = capital, maxDd = 0;
    for (let k = 0; k < pnls.length; k++) {
      eq += pnls[Math.floor(rnd() * pnls.length)];
      if (eq > peak) peak = eq;
      const dd = peak - eq;
      if (dd > maxDd) maxDd = dd;
    }
    finals.push(eq);
    ddPcts.push(peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (eq <= ruinLevel) ruinCount++;
  }
  finals.sort((a, b) => a - b);
  ddPcts.sort((a, b) => a - b);
  const mean = finals.reduce((a, b) => a + b, 0) / finals.length;
  const meanR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;

  return {
    ok: true,
    iterations: iters,
    sampleSize: pnls.length,
    seed,
    capital,
    meanR: round(meanR, 3),
    meanFinal: round(mean),
    medianFinal: round(percentile(finals, 50)),
    p5Final: round(percentile(finals, 5)),
    p25Final: round(percentile(finals, 25)),
    p75Final: round(percentile(finals, 75)),
    p95Final: round(percentile(finals, 95)),
    worstFinal: round(finals[0]),
    bestFinal: round(finals[finals.length - 1]),
    probProfitPct: round((finals.filter((f) => f > capital).length / finals.length) * 100),
    medianMaxDdPct: round(percentile(ddPcts, 50)),
    p95MaxDdPct: round(percentile(ddPcts, 95)),
    worstMaxDdPct: round(ddPcts[ddPcts.length - 1]),
    ruinDefinition: 'terminal equity ≤ 50% of starting capital',
    ruinProbabilityPct: round((ruinCount / iters) * 100),
    histogram: histogram(finals, 20),
    assumptions: [
      'Bootstrap of the ACTUAL closed-trade net P&L; trades are drawn with replacement.',
      'Trade order is randomised, so this only shows how the same edge could have sequenced.',
      'Costs/slippage are already inside each historical trade P&L.',
      'This is a model-based estimate, not a prediction or a guarantee.',
    ],
  };
}

module.exports = { simulate };
