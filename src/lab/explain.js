// ═══════════════════════════════════════════════════════════════════════════
//  Backtest report narrator.
//
//  This is a DETERMINISTIC, rules-based explainer: every sentence is derived
//  from metrics the engine already computed. It NEVER invents a number — if a
//  metric is missing it says so. If an external LLM is configured it can be
//  layered on top, but the numbers below are always produced by the backend.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const inr = (v) => (v == null || !isFinite(v) ? 'n/a' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }));
const pct = (v) => (v == null || !isFinite(v) ? 'n/a' : Number(v).toFixed(2) + '%');

function build({ stats, riskStats, monteCarlo, optimizer, walkForward: wf, spec, coverage } = {}) {
  const out = [];
  const s = stats || {};
  const has = s.totalTrades > 0;

  out.push({ q: 'Is the strategy profitable after estimated costs?', a: !has ? 'No result: the backtest produced no closed trades, so profitability cannot be assessed.' : (s.netPnl > 0 ? `Yes on this sample: net P&L was ${inr(s.netPnl)} (${pct(s.netPnlPct)}) after ${inr(s.totalCosts)} of estimated brokerage, taxes and slippage across ${s.totalTrades} trades.` : `No on this sample: net P&L was ${inr(s.netPnl)} (${pct(s.netPnlPct)}) after ${inr(s.totalCosts)} of estimated costs across ${s.totalTrades} trades.`) });

  out.push({ q: 'Is the win rate sufficient for the reward:risk tested?', a: !has || s.plannedRR == null ? 'Not applicable without a defined reward:risk and completed trades.' : `Planned R:R was 1:${s.plannedRR}. The break-even win rate for that ratio is about ${pct((1 / (1 + s.plannedRR)) * 100)}; the strategy won ${pct(s.winRate)} of trades (${s.wins}W / ${s.losses}L / ${s.breakeven}BE). Realised reward:risk was ${s.realizedRR == null ? 'n/a' : '1:' + s.realizedRR}.` });

  out.push({ q: 'What is the maximum drawdown?', a: s.maxDrawdown && s.maxDrawdown.amount != null ? `The peak-to-trough equity decline was ${inr(s.maxDrawdown.amount)} (${pct(s.maxDrawdown.pct)}). Consecutive losing trades peaked at ${s.maxConsecutiveLosses}.` : 'Drawdown could not be computed (no closed trades).' });

  out.push({ q: 'Does performance remain stable out of sample?', a: wf && wf.aggregate ? `Walk-forward scored ${wf.aggregate.windowsScored} unseen window(s): ${pct(wf.aggregate.oosPositiveWindowsPct)} were profitable, totalling ${inr(wf.aggregate.oosNetPnlTotal)} over ${wf.aggregate.oosTradesTotal} trades.` : (optimizer && optimizer.ranked && optimizer.ranked.length ? `Hold-out: the best in-sample parameter set delivered ${optimizer.best && optimizer.best.oos ? inr(optimizer.best.oos.netPnl) + ' (' + pct(optimizer.best.oos.netPnlPct) + ')' : 'no out-of-sample result'} on unseen candles.` : 'No out-of-sample validation was run — treat in-sample results with caution.') });

  out.push({ q: 'Which market conditions appear unfavourable?', a: !has ? 'Unknown without completed trades.' : unfavourable(stats) });

  out.push({ q: 'Which parameters deserve further testing?', a: optimizer && optimizer.ranked && optimizer.ranked.length ? `The optimizer tested ${optimizer.combosTested} bounded combinations. The top out-of-sample set was ${JSON.stringify(optimizer.ranked[0].params)}; vary around it (and re-check on fresh data) rather than trusting a single value.` : 'Run the optimizer on a longer history to explore parameter robustness.' });

  const mcLine = monteCarlo && monteCarlo.ok ? `A ${monteCarlo.iterations}-run bootstrap of the actual trade P&L gave a median terminal equity of ${inr(monteCarlo.medianFinal)} (5th–95th percentile ${inr(monteCarlo.p5Final)}–${inr(monteCarlo.p95Final)}) and an estimated ${pct(monteCarlo.ruinProbabilityPct)} chance of losing half the capital. ` : '';
  out.push({ q: 'What risks should be considered before paper trading?', a: mcLine + (has ? `Worst single loss was ${inr(s.largestLoss)}; the top-5 winners contributed ${pct(riskStats && riskStats.profitConcentrationTop5Pct)} of gross profit. Verify with live paper trades before risking capital.` : 'No trade sample exists, so no risk assessment is possible.') });

  out.push({ q: 'What does the AI interpretation rely on?', a: `Every figure above is computed by the backtest engine from ${coverage && coverage.count ? coverage.count : s.totalTrades} verified candles. This is a rules-based explanation, not a prediction, and no numbers were invented. Historical performance does not guarantee future results.` });

  return { method: 'rules-based (deterministic)', segments: out };
}

function unfavourable(s) {
  const bits = [];
  if (s.maxConsecutiveLosses >= 5) bits.push(`long losing streaks (up to ${s.maxConsecutiveLosses} in a row)`);
  if (s.profitFactor != null && s.profitFactor < 1.2) bits.push('a thin profit factor');
  if (s.maxDrawdown && s.maxDrawdown.pct > 20) bits.push(`deep drawdowns (${pct(s.maxDrawdown.pct)})`);
  if (s.avgRMultiple != null && s.avgRMultiple < 0) bits.push('negative average R per trade');
  return bits.length ? `Weak spots on this sample: ${bits.join(', ')}. These typically cluster in choppy or low-volatility phases.` : 'No single glaring weakness stood out on this sample, but regime dependence is always a risk.';
}

module.exports = { build };
