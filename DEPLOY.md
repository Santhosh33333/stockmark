# TradeMind — going live (free)

The app is a single Node process with an embedded SQLite database. It needs
**no API keys** and no paid services. Going live = pick where it runs and give it
two secrets for the owner account.

> **Cost honesty:** nothing here claims to be free forever. Each option lists its
> real free-tier limit. Free web hosts generally give **ephemeral** storage (the
> database resets on redeploy); options that keep data for free use a volume or
> your own machine, and that is called out explicitly.

---

## 0. Live on your own network right now (0 config, 0 cost)

The server already binds every interface. On this machine:

```
npm start
```

Open `http://<your-lan-ip>:5124/app` from any phone/laptop on the same Wi-Fi.
This machine's address is **`http://10.184.243.230:5124/app`**.

If other devices can't connect, allow the port through Windows Firewall (run once,
as Administrator):

```powershell
New-NetFirewallRule -DisplayName "TradeMind 5124" -Direction Inbound -Protocol TCP -LocalPort 5124 -Action Allow
```

Data lives in `./data/app.db` — fully persistent.

---

## 1. Public HTTPS, free, with persistent data — Cloudflare Tunnel ⭐ recommended

Runs on this machine (SQLite stays local and persistent) and gets a public HTTPS
URL through Cloudflare's free tunnel. No router changes, no static IP.

1. Download `cloudflared.exe` for Windows from Cloudflare's releases page and
   put it on your `PATH` (e.g. `C:\Windows\cloudflared.exe`).
2. Start the app: `npm start`
3. In another terminal, get a free throwaway URL:

   ```
   cloudflared tunnel --url http://localhost:5124
   ```

   It prints a `https://<random>.trycloudflare.com` address — open that anywhere.

Notes:
- Quick-tunnel URLs are **ephemeral** (they change each run) and are fine for
  demos. For a **stable** hostname, create a free Cloudflare account, a named
  tunnel, and point a domain at it (`cloudflared tunnel login`, `tunnel create`,
  `tunnel route dns`).
- The app auto-detects HTTPS via `x-forwarded-proto`, so the session cookie is set
  `Secure` automatically.
- Your data never leaves this machine except as HTTP responses.

**Permanent hostname (named tunnel — needs a free Cloudflare account + a domain):**

```bash
cloudflared tunnel login            # browser step — sign in to Cloudflare & Authorize
cloudflared tunnel create trademind
cloudflared tunnel route dns trademind app.yourdomain.com
cloudflared tunnel run trademind    # keep this running (or install it as a service)
```

`scripts/tunnel.ps1` restarts the quick tunnel and saves the URL to
`data/tunnel.url` if you just want the throwaway link again.

---

## 2. Render — free web service (one click, ephemeral DB)

`render.yaml` is a ready Blueprint.

1. Push this repo to GitHub (already done: `Santhosh33333/stockmark`).
2. Render dashboard → **New + → Blueprint** → pick the repo → **Apply**.
3. Set the two secrets in the dashboard (**Environment → Secret**):
   `ADMIN_EMAIL`, `ADMIN_PASSWORD` (the `render.yaml` already sets
   `ALLOW_SIGNUP=off` and `NODE_VERSION=24.18.0`).

**Free-tier reality:** the free plan sleeps after ~15 min idle (first request then
takes a few seconds) and its disk is **not persistent**, so the SQLite DB resets
on every deploy/restart. Use this to show the app publicly, not to keep accounts.

---

## 3. Fly.io — Docker + a real volume (persistent)

```bash
fly launch --no-deploy          # uses the included Dockerfile + fly.toml
fly volumes create trademind_data --size 1 --region sin
fly secrets set ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me ALLOW_SIGNUP=off
fly deploy
```

`fly.toml` mounts the volume at `/data` and sets `DATA_DIR=/data`, so the DB
survives. Fly's billing is pay-as-you-go with a small monthly free allowance —
check your current account terms.

---

## 4. Oracle Cloud **Always Free** VM — persistent, self-owned

An `Always Free` ARM/AMD VM (needs a card for identity verification, but the VM
itself is free with no time limit). Best option if you want a permanently free,
fully persistent instance under your control:

```bash
# on the VM, with Node 24 installed (nvm or nodesource)
git clone https://github.com/Santhosh33333/stockmark.git && cd stockmark
npm ci --omit=dev
ALLOW_SIGNUP=off ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me npm start
# keep it alive with pm2 or a systemd unit; open port 5124 in the VCN security list
```

Put Caddy or nginx in front for free automatic HTTPS, or use option 1's tunnel to
avoid exposing the VM directly.

---

## 5. Any Docker host / VPS

```bash
docker build -t trademind .
docker run -d --name trademind -p 5124:5124 \
  -v trademind-data:/app/data \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD=change-me -e ALLOW_SIGNUP=off \
  trademind
```

The image is `node:24-slim`, uses `npm ci --omit=dev`, ships a `HEALTHCHECK`, and
expects the platform's `$PORT`. Mount `/app/data` (or set `DATA_DIR`) to persist.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `5124` / `0.0.0.0` | Listen address (hosts inject `PORT`). |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Seeds the owner account on boot. **Set these on a public host.** |
| `ALLOW_SIGNUP` | on | `off` closes public registration (owner-only). **Recommended for public deploys.** |
| `DATA_DIR` | `./data` | Where `app.db` lives — point at a mounted volume. |
| `NSE_MIN_GAP_MS` | `3000` | Min gap between NSE option-chain calls (respects their limit). |
| `ALERT_POLL_MS` | `60000` | Background price-alert poll interval; `0` disables. |
| `SCAN_CONCURRENCY` | `12` | Parallel Yahoo requests (lower it on tiny instances). |

No other variables are required. Broker keys (Dhan / Angel One / Fyers / Tapetide)
are entered **in-app under Settings** and stored server-side — never in git.

## Live trading setup (Dhan)

Live orders are **OFF by default**. To power them on:

1. Get free API keys from DhanHQ (Dashboard → API) — client id + access token.
2. In **Settings → Dhan**, enter the keys, tick **Enable live orders**, and set the
   account mode to **LIVE**.
3. To practise first (recommended): tick **Dhan sandbox (test)** and use keys from
   the Dhan sandbox portal — orders then go to `api-sandbox.dhan.co` and fills are
   **simulated**, so no real money moves. The option chain keeps using the free
   NSE feed while sandbox is on.
4. Live orders still have to pass the risk guardrails (per-trade %, daily loss,
   drawdown) and are blocked while the kill switch is on.

---

## Public-deployment security checklist

- [ ] `ADMIN_PASSWORD` is strong and set as a **secret**, not in the repo.
- [ ] `ALLOW_SIGNUP=off` unless you actually want strangers to register.
- [ ] Served over HTTPS (the session cookie then becomes `Secure`).
- [ ] `owner.json`, `.env`, `data/` stay out of git (already in `.gitignore`).
- [ ] Live trading stays **off** (default). It requires your own Dhan keys plus an
      explicit in-app confirmation.

## Verify a deployment

```bash
curl https://<your-host>/healthz          # → ok
curl https://<your-host>/api/health       # → provider + market status (JSON)
```

Then open `/app/`, sign in as the owner, and confirm the data-quality chip reads a
real source (`Yahoo Finance`, labelled `DELAYED`/`CLOSED` as appropriate).
