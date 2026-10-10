// Public read-only API: market status, live quotes, scanner control, signal feed.
const express = require('express');
const { getSymbolList, buildUniverse, INDICES } = require('../providers/symbols');
const yahoo = require('../providers/yahoo');
const scanner = require('../scanner');
const strategy = require('../strategy');
const auth = require('../auth');
const { stmt, now } = require('../db');
const { marketStatus } = require('../util');

const router = express.Router();

router.get('/health', (_req, res) => res.json({ ok: true, ts: now(), service: 'StockArtha' }));

router.get('/market/status', async (_req, res) => {
  const status = marketStatus();
  const quotes = await yahoo.fetchQuotes(INDICES.map((i) => i.symbol), { concurrency: 8 });
  const indices = INDICES.map((i) => {
    const q = quotes[i.symbol] || {};
    return {
      symbol: i.symbol,
      name: i.name,
      price: q.price,
      change: q.change,
      changePct: q.change != null && q.prevClose ? +((q.change / q.prevClose) * 100).toFixed(2) : null,
      currency: q.currency || 'INR',
    };
  });
  res.json({ status, indices });
});

router.get('/universe', async (_req, res) => {
  try {
    const u = await buildUniverse();
    res.json({ counts: u.counts, updatedAt: u.updatedAt });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// Latest scanner rows from cache (fast, no network)
router.get('/scan/latest', (req, res) => {
  const { exchange, signal, fno, limit = 200, sort = 'time' } = req.query;
  let rows = scanner.getLatestSymbols();
  if (exchange && exchange !== 'ALL') rows = rows.filter((r) => r.exchange === exchange);
  if (fno === '1' || fno === 'true') rows = rows.filter((r) => r.fno);
  if (signal === 'BUY') rows = rows.filter((r) => r.lastSignal);
  if (sort === 'price') rows.sort((a, b) => (b.price || 0) - (a.price || 0));
  else if (sort === 'rsi') rows.sort((a, b) => (a.rsi4h ?? 999) - (b.rsi4h ?? 999));
  else rows.sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0));
  const slice = rows.slice(0, Number(limit));
  res.json({
    total: rows.length,
    returned: slice.length,
    rows: slice.map(compactRow),
  });
});

function compactRow(r) {
  return {
    symbol: r.symbol, name: r.name, exchange: r.exchange, fno: r.fno,
    price: r.price, changePct: r.changePct, volume: r.volume, volRatio: r.volRatio,
    rsi4h: r.rsi4h, rsiDaily: r.rsiDaily, ema: r.ema50, atr: r.atr,
    activeZones: r.activeZones, lastSignal: r.lastSignal, signalCount: r.signalCount,
    score: r.confluence?.score ?? null, trend: r.structure?.trend ?? null,
    wickLast: r.wickLastIdx != null && r.bars ? r.wickLastIdx === r.bars - 1 : false,
    scannedAt: r.scannedAt,
  };
}

// Full analysis of one symbol (fresh network fetch) — used by the stock detail page
router.get('/analysis/:symbol', async (req, res) => {
  const raw = String(req.params.symbol || '').toUpperCase();
  const yahooSym = raw.endsWith('.NS') || raw.endsWith('.BO') || raw.startsWith('^') ? raw : `${raw}.NS`;
  try {
    const data = await yahoo.fetchSymbolData(yahooSym);
    const a = strategy.analyze(data.daily, data.hourly, strategy.DEFAULTS);
    if (!a.ok) return res.status(422).json({ error: a.reason });
    res.json({
      symbol: raw, yahoo: yahooSym, ...a,
      candles: compressCandles(data.daily),
      candles4h: compressCandles(data.hourly),
      ...fourHourSeries(data.hourly),
    });
  } catch (e) {
    res.status(502).json({ error: `Data fetch failed: ${e.message}` });
  }
});

// 4H candles + 4H RSI series (chart pane)
function fourHourSeries(hourly) {
  const { resample4h, rsi } = require('../indicators');
  const c4h = resample4h(hourly || []);
  const r = rsi(c4h.map((c) => c.c), 14);
  const series = c4h.map((c, i) => ({ t: c.t, v: r[i] != null ? +r[i].toFixed(1) : null })).filter((x) => x.v != null);
  return {
    rsi4hSeries: series.slice(-140),
    candles4h: c4h.slice(-120).map((c) => ({ t: c.t, o: +c.o.toFixed(2), h: +c.h.toFixed(2), l: +c.l.toFixed(2), c: +c.c.toFixed(2), v: c.v })),
  };
}

// Lightweight candles for the chart (last N daily bars)
function compressCandles(daily) {
  return daily.slice(-160).map((c) => ({ t: c.t, o: +c.o.toFixed(2), h: +c.h.toFixed(2), l: +c.l.toFixed(2), c: +c.c.toFixed(2), v: c.v }));
}

router.post('/scan/start', async (req, res) => {
  const { preset = 'fno', opts = {}, useCache = true } = req.body || {};
  try {
    const job = await scanner.startScan({ preset, opts, userId: null, scanCache: !!useCache });
    res.json({ jobId: job.id, total: job.total, preset: job.preset });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/scan/jobs', (_req, res) => res.json({ jobs: scanner.listJobs() }));

router.get('/signals/latest', (req, res) => {
  const limit = Number(req.query.limit || 60);
  res.json({ signals: scanner.topSignals(limit) });
});

// Server-Sent Events: live scan progress + market status
router.get('/scan/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  const off = scanner.onEvent((event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25000);
  req.on('close', () => { clearInterval(ping); off(); });
});

module.exports = { router, compactRow };
