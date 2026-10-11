// Indian equity trading cost model — brokerage, STT, exchange fee, SEBI fee,
// stamp duty, GST and slippage/spread. Deterministic and unit-tested so the
// backtester, the paper trader and the UI all price a trade the same way.
//
// Defaults reflect a discount broker (e.g. ₹20/order or 0.03%, whichever lower)
// and NSE equity charges. They are conservative; override any field you like.
const DEFAULTS = {
  mode: 'DELIVERY',          // DELIVERY | INTRADAY
  brokeragePct: 0.03,        // % of turnover per order
  brokerageMin: 20,          // ₹ minimum per order
  brokerageMax: null,        // ₹ maximum per order (null = no cap)
  sttDeliveryBuyPct: 0.1,    // STT, delivery buy
  sttDeliverySellPct: 0.1,   // STT, delivery sell
  sttIntradaySellPct: 0.025, // STT, intraday sell (buy side is 0)
  exchangePct: 0.00325,      // NSE exchange transaction charge (per side)
  sebiPct: 0.0001,           // SEBI turnover fee (per side)
  stampDeliveryBuyPct: 0.015,// stamp duty on buy (delivery)
  stampIntradayBuyPct: 0.003,// stamp duty on buy (intraday)
  gstPct: 18,                // GST on (brokerage + exchange + SEBI)
  slippagePct: 0.05,         // adverse slippage + half-spread, per side
  notional: 100000,          // ₹ deployed per trade (used for position sizing/cost %)
};

function merge(cfg) { return { ...DEFAULTS, ...(cfg || {}) }; }

// Charges for one leg (one order) on a given turnover.
function sideCosts(turnover, side, cfg) {
  const c = merge(cfg);
  const intraday = c.mode === 'INTRADAY';
  const t = Math.max(0, Number(turnover) || 0);
  const rawBrokerage = t * c.brokeragePct / 100;
  const cap = c.brokerageMax == null ? Infinity : Number(c.brokerageMax);
  const brokerage = Math.min(cap, Math.max(Number(c.brokerageMin) || 0, rawBrokerage));
  const stt = side === 'BUY'
    ? t * (intraday ? 0 : c.sttDeliveryBuyPct) / 100
    : t * (intraday ? c.sttIntradaySellPct : c.sttDeliverySellPct) / 100;
  const exchange = t * c.exchangePct / 100;
  const sebi = t * c.sebiPct / 100;
  const stamp = side === 'BUY' ? t * (intraday ? c.stampIntradayBuyPct : c.stampDeliveryBuyPct) / 100 : 0;
  const gst = (brokerage + exchange + sebi) * c.gstPct / 100;
  const total = brokerage + stt + exchange + sebi + stamp + gst;
  const r = (v) => +v.toFixed(4);
  return { brokerage: r(brokerage), stt: r(stt), exchange: r(exchange), sebi: r(sebi), stamp: r(stamp), gst: r(gst), total: r(total) };
}

// Full round-trip: buy leg, sell leg and slippage. Returns ₹ charges and the
// total cost as a percentage of the entry notional (what the P&L should lose).
function roundTrip({ entryPrice, exitPrice, qty = 1, cfg } = {}) {
  const c = merge(cfg);
  const entryNotional = Math.max(0, entryPrice) * qty;
  const exitNotional = Math.max(0, exitPrice) * qty;
  const buy = sideCosts(entryNotional, 'BUY', c);
  const sell = sideCosts(exitNotional, 'SELL', c);
  const slippage = (entryNotional + exitNotional) * c.slippagePct / 100;
  const charges = buy.total + sell.total + slippage;
  return {
    buy, sell,
    slippage: +slippage.toFixed(4),
    charges: +charges.toFixed(4),
    costPct: entryNotional > 0 ? +((charges / entryNotional) * 100).toFixed(4) : 0,
    breakdown: {
      brokerage: +(buy.brokerage + sell.brokerage).toFixed(4),
      stt: +(buy.stt + sell.stt).toFixed(4),
      exchange: +(buy.exchange + sell.exchange).toFixed(4),
      sebi: +(buy.sebi + sell.sebi).toFixed(4),
      stamp: +(buy.stamp + sell.stamp).toFixed(4),
      gst: +(buy.gst + sell.gst).toFixed(4),
      slippage: +slippage.toFixed(4),
    },
  };
}

// Break-even move (in %) required to overcome the round-trip cost.
function breakevenPct(price, cfg) {
  const rt = roundTrip({ entryPrice: price, exitPrice: price, qty: 1, cfg });
  return rt.costPct;
}

module.exports = { DEFAULTS, merge, sideCosts, roundTrip, breakevenPct };
