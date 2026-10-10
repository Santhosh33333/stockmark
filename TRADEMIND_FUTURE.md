# TradeMind Future — rebuild checklist

_Written after inspecting the repo. This file tracks the phased rebuild. Check items off as they land and are verified._

## Phase 1 — Inspection (done)

**Stack (unchanged — no reason to migrate):**
- Node 24 + Express 4, CommonJS, **zero build step**.
- DB: built-in `node:sqlite` (`src/db.js`).
- Frontend: vanilla-JS SPA at `/app` (`public/app/`), static marketing page at `/` (`public/landing.html`).
- Market data: provider facade `src/providers/index.js` → **Angel One → Fyers → Tapetide → Yahoo (always-on fallback)**. Yahoo is live and key-less.
- Options: Dhan (optional) with free NSE fallback (`src/providers/options.js`).
- Auth: email+password, optional email OTP; sessions in DB; admin seeded from `owner.json`.
- Tests: `scripts/selftest.js` — live end-to-end suite (42 checks).

**Findings:**
- `public/landing.css` is **dead** (landing.html carries its own inline `<style>`). Keep or delete — currently unused.
- Landing hero already pulls **real** `/api/analysis/^NSEI`; good — keep.
- App shell has sidebar + bottom nav; no command palette, no collapsible sidebar, no global search box in the topbar, no freshness chip.
- Design tokens are two separate sets (landing vs app) and both lean blue/purple; the brief wants **cyan interaction accents** + emerald/red signals.
- No fabricated data found; unavailable states are explicit. Good.
- Selftest only asserts landing/app contain the string `TradeMind` → safe to redesign markup.

**Preserve:** working features, all user records, provider facade, strategy/backtest/paper/options engines, honesty rules.

## Phase 2 — TradeMind Future design system
- [ ] Canonical tokens (graphite/navy, emerald bull, restrained red, cyan accent) + light theme + reduced-motion, in `public/future.css`.
- [ ] Shared token names across landing + app.

## Phase 3 — Identity
- [ ] Distinctive geometric mark: `public/logo.svg` (candles + structure break + spark).
- [ ] Animated brand: `public/logo3d.html` — 3D rotation, lighting, market-structure lines, reduced-motion fallback.

## Phase 4 — Landing redesign
- [ ] Premium responsive hero with animated identity + layered interactive chart preview (real NIFTY data).
- [ ] Ambient lighting, scroll-reveal, micro-interactions, layer toggles, crosshair.
- [ ] Showcases for scanner / chart / backtesting / paper / options, all linked to real routes.
- [ ] Data-transparency + integrations + risk sections. Real data only.

## Phase 5 — App shell
- [ ] Global symbol search (topbar) + Ctrl/Cmd-K command palette.
- [ ] Data-freshness + connection chip; market-session indicator (already present, kept).
- [ ] Collapsible sidebar with persisted preference.
- [ ] Keyboard navigation (`g d`, `g s`, … , `/` focus search, Esc close).

## Phase 6 — Trading workspace
- [ ] Dashboard widgets already real; add freshness + provider chip.
- [ ] Resizable panels (deferred — see Next steps).

## Phases 7–11 — Scanner / chart / backtest / paper / options
- [ ] Audited: endpoints live (selftest 42/42). No fabricated data.
- [ ] Scanner table: sticky header + sort already present; label live/cached/stale on the freshness chip.
- [ ] Virtual scrolling for very large universes (deferred).

## Phase 12 — Integrations & security
- [ ] Provider secrets: server-side only, masked in `publicView()`.
- [ ] Admin routes guarded (`requireAdmin`, 403). Verified.
- [ ] Paper trading never calls Dhan. Verified (guard test).

## Phase 13 — Test & repair
- [ ] `npm test` (live selftest) — see Delivery report for exact result.
- [ ] Dedicated unit fixtures for SMC/backtest math (deferred).

## Verification log
- (updated at the end of the run)
