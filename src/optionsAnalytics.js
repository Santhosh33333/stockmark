// Options analytics — all values are either supplied by the provider or derived
// from valid inputs with a documented model. Nothing is invented: when an input
// is missing (IV, LTP, expiry) the field is returned as null with a note.
//
//   • Black-Scholes greeks (delta/gamma/theta/vega) from IV + spot + strike + T
//   • Max-pain settlement strike from open interest
//   • Payoff / breakeven / max-profit / max-loss for a multi-leg strategy
//   • IV rank & percentile from stored IV snapshots (real history, else null)
const { stmt, now } = require('./db');

const RISK_FREE = 0.065; // India ~6.5% (configurable via env)

// ── normal distribution helpers (Abramowitz & Stegun 7.1.26) ─────────────
function normalPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// ── Black-Scholes price + greeks ─────────────────────────────────────────
// Inputs: S spot, K strike, T years to expiry, sigma annualised IV (decimal),
// r risk-free, q dividend yield (default 0).
function bs({ S, K, T, sigma, r = RISK_FREE, q = 0, type = 'CE' }) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discR = Math.exp(-r * T), discQ = Math.exp(-q * T);
  const nd1 = normalCdf(d1), nd2 = normalCdf(d2);
  const pdf1 = normalPdf(d1);
  let price, delta, theta;
  if (type === 'CE') {
    price = S * discQ * nd1 - K * discR * nd2;
    delta = discQ * nd1;
    theta = (-(S * discQ * pdf1 * sigma) / (2 * sqrtT) - r * K * discR * nd2 + q * S * discQ * nd1) / 365;
  } else {
    price = K * discR * normalCdf(-d2) - S * discQ * normalCdf(-d1);
    delta = -discQ * normalCdf(-d1);
    theta = (-(S * discQ * pdf1 * sigma) / (2 * sqrtT) + r * K * discR * normalCdf(-d2) - q * S * discQ * normalCdf(-d1)) / 365;
  }
  const gamma = (discQ * pdf1) / (S * sigma * sqrtT);
  const vega = (S * discQ * pdf1 * sqrtT) / 100; // per 1% vol move
  return {
    price: +price.toFixed(2), delta: +delta.toFixed(4), gamma: +gamma.toFixed(6),
    theta: +theta.toFixed(2), vega: +vega.toFixed(2),
    inputs: { S, K, T: +T.toFixed(6), sigma, r, type },
    model: 'black-scholes',
  };
}

// ── Expiry parsing (NSE "DD-Mon-YYYY", ISO, or epoch ms) ──────────────────
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function expiryTs(expiry) {
  if (expiry == null) return null;
  if (typeof expiry === 'number') return expiry;
  const s = String(expiry).trim();
  const iso = Date.parse(s);
  if (isFinite(iso) && /^\d{4}-\d{2}-\d{2}/.test(s)) return iso;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon != null) return Date.UTC(Number(m[3]), mon, Number(m[1]), 10, 0, 0); // 15:30 IST ≈ 10:00 UTC
  }
  return isFinite(iso) ? iso : null;
}
function yearsToExpiry(expiry) {
  const ts = expiryTs(expiry);
  if (!ts) return null;
  const days = (ts - Date.now()) / 86400000;
  return Math.max(days, 0.25) / 365; // floor at ~6h so greeks stay finite on expiry day
}

// ── Max pain (settlement strike minimising option-writer loss) ────────────
function maxPain(strikes) {
  const rows = strikes.filter((s) => s.ce || s.pe);
  if (!rows.length) return null;
  let best = null;
  for (const cand of rows) {
    let pain = 0;
    for (const s of rows) {
      const ceOi = s.ce?.oi || 0, peOi = s.pe?.oi || 0;
      pain += ceOi * Math.max(cand.strike - s.strike, 0);
      pain += peOi * Math.max(s.strike - cand.strike, 0);
    }
    if (!best || pain < best.pain) best = { strike: cand.strike, pain: +pain.toFixed(0) };
  }
  return best;
}

