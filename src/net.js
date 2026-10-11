// Resilience layer: TTL cache, in-flight de-duplication and lightweight metrics.
// Zero dependencies. Used by the provider facade and option analytics so repeated
// requests hit memory instead of the (free, rate-limited) upstream sources.
const { httpJson } = require('./util');

// ── TTL cache with hit/miss accounting ───────────────────────────────────
class TtlCache {
  constructor(defaultTtlMs = 0, name = 'cache') {
    this.name = name;
    this.map = new Map();
    this.defaultTtlMs = defaultTtlMs;
    this.hits = 0;
    this.misses = 0;
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) { this.misses++; return undefined; }
    if (e.exp && e.exp <= Date.now()) { this.map.delete(key); this.misses++; return undefined; }
    this.hits++;
    return e.value;
  }
  has(key) { return this.get(key) !== undefined; }
  set(key, value, ttlMs) {
    const ttl = ttlMs == null ? this.defaultTtlMs : (typeof ttlMs === 'function' ? ttlMs(value) : ttlMs);
    this.map.set(key, { value, exp: ttl > 0 ? Date.now() + ttl : 0 });
    return value;
  }
  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
  stats() {
    const total = this.hits + this.misses;
    return { name: this.name, size: this.size, hits: this.hits, misses: this.misses, hitRate: total ? +((this.hits / total) * 100).toFixed(1) : 0 };
  }
}

// ── In-flight de-duplication ─────────────────────────────────────────────
// Concurrent callers asking for the same key share one upstream request.
const inflight = new Map();
function dedupe(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Cache-aware de-duplication: return a fresh cached value, else run fn once.
async function memo(cache, key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  return dedupe(cache.name + '|' + key, async () => {
    const again = cache.get(key);
    if (again !== undefined) return again;
    const value = await fn();
    if (value !== undefined) cache.set(key, value, ttlMs);
    return value;
  });
}

// ── Counters ─────────────────────────────────────────────────────────────
const counters = { deduped: 0 };
function bump(k, n = 1) { counters[k] = (counters[k] || 0) + n; }

// Resilient JSON GET: util.httpText already does retry + exponential backoff +
// jitter + Retry-After handling; this wrapper adds de-duplication + metrics.
async function getJson(url, opts = {}) {
  return dedupe('http|' + url, () => { bump('deduped'); return httpJson(url, opts); });
}

function metrics() {
  const { httpStats } = require('./util');
  return { http: httpStats(), counters: { ...counters }, inflight: inflight.size };
}

module.exports = { TtlCache, dedupe, memo, getJson, metrics, bump };
