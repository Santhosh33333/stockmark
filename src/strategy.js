// ═══════════════════════════════════════════════════════════════════════
//  SMC Strategy Engine — Wick Rejection + Order Block + Inducement
//  This is the JavaScript twin of pine/smc_wick_ob_inducement.pine so the
//  web scanner, paper trader and TradingView all use IDENTICAL rules.
// ═══════════════════════════════════════════════════════════════════════
const { sma, ema, rsi, atr, macdHistogram, resample4h } = require('./indicators');

const DEFAULTS = {
  // 1. Strong wick rejection candle
  wickMult: 1.5,          // lower wick >= 1.5 x body (strict preset uses 2.0)
  closePct: 0.70,         // close in top 30% of range
  requireBull: true,
  volLen: 20,             // volume > 20 SMA
  useWickVolume: true,
  // 2. Order block
  impLookback: 3,         // bearish candle followed within 3 bars by impulse
  impAtrMult: 2.0,        // impulse move >= 2 x ATR(14)
  atrLen: 14,
  maxZoneAge: 50,         // deactivate OB after N bars
  // 3. Inducement (liquidity sweep)
  sweepAtrMult: 1.5,      // default = improved preset; strict preset uses 0.3
  requireWickOnSweep: false, // default = improved; strict requires a wick on the sweep bar
  wickLookback: 0,        // 0 = wick must be on the sweep bar; N = within last N bars
  mitigateOnDeepSweep: false, // default = improved; strict mitigates on a deep sweep
  // 4. RSI filter
  rsiLen: 14,
  htfRsiMax: 50,          // 4H RSI < 50
  useHtfRsi: true,
  // optional confluence filters (your "better version")
  useEma: false, emaLen: 50,
  useDailyRsi: false, dailyRsiMin: 55,
  useWeeklyMacd: false,
  // trade management (paper/backtest)
  slPct: 3.0,
  tpPct: 10.0,
  maxBars: 25,
  direction: 'LONG',      // LONG | BOTH
  // 5. context layers (additive — do not change signal generation)
  swingLen: 3,            // pivot strength for fractal swings
  fvgMax: 8,              // fair-value gaps kept in the payload
  structureMax: 6,        // BOS/CHoCH events kept in the payload
  liqTolAtr: 0.25,        // equal-high/low tolerance (x ATR)
  liqMax: 3,              // liquidity pools per side kept in the payload
};

// ── Detect a strong wick-rejection candle ───────────────────────────────
function wickRejectionAt(c, volAvg, o = DEFAULTS) {
  if (!c) return false;
  const body = Math.abs(c.c - c.o);
  const range = c.h - c.l;
  if (range <= 0 || body <= 0) return false;
  const lowerWick = Math.min(c.o, c.c) - c.l;
  const closePos = (c.c - c.l) / range;
  const bull = c.c > c.o;
  if (o.requireBull && !bull) return false;
  if (lowerWick < o.wickMult * body) return false;
  if (closePos < o.closePct) return false;
  if (o.useWickVolume && c.v <= (volAvg || 0)) return false;
  return true;
}

function bearWickRejectionAt(c, volAvg) {
  if (!c || c.c >= c.o) return false;
  const body = Math.abs(c.c - c.o);
  const range = c.h - c.l;
  if (range <= 0 || body <= 0) return false;
  const upperWick = c.h - Math.max(c.o, c.c);
  const closePos = (c.h - c.c) / range;   // close in bottom 30%
  if (upperWick < 2 * body) return false;
  if (closePos < 0.70) return false;
  if (volAvg && c.v <= volAvg) return false;
  return true;
}

// ── Weekly candles from daily (for MACD histogram filter) ────────────────
function toWeekly(daily) {
  const out = [];
  let key = null, cur = null;
  for (const c of daily) {
    const d = new Date(c.t + 5.5 * 3600000);
    const day = (d.getUTCDay() + 6) % 7;             // Monday = 0
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 86400000);
    const k = monday.toISOString().slice(0, 10);
    if (k !== key) {
      if (cur) out.push(cur);
      key = k; cur = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l);
      cur.c = c.c; cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ── Fractal swing pivots (a high/low that dominates `len` bars each side) ──
function findSwings(candles, len = 3) {
  const highs = [], lows = [];
  for (let i = len; i < candles.length - len; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - len; j <= i + len; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ idx: i, t: candles[i].t, price: candles[i].h });
    if (isLow) lows.push({ idx: i, t: candles[i].t, price: candles[i].l });
  }
  return { highs, lows };
}

