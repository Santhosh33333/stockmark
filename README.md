# StockArtha 2.0

**Live NSE & BSE smart-money scanner.** Wick rejection + unmitigated order block + inducement sweep + 4H RSI filter, with explainable scoring, live charts, paper trading, alerts, an owner/admin console and an optional Dhan live-execution bridge.

> Educational analysis tooling — **not investment advice**. All market data is in ₹ (INR).

---

## Why it exists

Most "ICT / SMC" scanners are black boxes or need a paid data feed. StockArtha scans the **whole** NSE + BSE universe on **free public data**, prints *exactly* which rules passed on every setup, and never invents a price. If the data provider is unreachable it shows an explicit "unavailable" state rather than a random candle.

The strategy engine exists as **two twins that share identical rules**:

| Twin | File | Used by |
| --- | --- | --- |
| JavaScript | `src/strategy.js` | web scanner, charts, paper trader, backtests |
| Pine Script v5 | `pine/smc_wick_ob_inducement.pine` | TradingView (paste into the Pine editor) |

---

## Features

- 🔎 **Full-universe scanner** — every NSE + BSE equity, F&O tag, indices; parallel, cached, resumable.
- 🕯️ **Explainable setups** — wick rejection, order block, inducement sweep, 4H RSI; every pass/fail reason is surfaced.
- 📈 **Real charts** — candles, order-block zones (fresh / mitigated / invalidated), BUY markers, 4H RSI series.
- 💼 **Paper trading** — SL/TP/time exits on live ₹ prices, portfolio stats (win rate, profit factor, drawdown), auto-fill from signals.
- 🔔 **Alerts** — in-app feed, browser notifications, Telegram bot, and a TradingView webhook endpoint.
- 🛡️ **Owner console** — overview, users (role toggle + password reset), signals, trades, audit log and system health, all in one tabbed panel.
- 🤖 **Optional live execution** — bring your own free DhanHQ API key; risk caps enforced server-side; paper stays fully separate.
- 📱 **Installable PWA** + a marketing landing page separate from the app.
- 🎨 **2.0 UI** — desktop sidebar + mobile bottom nav, 3D tilt / parallax / glow motion layer (respects `prefers-reduced-motion`).

---

## Quick start

**Requirements:** Node.js **20+** (uses the built-in `node:sqlite` — no native build).

```bash
npm install
npm start
```

Then open:

| | URL |
| --- | --- |
| App | http://localhost:5124/app |
| Landing | http://localhost:5124/ |
| API | http://localhost:5124/api |
| Health | http://localhost:5124/healthz |

Dev mode with auto-restart: `npm run dev`.

The first run builds the symbol universe from NSE/BSE archives (a few seconds) and caches it in `data/universe.json`.

---

## Configuration

Everything is optional — the defaults work out of the box with free endpoints. Copy `.env.example` to `.env` to override.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5124` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `SCAN_CONCURRENCY` | `12` | Parallel Yahoo requests |
| `SCAN_DAILY_RANGE` | `8mo` | Daily candle window for the scanner |
| `SCAN_HOURLY_RANGE` | `45d` | Hourly window (resampled to 4H) |
| `MAIL_PROVIDER` | auto | `brevo` \| `smtp` \| `dev` (see below) |
| `BREVO_API_KEY` | — | Brevo HTTP API key (free 300 emails/day) |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | — | Gmail app-password fallback |
| `OTP_TTL_MINUTES` | `10` | OTP lifetime |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Alternative to `owner.json` (see below) |

### Email OTP

Sign-up and login are protected by a 6-digit email OTP. Pick whichever free sender you have:

1. **Brevo** (recommended) — https://brevo.com → *SMTP & API → API keys*, then set `BREVO_API_KEY`.
2. **Gmail SMTP** — create an App Password at https://myaccount.google.com/apppasswords and set `SMTP_HOST=smtp.gmail.com`, `SMTP_USER`, `SMTP_PASS`.
3. **Dev** — leave everything unset. No email is sent; the OTP is printed to the server log and shown in the UI.

### Owner / admin account

The owner account is seeded on boot from the private local file **`owner.json`** (git-ignored, never exposed by any API):

```json
{ "email": "you@example.com", "password": "change-me" }
```

`ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars work the same way. The owner sees the **Admin console** (`/app/#admin`) with the extra tabbed panel.

