// Parameter experiment: find which rule variants actually fire on daily data.
const yahoo = require('../src/providers/yahoo');
const strategy = require('../src/strategy');

const SYMS = ['RELIANCE', 'TCS', 'INFY', 'SBIN', 'ITC', 'LT', 'HDFCBANK', 'ICICIBANK', 'AXISBANK', 'TATAMOTORS', 'TATASTEEL', 'JSWSTEEL', 'MARUTI', 'SUNPHARMA', 'HINDALCO', 'NTPC'];

const CONFIGS = {
  'strict (as specified)': { useHtfRsi: false },
  'wick window 3 bars, 1.5x/60%/1.5ATR': { useHtfRsi: false, wickMult: 1.5, closePct: 0.6, sweepAtrMult: 1.5, mitigateOnDeepSweep: false, wickLookback: 3 },
  'wick window 5 bars, 1.5x/60%/1.5ATR': { useHtfRsi: false, wickMult: 1.5, closePct: 0.6, sweepAtrMult: 1.5, mitigateOnDeepSweep: false, wickLookback: 5 },
  'wick window 5, no vol filter': { useHtfRsi: false, wickMult: 1.5, closePct: 0.6, sweepAtrMult: 1.5, mitigateOnDeepSweep: false, wickLookback: 5, useWickVolume: false },
  'improved (drop sweep-wick)': { useHtfRsi: false, requireWickOnSweep: false, wickMult: 1.5, sweepAtrMult: 1.5, mitigateOnDeepSweep: false },
};

(async () => {
  console.log('Loading', SYMS.length, 'symbols x 10y daily...');
  const data = {};
  await yahoo.mapLimit(SYMS, 6, async (s) => {
    try { data[s] = (await yahoo.fetchChart(s + '.NS', { interval: '1d', range: '10y' })).candles; } catch { data[s] = null; }
  });

  for (const [name, opts] of Object.entries(CONFIGS)) {
    let trades = 0, wins = 0, losses = 0, net = 0, pf_num = 0, pf_den = 0, dd = 0, sig = 0, syms = 0;
    for (const s of SYMS) {
      if (!data[s]) continue;
      const a = strategy.analyze(data[s], [], { ...strategy.DEFAULTS, ...opts });
      if (!a.ok) continue;
      syms++;
      const st = a.stats;
      trades += st.trades; wins += st.wins; losses += st.losses; net += st.netProfitPct; dd = Math.max(dd, st.maxDrawdownPct);
      sig += a.signalCount;
      if (st.profitFactor >= 0 && st.profitFactor < 90) { /* n/a */ }
    }
    console.log(`\n▶ ${name}`);
    console.log(`   signals ${sig} · trades ${trades} · ${wins}W/${losses}L · win% ${trades ? (wins / trades * 100).toFixed(1) : 0} · net ${net.toFixed(1)}% · avg ${trades ? (net / trades).toFixed(2) : 0}% · worstDD ${dd.toFixed(1)}%`);
  }
})();