// ── Market structure: BOS (continuation) & CHoCH (change of character) ────
// A close above the last confirmed swing high is bullish. If the prior trend
// was DOWN it is a CHoCH (reversal); otherwise a BOS (continuation). Symmetric
// for the downside. This runs on the daily series.
function marketStructure(candles, len = 3, swings = null) {
  const sw = swings || findSwings(candles, len);
  const pts = [
    ...sw.highs.map((s) => ({ ...s, type: 'H' })),
    ...sw.lows.map((s) => ({ ...s, type: 'L' })),
  ].sort((a, b) => a.idx - b.idx);

  const events = [];
  let trend = 'RANGE';
  let hi = null, lo = null, p = 0;
  for (let i = 1; i < candles.length; i++) {
    // register pivots whose right-side window has closed by bar i
    while (p < pts.length && pts[p].idx + len <= i) {
      const s = pts[p++];
      if (s.type === 'H') { if (!hi || s.idx > hi.idx) hi = s; }
      else { if (!lo || s.idx > lo.idx) lo = s; }
    }
    const c = candles[i];
    if (hi && c.c > hi.price) {
      const type = trend === 'DOWN' ? 'CHoCH' : 'BOS';
      events.push({ type, dir: 'BULL', idx: i, t: c.t, price: +c.c.toFixed(2), level: +hi.price.toFixed(2), swingIdx: hi.idx, swingT: hi.t });
      trend = 'UP'; hi = null;
    } else if (lo && c.c < lo.price) {
      const type = trend === 'UP' ? 'CHoCH' : 'BOS';
      events.push({ type, dir: 'BEAR', idx: i, t: c.t, price: +c.c.toFixed(2), level: +lo.price.toFixed(2), swingIdx: lo.idx, swingT: lo.t });
      trend = 'DOWN'; lo = null;
    }
  }
  const lastOf = (t) => [...events].reverse().find((e) => e.type === t) || null;
  return {
    trend,
    lastEvent: events[events.length - 1] || null,
    lastBOS: lastOf('BOS'),
    lastCHoCH: lastOf('CHoCH'),
    bullCount: events.filter((e) => e.dir === 'BULL').length,
    bearCount: events.filter((e) => e.dir === 'BEAR').length,
    levels: {
      swingHigh: sw.highs.length ? { t: sw.highs[sw.highs.length - 1].t, price: +sw.highs[sw.highs.length - 1].price.toFixed(2) } : null,
      swingLow: sw.lows.length ? { t: sw.lows[sw.lows.length - 1].t, price: +sw.lows[sw.lows.length - 1].price.toFixed(2) } : null,
    },
    events,
  };
}

// ── Fair Value Gaps (3-candle imbalance) ─────────────────────────────────
// Bullish FVG: candle[i].low > candle[i-2].high → gap [high(i-2), low(i)].
// Bearish FVG: candle[i].high < candle[i-2].low → gap [high(i), low(i-2)].
// A gap is "filled" once price trades back into it.
function fairValueGaps(candles) {
  const gaps = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2], c = candles[i];
    if (c.l > a.h) gaps.push({ dir: 'BULL', idx: i, t: c.t, top: +c.l.toFixed(2), bottom: +a.h.toFixed(2), filled: false, filledIdx: null, filledT: null });
    else if (c.h < a.l) gaps.push({ dir: 'BEAR', idx: i, t: c.t, top: +a.l.toFixed(2), bottom: +c.h.toFixed(2), filled: false, filledIdx: null, filledT: null });
  }
  for (const g of gaps) {
    for (let k = g.idx + 1; k < candles.length; k++) {
      const touched = g.dir === 'BULL' ? candles[k].l <= g.top : candles[k].h >= g.bottom;
      if (touched) { g.filled = true; g.filledIdx = k; g.filledT = candles[k].t; break; }
    }
  }
  return gaps;
}