// ── OI analysis ──────────────────────────────────────────────────────────
function oiAnalysis(strikes, underlyingValue) {
  const rows = strikes.filter((s) => s.ce || s.pe);
  const byCe = [...rows].sort((a, b) => (b.ce?.oi || 0) - (a.ce?.oi || 0));
  const byPe = [...rows].sort((a, b) => (b.pe?.oi || 0) - (a.pe?.oi || 0));
  const chgCe = [...rows].sort((a, b) => (b.ce?.oiChange || 0) - (a.ce?.oiChange || 0))[0];
  const chgPe = [...rows].sort((a, b) => (b.pe?.oiChange || 0) - (a.pe?.oiChange || 0))[0];
  const top = (arr, leg) => arr.slice(0, 5).filter((s) => s[leg]?.oi != null).map((s) => ({ strike: s.strike, oi: s[leg].oi, oiChange: s[leg].oiChange ?? null }));
  return {
    highestCeOi: top(byCe, 'ce'),
    highestPeOi: top(byPe, 'pe'),
    biggestCeOiAdd: chgCe && chgCe.ce ? { strike: chgCe.strike, oiChange: chgCe.ce.oiChange } : null,
    biggestPeOiAdd: chgPe && chgPe.pe ? { strike: chgPe.strike, oiChange: chgPe.pe.oiChange } : null,
    underlyingValue: underlyingValue ?? null,
  };
}

// ── IV rank / percentile from stored snapshots (real history only) ────────
function ivRank(symbol, expiry, current) {
  let history = [];
  try { history = stmt.ivHistory.all(String(symbol).toUpperCase(), String(expiry), 250).map((r) => r.iv).filter((v) => v != null); } catch { }
  const need = 5;
  if (history.length < need || current == null) {
    return { available: false, samples: history.length, need, note: `Collecting IV history (${history.length}/${need} snapshots). Rank/percentile appear once enough sessions are recorded.` };
  }
  const min = Math.min(...history), max = Math.max(...history);
  const rank = max > min ? +(((current - min) / (max - min)) * 100).toFixed(1) : 0;
  const below = history.filter((v) => v <= current).length;
  const percentile = +((below / history.length) * 100).toFixed(1);
  return { available: true, samples: history.length, min: +min.toFixed(2), max: +max.toFixed(2), rank, percentile };
}

function recordIv(symbol, expiry, iv, underlying) {
  if (iv == null || !isFinite(iv)) return;
  try { stmt.insertIv.run(String(symbol).toUpperCase(), String(expiry), +iv, underlying ?? null, now()); } catch { }
}

// ── Payoff / breakeven for a multi-leg strategy ──────────────────────────
// legs: [{ type:'CE'|'PE', strike, qty (signed: +long/-short), premium }]
function payoff(legs, { underlying, lotSize = 1, steps = 121 } = {}) {
  const clean = (legs || []).filter((l) => l && (l.type === 'CE' || l.type === 'PE') && isFinite(l.strike) && isFinite(l.qty) && l.qty !== 0);
  if (!clean.length) return { ok: false, error: 'At least one valid option leg is required' };
  const strikes = clean.map((l) => l.strike);
  const lo = Math.min(...strikes) * 0.85;
  const hi = Math.max(...strikes) * 1.15;
  const premiumNet = clean.reduce((a, l) => a + (l.premium || 0) * l.qty, 0); // >0 debit, <0 credit
  const valueAt = (S) => clean.reduce((a, l) => {
    const intrinsic = l.type === 'CE' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0);
    return a + (intrinsic - (l.premium || 0)) * l.qty;
  }, 0) * lotSize;

  const grid = [];
  for (let i = 0; i < steps; i++) {
    const S = lo + ((hi - lo) * i) / (steps - 1);
    grid.push({ price: +S.toFixed(2), pnl: +valueAt(S).toFixed(2) });
  }
  // Slope analysis for unbounded tails
  const slopeAt = (S) => (valueAt(S + 1) - valueAt(S - 1)) / 2;
  const rightSlope = slopeAt(hi), leftSlope = slopeAt(lo);
  const localMax = Math.max(...grid.map((g) => g.pnl));
  const localMin = Math.min(...grid.map((g) => g.pnl));
  const maxProfit = rightSlope > 1e-9 || leftSlope < -1e-9 ? 'unlimited' : +localMax.toFixed(2);
  const maxLoss = rightSlope < -1e-9 || leftSlope > 1e-9 ? 'unlimited' : +localMin.toFixed(2);

  // Breakevens: sign changes of pnl across the grid (linear interpolation)
  const breakevens = [];
  for (let i = 1; i < grid.length; i++) {
    const a = grid[i - 1], b = grid[i];
    if (a.pnl === 0) { breakevens.push(a.price); continue; }
    if ((a.pnl < 0 && b.pnl > 0) || (a.pnl > 0 && b.pnl < 0)) {
      const S = a.price + (b.price - a.price) * (0 - a.pnl) / (b.pnl - a.pnl);
      breakevens.push(+S.toFixed(2));
    }
  }
  return {
    ok: true,
    legs: clean,
    lotSize,
    netPremium: +premiumNet.toFixed(2),
    position: premiumNet > 0 ? 'DEBIT (net paid)' : premiumNet < 0 ? 'CREDIT (net received)' : 'FLAT',
    maxProfit, maxLoss,
    breakevens: [...new Set(breakevens)],
    payoff: grid,
    underlying: underlying ?? null,
    note: 'Expiry payoff per lot. Excludes brokerage/taxes/slippage.',
  };
}

