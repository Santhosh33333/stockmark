// Account API: signup/signin, profile, watchlist, paper trading, Dhan live execution, alerts.
const express = require('express');
const auth = require('../auth');
const { stmt, now, config } = require('../db');
const paper = require('../paper');
const dhan = require('../dhan');
const options = require('../providers/options');
const optionsAnalytics = require('../optionsAnalytics');
const market = require('../providers');
const priceAlerts = require('../priceAlerts');
const notify = require('../notify');
const scanner = require('../scanner');
const { inr, marketStatus } = require('../util');

const router = express.Router();

// ── session middleware ──────────────────────────────────────────────────
function attachUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = (header.startsWith('Bearer ') && header.slice(7)) || parseCookie(req.headers.cookie, 'sa_token');
  const user = auth.userForToken(token);
  req.token = token;
  req.user = user;
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Owner only' });
  next();
}
const parseCookie = (header = '', name) => {
  const m = header.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
};
// Session cookie. `secure` follows the request scheme, so an HTTPS deployment gets
// a Secure cookie while local http still works (we trust x-forwarded-proto).
function setSessionCookie(req, res, token) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = req.secure || proto === 'https';
  res.cookie('sa_token', token, { httpOnly: true, sameSite: 'lax', secure, maxAge: 30 * 86400000 });
}
router.use(attachUser);

