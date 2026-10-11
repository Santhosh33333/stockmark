// ═══════════════════════════════════════════════════════════════════════════
//  Strategy Lab API — natural-language parsing, real-data backtesting,
//  optimization, walk-forward, Monte Carlo, explanation and persistence.
//
//  Real-data policy: a backtest only runs when the configured provider returns
//  enough verified candles. No simulated data is ever substituted.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const express = require('express');
const auth = require('../auth');
const { getSymbolList } = require('../providers/symbols');
const { marketStatus, pMap } = require('../util');
const parser = require('../lab/parser');
const schema = require('../lab/schema');
const data = require('../lab/data');
const engine = require('../lab/engine');
const metrics = require('../lab/metrics');
const optimizer = require('../lab/optimizer');
const montecarlo = require('../lab/montecarlo');
const explain = require('../lab/explain');
const store = require('../lab/store');

const router = express.Router();
const DAY = 86400000;
const MIN_CANDLES = 60;

const parseCookie = (header = '', name) => {
  const m = header.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
};
function attachUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = (header.startsWith('Bearer ') && header.slice(7)) || parseCookie(req.headers.cookie, 'sa_token');
  req.user = auth.userForToken(token);
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
}
router.use(attachUser);

function windowOf(spec) {
  const toTs = spec.toTs || Date.now();
  const fromTs = spec.fromTs || (toTs - 3 * 365.25 * DAY);
  return { fromTs, toTs };
}

function pickSymbol(spec, q) {
  const s = String((q && q.symbol) || '').trim();
  if (s) return s.toUpperCase();
  if (spec.universe && spec.universe.type === 'symbols' && spec.universe.symbols.length) return spec.universe.symbols[0];
  return null;
}

function htfTfs(spec) {
  const tfs = new Set();
  for (const c of (spec.entry || []).concat(spec.filters || [])) if ((c.kind === 'htf_trend' || c.kind === 'htf_rsi') && c.tf) tfs.add(c.tf);
  if (spec.higherTimeframe) tfs.add(spec.higherTimeframe);
  return [...tfs];
}

async function loadData(spec, symbol) {
  const { fromTs, toTs } = windowOf(spec);
  const series = await data.fetchSeries(symbol, spec.timeframe, { fromTs, toTs });
  if (!series || series.ok === false) return { ok: false, error: (series && series.error) || 'Market-data provider error.', symbol };
  const htf = {};
  const htfNotes = [];
  for (const tf of htfTfs(spec)) {
    const r = await data.fetchHtf(symbol, tf, { fromTs, toTs });
    if (r.ok && r.candles && r.candles.length >= 20) htf[tf] = r.candles;
    else htfNotes.push(`Higher-timeframe ${tf} candles unavailable from the provider for this window — the ${tf} condition cannot be verified.`);
  }
  return { ok: true, series, htf, htfNotes, fromTs, toTs };
}

function coverageOut(series, htfNotes) {
  const c = series.coverage || {};
  return {
    provider: series.source || 'Yahoo Finance',
    symbol: series.symbol,
    timeframe: series.timeframe,
    interval: series.interval,
    candles: series.candles.length,
    firstCandleTs: c.firstTs || null,
    lastCandleTs: c.lastTs || null,
    requestedFromTs: c.requestedFrom || null,
    requestedToTs: c.requestedTo || null,
    rejectedCandles: series.rejectedRaw || 0,
    notes: [...(c.warnings || []), ...(htfNotes || [])],
  };
}

function insufficient(series, htfNotes) {
  return {
    ok: false,
    error: 'Backtest unavailable: insufficient verified historical market data. No performance results have been generated.',
    coverage: coverageOut(series, htfNotes),
  };
}

// ── parse ────────────────────────────────────────────────────────────────
router.post('/lab/parse', (req, res) => {
  try {
    const body = req.body || {};
    const prompt = String(body.prompt || '').slice(0, 2000);
    if (!prompt.trim()) return res.status(400).json({ error: 'Describe your strategy in plain English.' });
    const out = parser.parse(prompt, body.spec ? { spec: body.spec } : {});
    res.json({
      ok: true,
      spec: out.spec,
      valid: out.valid,
      errors: out.errors,
      warnings: out.warnings,
      diagnostics: out.diagnostics,
    });
  } catch (e) { res.status(500).json({ error: 'Parser error: ' + e.message }); }
});