// ── Liquidity pools: clusters of equal highs/lows within tol x ATR ───────
// Buy-side liquidity sits above equal highs; sell-side below equal lows.
// A pool is "swept" once price trades beyond the level.
function liquidityPools(candles, swings, atrArr, tolAtr = 0.25) {
  const atrLast = atrArr[candles.length - 1] ?? 0;
  const tol = Math.max(atrLast * tolAtr, 1e-6);
  const cluster = (pts, side) => {
    const out = [];
    const sorted = [...pts].sort((a, b) => a.price - b.price);
    let group = [];
    const flush = () => {
      if (group.length >= 2) {
        const level = group.reduce((s, g) => s + g.price, 0) / group.length;
        const lastIdx = Math.max(...group.map((g) => g.idx));
        let swept = false, sweptIdx = null;
        for (let k = lastIdx + 1; k < candles.length; k++) {
          if (side === 'BUY' ? candles[k].h > level : candles[k].l < level) { swept = true; sweptIdx = k; break; }
        }
        out.push({
          side, level: +level.toFixed(2), touches: group.length, swept, sweptIdx,
          t: candles[lastIdx].t, sweptT: sweptIdx != null ? candles[sweptIdx].t : null,
        });
      }
      group = [];
    };
    for (const p of sorted) {
      if (group.length && p.price - group[group.length - 1].price > tol) flush();
      group.push(p);
    }
    flush();
    return out;
  };
  const buyside = cluster(swings.highs, 'BUY');
  const sellside = cluster(swings.lows, 'SELL');
  return { buyside, sellside, tol: +tol.toFixed(2) };
}

// ── Confluence score: how many independent bullish factors line up ───────
function confluenceScore(last, o, rsi4hNow, activeZoneCount, lastSignal, structure, fvgs, liquidity) {
  const parts = [];
  let score = 0;
  const add = (label, pts, ok) => { if (ok) { score += pts; parts.push({ label, pts }); } };
  add('4H RSI < 50', 15, rsi4hNow != null && rsi4hNow < o.htfRsiMax);
  add('Active order block', 15, activeZoneCount > 0);
  add('Fresh BUY signal', 20, !!lastSignal);
  add('Uptrend structure', 15, structure.trend === 'UP');
  const inBullFvg = fvgs.some((f) => f.dir === 'BULL' && !f.filled && last.c >= f.bottom && last.c <= f.top);
  add('Price in bullish FVG', 15, inBullFvg);
  const sweptSell = liquidity.sellside.some((p) => p.swept);
  add('Sell-side liquidity swept', 10, sweptSell);
  add('Bullish CHoCH', 10, !!(structure.lastCHoCH && structure.lastCHoCH.dir === 'BULL'));
  return { score: Math.min(100, score), parts };
}

// ── Multi-timeframe context: weekly / daily / 4H / 1H agreement ─────────
const TF_WEIGHT = { W: 4, D: 3, '4H': 2, '1H': 1 };

// Bias for one timeframe: structure trend, refined by price vs EMA(20) when
// structure is RANGE. Returns null when there is not enough history.
function timeframeBias(tf, candles, o) {
  if (!candles || candles.length < o.swingLen * 2 + 6) return null;
  const closes = candles.map((c) => c.c);
  const r = rsi(closes, 14);
  const e = ema(closes, 20);
  const price = closes[closes.length - 1];
  const emaLast = e[e.length - 1];
  const st = marketStructure(candles, o.swingLen);
  let bias = st.trend;
  if (bias === 'RANGE' && emaLast != null) bias = price > emaLast ? 'UP' : 'DOWN';
  return {
    tf,
    bars: candles.length,
    trend: st.trend,
    bias,
    rsi: r[r.length - 1] != null ? +r[r.length - 1].toFixed(1) : null,
    aboveEma: emaLast != null ? price > emaLast : null,
    lastEvent: st.lastEvent ? { type: st.lastEvent.type, dir: st.lastEvent.dir, t: st.lastEvent.t } : null,
  };
}

function multiTimeframe(daily, hourly, o) {
  const series = [
    ['W', toWeekly(daily || [])],
    ['D', daily || []],
    ['4H', resample4h(hourly || [])],
    ['1H', hourly || []],
  ];
  const timeframes = [];
  let wBull = 0, wBear = 0, wTotal = 0;
  for (const [tf, candles] of series) {
    const b = timeframeBias(tf, candles, o);
    if (!b) continue;
    timeframes.push(b);
    const w = TF_WEIGHT[tf] || 1;
    if (b.bias === 'UP') wBull += w;
    else if (b.bias === 'DOWN') wBear += w;
    wTotal += w;
  }
  const bull = timeframes.filter((t) => t.bias === 'UP').length;
  const bear = timeframes.filter((t) => t.bias === 'DOWN').length;
  const neutral = timeframes.length - bull - bear;
  let alignment = 'NEUTRAL';
  if (bull && !bear) alignment = 'BULL';
  else if (bear && !bull) alignment = 'BEAR';
  else if (bull && bear) alignment = 'MIXED';
  const score = wTotal ? Math.round(((wBull - wBear) / wTotal) * 100) : 0;
  return { timeframes, bull, bear, neutral, alignment, score };
}

