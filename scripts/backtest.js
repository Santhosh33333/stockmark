// ═══════════════════════════════════════════════════════════════════════
//  Backtest runner — runs the SMC strategy engine over LONG daily history
//  and reports the same metrics TradingView's Strategy Tester shows:
//  Net Profit, Win Rate, Profit Factor, Max Drawdown, trades, avg trade.
//
//  Usage:
//    node scripts/backtest.js                                   # NIFTY 50 · strict preset (≈0 trades)
//    node scripts/backtest.js --preset=improved                 # relaxed engine preset
//    node scripts/backtest.js --universe=fno --preset=improved  # 213 F&O names
//    node scripts/backtest.js --no-htf --range=10y              # full daily window, no 4H RSI filter
//    node scripts/backtest.js --symbols=RELIANCE,TCS,INFY
//    node scripts/backtest.js --limit=80                        # 80 largest F&O names
//
//  Notes:
//   • Yahoo symbol drift is handled: TATAMOTORS → TMCV/TMPV (2025 demerger),
//     LTIM → LTM (2026 rename). The live universe (data/universe.json) is already current.
//
//  Notes:
//   • Daily candles come from Yahoo Finance using --range (default 10y).
//   • The 4H RSI filter needs hourly candles; Yahoo caps 1H history at 730d
//     so strict-rule signals only start once hourly data exists (~2y). Run
//     with --no-htf to exercise the core setup across the whole daily window.
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const yahoo = require('../src/providers/yahoo');
const strategy = require('../src/strategy');

const NIFTY50 = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'HINDUNILVR', 'ITC', 'SBIN',
  'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI', 'BAJFINANCE',
  'HCLTECH', 'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'WIPRO', 'NESTLEIND', 'ONGC',
  'NTPC', 'POWERGRID', 'M&M', 'TMCV', 'TMPV', 'TATASTEEL', 'JSWSTEEL', 'ADANIENT',
  'ADANIPORTS', 'COALINDIA', 'BAJAJFINSV', 'GRASIM', 'HINDALCO', 'TECHM', 'INDUSINDBK',
  'DRREDDY', 'CIPLA', 'BRITANNIA', 'EICHERMOT', 'BPCL', 'DIVISLAB', 'APOLLOHOSP',
  'HEROMOTOCO', 'BAJAJ-AUTO', 'SBILIFE', 'HDFCLIFE', 'TATACONSUM', 'LTM', 'SHRIRAMFIN',
];

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
function flag(name) { return process.argv.includes(`--${name}`); }

// Presets come from the strategy engine (DEFAULTS = improved, PRESETS.strict = original spec).
const PRESETS = strategy.PRESETS;

