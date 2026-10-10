// Angel One SmartAPI adapter (FREE market data; needs an Angel One account).
// Login uses clientCode + PIN + TOTP (generated from a saved base32 secret).
// Docs: https://smartapi.angelone.in/docs  · session is valid until midnight IST.
const crypto = require('crypto');
const { httpJson } = require('../util');

const BASE = 'https://apiconnect.angelone.in';
const SCRIP_MASTER = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

const ID = 'angelone';
const LABEL = 'Angel One SmartAPI';

// ── TOTP (RFC 6238, 30s / 6 digits / SHA-1) from a base32 secret ──────────
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s || '').toUpperCase().replace(/[\s=]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret) {
  const key = base32Decode(secret);
  if (!key.length) throw new Error('TOTP secret is empty or invalid');
  const counter = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[19] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

function headers(apiKey, jwt) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '0.0.0.0',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey,
  };
  if (jwt) h.Authorization = 'Bearer ' + jwt;
  return h;
}

// ── session cache ────────────────────────────────────────────────────────
let session = null; // { jwt, feedToken, at }
const SESSION_MS = 6 * 3600 * 1000;

async function login(creds) {
  if (!creds.apiKey || !creds.clientCode || !creds.pin) throw new Error('Angel One: apiKey, clientCode and PIN are required');
  const code = creds.totpSecret ? totp(creds.totpSecret) : String(creds.totp || '').trim();
  if (!code) throw new Error('Angel One: need a TOTP secret (or a current 6-digit code)');
  const json = await httpJson(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: 'POST', timeoutMs: 20000, retry: 1,
    headers: headers(creds.apiKey),
    body: JSON.stringify({ clientcode: creds.clientCode, password: creds.pin, totp: code }),
  });
  if (!json || json.status !== true || !json.data?.jwtToken) {
    throw new Error(`Angel One login failed: ${json?.message || json?.errorcode || 'unknown'}`);
  }
  session = { jwt: json.data.jwtToken, feedToken: json.data.feedToken, at: Date.now() };
  return session;
}
async function getSession(creds) {
  if (session && Date.now() - session.at < SESSION_MS) return session;
  return login(creds);
}

// ── instrument (scrip) master → symbol → token ───────────────────────────
let master = null; // { map: Map('NSE:SBIN-EQ' -> {token,exch,symbol}), plain: Map('SBIN' -> {token,exch}) , at }
const MASTER_MS = 20 * 3600 * 1000;
// Index tokens are stable and not reliably in the master.
const INDEX_MAP = {
  '^NSEI': { exchange: 'NSE', symboltoken: '26000', name: 'NIFTY' },
  '^NSEBANK': { exchange: 'NSE', symboltoken: '26009', name: 'BANKNIFTY' },
  '^BSESN': { exchange: 'BSE', symboltoken: '1', name: 'SENSEX' },
};

async function loadMaster() {
  if (master && Date.now() - master.at < MASTER_MS) return master;
  const list = await httpJson(SCRIP_MASTER, { timeoutMs: 90000, retry: 1 });
  const map = new Map();
  const plain = new Map();
  for (const it of Array.isArray(list) ? list : []) {
    const exch = String(it.exch_seg || '').toUpperCase();
    if (exch !== 'NSE' && exch !== 'BSE') continue;
    const sym = String(it.symbol || '').toUpperCase();
    if (!sym) continue;
    const rec = { token: String(it.token), exch, symbol: sym, name: it.name || sym };
    map.set(`${exch}:${sym}`, rec);
    const bare = sym.replace(/-(EQ|BE|SM|ST|BZ)$/, '');
    if (!plain.has(bare)) plain.set(bare, rec);
  }
  master = { map, plain, at: Date.now() };
  return master;
}

// Yahoo-style symbol (SBIN.NS / ^NSEI) → Angel One instrument
async function resolve(yahooSymbol) {
  const up = String(yahooSymbol || '').toUpperCase();
  if (INDEX_MAP[up]) return { ...INDEX_MAP[up] };
  const m = await loadMaster();
  const isBse = /\.BO$/.test(up);
  const bare = up.replace(/\.(NS|BO)$/i, '');
  const wanted = isBse ? 'BSE' : 'NSE';
  const direct = m.map.get(`${wanted}:${bare}-EQ`) || m.map.get(`${wanted}:${bare}`);
  if (direct) return { exchange: direct.exch, symboltoken: direct.token, name: direct.name };
  const p = m.plain.get(bare);
  if (p) return { exchange: p.exch, symboltoken: p.token, name: p.name };
  throw new Error(`Angel One: no instrument token for ${yahooSymbol}`);
}