// ── Main analysis ───────────────────────────────────────────────────────
function analyze(daily, hourly, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = daily.length;
  const MIN_BARS = 60;
  if (n < MIN_BARS) return { ok: false, reason: `Not enough history (${n} bars)` };

  const closes = daily.map((c) => c.c);
  const vols = daily.map((c) => c.v);
  const volMa = sma(vols, o.volLen);
  const atrA = atr(daily, o.atrLen);
  const rsiD = rsi(closes, o.rsiLen);
  const emaA = ema(closes, o.emaLen);
  const c4h = resample4h(hourly);
  const rsi4h = rsi(c4h.map((c) => c.c), o.rsiLen);
  const weekly = toWeekly(daily);
  const wMacd = macdHistogram(weekly.map((c) => c.c));

  const wickFlags = daily.map((c, i) => wickRejectionAt(c, volMa[i], o));
  const zones = [];        // every OB zone ever created (chart)
  const signals = [];      // confirmed BUY signals
  const inducementMarks = []; // sweeps that failed a filter (for chart)
  let lastBear = null;     // {i,h,l}
  let active = [];         // active OB zones

  for (let i = 1; i < n; i++) {
    const c = daily[i];
    const a = atrA[i] ?? atrA[n - 1] ?? (c.h - c.l);

    // track last bearish candle (potential bullish OB)
    if (daily[i].c < daily[i].o) lastBear = { i, h: daily[i].h, l: daily[i].l };

    // ── 2. Order block: bullish impulse after bearish candle ──
    const impulseUp = (c.c - daily[i - 1].c) >= o.impAtrMult * a && c.c > daily[i - 1].c;
    if (impulseUp && lastBear && (i - lastBear.i) >= 1 && (i - lastBear.i) <= o.impLookback) {
      const dup = zones.some((z) => z.anchorIdx === lastBear.i);
      if (!dup) {
        const z = {
          anchorIdx: lastBear.i, createdIdx: i,
          top: lastBear.h, bottom: lastBear.l,
          t: daily[lastBear.i].t,
          mitigated: false, swept: false, sweptIdx: null,
          status: 'ACTIVE',
        };
        zones.push(z);
        active.push(z);
      }
    }

    // ── 3. Inducement (liquidity sweep) + mitigation bookkeeping ──
    if (active.length) {
      const nextActive = [];
      for (const z of active) {
        const age = i - z.createdIdx;
        const depth = z.bottom - daily[i].l;

        // decisive break below OB low → mitigated / broken
        if (daily[i].c < z.bottom || (o.mitigateOnDeepSweep && depth > o.sweepAtrMult * a && depth > 0)) {
          z.mitigated = true; z.status = 'MITIGATED';
          continue;
        }
        if (age > o.maxZoneAge) { z.status = 'EXPIRED'; continue; }

        const swept = daily[i].l <= z.top && depth > 0 && depth <= o.sweepAtrMult * a && daily[i].c > z.bottom;

        if (swept && !z.swept) {
          z.swept = true; z.sweptIdx = i;
          const r4 = rsi4h.length ? rsi4h[rsi4h.length - 1] : null;
          // HTF RSI value for this bar (nearest available 4H close <= bar time)
          let htfRsi = null;
          for (let k = rsi4h.length - 1; k >= 0; k--) {
            if (c4h[k] && c4h[k].t <= daily[i].t && rsi4h[k] != null) { htfRsi = rsi4h[k]; break; }
          }
          const passHtf = !o.useHtfRsi || (htfRsi != null && htfRsi < o.htfRsiMax);
          const passWick = !o.requireWickOnSweep || (o.wickLookback > 0
            ? wickFlags.slice(Math.max(0, i - o.wickLookback), i + 1).some(Boolean)
            : wickFlags[i]);
          const passEma = !o.useEma || (emaA[i] != null && daily[i].c > emaA[i]);
          const passRsiD = !o.useDailyRsi || (rsiD[i] != null && rsiD[i] > o.dailyRsiMin);
          let passMacd = true;
          if (o.useWeeklyMacd) {
            const wIdx = weekly.length - 1;
            passMacd = wMacd[wIdx] != null && wMacd[wIdx - 1] != null && wMacd[wIdx] > wMacd[wIdx - 1];
          }

          const entry = {
            i, t: daily[i].t, price: daily[i].c,
            htfRsi, rsiD: rsiD[i], ema: emaA[i], volRatio: volMa[i] ? daily[i].v / volMa[i] : null,
            zone: { top: z.top, bottom: z.bottom, anchorIdx: z.anchorIdx, createdIdx: z.createdIdx },
            filters: { htfRsi: passHtf, wick: passWick, ema: passEma, rsiDaily: passRsiD, macdWeekly: passMacd },
          };

          if (passHtf && passWick && passEma && passRsiD && passMacd) {
            entry.direction = 'BUY';
            signals.push(entry);
            z.signal = 'BUY';
          } else {
            entry.direction = 'INDUCEMENT';
            inducementMarks.push(entry);
          }
        }
        nextActive.push(z);
      }
      active = nextActive;
    }
  }

  // ── Backtest of confirmed BUY signals (SL/TP/time exits, no lookahead) ──
  const trades = [];
  const lastAtr = atrA[n - 1] ?? (daily[n - 1].h - daily[n - 1].l);
  for (const s of signals) {
    const entryPx = s.price;
    const sl = entryPx * (1 - o.slPct / 100);
    const tp = entryPx * (1 + o.tpPct / 100);
    let exit = null, exitPx = null, reason = null;
    for (let k = s.i + 1; k < n && k <= s.i + o.maxBars; k++) {
      if (daily[k].l <= sl) { exit = k; exitPx = sl; reason = 'STOP LOSS'; break; }
      if (daily[k].h >= tp) { exit = k; exitPx = tp; reason = 'TARGET'; break; }
    }
    if (exit == null) { exit = Math.min(s.i + o.maxBars, n - 1); exitPx = daily[exit].c; reason = exit === n - 1 ? 'OPEN (latest bar)' : 'TIME EXIT'; }
    trades.push({
      entryTs: daily[s.i].t, exitTs: daily[exit].t, entry: entryPx, exit: exitPx,
      sl, tp, reason, pct: ((exitPx - entryPx) / entryPx) * 100,
      bars: exit - s.i,
    });
  }
  const closed = trades.filter((t) => t.reason !== 'Open (latest bar)' && t.reason !== 'OPEN');
  const wins = closed.filter((t) => t.pct > 0);
  const losses = closed.filter((t) => t.pct <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pct, 0));
  const netPct = closed.reduce((a, t) => a + t.pct, 0);
  const equity = []; let run = 0;
  for (const t of closed) { run += t.pct; equity.push(run); }
  let peak = 0, maxDD = 0;
  for (const e of equity) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, peak - e); }
  const stats = {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? +(wins.length / closed.length * 100).toFixed(1) : 0,
    profitFactor: grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? 99 : 0),
    netProfitPct: +netPct.toFixed(2),
    grossProfitPct: +grossProfit.toFixed(2),
    grossLossPct: +grossLoss.toFixed(2),
    maxDrawdownPct: +maxDD.toFixed(2),
    avgTradePct: closed.length ? +(netPct / closed.length).toFixed(2) : 0,
    bestTradePct: closed.length ? +Math.max(...closed.map((t) => t.pct)).toFixed(2) : 0,
    worstTradePct: closed.length ? +Math.min(...closed.map((t) => t.pct)).toFixed(2) : 0,
    equityCurve: equity,
  };

  const last = daily[n - 1];
  const prev = daily[n - 2];
  const activeZones = zones.filter((z) => z.status === 'ACTIVE');

  // ── context layers (additive; do not affect signals/backtest above) ──
  const swings = findSwings(daily, o.swingLen);
  const structure = marketStructure(daily, o.swingLen, swings);
  const allFvgs = fairValueGaps(daily);
  const liquidity = liquidityPools(daily, swings, atrA, o.liqTolAtr);
  const mtf = multiTimeframe(daily, hourly, o);
  const rsi4hNow = rsi4h.length && rsi4h[rsi4h.length - 1] != null ? +rsi4h[rsi4h.length - 1].toFixed(1) : null;
  const lastSig = signals.length ? signals[signals.length - 1] : null;
  const confluence = confluenceScore(last, o, rsi4hNow, activeZones.length, lastSig, structure, allFvgs, liquidity);
  const unfilled = allFvgs.filter((f) => !f.filled);
  const nearestFvg = unfilled
    .map((f) => ({ ...f, distance: +Math.abs(last.c - (f.top + f.bottom) / 2).toFixed(2) }))
    .sort((a, b) => a.distance - b.distance)[0] || null;
  const recentZones = zones.slice(-24).map((z) => ({
    t: z.t, top: +z.top.toFixed(2), bottom: +z.bottom.toFixed(2),
    status: z.status, signal: z.signal || null, anchorIdx: z.anchorIdx, swept: z.swept,
  }));

  return {
    ok: true,
    price: last.c,
    changePct: prev ? +(((last.c - prev.c) / prev.c) * 100).toFixed(2) : 0,
    volume: last.v,
    volRatio: volMa[n - 1] ? +(last.v / volMa[n - 1]).toFixed(2) : null,
    rsi4h: rsi4h.length && rsi4h[rsi4h.length - 1] != null ? +rsi4h[rsi4h.length - 1].toFixed(1) : null,
    rsiDaily: rsiD[n - 1] != null ? +rsiD[n - 1].toFixed(1) : null,
    ema50: emaA[n - 1] != null ? +emaA[n - 1].toFixed(2) : null,
    atr: lastAtr != null ? +lastAtr.toFixed(2) : null,
    wickLastIdx: wickFlags.lastIndexOf(true),
    wickCount: wickFlags.filter(Boolean).length,
    activeZones: activeZones.map((z) => ({ top: +z.top.toFixed(2), bottom: +z.bottom.toFixed(2), createdIdx: z.createdIdx, swept: z.swept, age: n - 1 - z.createdIdx })),
    signals: signals.map((s) => ({ t: s.t, price: s.price, htfRsi: s.htfRsi, dir: s.direction, zone: { top: +s.zone.top.toFixed(2), bottom: +s.zone.bottom.toFixed(2) } })),
    inducements: inducementMarks.map((s) => ({ t: s.t, price: s.price, htfRsi: s.htfRsi, filters: s.filters })),
    zones: recentZones,
    lastSignal: signals.length ? { t: signals[signals.length - 1].t, price: signals[signals.length - 1].price, htfRsi: signals[signals.length - 1].htfRsi } : null,
    signalCount: signals.length,
    structure: {
      trend: structure.trend,
      lastEvent: structure.lastEvent,
      lastBOS: structure.lastBOS,
      lastCHoCH: structure.lastCHoCH,
      bullCount: structure.bullCount,
      bearCount: structure.bearCount,
      levels: structure.levels,
      events: structure.events.slice(-o.structureMax),
    },
    fvgs: allFvgs.slice(-o.fvgMax).map((f) => ({ dir: f.dir, top: f.top, bottom: f.bottom, t: f.t, filled: f.filled, filledT: f.filledT })),
    nearestFvg: nearestFvg
      ? { dir: nearestFvg.dir, top: nearestFvg.top, bottom: nearestFvg.bottom, t: nearestFvg.t, filled: nearestFvg.filled, distance: nearestFvg.distance }
      : null,
    liquidity: {
      tol: liquidity.tol,
      buyside: liquidity.buyside.slice(-o.liqMax),
      sellside: liquidity.sellside.slice(-o.liqMax),
    },
    mtf,
    confluence,
    stats,
    bars: n,
    optsUsed: o,
  };
}

// Named presets. DEFAULTS above IS the "improved" preset (the only variant that
// actually triggers on real daily data). "strict" is the original specification:
// it requires a full wick-rejection candle to also be the sweep bar and only
// allows a 0.3 x ATR sweep — on daily large-caps that produces ~0 signals.
const PRESETS = {
  improved: {},
  strict: {
    wickMult: 2.0,
    closePct: 0.70,
    sweepAtrMult: 0.3,
    requireWickOnSweep: true,
    wickLookback: 0,
    mitigateOnDeepSweep: true,
  },
};

module.exports = {
  analyze, DEFAULTS, PRESETS, wickRejectionAt, bearWickRejectionAt,
  findSwings, marketStructure, fairValueGaps, liquidityPools, confluenceScore, multiTimeframe,
};
