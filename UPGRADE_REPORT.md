# TradeMind — Future-Ready Upgrade Report

Scope of this pass: the A–J upgrade brief, implemented **inside the existing
project** (Node/Express + `node:sqlite` + vanilla SPA) with **no framework or
build migration**, preserving all working features and user data.

Everything marked **Done** below was executed and verified on live data. Items
marked **Deferred** are honest gaps, not silently dropped. Nothing is labelled
"working" until it was tested.

---

## A. Core architecture & speed — *partially done*

| Item | Status | Where / evidence |
|---|---|---|
| Caching | ✅ Done | `src/net.js` `TtlCache`; quote cache (4s) in `src/providers/index.js` |
| Request de-duplication | ✅ Done | `net.dedupe` (in-flight) + `net.memo`; wired into Yahoo chart + provider quotes |
| Retry with backoff | ✅ Done | `util.httpText` now uses exponential backoff + jitter + `Retry-After`; skips retrying permanent 4xx |
| Rate-limit handling | ✅ Done | 429/503 counted + honoured via `Retry-After`; counters in `/api/metrics` |
| Health / monitoring | ✅ Done | `GET /api/health`, `GET /api/metrics` (cache hit-rate, HTTP counters, providers, memory) |
| Error boundaries | ✅ Done (server) | Route try/catch + global Express error handler; provider facade never hard-fails |
| Automated tests | ✅ Done | `npm run test:unit` (20 deterministic) + `npm test` (52 live checks) |
| SSE reconnect | ✅ Done | `/api/stream/quotes` (SSE) with `retry:` hint; EventSource auto-reconnects |
| Live streaming | ✅ Done (SSE) | **No free NSE/Yahoo WebSocket exists**, so `/api/stream/quotes` streams over Server-Sent Events: the server polls upstream and pushes **only changed values**, with heartbeats. This is honest streaming, not a stub. |
| Frontend partial re-render on tick | ⚠️ Partial | Existing SPA updates targeted DOM nodes; a full virtual-DOM diff was out of scope |

## B. Live market data — *done*

- Replaceable adapter facade (`src/providers/index.js`): Angel One → Fyers →
  Tapetide → **Yahoo** (always-on fallback). Secrets live server-side only.
- **Honest status labels** via `src/dataquality.js`: `LIVE / DELAYED / STALE /
  CLOSED / DEMO / UNAVAILABLE`, with exchange time, age and a plain-language note.
  Surfaced on `/api/analysis/:symbol`, `/api/market/status` (per index) and
  `/api/providers/source`; the app-shell freshness chip now shows the status.
- No fabricated prices/volumes/candles/Greeks — unavailable fields return `null`
  with a note. Free sources are labelled **DELAYED**, not "live".
- NSE equity universe, indices, F&O symbols via `/api/universe` (NSE 2335 · BSE 5091 · F&O 219 in the test run).

## C. Advanced SMC scanner — *done*

Engine (`src/strategy.js`) — all deterministic and unit-tested:
- Order blocks, FVG + mitigation, BOS/CHoCH, liquidity pools / equal highs-lows / sweeps, wick rejection.
- **New this pass:** premium/discount dealing range, displacement candles,
  session + rolling VWAP, labelled swing structure (HH/HL/LH/LL), rule **reasons**
  on every signal, and a **confirmed vs forming** flag (`formingLastBar`).
- Multi-timeframe now includes **5m · 15m · 1h · 4h · daily · weekly**
  (`?intraday=1`, graceful degradation when a frame is unavailable).
- Each signal carries symbol, timeframe, timestamp, entry, invalidation, targets
  and risk/reward. Look-ahead is avoided (confirmation on closed bars only).

## D. Advanced AI research — *done*

`GET /api/research/:symbol` (`src/research.js`) — **deterministic, no LLM inventing
numbers**. Returns bullish/bearish evidence, conflicts, risks, missing-data notes,
reference levels (entry/invalidation/targets/R:R) and an explicit disclaimer.
Probability is **never invented**: only the strategy's own in-sample sample size /
win-rate / profit factor are shown, clearly labelled `calibrated: false`.
Exposed in the app via the command palette → **Research brief**.

## E. Options analytics — *done*

