# TradeMind on the Play Store — APK via PWA (TWA) + listing guide

The app is a fully installable PWA (`public/app/manifest.webmanifest`,
`public/app/sw.js`, maskable icons). The Play Store path below wraps that PWA
as a native **Trusted Web Activity** — no rewrite, no separate codebase, ₹0
build tools. What costs money: the **Google Play developer account (US $25
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
      `app.trademind.twa`, versionName `1.0.0`, minSdk 24, targetSdk 34:
      - Download: **`/app.apk`** → `public/download/TradeMind-v1.0.0.apk`
      - Rebuild: `powershell -File scripts\build-apk.ps1`
- [x] **Asset-links carries the real fingerprint** —
      `69:22:05:39:8F:8D:8D:DB:D7:38:67:46:65:FE:72:7E:BD:3F:00:00:7E:D1:D6:5A:91:49:3C:E0:FB:63:A1:70`
      (matches the keystore at `D:\android\trademind.keystore`, alias
      `trademind`). Served with `application/json` at
      `/.well-known/assetlinks.json`.

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
bundle with **its** key. The installed app then has a *different* SHA-256
than our keystore, and the address bar will show unless you update
asset-links. Two ways to avoid that:

- **Simplest:** keep our uploaded key as the app-signing key — in Play
  Console → *Release → Setup → App signing*, choose to use the upload key
  (our `trademind.keystore`) as the signing key, or
- Add **both** fingerprints to `sha256_cert_fingerprints` in
  `public/.well-known/assetlinks.json`: ours plus the one Play Console shows
  under *App signing key certificate*.

## 3. Store listing assets you must supply

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG | ✅ `public/icons/icon-512.png` |
| Feature graphic | 1024×500 PNG/JPG | ❌ make one (logo + "Live NSE & BSE Smart-Money Scanner") |
| Phone screenshots | ≥2, up to 8 (e.g. 1080×2400) | ❌ take on your phone from the installed PWA |
| 7" + 10" tablet screenshots | ≥1 each class | ❌ same, or "not designed for tablets" is not accepted — capture once |
| Short description | ≤80 chars | draft: "Live NSE & BSE smart-money scanner with paper trading." |
| Full description | ≤4000 chars | describe scanner, Strategy Lab, options analytics, paper trading; state data is delayed and educational, not advice |

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

- [x] Release APK + AAB built, signed, and the fingerprint is in asset-links
- [ ] Production origin is stable (custom domain recommended; Render free
      URLs sleep and show a cold-start delay — disclose nothing, but test it)
- [ ] Upload the AAB to **Internal testing** and install on your own phone:
      sign up, run a scan, open the Lab, load an option chain
- [ ] Freshness pills show honest states on mobile data (delayed/stale)
- [ ] No `console.log` secrets; API keys only server-side (already true)
- [ ] Bump `versionCode`/`versionName` in `D:\android\build\twa-app\app\build.gradle`
      and the version below for each new Play release

`APP_VERSION` for this guide: v24 — app shell `app.js?v=24`.
Android app version: `1.0.0` (versionCode 1).
