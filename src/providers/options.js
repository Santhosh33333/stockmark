// Real option chains for Indian underlyings — no fabricated data, ever.
//
// Source selection (best-effort, in order):
//   1. Dhan  — used when the signed-in user has saved a Dhan access token + client id.
//              Uses POST /v2/optionchain/expirylist then POST /v2/optionchain (1 req / 3s).
//   2. NSE   — free public fallback: homepage cookie bootstrap, then
//              GET /api/option-chain-contract-info and GET /api/option-chain-v3.
//
// Everything is normalised to one shape so the UI is source-agnostic:
//   { source, symbol, type, expiry, expiries, underlyingValue, pcr,
//     totals:{ceOi,peOi,ceOiChange,peOiChange,ceVolume,peVolume},
//     strikes:[{ strike, ce:{oi,oiChange,volume,iv,ltp,change,changePct}, pe:{...} }],
//     updatedAt }
const config = require('../../config');
const { httpJson, sleep } = require('../util');

// ── underlyings ──────────────────────────────────────────────────────────
// Index symbols that NSE serves with type=Indices and Dhan serves on segment IDX_I.
const INDEX_UNDERLYINGS = {
  NIFTY:      { dhan: { scrip: 13,  seg: 'IDX_I' }, aliases: ['NIFTY', 'NIFTY50', 'NIFTY 50'] },
  BANKNIFTY:  { dhan: { scrip: 25,  seg: 'IDX_I' }, aliases: ['BANKNIFTY', 'NIFTYBANK', 'NIFTY BANK'] },
  FINNIFTY:   { dhan: { scrip: 27,  seg: 'IDX_I' }, aliases: ['FINNIFTY', 'NIFTYFIN', 'FIN NIFTY'] },
  MIDCPNIFTY: { dhan: { scrip: 442, seg: 'IDX_I' }, aliases: ['MIDCPNIFTY', 'NIFTYMIDCPNIFTY'] },
  NIFTYNXT50: { dhan: { scrip: 26,  seg: 'IDX_I' }, aliases: ['NIFTYNXT50', 'NIFTY NEXT 50'] },
  SENSEX:     { dhan: { scrip: 51,  seg: 'IDX_I' }, aliases: ['SENSEX', 'BSESEN'] },
};

function resolveUnderlying(symbol) {
  const raw = String(symbol || '').trim().toUpperCase().replace(/[\s_-]+/g, '');
  for (const [name, def] of Object.entries(INDEX_UNDERLYINGS)) {
    if (name === raw || def.aliases.some((a) => a.replace(/[\s_-]+/g, '') === raw)) {
      return { symbol: name, type: 'Indices', dhan: def.dhan };
    }
  }
  return { symbol: raw, type: 'Equity', dhan: null };
}

// ── tiny TTL cache (protects the rate-limited sources) ───────────────────
const cache = new Map();
const CACHE_MS = 25 * 1000;
function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (hit) cache.delete(key);
  return null;
}
function cacheSet(key, value) { cache.set(key, { at: Date.now(), value }); }

// ══════════════════════════ normaliser ═══════════════════════════════════
function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

function normalize({ source, symbol, type, expiry, expiries, underlyingValue, strikes }) {
  const rows = [...strikes.values()]
    .filter((s) => s.ce || s.pe)
    .sort((a, b) => a.strike - b.strike);

  const totals = { ceOi: 0, peOi: 0, ceOiChange: 0, peOiChange: 0, ceVolume: 0, peVolume: 0 };
  for (const s of rows) {
    if (s.ce) { totals.ceOi += s.ce.oi || 0; totals.ceOiChange += s.ce.oiChange || 0; totals.ceVolume += s.ce.volume || 0; }
    if (s.pe) { totals.peOi += s.pe.oi || 0; totals.peOiChange += s.pe.oiChange || 0; totals.peVolume += s.pe.volume || 0; }
  }
  // ATM strike (nearest to the underlying) for a sane default scroll position
  let atm = null;
  if (underlyingValue != null && rows.length) {
    atm = rows.reduce((best, s) => (Math.abs(s.strike - underlyingValue) < Math.abs(best - underlyingValue) ? s.strike : best), rows[0].strike);
  }
  return {
    source, symbol, type, expiry,
    expiries: expiries || [],
    underlyingValue: underlyingValue ?? null,
    atm,
    pcr: totals.ceOi ? +(totals.peOi / totals.ceOi).toFixed(3) : null,
    totals,
    strikes: rows,
    updatedAt: Date.now(),
  };
}

