// Local account system (signup / signin). Passwords hashed with scrypt — no third-party service, no cost.
const crypto = require('crypto');
const { stmt, now, config } = require('./db');

const SESSION_DAYS = 30;
const loginAttempts = new Map();   // ip -> {count, first}
const MAX_ATTEMPTS = 8, WINDOW_MS = 10 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkRate(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || now() - rec.first > WINDOW_MS) { loginAttempts.set(ip, { count: 1, first: now() }); return true; }
  rec.count++;
  return rec.count <= MAX_ATTEMPTS;
}

const DEFAULT_SETTINGS = {
  mode: 'PAPER',                 // PAPER | SIGNAL | LIVE
  loginOtp: true,                // email OTP on every sign-in
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
    settings: { ...DEFAULT_SETTINGS, ...(safeJson(u.settings) || {}) },
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

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  stmt.insertSession.run(token, userId, now(), now() + SESSION_DAYS * 86400000);
  return token;
}
function userForToken(token) {
  if (!token) return null;
  stmt.cleanSessions.run(now());
  const s = stmt.session.get(token);
  if (!s || s.expires_at < now()) return null;
  return stmt.userById.get(s.user_id);
}
function destroySession(token) { if (token) stmt.deleteSession.run(token); }

function updateSettings(userId, patch) {
  const u = stmt.userById.get(userId);
  const merged = { ...DEFAULT_SETTINGS, ...(safeJson(u.settings) || {}), ...sanitizeSettings(patch || {}) };
  stmt.updateSettings.run(JSON.stringify(merged), userId);
  return merged;
}
const getSettings = (u) => ({ ...DEFAULT_SETTINGS, ...(safeJson(u.settings) || {}) });

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

// ── Email OTP (free senders) ────────────────────────────────────────────
async function sendOtp(email, purpose = 'signup') {
  email = String(email || '').trim().toLowerCase();
  const { isValidEmail } = require('./otp/validator');
  if (!isValidEmail(email)) throw new Error('Enter a valid email address');

  // resend cooldown
  const recent = stmt.latestOtp.get(email, purpose);
  if (recent && now() - recent.created_at < config.otp.resendCooldownSec * 1000) {
    const wait = Math.ceil((config.otp.resendCooldownSec * 1000 - (now() - recent.created_at)) / 1000);
    throw new Error(`Please wait ${wait}s before requesting another code`);
  }

  const { isSpam } = require('./otp/spamGuard');
  const mailer = require('./mailer');
  const otpType = cfgOtpType(mailer);
  const code = mailer.generateOTP(config.otp.length, otpType);
  const ttl = config.otp.ttlMinutes * 60000;
  stmt.insertOtp.run(email, code, purpose, now() + ttl, now());
  stmt.invalidateOtps.run(email, purpose === 'signup' ? 'login' : 'signup');

  const { subject, html, text } = mailer.otpEmail(code, config.otp.ttlMinutes, purpose);
  const sent = await mailer.send({ to: email, subject, html, text });
  stmt.log.run(null, 'OTP SENT', `${purpose} → ${email} (${sent.provider})`, now());
  return { sent, code: sent.ok ? undefined : code, email, purpose, expiresInMin: config.otp.ttlMinutes };
}

function cfgOtpType(mailer) {
  try { return mailer.status().otpType || 'numeric'; } catch { return 'numeric'; }
}

function verifyOtp(email, code, purpose = 'signup') {
  email = String(email || '').trim().toLowerCase();
  const row = stmt.latestOtp.get(email, purpose);
  if (!row) return { ok: false, error: 'No code requested. Tap "Resend code".' };
  if (row.consumed) return { ok: false, error: 'Code already used.' };
  if (row.expires_at < now()) return { ok: false, error: 'Code expired. Request a new one.' };
  if (row.attempts >= config.otp.maxAttempts) return { ok: false, error: 'Too many wrong attempts. Request a new code.' };
  if (String(code || '').trim() !== row.code) {
    stmt.bumpOtp.run(row.id);
    return { ok: false, error: 'Incorrect code. Check your email.' };
  }
  stmt.consumeOtp.run(row.id);
  const u = stmt.userByUsername.get(email);
  if (u) stmt.setEmailVerified.run(u.id);
  return { ok: true, user: u };
}

module.exports = { createUser, authenticate, createSession, userForToken, destroySession, updateSettings, getSettings, publicUser, DEFAULT_SETTINGS, RISK_RANGES, sanitizeSettings, checkRate, seedAdmin, hashPassword, sendOtp, verifyOtp };
