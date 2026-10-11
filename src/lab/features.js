// ═══════════════════════════════════════════════════════════════════════════
//  Feature calculators for the strategy backtest engine.
//  Every array is CAUSAL: the value at bar i is computed ONLY from bars 0..i
//  (plus confirmation lags for pivots). The engine therefore cannot peek at
//  future candles — there is no look-ahead bias.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { sma, ema, rsi, atr } = require('../indicators');
const smc = require('../strategy');

// ── wick rejection (volume SMA over the configured period) ─────────────────
function wickBull(c, vA, o) {
  if (!c) return false;
  const body = Math.abs(c.c - c.o), range = c.h - c.l;
  if (range <= 0 || body <= 0) return false;
  const lowerWick = Math.min(c.o, c.c) - c.l;
  const closePos = (c.c - c.l) / range;
  if (c.c <= c.o) return false;
  if (lowerWick < (o.wickMult || 1.5) * body) return false;
  if (closePos < (o.closePct || 0.7)) return false;
  if (o.volMult && vA != null && c.v <= o.volMult * vA) return false;
  return true;
}
function wickBear(c, vA, o) {
  if (!c) return false;
  const body = Math.abs(c.c - c.o), range = c.h - c.l;
  if (range <= 0 || body <= 0) return false;
  const upperWick = c.h - Math.max(c.o, c.c);
  const closePos = (c.h - c.c) / range;
  if (c.c >= c.o) return false;
  if (upperWick < (o.wickMult || 1.5) * body) return false;
  if (closePos < (o.closePct || 0.7)) return false;
  if (o.volMult && vA != null && c.v <= o.volMult * vA) return false;
  return true;
}
function wickFlags(candles, o) {
  const vAvg = sma(candles.map((c) => c.v || 0), o.volPeriod || 20);
  const bull = [], bear = [];
  for (let i = 0; i < candles.length; i++) { bull[i] = wickBull(candles[i], vAvg[i], o); bear[i] = wickBear(candles[i], vAvg[i], o); }
  return { bull, bear };
}

// ── candle patterns ────────────────────────────────────────────────────────
function patternAt(candles, i, pattern, dir) {
  const c = candles[i], p = candles[i - 1];
  if (!c) return false;
  const body = Math.abs(c.c - c.o), range = c.h - c.l;
  if (pattern === 'engulfing') {
    if (!p) return false;
    const pBody = Math.abs(p.c - p.o);
    if (dir === 'bull') return c.c > c.o && p.c < p.o && c.c >= p.o && c.o <= p.c && body > pBody;
    return c.c < c.o && p.c > p.o && c.c <= p.o && c.o >= p.c && body > pBody;
  }
  if (body <= 0 || range <= 0) return false;
  const upper = c.h - Math.max(c.o, c.c), lower = Math.min(c.o, c.c) - c.l;
  if (pattern === 'hammer') return lower >= 2 * body && upper <= body;
  if (pattern === 'shooting_star') return upper >= 2 * body && lower <= body;
  if (pattern === 'doji') return body / range < 0.1;
  return false;
}

// ── order blocks (causal) ──────────────────────────────────────────────────
function buildOrderBlocks(candles, atrArr, o) {
  const bull = [], bear = [];
  const n = candles.length;
  let lastBearIdx = -1, lastBullIdx = -1;
  const maxGap = Math.max(2, Math.min(6, o.maxAge || 6));
  for (let i = 1; i < n; i++) {
    if (candles[i - 1].c < candles[i - 1].o) lastBearIdx = i - 1;
    if (candles[i - 1].c > candles[i - 1].o) lastBullIdx = i - 1;
    const a = atrArr[i] ?? atrArr[n - 1] ?? (candles[i].h - candles[i].l);
    const up = (candles[i].c - candles[i - 1].c) >= (o.impAtrMult || 2) * a && candles[i].c > candles[i - 1].c;
    const down = (candles[i - 1].c - candles[i].c) >= (o.impAtrMult || 2) * a && candles[i].c < candles[i - 1].c;
    if (up && lastBearIdx >= 0 && i - lastBearIdx <= maxGap && !bull.some((z) => z.anchorIdx === lastBearIdx)) {
      const b = candles[lastBearIdx];
      bull.push({ dir: 'bull', top: b.h, bottom: b.l, anchorIdx: lastBearIdx, createdIdx: i, mitigatedIdx: null });
    }
    if (down && lastBullIdx >= 0 && i - lastBullIdx <= maxGap && !bear.some((z) => z.anchorIdx === lastBullIdx)) {
      const b = candles[lastBullIdx];
      bear.push({ dir: 'bear', top: b.h, bottom: b.l, anchorIdx: lastBullIdx, createdIdx: i, mitigatedIdx: null });
    }
  }
  for (const z of bull) for (let k = z.createdIdx + 1; k < n; k++) if (candles[k].c < z.bottom) { z.mitigatedIdx = k; break; }
  for (const z of bear) for (let k = z.createdIdx + 1; k < n; k++) if (candles[k].c > z.top) { z.mitigatedIdx = k; break; }
  return { bull, bear };
}

function orderBlockFlags(candles, zones, o) {
  const maxAge = o.maxAge || 50;
  const requireUnmit = o.requireUnmitigated !== false;
  const bull = new Array(candles.length).fill(false);
  const bear = new Array(candles.length).fill(false);
  const apply = (arr, flagArr) => {
    for (const z of arr) {
      const end = Math.min(candles.length - 1, z.createdIdx + maxAge);
      for (let i = z.createdIdx; i <= end; i++) {
        if (requireUnmit && z.mitigatedIdx != null && z.mitigatedIdx <= i) continue;
        const c = candles[i];
        if (c.l <= z.top && c.h >= z.bottom) flagArr[i] = true;
      }
    }
  };
  apply(zones.bull, bull); apply(zones.bear, bear);
  return { bull, bear };
}

