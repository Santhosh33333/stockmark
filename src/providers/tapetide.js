// Tapetide adapter — Indian stock data over the Model Context Protocol (MCP).
// Remote Streamable-HTTP endpoint; auth via personal token (Bearer tpt_rt_...).
// Free tier: ~50 successful tool calls/day, so this is an OPTIONAL, low-priority
// source (great for research/fundamentals, not for bulk scanning).
// Docs: https://tapetide.com/mcp
const ID = 'tapetide';
const LABEL = 'Tapetide MCP';
const MCP_URL = 'https://mcp.tapetide.com/mcp';

// ── MCP JSON-RPC over Streamable HTTP (JSON or SSE responses) ────────────
let session = null; // { sid, at, tools }
const SESSION_MS = 20 * 60 * 1000;
let usedToday = { day: '', count: 0 };
const DAILY_CAP = 45; // stay under the free 50/day so the app degrades cleanly

function dayKey() { const d = new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; }
function guardQuota() {
  const k = dayKey();
  if (usedToday.day !== k) usedToday = { day: k, count: 0 };
  if (usedToday.count >= DAILY_CAP) throw new Error(`Tapetide daily free limit reached (~${DAILY_CAP} calls/day)`);
  usedToday.count++;
}

async function rpc(token, sid, body) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(sid ? { 'Mcp-Session-Id': sid } : {}),
    },
    body: JSON.stringify(body),
  });
  const nsid = res.headers.get('mcp-session-id') || sid || null;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const txt = await res.text();
  if (res.status !== 202 && !res.ok) throw new Error(`Tapetide HTTP ${res.status}: ${txt.slice(0, 160)}`);
  let json = null;
  if (ct.includes('event-stream')) {
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const d = s.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try { const j = JSON.parse(d); if (j && (j.result !== undefined || j.error !== undefined)) { json = j; break; } } catch { /* skip */ }
    }
  } else if (txt) {
    try { json = JSON.parse(txt); } catch { /* maybe empty */ }
  }
  return { json, sid: nsid };
}