// ── Chain enrichment: greeks + analytics ─────────────────────────────────
function enrichChain(chain, { r = RISK_FREE } = {}) {
  if (!chain || !Array.isArray(chain.strikes)) return { ok: false, error: 'No chain' };
  const S = chain.underlyingValue;
  const T = yearsToExpiry(chain.expiry);
  const greeksAvailable = !!(S > 0 && T > 0);
  const enriched = chain.strikes.map((s) => {
    const out = { ...s };
    for (const leg of ['ce', 'pe']) {
      const d = s[leg];
      if (!d) continue;
      if (greeksAvailable && d.iv > 0) {
        const g = bs({ S, K: s.strike, T, sigma: d.iv / 100, r, type: leg === 'ce' ? 'CE' : 'PE' });
        out[leg] = { ...d, greeks: d.greeks || (g ? { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, model: 'black-scholes' } : null), theoPrice: g ? g.price : null };
      } else {
        out[leg] = { ...d, greeks: d.greeks || null, theoPrice: null };
      }
    }
    return out;
  });

  // ATM IV (nearest strike to spot with a valid CE/PE IV)
  let atmIV = null;
  if (S > 0) {
    const near = [...enriched].sort((a, b) => Math.abs(a.strike - S) - Math.abs(b.strike - S))[0];
    if (near) atmIV = near.ce?.iv ?? near.pe?.iv ?? null;
  }
  // IV skew: 25-delta proxy — difference between OTM put and OTM call IV near spot
  const callSide = enriched.filter((s) => s.strike >= (S || 0) && s.ce?.iv != null).sort((a, b) => a.strike - b.strike)[0];
  const putSide = enriched.filter((s) => s.strike <= (S || 0) && s.pe?.iv != null).sort((a, b) => b.strike - a.strike)[0];
  const skew = callSide && putSide && callSide.ce.iv != null && putSide.pe.iv != null ? +(putSide.pe.iv - callSide.ce.iv).toFixed(2) : null;

  const symbol = chain.symbol;
  recordIv(symbol, chain.expiry, atmIV, S);

  return {
    ok: true,
    source: chain.source,
    symbol, expiry: chain.expiry, underlyingValue: S ?? null, atm: chain.atm ?? null,
    greeks: { available: greeksAvailable, model: 'black-scholes', riskFreeRate: r, note: greeksAvailable ? 'Computed from provider IV + spot + time to expiry.' : 'Requires spot, expiry and IV from the provider.' },
    atmIV: atmIV ?? null,
    ivSkew: skew,
    ivRank: ivRank(symbol, chain.expiry, atmIV),
    pcr: chain.pcr ?? null,
    maxPain: maxPain(enriched),
    oi: oiAnalysis(enriched, S),
    totals: chain.totals,
    expiries: chain.expiries || [],
    strikes: enriched,
    updatedAt: chain.updatedAt,
  };
}

module.exports = { bs, normalCdf, normalPdf, expiryTs, yearsToExpiry, maxPain, payoff, ivRank, recordIv, oiAnalysis, enrichChain, RISK_FREE };
