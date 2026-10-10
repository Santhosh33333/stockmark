// Market-data facade. Tries the configured FREE providers in order and always
// falls back to Yahoo Finance (no key needed), so the app never hard-fails.
// Same interface as providers/yahoo.js: fetchChart, fetchSymbolData, fetchQuote,
// fetchQuotes, mapLimit — plus providerStatus()/testProvider() for Settings.
const config = require('../../config');
const { pMap } = require('../util');
const store = require('./store');
const yahoo = require('./yahoo');
const angelone = require('./angelone');
const fyers = require('./fyers');
const tapetide = require('./tapetide');

const noop = () => true;
const REGISTRY = {
  yahoo: { id: 'yahoo', label: 'Yahoo Finance', ...yahoo, isConfigured: noop },
  angelone,
  fyers,
  tapetide,
};

// Ordered list of provider ids to try (configured first, yahoo forced last).
// Any registered provider missing from the saved order is appended, so newly
// added sources (e.g. tapetide) light up without wiping an existing config.
function chainIds() {
  const c = store.load();
  const ids = (c.order || []).filter((id) => REGISTRY[id]);
  for (const id of Object.keys(REGISTRY)) if (!ids.includes(id)) ids.push(id);
  return ids.filter((id) => id !== 'yahoo').concat('yahoo');
}
function chain() {
  return chainIds().map((id) => REGISTRY[id]);
}
function credsFor(id) {
  if (id === 'yahoo') return {};
  return store.load()[id] || {};
}
function usable() {
  return chain().filter((p) => { try { return p.isConfigured(credsFor(p.id)); } catch { return false; } });
}

let lastUsed = { chart: null, quote: null, at: 0 };

// Run an operation across the provider chain until one succeeds.
async function race(method, args, { requireValue } = {}) {
  const providers = usable();
  let lastErr;
  for (const p of providers) {
    try {
      const out = await p[method](...args, credsFor(p.id));
      if (requireValue && !requireValue(out)) { lastErr = new Error(`${p.id}: empty result`); continue; }
      lastUsed = { ...lastUsed, [method === 'fetchChart' ? 'chart' : 'quote']: p.id, at: Date.now() };
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no data provider available');
}

async function fetchChart(symbol, opts = {}) {
  return race('fetchChart', [symbol, opts]);
}

async function fetchSymbolData(symbol, opts = {}) {
  const dailyRange = opts.dailyRange || config.scan.dailyRange;
  const hourlyRange = opts.hourlyRange || config.scan.hourlyRange;
  const daily = await fetchChart(symbol, { interval: '1d', range: dailyRange });
  let hourly = { candles: [], meta: {} };
  try { hourly = await fetchChart(symbol, { interval: '1h', range: hourlyRange }); } catch { /* hourly optional */ }
  return { daily: daily.candles, hourly: hourly.candles, meta: { ...(daily.meta || {}), source: daily.meta?.source || 'yahoo' } };
}

const hasPrice = (q) => !!q && Object.values(q).some((v) => v && v.price != null);

async function fetchQuotes(symbols, opts = {}) {
  const providers = usable();
  let lastErr;
  for (const p of providers) {
    try {
      const out = p.fetchQuotes
        ? await p.fetchQuotes(symbols, credsFor(p.id))
        : Object.fromEntries(await Promise.all([...new Set(symbols)].map(async (s) => [s, await p.fetchQuote(s, credsFor(p.id))])));
      if (hasPrice(out)) {
        lastUsed = { ...lastUsed, quote: p.id, at: Date.now() };
        return out;
      }
      lastErr = new Error(`${p.id}: no prices`);
    } catch (e) { lastErr = e; }
  }
  // Final safety net: yahoo per-symbol (never throws)
  void lastErr;
  const unique = [...new Set(symbols)];
  const results = await pMap(unique, opts.concurrency || 10, (s) => yahoo.fetchQuote(s));
  const out = {};
  results.forEach((r, i) => {
    const val = r.ok ? r.value : { symbol: unique[i], price: null };
    out[unique[i]] = val;
    const base = String(unique[i]).replace(/\.(NS|BO)$/i, '');
    if (!(base in out)) out[base] = val;
  });
  return out;
}

async function fetchQuote(symbol, opts = {}) {
  const out = await fetchQuotes([symbol], opts);
  return out[symbol] || { symbol, price: null };
}

const mapLimit = (items, limit, worker) => pMap(items, limit, worker);

// ── Settings helpers ─────────────────────────────────────────────────────
function providerStatus() {
  const list = chain().map((p) => {
    let ok = false;
    try { ok = p.isConfigured(credsFor(p.id)); } catch { /* ignore */ }
    return { id: p.id, label: p.label, configured: ok, active: ok };
  });
  return {
    order: chainIds(),
    providers: list,
    active: usable().map((p) => p.id),
    lastUsed,
    credentials: store.publicView(),
  };
}

async function testProvider(id) {
  const p = REGISTRY[id];
  if (!p) return { ok: false, error: `Unknown provider: ${id}` };
  const creds = credsFor(id);
  if (!p.isConfigured(creds)) return { ok: false, error: `${p.label} is not fully configured yet` };
  if (p.testConnection) return p.testConnection(creds);
  // Providers without an explicit test (Yahoo): probe a live quote.
  try {
    const q = await p.fetchQuote('^NSEI', creds);
    return q && q.price != null
      ? { ok: true, message: 'Live probe OK', profile: 'no key needed', sample: q.price }
      : { ok: false, error: 'no price returned' };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  fetchChart, fetchSymbolData, fetchQuote, fetchQuotes, mapLimit,
  providerStatus, testProvider, chain, usable,
};
