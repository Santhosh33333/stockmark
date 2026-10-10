/* Live end-to-end test: API, universe, market data, strategy engine, accounts, paper trading. */
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 5124;
const BASE = process.env.STOCKARTHA_BASE || `http://127.0.0.1:${PORT}`;
let server = null;

async function call(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
  return { status: res.status, body: json };
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  if (!process.env.STOCKARTHA_BASE) {
    console.log(`Starting server on :${PORT} for tests…`);
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit',
    });
    await new Promise((r) => setTimeout(r, 2500));
  }

  try {
    const health = await call('GET', '/api/health');
    check('API health', health.status === 200 && health.body.ok === true);

    const universe = await call('GET', '/api/universe');
    check('Universe masters loaded',
      universe.status === 200 && universe.body.counts?.nse > 1500,
      `NSE ${universe.body.counts?.nse} · BSE ${universe.body.counts?.bse} · F&O ${universe.body.counts?.fno}`);

    const market = await call('GET', '/api/market/status');
    check('Live market status', market.status === 200 && market.body.status?.state,
      `${market.body.status?.state} · NIFTY ${market.body.indices?.[0]?.price}`);

    // strategy engine on a real symbol
    const t0 = Date.now();
    const a = await call('GET', '/api/analysis/RELIANCE');
    check('Strategy analysis (live data)', a.status === 200 && a.body.ok === true,
      `price ₹${a.body.price} · 4H RSI ${a.body.rsi4h} · zones ${a.body.zones?.length} · signals ${a.body.signals?.length} · ${Date.now() - t0}ms`);
    check('Backtest stats computed', a.body.stats && a.body.stats.trades >= 0,
      `winRate ${a.body.stats?.winRate}% · PF ${a.body.stats?.profitFactor} · DD ${a.body.stats?.maxDrawdownPct}%`);
    check('4H RSI series for chart', Array.isArray(a.body.rsi4hSeries) && a.body.rsi4hSeries.length > 10,
      `${a.body.rsi4hSeries?.length} 4H bars`);

    // account flow (email OTP)
    const email = `test.user${Date.now()}@example.com`;
    const signup = await call('POST', '/api/auth/signup', { email, password: 'test1234', displayName: 'Test User' });
    check('Sign up + OTP sent', signup.status === 200 && signup.body.requiresVerification === true,
      signup.body.message || signup.body.error);
    const otpCode = signup.body.dev;
    check('OTP generated', !!otpCode, `code ${otpCode} (dev mode: no email service connected yet)`);
    const verify = await call('POST', '/api/auth/verify-otp', { email, code: otpCode });
    check('Email verified', verify.status === 200 && !!verify.body.token, verify.body.error || 'session issued');
    const token = verify.body.token;
    const authHeaders = { Authorization: 'Bearer ' + token };

    const login = await call('POST', '/api/auth/login', { email, password: 'test1234' });
    check('Sign in requests OTP', login.status === 200 && login.body.requiresOtp === true, login.body.message || login.body.error);
    const login2 = await call('POST', '/api/auth/verify-login-otp', { email, code: login.body.dev });
    check('Sign in with OTP', login2.status === 200 && !!login2.body.token, login2.body.error);

    const me = await call('GET', '/api/me', null, authHeaders);
    check('Session works', me.status === 200 && me.body.user?.username === email, `mode ${me.body.user?.settings?.mode}`);

    // watchlist + settings
    await call('POST', '/api/watchlist', { symbol: 'INFY' }, authHeaders);
    const wl = await call('GET', '/api/watchlist', null, authHeaders);
    check('Watchlist with live price', wl.status === 200 && wl.body.watchlist?.length === 1,
      `INFY ₹${wl.body.watchlist?.[0]?.price}`);

    const set = await call('PUT', '/api/me/settings', { capital: 250000, slPct: 4, tpPct: 12 }, authHeaders);
    check('Settings saved', set.status === 200 && set.body.settings?.capital === 250000);

    // paper trading
    const open = await call('POST', '/api/paper/open', { symbol: 'SBIN', price: 820, name: 'State Bank of India' }, authHeaders);
    check('Paper position opened', open.status === 200 && open.body.trade?.status === 'OPEN',
      `${open.body.trade?.symbol} ×${open.body.trade?.qty}`);
    const paper = await call('GET', '/api/paper/stats', null, authHeaders);
    check('Paper portfolio', paper.status === 200 && paper.body.positions?.length === 1,
      `net ${paper.body.stats?.netPnlFmt}`);
    const ev = await call('POST', '/api/paper/evaluate', {}, authHeaders);
    check('Live SL/TP evaluation', ev.status === 200, `${ev.body.closed?.length || 0} exited`);
    let stillOpen = open.body.trade?.id;
    if (ev.body.closed?.length) stillOpen = null;
    if (stillOpen) {
      const close = await call('POST', '/api/paper/close', { id: stillOpen, price: 835 }, authHeaders);
      check('Manual exit', close.status === 200 && close.body.trade?.status === 'CLOSED', `P&L ${close.body.trade?.pnl}`);
    } else {
      const after = await call('GET', '/api/paper/stats', null, authHeaders);
      check('Position closed by live SL/TP', after.status === 200 && after.body.positions?.length === 0,
        `net ${after.body.stats?.netPnlFmt} · ${after.body.stats?.closedCount} closed`);
    }

    // scanner (indices preset = 8 symbols, fast & live)
    const scan = await call('POST', '/api/scan/start', { preset: 'indices', useCache: false });
    check('Scan started', scan.status === 200 && !!scan.body.jobId, `${scan.body.total} symbols`);
    let done = false, attempts = 0;
    while (!done && attempts++ < 60) {
      await new Promise((r) => setTimeout(r, 3000));
      const latest = await call('GET', '/api/scan/latest?limit=5');
      const rows = latest.body.rows || [];
      done = rows.some((r) => r.symbol === '^NSEI' && r.scannedAt > Date.now() - 120000);
      if (attempts % 5 === 0) console.log(`   …scan progress (${attempts * 3}s)`);
    }
    const latest = await call('GET', '/api/scan/latest?limit=10');
    check('Scanner results live', latest.status === 200 && latest.body.total > 0,
      `${latest.body.total} rows cached`);
    const nifty = (latest.body.rows || []).find((r) => r.symbol === '^NSEI');
    check('Index row analysed', !!nifty, nifty ? `NIFTY ₹${nifty.price} · 4H RSI ${nifty.rsi4h}` : 'not found');

    const signals = await call('GET', '/api/signals/latest?limit=5');
    check('Signal feed', signals.status === 200 && Array.isArray(signals.body.signals));

    const alerts = await call('GET', '/api/alerts/history?limit=5', null, authHeaders);
    check('Alert history', alerts.status === 200 && Array.isArray(alerts.body.alerts));

    const dhan = await call('POST', '/api/dhan/test', {}, authHeaders);
    check('Dhan guard (no token → clean refusal)', dhan.status === 200 && dhan.body.ok === false, dhan.body.error || '');

    const mail = await call('GET', '/api/mail/status');
    check('Email OTP sender status', mail.status === 200 && mail.body.mail?.provider,
      `${mail.body.mail?.mode} · TTL ${mail.body.otpTtl}min`);

    const landing = await fetch(BASE + '/');
    check('Landing page', landing.status === 200 && (await landing.text()).includes('StockArtha'));
    const appHtml = await fetch(BASE + '/app/');
    check('App shell', appHtml.status === 200 && (await appHtml.text()).includes('StockArtha'));
    const manifest = await fetch(BASE + '/app/manifest.webmanifest');
    check('PWA manifest', manifest.status === 200);
    const icon = await fetch(BASE + '/icons/icon-512.png');
    check('Play Store icon', icon.status === 200 && (await icon.arrayBuffer()).byteLength > 3000);
  } catch (err) {
    check('Unhandled error during tests', false, err.message);
  } finally {
    if (server) server.kill();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(', ')); process.exit(1); }
  console.log('ALL LIVE CHECKS PASSED ✅');
}

main();