// ── interval / range mapping ─────────────────────────────────────────────
const INTERVALS = { '1m': 'ONE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE', '30m': 'THIRTY_MINUTE', '1h': 'ONE_HOUR', '1d': 'ONE_DAY' };
function rangeToDays(range) {
  const s = String(range || '6mo').toLowerCase();
  const n = parseFloat(s) || 0;
  if (s.endsWith('mo')) return Math.round((n || 6) * 31);
  if (s.endsWith('y')) return Math.round((n || 1) * 366);
  if (s.endsWith('d')) return Math.round(n || 5);
  if (s === 'max') return 3000;
  return 185;
}
const pad = (n) => String(n).padStart(2, '0');
function fmtIst(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function istDate(ms) { return new Date(ms + 5.5 * 3600000); }

async function fetchChart(symbol, { interval = '1d', range = '6mo' } = {}, creds) {
  const inst = await resolve(symbol);
  const s = await getSession(creds);
  const days = rangeToDays(range);
  const nowIst = istDate(Date.now());
  const from = istDate(Date.now() - days * 86400000);
  const json = await httpJson(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: 'POST', timeoutMs: 30000, retry: 1,
    headers: headers(creds.apiKey, s.jwt),
    body: JSON.stringify({
      exchange: inst.exchange,
      symboltoken: inst.symboltoken,
      interval: INTERVALS[interval] || 'ONE_DAY',
      fromdate: fmtIst(from),
      todate: fmtIst(nowIst),
    }),
  });
  if (!json || json.status !== true || !Array.isArray(json.data)) {
    throw new Error(`Angel One candles failed: ${json?.message || 'no data'}`);
  }
  const candles = json.data
    .map((r) => ({ t: new Date(r[0]).getTime(), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +(r[5] || 0) }))
    .filter((c) => c.c != null && isFinite(c.c))
    .sort((a, b) => a.t - b.t);
  return { meta: { symbol: inst.name || symbol, exchange: inst.exchange, source: 'angelone' }, candles };
}

async function fetchQuotes(symbols, creds) {
  const uniq = [...new Set(symbols)];
  const resolved = [];
  for (const sym of uniq) {
    try { resolved.push({ sym, inst: await resolve(sym) }); } catch { resolved.push({ sym, inst: null }); }
  }
  const tokens = { NSE: [], BSE: [] };
  for (const r of resolved) if (r.inst && tokens[r.inst.exchange]) tokens[r.inst.exchange].push(r.inst.symboltoken);
  const out = {};
  if (!tokens.NSE.length && !tokens.BSE.length) return out;
  const s = await getSession(creds);
  const json = await httpJson(`${BASE}/rest/secure/angelbroking/market/v1/quote`, {
    method: 'POST', timeoutMs: 20000, retry: 1,
    headers: headers(creds.apiKey, s.jwt),
    body: JSON.stringify({ mode: 'FULL', exchangeTokens: { NSE: tokens.NSE, BSE: tokens.BSE } }),
  });
  const fetched = json?.data?.fetched || [];
  const byToken = new Map(fetched.map((f) => [String(f.symbolToken), f]));
  for (const r of resolved) {
    if (!r.inst) { out[r.sym] = { symbol: r.sym, price: null }; continue; }
    const f = byToken.get(String(r.inst.symboltoken));
    const price = f?.ltp != null ? +f.ltp : null;
    const prevClose = f?.close != null ? +f.close : null;
    out[r.sym] = {
      symbol: r.sym, price, prevClose,
      change: price != null && prevClose != null ? +(price - prevClose).toFixed(2) : null,
      currency: 'INR', exchange: r.inst.exchange, source: 'angelone',
      volume: f?.tradeVolume != null ? +f.tradeVolume : null,
    };
  }
  return out;
}

async function fetchQuote(symbol, creds) {
  const q = await fetchQuotes([symbol], creds);
  return q[symbol] || { symbol, price: null };
}

async function testConnection(creds) {
  try {
    const inst = await resolve('SBIN.NS'); // also validates the scrip master
    const s = await getSession(creds);
    const list = await httpJson(`${BASE}/rest/secure/angelbroking/order/v1/getLTP`, {
      method: 'POST', timeoutMs: 15000, retry: 0,
      headers: headers(creds.apiKey, s.jwt),
      body: JSON.stringify({ exchange: inst.exchange, tradingsymbol: inst.symbol || 'SBIN-EQ', symboltoken: inst.symboltoken }),
    }).catch(() => null);
    const profile = await httpJson(`${BASE}/rest/secure/angelbroking/user/v1/getProfile`, {
      timeoutMs: 15000, retry: 0, headers: headers(creds.apiKey, s.jwt),
    }).catch(() => null);
    return { ok: true, message: 'Login OK', profile: profile?.data?.name || profile?.data?.clientcode || null, sample: list?.data?.ltp ?? null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const isConfigured = (creds) => !!(creds && creds.enabled && creds.apiKey && creds.clientCode && creds.pin && (creds.totpSecret || creds.totp));

module.exports = { id: ID, label: LABEL, isConfigured, fetchChart, fetchQuote, fetchQuotes, testConnection, resolve, totp };
