# TradeMind on the Play Store — APK via PWA (TWA) + listing guide

The app is a fully installable PWA (`public/app/manifest.webmanifest`,
`public/app/sw.js`, maskable icons). The Play Store path below wraps that PWA
as a native APK using a Trusted Web Activity — no rewrite, no separate
codebase, ₹0 build tools. What costs money: the **Google Play developer
account (US $25 one-time)**. Everything else here is free.

## 0. What is already done in this repo

- [x] Web manifest: name, short_name, id/scope/start_url `/app/`, standalone
      display, portrait, theme colors, `en-IN`, finance category, maskable +
      any-purpose icons (192/512), deep-link shortcuts (`#scanner #lab
      #options #paper` — the app reads the hash on boot)
- [x] Service worker registered on boot (HTTPS/localhost only): offline app
      shell, network-first for `/api/` (live data never served stale as
      fresh — the UI's freshness pills still apply)
- [x] Icons: `public/icons/icon-192.png`, `icon-512.png`,
      `icon-maskable-512.png`, `apple-touch-icon.png`
- [x] Privacy policy at `/privacy` (matches the product: password auth, no
      OTP, no ads/trackers) and Terms at `/terms`
- [x] Asset-links placeholder at `/.well-known/assetlinks.json` (served with
      `application/json`; replace the fingerprint before release)

## 1. One-time Google setup (~30 min, $25)

1. Pay the one-time $25 at <https://play.google.com/console/signup> and
   create a developer account (individual is fine).
2. In Play Console: **Create app** → name `TradeMind`, default language
   `English (India)` → category **Finance** → free app → accept declarations.
3. You will be asked for: a contact email (use the one in `/privacy`),
   the privacy-policy URL (`https://YOUR-DOMAIN/privacy`), and a
   target-audience/age declaration (18+, financial features — answer
   honestly; the app is educational analysis, **not** a trading terminal).

## 2. Build the release APK/AAB with PWABuilder (no Android Studio)

1. Go to <https://www.pwabuilder.com> → enter your **production origin**
   (the Render URL works, a custom domain looks better on the listing).
2. It scores the PWA (manifest + SW + icons + HTTPS must all pass — they do).
3. **Package for Android** → choose **App Bundle (AAB)** for the store
   (or APK for direct sideload testing on your phone).
4. Download the bundle, then **sign it**: PWABuilder can sign for you, or
   upload unsigned and let **Play App Signing** handle it (recommended).
5. Copy the **SHA-256 certificate fingerprint** from Play Console
   (Release → Setup → App signing) into
   `public/.well-known/assetlinks.json`, commit, redeploy, then verify at
   `https://YOUR-DOMAIN/.well-known/assetlinks.json`. This removes the
   browser address bar inside the installed app.

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

- [ ] Production origin is stable (custom domain recommended; Render free
      URLs sleep and show a cold-start delay — disclose nothing, but test it)
- [ ] `/.well-known/assetlinks.json` carries the real fingerprint
- [ ] Test the **closed** (internal-testing track) release on your own phone:
      install, sign up, run a scan, open the Lab, load an option chain
- [ ] Freshness pills show honest states on mobile data (delayed/stale)
- [ ] No `console.log` secrets; API keys only server-side (already true)
- [ ] Version the release: bump `APP_VERSION` below and the manifest if the
      shell changes

`APP_VERSION` for this guide: v23 (manifest shortcuts + SW registration).
