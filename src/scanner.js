// Background scanner: walks the whole Indian universe with the SMC strategy.
const { stmt, now } = require('./db');
const { getSymbolList } = require('./providers/symbols');
const yahoo = require('./providers/yahoo');
const strategy = require('./strategy');
const config = require('../config');
const { marketStatus } = require('./util');

const jobs = new Map();          // jobId -> job state
let latestBySymbol = new Map();  // symbol -> latest scanner row
let listeners = new Set();       // SSE listeners

const CACHE_MAX_MS = config.scan.staleAfterMs;

function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(event, data) { for (const fn of listeners) { try { fn(event, data); } catch { } } }

function loadCachedRows() {
  latestBySymbol = new Map();
  for (const row of stmt.allScan.all()) {
    try {
      const payload = JSON.parse(row.payload);
      payload.scannedAt = row.updated_at;
      latestBySymbol.set(row.symbol, payload);
    } catch { }
  }
}
loadCachedRows();

function getLatestSymbols() {
  return [...latestBySymbol.values()].sort((a, b) => b.scannedAt - a.scannedAt);
}

function getSymbolRow(symbol) { return latestBySymbol.get(symbol) || null; }

async function analyzeOne(entry, opts) {
  const data = await yahoo.fetchSymbolData(entry.yahoo);
  const a = strategy.analyze(data.daily, data.hourly, opts);
  if (!a.ok) return null;
  const row = {
    symbol: entry.symbol,
    yahoo: entry.yahoo,
    name: entry.name,
    exchange: entry.exchange,
    fno: !!entry.fno,
    scannedAt: now(),
    ...a,
  };
  stmt.upsertScan.run(entry.yahoo, JSON.stringify(row), row.scannedAt);
  latestBySymbol.set(entry.yahoo, row);
  return row;
}

async function startScan({ preset = 'fno', opts = {}, userId = null, scanCache = true } = {}) {
  const jobId = 'scan_' + now().toString(36);
  const list = await getSymbolList(preset);
  const job = {
    id: jobId, preset, status: 'RUNNING', total: list.length, done: 0, cached: 0,
    startedAt: now(), finishedAt: null, results: [], signals: [], error: null,
    userId, market: marketStatus().state,
  };
  jobs.set(jobId, job);

  (async () => {
    const emitThrottle = { t: 0 };
    const pendingSignals = [];
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      try {
        // reuse fresh cache during background scans
        if (scanCache) {
          const cached = stmt.getScan.get(entry.yahoo);
          if (cached && now() - cached.updated_at < CACHE_MAX_MS) {
            const payload = JSON.parse(cached.payload);
            payload.scannedAt = cached.updated_at;
            latestBySymbol.set(entry.yahoo, payload);
            job.cached++; job.done++;
            continue;
          }
        }
        const row = await analyzeOne(entry, opts);
        if (row) {
          job.results.push(row);
          if (row.lastSignal && Date.now() - row.lastSignal.t < 3 * 86400000) {
            pendingSignals.push(row);
          }
        }
      } catch (err) {
        job.errors = (job.errors || 0) + 1;
      }
      job.done++;
      if (now() - emitThrottle.t > 700 || job.done === job.total) {
        emitThrottle.t = now();
        emit('progress', { id: job.id, done: job.done, total: job.total, pct: Math.round((job.done / job.total) * 100), cached: job.cached });
        job.results = job.results.slice(-400);
      }
      if (now() - job.startedAt > config.scan.maxAutoScanMs) { job.error = 'time budget reached'; break; }
    }

    job.status = 'DONE';
    job.finishedAt = now();
    // record fresh signals (new within last 3 days) once
    for (const row of pendingSignals) {
      try {
        stmt.addSignal.run(userId, row.symbol, row.name, row.exchange, row.price, 'BUY',
          `4H RSI ${row.rsi4h} < 50 | wick+OB inducement`, JSON.stringify({ htfRsi: row.rsi4h, zone: row.activeZones[0] || null }), now());
      } catch { }
    }
    job.signals = pendingSignals.map((r) => ({ symbol: r.symbol, name: r.name, price: r.price, rsi4h: r.rsi4h }));
    emit('done', { id: job.id, total: job.total, done: job.done, signals: job.signals.length });
  })();

  return job;
}

function getJob(id) { return jobs.get(id) || null; }
function listJobs() { return [...jobs.values()].slice(-10).reverse().map((j) => ({ id: j.id, preset: j.preset, status: j.status, done: j.done, total: j.total, startedAt: j.startedAt })); }

// Quick top-signal view from cache (no network)
function topSignals(limit = 50) {
  const rows = getLatestSymbols();
  return rows
    .filter((r) => r.lastSignal)
    .sort((a, b) => b.lastSignal.t - a.lastSignal.t)
    .slice(0, limit)
    .map((r) => ({ symbol: r.symbol, name: r.name, exchange: r.exchange, price: r.price, rsi4h: r.rsi4h, lastSignal: r.lastSignal, fno: r.fno }));
}

module.exports = { startScan, getJob, listJobs, onEvent, getLatestSymbols, getSymbolRow, topSignals, analyzeOne };
