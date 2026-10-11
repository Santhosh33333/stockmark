// ═══════════════════════════════════════════════════════════════════════════
//  Event-driven backtest engine.
//
//  Execution model (documented, deterministic, no look-ahead):
//    • A signal is evaluated on a COMPLETED candle (bar i's close).
//    • Entry fills at bar i's close. Slippage + brokerage are applied by the
//      cost model as an adverse round-trip charge.
//    • Stops/targets are checked intrabar from bar i+1 onward. If both the stop
//      and the target are touched inside the same candle, the STOP fills first
//      (conservative).
//    • A bar that opens beyond the stop fills at that (worse) open price.
//    • Positions are sized by risk: qty = (equity × risk%) ÷ stop distance,
//      capped at the available equity (no leverage). The actual ₹ risked is
//      recorded per trade so R-multiples use the true figure.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const features = require('./features');
const metrics = require('./metrics');
const costsModel = require('../costs');
const { sma } = require('../indicators');
const smc = require('../strategy');

function cmp(op, a, b) {
  if (a == null || b == null || !isFinite(a) || !isFinite(b)) return false;
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  if (op === 'lte') return a <= b;
  return false;
}

// Causal "last confirmed swing low/high known at bar i" arrays.
function swingArrays(candles, swingLen) {
  const len = swingLen || 3;
  const sw = smc.findSwings(candles, len);
  const lastSwingLow = new Array(candles.length).fill(null);
  const lastSwingHigh = new Array(candles.length).fill(null);
  const pts = [
    ...sw.highs.map((s) => ({ idx: s.idx, price: s.price, type: 'H' })),
    ...sw.lows.map((s) => ({ idx: s.idx, price: s.price, type: 'L' })),
  ].sort((a, b) => a.idx - b.idx);
  let lo = null, hi = null, p = 0;
  for (let i = 0; i < candles.length; i++) {
    while (p < pts.length && pts[p].idx + len <= i) {
      const s = pts[p++];
      if (s.type === 'L') lo = s; else hi = s;
    }
    lastSwingLow[i] = lo ? lo.price : null;
    lastSwingHigh[i] = hi ? hi.price : null;
  }
  return { lastSwingLow, lastSwingHigh };
}

function dirMatchesCond(cond, dir) {
  if (cond.kind === 'liquidity_sweep') return cond.side === 'sellside' ? dir === 'long' : dir === 'short';
  if (cond.kind === 'htf_trend') return cond.align === 'bull' ? dir === 'long' : dir === 'short';
  const d = cond.dir;
  if (d === 'bull') return dir === 'long';
  if (d === 'bear') return dir === 'short';
  return true;
}

