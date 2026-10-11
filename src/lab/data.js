// ═══════════════════════════════════════════════════════════════════════════
//  Historical-data layer for the Strategy Lab.
//
//  REAL data only: candles come from the configured Yahoo Finance provider
//  (NSE ".NS" / BSE ".BO"). Nothing is generated, padded or interpolated.
//  Every fetch returns a coverage report; the caller refuses to backtest when
//  the verified data is insufficient.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const yahoo = require('../providers/yahoo');
const { resample4h } = require('../indicators');

// Yahoo interval → maximum lookback (days) it will return for that interval.
const MAX_LOOKBACK_DAYS = { '5m': 60, '15m': 60, '30m': 60, '1h': 730, '1d': 20000, '1wk': 20000 };
const INTERVAL_FOR = { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1d', '1w': '1wk' };
const RANGE_STEPS = [['5d', 5], ['1mo', 31], ['3mo', 92], ['6mo', 183], ['1y', 366], ['2y', 731], ['5y', 1826], ['10y', 3653], ['max', 1e9]];

function rangeFor(days) {
  for (const [r, d] of RANGE_STEPS) if (days <= d) return r;
  return 'max';
}

function yahooSymbol(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) return '';
  if (/\.(NS|BO)$/.test(s)) return s;
  return s + '.NS';
}

// Validate + normalise a raw candle array. Invalid candles are DROPPED (never
// repaired or interpolated), so a backtest can only use verified bars.
function clean(rawCandles) {
  const seen = new Set();
  const out = [];
  const rejected = [];
  for (const c of rawCandles || []) {
    if (!c || !isFinite(c.t) || !isFinite(c.o) || !isFinite(c.h) || !isFinite(c.l) || !isFinite(c.c)) { rejected.push(c); continue; }
    if (c.h < c.l || c.h < Math.max(c.o, c.c) - 1e-9 || c.l > Math.min(c.o, c.c) + 1e-9) { rejected.push(c); continue; }
    if (!(c.c > 0)) { rejected.push(c); continue; }
    if (seen.has(c.t)) { rejected.push(c); continue; }
    seen.add(c.t);
    out.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return { candles: out, rejected };
}

function coverage(candles, { interval, fromTs, toTs } = {}) {
  if (!candles.length) return { count: 0, firstTs: null, lastTs: null, warnings: ['No candles returned by the provider.'] };
  const firstTs = candles[0].t, lastTs = candles[candles.length - 1].t;
  const warnings = [];
  const days = MAX_LOOKBACK_DAYS[interval] || 20000;
  if (fromTs && firstTs > fromTs + 2 * 86400000) {
    const allowed = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    warnings.push(`Requested history starts ${new Date(fromTs).toISOString().slice(0, 10)} but ${interval} data is only available from ~${allowed} (provider limit ~${days} days).`);
  }
  if (toTs && lastTs < toTs - 2 * 86400000) {
    warnings.push(`Newest candle is ${new Date(lastTs).toISOString().slice(0, 10)}.`);
  }
  return { count: candles.length, firstTs, lastTs, requestedFrom: fromTs || null, requestedTo: toTs || null, interval, warnings };
}

// Fetch an execution series (already at the requested timeframe).
async function fetchSeries(symbol, timeframe, { fromTs = null, toTs = null } = {}) {
  const interval = INTERVAL_FOR[timeframe] || '1d';
  const sym = yahooSymbol(symbol);
  if (!sym) throw new Error('A symbol is required.');
  const days = fromTs ? Math.ceil((Date.now() - fromTs) / 86400000) : 366 * 3;
  const range = rangeFor(Math.min(days + 40, 1e9));
  let candles = [];
  let source = '';
  try {
    if (timeframe === '4h') {
      const h = await yahoo.fetchChart(sym, { interval: '1h', range });
      candles = resample4h(h.candles);
      source = 'Yahoo Finance 1h → 4h';
    } else {
      const r = await yahoo.fetchChart(sym, { interval, range });
      candles = r.candles;
      source = `Yahoo Finance ${interval}`;
    }
  } catch (e) {
    return { ok: false, error: `Provider error for ${sym}: ${e.message}`, symbol: sym };
  }
  const { candles: cleaned, rejected } = clean(candles);
  let sliced = cleaned;
  if (fromTs) sliced = sliced.filter((c) => c.t >= fromTs);
  if (toTs) sliced = sliced.filter((c) => c.t <= toTs);
  const cov = coverage(sliced, { interval: timeframe === '4h' ? '1h' : interval, fromTs, toTs });
  return { ok: true, symbol: sym, timeframe, source, candles: sliced, rejectedRaw: rejected.length, coverage: cov };
}

// Fetch a higher-timeframe series for confirmation (returns [] when the
// provider can't supply it, so the caller can honestly disable the condition).
async function fetchHtf(symbol, timeframe, { fromTs = null, toTs = null } = {}) {
  if (!timeframe) return { ok: true, candles: [], source: null };
  const r = await fetchSeries(symbol, timeframe, { fromTs, toTs });
  return r.ok ? { ok: true, candles: r.candles, source: r.source, timeframe } : { ok: false, candles: [], error: r.error };
}

module.exports = { fetchSeries, fetchHtf, clean, coverage, yahooSymbol, rangeFor, INTERVAL_FOR, MAX_LOOKBACK_DAYS };
