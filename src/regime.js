// ═══════════════════════════════════════════════════════════════════════════
//  Market-regime classifier — deterministic, documented rules.
//
//  Inputs: daily candles + precomputed context (ADX, ATR%, Bollinger width,
//  structure trend, MTF alignment). Every classification ships the metrics AND
//  the thresholds behind it. When inputs are insufficient it returns
//  { state: 'INSUFFICIENT_DATA' } instead of guessing.
//
//  States: TRENDING_UP | TRENDING_DOWN | RANGE | HIGH_VOL | LOW_VOL |
//          BREAKOUT_WATCH | INSUFFICIENT_DATA
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const THRESHOLDS = {
  adxTrend: 25,        // ADX >= 25 → trend strength sufficient
  adxStrong: 35,
  atrHighPct: 3.0,     // ATR as % of price >= 3 → high volatility (equity)
  atrLowPct: 1.2,      // ATR% <= 1.2 → low volatility
  bbWidePct: 8,        // Bollinger width% >= 8 → expanded
  bbSqueezePct: 3.5,   // Bollinger width% <= 3.5 → squeeze (breakout watch)
  minBars: 60,
};

function pct(v, d = 2) { return v == null || !isFinite(v) ? null : +Number(v).toFixed(d); }

function classify({ candles, adxNow, atrPctNow, bbWidthNow, bbWidthMedian, trend, mtfAlign } = {}) {
  const n = (candles || []).length;
  if (!n || n < THRESHOLDS.minBars || adxNow == null || atrPctNow == null || bbWidthNow == null) {
    return {
      state: 'INSUFFICIENT_DATA',
      metrics: { bars: n, adx: adxNow ?? null, atrPct: atrPctNow ?? null, bbWidthPct: bbWidthNow ?? null, trend: trend || null, mtf: mtfAlign || null },
      thresholds: { ...THRESHOLDS },
      note: `Need ≥${THRESHOLDS.minBars} daily bars plus ADX, ATR% and Bollinger width — have ${n} bars.`,
    };
  }
  const up = trend === 'UP' || mtfAlign === 'BULL';
  const down = trend === 'DOWN' || mtfAlign === 'BEAR';
  let state = 'RANGE';
  if (bbWidthNow <= THRESHOLDS.bbSqueezePct && adxNow < THRESHOLDS.adxTrend) state = 'BREAKOUT_WATCH';
  else if (atrPctNow >= THRESHOLDS.atrHighPct) state = 'HIGH_VOL';
  else if (adxNow >= THRESHOLDS.adxTrend && up) state = 'TRENDING_UP';
  else if (adxNow >= THRESHOLDS.adxTrend && down) state = 'TRENDING_DOWN';
  else if (atrPctNow <= THRESHOLDS.atrLowPct && adxNow < THRESHOLDS.adxTrend) state = 'LOW_VOL';

  const labels = {
    TRENDING_UP: `Trending up (ADX ${adxNow} ≥ ${THRESHOLDS.adxTrend}, structure/MTF bullish).`,
    TRENDING_DOWN: `Trending down (ADX ${adxNow} ≥ ${THRESHOLDS.adxTrend}, structure/MTF bearish).`,
    RANGE: `Range-bound (ADX ${adxNow} < ${THRESHOLDS.adxTrend} — no dominant trend).`,
    HIGH_VOL: `High volatility (ATR ${atrPctNow}% ≥ ${THRESHOLDS.atrHighPct}% — widen stops, cut size).`,
    LOW_VOL: `Low volatility compression (ATR ${atrPctNow}% ≤ ${THRESHOLDS.atrLowPct}%, ADX weak).`,
    BREAKOUT_WATCH: `Bollinger squeeze (width ${bbWidthNow}% ≤ ${THRESHOLDS.bbSqueezePct}%) with weak ADX — expansion often follows; direction NOT predicted.`,
  };
  return {
    state,
    metrics: { bars: n, adx: adxNow, atrPct: atrPctNow, bbWidthPct: bbWidthNow, bbWidthMedian: bbWidthMedian ?? null, trend: trend || null, mtf: mtfAlign || null },
    thresholds: { ...THRESHOLDS },
    note: labels[state],
  };
}

module.exports = { classify, THRESHOLDS };
