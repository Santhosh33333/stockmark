// Local account system (signup / signin). Passwords hashed with scrypt — no third-party service, no cost.
const crypto = require('crypto');
const { stmt, now } = require('./db');

const SESSION_DAYS = 30;

// Sign-in throttling. The tight limit is keyed per (IP + account) so a failed
// sign-in on one account can NEVER lock out a different account on the same
// device or network — accounts stay independent. A looser per-IP cap still stops
// an attacker from cycling through many emails. Only FAILED attempts are counted,
// so ordinary signing in/out can never trip the limit.
const attempts = new Map();          // key -> { count, first }
const MAX_ATTEMPTS = 8;              // failed tries per (IP + account) / window
const MAX_IP_ATTEMPTS = 40;          // failed tries per IP across all accounts / window
const WINDOW_MS = 10 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const acctKey = (ip, account) => 'acct:' + ip + '|' + String(account || '').toLowerCase();
function windowCount(key) {
  const rec = attempts.get(key);
  if (!rec || now() - rec.first > WINDOW_MS) return 0;
  return rec.count;
}
function bump(key) {
  const rec = attempts.get(key);
  if (!rec || now() - rec.first > WINDOW_MS) attempts.set(key, { count: 1, first: now() });
  else rec.count++;
}
// True when another attempt is allowed. `account` (email/username) scopes the
// tight limit to that one account; omit it for a pure per-IP check.
function checkRate(ip, account) {
  if (windowCount('ip:' + ip) >= MAX_IP_ATTEMPTS) return false;
  if (account && windowCount(acctKey(ip, account)) >= MAX_ATTEMPTS) return false;
  return true;
}
// Call after a FAILED sign-in or sign-up.
function noteFailure(ip, account) {
  bump('ip:' + ip);
  if (account) bump(acctKey(ip, account));
}
// Call after a successful sign-in — clears that account's failure counter.
function noteSuccess(ip, account) {
  if (account) attempts.delete(acctKey(ip, account));
}

const DEFAULT_SETTINGS = {
  mode: 'PAPER',                 // PAPER | SIGNAL | LIVE
  capital: 100000,
  qtyPct: 20,
  maxPositions: 5,
  maxTradesPerDay: 5,
  slPct: 3, tpPct: 10, maxBars: 25,
  // risk guardrails
  maxRiskPerTradePct: 1,         // % of capital risked between entry and stop
  maxDailyLossPct: 3,            // hard stop for the day
  maxDrawdownPct: 15,            // max peak-to-trough on closed trades
  killSwitch: false,             // master block on NEW opens (paper + live)
  autoScan: false, autoScanPreset: 'fno', autoScanMinutes: 30,
  telegramToken: '', telegramChat: '',
  webhookPass: '',
  dhanClientId: '', dhanAccessToken: '', dhanEnabled: false,
  dhanSandbox: false,            // route Dhan orders to the free sandbox (no real money)
  notifyBrowser: true,
  theme: 'dark',
};

// Clamp/validate the risk-bearing settings so the UI can never push an absurd
// value (e.g. 999% risk) into the engine.
const RISK_RANGES = {
  capital: [1000, 1e9], qtyPct: [1, 100], maxPositions: [1, 50], maxTradesPerDay: [1, 100],
  slPct: [0.1, 50], tpPct: [0.1, 500], maxBars: [1, 500],
  maxRiskPerTradePct: [0.1, 100], maxDailyLossPct: [0.1, 100], maxDrawdownPct: [0.5, 100],
};
function sanitizeSettings(patch) {
  const out = { ...patch };
  for (const [k, [lo, hi]] of Object.entries(RISK_RANGES)) {
    if (k in out && out[k] != null && isFinite(Number(out[k]))) out[k] = Math.min(hi, Math.max(lo, Number(out[k])));
  }
  if ('killSwitch' in out) out.killSwitch = !!out.killSwitch;
  if ('mode' in out && !['PAPER', 'SIGNAL', 'LIVE'].includes(out.mode)) delete out.mode;
  return out;
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, displayName: u.display_name || u.username.split('@')[0],
    isAdmin: !!u.is_admin, createdAt: u.created_at, lastLogin: u.last_login,
    settings: effectiveSettings(u),
  };
}
const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

