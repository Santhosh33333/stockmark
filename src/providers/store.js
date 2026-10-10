// Global (server-side) credentials for optional FREE market-data providers.
// Market data is shared by the whole app, so these live in one private file
// (data/providers.json, gitignored) rather than per-user settings.
// Secrets are never returned to clients unmasked.
const fs = require('fs');
const path = require('path');
const config = require('../../config');

const FILE = path.join(config.dataDir, 'providers.json');

const DEFAULTS = {
  // Try in this order; yahoo is the always-available, key-less fallback.
  order: ['angelone', 'fyers', 'yahoo'],
  angelone: { enabled: false, apiKey: '', clientCode: '', pin: '', totpSecret: '', totp: '' },
  fyers: { enabled: false, appId: '', accessToken: '' },
};

let cache = null;

function load() {
  if (cache) return cache;
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }
  cache = {
    ...DEFAULTS,
    ...disk,
    angelone: { ...DEFAULTS.angelone, ...(disk.angelone || {}) },
    fyers: { ...DEFAULTS.fyers, ...(disk.fyers || {}) },
    order: Array.isArray(disk.order) && disk.order.length ? disk.order : DEFAULTS.order,
  };
  return cache;
}

function save(patch = {}) {
  const cur = load();
  const next = {
    ...cur,
    ...patch,
    angelone: { ...cur.angelone, ...(patch.angelone || {}) },
    fyers: { ...cur.fyers, ...(patch.fyers || {}) },
  };
  cache = next;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  } catch { /* ignore disk errors, keep in-memory */ }
  return next;
}

const mask = (s) => (s ? '••••' + String(s).slice(-4) : '');
const has = (s) => !!String(s || '').length;

function publicView() {
  const c = load();
  return {
    order: c.order,
    angelone: {
      enabled: !!c.angelone.enabled,
      apiKey: mask(c.angelone.apiKey),
      clientCode: c.angelone.clientCode || '',
      hasPin: has(c.angelone.pin),
      hasTotpSecret: has(c.angelone.totpSecret),
      hasTotp: has(c.angelone.totp),
    },
    fyers: {
      enabled: !!c.fyers.enabled,
      appId: c.fyers.appId || '',
      hasAccessToken: has(c.fyers.accessToken),
    },
    yahoo: { enabled: true },
  };
}

module.exports = { load, save, publicView, FILE, DEFAULTS };
