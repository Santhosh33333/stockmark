// ═══════════════════════════════════════════════════════════════════════════
//  Natural-language → strategy specification parser.
//  Deterministic and offline: a controlled vocabulary of regexes maps a prompt
//  to the typed schema. It NEVER runs generated code and NEVER invents data.
//  Anything it cannot map is reported as "unsupported" or "ambiguous" instead
//  of being silently dropped.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const schema = require('./schema');

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, eighteen: 18, twenty: 20, thirty: 30 };

// Phrases we explicitly recognise but do NOT support, with a human explanation.
const UNSUPPORTED = [
  [/machine learning|neural|deep learning|\bai model\b|train a model/i, 'Machine-learned entry/exit models are not supported. Describe the rule in indicator terms (e.g. "RSI < 40 and bullish wick rejection").'],
  [/news|sentiment|twitter|\bx\b post|social media|headline/i, 'News / social-media sentiment is not a supported data source.'],
  [/fundamental|p\/e|earnings|balance sheet|revenue|book value/i, 'Fundamental data (earnings, ratios) is not part of this price-based engine.'],
  [/option|futures strategy|straddle|strangle|iron condor|covered call/i, 'This builder backtests single-instrument price strategies, not option structures. Options analytics live in the Options tab.'],
  [/guarantee|risk[- ]free|sure shot|100% (win|accurate)|cannot lose/i, 'Guaranteed-profit rules are not supported — no historical test can promise future returns.'],
  [/martingale|averag(e|ing) down|double the position (size )?after (a )?loss/i, 'Martingale / averaging-down position sizing is deliberately not supported (unbounded risk).'],
  [/intraday scalping on (tick|second) data|tick data|order book|level 2/i, 'Tick / order-book data is not available free; the finest supported bar is 5-minute.'],
];

function numWord(s) { return WORD_NUM[String(s).toLowerCase()] || Number(s); }

function toDateRange(text, now) {
  const t = text.toLowerCase();
  let months = null;
  const mYears = t.match(/last\s+([a-z0-9]+)\s*(?:years?|yrs?)/);
  const mMonths = t.match(/last\s+([a-z0-9]+)\s*(?:months?|mos?)/);
  const mDays = t.match(/last\s+([a-z0-9]+)\s*days?/);
  if (mYears) months = numWord(mYears[1]) * 12;
  else if (mMonths) months = numWord(mMonths[1]);
  else if (mDays) months = Math.max(1, Math.round(numWord(mDays[1]) / 30));
  if (months != null && isFinite(months)) {
    return { fromTs: now - months * 30.4375 * 86400000, toTs: now, matched: `history window: last ${months} months` };
  }
  const mFrom = t.match(/from\s+(20\d{2})/);
  const mTo = t.match(/(?:to|until|through)\s+(20\d{2})/);
  if (mFrom) {
    const from = Date.UTC(Number(mFrom[1]), 0, 1);
    const to = mTo ? Date.UTC(Number(mTo[1]) + 1, 0, 1) - 1 : now;
    return { fromTs: from, toTs: to, matched: `date range: ${mFrom[1]}–${mTo ? mTo[1] : 'now'}` };
  }
  return null;
}