---

## The strategy engine

**Five numbered conditions** — no black box. The default `improved` preset (the only variant that actually triggers on real daily data):

| # | Rule | Default |
| --- | --- | --- |
| 1 | Strong wick rejection | lower wick ≥ **1.5 × body**, close in top **30%** of range, bullish candle, volume > **20-SMA** |
| 2 | Bullish order block | last bearish candle before an impulse ≥ **2 × ATR(14)** within **3** bars; deactivates after **50** bars |
| 3 | Inducement sweep | sweeps the block low by ≤ **1.5 × ATR** and closes back above |
| 4 | Higher-timeframe filter | true **4H RSI(14) < 50** at the trigger bar |
| 5 | Trade management | entry at close, stop **3%**, target **10%**, time exit after **25** bars |

Optional confluence: EMA(50), daily RSI, weekly MACD.

The original spec is kept as the **`strict`** preset (`wickMult 2.0`, `sweepAtrMult 0.3`, the wick must sit on the sweep bar, deep sweeps mitigate the zone). It is selectable and documented, but on daily large-caps it produces **~0 signals**.

### Measured results (not promises)

Aggregate of per-symbol daily backtests using the engine, across NSE F&O names over 10 years:

| Run | Trades | Win rate | Profit factor | Worst DD |
| --- | --- | --- | --- | --- |
| `improved`, 10y | 628 | 30.9% | 1.28 | 21% |
| `improved` + 4H RSI filter (~2y window)* | 147 | 36.1% | 1.55 | 12% |
| `strict`, 10y | 6 | 16.7% | 0.23 | −11.5% |

\* Yahoo caps 1-hour history at 730 days, so the 4H-filtered run spans ~2 years. Backtests ignore costs/slippage and are **educational** — run your own.

```bash
node scripts/backtest.js                       # NIFTY 50, default preset
node scripts/backtest.js --range=10y           # longer window
node scripts/backtest.js --no-htf              # drop the 4H RSI filter
node scripts/backtest.js --symbols=RELIANCE,TCS,INFY
node scripts/backtest.js --limit=80            # 80 largest F&O names
```

---

## API reference

Base: `/api`. Auth via `Authorization: Bearer <token>` (issued by the OTP flows).

### Public

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `GET` | `/market/status` | Market state (IST), indices |
| `GET` | `/universe` | Symbol masters + counts (NSE / BSE / F&O) |
| `GET` | `/analysis/:symbol` | Candles, OB zones, signals, 4H RSI, stats |
| `POST` | `/scan/start` | Start a background scan (`preset`, `opts`) |
| `GET` | `/scan/latest` | Latest scan rows |
| `GET` | `/scan/jobs` | Running scan jobs |
| `GET` | `/scan/stream` | Server-Sent Events scan progress |
| `GET` | `/signals/latest` | Fresh signal feed |

