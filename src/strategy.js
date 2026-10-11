// ═══════════════════════════════════════════════════════════════════════
//  SMC Strategy Engine — Wick Rejection + Order Block + Inducement
//  This is the JavaScript twin of pine/smc_wick_ob_inducement.pine so the
//  web scanner, paper trader and TradingView all use IDENTICAL rules.
// ═══════════════════════════════════════════════════════════════════════
const { sma, ema, rsi, atr, macdHistogram, resample4h, adx, bollinger } = require('./indicators');
const costs = require('./costs');
const regime = require('./regime');

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
  // 6. extra context (additive; report-only)
  adxLen: 14,             // ADX / +/-DI period (daily)
  bbLen: 20, bbMult: 2,   // Bollinger Bands period + width multiplier (daily)
  scoreOff: [],           // confluence factor labels to disable, e.g. ['4H RSI < 50']
  rangeLookback: 60,      // bars used for the premium/discount dealing range
  dispMult: 1.5,          // body >= N x ATR counts as a displacement candle
  vwapWindow: 20,         // rolling VWAP window
  formingLastBar: false,  // true while the market is open (last daily bar not closed)
  intraday: null,         // { '5m': [...], '15m': [...] } optional MTF frames
  // 7. backtest realism (opt-in; never affects live signal generation)
  useCosts: false,        // subtract brokerage/STT/GST/slippage from trade P&L
  costs: null,            // overrides for src/costs.js DEFAULTS
  trainSplit: 0,          // e.g. 0.7 → also report in-sample + out-of-sample stats
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

// ── Premium / discount (dealing range) ───────────────────────────────────
// Equilibrium = midpoint of the most recent dealing range (highest swing high
// vs lowest swing low within `lookback` bars). Price above EQ = premium,
// below = discount. Used to avoid buying into premium.
function premiumDiscount(candles, swings, lookback = 60) {
  const n = candles.length;
  const from = Math.max(0, n - lookback);
  const hs = swings.highs.filter((s) => s.idx >= from);
  const ls = swings.lows.filter((s) => s.idx >= from);
  let high = hs.length ? Math.max(...hs.map((s) => s.price)) : null;
  let low = ls.length ? Math.min(...ls.map((s) => s.price)) : null;
  if (high == null || low == null) {
    const slice = candles.slice(from);
    high = Math.max(...slice.map((c) => c.h));
    low = Math.min(...slice.map((c) => c.l));
  }
  if (!(high > low)) return null;
  const eq = (high + low) / 2;
  const price = candles[n - 1].c;
  const pct = (price - low) / (high - low);
  const zone = Math.abs(pct - 0.5) <= 0.05 ? 'EQUILIBRIUM' : pct >= 0.5 ? 'PREMIUM' : 'DISCOUNT';
  return {
    high: +high.toFixed(2), low: +low.toFixed(2), equilibrium: +eq.toFixed(2),
    positionPct: +pct.toFixed(3), zone,
    premium: { top: +high.toFixed(2), bottom: +eq.toFixed(2) },
    discount: { top: +eq.toFixed(2), bottom: +low.toFixed(2) },
  };
}

// ── Displacement candles (large-body, high-conviction moves) ──────────────
function displacement(candles, atrArr, mult = 1.5) {
  const hits = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const a = atrArr[i];
    if (a == null || a <= 0) continue;
    const body = Math.abs(c.c - c.o);
    const range = c.h - c.l;
    if (range <= 0) continue;
    if (body >= mult * a && body / range >= 0.6) {
      hits.push({ idx: i, t: c.t, dir: c.c >= c.o ? 'BULL' : 'BEAR', body: +body.toFixed(2), atrMult: +(body / a).toFixed(2) });
    }
  }
  return { count: hits.length, last: hits[hits.length - 1] || null, recent: hits.slice(-6) };
}

// ── VWAP (session-anchored when intraday dates are available, else rolling) ─
function vwap(candles, window = 20) {
  if (!candles || !candles.length) return null;
  const typ = (c) => (c.h + c.l + c.c) / 3;
  // Anchor to the most recent IST session
  const istDay = (t) => new Date(t + 5.5 * 3600000).toISOString().slice(0, 10);
  const lastDay = istDay(candles[candles.length - 1].t);
  let pv = 0, vv = 0, bars = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (istDay(candles[i].t) !== lastDay) break;
    const v = candles[i].v > 0 ? candles[i].v : 1;
    pv += typ(candles[i]) * v; vv += v; bars++;
  }
  const session = vv > 0 ? pv / vv : null;
  // Rolling N-bar VWAP as a secondary reference
  let rpv = 0, rvv = 0;
  for (let i = Math.max(0, candles.length - window); i < candles.length; i++) {
    const v = candles[i].v > 0 ? candles[i].v : 1;
    rpv += typ(candles[i]) * v; rvv += v;
  }
  const rolling = rvv > 0 ? rpv / rvv : null;
  const price = candles[candles.length - 1].c;
  return {
    session: session != null ? +session.toFixed(2) : null,
    rolling: rolling != null ? +rolling.toFixed(2) : null,
    sessionBars: bars,
    aboveSession: session != null ? price > session : null,
    aboveRolling: rolling != null ? price > rolling : null,
  };
}