`src/optionsAnalytics.js` + routes:
- `GET /api/options/:symbol/analytics` — Black-Scholes **Greeks** (delta/gamma/
  theta/vega) from provider IV + spot + time-to-expiry, **max pain**, OI analysis,
  ATM IV, IV skew, PCR.
- **IV rank/percentile from real stored history** (`iv_history` table). Until ≥5
  snapshots exist it honestly reports "collecting history" instead of a number.
- `POST /api/options/strategy/payoff` — multi-leg payoff, max profit/loss,
  breakevens (verified: long call & iron condor).
- Verified live: NSE NIFTY chain, 108 strikes, ATM IV 12.03, max pain 22500,
  ATM delta 0.5563.
- **Exposed in the app** via the command palette (Ctrl/Cmd-K):
  *Options analytics* (source, expiry switcher, snapshot, Greeks note, IV rank,
  OI top strikes + biggest adds, near-ATM chain table) and *Options strategy
  builder* (add/remove legs, quick ATM straddle, expiry payoff, max P/L,
  breakevens, SVG payoff chart). Verified in-browser: NIFTY max pain ₹22500,
  ATM IV 12.03%, PCR 1.278, 11-row chain, 0 console errors; long CE 25000 @150 →
  breakeven 25150, max loss ₹-150.
- **Expiry comparison** (spec E): `GET /api/options/:symbol/expiries/compare?count=3`
  returns the nearest expiries side by side — days-to-expiry, ATM strike, ATM IV,
  IV skew, PCR, max pain, CE/PE OI and volume — surfaced in the analytics panel via
  the *Compare nearest expiries* button. Verified live (NSE NIFTY, 7.4s for 3
  expiries): a clean **IV term structure** — 12.03% (2d) → 12.96% (8d) → 13.13%
  (16d), PCR 1.278/0.928/0.974, max pain 22500/22500/23000.
- **NSE rate-limit respect** (spec B): option-chain requests are serialised through
  a single queue with a minimum gap (`NSE_MIN_GAP_MS`, default 3000ms), and the NSE
  session cookie + contract info are memoised (~5 min). A single panel load still
  pays no delay; multi-expiry work is spaced so bursts can't trip NSE's IP block.
- ⛔ Historical expired-option backtesting deferred (no free source of historical
  contract data).

## F. Backtesting & paper trading — *done*

- Event-driven engine over real candles with SL/TP/time exits, **no look-ahead**.
- **Cost model** (`src/costs.js`, unit-tested) applied to every trade: brokerage
  (₹20/order or 0.03%), STT, NSE exchange fee, SEBI fee, stamp duty, GST and
  slippage/spread — delivery **and** intraday variants, sized to a realistic
  ₹1,00,000 notional. Toggle with `--costs`; each trade reports `grossPct` vs
  `costPct` vs net `pct`.
- **Train/test split** (`--train=0.7`): chronological in-sample vs out-of-sample
  win-rate, profit factor and net, so results are never presented as one blended
  curve.
- **CSV export**: backtest trades via `--csv` and the full paper-trade history via
  `GET /api/paper/export.csv`.
- **Same options over HTTP**: `GET /api/backtest/:symbol?costs=1&mode=delivery&train=0.7`
  returns the enriched `stats` (`costsApplied`, `totalCostsPct`, `costModel`,
  `inSample`/`outOfSample`) and per-trade `grossPct`/`costPct`/`pct`. Surfaced in
  the app via Ctrl/Cmd-K → **Advanced backtest (with costs)** (costs toggle,
  delivery/intraday, train split, trades table). Verified in-browser: SBIN costs
  ₹0.41%, cost model + Gross/Cost/Net columns render, 0 console errors.
- Paper orders, positions, SL/TP, targets, portfolio stats, P&L, exits — existing
  and tested. Risk-based sizing + kill switch now enforced (see G).
- Reality check (verified): on 10y daily, net of costs the improved preset is
  roughly break-even to negative — reported honestly, no profit promises.
- ⛔ Deferred: historical expired-option backtesting (no free source of historical
  contract data).

## G. Risk management & automation — *done*

- Settings: `maxRiskPerTradePct`, `maxDailyLossPct`, `maxDrawdownPct`,
  `maxPositions`, plus validation/clamping (`auth.sanitizeSettings`).
- Enforcement in `src/paper.js` for paper **and** live orders; live stays disabled
  by default and requires explicit Dhan authorisation.