### Account

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/signup` \| `/auth/login` | Start email + password (issues OTP) |
| `POST` | `/auth/verify-otp` \| `/auth/verify-login-otp` | Verify OTP → session token |
| `POST` | `/auth/resend-otp` \| `/auth/logout` | Resend / end session |
| `GET` | `/me` · `PUT` `/me/settings` | Profile + settings |
| `GET`/`POST`/`DELETE` | `/watchlist[/:symbol]` | Watchlist |
| `GET` | `/paper/stats` | Portfolio stats |
| `POST` | `/paper/open` \| `/paper/close` \| `/paper/evaluate` \| `/paper/auto` | Paper trades |
| `GET` | `/alerts/history` · `POST` `/alerts/telegram-test` | Alerts |
| `POST` | `/webhook/tradingview` | TradingView alert ingest |
| `POST` | `/dhan/test` \| `/dhan/order` | Optional Dhan live execution |
| `GET` | `/mail/status` | Email-sender status |

### Admin (owner only)

`GET /admin/overview` · `/admin/users` · `/admin/logs` · `/admin/trades` · `/admin/signals` · `/admin/jobs` · `/admin/health`  
`PATCH` `/admin/users/:id` (role + password reset) · `DELETE` `/admin/users/:id` · `POST` `/admin/scan` · `/admin/mail-config` · `/admin/mail-test`

### Non-API routes

| Path | Description |
| --- | --- |
| `/` | Landing page |
| `/app` | The SPA |
| `/smc-strategy.pine` | Download the Pine Script deliverable |
| `/icons/*`, `/logo.svg` | Brand assets |

---

## TradingView Pine Script

Download from **`/smc-strategy.pine`** (or the footer link on the landing page) and paste it into TradingView's Pine editor. It mirrors `src/strategy.js`, including the `improved` defaults, the `wickWindow` input and the `strict` toggle. The Pine editor cannot be automated (shadow DOM) — paste it manually.

---

## Project structure

```
server.js                 Express bootstrap (API + /app + landing + /healthz)
config.js                 All configuration, free defaults
owner.json                Private owner creds (git-ignored)
src/
  auth.js util.js         Sessions, hashing, market-hours helpers
  strategy.js             SMC engine (JS twin of the Pine script)
  indicators.js           SMA / EMA / RSI / ATR / MACD / 4H resample
  scanner.js              Parallel universe scanner + jobs + SSE
  paper.js                Paper-trading engine
  mailer.js notify.js     Email OTP senders + Telegram/browser alerts
  dhan.js                 Optional Dhan live-execution bridge
  db.js                   node:sqlite schema + prepared statements
  routes/public.js        Market / scan / analysis / SSE
  routes/account.js       Auth / watchlist / paper / alerts / dhan / admin
  providers/yahoo.js      Free quotes + candles
  providers/symbols.js    NSE + BSE symbol masters
  otp/                    OTP generate / validate / spam-guard
public/
  landing.html landing.css
  app/  index.html app.css app.js chart.js fx.js sw.js manifest.webmanifest
  icons/  logo.svg
pine/smc_wick_ob_inducement.pine
scripts/
  selftest.js             Live end-to-end test suite
  backtest.js             Long-history backtest runner
  experiment.js debug-pipeline.js make-icons.js
data/                     Runtime DB, cache, logs (git-ignored)
```

---

## Testing

```bash
npm test        # node scripts/selftest.js
```

The suite boots a server (or targets `STOCKARTHA_BASE`) and runs the live end-to-end flow: API health, universe, market status, strategy analysis, backtest stats, the full signup → OTP → login → session path, watchlist, settings, paper open/evaluate/close, a real scan, signal + alert feeds, the Dhan guard, mail status, and the landing/app/manifest/icon assets.

> With a real email provider configured the API returns no dev OTP; the test reads the code from the `email_otps` table in `data/app.db`.

---

## Data sources (all free, no keys)

- **Yahoo Finance** — quotes and candles (`dailyRange` / `hourlyRange`).
- **NSE archives** — `EQUITY_L.csv`, `fo_mktlots.csv`, `ind_nifty500list.csv`.
- **BSE API** — active equity scrip list.

---

## Deploying

Any Node 20 host works (Render, Railway, Fly, a VPS). Set `PORT` (many platforms inject it), keep `HOST=0.0.0.0`, and point the platform health check at `/healthz`. Persist the `data/` directory for the SQLite DB and caches.

---

## Known limitations

- Free endpoints are unofficial and rate-limited; the scanner caches aggressively and retries.
- Yahoo caps 1-hour history at 730 days, so the 4H RSI filter spans ~2 years of history.
- ICT concepts have no universal definition — the exact rules used are printed on every chart and in this README.
- The Pine editor cannot be scripted; the `.pine` file is a manual paste.

---

## License

Provided as-is for educational use. Not investment advice.
