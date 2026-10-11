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
   `ADMIN_EMAIL`, `ADMIN_PASSWORD`. `render.yaml` already sets `NODE_VERSION=24.18.0`
   and `ALLOW_SIGNUP=on` — flip it to `off` there if you want the app to be
   owner-only.

**Free-tier reality:** the free plan sleeps after ~15 min idle (first request then
takes a few seconds) and its disk is **not persistent**, so the SQLite DB resets
on every deploy/restart. Use this to show the app publicly, not to keep accounts.

**Optional — make “Forgot password?” actually send (free).** Create a free
[Brevo](https://brevo.com) account (300 emails/day), verify a sender, then add these
in the Render dashboard (**Environment → Secret**):

```
MAIL_PROVIDER = brevo
BREVO_API_KEY = <your Brevo API key>
MAIL_FROM     = <a sender you verified in Brevo>
```

**Use env vars — not the in-app Settings → Email.** The free plan's disk is
ephemeral, so an in-app mail config is wiped on the next restart. With the env vars
set, the sign-in screen's **Forgot password?** link will email a real reset code.
(Prefer Gmail? Set `MAIL_PROVIDER=gmail`, `SMTP_USER=<you@gmail.com>`,
`SMTP_PASS=<16-char app password>` instead.)

**Optional — no cold starts.** `.github/workflows/keepalive.yml` pings `/healthz`
every 10 minutes from GitHub Actions so the free service stays warm. It uses ~720 of
the 750 free instance-hours/month; delete the file if you'd rather let it sleep.

Also worth setting: `SESSION_SECRET` — a fixed session-signing key so signing everyone
out only happens when you want it to (e.g. after rotating `ADMIN_PASSWORD`).

**Forgot the owner password?** Change `ADMIN_PASSWORD` in the dashboard and redeploy
(the owner is re-seeded). You can also reset any *other* user from **Admin → Users**.

---

## 3. Fly.io — Docker + a real volume (persistent)

```bash
fly launch --no-deploy          # uses the included Dockerfile + fly.toml
fly volumes create trademind_data --size 1 --region sin
fly secrets set ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me ALLOW_SIGNUP=off
fly deploy
```

`fly.toml` mounts the volume at `/data` and sets `DATA_DIR=/data`, so the DB
survives. **Fly has no free tier any more** (removed Oct 2024) — new accounts are
pay-as-you-go, roughly $2–5/month for a tiny machine. Use it if you want a managed
volume without running a VM; for genuinely free persistence use option 4.

---

## 4. Oracle Cloud **Always Free** VM — free + persistent ⭐ best free host

The only free option here that keeps your data **and** stays always-on (Render's
free tier sleeps after idle and wipes the disk on restart). The VM needs a card for
identity verification but is free with no time limit; the ARM Always-Free allowance
is **2 OCPU / 12 GB RAM**, far more than this app needs.

`docker-compose.yml` runs the app **and** Caddy (automatic HTTPS) together, so this
is a genuine one-command deploy.

**Create the VM (once, ~10 min):**
1. Sign up at **cloud.oracle.com** → **Create instance**.
2. Image **Ubuntu 24.04** · Shape **VM.Standard.A1.Flex** (ARM) · **2 OCPU / 12 GB**.
   If ARM shows "out of capacity", retry later or use another region.
3. Download the SSH key, create the instance, note its **public IP**.
4. **VCN → Security Lists → Default** → add ingress rules for TCP **80** and **443**.

**Install & run (SSH into the VM):**

```bash
# 1) open the OS firewall (Oracle images ship with iptables rules that block it)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
sudo netfilter-persistent save

# 2) Docker + Compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# 3) get the app and configure
git clone https://github.com/Santhosh33333/stockmark.git && cd stockmark
cp .env.deploy.example .env
nano .env        # set ADMIN_EMAIL, ADMIN_PASSWORD, SITE_ADDRESS=<public-ip>.sslip.io

# 4) build and start (app + free HTTPS)
docker compose up -d --build
```

Open **`https://<your-public-ip>.sslip.io/app/`** — Caddy gets a free Let's Encrypt
certificate automatically (no domain needed), so the session cookie is `Secure`.
Data persists in `./data` on the boot volume and survives restarts and rebuilds.

Update later with `git pull && docker compose up -d --build`.

Prefer not to expose the VM? Delete the `caddy` service from
`docker-compose.yml`, keep only `app`, and reach port 5124 with option 1's tunnel.

---

## 5. Any Docker host / VPS

The included `docker-compose.yml` is the quickest route (app + free HTTPS):

```bash
cp .env.deploy.example .env      # set the secrets + SITE_ADDRESS
docker compose up -d --build
```

Or by hand:

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
| `SESSION_SECRET` | derived from `ADMIN_PASSWORD` | Signs session tokens. Set a fixed value so sessions survive an `ADMIN_PASSWORD` change. |
| `MAIL_PROVIDER` | auto-detected | `brevo` \| `smtp` \| `gmail` — enables OTP / password-reset email. |
| `BREVO_API_KEY` | — | Free Brevo key (300 emails/day); also auto-selects the `brevo` provider. |
| `MAIL_FROM` / `MAIL_FROM_NAME` | `no-reply@trademind.app` / `TradeMind` | Sender identity for outgoing mail. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | — | Generic SMTP, or Gmail with an app password. |
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
- [ ] Only ports 80/443 are open on the host; the app's 5124 stays internal.
- [ ] Live trading stays **off** (default). It requires your own Dhan keys plus an
      explicit in-app confirmation.

## Verify a deployment

```bash
curl https://<your-host>/healthz          # → ok
curl https://<your-host>/api/health       # → provider + market status (JSON)
```

Then open `/app/`, sign in as the owner, and confirm the data-quality chip reads a
real source (`Yahoo Finance`, labelled `DELAYED`/`CLOSED` as appropriate).
