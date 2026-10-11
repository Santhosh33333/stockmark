// TradeMind server — Express. Zero-cost stack: node:sqlite + free public market data.
const fs = require('fs');
const path = require('path');
const express = require('express');
const auth = require('./src/auth');
const config = require('./config');
const publicRoutes = require('./src/routes/public');
const accountRoutes = require('./src/routes/account');
const labRoutes = require('./src/routes/lab');

// Owner credentials live ONLY in the local private file owner.json (never exposed by any API)
const ownerFile = path.join(__dirname, 'owner.json');
if (fs.existsSync(ownerFile)) {
  try {
    const o = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    process.env.ADMIN_EMAIL = o.email;
    process.env.ADMIN_PASSWORD = o.password;
  } catch { }
}
const admin = auth.seedAdmin();
if (admin) console.log('[TradeMind] owner account ready:', admin.username);

// Optional: keep a fixed set of accounts alive across restarts. Free hosts often
// have an ephemeral disk that is wiped on redeploy, which deletes normal sign-ups;
// seeding from SEED_USERS re-creates them on every boot so their logins always work.
// Format:  SEED_USERS="alice@x.com:secret1,bob@x.com:secret2"
// Idempotent — existing accounts (and their data) are left untouched.
(function seedExtraUsers() {
  const raw = String(process.env.SEED_USERS || '').trim();
  if (!raw) return;
  for (const pair of raw.split(',')) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    const email = pair.slice(0, i).trim().toLowerCase();
    const password = pair.slice(i + 1).trim();
    if (!email || password.length < 6) continue;
    try {
      const u = auth.createUser({ username: email, password, displayName: email.split('@')[0] });
      console.log('[TradeMind] seeded user:', u.username);
    } catch { /* already exists — leave as-is */ }
  }
})();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', true);

// Zero-dependency gzip for text/JSON responses (skips SSE, ranges, HEAD).
app.use(require('./src/compress')());

// Free price alerts: a gentle background poller lets armed rules fire even when
// no browser tab is open. 0 disables it; only runs when alerts exist.
const priceAlerts = require('./src/priceAlerts');
const alertPollMs = Number(process.env.ALERT_POLL_MS == null ? 60000 : process.env.ALERT_POLL_MS);
if (alertPollMs > 0) priceAlerts.start(alertPollMs);

// ── API ────────────────────────────────────────────────────────────────
app.use('/api', publicRoutes.router);
app.use('/api', accountRoutes.router);
app.use('/api', labRoutes.router);

// ── Marketing landing page (public/) ───────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

// ── NIFTY 50 live 3D page ──────────────────────────────────────────────
app.get('/nifty', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'nifty.html')));

// ── 3D animated brand mark ─────────────────────────────────────────────
app.get('/logo3d', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'logo3d.html')));

// ── Brand logo: serve the generated PNG when present, else the SVG mark ──
// Avoids a 404 (and a broken-image flash) before the PNG is dropped in.
app.get('/assets/trademind-logo.png', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  const png = path.join(__dirname, 'public', 'assets', 'trademind-logo.png');
  if (fs.existsSync(png)) return res.sendFile(png);
  res.type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'logo.svg'));
});

// ── Static content pages (docs / legal) ────────────────────────────────
app.get('/docs', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// ── Pine Script download (the TradingView deliverable) ─────────────────
app.get('/smc-strategy.pine', (_req, res) => {
  res.type('text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="trademind-smc-strategy.pine"');
  res.sendFile(path.join(__dirname, 'pine', 'smc_wick_ob_inducement.pine'));
});

// ── The app itself (/app/) — opens straight to the dashboard, no marketing ──
app.use('/app', express.static(path.join(__dirname, 'public', 'app'), {
  setHeaders(res, p) {
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    if (p.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Root-level brand assets for the landing page / favicons
// (HTML/CSS/JS revalidate so UI updates are never served stale; images stay cached)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '6h',
  setHeaders(res, p) {
    if (/\.(html|css|js)$/i.test(p)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Health probe for hosting platforms
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// SPA fallback inside /app (hash routing used, so rarely hit)
app.use('/app/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Server error' });
});

app.listen(config.port, config.host, () => {
  const { marketStatus } = require('./src/util');
  const m = marketStatus();
  console.log(`[TradeMind] server ready`);
  console.log(`  Web app      : http://localhost:${config.port}/app`);
  console.log(`  Landing page : http://localhost:${config.port}/`);
  console.log(`  API base     : http://localhost:${config.port}/api`);
  console.log(`  Market       : ${m.state} (${m.istTime})`);
});
