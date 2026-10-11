// Small shared helpers
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP counters (surfaced through /api/metrics) ────────────────────────
const httpCounters = { requests: 0, retries: 0, errors: 0, rateLimited: 0, timeouts: 0, notModified: 0 };
const httpStats = () => ({ ...httpCounters });

// Parse a Retry-After header (seconds or HTTP-date) into milliseconds.
function retryAfterMs(res) {
  const h = res && res.headers && res.headers.get ? res.headers.get('retry-after') : null;
  if (!h) return 0;
  const secs = Number(h);
  if (isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  return isFinite(when) ? Math.max(0, when - Date.now()) : 0;
}

// ── HTTP with retry + exponential backoff + jitter (free providers are
//    occasionally flaky and rate-limit with 429/503 + Retry-After) ─────────
async function httpText(url, { timeoutMs = 20000, retry = 2, retryDelayMs = 700, maxDelayMs = 8000, headers = {}, method = 'GET', body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    httpCounters.requests++;
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ctrl.signal,
        headers: {
          'User-Agent': config.userAgent,
          Accept: '*/*',
          ...(body != null ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      });
      const text = await res.text();
      if (!res.ok) {
        // 4xx (except 429) are permanent — do not retry.
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        err.permanent = permanent;
        err.retryAfterMs = retryAfterMs(res);
        if (res.status === 429) httpCounters.rateLimited++;
        httpCounters.errors++;
        lastErr = err;
        if (permanent || attempt >= retry) throw err;
      } else {
        return text;
      }
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') httpCounters.timeouts++;
      if (err.permanent) throw err;
      if (attempt >= retry) { httpCounters.errors++; throw err; }
    } finally {
      clearTimeout(timer);
    }
    httpCounters.retries++;
    const backoff = Math.min(maxDelayMs, retryDelayMs * 2 ** attempt);
    const jitter = Math.round(backoff * 0.25 * Math.random());
    const wait = lastErr && lastErr.retryAfterMs ? Math.min(maxDelayMs, lastErr.retryAfterMs) : backoff + jitter;
    await sleep(wait);
  }
  throw lastErr;
}

async function httpJson(url, opts) {
  const t = await httpText(url, opts);
  return JSON.parse(t);
}

// ── Mini CSV parser (handles quoted commas) ─────────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

// ── Currency: everything INR ─────────────────────────────────────────────
const inrFmt0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inrFmt2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr = (v, decimals) => (v == null || !isFinite(v)) ? '—' : (decimals ? inrFmt2.format(v) : inrFmt0.format(v));
const inrLakh = (v) => {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `₹${(v / 1e3).toFixed(1)} K`;
  return inrFmt0.format(v);
};

// ── IST market clock ────────────────────────────────────────────────────
function istNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 5.5 * 3600000); // IST
}
function istParts(d = istNow()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    y: d.getFullYear(), m: p(d.getMonth() + 1), d: p(d.getDate()),
    hh: p(d.getHours()), mm: p(d.getMinutes()), ss: p(d.getSeconds()),
    weekday: d.getDay(),           // 0 Sun … 6 Sat
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}
function marketStatus() {
  const p = istParts();
  const isWeekend = p.weekday === 0 || p.weekday === 6;
  const mins = Number(p.hh) * 60 + Number(p.mm);
  const open = 9 * 60 + 15, close = 15 * 60 + 30;
  let state = 'CLOSED';
  if (!isWeekend) {
    if (mins >= open && mins < close) state = 'OPEN';
    else if (mins >= 9 * 60 && mins < open) state = 'PRE-OPEN';
    else if (mins >= close && mins < 16 * 60) state = 'POST-CLOSE';
  }
  return { state, istTime: `${p.hh}:${p.mm}:${p.ss} IST`, istDate: `${p.y}-${p.m}-${p.d}`, weekday: p.weekday };
}

// ── Concurrency limiter ──────────────────────────────────────────────────
function pMap(items, limit, worker) {
  return new Promise((resolve, reject) => {
    const results = new Array(items.length);
    let idx = 0, done = 0, failed = false;
    const next = () => {
      if (failed) return;
      while (idx < items.length && idx - done < limit) {
        const i = idx++;
        Promise.resolve()
          .then(() => worker(items[i], i))
          .then((r) => { results[i] = { ok: true, value: r }; })
          .catch((e) => { results[i] = { ok: false, error: e }; })
          .finally(() => {
            done++;
            if (done === items.length) resolve(results);
            else next();
          });
      }
    };
    next();
  });
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round2 = (v) => Math.round(v * 100) / 100;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

module.exports = { sleep, httpText, httpJson, parseCsv, inr, inrLakh, inrFmt2, istNow, istParts, marketStatus, pMap, clamp, round2, uid, httpStats };
