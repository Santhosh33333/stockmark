// SQLite storage via Node's built-in node:sqlite (zero dependencies, free).
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('../config');

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(config.dbFile);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,           -- email or handle
  display_name  TEXT,
  pass_hash     TEXT NOT NULL,
  salt          TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login    INTEGER,
  settings      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id   INTEGER NOT NULL,
  symbol    TEXT NOT NULL,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS signal_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  symbol     TEXT NOT NULL,
  name       TEXT,
  exchange   TEXT,
  price      REAL,
  direction  TEXT,
  reason     TEXT,
  indicators TEXT,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sig_ts   ON signal_history(ts);
CREATE INDEX IF NOT EXISTS idx_sig_sym  ON signal_history(symbol);

CREATE TABLE IF NOT EXISTS paper_trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  name        TEXT,
  qty         INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  entry_ts    INTEGER NOT NULL,
  exit_price  REAL,
  exit_ts     INTEGER,
  sl          REAL,
  tp          REAL,
  status      TEXT NOT NULL DEFAULT 'OPEN',     -- OPEN | CLOSED
  exit_reason TEXT,
  pnl         REAL,
  mode        TEXT NOT NULL DEFAULT 'PAPER'     -- PAPER | LIVE
);
CREATE INDEX IF NOT EXISTS idx_pt_user ON paper_trades(user_id, status);

CREATE TABLE IF NOT EXISTS scan_cache (
  symbol      TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT,
  detail     TEXT,
  ts         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_otps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'signup',   -- signup | login | reset
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON email_otps(email, purpose, created_at);

CREATE TABLE IF NOT EXISTS iv_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL,
  expiry     TEXT NOT NULL,
  iv         REAL,
  underlying REAL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_iv ON iv_history(symbol, expiry, ts);

-- user-defined price alerts (free; evaluated against free quotes)
CREATE TABLE IF NOT EXISTS price_alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  symbol        TEXT NOT NULL,
  name          TEXT,
  condition     TEXT NOT NULL,                 -- above | below
  target        REAL NOT NULL,
  note          TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,    -- 1 armed, 0 disarmed (auto-cleared on trigger)
  created_at    INTEGER NOT NULL,
  last_price    REAL,
  last_checked  INTEGER,
  triggered_at  INTEGER,
  trigger_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pa_user ON price_alerts(user_id, enabled);
CREATE INDEX IF NOT EXISTS idx_pa_enabled ON price_alerts(enabled);
`);

// email verification column (added on existing databases too)
try { db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`); } catch { /* already present */ }