// ══════════════════════════ NSE (free) ═══════════════════════════════════
function nseHeaders(extra = {}) {
  return {
    'User-Agent': config.userAgent,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: config.nseOptionChain.referer,
    'X-Requested-With': 'XMLHttpRequest',
    Connection: 'keep-alive',
    ...extra,
  };
}

// Raw fetch that also surfaces Set-Cookie (needed for the NSE cookie bootstrap).
async function rawGet(url, { headers, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    const text = await res.text();
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { status: res.status, ok: res.ok, text, setCookies };
  } finally {
    clearTimeout(timer);
  }
}

async function nseCookie() {
  const res = await rawGet(config.nseOptionChain.base + '/', { headers: nseHeaders() });
  const cookie = res.setCookies.map((c) => String(c).split(';')[0]).join('; ');
  if (!cookie) throw new Error('NSE did not issue cookies (possibly blocked from this network)');
  return cookie;
}

async function nseJson(url, cookie) {
  const res = await rawGet(url, { headers: nseHeaders(cookie ? { Cookie: cookie } : {}) });
  if (!res.ok) throw new Error(`NSE responded HTTP ${res.status}`);
  const text = res.text.trim();
  if (!text) throw new Error('NSE returned an empty response');
  try { return JSON.parse(text); }
  catch { throw new Error('NSE returned a non-JSON response (likely blocked)'); }
}

function nseLeg(v) {
  if (!v) return null;
  return {
    oi: num(v.openInterest),
    oiChange: num(v.changeinOpenInterest),
    oiChangePct: num(v.pchangeinOpenInterest),
    volume: num(v.totalTradedVolume),
    iv: num(v.impliedVolatility),
    ltp: num(v.lastPrice),
    change: num(v.change),
    changePct: num(v.pChange),
  };
}

async function nseChain(symbol, expiry) {
  const u = resolveUnderlying(symbol);
  const cookie = await nseCookie();

  const info = await nseJson(`${config.nseOptionChain.contractInfo}?symbol=${encodeURIComponent(u.symbol)}`, cookie);
  const expiries = (info && (info.expiryDates || info.expiry_dates)) || [];
  if (!expiries.length) throw new Error(`No option expiries published for ${u.symbol} (not an F&O underlying?)`);

  const chosen = expiry && expiries.includes(expiry) ? expiry : expiries[0];
  const url = `${config.nseOptionChain.chain}?type=${u.type}&symbol=${encodeURIComponent(u.symbol)}&expiry=${encodeURIComponent(chosen)}`;
  const json = await nseJson(url, cookie);

  const rec = json && (json.records || json.filtered);
  const rows = (rec && rec.data) || [];
  if (!rows.length) throw new Error(`NSE returned no strikes for ${u.symbol} ${chosen}`);

  const underlyingValue = num(rec.underlyingValue);
  const strikes = new Map();
  for (const r of rows) {
    const k = num(r.strikePrice);
    if (k == null) continue;
    if (!strikes.has(k)) strikes.set(k, { strike: k, ce: null, pe: null });
    const cell = strikes.get(k);
    if (r.CE) cell.ce = nseLeg(r.CE);
    if (r.PE) cell.pe = nseLeg(r.PE);
  }
  return normalize({ source: 'NSE', symbol: u.symbol, type: u.type, expiry: chosen, expiries, underlyingValue, strikes });
}

// ══════════════════════════ Dhan (user's key) ════════════════════════════
function dhanHeaders(settings) {
  return {
    'Content-Type': 'application/json',
    'access-token': settings.dhanAccessToken,
    'client-id': settings.dhanClientId,
  };
}

