/* TradeMind — SPA app logic */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const inr = (v, d) => (v == null || !isFinite(v)) ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? 0 });
  const inrC = (v) => { if (v == null || !isFinite(v)) return '—'; const a = Math.abs(v); return (v < 0 ? '-₹' : '₹') + (a >= 1e7 ? (a / 1e7).toFixed(2) + ' Cr' : a >= 1e5 ? (a / 1e5).toFixed(2) + ' L' : a.toLocaleString('en-IN', { maximumFractionDigits: 0 })); };
  const pct = (v) => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  const dt = (t) => t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const dtDate = (t) => t ? new Date(t).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    token: localStorage.getItem('sa_token') || null,
    user: null, route: 'dashboard', market: null,
    scanRows: [], scanJob: null, scanPreset: 'fno', scanOpts: {},
    scanTimer: null, es: null, alerts: [], universe: null, watchlist: [],
    symbols: [], selected: null, detail: null, chart: null, paper: null, alertCount: 0,
    options: { symbol: 'NIFTY', expiry: null, data: null, loading: false, error: null, source: null },
    backtest: { symbol: 'RELIANCE', preset: 'improved', slPct: 1.5, tpPct: 3, maxBars: 25, data: null, loading: false, error: null },
  };

  /* ── API ── */
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    return j;
  }

  function toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind; t.textContent = msg;
    $('#toast-wrap').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2600);
  }

  /* ── AUTH (email + OTP) ── */
  let authMode = 'login';
  let otpCtx = { email: null, purpose: 'signup', dev: null };

  function otpValue() { return $$('#otp-inputs input').map((i) => i.value).join(''); }
  function showOtpStep(email, purpose, devCode, message) {
    otpCtx = { email, purpose, dev: devCode || null };
    $('#auth-form').classList.add('hidden');
    $('#otp-form').classList.remove('hidden');
    $('#otp-info').textContent = message || `Enter the 6-digit code sent to ${email}`;
    const dev = $('#otp-dev');
    if (devCode) { dev.classList.remove('hidden'); dev.innerHTML = `<b>No email service connected.</b><br>Use this code: <span class="otp-code">${devCode}</span><br><small>Owner: connect a free sender in Settings → Email OTP</small>`; }
    else dev.classList.add('hidden');
    $$('#otp-inputs input').forEach((i, idx, all) => {
      i.value = '';
      i.oninput = () => { if (i.value && idx < 5) all[idx + 1].focus(); };
      i.onkeydown = (e) => { if (e.key === 'Backspace' && !i.value && idx > 0) all[idx - 1].focus(); };
    });
    setTimeout(() => $('#otp-inputs input')?.focus(), 120);
  }
  function hideOtpStep() {
    $('#auth-form').classList.remove('hidden');
    $('#otp-form').classList.add('hidden');
    $('#otp-error').textContent = '';
  }

  async function resendOtp() {
    try {
      const j = await api('/auth/resend-otp', { method: 'POST', body: { email: otpCtx.email, purpose: otpCtx.purpose } });
      if (j.dev) $('#otp-dev').classList.remove('hidden'), ($('#otp-dev').innerHTML = `Use this code: <span class="otp-code">${j.dev}</span>`);
      toast('Code re-sent', 'ok');
    } catch (e) { $('#otp-error').textContent = e.message; }
  }
  function showAuth(show) {
    $('#auth-screen').classList.toggle('hidden', !show);
    $('#app').classList.toggle('hidden', show);
  }
  function setAuthMode(m) {
    authMode = m;
    $$('.auth-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
    $('#name-field').style.display = m === 'signup' ? 'block' : 'none';
    $('#auth-submit').textContent = m === 'signup' ? 'Create account' : 'Sign in';
    $('#auth-error').textContent = '';
  }
  function bindAuth() {
    $$('.auth-tabs .tab').forEach((b) => (b.onclick = () => { setAuthMode(b.dataset.tab); hideOtpStep(); }));
    $('#auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = $('#auth-submit'); btn.disabled = true;
      $('#auth-error').textContent = '';
      try {
        const j = await api('/auth/' + authMode, {
          method: 'POST',
          body: { email: f.email.value.trim(), username: f.email.value.trim(), password: f.password.value, displayName: f.displayName?.value || '' },
        });
        if (j.token) {
          state.token = j.token; state.user = j.user;
          localStorage.setItem('sa_token', j.token);
          showAuth(false); bootApp();
          toast('Welcome, ' + (state.user.displayName || 'trader'), 'ok');
        } else if (j.requiresVerification || j.requiresOtp) {
          showOtpStep(j.email, j.requiresOtp ? 'login' : 'signup', j.dev, j.message);
        }
      } catch (err) {
        $('#auth-error').textContent = err.message;
      } finally { btn.disabled = false; }
    };
    $('#otp-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#otp-submit'); btn.disabled = true; $('#otp-error').textContent = '';
      try {
        const endpoint = otpCtx.purpose === 'login' ? '/auth/verify-login-otp' : '/auth/verify-otp';
        const j = await api(endpoint, { method: 'POST', body: { email: otpCtx.email, code: otpValue() } });
        state.token = j.token; state.user = j.user;
        localStorage.setItem('sa_token', j.token);
        showAuth(false); hideOtpStep();
        bootApp();
        toast('Verified — welcome, ' + (state.user.displayName || 'trader'), 'ok');
      } catch (err) { $('#otp-error').textContent = err.message; }
      finally { btn.disabled = false; }
    };
    $('#otp-resend').onclick = resendOtp;
    $('#auth-resend').onclick = resendOtp;
    $('#btn-logout').onclick = async () => {
      try { await api('/auth/logout', { method: 'POST' }); } catch { }
      localStorage.removeItem('sa_token'); state.token = null; state.user = null;
      if (state.es) state.es.close();
      location.reload();
    };
  }

  /* ── ROUTER ── */
  function go(route, param) {
    state.route = route;
    state.detail = route === 'stock' ? param : null;
    $$('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.route === route || (route === 'stock' && b.dataset.route === 'scanner')));
    render();
    window.scrollTo({ top: 0 });
  }
  function bindNav() {
    $$('.navbtn').forEach((b) => (b.onclick = () => go(b.dataset.route)));
    $('#btn-alerts').onclick = () => go('alerts');
    const ba = $('#btn-admin'); if (ba) ba.onclick = () => go('admin');
  }
  function applyAdminNav() {
    const on = !!(state.user && state.user.isAdmin);
    const ba = $('#btn-admin'); if (ba) ba.classList.toggle('hidden', !on);
    const na = $('#nav-admin'); if (na) na.classList.toggle('hidden', !on);
    const nas = $('#nav-admin-side'); if (nas) nas.classList.toggle('hidden', !on);
  }

  /* ── DATA LOADERS ── */
  async function loadMarket() {
    try {
      const j = await api('/market/status');
      state.market = j.status;
      const pill = $('#market-pill');
      pill.className = 'market-pill ' + (j.status.state === 'OPEN' ? 'open' : j.status.state === 'PRE-OPEN' ? 'pre' : '');
      $('#market-text').textContent = j.status.state + ' · ' + j.status.istTime;
      if (j.indices?.length) renderTicker(j.indices);
    } catch { }
  }
  let tickerDup = false;
  function renderTicker(indices) {
    const items = indices.map((i) => `<span class="tick"><b>${esc(i.name)}</b> ${i.price ? inr(i.price) : '—'} <span class="${(i.changePct ?? 0) >= 0 ? 'u' : 'd'}">${pct(i.changePct)}</span></span>`).join('');
    $('#index-ticker').innerHTML = items + (tickerDup ? '' : items);
    tickerDup = true;
  }
  async function loadUniverse() {
    try { state.universe = await api('/universe'); } catch { }
  }
  async function loadLatest() {
    try {
      const j = await api('/scan/latest?limit=400');
      state.scanRows = j.rows;
    } catch { }
  }
  async function loadWatchlist() {
    try { state.watchlist = (await api('/watchlist')).watchlist || []; } catch { }
  }

  /* ── SCANNER (SSE live) ── */
  function connectSSE() {
    if (state.es) state.es.close();
    const es = new EventSource('/api/scan/stream');
    state.es = es;
    es.addEventListener('progress', (e) => {
      const d = JSON.parse(e.data);
      setProgress(d.pct, d.done + '/' + d.total);
    });
    es.addEventListener('done', async (e) => {
      const d = JSON.parse(e.data);
      setProgress(100, d.done + '/' + d.total);
      toast('Scan complete — ' + d.signals + ' fresh signals', 'ok');
      await loadLatest();
      if (state.route === 'scanner') render();
      checkAutoPaper();
    });
  }
  function setProgress(pct, label) {
    const bar = $('#scan-bar'), txt = $('#scan-progress-text');
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = 'Scanning ' + (label || '') + ' · ' + pct + '%';
  }
  async function startScan(preset, useCache = true) {
    try {
      const j = await api('/scan/start', { method: 'POST', body: { preset, opts: state.scanOpts, useCache } });
      setProgress(1, '0/' + j.total);
      toast('Scan started: ' + preset.toUpperCase() + ' (' + j.total + ' symbols)', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function loadSymbols() {
    try {
      const j = await api('/scan/latest?limit=9999');
      state.symbols = j.rows.map((r) => r);
    } catch { }
  }

  /* ── PAPER AUTO MODE ── */
  async function checkAutoPaper() {
    if (!state.user || state.user.settings.mode !== 'PAPER') return;
    try {
      const rows = state.scanRows.filter((r) => r.lastSignal && r.activeZones?.length).slice(0, 3)
        .map((r) => ({ symbol: r.symbol, name: r.name, price: r.price }));
      if (!rows.length) return;
      const j = await api('/paper/auto', { method: 'POST', body: { rows } });
      if (j.opened?.length) toast('Auto paper trade: ' + j.opened.map((t) => t.symbol).join(', '), 'ok');
    } catch { }
  }

  /* ══════════════ VIEWS ══════════════ */
  function stat(k, v, cls = '') { return `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`; }

  function renderDashboard() {
    const s = state.user.settings;
    const sigs = state.scanRows.filter((r) => r.lastSignal);
    const buys = sigs.length;
    const wickRows = state.scanRows.filter((r) => r.wickLast);
    const fnoCount = state.scanRows.filter((r) => r.fno).length;

    return `
    <div class="card" style="margin-top:14px">
      <div class="row between">
        <div><div class="tiny muted">Account mode</div>
          <div style="font-weight:800;font-size:17px;margin-top:2px">${s.mode === 'LIVE' ? '🔴 LIVE (Dhan)' : s.mode === 'SIGNAL' ? '🔔 Signals only' : '📄 Paper trading'}</div></div>
        <div style="text-align:right"><div class="tiny muted">Capital</div><div style="font-weight:800;font-size:17px;margin-top:2px">${inr(s.capital)}</div></div>
      </div>
      <div class="progress"><div class="bar" id="scan-bar" style="width:0%"></div></div>
      <div class="row between">
        <span class="tiny muted" id="scan-progress-text">${state.scanJob ? 'Scanning…' : 'Scanner idle — press Scan below'}</span>
        <button class="btn primary sm" onclick="window.__sa.startScan('${state.scanPreset}')">${state.scanJob ? 'Scanning…' : '▶ Start scan'}</button>
      </div>
    </div>

    <div class="section-title"><h2>Market snapshot</h2><span class="tiny muted">Live · INR</span></div>
    <div class="stats-grid">
      ${stat('Scanner rows', state.scanRows.length, 'a')}
      ${stat('Fresh BUY', buys, 'u')}
      ${stat('Wick now', wickRows.length, 'a')}
      ${stat('F&O covered', fnoCount)}
      ${stat('Auto-scan', s.autoScan ? 'ON' : 'OFF', s.autoScan ? 'u' : '')}
    </div>

    <div class="section-title"><h2>Fresh signals</h2><button class="btn sm" onclick="window.__sa.go('scanner')">View all</button></div>
    ${sigs.length ? sigs.slice(0, 8).map(signalCard).join('') : `<div class="card empty"><div class="big">📡</div>No fresh signals yet.<br>Run a scan to find wick-rejection + order-block setups.</div>`}

    <div class="section-title"><h2>Watchlist</h2><span class="tiny muted">${state.watchlist.length} symbol${state.watchlist.length === 1 ? '' : 's'}</span></div>
    ${state.watchlist.length ? state.watchlist.map(watchCard).join('') : `<div class="card empty"><div class="big">★</div>No symbols yet.<br>Open a stock and tap “★ Watchlist”.</div>`}

    <div class="section-title"><h2>Quick actions</h2></div>
    <div class="card row wrap" style="gap:8px">
      <button class="btn sm" onclick="window.__sa.startScan('fno')">Scan F&amp;O</button>
      <button class="btn sm" onclick="window.__sa.startScan('nse')">Scan all NSE</button>
      <button class="btn sm" onclick="window.__sa.startScan('all')">Scan NSE+BSE</button>
      <button class="btn sm" onclick="window.__sa.go('backtest')">Backtest a symbol</button>
      <button class="btn sm" onclick="window.__sa.go('paper')">Paper trades</button>
    </div>`;
  }

  function signalCard(r) {
    return `<div class="sig" onclick="window.__sa.openStock('${esc(r.symbol)}')">
      <div class="ticker-icon">${esc((r.symbol || '?').slice(0, 4))}</div>
      <div style="min-width:0">
        <div class="nm">${esc(r.symbol)} <span class="pill buy">BUY</span>${r.fno ? '<span class="pill fno">F&O</span>' : ''}</div>
        <div class="sub">${esc(r.name || '')} · 4H RSI ${r.rsi4h ?? '—'} · Vol ${r.volRatio ?? '—'}x</div>
      </div>
      <div class="px"><b>${inr(r.price)}</b><div class="tiny ${(r.changePct ?? 0) >= 0 ? '' : ''}" style="color:${(r.changePct ?? 0) >= 0 ? 'var(--up)' : 'var(--down)'}">${pct(r.changePct)}</div></div>
    </div>`;
  }

  function watchCard(w) {
    return `<div class="sig" onclick="window.__sa.openStock('${esc(w.symbol)}')">
      <div class="ticker-icon">${esc((w.symbol || '?').slice(0, 4))}</div>
      <div style="min-width:0">
        <div class="nm">${esc(w.symbol)} ${w.lastSignal ? '<span class="pill buy">BUY</span>' : ''}</div>
        <div class="sub">4H RSI ${w.rsi4h ?? '—'}${w.activeZones?.length ? ' · ' + w.activeZones.length + ' zone' + (w.activeZones.length === 1 ? '' : 's') : ''}</div>
      </div>
      <div class="px"><b>${inr(w.price)}</b><div class="tiny" style="color:${(w.changePct ?? 0) >= 0 ? 'var(--up)' : 'var(--down)'}">${pct(w.changePct)}</div></div>
      <button class="btn sm" title="Remove from watchlist" onclick="event.stopPropagation();window.__sa.removeWatch('${esc(w.symbol)}')">✕</button>
    </div>`;
  }

  function renderScanner() {
    const s = state.user.settings;
    const rows = state.scanRows;
    const f = state.scanFilter;
    const filtered = rows.filter((r) => {
      if (f.buy && !r.lastSignal) return false;
      if (f.fno && !r.fno) return false;
      if (f.mtf && !(r.mtf && r.mtf.alignment === 'BULL')) return false;
      if (f.exch !== 'ALL' && r.exchange !== f.exch) return false;
      if (f.q) {
        const q = f.q.toLowerCase();
        if (!(r.symbol.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q))) return false;
      }
      return true;
    }).slice(0, 120);
    return `
    <div class="card" style="margin-top:14px">
      <div class="row between wrap" style="gap:8px">
        <b>Scan universe</b>
        <span class="tiny muted">${state.universe ? `NSE ${state.universe.counts.nse} · BSE ${state.universe.counts.bse} · F&O ${state.universe.counts.fno}` : 'loading…'}</span>
      </div>
      <div class="seg" style="margin-top:10px">
        ${[['fno', 'NSE F&O'], ['nse', 'All NSE'], ['nse_bse_fno', 'NSE+F&O+BSE'], ['all', 'Everything'], ['indices', 'Indices']]
      .map(([v, l]) => `<button class="${state.scanPreset === v ? 'active' : ''}" onclick="window.__sa.setPreset('${v}')">${l}</button>`).join('')}
      </div>
      <div class="progress" style="margin-top:12px"><div class="bar" id="scan-bar" style="width:0%"></div></div>
      <div class="row between">
        <span class="tiny muted" id="scan-progress-text">${state.scanJob ? 'Scan running…' : 'Idle'}</span>
        <button class="btn primary sm" id="btn-scan" onclick="window.__sa.startScan(state.scanPreset)">▶ Scan</button>
      </div>
    </div>

    <div class="card">
      <div class="row wrap" style="gap:8px">
        <input placeholder="Search symbol / name" style="flex:1;min-width:150px" value="${esc(f.q)}" oninput="window.__sa.filter({q:this.value})" />
        <select style="width:auto" onchange="window.__sa.filter({exch:this.value})">
          ${['ALL', 'NSE', 'BSE'].map((e) => `<option ${f.exch === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
        <button class="btn sm ${f.buy ? 'green' : ''}" onclick="window.__sa.filter({buy:!f.buy})">BUY only</button>
        <button class="btn sm ${f.fno ? 'gold' : ''}" onclick="window.__sa.filter({fno:!f.fno})">F&amp;O</button>
        <button class="btn sm ${f.mtf ? 'green' : ''}" onclick="window.__sa.filter({mtf:!f.mtf})">MTF ▲ aligned</button>
      </div>
    </div>

    <div class="tbl-wrap"><table>
      <thead><tr><th>Symbol</th><th>Price</th><th>Chg%</th><th>4H RSI</th><th>Vol×</th><th>Signal</th><th>Trend</th><th>Zone</th></tr></thead>
      <tbody>
        ${filtered.length ? filtered.map((r) => `
          <tr onclick="window.__sa.openStock('${esc(r.symbol)}')">
            <td><b>${esc(r.symbol)}</b>${r.fno ? ' <span class="pill fno">F&O</span>' : ''}<div class="tiny muted">${esc((r.name || '').slice(0, 22))}</div></td>
            <td>${inr(r.price, r.price < 1000 ? 2 : 1)}</td>
            <td class="${(r.changePct ?? 0) >= 0 ? 'u' : 'd'}">${pct(r.changePct)}</td>
            <td class="${r.rsi4h != null && r.rsi4h < 50 ? 'a' : ''}">${r.rsi4h ?? '—'}</td>
            <td>${r.volRatio ?? '—'}</td>
            <td>${r.lastSignal ? '<span class="pill buy">BUY</span>' : r.wickLast ? '<span class="pill watch">Wick</span>' : '<span class="pill none">—</span>'}</td>
            <td>${r.trend === 'UP' ? '<span class="u">▲ up</span>' : r.trend === 'DOWN' ? '<span class="d">▼ down</span>' : '<span class="tiny muted">—</span>'}${r.score ? ` <span class="tiny muted">${r.score}%</span>` : ''}${r.mtf && r.mtf.alignment === 'BULL' ? ' <span class="pill buy">MTF▲</span>' : r.mtf && r.mtf.alignment === 'BEAR' ? ' <span class="pill sell">MTF▼</span>' : ''}</td>
            <td class="tiny muted">${r.activeZones?.length ? r.activeZones.length + ' live' : '—'}</td>
          </tr>`).join('') : `<tr><td colspan="8" class="empty">No rows match. Run a scan first.</td></tr>`}
      </tbody>
    </table></div>
    <p class="tiny muted" style="text-align:center;margin:8px 14px 20px">Showing ${filtered.length} of ${rows.length} cached rows · live data ${state.market?.state === 'OPEN' ? 'refreshing every 30s' : 'updates on next scan'}</p>`;
  }

  /* ── STOCK DETAIL ── */
  async function openStock(sym) {
    go('stock', sym);
    state.detailLoading = true; render();
    try {
      const j = await api('/analysis/' + encodeURIComponent(sym));
      state.detailData = j;
      state.detailLoading = false;
      render();
      setTimeout(drawDetail, 30);
    } catch (e) {
      state.detailLoading = false; state.detailError = e.message; render();
    }
  }
  function renderStock() {
    const d = state.detailData, s = state.user.settings;
    if (state.detailLoading) return `<div class="skel" style="height:280px"></div><div class="skel"></div><div class="skel"></div>`;
    if (state.detailError) return `<div class="card empty"><div class="big">⚠️</div>${esc(state.detailError)}</div>`;
    if (!d) return `<div class="card empty">No data</div>`;
    const st = d.stats;
    const tf = state.chartTf || 'D';
    const zones = d.zones.slice().reverse().slice(0, 8);
    return `
    <div class="card" style="margin-top:14px">
      <div class="row between">
        <div><div style="font-weight:800;font-size:19px">${esc(d.symbol)} <span class="pill fno">${esc(d.exchange || 'NSE')}</span></div>
          <div class="tiny muted">${esc(d.name || '')}</div></div>
        <div style="text-align:right"><b style="font-size:19px">${inr(d.price, 2)}</b>
          <div class="tiny" style="color:${d.changePct >= 0 ? 'var(--up)' : 'var(--down)'}">${pct(d.changePct)}</div></div>
      </div>
      <div class="row wrap" style="gap:8px;margin-top:12px">
        <button class="btn sm primary" onclick="window.__sa.paperOpen('${esc(d.symbol)}',${d.price})">📄 Paper buy</button>
        <button class="btn sm" onclick="window.__sa.addWatch('${esc(d.symbol)}')">★ Watchlist</button>
        <button class="btn sm" onclick="window.__sa.tvAlert('${esc(d.symbol)}')">🔔 TV alert</button>
        <button class="btn sm" onclick="window.__sa.openBacktest('${esc(d.symbol)}')">📈 Backtest</button>
      </div>
    </div>

    <div class="chart-box">
      <div class="chart-head">
        <b>Candles + OB zones</b>
        <span class="row" style="gap:5px;align-items:center">
          <span class="seg-tab ${tf === 'D' ? 'active' : ''}" onclick="window.__sa.setChartTf('D')">Daily</span>
          <span class="seg-tab ${tf === '4H' ? 'active' : ''}" onclick="window.__sa.setChartTf('4H')">4H</span>
          <button class="btn sm" style="padding:4px 9px" onclick="window.__sa.chartZoom(-1)" title="Zoom in">＋</button>
          <button class="btn sm" style="padding:4px 9px" onclick="window.__sa.chartZoom(1)" title="Zoom out">－</button>
          <button class="btn sm" style="padding:4px 9px" onclick="window.__sa.chartReset()" title="Reset zoom">⟳</button>
        </span>
      </div>
      <canvas id="chart"></canvas>
      <div class="chart-tools">
        <span class="tiny muted">Show</span>
        ${[['ob', 'Order blocks'], ['fvg', 'FVG'], ['ema', 'EMA 20/50'], ['vol', 'Volume']]
      .map(([k, l]) => `<span class="chip ${state.chartOpts[k] ? 'on' : ''}" onclick="window.__sa.chartToggle('${k}')">${l}</span>`).join('')}
      </div>
      <div class="legend">
        <span><i style="background:rgba(59,130,246,.45)"></i>Order block</span>
        <span><i style="background:rgba(100,116,139,.35)"></i>Mitigated OB</span>
        <span><i style="background:rgba(34,197,94,.4)"></i>Bull FVG</span>
        <span><i style="background:rgba(239,68,68,.35)"></i>Bear FVG</span>
        <span><i style="background:#fbbf24"></i>EMA 20</span>
        <span><i style="background:#e879f9"></i>EMA 50</span>
        <span><i style="background:var(--buy,#22c55e)"></i>BUY signal</span>
        <span><i style="background:var(--gold,#fbbf24)"></i>Inducement</span>
        <span><i style="background:#a855f7"></i>Wick rejection</span>
      </div>
      <div class="tiny muted" style="padding:0 13px 10px">${tf === '4H' ? '4H view · daily OB / FVG overlays hidden · drag to pan · scroll or ＋/－ to zoom' : 'Daily view · drag to pan · scroll, double-click or ⟳ to reset zoom'}</div>
    </div>

    <div class="stats-grid">
      ${stat('4H RSI', d.rsi4h ?? '—', d.rsi4h != null && d.rsi4h < 50 ? 'a' : '')}
      ${stat('Daily RSI', d.rsiDaily ?? '—', d.rsiDaily != null && d.rsiDaily > 55 ? 'a' : '')}
      ${stat('Vol × 20MA', d.volRatio ?? '—', d.volRatio && d.volRatio > 1.3 ? 'u' : '')}
      ${stat('ATR(14)', d.atr ?? '—')}
      ${stat('Live zones', d.activeZones?.length ?? 0)}
      ${stat('Confluence', (d.confluence?.score ?? 0) + '%', (d.confluence?.score ?? 0) >= 50 ? 'u' : (d.confluence?.score ?? 0) > 0 ? 'a' : '')}
    </div>

    <div class="section-title"><h2>Backtest on this chart (${st.trades} trades)</h2><span class="tiny muted">SL ${s.slPct}% · TP ${s.tpPct}%</span></div>
    <div class="stats-grid">
      ${stat('Win rate', st.winRate + '%', st.winRate >= 50 ? 'u' : 'd')}
      ${stat('Profit factor', st.profitFactor, st.profitFactor >= 1.5 ? 'u' : '')}
      ${stat('Net %', pct(st.netProfitPct), st.netProfitPct >= 0 ? 'u' : 'd')}
      ${stat('Max DD %', st.maxDrawdownPct + '%', 'd')}
      ${stat('Avg trade %', pct(st.avgTradePct))}
    </div>

    <div class="section-title"><h2>Order blocks (newest)</h2></div>
    <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Zone</th><th>Status</th></tr></thead><tbody>
      ${zones.map((z) => `<tr><td>${dt(z.t)}</td><td>${inr(z.bottom, 2)} – ${inr(z.top, 2)}</td>
        <td>${z.status === 'ACTIVE' ? (z.signal ? '<span class="pill buy">BUY</span>' : '<span class="pill watch">Active</span>') : '<span class="pill none">' + z.status + '</span>'}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No zones</td></tr>'}
    </tbody></table></div>

    <div class="section-title"><h2>Market structure</h2>
      <span class="pill ${d.structure?.trend === 'UP' ? 'buy' : d.structure?.trend === 'DOWN' ? 'sell' : 'none'}">${esc(d.structure?.trend || '—')} trend</span></div>
    <div class="card">
      ${d.structure?.lastEvent ? `<div class="row between" style="padding:6px 0;border-bottom:1px solid rgba(56,189,248,.08)">
        <span><span class="pill ${d.structure.lastEvent.dir === 'BULL' ? 'buy' : 'sell'}">${esc(d.structure.lastEvent.type)} ${d.structure.lastEvent.dir === 'BULL' ? '▲' : '▼'}</span> <span class="tiny muted">${dt(d.structure.lastEvent.t)}</span></span>
        <b>${inr(d.structure.lastEvent.price, 2)}</b></div>` : '<div class="empty">No structure breaks in this window</div>'}
      ${(d.structure?.events || []).slice(-4).reverse().map((e) => `<div class="row between tiny muted" style="padding:3px 0">
        <span>${esc(e.type)} ${e.dir === 'BULL' ? '▲' : '▼'} · ${dt(e.t)}</span><span>level ${inr(e.level, 2)}</span></div>`).join('')}
      <div class="tiny muted" style="margin-top:6px">BOS = trend continuation · CHoCH = possible reversal</div>
    </div>

    <div class="section-title"><h2>Multi-timeframe</h2>
      <span class="pill ${d.mtf?.alignment === 'BULL' ? 'buy' : d.mtf?.alignment === 'BEAR' ? 'sell' : 'none'}">${esc(d.mtf?.alignment || '—')}${d.mtf ? ` ${d.mtf.score > 0 ? '+' : ''}${d.mtf.score}` : ''}</span></div>
    <div class="card">
      <div class="mtf-grid">
        ${(d.mtf?.timeframes || []).map((t) => `<div class="mtf-tf">
          <div class="tiny muted">${esc(t.tf)}</div>
          <div class="${t.bias === 'UP' ? 'u' : t.bias === 'DOWN' ? 'd' : 'tiny muted'}" style="font-size:18px;line-height:1.1">${t.bias === 'UP' ? '▲' : t.bias === 'DOWN' ? '▼' : '—'}</div>
          <div class="tiny">RSI ${t.rsi ?? '—'}</div>
          <div class="tiny muted">${t.lastEvent ? esc(t.lastEvent.type) + ' ' + (t.lastEvent.dir === 'BULL' ? '▲' : '▼') : '—'}</div>
        </div>`).join('') || '<div class="empty">No timeframe history</div>'}
      </div>
      <div class="tiny muted" style="margin-top:8px">Weighted W×4 · D×3 · 4H×2 · 1H×1 · score −100 bearish → +100 bullish</div>
    </div>

    <div class="section-title"><h2>Fair value gaps</h2><span class="tiny muted">unfilled = “open”</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Dir</th><th>Zone</th><th>Status</th></tr></thead><tbody>
      ${(d.fvgs || []).slice().reverse().slice(0, 8).map((f) => `<tr><td>${dt(f.t)}</td>
        <td><span class="pill ${f.dir === 'BULL' ? 'buy' : 'sell'}">${esc(f.dir)}</span></td>
        <td>${inr(f.bottom, 2)} – ${inr(f.top, 2)}</td>
        <td>${f.filled ? '<span class="pill none">filled</span>' : '<span class="pill watch">open</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No gaps</td></tr>'}
    </tbody></table></div>

    <div class="section-title"><h2>Liquidity pools</h2><span class="tiny muted">equal highs / lows · tolerance ${inr(d.liquidity?.tol, 2)}</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Side</th><th>Level</th><th>Touches</th><th>Status</th></tr></thead><tbody>
      ${[...(d.liquidity?.buyside || []), ...(d.liquidity?.sellside || [])].map((p) => `<tr>
        <td><span class="pill ${p.side === 'BUY' ? 'buy' : 'sell'}">${p.side === 'BUY' ? 'buy-side' : 'sell-side'}</span></td>
        <td>${inr(p.level, 2)}</td><td>${p.touches}</td>
        <td>${p.swept ? '<span class="pill watch">swept</span>' : '<span class="pill none">intact</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No clusters</td></tr>'}
    </tbody></table></div>

    <div class="section-title"><h2>Signals on this symbol</h2></div>
    <div class="card">
      ${d.signals.slice(-6).reverse().map((x) => `<div class="row between" style="padding:7px 0;border-bottom:1px solid rgba(56,189,248,.08)">
        <span><span class="pill buy">BUY</span> ${dt(x.t)}</span><b>${inr(x.price, 2)}</b></div>`).join('') || '<div class="empty">No confirmed setup yet</div>'}
    </div>
    <div style="height:20px"></div>`;
  }

  async function drawDetail() {
    const d = state.detailData;
    const canvas = $('#chart');
    if (!canvas || !d) return;
    // The canvas element is recreated every time the view renders, so a chart
    // bound to a stale (detached) canvas must be torn down and rebuilt.
    if (state.chart && state.chart.c !== canvas) { state.chart.destroy(); state.chart = null; }
    if (!state.chart) state.chart = new window.CandleChart(canvas, {});
    const tf = state.chartTf || 'D';
    const is4h = tf === '4H';
    const candles = ((is4h ? d.candles4h : d.candles) || []).filter((c) => c && isFinite(c.c));
    const start = candles[0]?.t ?? 0;
    state.chart.opts.rsiLabel = is4h ? 'RSI (4H)' : 'RSI (Daily)';
    state.chart.opts.volPane = state.chartOpts.vol;
    state.chart.opts.show = { ...state.chartOpts, rsi: true };
    state.chart.setData({
      candles,
      // OB zones / FVG / structure are computed on daily bars — only overlay them on the daily view
      zones: is4h ? [] : d.zones.filter((z) => z.t >= start),
      signals: is4h ? [] : d.signals.filter((s) => s.t >= start),
      inducements: is4h ? [] : (d.inducements || []).filter((s) => s.t >= start),
      fvgs: is4h ? [] : (d.fvgs || []).filter((f) => f.t >= start),
      structure: is4h ? null : (d.structure || null),
      rsi: is4h ? (d.rsi4hSeries || []) : (d.rsiDailySeries || []),
    });
    // wick rejection mark (daily only)
    const marks = [];
    if (!is4h && d.wickLastIdx != null && d.candles[d.wickLastIdx]) marks.push({ t: d.candles[d.wickLastIdx].t });
    state.chart.opts.marks = marks;
    state.chart.render();
  }

  /* ── PAPER ── */
  async function renderPaper() {
    const s = state.user.settings;
    let data;
    try { data = await api('/paper/stats'); } catch (e) { return `<div class="card empty">${esc(e.message)}</div>`; }
    const stats = data.stats, pos = data.positions;
    return `
    <div class="card" style="margin-top:14px">
      <div class="row between">
        <div><div class="tiny muted">Mode</div><b>${data.mode === 'LIVE' ? '🔴 LIVE' : '📄 Paper'}</b></div>
        <div><div class="tiny muted">Capital</div><b>${inr(data.capital)}</b></div>
        <div><div class="tiny muted">Net P&L</div><b class="${stats.netPnl >= 0 ? '' : ''}" style="color:${stats.netPnl >= 0 ? 'var(--up)' : 'var(--down)'}">${stats.netPnlFmt}</b></div>
      </div>
      <button class="btn sm block" style="margin-top:12px" onclick="window.__sa.evalPositions()">⟳ Check SL / TP with live prices</button>
    </div>

    <div class="stats-grid">
      ${stat('Open', stats.openCount, 'a')}
      ${stat('Closed', stats.closedCount)}
      ${stat('Win rate', stats.winRate + '%', stats.winRate >= 50 ? 'u' : 'd')}
      ${stat('Profit factor', stats.profitFactor, stats.profitFactor >= 1.5 ? 'u' : '')}
      ${stat('Max DD', stats.maxDrawdownFmt, 'd')}
    </div>

    <div class="section-title"><h2>Open positions</h2></div>
    ${pos.length ? `<div class="tbl-wrap"><table><thead><tr><th>Symbol</th><th>Qty</th><th>Entry</th><th>LTP</th><th>P&L</th><th></th></tr></thead><tbody>
      ${pos.map((t) => `<tr>
        <td><b>${esc(t.symbol)}</b><div class="tiny muted">SL ${inr(t.sl, 1)} · TP ${inr(t.tp, 1)}</div></td>
        <td>${t.qty}</td><td>${inr(t.entry_price, 2)}</td><td>${inr(t.ltp, 2)}</td>
        <td class="${t.pnl >= 0 ? 'u' : 'd'}">${t.pnlFmt}<div class="tiny">${pct(t.pnlPct)}</div></td>
        <td><button class="btn sm red" onclick="window.__sa.paperClose(${t.id},${t.ltp})">Exit</button></td></tr>`).join('')}
    </tbody></table></div>` : `<div class="card empty"><div class="big">💼</div>No open positions. Signals can auto-fill here when a fresh BUY appears.</div>`}

    <div class="section-title"><h2>Closed trades</h2></div>
    ${stats.trades.filter((t) => t.status === 'CLOSED').length ? `<div class="tbl-wrap"><table><thead><tr><th>Symbol</th><th>Entry → Exit</th><th>P&L</th><th>Why</th></tr></thead><tbody>
      ${stats.trades.filter((t) => t.status === 'CLOSED').map((t) => `<tr>
        <td><b>${esc(t.symbol)}</b><div class="tiny muted">${dt(t.entry_ts)}</div></td>
        <td>${inr(t.entry_price, 1)} → ${inr(t.exit_price, 1)}</td>
        <td class="${t.pnl >= 0 ? 'u' : 'd'}">${t.pnlFmt}</td>
        <td class="tiny muted">${esc(t.exit_reason || '')}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="card empty">No closed trades yet</div>`}
    <div style="height:20px"></div>`;
  }

  /* ── ALERTS ── */
  async function renderAlerts() {
    let rows = [];
    try { rows = (await api('/alerts/history?limit=80')).alerts; } catch { }
    return `
    <div class="card" style="margin-top:14px">
      <div class="row between">
        <div><b>Alert feed</b><div class="tiny muted">Signals &amp; actions, newest first</div></div>
        <button class="btn sm" onclick="Notification.requestPermission()">Enable browser alerts</button>
      </div>
    </div>
    ${rows.map((a) => `<div class="card" style="padding:11px 12px">
      <div class="row between"><b>${esc(a.symbol)}</b><span class="pill buy">${esc(a.direction || 'BUY')}</span></div>
      <div class="tiny muted" style="margin-top:4px">${esc(a.reason || '')} · ${dt(a.ts)}</div>
      ${a.price ? `<div class="tiny" style="margin-top:2px">Price ${inr(a.price, 2)}</div>` : ''}
    </div>`).join('') || `<div class="card empty"><div class="big">🔔</div>No alerts yet — run a scan.</div>`}
    <div style="height:20px"></div>`;
  }

  /* ── OPTIONS CHAIN ── */
  const OPT_QUICK = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
  function oiFmt(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e7) return (v / 1e7).toFixed(2) + 'Cr';
    if (a >= 1e5) return (v / 1e5).toFixed(2) + 'L';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }
  function renderOptions() {
    const o = state.options;
    return `
    <div class="card" style="margin-top:14px">
      <div class="row between wrap" style="gap:10px">
        <div><b>Option chain</b><div class="tiny muted">Real NSE data — Dhan when you add a key, otherwise the free public NSE feed</div></div>
        <span class="pill ${o.source === 'Dhan' ? 'fno' : 'none'}" id="opt-src">${o.data ? 'source: ' + o.data.source : 'source: —'}</span>
      </div>
      <div class="row wrap" style="gap:8px;margin-top:12px;align-items:center">
        <input id="opt-sym" list="opt-syms" placeholder="Index or F&O stock (e.g. NIFTY, RELIANCE)" style="flex:1;min-width:180px" value="${esc(o.symbol)}" onkeydown="if(event.key==='Enter')window.__sa.loadOptions()">
        <datalist id="opt-syms">${OPT_QUICK.concat(['SENSEX', 'BANKBARODA', 'TCS', 'INFY', 'SBIN', 'HDFCBANK']).map((s) => `<option>${s}</option>`).join('')}</datalist>
        ${OPT_QUICK.map((s) => `<button class="btn sm ${o.symbol === s ? 'primary' : ''}" onclick="window.__sa.setOptSymbol('${s}')">${s}</button>`).join('')}
        <button class="btn sm" onclick="window.__sa.loadOptions()">⟳ Load</button>
      </div>
      ${o.data ? `<div class="row wrap" style="gap:8px;margin-top:10px;align-items:center">
        <span class="tiny muted">Expiry</span>
        <select style="width:auto" onchange="window.__sa.setOptExpiry(this.value)">
          ${(o.data.expiries || []).map((e) => `<option ${o.data.expiry === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
        <span class="tiny muted">· ${o.data.strikes.length} strikes</span>
      </div>` : ''}
    </div>
    <div id="opt-body">${o.loading ? `<div class="card empty"><div class="big">🧾</div>Loading live option chain…</div>` : o.error ? `<div class="card empty"><div class="big">⚠️</div>${esc(o.error)}</div>` : o.data ? optChainHtml(o.data) : `<div class="card empty"><div class="big">🧾</div>Pick an underlying and tap Load.</div>`}</div>
    <div style="height:20px"></div>`;
  }

  function optChainHtml(d) {
    const rows = d.strikes;
    const atm = d.atm;
    const cells = rows.map((s) => {
      const isAtm = s.strike === atm;
      const ce = s.ce || {}, pe = s.pe || {};
      const chg = (v) => v == null ? '—' : `<span class="${v >= 0 ? 'u' : 'd'}">${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}</span>`;
      const oic = (v) => v == null ? '—' : `<span class="${v >= 0 ? 'u' : 'd'}">${v >= 0 ? '+' : ''}${oiFmt(v)}</span>`;
      return `<tr class="${isAtm ? 'opt-atm' : ''}">
        <td class="num">${inr(ce.ltp, 2)}</td>
        <td class="num">${chg(ce.changePct)}</td>
        <td class="num">${oiFmt(ce.oi)}</td>
        <td class="num">${oic(ce.oiChange)}</td>
        <td class="num">${ce.iv != null ? Number(ce.iv).toFixed(1) : '—'}</td>
        <td class="num">${oiFmt(ce.volume)}</td>
        <td class="opt-k">${s.strike.toLocaleString('en-IN')}${isAtm ? ' <span class="tiny">ATM</span>' : ''}</td>
        <td class="num">${inr(pe.ltp, 2)}</td>
        <td class="num">${chg(pe.changePct)}</td>
        <td class="num">${oiFmt(pe.oi)}</td>
        <td class="num">${oic(pe.oiChange)}</td>
        <td class="num">${pe.iv != null ? Number(pe.iv).toFixed(1) : '—'}</td>
        <td class="num">${oiFmt(pe.volume)}</td>
      </tr>`;
    }).join('');
    const t = d.totals;
    return `
    <div class="card">
      <div class="row wrap between" style="gap:10px">
        <div><div class="tiny muted">Underlying</div><b style="font-size:20px">${d.underlyingValue != null ? inr(d.underlyingValue, 2) : '—'}</b></div>
        <div><div class="tiny muted">PCR (OI)</div><b style="font-size:20px" class="${d.pcr != null ? (d.pcr >= 1 ? 'u' : 'd') : ''}">${d.pcr ?? '—'}</b></div>
        <div><div class="tiny muted">Total CE OI</div><b>${oiFmt(t.ceOi)}</b></div>
        <div><div class="tiny muted">Total PE OI</div><b>${oiFmt(t.peOi)}</b></div>
        <div><div class="tiny muted">Updated</div><b class="tiny">${dt(d.updatedAt)}</b></div>
      </div>
      <div class="tiny muted" style="margin-top:8px">PCR &gt; 1 = more put writing (often supportive); &lt; 1 = more call writing. OI in contracts. This is analysis, not advice.</div>
    </div>
    <div class="tbl-wrap"><table class="opt-tbl">
      <thead>
        <tr class="opt-grp"><th colspan="6" class="ce-head">CALLS (CE)</th><th></th><th colspan="6" class="pe-head">PUTS (PE)</th></tr>
        <tr><th>LTP</th><th>Chg%</th><th>OI</th><th>OI chg</th><th>IV</th><th>Vol</th><th>Strike</th><th>LTP</th><th>Chg%</th><th>OI</th><th>OI chg</th><th>IV</th><th>Vol</th></tr>
      </thead>
      <tbody>${cells || `<tr><td colspan="13" class="empty">No strikes.</td></tr>`}</tbody>
    </table></div>`;
  }

  /* ── SETTINGS ── */
  function renderSettings() {
    const s = state.user.settings, u = state.user;
    const initials = (u.displayName || u.username || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    const joined = u.createdAt ? dtDate(u.createdAt) : '—';
    const lastLogin = u.lastLogin ? dtDate(u.lastLogin) : '—';
    return `
    <div class="profile-card card">
      <div class="avatar">${esc(initials)}</div>
      <div class="profile-main">
        <div class="row between wrap" style="gap:8px">
          <div>
            <b style="font-size:17px">${esc(u.displayName)}</b>
            ${u.isAdmin ? ' <span class="pill buy">OWNER</span>' : ' <span class="pill none">member</span>'}
            <div class="tiny muted">${esc(u.username)}</div>
          </div>
          <button class="btn sm" onclick="window.__sa.signOut()">Sign out</button>
        </div>
        <div class="profile-fields">
          <label class="pf"><span class="tiny muted">Display name</span>
            <span class="row" style="gap:6px"><input id="pf-name" value="${esc(u.displayName)}" maxlength="40" style="flex:1">
            <button class="btn sm primary" onclick="window.__sa.saveProfile()">Save</button></span></label>
          <div class="pf"><span class="tiny muted">Member since</span><b>${joined}</b></div>
          <div class="pf"><span class="tiny muted">Last sign-in</span><b>${lastLogin}</b></div>
        </div>
      </div>
    </div>

    <div class="section-title"><h2>Trading mode</h2></div>
    <div class="card">
      <div class="seg">
        ${[['PAPER', '📄 Paper'], ['SIGNAL', '🔔 Signals only'], ['LIVE', '🔴 Live Dhan']]
      .map(([v, l]) => `<button class="${s.mode === v ? 'active' : ''}" onclick="window.__sa.setSetting('mode','${v}')">${l}</button>`).join('')}
      </div>
      <p class="tiny muted" style="margin:10px 0 0">Paper uses live NSE/BSE prices with virtual money. Live sends real orders through your Dhan API key.</p>
    </div>

    <div class="section-title"><h2>Risk controls</h2></div>
    <div class="card">
      <div class="set-row"><span class="lbl">Capital<small>Paper buying power (INR)</small></span><input type="number" value="${s.capital}" onchange="window.__sa.setSetting('capital',+this.value)"></div>
      <div class="set-row"><span class="lbl">Per-trade %<small>Deployed per position</small></span><input type="number" value="${s.qtyPct}" onchange="window.__sa.setSetting('qtyPct',+this.value)"></div>
      <div class="set-row"><span class="lbl">Stop loss %</span><input type="number" step="0.5" value="${s.slPct}" onchange="window.__sa.setSetting('slPct',+this.value)"></div>
      <div class="set-row"><span class="lbl">Target %</span><input type="number" step="0.5" value="${s.tpPct}" onchange="window.__sa.setSetting('tpPct',+this.value)"></div>
      <div class="set-row"><span class="lbl">Max positions</span><input type="number" value="${s.maxPositions}" onchange="window.__sa.setSetting('maxPositions',+this.value)"></div>
    </div>

    <div class="section-title"><h2>Scanner automation</h2></div>
    <div class="card">
      <div class="set-row"><span class="lbl">Auto scan<small>Re-scan in background</small></span><label class="switch"><input type="checkbox" ${s.autoScan ? 'checked' : ''} onchange="window.__sa.setSetting('autoScan',this.checked)"><i></i></label></div>
      <div class="set-row"><span class="lbl">Auto-scan every (min)</span><input type="number" value="${s.autoScanMinutes}" onchange="window.__sa.setSetting('autoScanMinutes',+this.value)"></div>
      <div class="set-row"><span class="lbl">Universe</span><select onchange="window.__sa.setSetting('autoScanPreset',this.value)">
        ${[['fno', 'NSE F&O'], ['nse', 'All NSE'], ['all', 'NSE + BSE']].map(([v, l]) => `<option value="${v}" ${s.autoScanPreset === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
    </div>

    ${u.isAdmin ? `
    <div class="section-title"><h2>Email OTP sender</h2><span class="pill buy">owner only</span></div>
    <div class="card" id="mail-card">
      <div class="set-row"><span class="lbl">Status<small>Free senders: Brevo (300/day) or Gmail app password</small></span><b id="mail-status">…</b></div>
      <div class="set-row"><span class="lbl">Provider</span><select id="mail-provider" onchange="window.__sa.mailProvider(this.value)">
        <option value="dev">None (codes shown in app)</option><option value="gmail">Gmail — free App Password</option><option value="brevo">Brevo — free API</option><option value="smtp">Custom SMTP</option>
      </select></div>
      <div class="set-row"><span class="lbl">OTP type</span><select id="mail-otptype" onchange="window.__sa.mailOtpType(this.value)">
        <option value="numeric">Numeric (6 digits)</option><option value="alphanumeric">Alphanumeric</option><option value="alphabet">Letters only</option>
      </select></div>
      <div class="set-row"><span class="lbl">Gmail address<small>your Gmail — sends the OTP emails</small></span><input type="email" id="mail-gmail" placeholder="you@gmail.com"></div>
      <div class="set-row"><span class="lbl">Gmail App Password<small>myaccount.google.com/apppasswords</small></span><input type="password" id="mail-gpass" placeholder="16-digit app password"></div>
      <div class="set-row"><span class="lbl">Brevo API key<small>brevo.com → SMTP &amp; API</small></span><input type="password" id="mail-brevo" placeholder="xkeysib-…"></div>
      <div class="set-row"><span class="lbl">From email</span><input type="email" id="mail-from" placeholder="you@gmail.com"></div>
      <div class="set-row"><span class="lbl">SMTP host / port</span><span class="row"><input id="mail-host" placeholder="smtp.gmail.com" style="width:90px"><input id="mail-port" placeholder="587" style="width:56px"></span></div>
      <div class="set-row"><span class="lbl">SMTP user / password</span><span class="row"><input id="mail-user" placeholder="you@gmail.com" style="width:110px"><input id="mail-pass" type="password" placeholder="password" style="width:110px"></span></div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn sm primary" onclick="window.__sa.mailSave()">Save sender</button>
        <button class="btn sm" onclick="window.__sa.mailTest()">Send test code</button>
      </div>
    </div>` : ''}

    <div class="section-title"><h2>Alerts</h2></div>
    <div class="card">
      <div class="set-row"><span class="lbl">Sign-in email OTP<small>Code emailed on every login</small></span><label class="switch"><input type="checkbox" ${s.loginOtp !== false ? 'checked' : ''} onchange="window.__sa.setSetting('loginOtp',this.checked)"><i></i></label></div>
      <div class="set-row"><span class="lbl">Telegram token<small>Free bot from @BotFather</small></span><input type="text" value="${esc(s.telegramToken)}" onchange="window.__sa.setSetting('telegramToken',this.value)"></div>
      <div class="set-row"><span class="lbl">Telegram chat id</span><input type="text" value="${esc(s.telegramChat)}" onchange="window.__sa.setSetting('telegramChat',this.value)"></div>
      <div class="set-row"><span class="lbl">Send test alert</span><button class="btn sm" onclick="window.__sa.tgTest()">Send</button></div>
      <div class="set-row"><span class="lbl">Webhook passphrase<small>For TradingView alerts</small></span><input type="text" value="${esc(s.webhookPass)}" onchange="window.__sa.setSetting('webhookPass',this.value)"></div>
      <div class="tiny muted" style="margin-top:8px">Webhook URL: <b>${location.origin}/api/webhook/tradingview?pass=${encodeURIComponent(s.webhookPass || 'set-a-passphrase')}</b></div>
    </div>

    <div class="section-title"><h2>Dhan (live execution)</h2></div>
    <div class="card">
      <div class="set-row"><span class="lbl">Dhan client id</span><input type="text" value="${esc(s.dhanClientId)}" onchange="window.__sa.setSetting('dhanClientId',this.value)"></div>
      <div class="set-row"><span class="lbl">Access token</span><input type="password" value="${esc(s.dhanAccessToken)}" onchange="window.__sa.setSetting('dhanAccessToken',this.value)"></div>
      <div class="set-row"><span class="lbl">Enable live orders</span><label class="switch"><input type="checkbox" ${s.dhanEnabled ? 'checked' : ''} onchange="window.__sa.setSetting('dhanEnabled',this.checked)"><i></i></label></div>
      <div class="set-row"><span class="lbl">Test connection</span><button class="btn sm" onclick="window.__sa.dhanTest()">Test</button></div>
    </div>

    ${u.isAdmin ? `
    <div class="section-title"><h2>Market data sources</h2><span class="pill buy">owner only</span></div>
    <div class="card" id="prov-card">
      <div class="set-row"><span class="lbl">Active chain<small>Tried in order · falls back automatically</small></span><b id="prov-active">…</b></div>

      <div style="border-top:1px solid var(--line);margin:12px 0"></div>
      <div class="set-row"><span class="lbl"><b>Angel One</b> SmartAPI<small>Free NSE/BSE data · needs an Angel One account</small></span>
        <label class="switch"><input type="checkbox" id="ao-enabled" ${state.prov?.angelone?.enabled ? 'checked' : ''}><i></i></label></div>
      <div class="set-row"><span class="lbl">API key<small>SmartAPI app key</small></span><input type="password" id="ao-apiKey" placeholder="${esc(state.prov?.angelone?.apiKey || 'SmartAPI key')}"></div>
      <div class="set-row"><span class="lbl">Client code</span><input type="text" id="ao-clientCode" value="${esc(state.prov?.angelone?.clientCode || '')}" placeholder="e.g. A123456"></div>
      <div class="set-row"><span class="lbl">PIN<small>${state.prov?.angelone?.hasPin ? 'saved — leave blank to keep' : '4-digit PIN'}</small></span><input type="password" id="ao-pin" placeholder="••••"></div>
      <div class="set-row"><span class="lbl">TOTP secret<small>${state.prov?.angelone?.hasTotpSecret ? 'saved — leave blank to keep' : 'base32 secret from your authenticator setup'}</small></span><input type="password" id="ao-totpSecret" placeholder="JBSWY3DPEHPK3PXP"></div>
      <div class="row" style="gap:8px;margin-bottom:14px">
        <button class="btn sm primary" onclick="window.__sa.provSave('angelone')">Save</button>
        <button class="btn sm" onclick="window.__sa.provTest('angelone')">Test login</button>
      </div>

      <div style="border-top:1px solid var(--line);margin:12px 0"></div>
      <div class="set-row"><span class="lbl"><b>Fyers</b> API v3<small>Free data · access token expires daily</small></span>
        <label class="switch"><input type="checkbox" id="fy-enabled" ${state.prov?.fyers?.enabled ? 'checked' : ''}><i></i></label></div>
      <div class="set-row"><span class="lbl">App ID</span><input type="text" id="fy-appId" value="${esc(state.prov?.fyers?.appId || '')}" placeholder="XXXXXXXX-100"></div>
      <div class="set-row"><span class="lbl">Access token<small>${state.prov?.fyers?.hasAccessToken ? 'saved — paste a fresh one each day' : 'from Fyers auth redirect'}</small></span><input type="password" id="fy-accessToken" placeholder="eyJ0…"></div>
      <div class="row" style="gap:8px;margin-bottom:14px">
        <button class="btn sm primary" onclick="window.__sa.provSave('fyers')">Save</button>
        <button class="btn sm" onclick="window.__sa.provTest('fyers')">Test auth</button>
      </div>

      <div style="border-top:1px solid var(--line);margin:12px 0"></div>
      <div class="set-row"><span class="lbl"><b>Tapetide</b> MCP<small>Research/fundamentals · free ~50 calls/day</small></span>
        <label class="switch"><input type="checkbox" id="tp-enabled" ${state.prov?.tapetide?.enabled ? 'checked' : ''}><i></i></label></div>
      <div class="set-row"><span class="lbl">Personal token<small>${state.prov?.tapetide?.hasToken ? 'saved — leave blank to keep' : 'from tapetide.com/settings/tokens (tpt_rt_…)'}</small></span><input type="password" id="tp-token" placeholder="tpt_rt_…"></div>
      <div class="row" style="gap:8px;margin-bottom:14px">
        <button class="btn sm primary" onclick="window.__sa.provSave('tapetide')">Save</button>
        <button class="btn sm" onclick="window.__sa.provTest('tapetide')">Test</button>
      </div>

      <div class="set-row"><span class="lbl">Yahoo Finance<small>Always on · no key needed</small></span><b class="u">Active</b></div>
      <div class="tiny muted" style="margin-top:8px">Add credentials and enable a source to try it first. The app always falls back to Yahoo, so it never goes dark. Tapetide is best for research (its ~50 free calls/day suits occasional lookups, not bulk scanning).</div>
    </div>` : ''}
    <div style="height:24px"></div>`;
  }

  /* ── OWNER ADMIN CONSOLE ── */
  const ADMIN_TABS = [['overview', 'Overview'], ['users', 'Users'], ['signals', 'Signals'], ['trades', 'Trades'], ['logs', 'Audit log'], ['system', 'System']];
  const statCard = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const fmtUptime = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : (h ? `${h}h ${m}m` : `${m}m`); };

  async function renderAdmin() {
    if (!state.user.isAdmin) { go('dashboard'); return ''; }
    const tab = state.adminTab || 'overview';
    let body;
    try {
      if (tab === 'overview') body = adminOverview(await api('/admin/overview'));
      else if (tab === 'users') body = adminUsers((await api('/admin/users')).users);
      else if (tab === 'signals') body = adminSignals((await api('/admin/signals?limit=150')).signals);
      else if (tab === 'trades') body = adminTrades((await api('/admin/trades?limit=150')).trades);
      else if (tab === 'logs') body = adminLogs((await api('/admin/logs?limit=150')).logs);
      else body = adminSystem();
    } catch (e) { body = `<div class="card empty"><div class="big">⚠️</div>${esc(e.message)}</div>`; }
    return `
    <div class="card" style="margin-top:14px">
      <div class="row between">
        <div><div style="font-weight:800;font-size:18px">🛡️ Owner console</div><div class="tiny muted">System control · owner only</div></div>
        <button class="btn sm" onclick="window.__sa.adminRefresh()">⟳ Refresh</button>
      </div>
    </div>
    <div class="admin-tabs">${ADMIN_TABS.map(([id, l]) => `<button class="seg-tab ${tab === id ? 'active' : ''}" onclick="window.__sa.adminTab('${id}')">${l}</button>`).join('')}</div>
    ${body}
    <div style="height:24px"></div>`;
  }

  function adminOverview(o) {
    const m = o.market || {};
    return `
    <div class="stats-grid">
      ${statCard('Users', o.users.total, 'a')}
      ${statCard('Owners', o.users.admins)}
      ${statCard('Sessions', o.sessions)}
      ${statCard('Signals', o.signals.total)}
      ${statCard('24h signals', o.signals.last24h, 'u')}
      ${statCard('Trades', o.trades.total)}
      ${statCard('Open trades', o.trades.open, 'a')}
      ${statCard('Scan rows', o.scan.cachedSymbols)}
      ${statCard('New (7d)', o.users.last7d, 'u')}
    </div>
    <div class="section-title"><h2>System</h2></div>
    <div class="card">
      <div class="set-row"><span class="lbl">Market</span><b class="${m.state === 'OPEN' ? 'u' : ''}">${esc(m.state || '—')} · ${esc(m.istTime || '')}</b></div>
      <div class="set-row"><span class="lbl">Runtime</span><b>${esc(o.server.node)} · PID ${o.server.pid}</b></div>
      <div class="set-row"><span class="lbl">Uptime</span><b>${fmtUptime(o.server.uptimeSec)}</b></div>
      <div class="set-row"><span class="lbl">Memory (RSS)</span><b>${o.server.memoryMB} MB</b></div>
      <div class="set-row"><span class="lbl">Port</span><b>${o.server.port}</b></div>
      <div class="set-row"><span class="lbl">Last scan</span><b>${dt(o.scan.lastScanAt)}</b></div>
      <div class="set-row"><span class="lbl">Email sender</span><b class="${o.mail.ready ? 'u' : ''}">${esc(o.mail.mode || o.mail.provider)}</b></div>
    </div>
    <div class="section-title"><h2>Data provider</h2><button class="btn sm" onclick="window.__sa.adminHealth()">Run health check</button></div>
    <div class="card" id="admin-health"><div class="tiny muted">Run a live provider probe for the latest status.</div></div>`;
  }

  function adminUsers(users) {
    return `
    <div class="section-title"><h2>Accounts</h2><span class="tiny muted">${users.length} total</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Trades</th><th>Signals</th><th>Joined</th><th>Actions</th></tr></thead><tbody>
      ${users.map((u) => `<tr>
        <td><b>${esc(u.email)}</b><div class="tiny muted">${esc(u.displayName || '')}${u.verified ? ' · verified' : ' · unverified'}</div></td>
        <td>${u.isAdmin ? '<span class="pill buy">OWNER</span>' : '<span class="pill none">user</span>'}</td>
        <td class="tiny">${u.trades.total} <span class="muted">(${u.trades.open} open)</span><div class="tiny ${u.trades.netPnl >= 0 ? 'u' : 'd'}">${u.trades.netPnl >= 0 ? '+' : ''}₹${u.trades.netPnl}</div></td>
        <td class="tiny">${u.signals}</td>
        <td class="tiny muted">${dt(u.createdAt)}</td>
        <td><div class="row" style="gap:5px">
          <button class="btn sm" onclick="window.__sa.adminRole(${u.id},${u.isAdmin ? 0 : 1})">${u.isAdmin ? 'Demote' : 'Make owner'}</button>
          <button class="btn sm" onclick="window.__sa.adminResetPw(${u.id})">Reset pw</button>
          <button class="btn sm red" onclick="window.__sa.adminDelete(${u.id},'${esc(u.email)}')">Delete</button>
        </div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No users</td></tr>'}
    </tbody></table></div>`;
  }

  function adminSignals(sig) {
    return `
    <div class="section-title"><h2>Recent signals</h2><span class="tiny muted">${sig.length} latest</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Time</th><th>Symbol</th><th>User</th><th>Price</th><th>Reason</th></tr></thead><tbody>
      ${sig.map((s) => `<tr><td class="tiny muted">${dt(s.ts)}</td><td><b>${esc(s.symbol)}</b></td>
        <td class="tiny">${esc(s.email || 'system')}</td><td>${inr(s.price, 2)}</td><td class="tiny muted">${esc((s.reason || '').slice(0, 60))}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No signals</td></tr>'}
    </tbody></table></div>`;
  }

  function adminTrades(tr) {
    return `
    <div class="section-title"><h2>Recent trades</h2><span class="tiny muted">${tr.length} latest</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Symbol</th><th>User</th><th>Mode</th><th>Status</th><th>P&amp;L</th><th>Entry</th></tr></thead><tbody>
      ${tr.map((t) => `<tr><td><b>${esc(t.symbol)}</b> ×${t.qty}</td><td class="tiny">${esc(t.email || '—')}</td>
        <td class="tiny">${esc(t.mode)}</td><td class="tiny">${esc(t.status)}</td>
        <td class="${t.pnl >= 0 ? 'u' : 'd'}">${t.pnlFmt || '—'}</td><td class="tiny muted">${dt(t.entry_ts)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No trades</td></tr>'}
    </tbody></table></div>`;
  }

  function adminLogs(logs) {
    return `
    <div class="section-title"><h2>Audit log</h2><span class="tiny muted">${logs.length} latest</span></div>
    <div class="card">
      ${logs.map((l) => `<div class="log-row"><span class="pill none">${esc(l.action || '')}</span><span class="tiny muted">${esc(l.email || '')}</span><span class="tiny grow" style="overflow:hidden;text-overflow:ellipsis">${esc((l.detail || '').slice(0, 80))}</span><span class="tiny muted">${dt(l.ts)}</span></div>`).join('') || '<div class="empty">No log entries</div>'}
    </div>`;
  }

  function adminSystem() {
    const u = state.universe || { counts: {} };
    return `
    <div class="section-title"><h2>Scanner &amp; universe</h2></div>
    <div class="card">
      <div class="set-row"><span class="lbl">Universe masters</span><button class="btn sm" onclick="window.__sa.loadUniverse()">Reload</button></div>
      <div class="tiny muted" style="margin:8px 0">NSE ${u.counts.nse || 0} · BSE ${u.counts.bse || 0} · F&amp;O ${u.counts.fno || 0}</div>
      <div class="row wrap" style="gap:8px">
        <button class="btn sm gold" onclick="window.__sa.adminScan('all')">Scan NSE+BSE</button>
        <button class="btn sm" onclick="window.__sa.adminScan('fno')">Scan F&amp;O</button>
        <button class="btn sm" onclick="window.__sa.adminScan('nse')">Scan NSE</button>
      </div>
    </div>
    <div class="section-title"><h2>Email OTP sender</h2></div>
    <div class="card">
      <div class="set-row"><span class="lbl">Status</span><b id="mail-status">…</b></div>
      <div class="tiny muted">Configure the free sender under Settings → Email OTP.</div>
    </div>
    <div class="section-title"><h2>Scan jobs (this session)</h2></div>
    <div class="card" id="admin-jobs"><div class="tiny muted">Loading…</div></div>`;
  }

  /* ── BACKTEST WORKSPACE ── */
  function renderBacktest() {
    const b = state.backtest;
    const d = b.data;
    return `
    <div class="section-title"><h2>Backtesting workspace</h2><span class="tiny muted">Same engine that runs live · historical NSE data</span></div>
    <div class="card">
      <div class="row wrap" style="gap:10px;align-items:flex-end">
        <label style="flex:1 1 150px;min-width:140px">Symbol<input id="bt-symbol" value="${esc(b.symbol)}" placeholder="RELIANCE / NIFTY / ^NSEI" /></label>
        <label style="flex:0 0 120px">Preset<select id="bt-preset">
          <option value="improved"${b.preset === 'improved' ? ' selected' : ''}>Improved</option>
          <option value="strict"${b.preset === 'strict' ? ' selected' : ''}>Strict</option>
        </select></label>
        <label style="flex:0 0 92px">SL %<input id="bt-sl" type="number" step="0.1" min="0.1" value="${esc(b.slPct)}" /></label>
        <label style="flex:0 0 92px">TP %<input id="bt-tp" type="number" step="0.1" min="0.1" value="${esc(b.tpPct)}" /></label>
        <label style="flex:0 0 92px">Max bars<input id="bt-bars" type="number" step="1" min="1" value="${esc(b.maxBars)}" /></label>
        <button class="btn primary" id="btn-bt" onclick="window.__sa.runBacktest()" ${b.loading ? 'disabled' : ''}>${b.loading ? 'Running…' : '▶ Run backtest'}</button>
      </div>
      <div class="tiny muted" style="margin-top:8px">Daily candles drive the setup; 1h/4H bars drive the 4H-RSI gate. Yahoo serves ≈2 years of 1h data, so the window is capped there and reported exactly below — never extended or invented.</div>
    </div>
    ${b.loading ? `<div class="card empty"><div class="big">⏳</div>Running the engine over history…</div>` : ''}
    ${b.error ? `<div class="card empty"><div class="big">⚠️</div>${esc(b.error)}</div>` : ''}
    ${d ? btResults(d) : (!b.loading && !b.error ? `<div class="card empty"><div class="big">📈</div>Enter a symbol and run a backtest.<br>Results come from the deterministic SMC engine — not a curve-fit model.</div>` : '')}`;
  }

  function btResults(d) {
    const s = d.stats || {};
    const trades = d.trades || [];
    const curve = d.equityCurve || [];
    const monthly = d.monthly || [];
    const noTrades = !s.trades;
    return `
    <div class="section-title"><h2>${esc(d.symbol)} — results</h2><span class="pill ${noTrades ? 'none' : 'buy'}">${s.trades} trades</span></div>
    <div class="card">
      <div class="row between tiny muted"><span>Window: <b style="color:var(--txt)">${d.dataFrom ? dtDate(d.dataFrom) : '—'} → ${d.dataTo ? dtDate(d.dataTo) : '—'}</b></span><span>${d.bars} daily bars · preset ${esc(d.preset)}</span></div>
      <div class="row between tiny muted" style="margin-top:5px"><span>SL ${esc(d.params.slPct)}% · TP ${esc(d.params.tpPct)}% · max ${esc(d.params.maxBars)} bars</span><span>Generated ${dt(d.generatedAt)}</span></div>
    </div>
    <div class="stats-grid">
      ${stat('Trades', s.trades)}
      ${stat('Win rate', s.winRate + '%', s.trades && s.winRate >= 50 ? 'u' : s.trades ? 'd' : '')}
      ${stat('Profit factor', s.profitFactor, s.profitFactor >= 1.5 ? 'u' : '')}
      ${stat('Net %', pct(s.netProfitPct), s.netProfitPct >= 0 ? 'u' : 'd')}
      ${stat('Max DD %', s.maxDrawdownPct + '%', s.maxDrawdownPct > 0 ? 'd' : '')}
      ${stat('Avg trade %', pct(s.avgTradePct))}
      ${stat('Best %', pct(s.bestTradePct), 'u')}
      ${stat('Worst %', pct(s.worstTradePct), 'd')}
      ${stat('Bars', d.bars)}
    </div>
    ${noTrades ? `<div class="card empty"><div class="big">🔍</div>No closed trades in this window.<br>The SMC rules are selective — 4H RSI gate + wick rejection + unmitigated order block. Try another symbol, a wider window, or a different preset.</div>` : ''}
    <div class="section-title"><h2>Equity curve</h2><span class="tiny muted">Cumulative % per closed trade · ${curve.length} points</span></div>
    <div class="card"><canvas id="bt-equity" style="width:100%;height:220px;display:block"></canvas></div>
    <div class="section-title"><h2>Monthly returns</h2><span class="tiny muted">IST buckets</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Month</th><th>Trades</th><th>Win%</th><th>Return</th></tr></thead><tbody>
      ${monthly.map((m) => `<tr><td>${esc(m.month)}</td><td>${m.trades}</td><td>${m.winRate}%</td><td class="${m.pct >= 0 ? 'u' : 'd'}">${pct(m.pct)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No closed months</td></tr>'}
    </tbody></table></div>
    <div class="section-title"><h2>Trade history</h2><span class="tiny muted">${trades.length} closed</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Entry</th><th>Exit</th><th>In</th><th>Out</th><th>Bars</th><th>Reason</th><th>P&amp;L</th></tr></thead><tbody>
      ${trades.map((t) => `<tr><td>${dt(t.entryTs)}</td><td>${dt(t.exitTs)}</td><td>${inr(t.entry, 2)}</td><td>${inr(t.exit, 2)}</td><td>${t.bars}</td><td>${esc(t.reason)}</td><td class="${t.pct >= 0 ? 'u' : 'd'}">${pct(t.pct)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No trades</td></tr>'}
    </tbody></table></div>`;
  }

  function drawBacktest() {
    const cv = $('#bt-equity'); if (!cv) return;
    const d = state.backtest.data;
    const curve = (d && d.equityCurve) || [];
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 320, H = cv.clientHeight || 220;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(148,163,184,.14)'; ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++) { const y = (H / 4) * g; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    if (curve.length < 2) {
      ctx.fillStyle = '#6b7896'; ctx.font = '12px Segoe UI,system-ui'; ctx.textAlign = 'center';
      ctx.fillText(curve.length ? 'Single trade — need ≥2 to plot a curve' : 'No trades to plot', W / 2, H / 2);
      return;
    }
    const pts = [0, ...curve];
    let lo = Math.min(...pts, 0), hi = Math.max(...pts, 0);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const x = (i) => (i / (pts.length - 1)) * W;
    const y = (v) => H - ((v - lo) / (hi - lo)) * H;
    // zero baseline
    ctx.strokeStyle = 'rgba(148,163,184,.35)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(W, y(0)); ctx.stroke(); ctx.setLineDash([]);
    const up = pts[pts.length - 1] >= 0;
    const col = up ? '#22c55e' : '#f43f5e';
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, up ? 'rgba(34,197,94,.28)' : 'rgba(244,63,94,.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.moveTo(x(0), y(pts[0]));
    pts.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); pts.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#93a1bd'; ctx.font = '10px Segoe UI,system-ui'; ctx.textAlign = 'left';
    ctx.fillText(pct(hi).replace('%', '') + '%', 4, 12); ctx.textAlign = 'left';
    ctx.fillText(pct(lo).replace('%', '') + '%', 4, H - 4);
  }

  /* ── RENDER ── */
  async function render() {
    const v = $('#view');
    const route = state.route;
    if (route === 'dashboard') v.innerHTML = renderDashboard();
    else if (route === 'scanner') v.innerHTML = renderScanner();
    else if (route === 'backtest') { v.innerHTML = renderBacktest(); if (state.backtest.data) setTimeout(drawBacktest, 20); }
    else if (route === 'options') { v.innerHTML = renderOptions(); if (!state.options.data && !state.options.loading && !state.options.error) setTimeout(actions.loadOptions, 20); }
    else if (route === 'stock') v.innerHTML = renderStock();
    else if (route === 'paper') v.innerHTML = await renderPaper();
    else if (route === 'alerts') v.innerHTML = await renderAlerts();
    else if (route === 'settings') { v.innerHTML = renderSettings(); setTimeout(actions.mailStatus, 30); if (state.user.isAdmin) setTimeout(actions.provLoad, 30); }
    else if (route === 'admin') { v.innerHTML = await renderAdmin(); setTimeout(actions.mailStatus, 30); actions.adminJobs(); }
    applyAdminNav();
    // progress refs
    const bar = $('#scan-bar'); if (bar && state.scanProgress) bar.style.width = state.scanProgress + '%';
  }

  /* ══════════════ ACTIONS ══════════════ */
  state.scanFilter = { q: '', exch: 'ALL', buy: false, fno: false, mtf: false };
  state.scanProgress = 0;
  state.chartOpts = state.chartOpts || { ob: true, fvg: true, ema: true, vol: true };

  const actions = {
    go, toast, openStock,
    setChartTf(tf) {
      state.chartTf = tf;
      render();
      setTimeout(drawDetail, 20);
    },
    chartToggle(k) {
      state.chartOpts[k] = !state.chartOpts[k];
      render();
      setTimeout(drawDetail, 20);
    },
    chartZoom(dir) {
      if (!state.chart) return;
      if (dir < 0) state.chart.zoomIn(); else state.chart.zoomOut();
    },
    chartReset() { if (state.chart) state.chart.resetView(); },
    setOptSymbol(sym) {
      state.options.symbol = String(sym || '').toUpperCase();
      state.options.expiry = null;
      state.options.data = null;
      actions.loadOptions();
    },
    setOptExpiry(e) { state.options.expiry = e; actions.loadOptions(); },
    async loadOptions() {
      if (state.options.loading) return;
      const el = $('#opt-sym');
      const sym = String((el && el.value) || state.options.symbol || 'NIFTY').trim().toUpperCase();
      if (!sym) return;
      state.options.symbol = sym;
      state.options.loading = true;
      state.options.error = null;
      render();
      try {
        const q = state.options.expiry ? '?expiry=' + encodeURIComponent(state.options.expiry) : '';
        const d = await api('/options/' + encodeURIComponent(sym) + q);
        state.options.data = d;
        state.options.source = d.source;
        state.options.expiry = d.expiry;
      } catch (e) {
        state.options.data = null;
        state.options.error = e.message;
      } finally {
        state.options.loading = false;
        render();
      }
    },
    setPreset(p) { state.scanPreset = p; render(); },
    filter(patch) { Object.assign(state.scanFilter, patch); render(); },
    async startScan(preset, useCache = true) {
      const btn = $('#btn-scan'); if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const j = await api('/scan/start', { method: 'POST', body: { preset: preset || state.scanPreset, opts: state.scanOpts, useCache } });
        state.scanJob = j.jobId; state.scanProgress = 1;
        setProgress(1, '0/' + j.total);
        toast('Scanning ' + (preset || state.scanPreset) + ' · ' + j.total + ' symbols', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      finally { if (btn) { btn.disabled = false; btn.textContent = '▶ Scan'; } }
    },
    async paperOpen(sym, price) {
      try {
        const j = await api('/paper/open', { method: 'POST', body: { symbol: sym, price, name: sym } });
        toast('Paper position opened: ' + j.trade.symbol + ' ×' + j.trade.qty, 'ok');
        notifyBrowser('Paper buy ' + sym + ' @ ₹' + price);
      } catch (e) { toast(e.message, 'err'); }
    },
    async paperClose(id, price) {
      try { const j = await api('/paper/close', { method: 'POST', body: { id, price } }); toast('Position closed · P&L ' + j.trade.pnl, 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    },
    async evalPositions() {
      try { const j = await api('/paper/evaluate', { method: 'POST' }); toast(j.closed.length ? j.closed.length + ' position(s) exited' : 'No SL/TP hit yet', j.closed.length ? 'ok' : ''); }
      catch (e) { toast(e.message, 'err'); }
      render();
    },
    async setSetting(k, v) {
      try {
        const j = await api('/me/settings', { method: 'PUT', body: { [k]: v } });
        state.user.settings = j.settings;
        toast('Saved', 'ok');
        if (k === 'mode') render();
      } catch (e) { toast(e.message, 'err'); }
    },
    async saveProfile() {
      const el = $('#pf-name'); if (!el) return;
      const name = el.value.trim();
      if (!name) { toast('Display name cannot be empty', 'err'); return; }
      try {
        const j = await api('/me', { method: 'PATCH', body: { displayName: name } });
        state.user = j.user;
        toast('Profile saved', 'ok');
        render();
      } catch (e) { toast(e.message, 'err'); }
    },
    signOut() {
      try { api('/auth/logout', { method: 'POST' }).catch(() => { }); } catch { }
      localStorage.removeItem('sa_token'); state.token = null; state.user = null;
      if (state.es) state.es.close();
      location.reload();
    },
    async tgTest() {
      try { const j = await api('/alerts/telegram-test', { method: 'POST' }); toast(j.ok ? 'Telegram connected' : (j.error || 'Failed'), j.ok ? 'ok' : 'err'); }
      catch (e) { toast(e.message, 'err'); }
    },
    mailProvider(v) { state.mailProvider = v; },
    async mailSave() {
      try {
        const j = await api('/admin/mail-config', {
          method: 'POST',
          body: {
            provider: $('#mail-provider').value,
            otpType: $('#mail-otptype').value,
            from: $('#mail-from').value, fromName: 'TradeMind',
            brevoKey: $('#mail-brevo').value,
            smtp: {
              host: $('#mail-host').value, port: Number($('#mail-port').value || 587), secure: false,
              user: $('#mail-gmail').value || $('#mail-user').value,
              pass: $('#mail-gpass').value || $('#mail-pass').value,
            },
          },
        });
        toast('Sender saved: ' + j.mail.provider, 'ok');
        await actions.mailStatus();
      } catch (e) { toast(e.message, 'err'); }
    },
    mailOtpType(v) { state.mailOtpType = v; },
    async mailTest() {
      try { const j = await api('/admin/mail-test', { method: 'POST' }); toast(j.ok ? 'Test code sent to your email' : ('Not sent: ' + (j.error || 'unknown')), j.ok ? 'ok' : 'err'); }
      catch (e) { toast(e.message, 'err'); }
    },
    async mailStatus() {
      try {
        const j = await api('/mail/status');
        const el = $('#mail-status');
        if (el) el.innerHTML = j.mail.ready ? `<span style="color:var(--up)">${esc(j.mail.provider)} · connected</span>` : `<span style="color:var(--gold)">not connected (dev)</span>`;
        const sel = $('#mail-provider');
        if (sel) sel.value = j.mail.provider;
      } catch { }
    },
    async dhanTest() {
      try { const j = await api('/dhan/test', { method: 'POST' }); toast(j.ok ? 'Dhan connected · funds loaded' : (j.error || 'Failed'), j.ok ? 'ok' : 'err'); }
      catch (e) { toast(e.message, 'err'); }
    },
    async provLoad() {
      try {
        const j = await api('/providers/status');
        state.prov = j.credentials || {};
        const c = state.prov;
        const el = $('#prov-active');
        if (el) el.innerHTML = (j.active || []).map((id) => `<span class="pill buy" style="margin-left:4px">${esc({ yahoo: 'Yahoo Finance', angelone: 'Angel One', fyers: 'Fyers', tapetide: 'Tapetide' }[id] || id)}</span>`).join('') || '<span class="tiny muted">none</span>';
        const setv = (sel, v) => { const n = $(sel); if (n) n.value = v; };
        const setc = (sel, b) => { const n = $(sel); if (n) n.checked = !!b; };
        if (c.angelone) {
          setc('#ao-enabled', c.angelone.enabled);
          setv('#ao-clientCode', c.angelone.clientCode || '');
          const ak = $('#ao-apiKey'); if (ak && !ak.value) ak.placeholder = c.angelone.apiKey || 'SmartAPI key';
        }
        if (c.fyers) {
          setc('#fy-enabled', c.fyers.enabled);
          setv('#fy-appId', c.fyers.appId || '');
        }
        if (c.tapetide) {
          setc('#tp-enabled', c.tapetide.enabled);
          const tk = $('#tp-token'); if (tk && !tk.value) tk.placeholder = c.tapetide.hasToken ? '•••• saved — blank to keep' : 'tpt_rt_…';
        }
      } catch { }
    },
    async provSave(which) {
      const body = {};
      if (which === 'angelone') {
        const a = { enabled: $('#ao-enabled')?.checked };
        const set = (k, id) => { const v = $('#' + id)?.value; if (v) a[k] = v; };
        set('apiKey', 'ao-apiKey'); set('clientCode', 'ao-clientCode'); set('pin', 'ao-pin'); set('totpSecret', 'ao-totpSecret');
        body.angelone = a;
      } else if (which === 'tapetide') {
        const t = { enabled: $('#tp-enabled')?.checked };
        const tv = $('#tp-token')?.value; if (tv) t.token = tv;
        body.tapetide = t;
      } else {
        const f = { enabled: $('#fy-enabled')?.checked };
        const av = $('#fy-appId')?.value; if (av) f.appId = av;
        const tv = $('#fy-accessToken')?.value; if (tv) f.accessToken = tv;
        body.fyers = f;
      }
      try { const j = await api('/providers/credentials', { method: 'PUT', body }); state.prov = j.status.credentials; toast('Saved · active: ' + ((j.status.active || []).join(', ') || 'none'), 'ok'); render(); }
      catch (e) { toast(e.message, 'err'); }
    },
    async provTest(id) {
      toast('Testing ' + id + '…', 'ok');
      try { const j = await api('/providers/test', { method: 'POST', body: { id } }); toast(j.ok ? (id + ' OK' + (j.profile ? ' · ' + j.profile : '')) : (id + ': ' + (j.error || 'failed')), j.ok ? 'ok' : 'err'); }
      catch (e) { toast(e.message, 'err'); }
    },
    async adminScan(preset) {
      try { const j = await api('/admin/scan', { method: 'POST', body: { preset } }); toast('Owner scan started · ' + j.total + ' symbols', 'ok'); setProgress(1, '0/' + j.total); }
      catch (e) { toast(e.message, 'err'); }
    },
    adminTab(t) { state.adminTab = t; render(); },
    adminRefresh() { render(); toast('Refreshed', 'ok'); },
    async adminHealth() {
      const el = $('#admin-health'); if (el) el.innerHTML = '<div class="tiny muted">Probing…</div>';
      try {
        const j = await api('/admin/health'); const p = j.provider;
        if (el) el.innerHTML = `<div class="row between"><span><b>${esc(p.name)}</b><div class="tiny muted">${esc(p.probe)} · ${p.latencyMs} ms</div></span>
          <span class="${p.ok ? 'u' : 'd'}">${p.ok ? inr(p.price, 2) : '✗ ' + esc(p.error || 'unavailable')}</span></div>
          <div class="set-row"><span class="lbl">Market</span><b>${esc(j.market.state)} · ${esc(j.market.istTime)}</b></div>
          <div class="set-row"><span class="lbl">Email sender</span><b class="${j.mail.ready ? 'u' : ''}">${esc(j.mail.mode)}</b></div>`;
        toast(p.ok ? ('Provider OK · ' + p.latencyMs + 'ms') : 'Provider unavailable', p.ok ? 'ok' : 'err');
      } catch (e) { if (el) el.innerHTML = '<div class="tiny d">' + esc(e.message) + '</div>'; }
    },
    async adminJobs() {
      const el = $('#admin-jobs'); if (!el) return;
      try {
        const jobs = (await api('/admin/jobs')).jobs;
        el.innerHTML = jobs.length
          ? jobs.map((j) => `<div class="set-row"><span class="lbl">${esc(j.preset)}</span><span class="tiny muted">${esc(j.status)} · ${j.done}/${j.total} · ${dt(j.startedAt)}</span></div>`).join('')
          : '<div class="tiny muted">No scan jobs in this session.</div>';
      } catch { }
    },
    async adminRole(id, makeAdmin) {
      try { await api('/admin/users/' + id, { method: 'PATCH', body: { isAdmin: !!makeAdmin } }); toast('Role updated', 'ok'); render(); }
      catch (e) { toast(e.message, 'err'); }
    },
    async adminResetPw(id) {
      const p = prompt('New password (min 6 characters)'); if (!p) return;
      try { await api('/admin/users/' + id, { method: 'PATCH', body: { password: p } }); toast('Password reset', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    },
    async adminDelete(id, email) {
      if (!confirm('Delete ' + email + ' and all their data? This cannot be undone.')) return;
      try { await api('/admin/users/' + id, { method: 'DELETE' }); toast('User deleted', 'ok'); render(); }
      catch (e) { toast(e.message, 'err'); }
    },
    async loadUniverse() { await loadUniverse(); toast('Universe reloaded', 'ok'); render(); },
    async addWatch(sym) {
      try {
        await api('/watchlist', { method: 'POST', body: { symbol: sym } });
        toast(sym + ' added to watchlist', 'ok');
        await loadWatchlist();
        if (state.route === 'dashboard') render();
      } catch (e) { toast(e.message, 'err'); }
    },
    async removeWatch(sym) {
      try {
        await api('/watchlist/' + encodeURIComponent(sym), { method: 'DELETE' });
        toast(sym + ' removed', 'ok');
        await loadWatchlist();
        render();
      } catch (e) { toast(e.message, 'err'); }
    },
    tvAlert(sym) {
      const txt = 'In TradingView: open ' + sym + ' chart → Alerts → Create alert → Condition: TradeMind SMC strategy → message: {"symbol":"' + sym + '","price":{{close}},"action":"BUY"} → webhook URL: ' + location.origin + '/api/webhook/tradingview?pass=' + encodeURIComponent(state.user.settings.webhookPass || 'YOUR_PASS');
      toast(txt.slice(0, 120) + '…', 'ok');
      console.log(txt);
    },
    async runBacktest() {
      const b = state.backtest;
      const symEl = $('#bt-symbol');
      b.symbol = String((symEl && symEl.value) || b.symbol || '').trim().toUpperCase();
      const pEl = $('#bt-preset'); if (pEl) b.preset = pEl.value;
      const slEl = $('#bt-sl'); if (slEl && slEl.value !== '') b.slPct = slEl.value;
      const tpEl = $('#bt-tp'); if (tpEl && tpEl.value !== '') b.tpPct = tpEl.value;
      const mbEl = $('#bt-bars'); if (mbEl && mbEl.value !== '') b.maxBars = mbEl.value;
      if (!b.symbol) { toast('Enter a symbol', 'err'); return; }
      b.loading = true; b.error = null; b.data = null;
      render(); setTimeout(drawBacktest, 20);
      try {
        const q = new URLSearchParams({ preset: b.preset, slPct: b.slPct, tpPct: b.tpPct, maxBars: b.maxBars }).toString();
        const d = await api('/backtest/' + encodeURIComponent(b.symbol) + '?' + q);
        b.data = d;
        if (!d.stats.trades) toast('No closed trades for ' + d.symbol + ' in this window');
        else toast(d.stats.trades + ' trade(s) · win ' + d.stats.winRate + '% · net ' + pct(d.stats.netProfitPct), 'ok');
      } catch (e) { b.error = e.message; toast(e.message, 'err'); }
      finally { b.loading = false; render(); setTimeout(drawBacktest, 30); }
    },
    openBacktest(sym) {
      if (sym) state.backtest.symbol = String(sym).toUpperCase();
      go('backtest');
    },
  };
  window.__sa = actions;

  function notifyBrowser(text) {
    if (!state.user?.settings.notifyBrowser) return;
    try { if (Notification.permission === 'granted') new Notification('TradeMind', { body: text }); } catch { }
  }

  /* ══════════════ BOOT ══════════════ */
  async function bootApp() {
    applyAdminNav();
    await Promise.all([loadMarket(), loadUniverse(), loadLatest(), loadWatchlist()]);
    render();
    connectSSE();
    // live refresh loop
    setInterval(loadMarket, 30000);
    setInterval(async () => {
      if (state.route === 'scanner' || state.route === 'dashboard') await loadLatest();
      if (state.route === 'dashboard') await loadWatchlist();
      if (state.route === 'paper') render();
      if (state.route === 'stock' && state.detail) openStock(state.detail);
      if (state.route !== 'backtest') render();
    }, state.market?.state === 'OPEN' ? 30000 : 180000);
    // count alerts
    setInterval(async () => {
      try {
        const rows = (await api('/alerts/history?limit=50')).alerts;
        const fresh = rows.filter((r) => Date.now() - r.ts < 3600000).length;
        const b = $('#alert-badge');
        if (b) { b.textContent = fresh; b.classList.toggle('hidden', !fresh); }
      } catch { }
    }, 60000);
  }

  async function init() {
    bindAuth(); bindNav();
    if (state.token) {
      try {
        const j = await api('/me');
        state.user = j.user;
        showAuth(false);
        bootApp();
      } catch {
        localStorage.removeItem('sa_token'); state.token = null; showAuth(true);
      }
    } else showAuth(true);
    if ('Notification' in window && Notification.permission === 'default') {
      setTimeout(() => Notification.requestPermission().catch(() => { }), 4000);
    }
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
