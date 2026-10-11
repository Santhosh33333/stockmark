/* Live end-to-end test: API, universe, market data, strategy engine, accounts, paper trading. */
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 5124;
const BASE = process.env.TRADEMIND_BASE || `http://127.0.0.1:${PORT}`;
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
  if (!process.env.TRADEMIND_BASE) {
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

    const bt = await call('GET', '/api/backtest/RELIANCE?costs=1&train=0.7');
    check('Backtest cost model + train split (API)',
      bt.status === 200 && bt.body.stats?.costsApplied === true && typeof bt.body.stats?.totalCostsPct === 'number' && bt.body.params?.costs === true,
      `costs ${bt.body.stats?.totalCostsPct}% · trades ${bt.body.stats?.trades} · split ${bt.body.stats?.inSample ? 'yes' : 'no'} · net ${bt.body.stats?.netProfitPct}%`);
    check('4H RSI series for chart', Array.isArray(a.body.rsi4hSeries) && a.body.rsi4hSeries.length > 10,
      `${a.body.rsi4hSeries?.length} 4H bars`);
    check('Structure + FVG + liquidity layers',
      a.body.structure && Array.isArray(a.body.fvgs) && a.body.liquidity && typeof a.body.confluence?.score === 'number',
      `${a.body.structure?.trend} trend · ${a.body.fvgs?.length} FVG · ${a.body.liquidity?.buyside?.length + a.body.liquidity?.sellside?.length} pools · score ${a.body.confluence?.score}`);
    check('Multi-timeframe alignment',
      a.body.mtf && Array.isArray(a.body.mtf.timeframes) && a.body.mtf.timeframes.length >= 2 && typeof a.body.mtf.score === 'number',
      `${a.body.mtf?.timeframes?.map((t) => t.tf + ':' + t.bias).join(' ')} · ${a.body.mtf?.alignment} ${a.body.mtf?.score}`);

    // ── new SMC context layers + data-quality + research ──
    check('SMC context layers (premium/discount, VWAP, swing, displacement, equal H/L)',
      !!a.body.premiumDiscount && !!a.body.vwap && !!a.body.swingStructure && !!a.body.displacement && Array.isArray(a.body.equalHighs),
      `${a.body.premiumDiscount?.zone} · VWAP ₹${a.body.vwap?.session} · ${a.body.swingStructure?.bias} · disp ${a.body.displacement?.count} · EH ${a.body.equalHighs?.length}`);
    check('Data-quality label present', !!a.body.quality && !!a.body.quality.status,
      `${a.body.quality?.status} · ${a.body.quality?.source} · ${a.body.quality?.note}`);

    const res = await call('GET', '/api/research/RELIANCE');
    check('Research assistant (deterministic evidence)',
      res.status === 200 && res.body.ok === true && Array.isArray(res.body.bullEvidence) && Array.isArray(res.body.bearEvidence) && res.body.probability?.calibrated === false,
      `bull ${res.body.bullEvidence?.length} · bear ${res.body.bearEvidence?.length} · stance "${res.body.stance}" · R:R ${res.body.levels?.referenceRiskReward}`);

    const metrics = await call('GET', '/api/metrics');
    check('Operational metrics endpoint',
      metrics.status === 200 && typeof metrics.body.http?.http?.requests === 'number' && !!metrics.body.providers,
      `reqs ${metrics.body.http?.http?.requests} · retries ${metrics.body.http?.http?.retries} · uptime ${metrics.body.uptimeSec}s`);

    const email = `test.user${Date.now()}@example.com`;
    const signup = await call('POST', '/api/auth/signup', { email, password: 'test1234', displayName: 'Test User' });
    check('Sign up + OTP sent', signup.status === 200 && signup.body.requiresVerification === true,
      signup.body.message || signup.body.error);
    const otpCode = signup.body.dev;
    let verify;
    if (otpCode) {
      check('OTP generated', true, `code ${otpCode} (dev mode)`);
      verify = await call('POST', '/api/auth/verify-otp', { email, code: otpCode });
      check('Email verified', verify.status === 200 && !!verify.body.token, verify.body.error || 'session issued');
    } else {
      check('OTP generated', true, 'real email sent via Brevo (no dev code)');
      // real email mode — verify via DB directly for test
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('./data/app.db');
      const row = db.prepare('SELECT code FROM email_otps WHERE email = ? AND purpose = ? AND consumed = 0 ORDER BY id DESC LIMIT 1').get(email, 'signup');
      check('OTP in database', !!row, row ? `code ${row.code}` : 'not found');
      verify = await call('POST', '/api/auth/verify-otp', { email, code: row.code });
      check('Email verified', verify.status === 200 && !!verify.body.token, verify.body.error || 'session issued');
    }
    const token = verify.body.token;
    const authHeaders = { Authorization: 'Bearer ' + token };

    const login = await call('POST', '/api/auth/login', { email, password: 'test1234' });
    check('Sign in requests OTP', login.status === 200 && login.body.requiresOtp === true, login.body.message || login.body.error);
    if (login.body.dev) {
      const login2 = await call('POST', '/api/auth/verify-login-otp', { email, code: login.body.dev });
      check('Sign in with OTP', login2.status === 200 && !!login2.body.token, login2.body.error);
    } else {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('./data/app.db');
      const row = db.prepare('SELECT code FROM email_otps WHERE email = ? AND purpose = ? AND consumed = 0 ORDER BY id DESC LIMIT 1').get(email, 'login');
      const login2 = await call('POST', '/api/auth/verify-login-otp', { email, code: row.code });
      check('Sign in with OTP', login2.status === 200 && !!login2.body.token, login2.body.error);
    }

    const me = await call('GET', '/api/me', null, authHeaders);
    check('Session works', me.status === 200 && me.body.user?.username === email, `mode ${me.body.user?.settings?.mode}`);

    // watchlist + settings
    await call('POST', '/api/watchlist', { symbol: 'INFY' }, authHeaders);
    const wl = await call('GET', '/api/watchlist', null, authHeaders);
    check('Watchlist with live price', wl.status === 200 && wl.body.watchlist?.length === 1 && typeof wl.body.watchlist?.[0]?.price === 'number',
      `INFY ₹${wl.body.watchlist?.[0]?.price}`);

    const set = await call('PUT', '/api/me/settings', { capital: 250000, slPct: 4, tpPct: 12 }, authHeaders);
    check('Settings saved', set.status === 200 && set.body.settings?.capital === 250000);

    // ── risk management: state + kill switch guard ──
    const riskState = await call('GET', '/api/risk/state', null, authHeaders);
    check('Risk state endpoint',
      riskState.status === 200 && riskState.body.limits && typeof riskState.body.usage?.dayPnl === 'number',
      `risk ${riskState.body.limits?.maxRiskPerTradePct}% · dailyLoss ${riskState.body.limits?.maxDailyLossPct}% · dd ${riskState.body.limits?.maxDrawdownPct}%`);
    const killOn = await call('POST', '/api/risk/kill', { on: true }, authHeaders);
    check('Kill switch ON', killOn.status === 200 && killOn.body.killSwitch === true);
    const blocked = await call('POST', '/api/paper/open', { symbol: 'INFY', price: 1500, name: 'Infosys' }, authHeaders);
    check('Kill switch blocks new positions', blocked.status === 400 && /kill switch/i.test(blocked.body.error || ''),
      blocked.body.error);
    const killOff = await call('POST', '/api/risk/kill', { on: false }, authHeaders);
    check('Kill switch OFF', killOff.status === 200 && killOff.body.killSwitch === false);

    // ── options strategy builder (deterministic payoff maths) ──
    const payoff = await call('POST', '/api/options/strategy/payoff',
      { legs: [{ type: 'CE', strike: 25000, qty: 1, premium: 150 }], underlying: 24900, lotSize: 75 }, authHeaders);
    check('Options payoff builder',
      payoff.status === 200 && payoff.body.ok === true && payoff.body.maxLoss === -11250 && payoff.body.maxProfit === 'unlimited' && payoff.body.breakevens?.length >= 1,
      `maxLoss ₹${payoff.body.maxLoss} · maxProfit ${payoff.body.maxProfit} · BE ${payoff.body.breakevens?.join(',')}`);

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

    // paper history CSV export
    const csv = await call('GET', '/api/paper/export.csv', null, authHeaders);
    check('Paper history CSV export', csv.status === 200 && typeof csv.body === 'string' && csv.body.startsWith('id,symbol,name'),
      `${String(csv.body).split('\n').length - 1} data rows`);

    // live quote stream (SSE) — read the first frame then disconnect
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12000);
      const sres = await fetch(`${BASE}/api/stream/quotes?symbols=^NSEI`, { signal: ctrl.signal });
      const reader = sres.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (buf.length < 40) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      clearTimeout(to);
      try { await reader.cancel(); } catch { }
      check('Live quote stream (SSE)', sres.status === 200 && /retry:|event:/.test(buf), buf.replace(/\n/g, ' ').slice(0, 60));
    } catch (e) {
      check('Live quote stream (SSE)', false, e.message);
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

    // ── option chain (real NSE data; Dhan when the user has a key) ──
    const oc = await call('GET', '/api/options/NIFTY', null, authHeaders);
    const ocOk = oc.status === 200 && oc.body.ok === true && Array.isArray(oc.body.strikes) && oc.body.strikes.length > 5
      && ['NSE', 'Dhan'].includes(oc.body.source) && typeof oc.body.pcr === 'number';
    check('Option chain (live NSE/Dhan)',
      ocOk,
      oc.status === 200
        ? `${oc.body.source} · ${oc.body.symbol} ${oc.body.expiry} · ${oc.body.strikes?.length} strikes · PCR ${oc.body.pcr} · und ₹${oc.body.underlyingValue}`
        : (oc.body.error || `status ${oc.status}`));

    // Enriched analytics (greeks, max pain, IV) — tolerate upstream being blocked.
    const ocA = await call('GET', '/api/options/NIFTY/analytics', null, authHeaders);
    const ocAOk = ocA.status === 200 && ocA.body.ok === true && ocA.body.greeks && ocA.body.maxPain && ocA.body.ivRank
      && typeof ocA.body.maxPain.strike === 'number' && typeof ocA.body.greeks.available === 'boolean'
      && Array.isArray(ocA.body.strikes) && typeof ocA.body.ivRank.available === 'boolean';
    if (oc.status === 200) {
      check('Option analytics (greeks + max pain + IV)',
        ocAOk,
        ocAOk
          ? `ATM IV ${ocA.body.atmIV} · maxPain ${ocA.body.maxPain?.strike} · delta ${ocA.body.strikes?.find?.((s) => s.strike === ocA.body.atm)?.ce?.greeks?.delta} · IVrank avail ${ocA.body.ivRank?.available}`
          : (ocA.body.error || `status ${ocA.status}`));
    } else {
      check('Option analytics endpoint reachable', ocA.status === 200 || ocA.status === 502, `chain blocked upstream (${oc.status}) → analytics ${ocA.status}`);
    }

    // ── user profile (editable display name) ──
    const prof = await call('PATCH', '/api/me', { displayName: 'Selftest User' }, authHeaders);
    check('Update profile (display name)', prof.status === 200 && prof.body.user?.displayName === 'Selftest User',
      prof.body.user?.displayName || 'no change');

    // ── admin gating (test user is NOT admin yet) ──
    const nonguard = await call('GET', '/api/admin/overview', null, authHeaders);
    check('Admin guard (non-admin → 403)', nonguard.status === 403, `status ${nonguard.status}`);

    // ── owner / admin console (temporarily promote the test user) ──
    {
      const { DatabaseSync } = require('node:sqlite');
      const adb = new DatabaseSync('./data/app.db');
      const meRow = adb.prepare('SELECT id, is_admin FROM users WHERE username = ?').get(email);
      adb.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(meRow.id);
      try {
        const overview = await call('GET', '/api/admin/overview', null, authHeaders);
        check('Admin overview', overview.status === 200 && typeof overview.body.users?.total === 'number',
          `users ${overview.body.users?.total} · admins ${overview.body.users?.admins} · sessions ${overview.body.sessions} · mem ${overview.body.server?.memoryMB}MB`);
        const au = await call('GET', '/api/admin/users', null, authHeaders);
        check('Admin users list', au.status === 200 && Array.isArray(au.body.users) && au.body.users.length >= 1,
          `${au.body.total} accounts`);
        const alogs = await call('GET', '/api/admin/logs?limit=5', null, authHeaders);
        check('Admin audit log', alogs.status === 200 && Array.isArray(alogs.body.logs));
        const ajobs = await call('GET', '/api/admin/jobs', null, authHeaders);
        check('Admin scan jobs', ajobs.status === 200 && Array.isArray(ajobs.body.jobs));
        const ahealth = await call('GET', '/api/admin/health', null, authHeaders);
        check('Admin health probe', ahealth.status === 200 && !!ahealth.body.provider,
          `${ahealth.body.provider?.name} ${ahealth.body.provider?.ok ? 'ok' : 'down'} · ${ahealth.body.provider?.latencyMs}ms`);
        const atrades = await call('GET', '/api/admin/trades?limit=5', null, authHeaders);
        check('Admin trades view', atrades.status === 200 && Array.isArray(atrades.body.trades));
        const asig = await call('GET', '/api/admin/signals?limit=5', null, authHeaders);
        check('Admin signals view', asig.status === 200 && Array.isArray(asig.body.signals));
      } finally {
        adb.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(meRow.is_admin, meRow.id);
      }
      const guard = await call('GET', '/api/admin/overview');
      check('Admin guard (anonymous → 403)', guard.status === 403);
    }

    const mail = await call('GET', '/api/mail/status');
    check('Email OTP sender status', mail.status === 200 && mail.body.mail?.provider,
      `${mail.body.mail?.mode} · TTL ${mail.body.otpTtl}min`);

    const landing = await fetch(BASE + '/');
    check('Landing page', landing.status === 200 && (await landing.text()).includes('TradeMind'));
    const appHtml = await fetch(BASE + '/app/');
    check('App shell', appHtml.status === 200 && (await appHtml.text()).includes('TradeMind'));
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