// ── unfilled FVG retest (causal) ───────────────────────────────────────────
function fvgFlags(candles) {
  const gaps = smc.fairValueGaps(candles);
  const bull = new Array(candles.length).fill(false);
  const bear = new Array(candles.length).fill(false);
  for (const g of gaps) {
    const flagArr = g.dir === 'BULL' ? bull : bear;
    for (let i = g.idx + 1; i < candles.length; i++) {
      if (g.filledIdx != null && i >= g.filledIdx) break;
      const c = candles[i];
      if (g.dir === 'BULL' ? (c.l <= g.top && c.h >= g.bottom) : (c.h >= g.bottom && c.l <= g.top)) flagArr[i] = true;
    }
  }
  return { bull, bear };
}

// ── liquidity sweep (causal) ───────────────────────────────────────────────
function sweepFlags(candles, lookback) {
  const n = candles.length;
  const sellside = new Array(n).fill(false);
  const buyside = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    const from = Math.max(0, i - lookback);
    let lo = Infinity, hi = -Infinity;
    for (let k = from; k < i; k++) { if (candles[k].l < lo) lo = candles[k].l; if (candles[k].h > hi) hi = candles[k].h; }
    const c = candles[i];
    if (isFinite(lo) && c.l < lo && c.c > lo) sellside[i] = true;
    if (isFinite(hi) && c.h > hi && c.c < hi) buyside[i] = true;
  }
  return { sellside, buyside };
}

// ── HTF mapping: for each exec bar, the index of the most recent COMPLETED
//    higher-timeframe bar (the next htf bar's start marks completion). ───────
function mapHtf(execCandles, htfCandles) {
  const n = execCandles.length, m = htfCandles.length;
  const idx = new Array(n).fill(-1);
  if (!m) return idx;
  const span = m >= 2 ? (htfCandles[m - 1].t - htfCandles[m - 2].t) : 86400000;
  const closeT = htfCandles.map((c, k) => (k + 1 < m ? htfCandles[k + 1].t : c.t + span));
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < m && closeT[k] <= execCandles[i].t) k++;
    idx[i] = k - 1;
  }
  return idx;
}

// RSI(14) and a causal trend label per higher-timeframe bar.
function htfSeries(htfCandles, swingLen) {
  const r = rsi(htfCandles.map((c) => c.c), 14);
  const st = smc.marketStructure(htfCandles, swingLen || 3);
  const trend = new Array(htfCandles.length).fill('RANGE');
  const events = st.events || [];
  let p = 0, cur = 'RANGE';
  for (let i = 0; i < htfCandles.length; i++) {
    while (p < events.length && events[p].idx <= i) { cur = events[p].dir === 'BULL' ? 'UP' : 'DOWN'; p++; }
    trend[i] = cur;
  }
  return { rsi: r, trend };
}

// ── bundle used by the engine (only what the spec references) ──────────────
function build(candles, spec) {
  const all = (spec.entry || []).concat(spec.filters || []);
  const needs = (fn) => all.some(fn);
  const rsiCache = new Map(), maCache = new Map(), atrCache = new Map();
  const closes = candles.map((c) => c.c);
  const getRsi = (len) => { const k = 'r' + len; if (!rsiCache.has(k)) rsiCache.set(k, rsi(closes, len)); return rsiCache.get(k); };
  const getMa = (type, len) => { const k = type + len; if (!maCache.has(k)) maCache.set(k, (type === 'sma' ? sma : ema)(closes, len)); return maCache.get(k); };
  const getAtr = (len) => { const k = 'a' + len; if (!atrCache.has(k)) atrCache.set(k, atr(candles, len)); return atrCache.get(k); };

  let wick = null, ob = null, fvg = null, sweeps = null, structure = null;
  if (needs((c) => c.kind === 'wick_rejection')) {
    const c = all.find((x) => x.kind === 'wick_rejection');
    wick = wickFlags(candles, { wickMult: c.wickMult, closePct: c.closePct, volMult: c.volMult, volPeriod: c.volPeriod });
  }
  if (needs((c) => c.kind === 'order_block')) {
    const c = all.find((x) => x.kind === 'order_block');
    const zones = buildOrderBlocks(candles, getAtr(c.atrPeriod || 14), c);
    ob = { flags: orderBlockFlags(candles, zones, c), zones };
  }
  if (needs((c) => c.kind === 'fvg')) fvg = fvgFlags(candles);
  if (needs((c) => c.kind === 'liquidity_sweep')) {
    const c = all.find((x) => x.kind === 'liquidity_sweep');
    sweeps = sweepFlags(candles, c.lookback || 20);
  }
  if (needs((c) => c.kind === 'bos' || c.kind === 'choch')) {
    const c = all.find((x) => x.kind === 'bos' || x.kind === 'choch');
    structure = smc.marketStructure(candles, c.swingLen || 3);
  }
  return { getRsi, getMa, getAtr, wick, ob, fvg, sweeps, structure };
}

module.exports = {
  build, wickFlags, wickBull, wickBear, patternAt, buildOrderBlocks, orderBlockFlags,
  fvgFlags, sweepFlags, mapHtf, htfSeries,
};