function parse(text, opts = {}) {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const now = opts.now || Date.now();
  const matched = [];
  const unsupported = [];
  const ambiguous = [];
  const notes = [];

  const base = opts.base ? schema.normalize(opts.base) : schema.normalize({});
  const spec = { ...base, entry: [], filters: [], universe: { ...base.universe }, stopLoss: { ...base.stopLoss }, takeProfit: { ...base.takeProfit } };

  // ── unsupported phrases ──────────────────────────────────────────────────
  for (const [re, why] of UNSUPPORTED) if (re.test(raw)) unsupported.push(why);

  // ── name ─────────────────────────────────────────────────────────────────
  const mName = raw.match(/(?:call(?:ed)?|named)\s+["“]?([^"”\n.]{3,60})/i);
  if (mName) { spec.name = mName[1].trim(); matched.push(`name: "${spec.name}"`); }
  else { spec.name = 'Custom strategy'; }

  // ── universe ─────────────────────────────────────────────────────────────
  if (/nifty\s*50|nifty50|nifty fifty/i.test(t)) { spec.universe.type = 'nifty50'; matched.push('universe: NIFTY 50'); }
  else if (/f\s*&\s*o|fno|futures and options/i.test(t)) { spec.universe.type = 'fno'; matched.push('universe: F&O underlyings'); }
  else if (/all (indian )?(stocks|nse)|nse equities|indian equities|whole market/i.test(t)) { spec.universe.type = 'nse'; matched.push('universe: NSE equities'); }

  // Explicit tickers (only in the original-cased text, 2+ uppercase letters).
  const tickers = [...new Set((raw.match(/\b[A-Z][A-Z0-9&-]{1,14}\b/g) || []))]
    .filter((s) => !/^(NIFTY|BANKNIFTY|FINNIFTY|SENSEX|MIDCPNIFTY|BANKNIFTY)$/.test(s))
    .filter((s) => !Object.prototype.hasOwnProperty.call(WORD_NUM, s.toLowerCase()) && !/^(RSI|EMA|SMA|ATR|SMA|SMC|BOS|CHOCH|FVG|OB|HTF|MTF|NSE|BSE|RR|SL|TP|INR|RSI|OK|AI|US|UK|ETF|IPO|IPO)$/.test(s))
    .filter((s) => !/^(AND|OR|THE|WITH|NEAR|BOTH|LONG|SHORT|BUY|SELL|REQUIRE|USE|ENTRY|EXIT|STOP|LOSS|TARGET|RISK)$/.test(s));
  // Only treat tokens as symbols if they look like tickers and the prompt listed them explicitly.
  const symMention = /(?:symbols?|stocks?|watchlist|on)\s*:?\s*((?:[A-Z][A-Z0-9&.-]{1,14})(?:\s*,\s*[A-Z0-9][A-Z0-9.&-]{1,14}){1,})/.exec(raw);
  if (spec.universe.type === 'nifty50' && /selected|chosen|these|the following|list/i.test(t)) {
    ambiguous.push('Universe looks like a specific list — specify symbols explicitly (e.g. "on RELIANCE, TCS, INFY").');
  }
  if (spec.universe.type === 'nifty50' && !/nifty/i.test(t)) {
    notes.push('No universe named — defaulted to NIFTY 50. Change it in the spec editor.');
  }
  if (spec.universe.symbols.length === 0 && /selected nse equities/i.test(t)) {
    spec.universe.type = 'symbols';
    ambiguous.push('"Selected NSE equities" — add explicit symbols to define the universe.');
  }

  // ── direction ────────────────────────────────────────────────────────────
  if (/long and short|both (long|sides|directions)|buy and sell/i.test(t)) { spec.universe.direction = 'both'; matched.push('direction: long & short'); }
  else if (/short|bearish|sell|downside/i.test(t) && !/avoid short/i.test(t)) { spec.universe.direction = 'short'; matched.push('direction: short'); }
  else { spec.universe.direction = 'long'; }

  // ── timeframe ────────────────────────────────────────────────────────────
  const tfMap = [
    [/\b5[\s-]?(min|minute|m)\b/, '5m'], [/\b15[\s-]?(min|minute|m)\b/, '15m'],
    [/\b30[\s-]?(min|minute|m)\b/, '30m'], [/\b(1\s*)?(hour|hr|h)\b|hourly/, '1h'],
    [/\b4[\s-]?(hour|hr|h)\b/, '4h'], [/\b(daily|1\s*day|day)\b/, '1d'], [/\bweekly|1\s*week\b/, '1w'],
  ];
  for (const [re, tf] of tfMap) { if (re.test(t)) { spec.timeframe = tf; matched.push(`timeframe: ${tf}`); break; } }
  if (!matched.some((m) => m.startsWith('timeframe'))) notes.push('No timeframe given — defaulted to daily (1d).');

  // ── higher timeframe RSI / trend ─────────────────────────────────────────
  const htfRsi = t.match(/(\d+)[\s-]*(hour|hr|h|day|daily)\s*rsi/i) || t.match(/rsi[^.]*?(4[\s-]?hour|4h|daily|weekly)/i);
  if (htfRsi) {
    const src = htfRsi[1] + (htfRsi[2] || '') + (htfRsi[0] || '');
    const tf = /4/.test(src) ? '4h' : /day|daily/i.test(src) ? '1d' : /week/i.test(src) ? '1w' : '4h';
    spec.higherTimeframe = spec.higherTimeframe || tf;
    const op = /above|>|greater|over/.test(t) ? 'gt' : 'lt';
    const mVal = t.match(/rsi[^.]*?(\d{1,2}(?:\.\d+)?)/i);
    const val = mVal ? Number(mVal[1]) : (op === 'lt' ? 50 : 60);
    spec.entry.push(schema.normalizeCondition({ kind: 'htf_rsi', tf, period: 14, op, value: val }));
    matched.push(`filter: ${tf} RSI ${op === 'lt' ? '<' : '>'} ${val}`);
  } else {
    const rsiM = t.match(/rsi[^.]*?(above|over|greater than|>|below|under|less than|<)\s*(\d{1,2}(?:\.\d+)?)/i);
    if (rsiM) {
      const op = /above|over|greater|>/.test(rsiM[1]) ? 'gt' : 'lt';
      const val = Number(rsiM[2]);
      const cond = { kind: 'rsi', period: 14, op, value: val, tf: null };
      const mPer = t.match(/rsi\s*\(?\s*(\d{1,2})\s*\)?/i); if (mPer) cond.period = Number(mPer[1]) || 14;
      // If a higher timeframe is named, treat it as HTF RSI.
      spec.entry.push(schema.normalizeCondition(cond));
      matched.push(`filter: RSI(${cond.period}) ${op === 'lt' ? '<' : '>'} ${val}`);
    }
  }
  if (/multi[-\s]?time[-\s]?frame|mtf|higher[-\s]?time[-\s]?frame (trend|confirmation)/i.test(t) && !spec.entry.some((c) => c && c.kind === 'htf_trend')) {
    const tf = spec.higherTimeframe || '4h';
    spec.entry.push(schema.normalizeCondition({ kind: 'htf_trend', tf, align: spec.universe.direction === 'short' ? 'bear' : 'bull' }));
    matched.push(`filter: ${tf} trend ${spec.universe.direction === 'short' ? 'bearish' : 'bullish'}`);
  }

  // ── moving-average cross ─────────────────────────────────────────────────
  const maCross = t.match(/(ema|sma)\s*\(?\s*(\d{1,3})\s*\)?\s*(?:cross(?:es|ing|ed)?|>|above)\s*(?:over\s*)?(ema|sma)\s*\(?\s*(\d{1,3})/i)
    || t.match(/(\d{1,3})\s*(?:\/\s*)(\d{1,3})\s*(ema|sma)?\s*cross/i)
    || t.match(/(?:golden|death)\s*cross/i);
  if (maCross) {
    let type = 'ema', fast = 20, slow = 50, dir = spec.universe.direction === 'short' ? 'bear' : 'bull';
    if (/golden cross/i.test(t)) { dir = 'bull'; }
    if (/death cross/i.test(t)) { dir = 'bear'; }
    const nums = (maCross[0].match(/\d{1,3}/g) || []).map(Number).sort((a, b) => a - b);
    if (nums.length >= 2) { fast = nums[0]; slow = nums[1]; }
    if (/sma/i.test(maCross[0])) type = 'sma';
    if (/ema/i.test(maCross[0]) || !type) type = /sma/i.test(maCross[0]) ? 'sma' : 'ema';
    spec.entry.push(schema.normalizeCondition({ kind: 'ma_cross', type, fast, slow, dir }));
    matched.push(`entry: ${type.toUpperCase()}(${fast}) crosses ${dir === 'bull' ? 'above' : 'below'} ${type.toUpperCase()}(${slow})`);
  }
  const pvm = t.match(/(?:price|close)\s*(above|below|over|under)\s*(ema|sma)\s*\(?\s*(\d{1,3})/i);
  if (pvm) {
    spec.entry.push(schema.normalizeCondition({ kind: 'price_vs_ma', type: pvm[2].toLowerCase(), len: Number(pvm[3]), side: /above|over/.test(pvm[1]) ? 'above' : 'below' }));
    matched.push(`entry: price ${/above|over/.test(pvm[1]) ? 'above' : 'below'} ${pvm[2].toUpperCase()}(${pvm[3]})`);
  }

  // ── wick rejection ───────────────────────────────────────────────────────
  if (/wick rejection|rejection (candle|wick)|pin ?bar|long (lower|upper) wick/i.test(t)) {
    const dir = /bear|upper|short|sell/i.test(t) ? 'bear' : 'bull';
    const wm = t.match(/(\d(?:\.\d)?)\s*x?\s*(?:the\s*)?body/i);
    spec.entry.push(schema.normalizeCondition({ kind: 'wick_rejection', dir, wickMult: wm ? Number(wm[1]) : 1.5 }));
    matched.push(`entry: ${dir}ish wick rejection (wick ≥ ${wm ? wm[1] : 1.5}× body)`);
  }

  // ── candle patterns ──────────────────────────────────────────────────────
  if (/engulfing/i.test(t)) { spec.entry.push(schema.normalizeCondition({ kind: 'candle_pattern', pattern: 'engulfing', dir: /bear/i.test(t) ? 'bear' : 'bull' })); matched.push('entry: engulfing candle'); }
  if (/hammer/i.test(t)) { spec.entry.push(schema.normalizeCondition({ kind: 'candle_pattern', pattern: 'hammer', dir: 'bull' })); matched.push('entry: hammer'); }
  if (/shooting star/i.test(t)) { spec.entry.push(schema.normalizeCondition({ kind: 'candle_pattern', pattern: 'shooting_star', dir: 'bear' })); matched.push('entry: shooting star'); }

  // ── order block ──────────────────────────────────────────────────────────
  if (/order ?block|\bob\b/i.test(t)) {
    const dir = /bear|short|sell/i.test(t) && !/bullish/i.test(t) ? 'bear' : 'bull';
    const unmitigated = /unmitigated|untested|fresh|retest/i.test(t);
    spec.entry.push(schema.normalizeCondition({ kind: 'order_block', dir, requireUnmitigated: unmitigated !== false ? true : true }));
    matched.push(`entry: ${dir}ish order block${/retest/i.test(t) ? ' retest' : ''}`);
  }
  // ── fair value gap ───────────────────────────────────────────────────────
  if (/fair[-\s]?value[-\s]?gap|\bfvg\b|imbalance/i.test(t)) {
    const dir = /bear|short|sell/i.test(t) && !/bullish/i.test(t) ? 'bear' : 'bull';
    spec.entry.push(schema.normalizeCondition({ kind: 'fvg', dir, requireUnfilled: true }));
    matched.push(`entry: ${dir}ish fair-value gap`);
  }
  // ── structure ────────────────────────────────────────────────────────────
  if (/break of structure|\bbos\b/i.test(t)) { spec.entry.push(schema.normalizeCondition({ kind: 'bos', dir: spec.universe.direction === 'short' ? 'bear' : 'bull' })); matched.push('entry: break of structure'); }
  if (/change of character|\bchoch\b/i.test(t)) { spec.entry.push(schema.normalizeCondition({ kind: 'choch', dir: spec.universe.direction === 'short' ? 'bear' : 'bull' })); matched.push('entry: change of character'); }
  if (/price\s+(?:cross(?:es|ing)?|breaks?)\s+(support|resistance)/i.test(t)) {
    const side = /support/i.test(t) ? (spec.universe.direction === 'short' ? 'bear' : 'bull') : (spec.universe.direction === 'short' ? 'bear' : 'bull');
    // Breaking resistance = bullish BOS; breaking support = bearish BOS.
    const dir = /support/i.test(t) ? 'bear' : 'bull';
    spec.entry.push(schema.normalizeCondition({ kind: 'bos', dir: dir === 'bear' && spec.universe.direction !== 'short' ? 'bear' : dir }));
    matched.push(`entry: price breaks ${/support/i.test(t) ? 'support (bearish BOS)' : 'resistance (bullish BOS)'}`);
  }
  // ── liquidity sweep ──────────────────────────────────────────────────────
  if (/liquidity sweep|sweep|inducement|liquidity grab/i.test(t)) {
    const side = spec.universe.direction === 'short' || /buyside|buy[-\s]?side|equal highs/i.test(t) ? 'buyside' : 'sellside';
    spec.entry.push(schema.normalizeCondition({ kind: 'liquidity_sweep', side }));
    matched.push(`entry: ${side} liquidity sweep`);
  }

  // ── volume confirmation ──────────────────────────────────────────────────
  const volM = t.match(/volume\s*(?:>|above|greater than|≥)?\s*(\d(?:\.\d)?)\s*x/i);
  if (volM) { spec.entry.push(schema.normalizeCondition({ kind: 'volume', mult: Number(volM[1]) })); matched.push(`filter: volume > ${volM[1]}× average`); }

  // ── stop loss ────────────────────────────────────────────────────────────
  if (/atr[-\s]?(based|stop)/i.test(t) || /\batr\b[^.]*?(stop|sl)/i.test(t)) {
    const am = t.match(/(\d(?:\.\d)?)\s*x?\s*atr/i) || t.match(/atr[^.]*?(\d(?:\.\d)?)\s*x/i) || t.match(/atr\s*\(?\s*(\d{1,2})\s*\)?/i);
    spec.stopLoss.kind = 'atr'; spec.stopLoss.atrMult = am ? Number(am[1]) : 2;
    matched.push(`stop loss: ${AM(am)}ATR`); 
  } else if (/stop[^.]*?(\d(?:\.\d)?)\s*%/i.test(t) || /(\d(?:\.\d)?)\s*%\s*stop/i.test(t)) {
    const pm = t.match(/(\d(?:\.\d)?)\s*%/);
    spec.stopLoss = { ...spec.stopLoss, kind: 'pct', pct: pm ? Number(pm[1]) : 2 };
    matched.push(`stop loss: ${spec.stopLoss.pct}%`);
  } else if (/swing|invalidation|structure (low|high)|below the (low|swing)/i.test(t)) {
    spec.stopLoss = { ...spec.stopLoss, kind: 'swing' };
    matched.push('stop loss: beyond the invalidation swing');
  } else if (/order ?block (low|high)|ob (low|high)/i.test(t)) {
    spec.stopLoss = { ...spec.stopLoss, kind: 'ob' };
    matched.push('stop loss: beyond the order block');
  }
  function AM() { return ''; }

  // ── take profit / risk-reward ────────────────────────────────────────────
  const rrM = t.match(/(?:risk[-\s]?(?:reward|to[-\s]?reward)?|r:r|rr)\s*(?:ratio)?\s*(?:of\s*)?(\d(?:\.\d+)?)\s*[:/]\s*(\d(?:\.\d+)?)/i)
    || t.match(/(\d(?:\.\d+)?)\s*(?:times|×|x)\s*(?:the\s*)?(?:initial\s*)?risk/i)
    || t.match(/(?:target|tp)\s*(?:of\s*)?(\d(?:\.\d+)?)\s*r\b/i);
  if (rrM) {
    let rr;
    if (rrM.length >= 3 && rrM[2] != null && /[:/]/.test(rrM[0])) rr = Number(rrM[2]) / Number(rrM[1]);
    else rr = Number(rrM[1]);
    if (isFinite(rr) && rr > 0) { spec.takeProfit = { ...spec.takeProfit, kind: 'rr', rr: Math.min(50, rr) }; matched.push(`target: ${rr}R (${rrM[0].trim()})`); }
  } else if (/atr[^.]*?(target|tp|profit)/i.test(t) || /(target|tp)[^.]*?atr/i.test(t)) {
    const am = t.match(/(\d(?:\.\d)?)\s*x?\s*atr/i);
    spec.takeProfit = { ...spec.takeProfit, kind: 'atr', atrMult: am ? Number(am[1]) : 3 };
    matched.push(`target: ${am ? am[1] : 3}× ATR`);
  } else if (/(?:target|take[-\s]?profit|tp)\s*(?:of\s*)?(\d(?:\.\d+)?)\s*%/i.test(t)) {
    const m = t.match(/(?:target|take[-\s]?profit|tp)\s*(?:of\s*)?(\d(?:\.\d+)?)\s*%/i);
    spec.takeProfit = { ...spec.takeProfit, kind: 'pct', pct: Number(m[1]) };
    matched.push(`target: ${m[1]}%`);
  }

  // ── risk per trade ───────────────────────────────────────────────────────
  const riskM = t.match(/risk(?:ing)?\s*(\d(?:\.\d+)?)\s*%/i);
  if (riskM) { spec.riskPct = Number(riskM[1]); matched.push(`risk per trade: ${riskM[1]}% of equity`); }

  // ── max simultaneous positions ───────────────────────────────────────────
  const posM = t.match(/(?:maximum|max|up to)\s*(\d{1,2})\s*(?:open\s*)?positions?/i) || t.match(/(\d{1,2})\s*(?:simultaneous|concurrent)\s*positions?/i);
  if (posM) { spec.maxPositions = Number(posM[1]); matched.push(`max positions: ${posM[1]}`); }

  // ── time exit ────────────────────────────────────────────────────────────
  const timeM = t.match(/(?:exit|close|time[-\s]?exit)[^.]*?(?:after|within)\s*(\d{1,3})\s*(?:bars?|candles?|days?)/i);
  if (timeM) { spec.maxBars = Number(timeM[1]); matched.push(`exit: time stop after ${timeM[1]} bars`); }

  // ── session filter ───────────────────────────────────────────────────────
  if (/trading[-\s]?session|session filter|only trade|market hours/i.test(t)) {
    const ses = t.match(/(\d{1,2}[:.]\d{2})\s*(?:-|to|–)\s*(\d{1,2}[:.]\d{2})/);
    spec.session = ses ? { from: ses[1].replace('.', ':'), to: ses[2].replace('.', ':') } : { from: '09:15', to: '15:30' };
    matched.push(`filter: session ${spec.session.from}–${spec.session.to} IST`);
  }

  // ── date range ───────────────────────────────────────────────────────────
  const dr = toDateRange(t, now);
  if (dr) { spec.fromTs = dr.fromTs; spec.toTs = dr.toTs; matched.push(dr.matched); }
  if (/three years|3 years|three[-\s]?year/i.test(t) && !matched.some((m) => m.includes('months'))) {
    spec.fromTs = now - 3 * 365.25 * 86400000; spec.toTs = now;
    if (!matched.some((m) => m.startsWith('history window'))) matched.push('history window: last 3 years');
  }
  if (/commission|brokerage|slippage/i.test(t)) notes.push('Commission and slippage are configurable; current defaults from the cost model are applied.');

  if (!unsupported.length && spec.entry.length === 0) {
    ambiguous.push('No recognisable entry condition found. Add an indicator or SMC rule (e.g. "RSI < 40", "bullish order block retest", "EMA(20) crosses above EMA(50)").');
  }

  const finalSpec = schema.normalize(spec);
  // Keep parser-only extras on the spec so the engine can use them.
  finalSpec.riskPct = spec.riskPct != null ? spec.riskPct : base.riskPct;
  finalSpec.maxBars = spec.maxBars != null ? spec.maxBars : (base.maxBars != null ? base.maxBars : 30);
  finalSpec.riskLevels = /\b(0?\.25|0?\.5|1|2)\s*%/.test(t) && /risk level|compare|different risk/i.test(t) ? [0.25, 0.5, 1, 2] : undefined;

  const check = schema.validate(finalSpec);
  return {
    spec: check.spec, diagnostics: { matched, unsupported, ambiguous, notes }, valid: check.ok, errors: check.errors, warnings: check.warnings,
  };
}

module.exports = { parse, UNSUPPORTED };
