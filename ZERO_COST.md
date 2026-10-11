# TradeMind — Zero-Cost Deployment Audit

**Recurring software cost: ₹0.** This project adds **no new dependencies** and
requires **no API keys** to run. Every data path has a free, key-less default.

## Services actually used

| Concern | What we use | Free tier / cost | Paid alternative (optional) |
|---|---|---|---|
| Market data (quotes, candles) | **Yahoo Finance** public endpoints | Free, no key, no account | Angel One / Fyers / Tapetide broker feed — *user's own account, only if they want true real-time* |
| Option chain | **NSE** public option-chain API | Free, no key | Dhan — *user's own token, optional* |
| Database | **`node:sqlite`** (Node built-in) | Free, bundled, no server | — |
| Web/server | **Node.js + Express** (OSS) | Free | — |
| Live streaming | **Server-Sent Events (SSE)** in-process | Free | WebSocket would need a paid broker licence — **not used** |
| Email / OTP | **not used** — sign-in is email + password | Free (no provider) | Brevo / Gmail SMTP — *no longer needed* |
| Charts | Hand-rolled SVG / canvas (existing) | Free | TradingView paid — **not used** |
| Hosting | Run locally, on your LAN, via a free Cloudflare Tunnel, or any free tier (Render/Fly free, Oracle Always-Free VM) | ₹0 on free tiers (see DEPLOY.md for real limits) | — |

## What is NOT required
- No paid market-data subscription.
- No cloud database.
- No SMS/email provider.
- No credit card, no trial that expires into a charge.
- No secrets in the repo: `owner.json`, `.env`, `data/` and `*.db` are gitignored.

## Free-tier limits we respect
- Yahoo/NSE are polled politely: short-TTL quote cache (4s) + in-flight
  de-duplication + exponential backoff + `Retry-After` handling + a single SSE
  poll loop instead of per-client polling.
- The NSE option chain (limit ~1 request / 3s) is serialised through one queue
  with a configurable gap (`NSE_MIN_GAP_MS`, default 3000ms), and the session
  cookie + contract info are memoised (~5 min). Multi-expiry comparison is
  spaced accordingly instead of bursting (which NSE blocks by IP).
- If a free source rate-limits, the resilience layer backs off and the UI shows
  `DELAYED`/`STALE` rather than failing or silently switching to a paid source.
- Brevo/SMTP support still exists in the code but is dormant — the app never sends
  email and never needs a mail provider to run.

## Proven with no configuration
```
npm install
npm start          # no .env, no keys, no owner.json needed to boot
# open http://localhost:5124/app   (landing at /)
```
The data-quality chip will read `DELAYED · Yahoo Finance` (or `CLOSED` after
hours) — an honest label, not a paid upsell.

## Optional, user-supplied only (never switched to automatically)
- Broker live feeds (Angel One / Fyers / Tapetide / Dhan): entered by the account
  owner in **Settings**, stored server-side, never bundled.
- Real-time **WebSocket** market data: requires a paid broker licence. The app
  ships free **SSE streaming** instead and does not require it.
