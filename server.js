// StockArtha server — Express. Zero-cost stack: node:sqlite + free public market data.
const fs = require('fs');
const path = require('path');
const express = require('express');
const auth = require('./src/auth');
const config = require('./config');
const publicRoutes = require('./src/routes/public');
const accountRoutes = require('./src/routes/account');

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
if (admin) console.log('[StockArtha] owner account ready:', admin.username);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', true);

// ── API ────────────────────────────────────────────────────────────────
app.use('/api', publicRoutes.router);
app.use('/api', accountRoutes.router);

// ── Marketing landing page (public/) ───────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

// ── Pine Script download (the TradingView deliverable) ─────────────────
app.get('/smc-strategy.pine', (_req, res) => {
  res.type('text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="stockartha-smc-strategy.pine"');
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
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '6h' }));

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
  console.log(`[StockArtha] server ready`);
  console.log(`  Web app      : http://localhost:${config.port}/app`);
  console.log(`  Landing page : http://localhost:${config.port}/`);
  console.log(`  API base     : http://localhost:${config.port}/api`);
  console.log(`  Market       : ${m.state} (${m.istTime})`);
});