function createUser({ username, password, displayName }) {
  username = String(username || '').trim().toLowerCase();
  displayName = String(displayName || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(username) && username.length < 3) throw new Error('Enter a valid email or username');
  if (String(password).length < 6) throw new Error('Password must be at least 6 characters');
  if (stmt.userByUsername.get(username)) throw new Error('Account already exists');

  const { hash, salt } = hashPassword(password);
  const info = stmt.insertUser.run(username, displayName || username.split('@')[0], hash, salt, 0, now());
  return { id: Number(info.lastInsertRowid), username, displayName: displayName || username };
}

function authenticate(username, password) {
  const u = stmt.userByUsername.get(String(username || '').trim().toLowerCase());
  if (!u || !verifyPassword(password, u.salt, u.pass_hash)) return null;
  stmt.touchLogin.run(now(), u.id);
  return u;
}

// ── sessions ─────────────────────────────────────────────────────────────
// Tokens are signed (HMAC-SHA256) so a valid token still proves who you are
// even after the sessions table is wiped — which is exactly what happens on a
// free host whose disk is ephemeral and resets on every restart. We keep the DB
// row as the source of truth but self-heal it from a valid signature, so a page
// refresh never signs you out. The secret is derived from stable server config
// so it survives restarts/redeploys too.
const SESSION_SECRET = process.env.SESSION_SECRET
  || process.env.ADMIN_PASSWORD
  || 'trademind-local-dev-secret';

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function readToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const i = token.indexOf('.');
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || !p.uid || !p.exp || p.exp < now()) return null;
  return p;
}

function createSession(userId) {
  const exp = now() + SESSION_DAYS * 86400000;
  const token = signToken({ uid: userId, exp, nonce: crypto.randomBytes(8).toString('hex') });
  stmt.insertSession.run(token, userId, now(), exp);
  return token;
}
function userForToken(token) {
  if (!token) return null;
  stmt.cleanSessions.run(now());
  const s = stmt.session.get(token);
  if (!s || s.expires_at < now()) {
    const p = readToken(token);
    if (!p) return null;
    const u = stmt.userById.get(p.uid);
    if (!u) return null;
    try { stmt.insertSession.run(token, p.uid, now(), p.exp); } catch { /* raced */ }
    return u;
  }
  return stmt.userById.get(s.user_id);
}
// True when the token is cryptographically valid (used to tell "your account is
// gone" apart from "just a stale session row").
function tokenIsValid(token) { return !!readToken(token); }
function destroySession(token) { if (token) stmt.deleteSession.run(token); }

function updateSettings(userId, patch) {
  const u = stmt.userById.get(userId);
  const merged = { ...DEFAULT_SETTINGS, ...(safeJson(u.settings) || {}), ...sanitizeSettings(patch || {}) };
  stmt.updateSettings.run(JSON.stringify(merged), userId);
  return merged;
}
const getSettings = (u) => ({ ...DEFAULT_SETTINGS, ...(safeJson(u.settings) || {}) });
const effectiveSettings = (u) => getSettings(u);

// Seeds the private owner/admin account once (credentials come from server env, never exposed by API)
function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const pass = process.env.ADMIN_PASSWORD;
  if (!email || !pass) return null;
  if (stmt.userByUsername.get(email.toLowerCase())) return null;
  const { hash, salt } = hashPassword(pass);
  const info = stmt.insertUser.run(email.toLowerCase(), 'Owner', hash, salt, 1, now());
  return { id: Number(info.lastInsertRowid), username: email };
}

// ── password reset ─────────────────────────────────────────────────────
// There is no self-service email reset. The owner resets a password from
// Admin → Users, which reuses setUserPassword below.

module.exports = { createUser, authenticate, createSession, userForToken, tokenIsValid, destroySession, updateSettings, getSettings, effectiveSettings, publicUser, DEFAULT_SETTINGS, RISK_RANGES, sanitizeSettings, checkRate, noteFailure, noteSuccess, seedAdmin, hashPassword };
