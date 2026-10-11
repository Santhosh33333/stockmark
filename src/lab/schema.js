// ═══════════════════════════════════════════════════════════════════════════
//  Strategy specification schema (v1)
//  A typed, validated, versioned description of a trading strategy. The parser
//  produces this shape; the engine ONLY executes kinds/operators declared here.
//  Nothing outside this vocabulary is ever executed (no generated code).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const SPEC_VERSION = 1;

const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d', '1w'];
const HTF = ['15m', '30m', '1h', '4h', '1d', '1w'];
const DIRECTIONS = ['long', 'short', 'both'];
const UNIVERSE_TYPES = ['symbols', 'nifty50', 'fno', 'nse'];
const CONDITION_KINDS = [
  'rsi', 'ma_cross', 'price_vs_ma', 'wick_rejection', 'order_block', 'fvg',
  'bos', 'choch', 'liquidity_sweep', 'htf_trend', 'htf_rsi', 'candle_pattern', 'volume',
];
const STOP_KINDS = ['pct', 'atr', 'swing', 'ob'];
const TARGET_KINDS = ['rr', 'pct', 'atr', 'none'];
const SIZING_KINDS = ['risk_pct', 'fixed_notional', 'fixed_qty'];

// Which stop/target kinds are valid per direction (ob/swing need a structural side).
const CROSS_OPS = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };
const RSI_OPS = ['gt', 'gte', 'lt', 'lte'];

const DEFAULTS = {
  name: 'Untitled strategy',
  universe: { type: 'nifty50', symbols: [], direction: 'long' },
  timeframe: '1d',
  higherTimeframe: null,
  entry: [],
  filters: [],
  stopLoss: { kind: 'pct', pct: 3, atrMult: 2, atrPeriod: 14, bufferAtr: 0.25 },
  takeProfit: { kind: 'rr', rr: 2, pct: null, atrMult: 2 },
  trailing: { kind: 'none', atrMult: 2 },
  sizing: { kind: 'risk_pct', riskPct: 0.5, notional: 100000, qty: 1 },
  costs: { mode: 'DELIVERY', slippagePct: 0.05 },
  risk: { maxPositions: 1, maxRiskPerTradePct: 5, dailyLossLimitPct: 0, weeklyLossLimitPct: 0 },
  backtest: { years: 3, fromTs: null, toTs: null, capital: 100000 },
  notes: [],
};

function isNum(v) { return v != null && v !== '' && isFinite(Number(v)); }
const n = (v, d) => (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : d);
const clone = (o) => JSON.parse(JSON.stringify(o));

function emptySpec(name) {
  return clone({ ...DEFAULTS, name: name || DEFAULTS.name });
}

// Coerce arbitrary parsed input into a complete, in-range spec (fills defaults).
function normalize(spec = {}) {
  const s = {
    version: SPEC_VERSION,
    name: String(spec.name || DEFAULTS.name).slice(0, 120),
    universe: normalizeUniverse(spec.universe),
    timeframe: TIMEFRAMES.includes(spec.timeframe) ? spec.timeframe : '1d',
    higherTimeframe: HTF.includes(spec.higherTimeframe) ? spec.higherTimeframe : null,
    entry: normConditions(spec.entry),
    filters: (Array.isArray(spec.filters) ? spec.filters : []).map((c) => normalizeCondition(c)).filter(Boolean),
    stopLoss: normStop(spec.stopLoss),
    takeProfit: normTarget(spec.takeProfit),
    trailing: normTrailing(spec.trailing),
    sizing: normSizing(spec.sizing),
    costs: normalizeCosts(spec.costs),
    maxPositions: intOr(spec.maxPositions, 1, 1, 50),
    riskPct: numOr(spec.riskPct != null ? spec.riskPct : (spec.sizing ? spec.sizing.riskPct : undefined), 0.5, 0.01, 100),
    maxBars: intOr(spec.maxBars, 30, 1, 2000),
    dailyLossLimitPct: numOr(spec.dailyLossLimitPct, 0, 0, 100),
    weeklyLossLimitPct: numOr(spec.weeklyLossLimitPct, 0, 0, 100),
    fromTs: tsOr(spec.fromTs, null),
    toTs: tsOr(spec.toTs, null),
    capital: numOr(spec.capital, 100000, 1000, 1e9),
  };
  return s;
}