// ── Labelled swing structure (HH / HL / LH / LL progression) ──────────────
function swingStructure(swings, max = 10) {
  const pts = [
    ...swings.highs.map((s) => ({ ...s, type: 'H' })),
    ...swings.lows.map((s) => ({ ...s, type: 'L' })),
  ].sort((a, b) => a.idx - b.idx);

  const labelled = [];
  let prevH = null, prevL = null;
  for (const p of pts) {
    let label;
    if (p.type === 'H') { label = prevH == null ? 'H' : (p.price > prevH ? 'HH' : p.price < prevH ? 'LH' : 'EH'); prevH = p.price; }
    else { label = prevL == null ? 'L' : (p.price > prevL ? 'HL' : p.price < prevL ? 'LL' : 'EL'); prevL = p.price; }
    labelled.push({ ...p, label });
  }
  const last = labelled.slice(-max);
  const labels = last.map((l) => l.label);
  let bias = 'NEUTRAL';
  const tail = labels.slice(-4);
  if (tail.includes('HH') && tail.includes('HL')) bias = 'UP';
  else if (tail.includes('LL') && tail.includes('LH')) bias = 'DOWN';
  return { bias, labels, last: last[last.length - 1] || null, points: last };
}

// ── Confluence score: how many independent bullish factors line up ───────
function confluenceScore(last, o, rsi4hNow, activeZoneCount, lastSignal, structure, fvgs, liquidity) {
  const parts = [];
  const disabled = [];
  let score = 0;
  const off = new Set((o.scoreOff || []).map((s) => String(s)));
  const add = (label, pts, ok) => {
    if (off.has(label)) { disabled.push({ label, pts }); return; }
    if (ok) { score += pts; parts.push({ label, pts }); }
    else parts.push({ label, pts, missed: true });
  };
  add('4H RSI < 50', 15, rsi4hNow != null && rsi4hNow < o.htfRsiMax);
  add('Active order block', 15, activeZoneCount > 0);
  add('Fresh BUY signal', 20, !!lastSignal);
  add('Uptrend structure', 15, structure.trend === 'UP');
  const inBullFvg = fvgs.some((f) => f.dir === 'BULL' && !f.filled && last.c >= f.bottom && last.c <= f.top);
  add('Price in bullish FVG', 15, inBullFvg);
  const sweptSell = liquidity.sellside.some((p) => p.swept);
  add('Sell-side liquidity swept', 10, sweptSell);
  add('Bullish CHoCH', 10, !!(structure.lastCHoCH && structure.lastCHoCH.dir === 'BULL'));
  return {
    score: Math.min(100, score),
    max: 100 - disabled.reduce((a, d) => a + d.pts, 0),
    parts, disabled,
    note: 'Rule-based confluence rating (0–100 of the enabled factors). Not a probability of profit.',
  };
}

// ── Multi-timeframe context: weekly / daily / 4H / 1H agreement ─────────
const TF_WEIGHT = { W: 4, D: 3, '4H': 2, '1H': 1, '15m': 0.75, '5m': 0.5 };

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

