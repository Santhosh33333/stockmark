// ═══════════════════════════════════════════════════════════════════════════
//  Performance metrics — every number is computed from the actual simulated
//  trade ledger. Nothing here is estimated or invented. When a metric is
//  undefined (e.g. no losing trades → profit factor infinite) it is returned
//  with an explicit `note` rather than a fake number.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d));

function maxDrawdown(equityCurve) {
  // equityCurve: [{ t, equity }] in ₹. Returns ₹ peak-to-trough + duration.
  let peak = -Infinity, peakT = null, maxDd = 0, maxDdPct = 0, ddStart = null, ddEnd = null, bestStart = null, bestEnd = null;
  for (const p of equityCurve) {
    if (p.equity > peak) { peak = p.equity; peakT = p.t; }
    const dd = peak - p.equity;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > 0 && ddStart == null) { ddStart = peakT; }
    if (dd > maxDd) { maxDd = dd; maxDdPct = ddPct; bestStart = peakT; bestEnd = p.t; }
    if (dd === 0) ddStart = null;
  }
  ddEnd = bestEnd; ddStart = bestStart;
  let durationMs = null;
  if (bestStart != null && bestEnd != null) durationMs = bestEnd - bestStart;
  return { amount: round(maxDd), pct: round(maxDdPct), peakToTroughMs: durationMs, from: bestStart, to: bestEnd };
}

function consecutive(trades, predicate) {
  let best = 0, cur = 0;
  for (const t of trades) { if (predicate(t)) { cur++; if (cur > best) best = cur; } else cur = 0; }
  return best;
}

function summarize(trades, { capital = 100000, plannedRR = null } = {}) {
  const closed = trades.filter((t) => t.status === 'closed');
  const n = closed.length;
  const notes = [];
  const wins = closed.filter((t) => t.netPnl > 0);
  const losses = closed.filter((t) => t.netPnl < 0);
  const breakeven = closed.filter((t) => t.netPnl === 0);

  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const grossProfit = sum(wins, (t) => t.netPnl);
  const grossLoss = Math.abs(sum(losses, (t) => t.netPnl));
  const netPnl = grossProfit - grossLoss;
  const totalCosts = sum(closed, (t) => t.costs);

  const rMultiples = closed.map((t) => t.rMultiple).filter((v) => v != null && isFinite(v));
  const avgR = rMultiples.length ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : null;
  const winR = wins.map((t) => t.rMultiple).filter((v) => v != null);
  const lossR = losses.map((t) => t.rMultiple).filter((v) => v != null);
  const avgWinR = winR.length ? winR.reduce((a, b) => a + b, 0) / winR.length : null;
  const avgLossR = lossR.length ? Math.abs(lossR.reduce((a, b) => a + b, 0) / lossR.length) : null;

  let run = capital; const eq = [];
  for (const t of closed) { run += t.netPnl; eq.push({ t: t.exitTs, equity: round(run), cumPnl: round(run - capital), trade: t.seq }); }
  const dd = maxDrawdown(eq);

  if (grossLoss === 0 && grossProfit > 0) notes.push('Profit factor is undefined: there were no losing trades.');
  if (n === 0) notes.push('No closed trades — metrics are empty by construction, not zero.');

  const capitalReturnPct = capital > 0 ? (netPnl / capital) * 100 : null;
  const avgHoldingBars = n ? sum(closed, (t) => t.barsHeld) / n : null;
  const avgHoldingMs = n ? sum(closed, (t) => (t.exitTs - t.entryTs)) / n : null;

  return {
    totalTrades: n,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: n ? round((wins.length / n) * 100) : null,
    lossRate: n ? round((losses.length / n) * 100) : null,
    avgWin: wins.length ? round(grossProfit / wins.length) : null,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : null,
    avgWinR: round(avgWinR),
    avgLossR: round(avgLossR),
    plannedRR: plannedRR != null ? round(plannedRR) : null,
    realizedRR: avgWinR != null && avgLossR ? round(avgWinR / avgLossR) : null,
    avgRMultiple: round(avgR),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    netPnl: round(netPnl),
    netPnlPct: round(capitalReturnPct),
    returnOnCapitalPct: round(capitalReturnPct),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    expectancy: n ? round(netPnl / n) : null,
    expectancyR: avgR,
    maxDrawdown: dd,
    equityCurve: eq,
    maxConsecutiveWins: consecutive(closed, (t) => t.netPnl > 0),
    maxConsecutiveLosses: consecutive(closed, (t) => t.netPnl < 0),
    avgHoldingBars: round(avgHoldingBars, 1),
    avgHoldingMs: avgHoldingMs != null ? Math.round(avgHoldingMs) : null,
    largestWin: n ? round(Math.max(...closed.map((t) => t.netPnl))) : null,
    largestLoss: n ? round(Math.min(...closed.map((t) => t.netPnl))) : null,
    totalCosts: round(totalCosts),
    grossProfitOnly: round(grossProfit),
    netPnlOnly: round(netPnl),
    capitalReturnPct: round(capitalReturnPct),
    realizedRR: avgLossR ? round(avgWinR / avgLossR) : null,
    plannedRRRatio: plannedRR,
    grossLossOnly: round(grossLoss),
    equityCurve: eq,
    drawdownCurve: buildDrawdownCurve(eq),
    maxDrawdownFull: dd,
    notes,
    definitions: {
      winRate: 'winning trades ÷ total closed trades × 100',
      profitFactor: 'gross profit ÷ |gross loss|',
      expectancy: 'net P&L ÷ number of closed trades (net of costs)',
      realizedRR: 'average winning R ÷ average |losing R|, measured from actual outcomes',
      plannedRR: 'target multiple ÷ stop distance set in the strategy spec',
      rMultiple: 'net P&L ÷ the ₹ risked at entry (stop distance × position size)',
      maxDrawdown: 'largest peak-to-trough decline of the closed-trade equity curve',
    },
  };
}