function evaluate(cond, i, dir, x) {
  const c = x.candles[i];
  switch (cond.kind) {
    case 'rsi': {
      if (cond.tf) return evalHtfRsi(cond, i, x);
      const arr = x.f.getRsi(cond.period);
      return cmp(cond.op, arr ? arr[i] : null, cond.value);
    }
    case 'ma_cross': {
      if (i < 1) return false;
      const fast = x.f.getMa(cond.type, cond.fast), slow = x.f.getMa(cond.type, cond.slow);
      const f0 = fast[i], f1 = fast[i - 1], s0 = slow[i], s1 = slow[i - 1];
      if (f0 == null || f1 == null || s0 == null || s1 == null) return false;
      return cond.dir === 'bull' ? (f0 > s0 && f1 <= s1) : (f0 < s0 && f1 >= s1);
    }
    case 'price_vs_ma': {
      const ma = x.f.getMa(cond.type, cond.len);
      if (ma[i] == null) return false;
      return cond.side === 'above' ? c.c > ma[i] : c.c < ma[i];
    }
    case 'wick_rejection': return x.f.wick ? (cond.dir === 'bull' ? x.f.wick.bull[i] : x.f.wick.bear[i]) : false;
    case 'order_block': return x.f.ob ? (cond.dir === 'bull' ? x.f.ob.flags.bull[i] : x.f.ob.flags.bear[i]) : false;
    case 'fvg': return x.f.fvg ? (cond.dir === 'bull' ? x.f.fvg.bull[i] : x.f.fvg.bear[i]) : false;
    case 'bos':
    case 'choch': {
      const want = cond.kind === 'bos' ? 'BOS' : 'CHoCH';
      const dirWant = cond.dir === 'bull' ? 'BULL' : 'BEAR';
      const evs = (x.f.structure && x.f.structure.events) || [];
      for (let k = evs.length - 1; k >= 0; k--) {
        const e = evs[k];
        if (e.idx > i) continue;
        if (i - e.idx > (cond.maxAgeBars || 50)) break;
        if (e.type === want && e.dir === dirWant) return true;
      }
      return false;
    }
    case 'liquidity_sweep': return x.f.sweeps ? (cond.side === 'sellside' ? x.f.sweeps.sellside[i] : x.f.sweeps.buyside[i]) : false;
    case 'htf_trend': {
      const tf = cond.tf || x.spec.higherTimeframe;
      const series = x.htfSeries[tf], map = x.htfIdx[tf];
      if (!series || !map) return false;
      const hi = map[i];
      if (hi == null || hi < 0) return false;
      return cond.align === 'bull' ? series.trend[hi] === 'UP' : series.trend[hi] === 'DOWN';
    }
    case 'htf_rsi': return evalHtfRsi(cond, i, x);
    case 'candle_pattern': return features.patternAt(x.candles, i, cond.pattern, cond.dir);
    case 'volume': {
      const va = sma(x.candles.map((cc) => cc.v || 0), cond.period);
      if (va[i] == null) return false;
      return c.v > cond.mult * va[i];
    }
    default: return false;
  }
}

function evalHtfRsi(cond, i, x) {
  const tf = cond.tf || x.spec.higherTimeframe;
  const series = x.htfSeries[tf], map = x.htfIdx[tf];
  if (!series || !map) return false;
  const hi = map[i];
  if (hi == null || hi < 0) return false;
  return cmp(cond.op, series.rsi[hi], cond.value);
}

function evaluateAll(spec, i, dir, x) {
  const conds = (spec.entry || []).concat(spec.filters || []);
  if (!conds.length) return false;
  for (const cond of conds) {
    if (!dirMatchesCond(cond, dir)) return false;
    if (!evaluate(cond, i, dir, x)) return false;
  }
  return true;
}

function planTrade(spec, i, dir, x) {
  const entry = x.candles[i].c;
  const s = spec.stopLoss || {};
  const atrNow = x.f.getAtr(s.atrPeriod || 14)[i];
  let stop = null;
  if (s.kind === 'pct') stop = dir === 'long' ? entry * (1 - (s.pct || 2) / 100) : entry * (1 + (s.pct || 2) / 100);
  else if (s.kind === 'atr') { if (atrNow == null) return null; stop = dir === 'long' ? entry - (s.atrMult || 2) * atrNow : entry + (s.atrMult || 2) * atrNow; }
  else if (s.kind === 'swing') {
    const buffer = (s.buffer || 0) * (atrNow || 0);
    if (dir === 'long') { const sl = x.lastSwingLow[i]; if (sl == null || sl >= entry) return null; stop = sl - buffer; }
    else { const sh = x.lastSwingHigh[i]; if (sh == null || sh <= entry) return null; stop = sh + buffer; }
  } else if (s.kind === 'ob') {
    const zones = x.f.ob ? (dir === 'long' ? x.f.ob.zones.bull : x.f.ob.zones.bear) : [];
    let best = null;
    for (const z of zones) {
      if (z.createdIdx > i) continue;
      if (z.mitigatedIdx != null && z.mitigatedIdx <= i) continue;
      if (dir === 'long' && z.bottom < entry && (!best || z.createdIdx > best.createdIdx)) best = z;
      if (dir === 'short' && z.top > entry && (!best || z.createdIdx > best.createdIdx)) best = z;
    }
    if (!best) return null;
    const buffer = (s.buffer || 0) * (atrNow || 0);
    stop = dir === 'long' ? best.bottom - buffer : best.top + buffer;
  }
  if (stop == null || !isFinite(stop)) return null;
  const dist = Math.abs(entry - stop);
  if (!(dist > 0)) return null;

  const t = spec.takeProfit || {};
  let target = null;
  if (t.kind === 'rr') target = dir === 'long' ? entry + (t.rr || 2) * dist : entry - (t.rr || 2) * dist;
  else if (t.kind === 'pct') target = dir === 'long' ? entry * (1 + (t.pct || 5) / 100) : entry * (1 - (t.pct || 5) / 100);
  else if (t.kind === 'atr') { const a = x.f.getAtr(t.atrPeriod || 14); if (a[i] != null) target = dir === 'long' ? entry + (t.atrMult || 3) * a[i] : entry - (t.atrMult || 3) * a[i]; }
  return { entry, stop, target, dist, planR: target != null ? Math.abs(target - entry) / dist : null };
}

