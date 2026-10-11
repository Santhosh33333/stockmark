// Data-quality classification: turns raw provider metadata into an honest
// LIVE / DELAYED / STALE / CLOSED / DEMO / UNAVAILABLE label plus timestamps.
// We label rather than guess — if a source is not real-time we say so.
const { marketStatus } = require('./util');

const SOURCE_CLASS = {
  angelone: 'realtime',
  fyers: 'realtime',
  tapetide: 'realtime',
  dhan: 'realtime',
  nse: 'delayed',
  yahoo: 'delayed',
  demo: 'demo',
  test: 'demo',
};

const STALE_AFTER_MS = 26 * 60 * 60 * 1000; // older than ~1 trading day

function classify({ source, asOf, meta, market } = {}) {
  const mkt = market || marketStatus();
  const src = String(source || meta?.source || 'yahoo').toLowerCase();
  const kind = SOURCE_CLASS[src] || 'delayed';
  const t = Number(asOf) || Number(meta?.regularMarketTime ? meta.regularMarketTime * 1000 : 0) || null;
  const ageMs = t ? Date.now() - t : null;

  let status;
  if (kind === 'demo') status = 'DEMO';
  else if (mkt.state === 'OPEN') status = kind === 'realtime' ? 'LIVE' : 'DELAYED';
  else status = 'CLOSED';

  if (status === 'LIVE' && ageMs != null && ageMs > STALE_AFTER_MS) status = 'STALE';

  const note = {
    LIVE: 'Streaming from a real-time broker feed.',
    DELAYED: 'Free source may lag the exchange by up to ~15 minutes.',
    STALE: 'No fresh tick within the last trading day.',
    CLOSED: `Market ${mkt.state.toLowerCase()} — showing last traded price.`,
    DEMO: 'Explicitly labelled demonstration data (not a live feed).',
    UNAVAILABLE: 'No price available from the configured sources.',
  }[status];

  return {
    status,
    source: src,
    sourceClass: kind,
    marketState: mkt.state,
    exchangeTime: t ? new Date(t).toISOString() : null,
    asOf: t,
    ageSec: ageMs != null ? Math.round(ageMs / 1000) : null,
    note,
  };
}

module.exports = { classify, SOURCE_CLASS };
