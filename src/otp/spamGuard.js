// Ported from https://github.com/sauravhathi/otp-service (MIT License)
// Spam detection: blocklist (email/IP) + blocked keywords + in-memory cache.
// Original used MongoDB; this port keeps the same behaviour with zero dependencies.
const config = require('../../config');

const spamWords = new Set(
  (process.env.BLOCK_KEYWORDS_RULES || 'viagra,casino,lottery,free money,click here')
    .split(',').map((w) => w.toLowerCase().trim()).filter(Boolean)
);
const blockCache = new Map();          // key -> blockedUntilTs
const CACHE_EXPIRY_MS = 60 * 1000;

function isSpam({ email, ip, bodyText }) {
  const now = Date.now();
  const key = email || ip;
  if (blockCache.has(key) && now - blockCache.get(key) < CACHE_EXPIRY_MS) {
    return { spam: true, reason: 'Blocked by cache' };
  }
  const text = String(bodyText || '').toLowerCase();
  for (const word of spamWords) {
    if (text.includes(word)) {
      blockCache.set(key, now);
      return { spam: true, reason: 'Contains blocked keywords' };
    }
  }
  return { spam: false };
}

function block({ email, ip }) {
  blockCache.set(email || ip, Date.now());
}

module.exports = { isSpam, block };