// ── validate a (possibly user-edited) spec ───────────────────────────────
router.post('/lab/validate', (req, res) => {
  try {
    const check = schema.validate((req.body || {}).spec || {});
    res.json({ ok: check.ok, spec: check.spec, errors: check.errors, warnings: check.warnings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── data quality / coverage only (no backtest) ───────────────────────────
router.post('/lab/data', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const spec = schema.normalize(body.spec || {});
    const symbol = pickSymbol(spec, body);
    if (!symbol) return res.status(400).json({ error: 'Choose an instrument (NSE symbol).' });
    const loaded = await loadData(spec, symbol);
    if (!loaded.ok) return res.status(502).json({ ok: false, error: loaded.error });
    res.json({ ok: true, coverage: coverageOut(loaded.series, loaded.htfNotes), usable: loaded.series.candles.length >= MIN_CANDLES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── run backtest ─────────────────────────────────────────────────────────
router.post('/lab/run', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const check = schema.validate(body.spec || {});
    if (!check.ok) return res.status(400).json({ ok: false, error: 'Strategy is invalid', errors: check.errors });
    const spec = check.spec;
    const symbol = pickSymbol(spec, body);
    if (!symbol) return res.status(400).json({ ok: false, error: 'Choose an instrument (NSE symbol) to backtest.' });

    const loaded = await loadData(spec, symbol);
    if (!loaded.ok) return res.status(502).json({ ok: false, error: loaded.error });
    const { series, htf } = loaded;
    if (series.candles.length < MIN_CANDLES) return res.json(insufficient(series, loaded.htfNotes));

    spec.__symbol = series.symbol;
    const r = engine.run({ candles: series.candles, spec, htf });
    if (!r.ok) return res.json({ ok: false, error: r.error, coverage: coverageOut(series, loaded.htfNotes) });

    const risk = metrics.riskStats(r.trades);
    const mc = r.trades.length >= 5 ? montecarlo.simulate({ trades: r.trades, capital: spec.capital, iterations: 2000 }) : { ok: false, error: 'Monte Carlo needs at least 5 closed trades.' };
    const report = explain.build({ stats: r.stats, riskStats: risk, monteCarlo: mc, spec, coverage: series.coverage });

    const summary = {
      trades: r.stats.totalTrades, winRate: r.stats.winRate, netPnl: r.stats.netPnl, netPnlPct: r.stats.netPnlPct,
      profitFactor: r.stats.profitFactor, expectancy: r.stats.expectancy, avgRMultiple: r.stats.avgRMultiple,
      maxDrawdownPct: r.stats.maxDrawdown ? r.stats.maxDrawdown.pct : null,
    };
    if (body.save) store.recordRun(req.user.id, { strategyId: body.strategyId || null, symbol: series.symbol, timeframe: spec.timeframe, fromTs: loaded.fromTs, toTs: loaded.toTs, spec, summary });

    res.json({
      ok: true,
      symbol: series.symbol,
      spec,
      coverage: coverageOut(series, loaded.htfNotes),
      meta: r.meta,
      warnings: r.warnings,
      stats: r.stats,
      risk,
      monteCarlo: mc,
      equityCurve: r.equityCurve,
      drawdownCurve: r.drawdownCurve,
      buckets: r.buckets,
      trades: r.trades,
      signals: r.signals,
      report,
      realData: true,
    });
  } catch (e) { res.status(500).json({ ok: false, error: 'Backtest failed: ' + e.message }); }
});

// ── optimize (IS selection + OOS hold-out) ───────────────────────────────
router.post('/lab/optimize', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const check = schema.validate(body.spec || {});
    if (!check.ok) return res.status(400).json({ ok: false, error: 'Strategy is invalid', errors: check.errors });
    const spec = check.spec;
    const symbol = pickSymbol(spec, body);
    if (!symbol) return res.status(400).json({ ok: false, error: 'Choose an instrument.' });
    const loaded = await loadData(spec, symbol);
    if (!loaded.ok) return res.status(502).json({ ok: false, error: loaded.error });
    if (loaded.series.candles.length < 250) return res.json({ ok: false, error: 'Optimizer unavailable: needs at least 250 verified candles.', coverage: coverageOut(loaded.series, loaded.htfNotes) });
    const out = optimizer.optimize({ candles: loaded.series.candles, htf: loaded.htf, spec, trainFrac: 0.7, minTrades: body.minTrades || 20 });
    res.json({ ok: out.ok, ...out, symbol: loaded.series.symbol, coverage: coverageOut(loaded.series, loaded.htfNotes) });
  } catch (e) { res.status(500).json({ ok: false, error: 'Optimize failed: ' + e.message }); }
});

// ── walk-forward ─────────────────────────────────────────────────────────
router.post('/lab/walkforward', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const check = schema.validate(body.spec || {});
    if (!check.ok) return res.status(400).json({ ok: false, error: 'Strategy is invalid', errors: check.errors });
    const spec = check.spec;
    const symbol = pickSymbol(spec, body);
    if (!symbol) return res.status(400).json({ ok: false, error: 'Choose an instrument.' });
    const loaded = await loadData(spec, symbol);
    if (!loaded.ok) return res.status(502).json({ ok: false, error: loaded.error });
    if (loaded.series.candles.length < 400) return res.json({ ok: false, error: 'Walk-forward unavailable: needs at least 400 verified candles.', coverage: coverageOut(loaded.series, loaded.htfNotes) });
    const out = optimizer.walkForward({ candles: loaded.series.candles, htf: loaded.htf, spec, windows: body.windows || 4, minTrades: body.minTrades || 10 });
    res.json({ ok: out.ok, ...out, symbol: loaded.series.symbol });
  } catch (e) { res.status(500).json({ ok: false, error: 'Walk-forward failed: ' + e.message }); }
});

// ── Monte Carlo (from the real trade ledger) ─────────────────────────────
router.post('/lab/montecarlo', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const check = schema.validate(body.spec || {});
    if (!check.ok) return res.status(400).json({ ok: false, error: 'Strategy is invalid', errors: check.errors });
    const spec = check.spec;
    const symbol = pickSymbol(spec, body);
    if (!symbol) return res.status(400).json({ ok: false, error: 'Choose an instrument.' });
    const loaded = await loadData(spec, symbol);
    if (!loaded.ok) return res.status(502).json({ ok: false, error: loaded.error });
    if (loaded.series.candles.length < MIN_CANDLES) return res.json(insufficient(loaded.series, loaded.htfNotes));
    const r = engine.run({ candles: loaded.series.candles, spec, htf: loaded.htf });
    if (!r.ok) return res.json({ ok: false, error: r.error });
    const mc = montecarlo.simulate({ trades: r.trades, capital: spec.capital, iterations: body.iterations || 2000, seed: body.seed || 12345 });
    res.json({ ok: mc.ok, ...mc, backtestTrades: r.stats.totalTrades });
  } catch (e) { res.status(500).json({ ok: false, error: 'Monte Carlo failed: ' + e.message }); }
});