async function ensureSession(token) {
  if (session && Date.now() - session.at < SESSION_MS) return session;
  const init = await rpc(token, null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'TradeMind', version: '1.0.0' } },
  });
  if (init.json?.error) throw new Error('Tapetide initialize failed: ' + (init.json.error.message || 'unknown'));
  await rpc(token, init.sid, { jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
  session = { sid: init.sid, at: Date.now(), tools: null };
  return session;
}

function parseToolText(res) {
  if (res?.isError) {
    const msg = (res.content || []).map((c) => c.text).join(' ').replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(msg || 'Tapetide tool error');
  }
  let text = (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  text = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(text); } catch { return text; }
}

async function callTool(token, name, args) {
  guardQuota();
  const s = await ensureSession(token);
  const r = await rpc(token, s.sid, { jsonrpc: '2.0', id: (Date.now() % 100000), method: 'tools/call', params: { name, arguments: args } });
  if (r.json?.error) throw new Error(`${name}: ${r.json.error.message || 'error'}`);
  return parseToolText(r.json?.result);
}

async function tools(token) {
  const s = await ensureSession(token);
  if (s.tools) return s.tools;
  const r = await rpc(token, s.sid, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  s.tools = r.json?.result?.tools || [];
  return s.tools;
}

// ── helpers: symbols + tolerant parsing ──────────────────────────────────
const INDEX = { '^NSEI': 'NIFTY', '^NSEBANK': 'BANKNIFTY', '^CNXIT': 'NIFTY IT', '^INDIAVIX': 'INDIA VIX' };
const toTpSymbol = (sym) => {
  const up = String(sym || '').toUpperCase();
  if (INDEX[up]) return INDEX[up];
  return up.replace(/\.(NS|BO)$/i, '');
};

// Recursively find the first numeric value under any of the given keys.
function findNum(obj, keys, depth = 0) {
  if (!obj || depth > 5) return null;
  if (Array.isArray(obj)) { for (const v of obj) { const r = findNum(v, keys, depth + 1); if (r != null) return r; } return null; }
  if (typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.some((want) => k.toLowerCase().replace(/[^a-z]/g, '') === want)) {
      const n = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : v;
      if (typeof n === 'number' && isFinite(n)) return n;
    }
  }
  for (const v of Object.values(obj)) { const r = findNum(v, keys, depth + 1); if (r != null) return r; }
  return null;
}

// Locate the sub-object belonging to a specific symbol in a batch response.
function pickSymbolNode(data, sym) {
  const bare = String(sym).toUpperCase().replace(/\.(NS|BO)$/i, '');
  const want = new Set([bare, bare + '.NS', bare + '.BO', 'NSE:' + bare, 'BSE:' + bare, 'NSE:' + bare + '-EQ']);
  const walk = (o, d = 0) => {
    if (!o || d > 5) return null;
    if (Array.isArray(o)) { for (const v of o) { const r = walk(v, d + 1); if (r) return r; } return null; }
    if (typeof o !== 'object') return null;
    for (const [k, v] of Object.entries(o)) {
      const kk = String(k).toUpperCase();
      if (want.has(kk) || kk.replace(/[^A-Z0-9]/g, '') === bare) return v;
    }
    for (const v of Object.values(o)) { const r = walk(v, d + 1); if (r) return r; }
    return null;
  };
  return walk(data);
}

function quoteFrom(data, symbol) {
  if (typeof data === 'number') return { symbol, price: data, prevClose: null, change: null, currency: 'INR', source: 'tapetide' };
  const price = findNum(data, ['ltp', 'lastprice', 'price', 'last', 'close', 'currentprice', 'value']);
  const prev = findNum(data, ['prevclose', 'previousclose', 'prevcloseprice', 'previousclosingprice']);
  return {
    symbol, price,
    prevClose: prev,
    change: price != null && prev != null ? +(price - prev).toFixed(2) : null,
    currency: 'INR', source: 'tapetide',
    volume: findNum(data, ['volume', 'tradedvolume', 'qty']),
  };
}

// Extract OHLCV rows from whatever shape the tool returns.
function extractCandles(data) {
  const out = [];
  const pushRow = (r) => {
    if (Array.isArray(r) && r.length >= 5) {
      const t = typeof r[0] === 'number' ? (r[0] < 1e12 ? r[0] * 1000 : r[0]) : Date.parse(r[0]);
      const [o, h, l, c, v] = [r[1], r[2], r[3], r[4], r[5]].map(Number);
      if (isFinite(t) && isFinite(c)) out.push({ t, o: +o, h: +h, l: +l, c: +c, v: +(v || 0) });
    } else if (r && typeof r === 'object') {
      const norm = {}; for (const [k, v] of Object.entries(r)) norm[k.toLowerCase().replace(/[^a-z]/g, '')] = v;
      const tRaw = norm.date ?? norm.time ?? norm.timestamp ?? norm.dt;
      const t = typeof tRaw === 'number' ? (tRaw < 1e12 ? tRaw * 1000 : tRaw) : Date.parse(tRaw);
      const c = Number(norm.close ?? norm.c);
      if (isFinite(t) && isFinite(c)) out.push({ t, o: Number(norm.open ?? norm.o ?? c), h: Number(norm.high ?? norm.h ?? c), l: Number(norm.low ?? norm.l ?? c), c, v: Number(norm.volume ?? norm.v ?? 0) });
    }
  };
  const walk = (o, d = 0) => {
    if (!o || d > 6) return;
    if (Array.isArray(o)) {
      if (o.length && (Array.isArray(o[0]) || (o[0] && typeof o[0] === 'object'))) o.forEach(pushRow);
      else o.forEach((x) => walk(x, d + 1));
      return;
    }
    if (typeof o === 'object') Object.values(o).forEach((v) => walk(v, d + 1));
  };
  walk(data);
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Build arguments for get_price_history using the tool's real schema.
async function historyArgs(token, symbol, days) {
  const t = (await tools(token)).find((x) => x.name === 'get_price_history');
  const props = t?.inputSchema?.properties || {};
  const args = {};
  const setIf = (names, val) => { for (const n of names) if (props[n]) { args[n] = val; return true; } return false; };
  setIf(['symbol', 'ticker', 'scrip'], symbol);
  setIf(['period', 'interval', 'frequency', 'resolution'], '1d');
  setIf(['days', 'limit', 'lookback_days', 'lookback', 'count', 'sessions'], days);
  if (!args.symbol) args.symbol = symbol;
  return args;
}

// ── provider interface ───────────────────────────────────────────────────
async function fetchChart(symbol, { interval = '1d', range = '6mo' } = {}, creds) {
  if (interval !== '1d') throw new Error('Tapetide adapter supports daily history only');
  const days = /mo$/.test(range) ? Math.round((parseFloat(range) || 6) * 31) : /y$/.test(range) ? Math.round((parseFloat(range) || 1) * 366) : (parseInt(range, 10) || 185);
  const sym = toTpSymbol(symbol);
  const data = await callTool(creds.token, 'get_price_history', await historyArgs(creds.token, sym, days));
  const candles = extractCandles(data);
  if (!candles.length) throw new Error('Tapetide: no candles parsed from get_price_history');
  return { meta: { symbol: sym, source: 'tapetide' }, candles };
}

async function fetchQuotes(symbols, creds) {
  const uniq = [...new Set(symbols)];
  const out = {};
  // Prefer the batch tool for up to 20 symbols.
  try {
    const data = await callTool(creds.token, 'get_batch_quotes', { symbols: uniq.slice(0, 20).map(toTpSymbol) });
    for (const sym of uniq) {
      const node = uniq.length === 1 ? data : pickSymbolNode(data, sym);
      out[sym] = node ? quoteFrom(node, sym) : { symbol: sym, price: null };
      const bare = String(sym).replace(/\.(NS|BO)$/i, '');
      if (!(bare in out)) out[bare] = out[sym];
    }
    if (Object.values(out).some((q) => q.price != null)) return out;
  } catch { /* fall through to per-symbol */ }
  for (const sym of uniq) out[sym] = quoteFrom(await callTool(creds.token, 'get_stock_quote', { symbol: toTpSymbol(sym) }), sym);
  return out;
}

async function fetchQuote(symbol, creds) {
  const q = await fetchQuotes([symbol], creds);
  return q[symbol] || { symbol, price: null };
}

async function testConnection(creds) {
  try {
    // tools/list is protocol-level and does NOT consume the free allowance.
    const list = await tools(creds.token);
    const names = (list || []).map((t) => t.name);
    if (!names.length) return { ok: false, error: 'connected, but no tools advertised' };
    const missing = ['get_stock_quote'].filter((n) => !names.includes(n));
    if (missing.length && names.length) return { ok: false, error: `connected, but missing tools: ${missing.join(', ')}` };
    const q = await callTool(creds.token, 'get_stock_quote', { symbol: 'RELIANCE' });
    const price = findNum(q, ['ltp', 'lastprice', 'price', 'close']);
    return {
      ok: true,
      message: names.length + ' tools available' + (price != null ? ' · sample fetched' : ''),
      profile: 'tapetide MCP', sample: price,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const isConfigured = (creds) => !!(creds && creds.enabled && creds.token);

module.exports = { id: ID, label: LABEL, isConfigured, fetchChart, fetchQuote, fetchQuotes, testConnection, MCP_URL };
