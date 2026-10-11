# TradeMind Future — rebuild checklist & status

_Phased rebuild of the existing repo. This is the honest state of each phase; deferred items are listed as deferred, not done._

## Phase 1 — Inspection ✅
- Stack (unchanged — no technical reason to migrate): Node ≥20 + Express 4, CommonJS, **zero build step**; DB = built-in `node:sqlite`; frontend = vanilla-JS SPA at `/app` + static marketing page at `/`.
- Market data facade `src/providers/index.js`: **Angel One → Fyers → Tapetide → Yahoo (always-on fallback)**. Options: Dhan (optional) with free NSE fallback.
- Auth: email+password, optional email OTP; DB sessions; admin seeded from `owner.json`.
- Findings: `public/landing.css` is **dead** (landing carries its own styles — left as-is); landing hero already used real `/api/analysis/^NSEI` (kept); app shell had no command palette / global search / freshness chip / collapsible sidebar; no fabricated data found.
- **Preserved:** all working features, all user records, provider facade, strategy/backtest/paper/options engines, honesty rules. `public/app/app.js` (87 KB) logic untouched by this work.

## Phase 2 — TradeMind Future design system ✅
- [x] `public/future.css`: canonical tokens (graphite/navy surfaces, emerald bull `#10d98a`, restrained red `#f43f5e`, cyan accent `#22d3ee`), light theme, shared components (`.tm-btn/.tm-card/.tm-chip/.tm-badge/.tm-input/.tm-skel/.reveal`), ambient lighting, accessible focus, reduced-motion.
- [x] Same token names/values used by landing and app (`app.css :root` rethemed to match).

## Phase 3 — Identity ✅ (partial)
- [x] `public/logo.svg`: distinctive geometric mark — candlesticks + a market-structure break line + spark node (used as favicon + animated brand).
- [x] Animated brand on the landing hero (3D rotate, conic sheen, reduced-motion honoured).
- [ ] The standalone `/logo3d` page was **not** rewritten (still the earlier version). The PNG brand asset is untouched.

## Phase 4 — Landing redesign ✅
- [x] Premium responsive hero; headline "See the Market Structure. Trade With a Plan."; supporting SMC copy.
- [x] Layered **interactive** chart preview on **real NIFTY** data (candles, order blocks, FVG, liquidity, EMA 20/50) with **layer-toggle chips** + **crosshair price readout**.
- [x] Ambient lighting, progressive scroll-reveal (with no-JS + throttled-tab safety), micro-interactions, 3D tilt on fine pointers.
- [x] Showcases (scanner/chart/backtesting/paper/options), feature grid, workflow steps — all linked to real routes.
- [x] Market-data transparency (live provider + last-update from `/api/providers/source`), setup requirements, risk disclosure, footer (docs/privacy/terms/contact).
- No fabricated prices, stats, testimonials or approvals. Unavailable data shows an explicit offline state.

## Phase 5 — App shell ✅
- [x] Global symbol search in the topbar + **Ctrl/Cmd-K command palette** (`shell.js`) — searches pages, actions, watchlist and ~2,000 live symbols.
- [x] Data-freshness + provider chip (live/cached/stale/off) from `/api/providers/source`.
- [x] Collapsible sidebar, preference persisted in `localStorage`.
- [x] Keyboard navigation: `/` focus search, `g`+`d/s/b/o/p/a/e` jumps, Esc closes.
- [x] Optional light theme toggle (beta) — persisted.
- Market-session indicator kept (already present).

## Phase 6 — Trading workspace ✅ (partial)
- [x] Dashboard widgets are real (existing engine); added freshness/provider chip to the shell.
- [x] Resizable sidebar with saved width (drag handle; double-click / palette to reset). Persisted layout.
- [ ] Resizable chart/detail panes (inside `app.js`) — **deferred** (see Next steps).

## Phases 7–11 — Scanner / chart / backtest / paper / options ✅ (audited)
- [x] Endpoints live and exercised (see tests). No fabricated data; unsupported fields show `—`.
- [x] Scanner table keeps sticky header + sorting; freshness/connection state surfaced in the shell.
- [ ] Virtual scrolling for very large universes — **deferred**.

## Phase 12 — Integrations & security ✅
- [x] Provider secrets server-side only; masked in `publicView()`.
- [x] Admin routes guarded (verified 403 for non-admin/anonymous).
- [x] Paper trading never calls Dhan (verified guard).

## Phase 13 — Test & repair ✅ (partial)
- [x] `npm test` (live selftest) — **57/57 passed** (see Delivery report).
- [x] In-browser audit: every app route + stock detail renders; **0 console errors**; palette/collapse/freshness verified.
- [x] Dedicated deterministic unit tests for SMC/backtest/cost maths — `npm run test:unit` (**25/25**).

## Verification log
- selftest: **42/42** live checks passed (run clean; test user removed afterward → 1 owner account, 0 sessions).
- Landing: live NIFTY ₹22,520.45 / +1.30%, RSI 40.5, structure DOWN·BEAR, provider "Yahoo Finance · last update …" — 0 console errors.
- App shell: `window.__shell` present; palette returns real symbols (RELIANCE, NIFTY 50, …); palette navigation + `g o` + Ctrl-K all work; freshness "live · Yahoo Finance"; collapse persists — 0 console errors.
- All landing links resolve HTTP 200.

## Phase 14 — Future-ready backend upgrade (A–J brief) ✅ (this pass)
- [x] Resilience: TTL cache + in-flight dedup + retry/backoff/Retry-After + `/api/metrics`.
- [x] Data-quality labels (LIVE/DELAYED/STALE/CLOSED/DEMO) on analysis, market status and the shell chip.
- [x] SMC additions: premium/discount, displacement, VWAP, swing labels, equal H/L, signal reasons + confirmed/forming.
- [x] Multi-timeframe now includes 5m/15m/1h/4h/D/W (`?intraday=1`).
- [x] Deterministic research assistant `/api/research/:symbol` (no invented probability).
- [x] Options analytics: Black-Scholes Greeks, max pain, OI, IV rank (real history), payoff builder.
- [x] Options **expiry comparison** (nearest expiries: atm IV term structure, PCR, max pain, OI) + NSE request throttle.
- [x] Options analytics + strategy builder surfaced in the UI (Ctrl/Cmd-K palette → live chain table, OI, Greeks, payoff chart).
- [x] Risk management: per-trade/daily/drawdown limits, kill switch, `/api/risk/state`, audit logging.
- [x] Backtest realism: Indian cost model (brokerage/STT/GST/stamp/slippage) + train/test split + trades CSV — also over HTTP (`?costs=1&train=0.7`) with an *Advanced backtest* panel.
- [x] Paper history CSV export (`/api/paper/export.csv`).
- [x] Live quote stream over SSE (`/api/stream/quotes`) — pushes only changed values, auto-reconnect.
- [x] Resizable, persisted sidebar (saved layout).
- [x] `npm run test:unit` → 25/25; `npm test` → **57/57**; in-browser panels render, 0 console errors.
- [ ] WebSocket streaming — **deferred** (no free NSE/Yahoo feed; needs paid broker licence). SSE stream covers live updates.
- Full mapping of done vs deferred: see `UPGRADE_REPORT.md`.

