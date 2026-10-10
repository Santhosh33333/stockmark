// Live market data from Yahoo Finance (free, no API key). NSE ".NS" and BSE ".BO" symbols.
const config = require('../../config');
const { httpJson, pMap, sleep } = require('../util');

const BASE = config.yahooBase;
const FALLBACK = config.yahooBase2;

async function fetchChart(symbol, { interval = '1d', range = '6mo' } = {}) {
  const url = `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  let json;
  try {
    json = await httpJson(url, { timeoutMs: 25000, retry: 1 });
  } catch (e) {
    json = await httpJson(`${FALLBACK}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`, { timeoutMs: 25000, retry: 1 });
  }
  const res = json?.chart?.result?.[0];
  if (!res || !res.timestamp) {
    const err = json?.chart?.error?.description || 'no data';
    throw new Error(err);
  }
  const q = res.indicators.quote[0] || {};
  const candles = [];
  const tzOffset = (res.meta?.gmtoffset ?? 19800) * 1000;
  for (let i = 0; i < res.timestamp.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (c == null || o == null || h == null || l == null) continue;
    candles.push({ t: new Date(res.timestamp[i] * 1000 + tzOffset).getTime(), o, h, l, c, v: v ?? 0 });
  }
  candles.sort((a, b) => a.t - b.t);
  return { meta: res.meta || {}, candles };
}

// One symbol = daily (strategy) + hourly (4H RSI aggregation)
async function fetchSymbolData(symbol, opts = {}) {
  const dailyRange = opts.dailyRange || config.scan.dailyRange;
  const hourlyRange = opts.hourlyRange || config.scan.hourlyRange;
  const [daily, hourly] = await Promise.all([
    fetchChart(symbol, { interval: '1d', range: dailyRange }),
    fetchChart(symbol, { interval: '1h', range: hourlyRange }).catch(() => ({ meta: {}, candles: [] })),
  ]);
  return { daily: daily.candles, hourly: hourly.candles, meta: daily.meta };
}

// Fast live price check for watchlists / open positions
async function fetchQuote(symbol) {
  try {
    const { meta } = await fetchChart(symbol, { interval: '1d', range: '5d' });
    const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
    return {
      symbol,
      price,
      prevClose: meta.chartPreviousClose ?? meta.previousClose,
      change: price != null && meta.chartPreviousClose ? price - meta.chartPreviousClose : null,
      currency: meta.currency || 'INR',
      exchange: meta.fullExchangeName || meta.exchangeName || '',
      marketState: meta.marketState || '',
    };
  } catch {
    return { symbol, price: null, currency: 'INR' };
  }
}

async function fetchQuotes(symbols, { concurrency = 10 } = {}) {
  const unique = [...new Set(symbols)];
  const results = await pMap(unique, concurrency, async (s) => fetchQuote(s));
  const out = {};
  results.forEach((r, i) => {
    const val = r.ok ? r.value : { symbol: unique[i], price: null };
    out[unique[i]] = val;
    // also index by the bare symbol so callers can look up "SBIN" or "SBIN.NS"
    const base = String(unique[i]).replace(/\.(NS|BO)$/i, '');
    if (!(base in out)) out[base] = val;
  });
  return out;
}

// Batch concurrency helper reused by the scanner
async function mapLimit(items, limit, worker) {
  return pMap(items, limit, worker);
}

module.exports = { fetchChart, fetchSymbolData, fetchQuote, fetchQuotes, mapLimit };