const stmt = {
  insertUser: db.prepare(`INSERT INTO users (username, display_name, pass_hash, salt, is_admin, created_at) VALUES (?,?,?,?,?,?)`),
  userByUsername: db.prepare(`SELECT * FROM users WHERE username = ?`),
  userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  allUsers: db.prepare(`SELECT id, username, display_name, is_admin, created_at, last_login FROM users ORDER BY id`),
  touchLogin: db.prepare(`UPDATE users SET last_login = ? WHERE id = ?`),
  updateSettings: db.prepare(`UPDATE users SET settings = ? WHERE id = ?`),
  updateDisplayName: db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`),
  deleteUser: db.prepare(`DELETE FROM users WHERE id = ?`),
  insertSession: db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`),
  session: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  deleteUserSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
  cleanSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
  addWatch: db.prepare(`INSERT OR IGNORE INTO watchlist (user_id, symbol, added_at) VALUES (?,?,?)`),
  delWatch: db.prepare(`DELETE FROM watchlist WHERE user_id = ? AND symbol = ?`),
  watchlist: db.prepare(`SELECT symbol, added_at FROM watchlist WHERE user_id = ? ORDER BY added_at`),
  addSignal: db.prepare(`INSERT INTO signal_history (user_id, symbol, name, exchange, price, direction, reason, indicators, ts) VALUES (?,?,?,?,?,?,?,?,?)`),
  signals: db.prepare(`SELECT * FROM signal_history WHERE user_id = ? ORDER BY ts DESC LIMIT ?`),
  signalsAll: db.prepare(`SELECT * FROM signal_history ORDER BY ts DESC LIMIT ?`),
  addTrade: db.prepare(`INSERT INTO paper_trades (user_id, symbol, name, qty, entry_price, entry_ts, sl, tp, mode) VALUES (?,?,?,?,?,?,?,?,?)`),
  openTrades: db.prepare(`SELECT * FROM paper_trades WHERE status='OPEN' AND user_id = ?`),
  allOpenTrades: db.prepare(`SELECT * FROM paper_trades WHERE status='OPEN'`),
  closeTrade: db.prepare(`UPDATE paper_trades SET exit_price=?, exit_ts=?, status='CLOSED', exit_reason=?, pnl=? WHERE id=?`),
  trades: db.prepare(`SELECT * FROM paper_trades WHERE user_id = ? ORDER BY entry_ts DESC LIMIT ?`),
  tradeById: db.prepare(`SELECT * FROM paper_trades WHERE id = ?`),
  upsertScan: db.prepare(`INSERT INTO scan_cache (symbol, payload, updated_at) VALUES (?,?,?) ON CONFLICT(symbol) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`),
  getScan: db.prepare(`SELECT payload, updated_at FROM scan_cache WHERE symbol = ?`),
  allScan: db.prepare(`SELECT symbol, payload, updated_at FROM scan_cache`),
  log: db.prepare(`INSERT INTO audit_log (user_id, action, detail, ts) VALUES (?,?,?,?)`),
  // email OTP
  insertOtp: db.prepare(`INSERT INTO email_otps (email, code, purpose, expires_at, created_at) VALUES (?,?,?,?,?)`),
  latestOtp: db.prepare(`SELECT * FROM email_otps WHERE email = ? AND purpose = ? AND consumed = 0 ORDER BY id DESC LIMIT 1`),
  otpById: db.prepare(`SELECT * FROM email_otps WHERE id = ?`),
  bumpOtp: db.prepare(`UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?`),
  consumeOtp: db.prepare(`UPDATE email_otps SET consumed = 1 WHERE id = ?`),
  invalidateOtps: db.prepare(`UPDATE email_otps SET consumed = 1 WHERE email = ? AND purpose = ?`),
  setEmailVerified: db.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`),
  userByEmail: db.prepare(`SELECT * FROM users WHERE username = ?`),
  // ── admin / owner console ──
  countUsers: db.prepare(`SELECT COUNT(*) c FROM users`),
  countAdmins: db.prepare(`SELECT COUNT(*) c FROM users WHERE is_admin = 1`),
  countUsersSince: db.prepare(`SELECT COUNT(*) c FROM users WHERE created_at >= ?`),
  countSessions: db.prepare(`SELECT COUNT(*) c FROM sessions WHERE expires_at > ?`),
  countSignals: db.prepare(`SELECT COUNT(*) c FROM signal_history`),
  countSignalsSince: db.prepare(`SELECT COUNT(*) c FROM signal_history WHERE ts >= ?`),
  countTrades: db.prepare(`SELECT COUNT(*) c FROM paper_trades`),
  countOpenTrades: db.prepare(`SELECT COUNT(*) c FROM paper_trades WHERE status = 'OPEN'`),
  countScan: db.prepare(`SELECT COUNT(*) c FROM scan_cache`),
  lastScanAt: db.prepare(`SELECT MAX(updated_at) m FROM scan_cache`),
  logs: db.prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ? OFFSET ?`),
  logsForUser: db.prepare(`SELECT * FROM audit_log WHERE user_id = ? ORDER BY ts DESC LIMIT ?`),
  allTradesAdmin: db.prepare(`SELECT t.*, u.username AS email FROM paper_trades t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.entry_ts DESC LIMIT ?`),
  allSignalsAdmin: db.prepare(`SELECT s.*, u.username AS email FROM signal_history s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.ts DESC LIMIT ?`),
  setUserRole: db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`),
  setUserPassword: db.prepare(`UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?`),
  deleteUserWatch: db.prepare(`DELETE FROM watchlist WHERE user_id = ?`),
  deleteUserTrades: db.prepare(`DELETE FROM paper_trades WHERE user_id = ?`),
  deleteUserSignals: db.prepare(`DELETE FROM signal_history WHERE user_id = ?`),
  // ── option IV history (for real IV rank / percentile) ──
  insertIv: db.prepare(`INSERT INTO iv_history (symbol, expiry, iv, underlying, ts) VALUES (?,?,?,?,?)`),
  ivHistory: db.prepare(`SELECT iv, underlying, ts FROM iv_history WHERE symbol = ? AND expiry = ? ORDER BY ts DESC LIMIT ?`),
  countIv: db.prepare(`SELECT COUNT(*) c FROM iv_history WHERE symbol = ?`),
  // ── user-defined price alerts ──
  addPriceAlert: db.prepare(`INSERT INTO price_alerts (user_id, symbol, name, condition, target, note, created_at) VALUES (?,?,?,?,?,?,?)`),
  priceAlerts: db.prepare(`SELECT * FROM price_alerts WHERE user_id = ? ORDER BY id DESC`),
  priceAlertById: db.prepare(`SELECT * FROM price_alerts WHERE id = ?`),
  enabledAlertsForUser: db.prepare(`SELECT * FROM price_alerts WHERE user_id = ? AND enabled = 1 ORDER BY id`),
  enabledAlerts: db.prepare(`SELECT * FROM price_alerts WHERE enabled = 1 ORDER BY id`),
  countEnabledAlerts: db.prepare(`SELECT COUNT(*) c FROM price_alerts WHERE enabled = 1`),
  setAlertEnabled: db.prepare(`UPDATE price_alerts SET enabled = ?, triggered_at = NULL WHERE id = ? AND user_id = ?`),
  deletePriceAlert: db.prepare(`DELETE FROM price_alerts WHERE id = ? AND user_id = ?`),
  markAlertTriggered: db.prepare(`UPDATE price_alerts SET last_price = ?, last_checked = ?, triggered_at = ?, trigger_count = trigger_count + 1, enabled = 0 WHERE id = ?`),
  touchAlertChecked: db.prepare(`UPDATE price_alerts SET last_price = ?, last_checked = ? WHERE id = ?`),
};

const now = () => Date.now();

module.exports = { db, stmt, now, config };