function run({ candles, spec, htf = {} }) {
  const warnings = [];
  if (!candles || candles.length < 30) {
    return { ok: false, error: 'Insufficient verified candles for a backtest (need at least 30).', warnings };
  }
  const cap = spec.capital || 100000;
  const rp = Number(spec.riskPct != null ? spec.riskPct : (spec.sizing ? spec.sizing.riskPct : 0.5));
  const risk = isFinite(rp) && rp > 0 ? rp : 0.5;
  const maxBarsLife = Number(spec.maxBars) > 0 ? Number(spec.maxBars) : 30;

  const f = features.build(candles, spec);
  const sw = spec.stopLoss && spec.stopLoss.kind === 'swing' ? swingArrays(candles, spec.stopLoss.swingLen || 3) : { lastSwingLow: [], lastSwingHigh: [] };

  const x = { candles, spec, f, lastSwingLow: sw.lastSwingLow, lastSwingHigh: sw.lastSwingHigh, htfSeries: {}, htfIdx: {} };

  const htfConds = (spec.entry || []).concat(spec.filters || []).filter((c) => c.kind === 'htf_trend' || c.kind === 'htf_rsi' || (c.kind === 'rsi' && c.tf));
  for (const c of htfConds) {
    const tf = c.tf || spec.higherTimeframe;
    if (!tf || x.htfSeries[tf]) continue;
    const hc = htf[tf];
    if (!hc || hc.length < 20) { warnings.push(`Higher-timeframe ${tf} candles are unavailable — the "${c.kind} ${tf}" condition can't be verified and is treated as NOT met.`); continue; }
    x.htfSeries[tf] = features.htfSeries(hc, c.swingLen || 3);
    x.htfIdx[tf] = features.mapHtf(candles, hc);
  }

  const opensArr = [];
  const trades = [];
  let equity = cap;
  let signals = 0;
  const startIdx = Math.min(60, Math.max(1, candles.length - 2));

  const closeTrade = (p, i, exitPx, reason) => {
    const sign = p.dir === 'long' ? 1 : -1;
    const gross = sign * p.qty * (exitPx - p.entryPx);
    const rt = costsModel.roundTrip({ entryPrice: p.entryPx, exitPrice: exitPx, qty: p.qty, cfg: spec.costs });
    const net = gross - rt.charges;
    equity += net;
    trades.push({
      seq: 0, symbol: p.symbol, dir: p.dir,
      entryIdx: p.entryIdx, exitIdx: i,
      entryTs: candles[p.entryIdx].t, exitTs: candles[i].t,
      entry: +p.entryPx.toFixed(4), exit: +exitPx.toFixed(4),
      stop: +p.stopPx.toFixed(4), target: p.targetPx != null ? +p.targetPx.toFixed(4) : null,
      qty: +p.qty.toFixed(4), riskAmount: +p.riskAmount.toFixed(2),
      grossPnl: +gross.toFixed(2), costs: +rt.charges.toFixed(2), costBreakdown: rt.breakdown,
      netPnl: +net.toFixed(2), rMultiple: p.riskAmount > 0 ? +(net / p.riskAmount).toFixed(3) : null,
      barsHeld: i - p.entryIdx, reason, status: 'closed',
    });
  };

  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];

    for (let k = opensArr.length - 1; k >= 0; k--) {
      const p = opensArr[k];
      if (i <= p.entryIdx) continue;
      let exitPx = null, reason = null;
      if (p.dir === 'long') {
        if (c.l <= p.stopPx) { exitPx = c.o < p.stopPx ? c.o : p.stopPx; reason = 'stop'; }
        else if (p.targetPx != null && c.h >= p.targetPx) { exitPx = p.targetPx; reason = 'target'; }
      } else {
        if (c.h >= p.stopPx) { exitPx = c.o > p.stopPx ? c.o : p.stopPx; reason = 'stop'; }
        else if (p.targetPx != null && c.l <= p.targetPx) { exitPx = p.targetPx; reason = 'target'; }
      }
      if (exitPx == null && maxBarsLife > 0 && (i - p.entryIdx) >= maxBarsLife) { exitPx = c.c; reason = 'time'; }
      if (exitPx != null) { closeTrade(p, i, exitPx, reason); opensArr.splice(k, 1); }
    }

    if (opensArr.length < spec.maxPositions) {
      const dirs = [];
      if (spec.universe.direction === 'long' || spec.universe.direction === 'both') dirs.push('long');
      if (spec.universe.direction === 'short' || spec.universe.direction === 'both') dirs.push('short');
      for (const dir of dirs) {
        if (opensArr.length >= spec.maxPositions) break;
        if (opensArr.some((o) => o.dir === dir)) continue;
        if (!evaluateAll(spec, i, dir, x)) continue;
        signals++;
        const plan = planTrade(spec, i, dir, x);
        if (!plan) continue;
        const riskIntended = equity * risk / 100;
        let qty = plan.dist > 0 ? riskIntended / plan.dist : 0;
        const capQty = equity / plan.entry; // no leverage
        if (qty > capQty) qty = capQty;
        if (!isFinite(qty) || qty <= 0) continue;
        opensArr.push({ dir, symbol: null, entryIdx: i, entryPx: plan.entry, stopPx: plan.stop, targetPx: plan.target, qty, riskAmount: plan.dist * qty });
      }
    }
  }

  for (const p of opensArr) closeTrade(p, candles.length - 1, candles[candles.length - 1].c, 'open_at_end');

  trades.sort((a, b) => a.exitTs - b.exitTs || a.entryTs - b.entryTs);
  trades.forEach((t, idx) => { t.seq = idx + 1; });

  const stats = metrics.summarize(trades, { capital: cap, plannedRR: spec.takeProfit && spec.takeProfit.kind === 'rr' ? spec.takeProfit.rr : null });
  const buckets = metrics.buckets(trades, cap);
  const equityCurve = [{ t: candles[startIdx].t, equity: cap, cumPnl: 0 }].concat(stats.equityCurve || []);

  return {
    ok: true, trades, stats, buckets, signals, warnings, equityCurve,
    drawdownCurve: metrics.buildDrawdownCurve(equityCurve),
    meta: {
      timeframe: spec.timeframe, bars: candles.length,
      firstTs: candles[0].t, lastTs: candles[candles.length - 1].t,
      warmup: startIdx, htfUsed: Object.keys(x.htfSeries), maxBarsLife,
    },
  };
}

module.exports = { run, evaluateAll, evaluate, planTrade, swingArrays };
