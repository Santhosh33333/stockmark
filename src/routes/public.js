// Public read-only API: market status, live quotes, scanner control, signal feed.
const express = require('express');
const { getSymbolList, buildUniverse, INDICES } = require('../providers/symbols');
const market = require('../providers');
const scanner = require('../scanner');
const strategy = require('../strategy');
const research = require('../research');
const dq = require('../dataquality');
const net = require('../net');
const auth = require('../auth');
const { stmt, now } = require('../db');
const { marketStatus } = require('../util');
const config = require('../../config');

const router = express.Router();

router.get('/health', (_req, res) => res.json({ ok: true, ts: now(), service: 'TradeMind' }));

// Operational metrics (no secrets): cache hit-rates, HTTP counters, provider use.
router.get('/metrics', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ts: now(),
    uptimeSec: Math.round(process.uptime()),
    memoryMB: { rss: +(mem.rss / 1048576).toFixed(1), heap: +(mem.heapUsed / 1048576).toFixed(1) },
    node: process.version,
    http: net.metrics(),
    providers: market.providerStatus(),
    market: marketStatus(),
  });
});

router.get('/market/status', async (_req, res) => {
  const status = marketStatus();
  const quotes = await market.fetchQuotes(INDICES.map((i) => i.symbol), { concurrency: 8 });
  const indices = INDICES.map((i) => {
    const q = quotes[i.symbol] || {};
    return {
      symbol: i.symbol,
      name: i.name,
      price: q.price,
      change: q.change,
      changePct: q.change != null && q.prevClose ? +((q.change / q.prevClose) * 100).toFixed(2) : null,
      currency: q.currency || 'INR',
      quality: q.price != null ? dq.classify({ source: q.source || market.providerStatus().lastUsed.quote, market: status }) : null,
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
    mtf: r.mtf ? { alignment: r.mtf.alignment, score: r.mtf.score } : null,
    wickLast: r.wickLastIdx != null && r.bars ? r.wickLastIdx === r.bars - 1 : false,
    scannedAt: r.scannedAt,
  };
}

// Live quote stream (Server-Sent Events). Free providers expose no WebSocket,
// so the server polls upstream and pushes ONLY changed values — honest streaming
// with automatic client reconnect (EventSource) and a heartbeat per interval.
router.get('/stream/quotes', async (req, res) => {
  const symbols = String(req.query.symbols || '^NSEI,^NSEBANK').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const interval = Math.max(2000, Math.min(30000, Number(req.query.interval) || 4000));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { } };
  const keyOf = (v) => `${v.price}|${v.change}|${v.changePct}|${v.volume ?? ''}`;
  const last = new Map();
  let closed = false;
  const tick = async () => {
    if (closed) return;
    try {
      const q = await market.fetchQuotes(symbols, { concurrency: 6 });
      const changed = {};
      for (const s of symbols) {
        const v = q[s]; if (!v || v.price == null) continue;
        const k = keyOf(v);
        if (last.get(s) !== k) { last.set(s, k); changed[s] = v; }
      }
      const mkt = marketStatus();
      if (Object.keys(changed).length) send('quotes', { ts: now(), market: mkt, changed });
      else send('heartbeat', { ts: now(), market: mkt });
    } catch (e) {
      send('error', { ts: now(), message: e.message });
    }
  };
  await tick();
  const iv = setInterval(tick, interval);
  req.on('close', () => { closed = true; clearInterval(iv); });
});

// Full analysis of one symbol (fresh network fetch) — used by the stock detail page
router.get('/analysis/:symbol', async (req, res) => {
  const raw = String(req.params.symbol || '').toUpperCase();
  const yahooSym = raw.endsWith('.NS') || raw.endsWith('.BO') || raw.startsWith('^') ? raw : `${raw}.NS`;
  const wantIntraday = req.query.intraday === '1' || req.query.intraday === 'true';
  try {
    const data = await market.fetchSymbolData(yahooSym, { intraday: wantIntraday });
    const mkt = marketStatus();
    const opts = { ...strategy.DEFAULTS, formingLastBar: mkt.state === 'OPEN' };
    if (data.intraday) opts.intraday = data.intraday;
    const a = strategy.analyze(data.daily, data.hourly, opts);
    if (!a.ok) return res.status(422).json({ error: a.reason });
    const source = data.meta?.source || market.providerStatus().lastUsed.chart || 'yahoo';
    const last = data.daily[data.daily.length - 1];
    const quality = dq.classify({ source, asOf: last?.t, market: mkt });
    res.json({
      symbol: raw, yahoo: yahooSym, ...a,
      source, quality,
      candles: compressCandles(data.daily),
      candles4h: compressCandles(data.hourly),
      ...fourHourSeries(data.hourly),
      rsiDailySeries: dailyRsiSeries(data.daily),
    });
  } catch (e) {
    res.status(502).json({ error: `Data fetch failed: ${e.message}` });
  }
});

// Deterministic, evidence-backed research brief (no LLM, no invented numbers).
router.get('/research/:symbol', async (req, res) => {
  const raw = String(req.params.symbol || '').toUpperCase();
  const yahooSym = raw.endsWith('.NS') || raw.endsWith('.BO') || raw.startsWith('^') ? raw : `${raw}.NS`;
  try {
    const data = await market.fetchSymbolData(yahooSym, { intraday: true });
    const mkt = marketStatus();
    const opts = { ...strategy.DEFAULTS, formingLastBar: mkt.state === 'OPEN' };
    if (data.intraday) opts.intraday = data.intraday;
    const a = strategy.analyze(data.daily, data.hourly, opts);
    if (!a.ok) return res.status(422).json({ ok: false, error: a.reason });
    const source = data.meta?.source || market.providerStatus().lastUsed.chart || 'yahoo';
    const brief = research.build(a, {
      symbol: raw, source,
      dataFrom: data.daily.length ? data.daily[0].t : null,
      dataTo: data.daily.length ? data.daily[data.daily.length - 1].t : null,
    });
    brief.quality = dq.classify({ source, asOf: data.daily[data.daily.length - 1]?.t, market: mkt });
    res.json(brief);
  } catch (e) {
    res.status(502).json({ ok: false, error: `Research data fetch failed: ${e.message}` });
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

// Daily RSI(14) series aligned to the daily candles drawn on the chart
function dailyRsiSeries(daily) {
  const { rsi } = require('../indicators');
  const r = rsi((daily || []).map((c) => c.c), 14);
  return (daily || []).map((c, i) => ({ t: c.t, v: r[i] != null ? +r[i].toFixed(1) : null })).filter((x) => x.v != null).slice(-170);
}

// Lightweight candles for the chart (last N daily bars)
function compressCandles(daily) {
  return daily.slice(-160).map((c) => ({ t: c.t, o: +c.o.toFixed(2), h: +c.h.toFixed(2), l: +c.l.toFixed(2), c: +c.c.toFixed(2), v: c.v }));
}

// ── Backtest: run the deterministic scanner rules over history ─────────
// Returns the real engine output (never fabricated): stats, equity curve,
// per-trade log and monthly P&L for the requested parameters.
router.get('/backtest/:symbol', async (req, res) => {
  const raw = String(req.params.symbol || '').toUpperCase();
  const yahooSym = raw.endsWith('.NS') || raw.endsWith('.BO') || raw.startsWith('^') ? raw : `${raw}.NS`;
  const preset = String(req.query.preset || 'improved').toLowerCase();
  const base = strategy.PRESETS[preset] || {};
  const num = (v) => (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : undefined);
  const opts = { ...base };
  const slPct = num(req.query.slPct); if (slPct != null) opts.slPct = slPct;
  const tpPct = num(req.query.tpPct); if (tpPct != null) opts.tpPct = tpPct;
  const maxBars = num(req.query.maxBars); if (maxBars != null) opts.maxBars = Math.max(1, Math.floor(maxBars));
  // Realistic-cost + train/test options (opt-in; src/costs.js)
  const useCosts = ['1', 'true', 'yes'].includes(String(req.query.costs || '').toLowerCase());
  const costMode = String(req.query.mode || '').toUpperCase();
  const train = num(req.query.train);
  if (useCosts) opts.useCosts = true;
  if (costMode === 'INTRADAY' || costMode === 'DELIVERY') opts.costs = { ...(opts.costs || {}), mode: costMode };
  if (train != null && train > 0 && train < 1) opts.trainSplit = train;
  try {
    const data = await market.fetchSymbolData(yahooSym, {
      dailyRange: config.backtest.dailyRange,
      hourlyRange: config.backtest.hourlyRange,
    });
    const a = strategy.analyze(data.daily, data.hourly, opts);
    if (!a.ok) return res.status(422).json({ error: a.reason });
    const trades = (a.trades || []).filter((t) => !/^open/i.test(t.reason || ''));
    res.json({
      symbol: raw, yahoo: yahooSym, preset,
      engine: 'SMC wick-rejection + order block + inducement (with 4H RSI gate)',
      params: { preset, slPct: a.optsUsed.slPct, tpPct: a.optsUsed.tpPct, maxBars: a.optsUsed.maxBars, costs: !!opts.useCosts, costMode: opts.useCosts ? (opts.costs?.mode || 'DELIVERY') : null, trainSplit: opts.trainSplit || 0 },
      bars: a.bars, stats: a.stats, equityCurve: a.stats.equityCurve || [],
      trades, monthly: monthlyReturns(trades),
      dataFrom: data.daily.length ? data.daily[0].t : null,
      dataTo: data.daily.length ? data.daily[data.daily.length - 1].t : null,
      generatedAt: now(),
    });
  } catch (e) {
    res.status(502).json({ error: `Backtest data fetch failed: ${e.message}` });
  }
});

// Group closed trades into month buckets (IST) for the monthly-returns table.
function monthlyReturns(trades) {
  const buckets = new Map();
  for (const t of trades) {
    const label = new Date(t.exitTs).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short' });
    const cur = buckets.get(label) || { month: label, trades: 0, pct: 0, wins: 0 };
    cur.trades += 1; cur.pct += t.pct; if (t.pct > 0) cur.wins += 1;
    buckets.set(label, cur);
  }
  return [...buckets.values()].map((b) => ({ ...b, pct: +b.pct.toFixed(2), winRate: b.trades ? +((b.wins / b.trades) * 100).toFixed(1) : 0 }));
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
