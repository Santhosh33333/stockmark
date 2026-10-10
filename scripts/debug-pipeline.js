const yahoo = require('../src/providers/yahoo');
const strategy = require('../src/strategy');
const { sma, atr } = require('../src/indicators');

(async () => {
  for (const sym of ['RELIANCE', 'TATAMOTORS', 'SBIN', 'JSWSTEEL']) {
    const d = await yahoo.fetchChart(sym + '.NS', { interval: '1d', range: '10y' });
    const a = strategy.analyze(d.candles, [], { ...strategy.DEFAULTS, useHtfRsi: false, requireWickOnSweep: false });
    console.log(sym, 'bars', a.bars, '| wickCount', a.wickCount, '| zones(recent shown)', a.zones.length, '| signals', a.signalCount, '| inducements', a.inducements.length, '| activeZones', a.activeZones.length);
  }
})();