function buildDrawdownCurve(eq) {
  let peak = -Infinity; const out = [];
  for (const p of eq) {
    if (p.equity > peak) peak = p.equity;
    out.push({ t: p.t, ddPct: peak > 0 ? round(((peak - p.equity) / peak) * 100) : 0, dd: round(peak - p.equity) });
  }
  return out;
}

// Monthly + yearly buckets by IST close time.
function buckets(trades, capital) {
  const monthMap = new Map(), yearMap = new Map();
  for (const t of trades.filter((x) => x.status === 'closed')) {
    const d = new Date(t.exitTs + 5.5 * 3600000);
    const y = d.getUTCFullYear();
    const m = `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    for (const [map, key] of [[monthMap, m], [yearMap, String(y)]]) {
      if (!map.has(key)) map.set(key, { key, trades: 0, wins: 0, netPnl: 0 });
      const b = map.get(key); b.trades++; if (t.netPnl > 0) b.wins++; b.netPnl += t.netPnl;
    }
  }
  const fmt = (map) => [...map.values()].sort((a, b) => a.key.localeCompare(b.key)).map((b) => ({ period: b.key, trades: b.trades, winRate: b.trades ? round((b.wins / b.trades) * 100) : null, netPnl: round(b.netPnl), returnPct: capital > 0 ? round((b.netPnl / capital) * 100) : null }));
  return { monthly: fmt(monthMap), yearly: fmt(yearMap) };
}

// Risk-distribution statistics derived from the actual closed-trade ledger.
function riskStats(trades) {
  const closed = trades.filter((t) => t.status === 'closed');
  const rs = closed.map((t) => t.rMultiple).filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  const n = rs.length;
  const mean = n ? rs.reduce((a, b) => a + b, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
  const pct = (p) => (n ? rs[Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))))] : null);
  const buckets = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 10];
  const histogram = [];
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i + 1];
    histogram.push({ from: lo, to: hi, count: rs.filter((r) => r >= lo && r < hi).length });
  }
  histogram.push({ from: buckets[buckets.length - 1], to: null, count: rs.filter((r) => r >= buckets[buckets.length - 1]).length });
  const positives = closed.filter((t) => t.netPnl > 0).map((t) => t.netPnl).sort((a, b) => b - a);
  const totalProfit = positives.reduce((a, b) => a + b, 0);
  const top5 = positives.slice(0, 5).reduce((a, b) => a + b, 0);
  return {
    trades: n,
    meanR: round(mean, 3), stdevR: round(sd, 3),
    medianR: round(n % 2 ? rs[(n - 1) / 2] : (rs[n / 2 - 1] + rs[n / 2]) / 2, 3),
    minR: n ? round(rs[0], 3) : null, maxR: n ? round(rs[n - 1], 3) : null,
    p5R: round(pct(5), 3), p25R: round(pct(25), 3), p75R: round(pct(75), 3), p95R: round(pct(95), 3),
    histogram,
    profitConcentrationTop5Pct: totalProfit > 0 ? round((top5 / totalProfit) * 100) : null,
    bigLosersOver2R: closed.filter((t) => t.rMultiple != null && t.rMultiple < -1.5).length,
    note: 'R-multiple = net P&L ÷ the ₹ risked at entry. Distribution is descriptive of these trades only.',
  };
}

module.exports = { summarize, buckets, maxDrawdown, buildDrawdownCurve, riskStats };