// ── sensitivity grid ─────────────────────────────────────────────────────
router.post('/lab/sensitivity', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const check = schema.validate(body.spec || {});
    if (!check.ok) return res.status(400).json({ ok: false, error: 'Strategy is invalid', errors: check.errors });
    const spec = check.spec;
    const symbol = pickSymbol(spec, body);
    if (!symbol) return res.status(400).json({ ok: false, error: 'Choose an instrument.' });
    const loaded = await loadData(spec, symbol);
    if (!loaded.ok) return res.status(502).json({ ok: false, error: loaded.error });
    if (loaded.series.candles.length < 120) return res.json({ ok: false, error: 'Sensitivity unavailable: needs at least 120 verified candles.' });
    const out = optimizer.sensitivity({ candles: loaded.series.candles, htf: loaded.htf, spec });
    res.json({ ok: out.ok, ...out, symbol: loaded.series.symbol });
  } catch (e) { res.status(500).json({ ok: false, error: 'Sensitivity failed: ' + e.message }); }
});

// ── risk-level comparison ────────────────────────────────────────────────
router.post('/lab/risklevels', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const check = schema.validate(body.spec || {});
    if (!check.ok) return res.status(400).json({ ok: false, error: 'Strategy is invalid', errors: check.errors });
    const spec = check.spec;
    const symbol = pickSymbol(spec, body);
    if (!symbol) return res.status(400).json({ ok: false, error: 'Choose an instrument.' });
    const loaded = await loadData(spec, symbol);
    if (!loaded.ok) return res.status(502).json({ ok: false, error: loaded.error });
    if (loaded.series.candles.length < 120) return res.json({ ok: false, error: 'Risk-level comparison needs at least 120 verified candles.' });
    const out = optimizer.riskLevels({ candles: loaded.series.candles, htf: loaded.htf, spec, levels: body.levels || [0.25, 0.5, 1, 2] });
    res.json({ ok: out.ok, ...out, symbol: loaded.series.symbol });
  } catch (e) { res.status(500).json({ ok: false, error: 'Risk-level run failed: ' + e.message }); }
});

