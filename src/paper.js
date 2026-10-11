// Risk controls + paper trading engine. All money in INR.
const { stmt, now } = require('./db');
const { inr } = require('./util');

// Real epoch (ms) of the current IST midnight — entry/exit timestamps are epoch.
function startOfIstDay(ts = Date.now()) {
  const d = new Date(ts + 5.5 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 5.5 * 3600000;
}

// Capital deployed per position (% of capital) — pre-risk sizing.
function positionSize(settings, price) {
  const capital = Number(settings.capital || 100000);
  const deploy = capital * (Number(settings.qtyPct || 20) / 100);
  const qty = Math.max(1, Math.floor(deploy / price));
  return qty;
}

// Risk-based sizing: risk no more than maxRiskPerTradePct of capital between
// entry and stop. Falls back to the capital-allocation size when unset.
function positionSizeRisk(settings, price) {
  const capital = Number(settings.capital || 100000);
  const allocQty = positionSize(settings, price);
  const riskPct = Number(settings.maxRiskPerTradePct);
  const slPct = Number(settings.slPct || 3);
  if (!isFinite(riskPct) || riskPct <= 0 || slPct <= 0) return allocQty;
  const riskBudget = capital * (riskPct / 100);
  const riskPerShare = price * (slPct / 100);
  const riskQty = Math.floor(riskBudget / riskPerShare);
  return Math.max(1, Math.min(allocQty, riskQty));
}

// Per-user risk snapshot used by both the guard and the /risk/state endpoint.
function riskSnapshot(userId) {
  const trades = userId ? stmt.trades.all(userId, 1000) : [];
  const start = startOfIstDay();
  const closed = trades.filter((t) => t.status === 'CLOSED').slice().sort((a, b) => (a.exit_ts || 0) - (b.exit_ts || 0));
  const closedToday = closed.filter((t) => (t.exit_ts || 0) >= start);
  const dayPnl = +closedToday.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) { cum += t.pnl || 0; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  const open = userId ? stmt.openTrades.all(userId) : [];
  return { dayPnl, tradesToday: closedToday.length, openCount: open.length, maxDrawdown: +maxDD.toFixed(2), closedCount: closed.length };
}

function riskCheck(settings, symbol, price, qty, userId = null) {
  const problems = [];
  const open = userId ? stmt.openTrades.all(userId) : stmt.openTrades.all(0);
  const capital = Number(settings.capital || 100000);
  const maxPos = Number(settings.maxPositions || 5);

  if (settings.killSwitch) problems.push('Kill switch is ON — new positions are blocked');
  if (open.length >= maxPos) problems.push(`Max positions reached (${maxPos})`);
  if (!(qty > 0)) problems.push('Invalid quantity');
  if (!(price > 0)) problems.push('Invalid price');

  // Max risk per trade (distance to stop × size)
  const slPct = Number(settings.slPct || 3);
  const riskPct = Number(settings.maxRiskPerTradePct);
  if (qty > 0 && price > 0 && isFinite(riskPct) && riskPct > 0) {
    const tradeRisk = qty * price * (slPct / 100);
    const budget = capital * (riskPct / 100);
    if (tradeRisk > budget * 1.0001) {
      problems.push(`Trade risk ₹${tradeRisk.toFixed(0)} exceeds ${riskPct}% risk budget (₹${budget.toFixed(0)})`);
    }
  }

  const snap = userId ? riskSnapshot(userId) : { dayPnl: 0, openCount: open.length, maxDrawdown: 0 };
  const dailyLossLimit = capital * (Number(settings.maxDailyLossPct || 3) / 100);
  if (snap.dayPnl <= -dailyLossLimit) problems.push(`Daily loss limit reached (₹${Math.abs(snap.dayPnl).toFixed(0)} of ₹${dailyLossLimit.toFixed(0)})`);
  const ddLimit = capital * (Number(settings.maxDrawdownPct || 15) / 100);
  if (snap.maxDrawdown >= ddLimit) problems.push(`Max drawdown limit reached (₹${snap.maxDrawdown.toFixed(0)} of ₹${ddLimit.toFixed(0)})`);

  const exposure = open.reduce((a, t) => a + t.qty * t.entry_price, 0) + qty * price;
  if (exposure > capital * 1.5) problems.push('Exposure limit breached');
  return { ok: problems.length === 0, problems, exposure, snapshot: snap };
}

function openTrade(userId, { symbol, name, price, settings }) {
  const s = settings;
  const open = stmt.openTrades.all(userId);
  const qty = positionSizeRisk(s, price);
  const check = riskCheck(s, symbol, price, qty, userId);
  check.open = open.length;
  if (!check.ok) return { ok: false, ...check };

  const sl = price * (1 - Number(s.slPct || 3) / 100);
  const tp = price * (1 + Number(s.tpPct || 10) / 100);
  const info = stmt.addTrade.run(userId, symbol, name || symbol, qty, price, now(), sl, tp, s.mode === 'LIVE' ? 'LIVE' : 'PAPER');
  const trade = { id: Number(info.lastInsertRowid), user_id: userId, symbol, name, qty, entry_price: price, entry_ts: now(), sl, tp, status: 'OPEN' };
  return { ok: true, trade, ...check };
}

function closeTrade(tradeId, price, reason) {
  const t = stmt.tradeById.get(tradeId);
  if (!t || t.status === 'CLOSED') return null;
  const pnl = (price - t.entry_price) * t.qty;
  stmt.closeTrade.run(price, now(), reason, pnl, tradeId);
  return { ...t, exit_price: price, exit_reason: reason, pnl, status: 'CLOSED' };
}

// Evaluates SL/TP for every open paper position using live prices
async function evaluateOpenPositions(getPriceFn) {
  const open = stmt.allOpenTrades.all();
  const closed = [];
  for (const t of open) {
    const px = await getPriceFn(t.symbol.includes('.') ? t.symbol : `${t.symbol}.NS`);
    if (px == null || !isFinite(px)) continue;
    let exitPrice = null, reason = null;
    if (px <= t.sl) { exitPrice = t.sl; reason = 'STOP LOSS'; }
    else if (px >= t.tp) { exitPrice = t.tp; reason = 'TARGET'; }
    if (exitPrice != null) {
      const c = closeTrade(t.id, exitPrice, reason);
      if (c) closed.push(c);
    }
  }
  return closed;
}

function portfolioStats(userId) {
  const trades = stmt.trades.all(userId, 500);
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const open = trades.filter((t) => t.status === 'OPEN');
  const wins = closed.filter((t) => t.pnl > 0);
  const grossP = wins.reduce((a, t) => a + t.pnl, 0);
  const grossL = Math.abs(closed.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const net = closed.reduce((a, t) => a + (t.pnl || 0), 0);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) { cum += t.pnl || 0; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  return {
    openCount: open.length,
    closedCount: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRate: closed.length ? +(wins.length / closed.length * 100).toFixed(1) : 0,
    netPnl: +net.toFixed(2),
    netPnlFmt: inr(net, true),
    grossProfit: +grossP.toFixed(2),
    grossLoss: +grossL.toFixed(2),
    profitFactor: grossL > 0 ? +(grossP / grossL).toFixed(2) : (grossP > 0 ? 99 : 0),
    maxDrawdown: +maxDD.toFixed(2),
    maxDrawdownFmt: inr(maxDD),
    avgTrade: closed.length ? +(net / closed.length).toFixed(2) : 0,
    avgTradeFmt: inr(closed.length ? net / closed.length : 0, true),
    trades: trades.slice(0, 100).map((t) => ({ ...t, pnlFmt: t.pnl != null ? inr(t.pnl, true) : null })),
    open: open.map((t) => ({ ...t, pnl: t.entry_price ? 0 : 0 })),
  };
}

module.exports = { openTrade, closeTrade, evaluateOpenPositions, portfolioStats, positionSize, positionSizeRisk, riskCheck, riskSnapshot, startOfIstDay };
