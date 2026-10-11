# TradeMind on the Play Store — installable PWA wrapped in a native WebView + listing guide

The app is a fully installable PWA (`public/app/manifest.webmanifest`,
`public/app/sw.js`, maskable icons). The Play Store path below wraps that PWA
in a single-activity **native WebView** — no rewrite, no separate codebase, ₹0
build tools. A native WebView is used on purpose rather than a Trusted Web
Activity: a TWA needs Chrome plus a passing Digital Asset Links check, and on
devices without them the launcher finishes immediately and the app looks like
it "closes on open". A plain WebView opens the same URL on every Android
device. What costs money: the **Google Play developer account (US $25
one-time)**. Everything else here is free.

## 0. What is already done

- [x] Web manifest: name, short_name, id/scope/start_url `/app/`, standalone
      display, portrait, theme colors, `en-IN`, finance category, maskable +
      any-purpose icons (192/512), deep-link shortcuts (`#scanner #lab
      #options #paper` — the app reads the hash on boot)
- [x] Service worker registered on boot (HTTPS/localhost only): offline app
      shell, network-first for `/api/` (live data never served stale as
      fresh — the UI's freshness pills still apply)
- [x] Icons: `public/icons/icon-192.png`, `icon-512.png`,
      `icon-maskable-512.png`, `apple-touch-icon.png`
- [x] Privacy policy at `/privacy` (password auth, no OTP, no ads/trackers)
      and Terms at `/terms`
- [x] **Signed release APK built here** (not PWABuilder) — package
      `app.trademind.twa`, versionName `1.0.1` (versionCode 2), minSdk 24,
      targetSdk 34. The launcher is a native `MainActivity` WebView that loads
      the live URL — no Chrome / Play-Services / asset-links dependency:
      - Download: **`/app.apk`** → `public/download/TradeMind-v1.0.1.apk`
      - Rebuild: `powershell -File scripts\build-apk.ps1`
- [x] `public/.well-known/assetlinks.json` still carries the real fingerprint
      (`69:22:05:39:8F:8D:8D:DB:D7:38:67:46:65:FE:72:7E:BD:3F:00:00:7E:D1:D6:5A:91:49:3C:E0:FB:63:A1:70`,
      matching `D:\android\trademind.keystore`, alias `trademind`). It is not
      required by the native WebView build, but keeping it means the listing is
      still ready if you ever switch back to a TWA.

## 1. One-time Google setup (~30 min, $25)

1. Pay the one-time $25 at <https://play.google.com/console/signup> and
   create a developer account (individual is fine).
2. In Play Console: **Create app** → name `TradeMind`, default language
   `English (India)` → category **Finance** → free app → accept declarations.
3. You will be asked for: a contact email (use the one in `/privacy`),
   the privacy-policy URL (`https://YOUR-DOMAIN/privacy`), and a
   target-audience/age declaration (18+, financial features — answer
   honestly; the app is educational analysis, **not** a trading terminal).

## 2. Ship it to the Play Store (already-built APK/AAB)

The APK is already built and signed; rebuild any time with
`scripts\build-apk.ps1`. That script produces both:

| Output | Path | Use |
|---|---|---|
| APK | `public/download/TradeMind-v1.0.0.apk` (served at `/app.apk`) | sideload / share directly |
| AAB | `public/download/TradeMind-v1.0.0.aab` | **upload to Play Console** |

Play Store steps:

1. Play Console → your app → **Testing → Internal testing → Create release**.
2. Upload `TradeMind-v1.0.0.aab` (Play requires the AAB, not the APK).
3. Add your own Gmail as a tester, roll out, install from the Play link on
   your phone.
4. Promote to **Production** when the internal build looks good.

### Play App Signing note (important)

If you let Google manage the signing key (the default), Google re-signs your
bundle with **its** key, so the installed app has a *different* SHA-256 than
our keystore. That does not affect the native WebView build (it never checks
asset-links), but if you ever switch back to a TWA the address bar would show
until you add Google's fingerprint to `sha256_cert_fingerprints` in
`public/.well-known/assetlinks.json`.

## 3. Store listing assets

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG | ✅ `public/icons/icon-512.png` |
| Feature graphic | 1024×500 PNG | ✅ `public/store/feature-graphic-1024x500.png` |
| Phone screenshots | 2–8, 1080×1922 (9:16) | ✅ 7 in `public/store/screenshots/phone-*.png` |
| 7" tablet screenshots | ≥1, 1200×1920 | ✅ 2 in `public/store/screenshots/tablet-7in-*.png` |
| 10" tablet screenshots | ≥1, 1600×2560 | ✅ 2 in `public/store/screenshots/tablet-10in-*.png` |
| Short description | ≤80 chars | see below |
| Full description | ≤4000 chars | see below |

Screenshots are real captures of the running app (headless Chromium emulating a
phone / 7" / 10" viewport against a live session) — dashboard, scanner, stock
analysis, backtest, Strategy Lab, options analytics, auto paper-trading.

### Short description (74 chars)

```
NSE & BSE smart-money scanner, strategy lab, option chain & paper trading.
```

### Full description

```
TradeMind is a market-analysis workspace for NSE and BSE equities, built around
Smart Money Concepts and honest, verified market data.

SMART-MONEY ANALYSIS
• Market structure: breaks of structure, changes of character, swing highs and
  lows, liquidity sweeps, order blocks and fair-value gaps, marked on the chart
  with the rule that fired.
• Multi-timeframe alignment (15m / 1H / 4H / 1D) with plain-language "confirmed"
  or "conflicting" labels — no repainting, only closed candles.

STRATEGY LAB
• Describe a strategy in plain English; it is parsed into explicit entry, stop
  and target rules that you can read and edit.
• Backtest it on real history with brokerage and slippage costs, see the full
  trade log, equity curve, expectancy, profit factor and drawdown.
• Auto-screen every F&O symbol for fresh setups, and run the same rules as
  automatic paper trades (simulated only — never a real order).

OPTION CHAIN ANALYTICS
• Live NSE option chain with open interest, changes, IV, max pain, PCR,
  expected move and OI-wall support/resistance for NIFTY and index options,
  plus an expiry-to-expiry comparison.

DISCIPLINE TOOLS
• Setup planner: entry, stop, target, planned risk-reward and position size
  from your own capital and risk per trade.
• Paper trading with the same guardrails as a real desk: max positions, daily
  loss limit and drawdown limits.

TRUST AND LIMITS
• Data comes from public NSE/BSE and Yahoo Finance endpoints and can be
  delayed. Every panel shows its source and freshness, and the app says
  "insufficient data" instead of guessing when a feed is missing or stale.
• Analysis and education only. Not investment advice, and not a registered
  advisor or broker. Markets carry risk; backtests describe a specific
  historical run and do not indicate future results.

No ads. No trackers. Your watchlists, settings and paper trades stay on your
account.
```

## 4. Data-safety form (answer truthfully)

- **Data collected**: email address (account), display name (optional),
  homemade app data (watchlist, settings, paper trades), broker credentials
  **only if the user enters them** (Dhan client id + token, stored
  server-side, never in the APK).
- **Data shared**: market-data providers (Yahoo/NSE/BSE/Dhan) receive only
  the symbols requested. No ads, no analytics SDKs, no third-party sharing.
- **Security**: password hashing server-side, session tokens, HTTPS only,
  credentials removable in Settings, deletion via the contact in `/privacy`.
- **Financial features declaration**: the app shows market analysis and
  simulated paper trading; live brokerage is optional, user-configured and
  off by default. Say so explicitly.

## 5. Pre-launch checklist

- [x] Release APK + AAB built and signed (native WebView, no asset-links check)
- [ ] Production origin is stable (custom domain recommended; Render free
      URLs sleep and show a cold-start delay — disclose nothing, but test it)
- [ ] Upload the AAB to **Internal testing** and install on your own phone:
      sign up, run a scan, open the Lab, load an option chain
- [ ] Freshness pills show honest states on mobile data (delayed/stale)
- [ ] No `console.log` secrets; API keys only server-side (already true)
- [ ] Bump `versionCode`/`versionName` in `D:\android\build\twa-app\app\build.gradle`
      and `$version` in `scripts\build-apk.ps1` for each new Play release

`APP_VERSION` for this guide: v24 — app shell `app.js?v=24`.
Android app version: `1.0.1` (versionCode 2).