// ── screen: evaluate the validated spec on the latest completed bar of every
//    symbol in a universe preset (default F&O) and report which ones qualify
//    RIGHT NOW — no manual symbol entry. Symbols with insufficient verified
//    history are skipped (counted, never fabricated). ──────────────────────
const SCREEN_TF_DAYS = { '1d': 400, '4h': 400, '1h': 400, '30m': 55, '15m': 55 };
const SCREEN_BUDGET_MS = 100000;
const round2 = (v) => (v == null || !isFinite(v) ? null : +Number(v).toFixed(2));

router.post('/lab/screen', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const check = schema.validate(body.spec || {});
    if (!check.ok) return res.status(400).json({ ok: false, error: 'Strategy is invalid', errors: check.errors });
    const spec = check.spec;
    const universe = String(body.universe || 'fno').toLowerCase();
    if (!['fno', 'nse', 'indices'].includes(universe)) {
      return res.status(400).json({ ok: false, error: 'Screen universe must be fno, nse or indices (the full NSE+BSE list is too large for a live screen).' });
    }
    const maxSymbols = Math.min(500, Math.max(1, Number(body.maxSymbols) || 300));
    let list;
    try { list = await getSymbolList(universe); }
    catch (e) { return res.status(502).json({ ok: false, error: 'Universe list unavailable: ' + e.message }); }
    list = (list || []).slice(0, maxSymbols);
    if (!list.length) return res.status(502).json({ ok: false, error: 'Universe list is empty — try again shortly.' });

    const days = SCREEN_TF_DAYS[spec.timeframe] || 400;
    const fromTs = Date.now() - days * 86400000;
    const needHtf = htfTfs(spec);
    const open = marketStatus().state === 'OPEN';
    const t0 = Date.now();
    let stopped = false;

    const screenOne = async (entry) => {
      if (stopped || Date.now() - t0 > SCREEN_BUDGET_MS) { stopped = true; return { status: 'budget' }; }
      const sym = entry.yahoo || entry.symbol;
      try {
        const series = await data.fetchSeries(sym, spec.timeframe, { fromTs });
        if (!series || series.ok === false) return { status: 'error', symbol: entry.symbol, error: (series && series.error) || 'provider error' };
        if (series.candles.length < 60) return { status: 'skipped', symbol: entry.symbol, reason: `only ${series.candles.length} verified bars (need 60)` };
        // Latest COMPLETED bar: skip the forming bar while the market is open.
        const sigIdx = series.candles.length - 1 - (open ? 1 : 0);
        if (sigIdx < 30) return { status: 'skipped', symbol: entry.symbol, reason: 'not enough completed bars' };
        const sliced = series.candles.slice(0, sigIdx + 1);
        const htf = {};
        for (const tf of needHtf) {
          const r = await data.fetchHtf(sym, tf, { fromTs });
          if (r.ok && r.candles && r.candles.length >= 20) htf[tf] = r.candles;
        }
        const r = engine.run({ candles: sliced, spec, htf });
        if (!r.ok) return { status: 'skipped', symbol: entry.symbol, reason: r.error };
        // A setup qualifies when it fired on the signal bar (fresh) or fired
        // earlier and is still running into the signal bar (open at the end).
        const hits = (r.trades || []).filter((t) => t.entryIdx === sigIdx || (t.exitIdx === sigIdx && t.reason === 'open_at_end'));
        if (!hits.length) return { status: 'none' };
        return {
          status: 'match', symbol: entry.symbol, name: entry.name || entry.symbol, exchange: entry.exchange || 'NSE',
          asOf: sliced[sigIdx].t, lastClose: sliced[sigIdx].c,
          setups: hits.map((t) => ({
            dir: t.dir, entry: t.entry, stop: t.stop, target: t.target,
            planR: t.target != null && t.stop !== t.entry ? round2(Math.abs(t.target - t.entry) / Math.abs(t.entry - t.stop)) : null,
            fresh: t.entryIdx === sigIdx, barsAgo: sigIdx - t.entryIdx,
            reason: t.reason,
          })),
        };
      } catch (e) { return { status: 'error', symbol: entry.symbol, error: e.message }; }
    };

    const wrapped = await pMap(list, 10, screenOne);
    const results = wrapped.map((w) => (w && w.ok ? w.value : { status: 'error', error: (w && w.error && w.error.message) || 'worker failed' }));
    const matches = results.filter((r) => r && r.status === 'match');
    const skipped = results.filter((r) => r && r.status === 'skipped').length;
    const errors = results.filter((r) => r && r.status === 'error').length;
    const scanned = results.filter((r) => r && r.status !== 'budget').length;
    const sigBarTs = (() => { for (const m of matches) return m.asOf; return null; })();

    res.json({
      ok: true,
      universe, timeframe: spec.timeframe, marketOpen: open,
      signalBarTs: sigBarTs,
      scanned, universeSize: list.length, matches: matches.map((m) => ({ symbol: m.symbol, name: m.name, exchange: m.exchange, asOf: m.asOf, lastClose: m.lastClose, setups: m.setups })),
      skipped, errors,
      partial: stopped,
      method: 'Each symbol: latest ~' + days + ' days of verified ' + String(spec.timeframe).toUpperCase() + ' candles, strategy evaluated on the latest completed bar only. No signal, no report.',
      note: stopped
        ? `Time budget reached — partial results over ${scanned}/${list.length} symbols. Re-run to cover the rest (results vary as bars complete).`
        : `${matches.length} of ${scanned} symbols show a fresh setup on the latest completed bar. ${skipped} skipped (insufficient verified history), ${errors} provider errors.`,
      realData: true,
    });
  } catch (e) { res.status(500).json({ ok: false, error: 'Screen failed: ' + e.message }); }
});