// ── auth ─────────────────────────────────────────────────────────────────
router.post('/auth/signup', async (req, res) => {
  const ip = req.ip;
  if (!auth.checkRate(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  if (!config.allowSignup) return res.status(403).json({ error: 'Sign-ups are disabled on this deployment' });
  try {
    const body = req.body || {};
    const username = (body.email || body.username || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(username)) return res.status(400).json({ error: 'Enter a valid email address' });
    const u = auth.createUser({ ...body, username });
    const token = auth.createSession(u.id);
    setSessionCookie(req, res, token);
    res.json({ token, user: auth.publicUser(u) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Step 2 of signup: verify the email OTP → session issued
router.post('/auth/verify-otp', (req, res) => {
  const { email, code, purpose = 'signup' } = req.body || {};
  const out = auth.verifyOtp(email, code, purpose);
  if (!out.ok) return res.status(400).json({ error: out.error });
  const token = auth.createSession(out.user.id);
  stmt.log.run(out.user.id, 'EMAIL VERIFIED', 'OTP verified', now());
  setSessionCookie(req, res, token);
  res.json({ token, user: auth.publicUser(out.user) });
});

router.post('/auth/resend-otp', async (req, res) => {
  try {
    const { email, purpose = 'signup' } = req.body || {};
    const out = await auth.sendOtp(email, purpose);
    res.json({ ok: true, sent: out.sent.ok, dev: out.code || null, email: out.email });
  } catch (e) { res.status(429).json({ error: e.message }); }
});

router.post('/auth/login', async (req, res) => {
  const ip = req.ip;
  if (!auth.checkRate(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  const { email, username, password } = req.body || {};
  const u = auth.authenticate(username || email, password);
  if (!u) return res.status(401).json({ error: 'Invalid email or password' });
  const token = auth.createSession(u.id);
  setSessionCookie(req, res, token);
  res.json({ token, user: auth.publicUser(u) });
});

// Step 2 of login: verify OTP → session
router.post('/auth/verify-login-otp', (req, res) => {
  const { email, code } = req.body || {};
  const out = auth.verifyOtp(email, code, 'login');
  if (!out.ok) return res.status(400).json({ error: out.error });
  const token = auth.createSession(out.user.id);
  setSessionCookie(req, res, token);
  res.json({ token, user: auth.publicUser(out.user) });
});

router.get('/mail/status', (_req, res) => {
  const mailer = require('../mailer');
  res.json({ mail: mailer.status(), otpTtl: config.otp.ttlMinutes });
});

// Owner can paste FREE sender credentials here (Brevo key or Gmail app password)
router.post('/admin/mail-config', requireAdmin, (req, res) => {
  const mailer = require('../mailer');
  const patch = {};
  const b = req.body || {};
  if (b.provider) patch.provider = b.provider;
  if (b.from) patch.from = b.from;
  if (b.fromName) patch.fromName = b.fromName;
  if (b.brevoKey) patch.brevoKey = b.brevoKey;
  if (b.smtp) patch.smtp = b.smtp;
  const status = mailer.saveRuntimeConfig(patch);
  stmt.log.run(req.user.id, 'MAIL CONFIG', status.provider, now());
  res.json({ ok: true, mail: status });
});

router.post('/admin/mail-test', requireAdmin, async (req, res) => {
  try {
    const mailer = require('../mailer');
    const out = await auth.sendOtp(req.user.username, 'login');
    res.json({ ok: out.sent.ok, provider: out.sent.provider, dev: out.code || null, error: out.sent.error });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/auth/logout', (req, res) => {
  auth.destroySession(req.token);
  res.clearCookie('sa_token');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: auth.publicUser(req.user) });
});

// Update profile (display name). Email/username is the login identity and is
// intentionally not editable here.
router.patch('/me', requireUser, (req, res) => {
  const body = req.body || {};
  if (body.displayName != null) {
    const name = String(body.displayName).trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Display name cannot be empty' });
    stmt.updateDisplayName.run(name, req.user.id);
  }
  const fresh = stmt.userById.get(req.user.id);
  res.json({ user: auth.publicUser(fresh) });
});

router.put('/me/settings', requireUser, (req, res) => {
  const s = auth.updateSettings(req.user.id, req.body || {});
  res.json({ settings: s });
});

// ── watchlist ───────────────────────────────────────────────────────────
router.get('/watchlist', requireUser, async (req, res) => {
  const rows = stmt.watchlist.all(req.user.id).map((r) => r.symbol);
  // Yahoo needs the exchange suffix; key the response back by the bare symbol.
  const yahooSyms = rows.map((s) => (s.includes('.') ? s : `${s}.NS`));
  const quotes = rows.length ? await market.fetchQuotes(yahooSyms, { concurrency: 6 }) : {};
  const list = rows.map((sym, i) => {
    const yahooSym = yahooSyms[i];
    const q = quotes[yahooSym] || quotes[sym] || {};
    const cached = scanner.getSymbolRow(yahooSym) || scanner.getSymbolRow(sym);
    return {
      symbol: sym, price: q.price ?? null, change: q.change ?? null,
      changePct: q.change != null && q.prevClose ? +((q.change / q.prevClose) * 100).toFixed(2) : null,
      rsi4h: cached?.rsi4h ?? null, lastSignal: cached?.lastSignal ?? null,
      activeZones: cached?.activeZones ?? [],
    };
  });
  res.json({ watchlist: list });
});

router.post('/watchlist', requireUser, (req, res) => {
  const symbol = String(req.body?.symbol || '').toUpperCase().replace(/[^A-Z0-9.&-]/g, '');
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  stmt.addWatch.run(req.user.id, symbol, now());
  res.json({ ok: true });
});

router.delete('/watchlist/:symbol', requireUser, (req, res) => {
  stmt.delWatch.run(req.user.id, String(req.params.symbol).toUpperCase());
  res.json({ ok: true });
});

// ── paper trading ───────────────────────────────────────────────────────
router.get('/paper/stats', requireUser, async (req, res) => {
  const stats = paper.portfolioStats(req.user.id);
  const settings = auth.getSettings(req.user);
  const open = stmt.openTrades.all(req.user.id);
  const quotes = open.length ? await market.fetchQuotes(open.map((t) => (t.symbol.includes('.') ? t.symbol : `${t.symbol}.NS`)), { concurrency: 6 }) : {};
  const positions = open.map((t) => {
    const ySym = t.symbol.includes('.') ? t.symbol : `${t.symbol}.NS`;
    const q = quotes[ySym] || quotes[t.symbol] || {};
    const px = q.price ?? t.entry_price;
    return {
      ...t,
      ltp: px,
      pnl: +((px - t.entry_price) * t.qty).toFixed(2),
      pnlPct: +(((px - t.entry_price) / t.entry_price) * 100).toFixed(2),
      pnlFmt: inr((px - t.entry_price) * t.qty, true),
    };
  });
  res.json({ stats, positions, capital: settings.capital, mode: settings.mode });
});

// Paper trade history as CSV (safe escaping; opens in Excel/Sheets).
router.get('/paper/export.csv', requireUser, (req, res) => {
  const trades = stmt.trades.all(req.user.id, 100000);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const iso = (ts) => (ts ? new Date(ts).toISOString() : '');
  const head = ['id', 'symbol', 'name', 'qty', 'entry_price', 'entry_ts', 'exit_price', 'exit_ts', 'sl', 'tp', 'status', 'exit_reason', 'pnl', 'pnl_pct', 'mode'];
  const lines = [head.join(',')];
  for (const t of trades) {
    const pnlPct = t.status === 'CLOSED' && t.entry_price ? (((t.exit_price - t.entry_price) / t.entry_price) * 100).toFixed(2) : '';
    lines.push([
      t.id, esc(t.symbol), esc(t.name), t.qty, t.entry_price, iso(t.entry_ts),
      t.exit_price ?? '', iso(t.exit_ts), t.sl, t.tp, t.status, esc(t.exit_reason), t.pnl ?? '', pnlPct, t.mode,
    ].join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="trademind-paper-trades.csv"`);
  res.send(lines.join('\n'));
});

router.post('/paper/open', requireUser, (req, res) => {
  const settings = auth.getSettings(req.user);
  const symbol = String(req.body?.symbol || '').toUpperCase();
  const price = Number(req.body?.price);
  if (!symbol || !isFinite(price) || price <= 0) return res.status(400).json({ error: 'Symbol and valid price required' });
  if (settings.mode === 'LIVE') {
    return res.status(403).json({ error: 'Mode is LIVE — use /api/dhan/order instead' });
  }
  const out = paper.openTrade(req.user.id, { symbol, name: req.body?.name || symbol, price, settings });
  if (!out.ok) {
    stmt.log.run(req.user.id, 'PAPER ORDER BLOCKED', `${symbol} — ${(out.problems || []).join('; ')}`, now());
    return res.status(400).json({ error: out.problems.join(', '), ...out });
  }
  notify.recordSignal(req.user.id, { symbol, name: symbol, exchange: 'NSE', price }, `Paper trade opened @ ₹${price}`);
  res.json({ ok: true, trade: out.trade, exposure: out.exposure });
});

router.post('/paper/close', requireUser, (req, res) => {
  const id = Number(req.body?.id);
  const price = Number(req.body?.price);
  const t = id ? stmt.tradeById.get(id) : null;
  if (!t || t.user_id !== req.user.id) return res.status(404).json({ error: 'Trade not found' });
  const closed = paper.closeTrade(t.id, isFinite(price) && price > 0 ? price : t.entry_price, 'MANUAL');
  res.json({ ok: true, trade: closed });
});

router.post('/paper/evaluate', requireUser, async (_req, res) => {
  const closed = await paper.evaluateOpenPositions(async (sym) => {
    const q = await market.fetchQuote(sym);
    return q.price;
  });
  res.json({ ok: true, closed: closed.map((c) => ({ ...c, pnlFmt: inr(c.pnl, true) })) });
});

// Auto-paper-trade every fresh BUY signal (runs after scan)
router.post('/paper/auto', requireUser, async (req, res) => {
  const settings = auth.getSettings(req.user);
  if (settings.mode !== 'PAPER') return res.status(400).json({ error: 'Enable PAPER mode to auto-trade' });
  const { rows = [] } = req.body || {};
  const opened = [];
  for (const r of rows) {
    if (r.mode === 'SIGNAL') continue;
    const out = paper.openTrade(req.user.id, { symbol: r.symbol, name: r.name, price: r.price, settings });
    if (out.ok) opened.push(out.trade);
  }
  res.json({ ok: true, opened });
});

// ── alerts feed ─────────────────────────────────────────────────────────
router.get('/alerts/history', requireUser, (req, res) => {
  const userId = req.user.is_admin ? (req.query.all ? null : req.user.id) : req.user.id;
  const rows = userId ? stmt.signals.all(userId, Number(req.query.limit || 100)) : stmt.signalsAll.all(Number(req.query.limit || 100));
  res.json({ alerts: rows });
});

router.post('/alerts/telegram-test', requireUser, async (req, res) => {
  const settings = auth.getSettings(req.user);
  const out = await notify.sendTelegram(settings, '✅ <b>TradeMind</b> connected — alerts will arrive here.');
  res.json(out);
});

// ── user-defined price alerts (free; real quotes only) ──────────────────
router.get('/alerts/rules', requireUser, (req, res) => {
  res.json({ rules: stmt.priceAlerts.all(req.user.id).map(priceAlerts.shape) });
});

router.post('/alerts/rules', requireUser, (req, res) => {
  const b = req.body || {};
  const symbol = priceAlerts.normalizeSymbol(b.symbol);
  const condition = String(b.condition || '').toLowerCase();
  const target = Number(b.target);
  if (!symbol) return res.status(400).json({ error: 'Symbol is required' });
  if (!priceAlerts.CONDITIONS.has(condition)) return res.status(400).json({ error: "Condition must be 'above' or 'below'" });
  if (!isFinite(target) || target <= 0) return res.status(400).json({ error: 'Target must be a positive number' });
  const info = stmt.addPriceAlert.run(req.user.id, symbol, String(b.name || '').slice(0, 80), condition, target, String(b.note || '').slice(0, 200), now());
  const rule = priceAlerts.shape(stmt.priceAlertById.get(info.lastInsertRowid));
  res.json({ ok: true, id: rule.id, rule });
});

router.post('/alerts/rules/:id/toggle', requireUser, (req, res) => {
  const r = stmt.priceAlertById.get(Number(req.params.id));
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'Alert not found' });
  const enabled = req.body && req.body.enabled != null ? (req.body.enabled ? 1 : 0) : (r.enabled ? 0 : 1);
  stmt.setAlertEnabled.run(enabled, r.id, req.user.id);
  res.json({ ok: true, enabled: !!enabled });
});

router.delete('/alerts/rules/:id', requireUser, (req, res) => {
  stmt.deletePriceAlert.run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// Evaluate this user's armed rules. The client may pass { prices } it already
// holds (e.g. from the SSE stream); otherwise the server fetches real quotes.
router.post('/alerts/rules/eval', requireUser, async (req, res) => {
  try {
    const prices = req.body && req.body.prices;
    const fired = prices && typeof prices === 'object'
      ? priceAlerts.evaluateWithPrices(req.user.id, prices)
      : await priceAlerts.evaluateUser(req.user.id);
    res.json({ ok: true, fired });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, fired: [] });
  }
});

// TradingView webhook (free): paste this URL into a TradingView alert
router.post('/webhook/tradingview', (req, res) => {
  const body = req.body || {};
  const pass = req.query.pass || body.passphrase || '';
  const users = stmt.allUsers.all().filter((u) => auth.getSettings(u).webhookPass && auth.getSettings(u).webhookPass === pass);
  if (!users.length) return res.status(401).json({ error: 'Invalid webhook passphrase' });
  for (const u of users) {
    const s = auth.getSettings(u);
    stmt.addSignal.run(u.id, String(body.symbol || body.ticker || 'UNKNOWN').toUpperCase(), body.name || '', body.exchange || 'NSE',
      Number(body.price || body.close || 0), String(body.action || body.direction || 'BUY').toUpperCase(), body.strategy || 'TradingView webhook',
      JSON.stringify(body), now());
    if (s.mode === 'LIVE' && s.dhanEnabled && s.dhanAccessToken) {
      dhan.placeOrderWithProtections(s, {
        symbol: String(body.symbol || '').toUpperCase(),
        qty: Number(body.qty || 1), price: Number(body.price || body.close || 0),
        slPct: s.slPct, tpPct: s.tpPct,
      }).catch(() => { });
    }
    if (s.mode === 'PAPER') {
      paper.openTrade(u.id, { symbol: String(body.symbol || 'X').toUpperCase(), price: Number(body.price || body.close || 0), settings: s });
    }
    notify.sendTelegram(s, notify.formatSignalMessage(body)).catch(() => { });
  }
  res.json({ ok: true });
});

// ── Option chain (Dhan when configured, else free NSE fallback) ──────────
router.get('/options/:symbol', requireUser, async (req, res) => {
  try {
    const settings = auth.getSettings(req.user);
    const out = await options.getOptionChain({
      settings, symbol: req.params.symbol, expiry: req.query.expiry,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, attempts: e.attempts || [] });
  }
});

// Enriched chain: Black-Scholes greeks, max pain, OI analysis, IV rank.
router.get('/options/:symbol/analytics', requireUser, async (req, res) => {
  try {
    const settings = auth.getSettings(req.user);
    const chain = await options.getOptionChain({ settings, symbol: req.params.symbol, expiry: req.query.expiry });
    const enriched = optionsAnalytics.enrichChain(chain, { r: Number(req.query.r) || optionsAnalytics.RISK_FREE });
    res.json({ ok: true, ...enriched, cached: chain.cached || false, attempts: chain.attempts || [] });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, attempts: e.attempts || [] });
  }
});

// Expiry comparison (spec E): nearest expiries side by side — ATM IV, IV skew,
// PCR, max pain, OI and volume. NSE publishes one chain per expiry and
// rate-limits, so this fetches the nearest `count` expiries sequentially and
// relies on the provider cache (25s) + NSE session memo. Per-expiry failures
// degrade to an error row rather than failing the whole response.
router.get('/options/:symbol/expiries/compare', requireUser, async (req, res) => {
  try {
    const settings = auth.getSettings(req.user);
    const count = Math.max(2, Math.min(5, Number(req.query.count) || 3));
    const first = await options.getOptionChain({ settings, symbol: req.params.symbol });
    const avail = first.expiries || [];
    const list = avail.slice(0, count);
    const under = first.underlyingValue ?? null;
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      const exp = list[i];
      try {
        const chain = exp === first.expiry
          ? first
          : await options.getOptionChain({ settings, symbol: req.params.symbol, expiry: exp });
        const e = optionsAnalytics.enrichChain(chain);
        const sum = (leg, k) => (e.strikes || []).reduce((a, s) => a + (s[leg] && s[leg][k] != null ? s[leg][k] : 0), 0);
        const ts = optionsAnalytics.expiryTs(exp);
        rows.push({
          expiry: exp,
          daysToExpiry: ts ? Math.round((ts - Date.now()) / 86400000) : null,
          atmStrike: e.atm ?? null,
          atmIV: e.atmIV ?? null,
          ivSkew: e.ivSkew ?? null,
          pcr: e.pcr ?? null,
          maxPain: e.maxPain ? e.maxPain.strike : null,
          ceOi: sum('ce', 'oi'), peOi: sum('pe', 'oi'),
          ceOiChange: sum('ce', 'oiChange'), peOiChange: sum('pe', 'oiChange'),
          ceVolume: sum('ce', 'volume'), peVolume: sum('pe', 'volume'),
          strikes: (e.strikes || []).length,
        });
      } catch (err) {
        rows.push({ expiry: exp, error: err.message });
      }
    }
    res.json({
      ok: true, symbol: first.symbol, source: first.source, underlyingValue: under,
      expiries: rows, availableExpiries: avail, generatedAt: now(),
      note: 'Nearest expiries only — NSE publishes one chain per expiry and rate-limits requests; each chain is cached ~25s.',
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: `Expiry comparison failed: ${e.message}` });
  }
});

// Options strategy builder: expiry payoff, max profit/loss, breakevens.
// Body: { legs:[{type,strike,qty,premium}], underlying, lotSize }
router.post('/options/strategy/payoff', requireUser, (req, res) => {
  const { legs = [], underlying = null, lotSize = 1 } = req.body || {};
  const out = optionsAnalytics.payoff(legs, { underlying, lotSize: Number(lotSize) || 1 });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

// ── Dhan live execution ─────────────────────────────────────────────────
router.post('/dhan/test', requireUser, async (req, res) => {
  const settings = auth.getSettings(req.user);
  const out = await dhan.testConnection(settings);
  res.json(out);
});

router.post('/dhan/order', requireUser, async (req, res) => {
  const settings = auth.getSettings(req.user);
  if (settings.mode !== 'LIVE' || !settings.dhanEnabled) {
    return res.status(403).json({ error: 'Switch to LIVE mode and enable Dhan in settings first' });
  }
  if (settings.killSwitch) return res.status(403).json({ error: 'Kill switch is ON — live orders are blocked' });
  const { symbol, qty, price, slPct, tpPct, exchange } = req.body || {};
  try {
    const q = Number(qty || 1);
    const check = paper.riskCheck(settings, symbol, Number(price), q, req.user.id);
    if (!check.ok) {
      stmt.log.run(req.user.id, 'LIVE ORDER BLOCKED', `${symbol} — ${check.problems.join('; ')}`, now());
      return res.status(400).json({ error: check.problems.join(', '), problems: check.problems });
    }
    const out = await dhan.placeOrderWithProtections(settings, {
      symbol, name: symbol, exchange: exchange || 'NSE', qty: q, price: Number(price),
      slPct: Number(slPct || settings.slPct), tpPct: Number(tpPct || settings.tpPct),
    });
    const info = stmt.addTrade.run(req.user.id, symbol, symbol, q, Number(price), now(),
      Number(price) * (1 - (Number(slPct || settings.slPct)) / 100),
      Number(price) * (1 + (Number(tpPct || settings.tpPct)) / 100), 'LIVE');
    stmt.log.run(req.user.id, 'LIVE ORDER', `${symbol} qty ${qty} @ ${price} | ${JSON.stringify(out)}`, now());
    res.json({ ok: true, dhan: out, tradeId: Number(info.lastInsertRowid) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── risk management: live state + kill switch ───────────────────────────
router.get('/risk/state', requireUser, (req, res) => {
  const settings = auth.getSettings(req.user);
  const snap = paper.riskSnapshot(req.user.id);
  const capital = Number(settings.capital || 100000);
  res.json({
    capital,
    mode: settings.mode,
    killSwitch: !!settings.killSwitch,
    limits: {
      maxRiskPerTradePct: settings.maxRiskPerTradePct,
      maxDailyLossPct: settings.maxDailyLossPct,
      maxDrawdownPct: settings.maxDrawdownPct,
      maxPositions: settings.maxPositions,
      slPct: settings.slPct, tpPct: settings.tpPct,
    },
    usage: {
      dayPnl: snap.dayPnl,
      dayPnlFmt: inr(snap.dayPnl, true),
      dailyLossLimit: +(capital * (Number(settings.maxDailyLossPct || 3) / 100)).toFixed(2),
      maxDrawdown: snap.maxDrawdown,
      drawdownLimit: +(capital * (Number(settings.maxDrawdownPct || 15) / 100)).toFixed(2),
      openCount: snap.openCount,
      tradesToday: snap.tradesToday,
      dailyLossBreached: snap.dayPnl <= -(capital * (Number(settings.maxDailyLossPct || 3) / 100)),
      drawdownBreached: snap.maxDrawdown >= capital * (Number(settings.maxDrawdownPct || 15) / 100),
    },
  });
});

router.post('/risk/kill', requireUser, (req, res) => {
  const on = !!(req.body && req.body.on);
  const s = auth.updateSettings(req.user.id, { killSwitch: on });
  stmt.log.run(req.user.id, 'KILL SWITCH', on ? 'ON — new positions blocked' : 'OFF', now());
  res.json({ ok: true, killSwitch: !!s.killSwitch });
});

// ── owner / admin console ───────────────────────────────────────────────
router.get('/admin/overview', requireAdmin, (_req, res) => {
  const dayAgo = now() - 86400000, weekAgo = now() - 7 * 86400000;
  const mem = process.memoryUsage();
  const mailer = require('../mailer');
  res.json({
    server: {
      uptimeSec: Math.round(process.uptime()), memoryMB: +(mem.rss / 1048576).toFixed(1),
      node: process.version, pid: process.pid, port: config.port, startedAt: now() - Math.round(process.uptime() * 1000),
    },
    market: marketStatus(),
    users: { total: stmt.countUsers.get().c, admins: stmt.countAdmins.get().c, last7d: stmt.countUsersSince.get(weekAgo).c },
    sessions: stmt.countSessions.get(now()).c,
    signals: { total: stmt.countSignals.get().c, last24h: stmt.countSignalsSince.get(dayAgo).c },
    trades: { total: stmt.countTrades.get().c, open: stmt.countOpenTrades.get().c },
    scan: { cachedSymbols: stmt.countScan.get().c, lastScanAt: stmt.lastScanAt.get().m || null },
    mail: mailer.status(),
  });
});

router.get('/admin/users', requireAdmin, (_req, res) => {
  const users = stmt.allUsers.all().map((u) => {
    const full = stmt.userById.get(u.id);
    const trades = stmt.trades.all(u.id, 100000);
    const closed = trades.filter((t) => t.status === 'CLOSED');
    return {
      id: u.id, email: u.username, displayName: u.display_name, isAdmin: !!u.is_admin,
      createdAt: u.created_at, lastLogin: u.last_login, verified: !!full?.email_verified,
      trades: {
        total: trades.length, open: trades.filter((t) => t.status === 'OPEN').length, closed: closed.length,
        netPnl: +closed.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2),
      },
      signals: stmt.signals.all(u.id, 100000).length,
      watchlist: stmt.watchlist.all(u.id).length,
    };
  });
  res.json({ users, total: users.length });
});

router.patch('/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = stmt.userById.get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  if (b.isAdmin != null) {
    const makeAdmin = !!b.isAdmin;
    if (!makeAdmin && u.is_admin) {
      if (id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own owner role' });
      if (stmt.countAdmins.get().c <= 1) return res.status(400).json({ error: 'At least one owner must remain' });
    }
    stmt.setUserRole.run(makeAdmin ? 1 : 0, id);
    stmt.log.run(req.user.id, 'ADMIN ROLE', `${u.username} → ${makeAdmin ? 'owner' : 'user'}`, now());
  }
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const { hash, salt } = auth.hashPassword(b.password);
    stmt.setUserPassword.run(hash, salt, id);
    stmt.log.run(req.user.id, 'ADMIN PASSWORD RESET', u.username, now());
  }
  const fresh = stmt.userById.get(id);
  res.json({ ok: true, user: { id: fresh.id, email: fresh.username, isAdmin: !!fresh.is_admin } });
});

router.delete('/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = stmt.userById.get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (u.is_admin && stmt.countAdmins.get().c <= 1) return res.status(400).json({ error: 'At least one owner must remain' });
  stmt.deleteUserWatch.run(id);
  stmt.deleteUserTrades.run(id);
  stmt.deleteUserSignals.run(id);
  stmt.deleteUserSessions.run(id);
  stmt.deleteUser.run(id);
  stmt.log.run(req.user.id, 'ADMIN DELETE USER', u.username, now());
  res.json({ ok: true, deleted: u.username });
});

router.get('/admin/logs', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Number(req.query.offset || 0);
  const rows = stmt.logs.all(limit, offset).map((r) => ({
    ...r, email: r.user_id ? (stmt.userById.get(r.user_id)?.username || null) : null,
  }));
  res.json({ logs: rows, limit, offset });
});

router.get('/admin/trades', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  res.json({ trades: stmt.allTradesAdmin.all(limit).map((t) => ({ ...t, pnlFmt: t.pnl != null ? inr(t.pnl, true) : null })) });
});

router.get('/admin/signals', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  res.json({ signals: stmt.allSignalsAdmin.all(limit) });
});

router.get('/admin/jobs', requireAdmin, (_req, res) => {
  res.json({ jobs: scanner.listJobs() });
});

router.get('/admin/health', requireAdmin, async (_req, res) => {
  const t0 = Date.now();
  let provider;
  try {
    const q = await market.fetchQuote('^NSEI');
    const src = q.source || market.providerStatus().lastUsed.quote || 'yahoo';
    provider = { ok: q.price != null, name: src, probe: '^NSEI', price: q.price, currency: q.currency, latencyMs: Date.now() - t0 };
  } catch (e) {
    provider = { ok: false, name: 'none', probe: '^NSEI', error: e.message, latencyMs: Date.now() - t0 };
  }
  const mailer = require('../mailer');
  res.json({ provider, market: marketStatus(), mail: mailer.status(), checkedAt: now() });
});

// ── data providers (owner only): free sources + credential management ─────
router.get('/providers/status', requireAdmin, (_req, res) => {
  try { res.json(market.providerStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/providers/credentials', requireAdmin, (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.order) patch.order = body.order;
  if (body.angelone) {
    const a = body.angelone;
    patch.angelone = {};
    for (const k of ['enabled', 'apiKey', 'clientCode', 'pin', 'totpSecret', 'totp']) {
      if (k in a) patch.angelone[k] = a[k];
    }
  }
  if (body.fyers) {
    const f = body.fyers;
    patch.fyers = {};
    for (const k of ['enabled', 'appId', 'accessToken']) {
      if (k in f) patch.fyers[k] = f[k];
    }
  }
  if (body.tapetide) {
    const t = body.tapetide;
    patch.tapetide = {};
    for (const k of ['enabled', 'token']) {
      if (k in t) patch.tapetide[k] = t[k];
    }
  }
  try {
    const store = require('../providers/store');
    store.save(patch);
    res.json({ ok: true, status: market.providerStatus() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/providers/test', requireAdmin, async (req, res) => {
  const id = String(req.body?.id || '');
  try { res.json(await market.testProvider(id)); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Public freshness/source indicator (no secrets) for the topbar.
router.get('/providers/source', (_req, res) => {
  const s = market.providerStatus();
  const dq = require('../dataquality');
  const lastSource = s.lastUsed.quote || s.lastUsed.chart || s.active[0] || 'yahoo';
  res.json({
    active: s.active, order: s.order, lastUsed: s.lastUsed, checkedAt: now(),
    quality: dq.classify({ source: lastSource }),
  });
});

router.post('/admin/scan', requireAdmin, async (req, res) => {
  const { preset = 'fno', opts = {} } = req.body || {};
  try {
    const job = await scanner.startScan({ preset, opts, userId: req.user.id, scanCache: true });
    res.json({ jobId: job.id, total: job.total, preset });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { router };