async function run() {
  const range = arg('range', '10y');
  const hourlyRange = arg('hourly', '730d');
  const limit = Number(arg('limit', '0'));
  const noHtf = flag('no-htf');
  const concurrency = Number(arg('concurrency', '6'));
  const outFile = arg('out', path.join(__dirname, '..', 'data', 'backtest-results.json'));

  let symbols = arg('symbols', '')
    ? arg('symbols', '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : NIFTY50.slice();
  const universe = arg('universe', '');
  if (universe) {
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'universe.json'), 'utf8'));
      if (universe === 'fno') symbols = cache.nse.filter((r) => r.fno).map((r) => r.symbol);
      else if (universe === 'nse') symbols = cache.nse.map((r) => r.symbol);
      else if (universe === 'nifty50') symbols = NIFTY50.slice();
      console.log(`Universe "${universe}" → ${symbols.length} symbols`);
    } catch (e) { console.log('Could not read universe.json:', e.message); }
  }
  if (limit > 0) symbols = symbols.slice(0, limit);

  const preset = arg('preset', 'strict');
  const opts = { ...strategy.DEFAULTS, ...(PRESETS[preset] || {}) };
  if (noHtf) { opts.useHtfRsi = false; }
  if (preset === 'strict' && !noHtf) {
    console.log('NOTE: strict rules rarely trigger on daily large-caps — expect 0 trades.');
  }

  // Backtest realism flags.
  const useCosts = flag('costs') || arg('costs', '') === '1';
  const train = Number(arg('train', '0')) || 0;
  const costMode = (arg('mode', 'delivery') || 'delivery').toUpperCase();
  const csvFile = flag('csv') ? arg('csv', path.join(__dirname, '..', 'data', 'backtest-trades.csv')) : (arg('csv', '') || '');
  if (useCosts) opts.useCosts = true;
  if (costMode === 'INTRADAY') opts.costs = { ...(opts.costs || {}), mode: 'INTRADAY' };
  if (train > 0) opts.trainSplit = train;
  const costNote = useCosts ? ` · COSTS ON (${costMode.toLowerCase()})` : ' · costs OFF';
  const trainNote = train > 0 ? ` · train ${Math.round(train * 100)}% / test ${Math.round((1 - train) * 100)}%` : '';

  console.log(`\nTradeMind backtest — ${symbols.length} symbols · preset ${preset} · daily range ${range}` +
    ` · 4H RSI filter ${noHtf ? 'OFF' : 'ON'} · SL ${opts.slPct}% / TP ${opts.tpPct}% / ${opts.maxBars} bars` +
    `${costNote}${trainNote}\n`);

  const rows = [];
  const allTrades = [];
  const t0 = Date.now();

  const results = await yahoo.mapLimit(symbols, concurrency, async (sym) => {
    const ySym = sym.includes('.') || sym.startsWith('^') ? sym : `${sym}.NS`;
    try {
      const [daily, hourly] = await Promise.all([
        yahoo.fetchChart(ySym, { interval: '1d', range }),
        noHtf ? Promise.resolve({ candles: [] })
          : yahoo.fetchChart(ySym, { interval: '1h', range: hourlyRange }).catch(() => ({ candles: [] })),
      ]);
      const a = strategy.analyze(daily.candles, hourly.candles, opts);
      if (!a.ok) return { symbol: sym, error: a.reason, bars: daily.candles.length };
      return { symbol: sym, bars: daily.candles.length, from: daily.candles[0]?.t, to: daily.candles.at(-1)?.t, stats: a.stats, price: a.price, signals: a.signalCount, trades: a.trades };
    } catch (e) {
      return { symbol: sym, error: e.message };
    }
  });

  for (const r of results) {
    if (r.status === 'rejected') continue;
    rows.push(r.value);
  }

  // ── aggregate ──
  let totTrades = 0, totWins = 0, totLosses = 0, grossProfit = 0, grossLoss = 0, netPct = 0;
  let worstDd = 0;
  const withTrades = [];
  for (const r of rows) {
    if (!r.stats) continue;
    const s = r.stats;
    totTrades += s.trades; totWins += s.wins; totLosses += s.losses;
    grossProfit += s.grossProfitPct || 0;
    grossLoss += s.grossLossPct || 0;
    netPct += s.netProfitPct;
    worstDd = Math.max(worstDd, s.maxDrawdownPct);
    if (s.trades > 0) withTrades.push(r);
  }
  const winRate = totTrades ? (totWins / totTrades * 100) : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : 0);
  const avgTrade = totTrades ? netPct / totTrades : 0;

  // ── train/test split aggregate (chronological, no look-ahead) ──
  function aggSplit(key) {
    let t = 0, w = 0, l = 0, gp = 0, gl = 0, net = 0;
    for (const r of rows) {
      const s = r.stats && r.stats[key]; if (!s) continue;
      t += s.trades; w += s.wins; l += s.losses;
      gp += s.grossProfitPct || 0; gl += s.grossLossPct || 0; net += s.netProfitPct || 0;
    }
    return { trades: t, wins: w, losses: l, winRate: t ? +(w / t * 100).toFixed(1) : 0, profitFactor: gl > 0 ? +(gp / gl).toFixed(2) : (gp > 0 ? 99 : 0), netPct: +net.toFixed(2) };
  }
  const splitAgg = opts.trainSplit > 0 ? { inSample: aggSplit('inSample'), outOfSample: aggSplit('outOfSample') } : null;

  // ── report ──
  rows.sort((a, b) => (b.stats?.netProfitPct || -999) - (a.stats?.netProfitPct || -999));
  console.log('SYMBOL        BARS   TRADES  WIN%   NET%    PF    MAXDD%   AVG%');
  console.log('─'.repeat(70));
  for (const r of rows) {
    if (r.error) { console.log(`${r.symbol.padEnd(13)} ${String(r.bars || '').padEnd(6)}  — ${r.error}`); continue; }
    const s = r.stats;
    console.log(
      `${r.symbol.padEnd(13)} ${String(r.bars).padEnd(6)} ${String(s.trades).padEnd(6)} ` +
      `${String(s.winRate).padEnd(6)} ${String(s.netProfitPct).padEnd(7)} ${String(s.profitFactor).padEnd(5)} ` +
      `${String(s.maxDrawdownPct).padEnd(8)} ${s.avgTradePct}`
    );
  }

  console.log('─'.repeat(70));
  console.log(`\nSYMBOLS TESTED   : ${rows.filter((r) => r.stats).length}`);
  console.log(`TOTAL TRADES     : ${totTrades}`);
  console.log(`WIN RATE         : ${winRate.toFixed(1)}%  (${totWins}W / ${totLosses}L)`);
  console.log(`PROFIT FACTOR    : ${profitFactor.toFixed(2)}`);
  console.log(`NET P&L (sum)    : ${netPct.toFixed(2)}%  (equal-size trades, 1 unit each)`);
  console.log(`AVG TRADE        : ${avgTrade.toFixed(2)}%`);
  console.log(`WORST SYMBOL DD  : ${worstDd.toFixed(2)}%`);
  console.log(`SYMBOLS W/ TRADES: ${withTrades.length}/${rows.filter((r) => r.stats).length}`);
  const totalCost = rows.reduce((a, r) => a + (r.stats?.totalCostsPct || 0), 0);
  if (opts.useCosts) console.log(`TOTAL COSTS      : ${totalCost.toFixed(1)}% (brokerage+STT+GST+stamp+slippage, summed)`);
  if (splitAgg) {
    const f = (a, label) => `  ${label.padEnd(12)} trades ${String(a.trades).padEnd(5)} win% ${String(a.winRate).padEnd(6)} PF ${String(a.profitFactor).padEnd(5)} net% ${a.netPct}`;
    console.log('\nTRAIN / TEST SPLIT (chronological):');
    console.log(f(splitAgg.inSample, 'IN-SAMPLE'));
    console.log(f(splitAgg.outOfSample, 'OUT-OF-SAMPLE'));
  }
  console.log(`ELAPSED          : ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // ── optional trades CSV export ──
  if (csvFile) {
    const iso = (ts) => (ts ? new Date(ts).toISOString() : '');
    const header = 'symbol,entry_ts,exit_ts,entry,exit,sl,tp,reason,pct,grossPct,costPct,bars';
    const lines = [header];
    for (const r of rows) {
      for (const t of (r.trades || [])) {
        lines.push([r.symbol, iso(t.entryTs), iso(t.exitTs), t.entry, t.exit, t.sl, t.tp, `"${t.reason}"`, t.pct, t.grossPct, t.costPct, t.bars].join(','));
      }
    }
    try {
      fs.mkdirSync(path.dirname(csvFile), { recursive: true });
      fs.writeFileSync(csvFile, lines.join('\n'));
      console.log(`Trades CSV       : ${csvFile}  (${lines.length - 1} rows)\n`);
    } catch (e) { console.log('Could not write CSV:', e.message); }
  }

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({
      generatedAt: new Date().toISOString(),
      range, preset, noHtf, opts,
      aggregate: { symbols: rows.filter((r) => r.stats).length, trades: totTrades, wins: totWins, losses: totLosses, winRate: +winRate.toFixed(1), profitFactor: +profitFactor.toFixed(2), grossProfit: +grossProfit.toFixed(2), grossLoss: +grossLoss.toFixed(2), netPct: +netPct.toFixed(2), avgTrade: +avgTrade.toFixed(2), worstSymbolDd: +worstDd.toFixed(2) },
      costs: { applied: !!opts.useCosts, mode: costMode, totalCostsPct: +totalCost.toFixed(2), model: opts.useCosts ? require('../src/costs').merge(opts.costs) : null },
      split: splitAgg,
      rows,
    }, null, 2));
    console.log(`Saved → ${outFile}\n`);
  } catch (e) { console.log('Could not save results file:', e.message); }
}

run().catch((e) => { console.error('Backtest failed:', e); process.exit(1); });