async function dhanJson(path, settings, body) {
  return httpJson(`${config.dhan.baseUrl}${path}`, {
    method: 'POST',
    headers: dhanHeaders(settings),
    body: JSON.stringify(body),
    timeoutMs: 25000,
    retry: 0,
  });
}

function dhanLeg(v) {
  if (!v) return null;
  const oi = num(v.oi);
  const prev = num(v.previous_oi);
  return {
    oi,
    oiChange: oi != null && prev != null ? +(oi - prev).toFixed(0) : null,
    oiChangePct: oi != null && prev ? +(((oi - prev) / prev) * 100).toFixed(2) : null,
    volume: num(v.volume),
    iv: num(v.implied_volatility),
    ltp: num(v.last_price),
    change: null,
    changePct: null,
    greeks: v.greeks || null,
  };
}

async function dhanChain(settings, symbol, expiry) {
  if (!settings.dhanAccessToken || !settings.dhanClientId) throw new Error('Dhan credentials not set');
  const u = resolveUnderlying(symbol);
  let scrip, seg;
  if (u.dhan) { scrip = u.dhan.scrip; seg = u.dhan.seg; }
  else {
    // equity F&O — resolve the NSE security id from the free Dhan scrip master
    const dhanMod = require('../dhan');
    const id = await dhanMod.resolveSecurityId(u.symbol, 'NSE');
    if (!id) throw new Error(`Dhan security id not found for ${u.symbol}`);
    scrip = Number(id); seg = 'NSE_FNO';
  }

  const list = await dhanJson('/v2/optionchain/expirylist', settings, { UnderlyingScrip: scrip, UnderlyingSeg: seg });
  const expiries = (list && list.data) || [];
  if (!expiries.length) throw new Error(`Dhan returned no expiries for ${u.symbol}`);

  // Dhan rate-limits to ~1 request / 3s per client
  await sleep(3100);
  const chosen = expiry && expiries.includes(expiry) ? expiry : expiries[0];
  const oc = await dhanJson('/v2/optionchain', settings, { UnderlyingScrip: scrip, UnderlyingSeg: seg, Expiry: chosen });
  if (!oc || oc.status === 'failed') throw new Error((oc && oc.errorMessage) || 'Dhan option chain request failed');
  const data = oc.data || {};
  const ocMap = data.oc || {};
  const strikes = new Map();
  for (const [k, legs] of Object.entries(ocMap)) {
    const strike = num(k);
    if (strike == null) continue;
    strikes.set(strike, { strike, ce: dhanLeg(legs.ce), pe: dhanLeg(legs.pe) });
  }
  if (!strikes.size) throw new Error(`Dhan returned no strikes for ${u.symbol} ${chosen}`);
  return normalize({
    source: 'Dhan', symbol: u.symbol, type: u.type, expiry: chosen, expiries,
    underlyingValue: num(data.last_price), strikes,
  });
}

// ══════════════════════════ public entrypoint ════════════════════════════
// settings: optional user settings (uses Dhan when it has a token + client id).
async function getOptionChain({ settings = {}, symbol, expiry } = {}) {
  const u = resolveUnderlying(symbol);
  if (!u.symbol) throw new Error('Symbol required');
  const key = `${u.symbol}|${expiry || ''}|${settings.dhanAccessToken ? 'dhan' : 'nse'}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const preferDhan = !!(settings.dhanAccessToken && settings.dhanClientId);
  const attempts = [];
  if (preferDhan) {
    try {
      const out = await dhanChain(settings, u.symbol, expiry);
      cacheSet(key, out);
      return { ...out, cached: false };
    } catch (e) {
      attempts.push({ source: 'Dhan', error: e.message });
    }
  }
  try {
    const out = await nseChain(u.symbol, expiry);
    cacheSet(key, out);
    return { ...out, cached: false, attempts };
  } catch (e) {
    attempts.push({ source: 'NSE', error: e.message });
    const err = new Error(`Option chain unavailable. ${attempts.map((a) => `${a.source}: ${a.error}`).join(' · ')}`);
    err.attempts = attempts;
    throw err;
  }
}

module.exports = { getOptionChain, resolveUnderlying, INDEX_UNDERLYINGS };