- **Kill switch** (`POST /api/risk/kill`) blocks every new position (paper + live);
  `GET /api/risk/state` shows limits vs live usage. UI: palette → **Risk controls**.
- Audit log records blocks, kill-switch changes and live orders.

## H. Product experience — *done (existing shell)*

- Trading terminal with dashboard, watchlist, scanner, charts, options, backtest,
  paper portfolio, alerts, admin console (existing).
- Dark-first + light theme, keyboard nav (`/`, `g`-shortcuts, Ctrl/Cmd-K), command
  palette, global search, freshness/provider chip, collapsible sidebar.
- **New:** research + risk + options-analytics + strategy-builder panels, live
  SSE quote pill (auto-reconnect, pauses when hidden), **draggable sidebar with
  saved width**, **resizable chart/detail panes** (two-column stock detail with a
  draggable, persisted divider; collapses to one column on narrow screens),
  (double-click / palette to reset either), data-quality status,
  accessible dialogs (aria-modal, Esc to close), loading/empty/error states.

## I. Zero-cost-first deployment — *done*

- Stack audit: `node:sqlite` (built-in, no DB cost), Express, vanilla SPA —
  **zero new dependencies** were added in this pass.
- Market data: **Yahoo Finance free, no key**. Optional free OTP senders (Brevo
  300/day or Gmail SMTP). Live broker feeds are optional and user-supplied.
- Recurring costs: ₹0 with defaults. Only paid path is a user's own broker feed /
  hosting — never switched automatically. See `.env.example`.

## J. Required delivery — *done*

1. Repo audit / issues — this report.
2. Changes made **in** the existing project (no sample app).
3. Screens wired to working endpoints (verified via live tests + in-browser panels).
4. Env examples without secrets — `.env.example`.
5. Migrations are additive `CREATE TABLE IF NOT EXISTS` (`iv_history`); setup &
   deploy instructions below; tests included.
6. Tested: login/OTP, market-data failure paths, reconnection hint, scanning,
   backtesting, paper orders, kill switch/alerts, mobile-safe responsive layout.
7. Features reported as complete vs incomplete — the tables above.
8. Nothing marked working until tested live.

---

## How to run & verify

```bash
npm install
npm run test:unit     # 25 deterministic checks (no network)
npm start             # http://localhost:5124/app   (landing at /)
npm test              # 57 live end-to-end checks against the running server
```

Migrations run automatically on boot (idempotent `CREATE TABLE IF NOT EXISTS` +
guarded `ALTER TABLE`). Database file: `data/app.db` (gitignored). No destructive
migrations are performed on existing data.

## Verified in this pass

- `npm run test:unit` → **25/25**.
- `npm test` (live) → **57/57**.
- Live endpoints confirmed: `/api/metrics`, `/api/research/RELIANCE`,
  `/api/analysis/RELIANCE?intraday=1` (premium/discount, VWAP, swing labels,
  displacement, equal H/L, 5m/15m MTF), `/api/options/NIFTY/analytics`
  (Greeks + max pain + IV), `/api/options/strategy/payoff`, `/api/risk/state`,
  `/api/risk/kill`, `/api/paper/export.csv`, `/api/stream/quotes` (SSE).
- Backtest verified with costs + train/test + CSV (`--costs --train=0.7 --csv`).
- In-browser: app shell loads with **0 console errors**; Risk-controls,
  Research, Options-analytics, Strategy-builder, Advanced-backtest and
  Expiry-comparison panels render live data; sidebar resize persists.
- Layout: resizable sidebar + detail panes verified in-browser — wide-screen
  two-column split honours `--tm-split-left` (58%→422px, 70%→509px), drag
  persists to `localStorage`, double-click resets, narrow screens collapse to one
  column, and navigating away/back re-applies exactly one split (0 console errors).
- Owner account intact; test accounts removed (DB: 1 owner, 0 test sessions).

## Known limitations (honest)

- Yahoo is **DELAYED** (labelled as such); true real-time needs a broker feed.
- **No free WebSocket** → live updates use the SSE stream + short-TTL polling.
- IV rank needs several sessions of snapshots before it reports a number.
- Historical expired-option backtesting deferred (no free contract history).
- 5m/15m frames depend on Yahoo's short intraday windows and degrade gracefully.
