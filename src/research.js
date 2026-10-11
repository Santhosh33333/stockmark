// Deterministic, evidence-based research assistant.
//
// It NEVER invents prices, indicators or probabilities. It only reorganises the
// numbers already computed by the SMC engine into bull/bear evidence, conflicts,
// risks, missing-data notes and reference levels. Probability estimates are
// surfaced ONLY from the strategy's own historical sample and are explicitly
// labelled in-sample (not a calibrated, out-of-sample forecast).
const { inr } = require('./util');

function pct(v, d = 2) { return v == null || !isFinite(v) ? null : +Number(v).toFixed(d); }

// Nearest reference level at/under price from a candidate list.
function nearestBelow(price, candidates) {
  return candidates.filter((c) => c.price != null && c.price <= price).sort((a, b) => b.price - a.price)[0] || null;
}
function nextAbove(price, candidates) {
  return candidates.filter((c) => c.price != null && c.price > price).sort((a, b) => a.price - b.price)[0] || null;
}

function build(a, meta = {}) {
  if (!a || !a.ok) return { ok: false, reason: a?.reason || 'no analysis' };
  const price = a.price;
  const sym = meta.symbol || a.symbol || '';

  const bull = [];
  const bear = [];
  const conflicts = [];
  const risks = [];
  const missing = [];
  const add = (arr, label, value, detail) => arr.push({ label, value: value ?? null, detail: detail || null });

  // ── Structure ──
  const trend = a.structure?.trend;
  add(trend === 'UP' ? bull : trend === 'DOWN' ? bear : conflicts, `Daily structure: ${trend}`, trend,
    a.structure?.lastEvent ? `Last event ${a.structure.lastEvent.type} (${a.structure.lastEvent.dir}) at ₹${a.structure.lastEvent.price}` : 'no confirmed break yet');

  // ── Multi-timeframe ──
  const align = a.mtf?.alignment;
  if (align === 'BULL') add(bull, 'Multi-timeframe alignment: bullish', a.mtf.score, `${a.mtf.bull}/${a.mtf.timeframes.length} timeframes up`);
  else if (align === 'BEAR') add(bear, 'Multi-timeframe alignment: bearish', a.mtf.score, `${a.mtf.bear}/${a.mtf.timeframes.length} timeframes down`);
  else if (align === 'MIXED') add(conflicts, 'Timeframes disagree (MIXED)', a.mtf.score, a.mtf.timeframes.map((t) => `${t.tf}:${t.bias}`).join(' '));
  else add(conflicts, 'Timeframes neutral/ranging', a.mtf?.score ?? null, 'no dominant bias');

  // ── Premium / discount ──
  const pd = a.premiumDiscount;
  if (pd) {
    if (pd.zone === 'DISCOUNT') add(bull, 'Price in discount zone', pd.positionPct, `EQ ₹${pd.equilibrium} of ₹${pd.low}–₹${pd.high}`);
    else if (pd.zone === 'PREMIUM') add(bear, 'Price in premium zone', pd.positionPct, `EQ ₹${pd.equilibrium} of ₹${pd.low}–₹${pd.high}`);
    else add(conflicts, 'Price at equilibrium', pd.positionPct, `EQ ₹${pd.equilibrium}`);
  } else missing.push('Dealing range (not enough swing pivots)');

  // ── Latest signal ──
  const ls = a.lastSignal;
  if (ls) {
    const label = `Latest SMC signal @ ₹${ls.price} (${ls.confirmed ? 'confirmed' : 'forming/unconfirmed'})`;
    add(bull, label, ls.htfRsi, ls.reasons?.[0] || 'wick + order block + inducement');
    if (!ls.confirmed) add(risks, 'Signal is on the still-forming bar', null, 'Wait for the daily candle to close before acting.');
  } else {
    add(conflicts, 'No active BUY signal', null, 'Rules are not currently aligned.');
  }

  // ── RSI / momentum ──
  if (a.rsi4h != null) add(a.rsi4h < (a.optsUsed?.htfRsiMax ?? 50) ? bull : bear, `4H RSI ${a.rsi4h}`, a.rsi4h, a.rsi4h < 50 ? 'below 50 (pullback zone for longs)' : 'above 50');
  if (a.rsiDaily != null) add(a.rsiDaily >= 55 ? bull : bear, `Daily RSI ${a.rsiDaily}`, a.rsiDaily, a.rsiDaily >= 55 ? 'strong momentum' : 'muted momentum');

  // ── Volume / VWAP ──
  if (a.volRatio != null) {
    if (a.volRatio >= 1.2) add(bull, `Volume ${a.volRatio}× average`, a.volRatio, 'volume confirmation');
    else if (a.volRatio < 0.8) add(risks, `Volume ${a.volRatio}× average`, a.volRatio, 'thin participation');
  }
  if (a.vwap) {
    if (a.vwap.aboveSession != null) add(a.vwap.aboveSession ? bull : bear, `Price ${a.vwap.aboveSession ? 'above' : 'below'} session VWAP`, a.vwap.session, `VWAP ₹${a.vwap.session}`);
  }

  // ── FVG / liquidity ──
  const unsafeFvg = a.fvgs?.find((f) => !f.filled && f.dir === 'BULL' && price >= f.bottom && price <= f.top);
  if (unsafeFvg) add(bull, 'Price trading inside a bullish FVG', unsafeFvg.t, `₹${unsafeFvg.bottom}–₹${unsafeFvg.top}`);
  const unfilledBull = (a.fvgs || []).filter((f) => !f.filled);
  if (!unfilledBull.length) missing.push('No unfilled fair-value gaps in the window');
  const sweptBuy = (a.liquidity?.buyside || []).filter((p) => p.swept);
  const sweptSell = (a.liquidity?.sellside || []).filter((p) => p.swept);
  if (sweptSell.length) add(bull, 'Sell-side liquidity swept (stop run below)', sweptSell.length, `last at ₹${sweptSell[sweptSell.length - 1].level}`);
  if (sweptBuy.length) add(bear, 'Buy-side liquidity swept (stop run above)', sweptBuy.length, `last at ₹${sweptBuy[sweptBuy.length - 1].level}`);

  // ── Displacement ──
  if (a.displacement?.last) {
    const d = a.displacement.last;
    add(d.dir === 'BULL' ? bull : bear, `Displacement candle (${d.dir})`, d.atrMult, `${d.atrMult}× ATR body at ₹${price}`);
  }

  // ── Missing data ──
  if (!a.mtf?.timeframes?.some((t) => t.tf === '1H')) missing.push('1-hour series unavailable from provider');
  if (!a.mtf?.timeframes?.some((t) => t.tf === '5m' || t.tf === '15m')) missing.push('Intraday 5m/15m frames not requested (add ?intraday=1)');
  if (!a.activeZones?.length) missing.push('No active (unmitigated) order block');
  if (a.bars < 220) missing.push(`Limited history (${a.bars} daily bars)`);

  // ── Reference levels (deterministic; from the engine's own numbers) ──
  const invCandidates = [
    a.activeZones?.[a.activeZones.length - 1] ? { price: a.activeZones[a.activeZones.length - 1].bottom, label: 'Active order block low' } : null,
    a.structure?.levels?.swingLow ? { price: a.structure.levels.swingLow.price, label: 'Last swing low' } : null,
    pd ? { price: pd.low, label: 'Dealing range low' } : null,
  ].filter(Boolean).map((c) => ({ ...c, price: pct(c.price) }));

  const targetCandidates = [
    a.nearestFvg && !a.nearestFvg.filled ? { price: a.nearestFvg.top, label: 'Unfilled FVG top' } : null,
    pd ? { price: pd.equilibrium, label: 'Equilibrium (EQ)' } : null,
    pd ? { price: pd.high, label: 'Dealing range high' } : null,
    (a.liquidity?.buyside || []).length ? { price: a.liquidity.buyside[a.liquidity.buyside.length - 1].level, label: 'Buy-side liquidity' } : null,
  ].filter(Boolean).map((c) => ({ ...c, price: pct(c.price) }));

  const invalidation = nearestBelow(price, invCandidates);
  const targets = targetCandidates.filter((t) => t.price > price).sort((a, b) => a.price - b.price).slice(0, 3);
  const firstTarget = targets[0] || null;
  const risk = invalidation ? price - invalidation.price : null;
  const reward = firstTarget ? firstTarget.price - price : null;
  const rr = risk && reward && risk > 0 ? +(reward / risk).toFixed(2) : null;

  // ── Probability: historical sample only, never invented ──
  const s = a.stats || {};
  const probability = {
    calibrated: false,
    note: 'No calibrated, out-of-sample probability model is available. The figures below are the strategy\'s own in-sample results on the fetched window — not a forecast.',
    historical: {
      sampleSize: s.trades ?? 0,
      winRate: s.winRate ?? null,
      profitFactor: s.profitFactor ?? null,
      avgTradePct: s.avgTradePct ?? null,
      maxDrawdownPct: s.maxDrawdownPct ?? null,
      bars: a.bars ?? null,
      periodFrom: meta.dataFrom || null,
      periodTo: meta.dataTo || null,
      outOfSample: false,
    },
  };

  const summary = { bull: bull.length, bear: bear.length, conflicts: conflicts.length, risks: risks.length, missing: missing.length };
  const stance = bull.length > bear.length + conflicts.length ? 'BULLISH-leaning'
    : bear.length > bull.length + conflicts.length ? 'BEARISH-leaning'
    : 'MIXED / no edge';

  const headline = `${sym || 'Symbol'} @ ${inr(price, true)} — ${stance}. ` +
    `Structure ${trend}, MTF ${align || 'n/a'} (${a.mtf?.score ?? 0}). ` +
    `${ls ? (ls.confirmed ? 'Latest signal confirmed' : 'Latest signal still forming') : 'No active signal'}; ` +
    (invalidation ? `reference invalidation ₹${invalidation.price}` : 'no nearby invalidation found') +
    (firstTarget ? `, first reference target ₹${firstTarget.price}` : '') +
    (rr != null ? `, reference R:R ≈ 1:${rr}.` : '.');

  return {
    ok: true, symbol: sym, price, headline, stance, summary,
    bullEvidence: bull, bearEvidence: bear, conflicts, risks, missingData: missing,
    levels: {
      entryReference: pct(price),
      invalidation,
      targets,
      referenceRiskReward: rr,
      riskPerShare: risk != null ? pct(risk) : null,
      rewardPerShare: reward != null ? pct(reward) : null,
    },
    probability,
    disclaimer: 'Educational analysis of deterministic indicators. Not investment advice. Markets carry risk; no outcome is guaranteed.',
  };
}

module.exports = { build };
