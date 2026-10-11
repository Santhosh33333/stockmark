// ═══════════════════════════════════════════════════════════════════════════
//  Strategy optimizer, sensitivity grid and walk-forward validation.
//
//  • A BOUNDED grid of parameter combinations is built from the validated spec
//    (never unbounded, never generated code).
//  • Selection uses the IN-SAMPLE slice only. The out-of-sample slice is a
//    genuine hold-out — it never influences parameter choice.
//  • Walk-forward re-fits on each expanding in-sample window and measures the
//    following unseen window.
//  • Ranking uses expectancy, profit factor, drawdown and trade count — never
//    win rate alone.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const engine = require('./engine');
const schema = require('./schema');

const clone = (o) => JSON.parse(JSON.stringify(o));
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d));

function scoreStats(stats, minTrades) {
  if (!stats || !stats.totalTrades || stats.totalTrades < minTrades) return -Infinity;
  const pf = stats.profitFactor == null ? (stats.netPnl > 0 ? 5 : 1) : Math.min(stats.profitFactor, 5);
  const expR = stats.avgRMultiple == null ? 0 : stats.avgRMultiple;
  const dd = stats.maxDrawdown && stats.maxDrawdown.pct != null ? stats.maxDrawdown.pct / 100 : 0;
  return +(expR * pf - dd * 2).toFixed(4);
}

function summarizeStats(s) {
  return {
    trades: s.totalTrades, winRate: s.winRate, netPnl: s.netPnl, netPnlPct: s.netPnlPct,
    profitFactor: s.profitFactor, expectancy: s.expectancy, avgRMultiple: s.avgRMultiple,
    realizedRR: s.realizedRR, plannedRR: s.plannedRR,
    maxDrawdownPct: s.maxDrawdown ? s.maxDrawdown.pct : null,
    totalCosts: s.totalCosts,
  };
}