function numOr(v, d, lo, hi) { const n = Number(v); if (!isFinite(n)) return d; return Math.min(hi, Math.max(lo, n)); }
function intOr(v, d, lo, hi) { const n = Math.round(Number(v)); if (!isFinite(n)) return d; return Math.min(hi, Math.max(lo, n)); }
function tsOr(v, d) { const n = Number(v); return isFinite(n) && n > 0 ? n : d; }

function normalizeUniverse(u) {
  u = u || {};
  const type = UNIVERSE_TYPES.includes(u.type) ? u.type : 'nifty50';
  const symbols = Array.isArray(u.symbols)
    ? [...new Set(u.symbols.map((s) => String(s).toUpperCase().trim()).filter(Boolean))].slice(0, 250)
    : [];
  const direction = DIRECTIONS.includes(u.direction) ? u.direction : 'long';
  return { type, symbols, direction };
}

function conditionFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!CONDITION_KINDS.includes(raw.kind)) return null;
  return raw;
}

function normConditions(arr) {
  return (Array.isArray(arr) ? arr : []).map((c) => normalizeCondition(c)).filter(Boolean);
}

function normalizeCondition(c) {
  if (!c || !CONDITION_KINDS.includes(c.kind)) return null;
  switch (c.kind) {
    case 'rsi': return { kind: 'rsi', tf: HTF.includes(c.tf) ? c.tf : null, period: intOr(c.period, 14, 2, 100), op: RSI_OPS.includes(c.op) ? c.op : 'lt', value: numOr(c.value, 50, 0, 100) };
    case 'ma_cross': return { kind: 'ma_cross', type: c.type === 'sma' ? 'sma' : 'ema', fast: intOr(c.fast, 20, 2, 400), slow: intOr(c.slow, 50, 3, 500), dir: c.dir === 'bear' ? 'bear' : 'bull' };
    case 'price_vs_ma': return { kind: 'price_vs_ma', type: c.type === 'sma' ? 'sma' : 'ema', len: intOr(c.len, 50, 2, 500), side: c.side === 'below' ? 'below' : 'above' };
    case 'wick_rejection': return { kind: 'wick_rejection', dir: c.dir === 'bear' ? 'bear' : 'bull', wickMult: numOr(c.wickMult, 1.5, 0.1, 10), closePct: numOr(c.closePct, 0.7, 0.5, 1), volMult: numOr(c.volMult, 1, 0, 10), volPeriod: intOr(c.volPeriod, 20, 2, 200) };
    case 'order_block': return { kind: 'order_block', dir: c.dir === 'bear' ? 'bear' : 'bull', impAtrMult: numOr(c.impAtrMult, 2, 0.1, 20), atrPeriod: intOr(c.atrPeriod, 14, 2, 100), maxAge: intOr(c.maxAge, 50, 1, 500), requireUnmitigated: c.requireUnmitigated !== false };
    case 'fvg': return { kind: 'fvg', dir: c.dir === 'bear' ? 'bear' : 'bull', requireUnfilled: c.requireUnfilled !== false, maxAge: intOr(c.maxAge, 60, 1, 500) };
    case 'bos': return { kind: 'bos', dir: c.dir === 'bear' ? 'bear' : 'bull', swingLen: intOr(c.swingLen, 3, 1, 30), maxAgeBars: intOr(c.maxAgeBars, 50, 1, 500) };
    case 'choch': return { kind: 'choch', dir: c.dir === 'bear' ? 'bear' : 'bull', swingLen: intOr(c.swingLen, 3, 1, 30), maxAgeBars: intOr(c.maxAgeBars, 50, 1, 500) };
    case 'liquidity_sweep': return { kind: 'liquidity_sweep', side: c.side === 'buyside' ? 'buyside' : 'sellside', lookback: intOr(c.lookback, 20, 2, 300) };
    case 'htf_trend': return { kind: 'htf_trend', tf: HTF.includes(c.tf) ? c.tf : '4h', align: c.align === 'bear' ? 'bear' : 'bull', swingLen: intOr(c.swingLen, 3, 1, 30) };
    case 'htf_rsi': return { kind: 'htf_rsi', tf: HTF.includes(c.tf) ? c.tf : '4h', period: intOr(c.period, 14, 2, 100), op: RSI_OPS.includes(c.op) ? c.op : 'lt', value: numOr(c.value, 50, 0, 100) };
    case 'candle_pattern': return { kind: 'candle_pattern', dir: c.dir === 'bear' ? 'bear' : 'bull', pattern: String(c.pattern || 'engulfing') };
    case 'volume': return { kind: 'volume', mult: numOr(c.mult, 1.5, 0.1, 20), period: intOr(c.period, 20, 2, 200) };
    default: return null;
  }
}

