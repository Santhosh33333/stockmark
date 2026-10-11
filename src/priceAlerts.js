// User-defined price alerts — free, zero-key.
//
// A rule is { symbol, condition: 'above'|'below', target }. Rules are one-shot:
// when a rule triggers it is recorded (feed + audit-friendly signal row), the
// owner is notified (in-app feed, optional Telegram) and the rule auto-disarms
// so it never spams. The user can re-arm any rule at any time.
//
// Evaluation uses the same free provider facade as the rest of the app
// (Angel One → Fyers → Tapetide → Yahoo). No price is ever invented: a rule
// only fires when a real quote is available.
const { stmt, now } = require('./db');

const CONDITIONS = new Set(['above', 'below']);

function normalizeSymbol(s) { return String(s || '').trim().toUpperCase(); }
// Yahoo needs an exchange suffix for equities; indices (^...) already qualify.
function toLookup(sym) {
  const s = normalizeSymbol(sym);
  if (!s) return s;
  if (s.startsWith('^') || /\.(NS|BO)$/.test(s)) return s;
  return s + '.NS';
}

function ruleMatches(rule, price) {
  if (!isFinite(price) || price <= 0) return false;
  return rule.condition === 'above' ? price >= Number(rule.target) : price <= Number(rule.target);
}

function fire(rule, price) {
  const cmp = rule.condition === 'above' ? '≥' : '≤';
  const reason = `Price alert: ₹${price} ${cmp} ₹${rule.target}` + (rule.note ? ` · ${rule.note}` : '');
  stmt.markAlertTriggered.run(price, now(), now(), rule.id);
  try {
    stmt.addSignal.run(rule.user_id, rule.symbol, rule.name || '', 'NSE', price, 'ALERT', reason,
      JSON.stringify({ ruleId: rule.id, condition: rule.condition, target: rule.target }), now());
  } catch { /* feed is best-effort */ }
  return {
    id: rule.id, userId: rule.user_id, symbol: rule.symbol, condition: rule.condition,
    target: Number(rule.target), price, note: rule.note || '', triggeredAt: now(),
  };
}

// Evaluate a set of already-fetched rules against a { SYMBOL: price } map.
function runRules(rules, priceMap) {
  const fired = [];
  for (const r of rules) {
    const direct = priceMap[r.symbol];
    const viaSuffix = priceMap[toLookup(r.symbol)];
    const px = direct != null ? direct : viaSuffix;
    if (ruleMatches(r, px)) fired.push(fire(r, px));
  }
  return fired;
}

// Turn a rule row into the public shape the UI consumes.
function shape(r) {
  if (!r) return null;
  return {
    id: r.id, symbol: r.symbol, name: r.name || '', condition: r.condition,
    target: Number(r.target), note: r.note || '', enabled: !!r.enabled,
    createdAt: r.created_at, lastPrice: r.last_price, lastChecked: r.last_checked,
    triggeredAt: r.triggered_at, triggerCount: r.trigger_count,
  };
}

// Fetch real quotes for a list of user symbols → { SYMBOL: price }.
async function priceMapFor(symbols) {
  const market = require('./providers');
  const uniq = [...new Set(symbols.map(normalizeSymbol))];
  if (!uniq.length) return {};
  const quotes = await market.fetchQuotes(uniq.map(toLookup), { concurrency: 6 });
  const out = {};
  for (const s of uniq) {
    const q = quotes[toLookup(s)] || quotes[s];
    const px = q && (q.price != null ? q.price : q.regularMarketPrice);
    if (px != null && isFinite(Number(px))) out[s] = Number(px);
  }
  return out;
}

// Best-effort Telegram push to each affected owner (only when configured).
async function pushTelegram(fired) {
  if (!fired.length) return;
  let auth;
  try { auth = require('./auth'); } catch { return; }
  const notify = require('./notify');
  const byUser = new Map();
  for (const f of fired) {
    if (!byUser.has(f.userId)) byUser.set(f.userId, []);
    byUser.get(f.userId).push(f);
  }
  for (const [userId, list] of byUser) {
    try {
      const u = stmt.userById.get(userId);
      if (!u) continue;
      const settings = auth.getSettings(u);
      if (!settings || !settings.telegramToken) continue;
      const text = list.map((f) => `🔔 <b>${f.symbol}</b> ${f.condition === 'above' ? '≥' : '≤'} ₹${f.target}\n` +
        `Price: ₹${f.price}${f.note ? `\n${f.note}` : ''}`).join('\n\n');
      await notify.sendTelegram(settings, text);
    } catch { /* best-effort */ }
  }
}

// Evaluate one user's armed rules using live quotes. Returns the fired list.
async function evaluateUser(userId) {
  const rules = stmt.enabledAlertsForUser.all(userId);
  if (!rules.length) return [];
  let map = {};
  try { map = await priceMapFor(rules.map((r) => r.symbol)); } catch { return []; }
  const fired = runRules(rules, map);
  if (fired.length) pushTelegram(fired).catch(() => { });
  return fired;
}

// Evaluate a supplied { SYMBOL: price } map against one user's armed rules.
// Lets the client evaluate against prices it already holds (e.g. from the SSE
// stream) without a second upstream fetch.
function evaluateWithPrices(userId, priceMap) {
  const rules = stmt.enabledAlertsForUser.all(userId);
  if (!rules.length) return [];
  const fired = runRules(rules, priceMap || {});
  if (fired.length) pushTelegram(fired).catch(() => { });
  return fired;
}

// Evaluate every armed rule in the database (used by the gentle background
// poller so alerts still fire when no browser tab is open).
async function pollAll() {
  const rules = stmt.enabledAlerts.all();
  if (!rules.length) return [];
  let map = {};
  try { map = await priceMapFor(rules.map((r) => r.symbol)); } catch { return []; }
  const fired = runRules(rules, map);
  if (fired.length) pushTelegram(fired).catch(() => { });
  return fired;
}

let timer = null;
function start(intervalMs) {
  const ms = Number(intervalMs) || 0;
  if (timer || ms <= 0) return;
  timer = setInterval(() => { pollAll().catch(() => { }); }, ms);
  if (timer.unref) timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  CONDITIONS, normalizeSymbol, toLookup, ruleMatches, shape,
  evaluateUser, evaluateWithPrices, priceMapFor, pollAll, start, stop,
};