function buildGrid(spec, maxCombos = 96) {
  const dims = [];
  const entry = spec.entry || [];

  const rsiCond = entry.find((c) => c.kind === 'rsi' || c.kind === 'htf_rsi');
  if (rsiCond) {
    const v = rsiCond.value;
    const vals = [...new Set([Math.max(15, v - 10), v, Math.min(85, v + 10)])];
    dims.push({ label: 'rsi', values: vals, apply: (s, x) => { const c = (s.entry || []).concat(s.filters || []).find((k) => k.kind === rsiCond.kind); if (c) c.value = x; } });
  }

  const s = spec.stopLoss || {};
  if (s.kind === 'pct') {
    const vals = [...new Set([0.75, 1, 1.25].map((m) => round(Math.min(50, Math.max(0.3, (s.pct || 2) * m)), 2)))];
    dims.push({ label: 'stopPct', values: vals, apply: (sp, x) => { sp.stopLoss.pct = x; } });
  } else if (s.kind === 'atr') {
    dims.push({ label: 'stopAtr', values: [1.5, 2, 2.5], apply: (sp, x) => { sp.stopLoss.atrMult = x; } });
  }

  dims.push({ label: 'rr', values: [1, 1.5, 2, 3], apply: (sp, x) => { sp.takeProfit = { ...sp.takeProfit, kind: 'rr', rr: x }; } });

  const maCond = entry.find((c) => c.kind === 'ma_cross');
  if (maCond) dims.push({ label: 'ma', values: [[10, 20], [20, 50], [20, 100]], apply: (sp, x) => { const c = (sp.entry || []).find((k) => k.kind === 'ma_cross'); if (c) { c.fast = x[0]; c.slow = x[1]; } } });

  const combos = [];
  const walk = (k, acc) => {
    if (combos.length >= maxCombos) return;
    if (k === dims.length) {
      const sp = clone(spec);
      for (const step of acc) step.apply(sp, step.value);
      const desc = {};
      acc.forEach((step, i) => { desc[dims[i].label] = step.value; });
      sp.__desc = desc;
      const ns = schema.normalize(sp);
      ns.__desc = desc;
      combos.push(ns);
      return;
    }
    for (const v of dims[k].values) {
      if (combos.length >= maxCombos) return;
      acc.push({ apply: dims[k].apply, value: v });
      walk(k + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return combos;
}

function describeParams(spec) {
  return spec.__desc || {};
}

function runStats(candles, htf, spec) {
  const r = engine.run({ candles, spec, htf });
  return r.ok ? r.stats : null;
}

function optimize({ candles, htf = {}, spec, trainFrac = 0.7, minTrades = 20, maxCombos = 96 } = {}) {
  if (!candles || candles.length < 250) return { ok: false, error: 'Optimizer needs at least 250 verified candles for a train/hold-out split.' };
  const cut = Math.max(120, Math.floor(candles.length * trainFrac));
  if (candles.length - cut < 60) return { ok: false, error: 'Not enough held-out candles. Use a longer history or a smaller timeframe.' };
  const isCandles = candles.slice(0, cut);
  const oosCandles = candles.slice(cut - 1);

  const combos = buildGrid(spec, maxCombos);
  const all = [];
  for (const sp of combos) {
    const st = runStats(isCandles, htf, sp);
    if (!st) continue;
    all.push({ spec: sp, is: st, isScore: scoreStats(st, minTrades) });
  }
  if (!all.length) return { ok: false, error: 'No parameter combination produced a usable in-sample result.' };
  all.sort((a, b) => b.isScore - a.isScore);
  const top = all.slice(0, 8);

  const ranked = top.map((r) => {
    const oos = runStats(oosCandles, htf, r.spec);
    return {
      params: describeParams(r.spec),
      is: summarizeStats(r.is),
      oos: oos ? summarizeStats(oos) : null,
      isScore: r.isScore,
      oosScore: scoreStats(oos, minTrades),
      enoughTrades: { is: r.is.totalTrades >= minTrades, oos: oos ? oos.totalTrades >= minTrades : false },
      _spec: r.spec,
    };
  });
  ranked.sort((a, b) => b.oosScore - a.oosScore);

  return {
    ok: true,
    method: `In-sample selection (first ${Math.round(trainFrac * 100)}% of candles), out-of-sample hold-out (remaining candles). Parameters chosen on IS only.`,
    minTrades,
    combosTested: all.length,
    trainBars: isCandles.length,
    oosBars: oosCandles.length,
    ranked: ranked.map((r, i) => ({
      rank: i + 1, params: r.params, is: r.is, oos: r.oos, isScore: r.isScore, oosScore: r.oosScore === -Infinity ? null : r.oosScore, enoughTrades: r.enoughTrades,
    })),
    best: ranked[0] ? { params: ranked[0].params, is: ranked[0].is, oos: ranked[0].oos } : null,
    note: 'Ranked by out-of-sample expectancy / profit factor / drawdown with a minimum trade count. Win rate alone is never the objective.',
  };
}

// Anchored (expanding) walk-forward validation.
function walkForward({ candles, htf = {}, spec, windows = 4, minTrades = 10, maxCombos = 48 } = {}) {
  if (!candles || candles.length < 400) return { ok: false, error: 'Walk-forward needs at least 400 verified candles.' };
  const w = Math.max(2, Math.min(8, windows));
  const out = [];
  for (let k = 0; k < w; k++) {
    const isEnd = Math.floor(candles.length * (k + 2) / (w + 2));
    const oosEnd = k + 1 < w ? Math.floor(candles.length * (k + 3) / (w + 2)) : candles.length;
    const isCandles = candles.slice(0, isEnd);
    const oosCandles = candles.slice(isEnd - 1, oosEnd);
    if (isCandles.length < 120 || oosCandles.length < 20) continue;
    const combos = buildGrid(spec, maxCombos);
    let best = null;
    for (const sp of combos) {
      const st = runStats(isCandles, htf, sp);
      if (!st) continue;
      const sc = scoreStats(st, minTrades);
      if (!best || sc > best.score) best = { spec: sp, score: sc, is: st };
    }
    if (!best) { out.push({ window: k + 1, skipped: true, reason: 'no usable in-sample result' }); continue; }
    const oos = runStats(oosCandles, htf, best.spec);
    out.push({
      window: k + 1,
      isBars: isCandles.length, oosBars: oosCandles.length,
      params: describeParams(best.spec),
      is: summarizeStats(best.is),
      oos: oos ? summarizeStats(oos) : null,
    });
  }
  const scored = out.filter((o) => o.oos);
  const oosNet = scored.reduce((a, o) => a + (o.oos.netPnl || 0), 0);
  const oosTrades = scored.reduce((a, o) => a + (o.oos.trades || 0), 0);
  const positive = scored.filter((o) => o.oos.netPnl > 0).length;
  return {
    ok: true,
    method: 'Anchored walk-forward: parameters re-fit on each expanding in-sample window, then measured on the immediately following, unseen window.',
    windows: out,
    aggregate: {
      windowsScored: scored.length,
      oosTradesTotal: oosTrades,
      oosNetPnlTotal: round(oosNet),
      oosPositiveWindowsPct: scored.length ? round((positive / scored.length) * 100) : null,
    },
    note: 'Out-of-sample windows are never used for fitting. A strategy that only works in-sample is a red flag.',
  };
}

// Stop-distance × target grid on the full verified sample (robustness view).
function sensitivity({ candles, htf = {}, spec } = {}) {
  if (!candles || candles.length < 120) return { ok: false, error: 'Sensitivity needs at least 120 verified candles.' };
  const s = spec.stopLoss || {};
  const stopMults = [0.75, 1, 1.25, 1.5];
  const rrs = [1, 1.5, 2, 3];
  const cells = [];
  for (const m of stopMults) {
    for (const rr of rrs) {
      const sp = clone(spec);
      sp.takeProfit = { ...sp.takeProfit, kind: 'rr', rr };
      if (s.kind === 'pct') sp.stopLoss.pct = round(Math.min(50, Math.max(0.3, (s.pct || 2) * m)), 2);
      else if (s.kind === 'atr') sp.stopLoss.atrMult = round(Math.max(0.2, (s.atrMult || 2) * m), 2);
      const st = runStats(candles, htf, schema.normalize(sp));
      cells.push({ stopMult: m, rr, stop: sp.stopLoss.kind === 'pct' ? sp.stopLoss.pct : sp.stopLoss.atrMult, stopKind: sp.stopLoss.kind, trades: st ? st.totalTrades : 0, netPnl: st ? st.netPnl : null, profitFactor: st ? st.profitFactor : null, expectancy: st ? st.expectancy : null, maxDrawdownPct: st && st.maxDrawdown ? st.maxDrawdown.pct : null });
    }
  }
  return { ok: true, stopKind: s.kind || 'pct', cells, note: 'Each cell is a full re-run on the same verified candles. Look for a robust plateau, not a single lucky cell.' };
}

// Equity-risk levels (position sizing) on the full verified sample.
function riskLevels({ candles, htf = {}, spec, levels = [0.25, 0.5, 1, 2] } = {}) {
  if (!candles || candles.length < 120) return { ok: false, error: 'Risk-level comparison needs at least 120 verified candles.' };
  const out = [];
  for (const rp of levels) {
    const sp = clone(spec);
    sp.riskPct = rp;
    const st = runStats(candles, htf, schema.normalize(sp));
    out.push({ riskPct: rp, trades: st ? st.totalTrades : 0, netPnl: st ? st.netPnl : null, netPnlPct: st ? st.netPnlPct : null, profitFactor: st ? st.profitFactor : null, expectancy: st ? st.expectancy : null, maxDrawdownPct: st && st.maxDrawdown ? st.maxDrawdown.pct : null, maxConsecutiveLosses: st ? st.maxConsecutiveLosses : null });
  }
  return { ok: true, levels: out, note: 'Same strategy, different % risked per trade. Higher risk scales both gains and drawdowns (and costs).' };
}

module.exports = { optimize, walkForward, sensitivity, riskLevels, buildGrid, summarizeStats, scoreStats };