function normalizeStop(s) {
  s = s || {};
  const kind = STOP_KINDS.includes(s.kind) ? s.kind : 'pct';
  return {
    kind,
    pct: numOr(s.pct, 2, 0.05, 50),
    atrMult: numOr(s.atrMult, 2, 0.1, 20),
    atrPeriod: intOr(s.atrPeriod, 14, 2, 100),
    swingLen: intOr(s.swingLen, 3, 1, 30),
    buffer: numOr(s.buffer, 0, 0, 5),
  };
}
function normalizeTarget(t) {
  t = t || {};
  const kind = TARGET_KINDS.includes(t.kind) ? t.kind : 'rr';
  return { kind, rr: numOr(t.rr, 2, 0.1, 50), pct: numOr(t.pct, 5, 0.1, 200), atrMult: numOr(t.atrMult, 3, 0.1, 50), atrPeriod: intOr(t.atrPeriod, 14, 2, 100) };
}

function normStop(s) { return normalizeStop(s); }
function normTarget(t) { return normalizeTarget(t); }
function normTrailing(t) {
  t = t || {};
  const kind = ['none', 'atr', 'pct'].includes(t.kind) ? t.kind : 'none';
  return { kind, atrMult: numOr(t.atrMult, 2, 0.1, 20), pct: numOr(t.pct, 3, 0.1, 50) };
}
function normSizing(s) {
  s = s || {};
  const kind = SIZING_KINDS.includes(s.kind) ? s.kind : 'risk_pct';
  return { kind, riskPct: numOr(s.riskPct, 0.5, 0.01, 25), notional: numOr(s.notional, 100000, 1000, 1e9), qty: intOr(s.qty, 1, 1, 100000) };
}
function normalizeCosts(c) {
  c = c || {};
  return { mode: c.mode === 'INTRADAY' ? 'INTRADAY' : 'DELIVERY', slippagePct: numOr(c.slippagePct, 0.05, 0, 5) };
}

function validate(spec) {
  const errors = [];
  const warnings = [];
  const s = normalize(spec);
  if (!s.name || !s.name.trim()) errors.push('Strategy name is required.');
  if (s.universe.type === 'symbols' && !s.universe.symbols.length) errors.push('Universe type "symbols" needs at least one symbol.');
  if (!TIMEFRAMES.includes(s.timeframe)) errors.push(`Unsupported execution timeframe "${spec.timeframe}".`);
  if (s.higherTimeframe && TIMEFRAMES.indexOf(s.higherTimeframe) <= TIMEFRAMES.indexOf(s.timeframe)) {
    errors.push(`Higher timeframe (${s.higherTimeframe}) must be larger than the execution timeframe (${s.timeframe}).`);
  }
  if (!s.entry.length) errors.push('Strategy needs at least one entry condition.');
  for (const c of s.entry.concat(s.filters)) {
    if (!c || !CONDITION_KINDS.includes(c.kind)) errors.push('Contains an unsupported condition.');
  }
  if (s.universe.direction === 'short' && s.stopLoss.kind === 'ob') {
    warnings.push('Short trades with an order-block stop are supported only when a bearish order block is present at entry.');
  }
  if (s.fromTs && s.toTs && s.fromTs >= s.toTs) errors.push('Backtest start date must be before the end date.');
  if (s.capital <= 0) errors.push('Initial capital must be greater than zero.');
  return { ok: errors.length === 0, errors, warnings, spec: s };
}

module.exports = {
  SPEC_VERSION, TIMEFRAMES, HTF, DIRECTIONS, UNIVERSE_TYPES, CONDITION_KINDS,
  STOP_KINDS, TARGET_KINDS, SIZING_KINDS, DEFAULTS,
  emptySpec, normalize, validate, normalizeCondition, normConditions, conditionFrom,
};
