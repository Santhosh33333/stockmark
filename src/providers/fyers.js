// Fyers API v3 adapter (FREE market data; needs a Fyers account + API app).
// Auth header is "appId:accessToken" (no Bearer). Access tokens expire daily,
// so the user pastes a fresh token in Settings. Docs: https://myapi.fyers.in/docsv3
const { httpJson } = require('../util');

const BASE = 'https://api-t1.fyers.in';
const ID = 'fyers';
const LABEL = 'Fyers API v3';

const INDEX_MAP = {
  '^NSEI': 'NSE:NIFTY50-INDEX',
  '^NSEBANK': 'NSE:NIFTYBANK-INDEX',
  '^BSESN': 'BSE:SENSEX-INDEX',
  '^INDIAVIX': 'NSE:INDIAVIX-INDEX',
};

function toFyersSymbol(sym) {
  const up = String(sym || '').toUpperCase();
  if (INDEX_MAP[up]) return INDEX_MAP[up];
  const isBse = /\.BO$/.test(up);
  const bare = up.replace(/\.(NS|BO)$/i, '');
  return isBse ? `BSE:${bare}-EQ` : `NSE:${bare}-EQ`;
}
function fromFyersSymbol(f) {
  const s = String(f || '').toUpperCase();
  for (const [k, v] of Object.entries(INDEX_MAP)) if (v === s) return k;
  const m = s.match(/^(NSE|BSE):([A-Z0-9&-]+?)(?:-EQ)?$/);
  if (!m) return s;
  return `${m[2]}.${m[1] === 'BSE' ? 'BO' : 'NS'}`;
}

function headers(creds) {
  return { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `${creds.appId}:${creds.accessToken}` };
}

const RESOLUTIONS = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '1d': 'D' };
function rangeFromDays(days) {
  const d = new Date(Date.now() - days * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function rangeToDays(range) {
  const s = String(range || '6mo').toLowerCase();
  const n = parseFloat(s) || 0;
  if (s.endsWith('mo')) return Math.round((n || 6) * 31);
  if (s.endsWith('y')) return Math.round((n || 1) * 366);
  if (s.endsWith('d')) return Math.round(n || 5);
  if (s === 'max') return 2000;
  return 185;
}
const today = rangeFromDays(0);

async function fetchChart(symbol, { interval = '1d', range = '6mo' } = {}, creds) {
  const symbolId = toFyersSymbol(symbol);
  const json = await httpJson(`${BASE}/data/history`, {
    method: 'POST', timeoutMs: 30000, retry: 1,
    headers: headers(creds),
    body: JSON.stringify({
      symbol: symbolId,
      resolution: RESOLUTIONS[interval] || 'D',
      date_format: '1',
      range_from: rangeFromDays(rangeToDays(range)),
      range_to: today,
      cont_flag: '1',
    }),
  });
  if (!json || json.s !== 'ok' || !Array.isArray(json.candles)) {
    throw new Error(`Fyers candles failed: ${json?.message || json?.s || 'no data'}`);
  }
  const candles = json.candles
    .map((r) => ({ t: Number(r[0]) * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +(r[5] || 0) }))
    .filter((c) => isFinite(c.c))
    .sort((a, b) => a.t - b.t);
  return { meta: { symbol: symbolId, source: 'fyers' }, candles };
}

async function fetchQuotes(symbols, creds) {
  const uniq = [...new Set(symbols)];
  const json = await httpJson(`${BASE}/data/quotes`, {
    method: 'POST', timeoutMs: 20000, retry: 1,
    headers: headers(creds),
    body: JSON.stringify({ symbols: uniq.map(toFyersSymbol).join(',') }),
  });
  const list = json?.d || [];
  const bySym = new Map(list.map((x) => [String(x.n).toUpperCase(), x.v || {}]));
  const out = {};
  for (const sym of uniq) {
    const v = bySym.get(toFyersSymbol(sym)) || {};
    const price = v.lp != null ? +v.lp : null;
    const prevClose = v.prev_close_price != null ? +v.prev_close_price : null;
    out[sym] = {
      symbol: sym, price, prevClose,
      change: price != null && prevClose != null ? +(price - prevClose).toFixed(2) : null,
      currency: 'INR', source: 'fyers',
      volume: v.volume != null ? +v.volume : null,
    };
    // also key by bare symbol so callers can look up "SBIN" or "SBIN.NS"
    const bare = String(sym).replace(/\.(NS|BO)$/i, '');
    if (!(bare in out)) out[bare] = out[sym];
  }
  return out;
}

async function fetchQuote(symbol, creds) {
  const q = await fetchQuotes([symbol], creds);
  return q[symbol] || { symbol, price: null };
}

async function testConnection(creds) {
  try {
    const profile = await httpJson(`${BASE}/api/v3/profile`, { timeoutMs: 20000, retry: 0, headers: headers(creds) });
    if (profile?.s !== 'ok') throw new Error(profile?.message || 'auth failed');
    const d = profile.data || {};
    return { ok: true, message: 'Auth OK', profile: d.name || d.fy_id || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const isConfigured = (creds) => !!(creds && creds.enabled && creds.appId && creds.accessToken);

module.exports = { id: ID, label: LABEL, isConfigured, fetchChart, fetchQuote, fetchQuotes, testConnection, toFyersSymbol, fromFyersSymbol };