function multiTimeframe(daily, hourly, o, intraday = {}) {
  const series = [
    ['W', toWeekly(daily || [])],
    ['D', daily || []],
    ['4H', resample4h(hourly || [])],
    ['1H', hourly || []],
    ['15m', intraday['15m'] || []],
    ['5m', intraday['5m'] || []],
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

// ── Human-readable rule trace for a signal (what exactly triggered) ───────
function buildReasons(o, entry, z) {
  const r = [];
  r.push(`Lower-wick rejection: lower wick ≥ ${o.wickMult}× body with close in top ${Math.round((1 - o.closePct) * 100)}% of range`);
  r.push(`Bullish order block at ₹${z.bottom.toFixed(2)}–₹${z.top.toFixed(2)} (bearish candle + ≥${o.impAtrMult}×ATR impulse)`);
  r.push(`Sweep of the order block low within ${o.sweepAtrMult}×ATR of ATR (inducement)`);
  if (entry.filters && entry.filters.htfRsi) r.push(`4H RSI ${entry.htfRsi != null ? entry.htfRsi : '—'} < ${o.htfRsiMax}`);
  if (entry.filters && entry.filters.ema) r.push(`Close above EMA(${o.emaLen})`);
  if (entry.filters && entry.filters.rsiDaily) r.push(`Daily RSI > ${o.dailyRsiMin}`);
  if (entry.filters && entry.filters.macdWeekly) r.push('Weekly MACD histogram rising');
  return r;
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
  const adxA = adx(daily, o.adxLen);
  const bbA = bollinger(closes, o.bbLen, o.bbMult);

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

          entry.reasons = buildReasons(o, entry, z);
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
  const closed = trades.filter((t) => !/^open/i.test(t.reason));
  // Apply the cost model (opt-in) so P&L is net of brokerage/STT/GST/slippage.
  let totalCostPct = 0;
  for (const t of trades) {
    t.grossPct = +t.pct.toFixed(4);
    if (o.useCosts) {
      const notional = Number((o.costs && o.costs.notional) || 100000);
      const qty = Math.max(1, Math.floor(notional / t.entry));
      const rt = costs.roundTrip({ entryPrice: t.entry, exitPrice: t.exit, qty, cfg: o.costs });
      t.costPct = rt.costPct;
      t.pct = +(t.pct - rt.costPct).toFixed(4);
      if (!/^open/i.test(t.reason)) totalCostPct += rt.costPct;
    } else { t.costPct = 0; }
  }
  function summarize(list) {
    const wins = list.filter((t) => t.pct > 0);
    const losses = list.filter((t) => t.pct <= 0);
    const gp = wins.reduce((a, t) => a + t.pct, 0);
    const gl = Math.abs(losses.reduce((a, t) => a + t.pct, 0));
    const net = list.reduce((a, t) => a + t.pct, 0);
    const eq = []; let run = 0;
    for (const t of list) { run += t.pct; eq.push(+run.toFixed(4)); }
    let peak = 0, dd = 0;
    for (const e of eq) { peak = Math.max(peak, e); dd = Math.max(dd, peak - e); }
    return {
      trades: list.length, wins: wins.length, losses: losses.length,
      winRate: list.length ? +(wins.length / list.length * 100).toFixed(1) : 0,
      profitFactor: gl > 0 ? +(gp / gl).toFixed(2) : (gp > 0 ? 99 : 0),
      netProfitPct: +net.toFixed(2),
      grossProfitPct: +gp.toFixed(2), grossLossPct: +gl.toFixed(2),
      maxDrawdownPct: +dd.toFixed(2),
      avgTradePct: list.length ? +(net / list.length).toFixed(2) : 0,
      expectancyPct: list.length ? +(net / list.length).toFixed(2) : 0,
      bestTradePct: list.length ? +Math.max(...list.map((t) => t.pct)).toFixed(2) : 0,
      worstTradePct: list.length ? +Math.min(...list.map((t) => t.pct)).toFixed(2) : 0,
      equityCurve: eq,
    };
  }
  const stats = summarize(closed);
  stats.costsApplied = !!o.useCosts;
  stats.totalCostsPct = +totalCostPct.toFixed(2);
  if (o.useCosts) stats.costModel = costs.merge(o.costs);
  // Train / test split: in-sample vs out-of-sample (no look-ahead — chronological).
  if (o.trainSplit > 0 && closed.length >= 4) {
    const at = Math.max(1, Math.min(closed.length - 1, Math.floor(closed.length * o.trainSplit)));
    stats.inSample = summarize(closed.slice(0, at));
    stats.outOfSample = summarize(closed.slice(at));
    stats.trainSplit = o.trainSplit;
  }

  const last = daily[n - 1];
  const prev = daily[n - 2];
  const activeZones = zones.filter((z) => z.status === 'ACTIVE');

  // ── context layers (additive; do not affect signals/backtest above) ──
  const swings = findSwings(daily, o.swingLen);
  const structure = marketStructure(daily, o.swingLen, swings);
  const allFvgs = fairValueGaps(daily);
  const liquidity = liquidityPools(daily, swings, atrA, o.liqTolAtr);
  const mtf = multiTimeframe(daily, hourly, o, (o.intraday) || {});
  const premDisc = premiumDiscount(daily, swings, o.rangeLookback);
  const disp = displacement(daily, atrA, o.dispMult);
  const vw = vwap(hourly && hourly.length ? hourly : daily, o.vwapWindow);
  const swStruct = swingStructure(swings);
  const forming = !!o.formingLastBar;
  const rsi4hNow = rsi4h.length && rsi4h[rsi4h.length - 1] != null ? +rsi4h[rsi4h.length - 1].toFixed(1) : null;
  const lastSig = signals.length ? signals[signals.length - 1] : null;
  const confluence = confluenceScore(last, o, rsi4hNow, activeZones.length, lastSig, structure, allFvgs, liquidity);
  // ── trend/volatility context (additive; report-only) ──
  const adxNow = adxA.adx[n - 1] ?? null;
  const atrPctNow = lastAtr != null && last.c > 0 ? +(lastAtr / last.c * 100).toFixed(2) : null;
  const bbNow = bbA.widthPct[n - 1] ?? null;
  const bbHist = bbA.widthPct.filter((v) => v != null).slice(-120).sort((a, b) => a - b);
  const bbMed = bbHist.length ? +bbHist[Math.floor(bbHist.length / 2)].toFixed(3) : null;
  const marketRegime = regime.classify({
    candles: daily, adxNow, atrPctNow, bbWidthNow: bbNow, bbWidthMedian: bbMed,
    trend: structure.trend, mtfAlign: mtf.alignment,
  });
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
    atrPct: atrPctNow,
    adx: adxNow,
    plusDI: adxA.plusDI[n - 1] ?? null,
    minusDI: adxA.minusDI[n - 1] ?? null,
    adxPeriod: o.adxLen,
    bollinger: bbA.middle[n - 1] != null ? {
      period: o.bbLen, mult: o.bbMult,
      middle: +bbA.middle[n - 1].toFixed(2), upper: +bbA.upper[n - 1].toFixed(2), lower: +bbA.lower[n - 1].toFixed(2),
      widthPct: bbNow, medianWidthPct: bbMed,
      position: last.c > bbA.upper[n - 1] ? 'ABOVE_UPPER' : last.c < bbA.lower[n - 1] ? 'BELOW_LOWER' : 'INSIDE',
    } : null,
    regime: marketRegime,
    wickLastIdx: wickFlags.lastIndexOf(true),
    wickCount: wickFlags.filter(Boolean).length,
    activeZones: activeZones.map((z) => ({ top: +z.top.toFixed(2), bottom: +z.bottom.toFixed(2), createdIdx: z.createdIdx, swept: z.swept, age: n - 1 - z.createdIdx })),
    signals: signals.map((s) => {
      const entry = s.price;
      const invalidation = entry * (1 - o.slPct / 100);
      const target = entry * (1 + o.tpPct / 100);
      return {
        t: s.t, price: s.price, htfRsi: s.htfRsi, dir: s.direction,
        timeframe: 'D',
        zone: { top: +s.zone.top.toFixed(2), bottom: +s.zone.bottom.toFixed(2) },
        entry: +entry.toFixed(2),
        invalidation: +invalidation.toFixed(2),
        targets: [{ label: `${o.tpPct}% target`, price: +target.toFixed(2) }],
        riskReward: o.slPct > 0 ? +(o.tpPct / o.slPct).toFixed(2) : null,
        confirmed: s.i < n - 1 || !forming,
        reasons: s.reasons || [],
      };
    }),
    inducements: inducementMarks.map((s) => ({ t: s.t, price: s.price, htfRsi: s.htfRsi, filters: s.filters })),
    zones: recentZones,
    lastSignal: signals.length ? {
      t: signals[signals.length - 1].t, price: signals[signals.length - 1].price,
      htfRsi: signals[signals.length - 1].htfRsi,
      confirmed: signals[signals.length - 1].i < n - 1 || !forming,
      reasons: signals[signals.length - 1].reasons || [],
    } : null,
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
    equalHighs: liquidity.buyside.slice(-o.liqMax),
    equalLows: liquidity.sellside.slice(-o.liqMax),
    premiumDiscount: premDisc,
    displacement: disp,
    vwap: vw,
    swingStructure: swStruct,
    formingLastBar: forming,
    mtf,
    confluence,
    stats,
    trades: trades.map((t) => ({
      entryTs: t.entryTs, exitTs: t.exitTs, entry: +t.entry.toFixed(2), exit: +t.exit.toFixed(2),
      sl: +t.sl.toFixed(2), tp: +t.tp.toFixed(2), reason: t.reason, pct: +t.pct.toFixed(2),
      grossPct: t.grossPct != null ? +t.grossPct.toFixed(2) : +t.pct.toFixed(2),
      costPct: t.costPct != null ? +t.costPct.toFixed(4) : 0,
      bars: t.bars,
    })),
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
  premiumDiscount, displacement, vwap, swingStructure, buildReasons,
};
