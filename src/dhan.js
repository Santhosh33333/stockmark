// Optional LIVE execution via Dhan HTTP API (free API keys from DhanHQ dashboard).
// The app itself stays fully usable in PAPER / SIGNAL mode with no account at all.
const fs = require('fs');
const config = require('../config');
const { httpText, httpJson, parseCsv } = require('./util');

const DHAN_BASE = config.dhan.baseUrl;
const MASTER_CSV = 'https://images.dhan.co/api-data/api-scrip-master.csv';
let masterCache = null;         // { bySymbol: Map(symbol -> securityId) }
let masterLoadedAt = 0;

// Security-id resolution needs Dhan's free scrip master (ISIN/symbol -> numeric id)
async function loadMaster() {
  if (masterCache && Date.now() - masterLoadedAt < 24 * 3600 * 1000) return masterCache;
  const text = await httpText(MASTER_CSV, { timeoutMs: 60000, retry: 2 });
  const rows = parseCsv(text);
  const head = rows[0];
  const idx = (name) => head.findIndex((h) => h.trim() === name);
  const iSeg = idx('SEM_EXM_EXCH_ID');
  const iSym = idx('SEM_TRADING_SYMBOL');
  const iCustom = idx('SEM_CUSTOM_SYMBOL');
  const iSec = idx('SEM_SMST_SECURITY_ID');
  const bySymbol = new Map();
  for (const r of rows.slice(1)) {
    const seg = (r[iSeg] || '').trim();
    if (seg !== 'NSE' && seg !== 'BSE') continue;
    const sym = ((r[iCustom] || r[iSym] || '').trim() || '').toUpperCase();
    const plain = sym.replace(/-(EQ|BE|SM|ST)$/, '');
    if (!bySymbol.has(plain)) bySymbol.set(plain, (r[iSec] || '').trim());
  }
  masterCache = { bySymbol };
  masterLoadedAt = Date.now();
  return masterCache;
}

async function resolveSecurityId(symbol, exchange = 'NSE') {
  const m = await loadMaster();
  const plain = symbol.replace(/\.(NS|BO)$/i, '').toUpperCase();
  return m.bySymbol.get(plain) || null;
}

// Headers required by Dhan v2
function headers(accessToken) {
  return {
    'Content-Type': 'application/json',
    'access-token': accessToken,
  };
}

async function testConnection(settings) {
  if (!settings.dhanAccessToken) return { ok: false, error: 'Dhan access token not set' };
  try {
    const funds = await httpJson(`${DHAN_BASE}/v2/fundlimit`, {
      timeoutMs: 20000, retry: 1,
      headers: headers(settings.dhanAccessToken),
    });
    return { ok: true, funds };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getPositions(settings) {
  const p = await httpJson(`${DHAN_BASE}/v2/positions`, {
    timeoutMs: 20000, retry: 1, headers: headers(settings.dhanAccessToken),
  });
  return p;
}

// Place a market/LIMIT order with SL & TP child legs (Dhan supports bracket via停止 orders)
async function placeOrderWithProtections(settings, { symbol, name, exchange = 'NSE', qty, price, slPct, tpPct, productType = 'INTRADAY' }) {
  if (!settings.dhanAccessToken || !settings.dhanClientId) throw new Error('Dhan credentials missing');
  const securityId = await resolveSecurityId(symbol, exchange);
  if (!securityId) throw new Error(`Security id not found for ${symbol}`);
  const segment = exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ';
  const correlationId = 'SA-' + Date.now().toString(36);

  const entry = {
    dhanClientId: settings.dhanClientId,
    transactionType: 'BUY',
    exchangeSegment: segment,
    productType,
    orderType: 'LIMIT',
    validity: 'DAY',
    securityId,
    quantity: qty,
    price: Number(price.toFixed(2)),
    correlationId,
    afterMarketOrder: false,
  };
  const entryRes = await httpJson(`${DHAN_BASE}/v2/orders`, {
    method: 'POST', headers: headers(settings.dhanAccessToken), body: JSON.stringify(entry), timeoutMs: 25000, retry: 0,
  });

  // protective stop-loss order
  const sl = Number((price * (1 - slPct / 100)).toFixed(2));
  const slOrder = {
    dhanClientId: settings.dhanClientId,
    transactionType: 'SELL',
    exchangeSegment: segment,
    productType,
    orderType: 'STOP_LOSS',
    validity: 'DAY',
    securityId,
    quantity: qty,
    triggerPrice: sl,
    price: Number((sl * 0.995).toFixed(2)),
    correlationId: correlationId + '-SL',
  };
  let slRes = null, slErr = null;
  try {
    slRes = await httpJson(`${DHAN_BASE}/v2/orders`, {
      method: 'POST', headers: headers(settings.dhanAccessToken), body: JSON.stringify(slOrder), timeoutMs: 25000, retry: 0,
    });
  } catch (e) { slErr = e.message; }

  return { entry: entryRes, sl: slRes, slErr, correlationId, securityId, slPrice: sl };
}

async function cancelOrder(settings, orderId) {
  return httpJson(`${DHAN_BASE}/v2/orders/${orderId}`, {
    method: 'DELETE', headers: headers(settings.dhanAccessToken), timeoutMs: 20000,
  });
}

module.exports = { testConnection, placeOrderWithProtections, resolveSecurityId, getPositions, cancelOrder, loadMaster };