// ── saved strategies ─────────────────────────────────────────────────────
router.get('/lab/strategies', requireUser, (req, res) => {
  res.json({ ok: true, strategies: store.listStrategies(req.user.id) });
});

router.post('/lab/strategies', requireUser, (req, res) => {
  const body = req.body || {};
  const out = store.saveStrategy(req.user.id, { id: body.id || null, name: body.name, description: body.description, spec: body.spec, label: body.label });
  if (!out.ok) return res.status(out.error === 'forbidden' ? 403 : out.error === 'not_found' ? 404 : 400).json(out);
  res.json(out);
});

router.get('/lab/strategies/:id', requireUser, (req, res) => {
  const out = store.getStrategy(req.user.id, Number(req.params.id));
  if (!out.ok) return res.status(out.error === 'forbidden' ? 403 : 404).json(out);
  res.json(out);
});

router.post('/lab/strategies/:id/duplicate', requireUser, (req, res) => {
  const out = store.duplicateStrategy(req.user.id, Number(req.params.id), (req.body || {}).name);
  if (!out.ok) return res.status(out.error === 'forbidden' ? 403 : out.error === 'not_found' ? 404 : 400).json(out);
  res.json(out);
});

router.delete('/lab/strategies/:id', requireUser, (req, res) => {
  const out = store.deleteStrategy(req.user.id, Number(req.params.id));
  if (!out.ok) return res.status(out.error === 'forbidden' ? 403 : 404).json(out);
  res.json(out);
});

router.get('/lab/strategies/:id/versions/:v', requireUser, (req, res) => {
  const out = store.getVersion(req.user.id, Number(req.params.id), Number(req.params.v));
  if (!out.ok) return res.status(out.error === 'forbidden' ? 403 : 404).json(out);
  res.json(out);
});

router.get('/lab/runs', requireUser, (req, res) => {
  res.json({ ok: true, runs: store.listRuns(req.user.id, Math.min(200, Number(req.query.limit) || 50)) });
});

module.exports = { router };
