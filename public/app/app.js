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
    optSyms: null, optSymsLoading: false, optFilter: '',
    backtest: { symbol: 'RELIANCE', preset: 'improved', slPct: 1.5, tpPct: 3, maxBars: 25, data: null, loading: false, error: null },
    lab: {
      prompt: 'Find bullish NSE stocks using liquidity sweeps, wick rejection, bullish BOS, and an unmitigated order block. Confirm the trend using the completed 4-hour RSI. Enter after confirmation, place the stop loss below the invalidation swing, and target a 1:2 risk-reward ratio.',
      parsing: false, parsed: null, parseError: null,
      symbol: 'RELIANCE', running: false, result: null, runError: null,
      optimizing: false, optimize: null,
      wf: null, mc: null, sens: null, risklv: null,
      saving: false, strategies: [], savedLoaded: false,
    },
  };

  /* ── API ── */
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error || ('HTTP ' + res.status)); e.status = res.status; throw e; }
    return j;
  }

  function toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind; t.textContent = msg;
    $('#toast-wrap').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2600);
  }

  /* ── AUTH (email + password) ── */
  let authMode = 'login';

  function showAuth(show) {
    $('#auth-screen').classList.toggle('hidden', !show);
    $('#app').classList.toggle('hidden', show);
    const bs = $('#boot-screen'); if (bs) bs.classList.add('hidden');
  }
  function setAuthMode(m) {
    authMode = m;
    $$('.auth-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
    $('#name-field').style.display = m === 'signup' ? 'block' : 'none';
    $('#auth-submit').textContent = m === 'signup' ? 'Create account' : 'Sign in';
    $('#auth-error').textContent = '';
  }
  function bindAuth() {
    $$('.auth-tabs .tab').forEach((b) => (b.onclick = () => setAuthMode(b.dataset.tab)));
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
        } else {
          $('#auth-error').textContent = j.error || 'Sign-in failed';
        }
      } catch (err) {
        $('#auth-error').textContent = err.message;
      } finally { btn.disabled = false; }
    };
    $('#btn-logout').onclick = async () => {
      try { await api('/auth/logout', { method: 'POST' }); } catch { }
      localStorage.removeItem('sa_token'); state.token = null; state.user = null;
      if (state.es) state.es.close();
      location.reload();
    };

    // show / hide password
    $$('.pw-toggle').forEach((b) => {
      b.onclick = () => {
        const inp = document.getElementById(b.dataset.pw);
        if (!inp) return;
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        b.textContent = show ? '🙈' : '👁';
        b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        b.title = show ? 'Hide password' : 'Show password';
      };
    });
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
          <div style="font-weight:800;font-size:17px;margin-top:2px">${s.mode === 'LIVE' ? (s.dhanSandbox ? '🧪 LIVE (Dhan sandbox)' : '🔴 LIVE (Dhan)') : s.mode === 'SIGNAL' ? '🔔 Signals only' : '📄 Paper trading'}</div></div>
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

  function scanRowHtml(r) {
    return `
          <tr onclick="window.__sa.openStock('${esc(r.symbol)}')">
            <td><b>${esc(r.symbol)}</b>${r.fno ? ' <span class="pill fno">F&O</span>' : ''}<div class="tiny muted symname">${esc((r.name || '').slice(0, 22))}</div></td>
            <td>${inr(r.price, r.price < 1000 ? 2 : 1)}</td>
            <td class="${(r.changePct ?? 0) >= 0 ? 'u' : 'd'}">${pct(r.changePct)}</td>
            <td class="${r.rsi4h != null && r.rsi4h < 50 ? 'a' : ''}">${r.rsi4h ?? '—'}</td>
            <td>${r.volRatio ?? '—'}</td>
            <td>${r.lastSignal ? '<span class="pill buy">BUY</span>' : r.wickLast ? '<span class="pill watch">Wick</span>' : '<span class="pill none">—</span>'}</td>
            <td>${r.trend === 'UP' ? '<span class="u">▲ up</span>' : r.trend === 'DOWN' ? '<span class="d">▼ down</span>' : '<span class="tiny muted">—</span>'}${r.score ? ` <span class="tiny muted">${r.score}%</span>` : ''}${r.mtf && r.mtf.alignment === 'BULL' ? ' <span class="pill buy">MTF▲</span>' : r.mtf && r.mtf.alignment === 'BEAR' ? ' <span class="pill sell">MTF▼</span>' : ''}</td>
            <td class="tiny muted">${r.activeZones?.length ? r.activeZones.length + ' live' : '—'}</td>
          </tr>`;
  }
  const SCAN_TH = 80;    // above this many rows, switch to a virtual (windowed) list
  const SCAN_ROW = 54;   // fixed row height (px) used by the virtual list

  // Virtual scrolling: only the rows intersecting the viewport (+overscan) live in
  // the DOM, so universes of thousands stay smooth. Scroll offset is kept in state
  // so it survives the SPA's full re-renders (e.g. the 30s market refresh).
  let scanVRaf = 0;
  function wireScanVirtual() {
    const wrap = document.getElementById('scan-vwrap');
    const tb = document.getElementById('scan-tbody');
    if (!wrap || !tb) return;
    const rows = state.scanFiltered || [];
    const total = rows.length;
    if (!total) { tb.innerHTML = `<tr><td colspan="8" class="empty">No rows match. Run a scan first.</td></tr>`; return; }
    const viewH = wrap.clientHeight || 460;
    const span = Math.ceil(viewH / SCAN_ROW) + 12;
    // Render the window for a given scroll offset. We paint first (so the spacer
    // rows give the scroller its full height) and only then set scrollTop —
    // otherwise the offset clamps to 0 while the table is still short.
    const paint = (offset) => {
      const start = Math.max(0, Math.min(total - 1, Math.floor(offset / SCAN_ROW) - 6));
      const end = Math.min(total, start + span);
      const topH = start * SCAN_ROW;
      const botH = Math.max(0, (total - end) * SCAN_ROW);
      tb.innerHTML =
        `<tr class="vspacer" aria-hidden="true"><td colspan="8" style="height:${topH}px"></td></tr>` +
        rows.slice(start, end).map(scanRowHtml).join('') +
        `<tr class="vspacer" aria-hidden="true"><td colspan="8" style="height:${botH}px"></td></tr>`;
      state.scanScrollTop = offset;
    };
    const initial = state.scanScrollTop || 0;
    paint(initial);
    if (initial) wrap.scrollTop = initial;
    wrap.addEventListener('scroll', () => {
      if (scanVRaf) return;
      scanVRaf = requestAnimationFrame(() => { scanVRaf = 0; paint(wrap.scrollTop); });
    }, { passive: true });
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
    });
    state.scanFiltered = filtered;
    const head = `<thead><tr><th>Symbol</th><th>Price</th><th>Chg%</th><th>4H RSI</th><th>Vol×</th><th>Signal</th><th>Trend</th><th>Zone</th></tr></thead>`;
    const tableBlock = filtered.length > SCAN_TH
      ? `<div class="tbl-wrap scan-vwrap" id="scan-vwrap"><table class="scan-v">${head}<tbody id="scan-tbody"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody></table></div>`
      : `<div class="tbl-wrap"><table>${head}<tbody>${
          filtered.length ? filtered.map(scanRowHtml).join('') : `<tr><td colspan="8" class="empty">No rows match. Run a scan first.</td></tr>`
        }</tbody></table></div>`;
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

    ${tableBlock}
    <p class="tiny muted" style="text-align:center;margin:8px 14px 20px">Showing ${filtered.length} of ${rows.length} cached rows${filtered.length > SCAN_TH ? ' · virtual list' : ''} · live data ${state.market?.state === 'OPEN' ? 'refreshing every 30s' : 'updates on next scan'}</p>`;
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
      <div class="row between wrap" style="gap:10px">
        <div><div class="tiny muted">Mode</div><b>${data.mode === 'LIVE' ? '🔴 LIVE' : '📄 Paper'}</b></div>
        <div><div class="tiny muted">Capital</div><b>${inr(data.capital)}</b></div>
        <div><div class="tiny muted">Realized P&L</div><b style="color:${stats.netPnl >= 0 ? 'var(--up)' : 'var(--down)'}">${stats.netPnlFmt}</b></div>
        <div><div class="tiny muted">Open P&L</div><b style="color:${data.unrealizedPnl >= 0 ? 'var(--up)' : 'var(--down)'}">${data.unrealizedPnlFmt}</b></div>
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
        <td>${t.qty}</td><td>${inr(t.entry_price, 2)}</td><td>${t.ltp == null ? '<span class="tiny muted">no quote</span>' : inr(t.ltp, 2)}</td>
        <td class="${t.pnl == null ? 'tiny muted' : (t.pnl >= 0 ? 'u' : 'd')}">${t.pnl == null ? '—' : t.pnlFmt + '<div class="tiny">' + pct(t.pnlPct) + '</div>'}</td>
        <td><button class="btn sm red" onclick="window.__sa.paperClose(${t.id},${t.ltp == null ? 'null' : t.ltp})">Exit</button></td></tr>`).join('')}
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
  // Every option-eligible underlying (indices + all F&O stocks), filtered by the
  // typed query so the user can search the whole list by symbol or company name.
  function optMatches(q) {
    const s = state.optSyms || { indices: OPT_QUICK.map((x) => ({ symbol: x, name: '' })), stocks: [] };
    const ql = String(q == null ? state.optFilter : q).trim().toLowerCase();
    const hit = (r) => !ql || r.symbol.toLowerCase().includes(ql) || (r.name || '').toLowerCase().includes(ql);
    return { indices: (s.indices || []).filter(hit), stocks: (s.stocks || []).filter(hit) };
  }
  function optDatalist() {
    const m = optMatches();
    return m.indices.concat(m.stocks).map((r) => `<option value="${esc(r.symbol)}">${esc(r.name || r.symbol)}</option>`).join('');
  }
  function optOptionsHtml() {
    const m = optMatches();
    const sel = state.options.symbol;
    const opt = (r) => `<option value="${esc(r.symbol)}"${r.symbol === sel ? ' selected' : ''}>${esc(r.symbol)}${r.name ? ' — ' + esc(r.name) : ''}</option>`;
    const chosen = m.indices.concat(m.stocks).some((r) => r.symbol === sel);
    return '<option value="">— choose a stock —</option>'
      + (m.indices.length ? `<optgroup label="Indices">${m.indices.map(opt).join('')}</optgroup>` : '')
      + (m.stocks.length ? `<optgroup label="F&O stocks (${m.stocks.length})">${m.stocks.map(opt).join('')}</optgroup>` : '')
      + (!chosen && sel ? `<option value="${esc(sel)}" selected>${esc(sel)}</option>` : '');
  }
  function renderOptions() {
    const o = state.options;
    const ready = state.optSyms ? state.optSyms.total : null;
    return `
    <div class="card" style="margin-top:14px">
      <div class="row between wrap" style="gap:10px">
        <div><b>Option chain</b><div class="tiny muted">Real NSE data — Dhan when you add a key, otherwise the free public NSE feed</div></div>
        <span class="pill ${o.source === 'Dhan' ? 'fno' : 'none'}" id="opt-src">${o.data ? 'source: ' + o.data.source : 'source: —'}</span>
      </div>
      <div class="row wrap" style="gap:8px;margin-top:12px;align-items:center">
        <input id="opt-sym" list="opt-syms" placeholder="Index or F&O stock (e.g. NIFTY, RELIANCE)" style="flex:1;min-width:180px" value="${esc(o.symbol)}" onkeydown="if(event.key==='Enter')window.__sa.loadOptions()">
        <datalist id="opt-syms">${optDatalist()}</datalist>
        ${OPT_QUICK.map((s) => `<button class="btn sm ${o.symbol === s ? 'primary' : ''}" onclick="window.__sa.setOptSymbol('${s}')">${s}</button>`).join('')}
        <button class="btn sm" onclick="window.__sa.loadOptions()">⟳ Load</button>
      </div>
      <div class="row wrap" style="gap:8px;margin-top:8px;align-items:center">
        <span class="tiny muted">All stocks</span>
        <input id="opt-filter" placeholder="Filter by name or symbol…" style="flex:0 0 180px" value="${esc(state.optFilter || '')}" oninput="window.__sa.filterOptSyms(this.value)" aria-label="Filter stocks">
        <select id="opt-pick" style="flex:1;min-width:200px" onchange="if(this.value)window.__sa.setOptSymbol(this.value)" aria-label="Choose a stock">
          ${optOptionsHtml()}
        </select>
        <span class="tiny muted" id="opt-count">${ready != null ? ready + ' F&O stocks' : 'loading list…'}</span>
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
      <p class="tiny muted" style="margin:10px 0 0">Paper uses live NSE/BSE prices with virtual money. Live sends real orders through your Dhan API key — orders are <b>simulated</b> while "Dhan sandbox (test)" is on, so no real money moves.</p>
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

    <div class="section-title"><h2>Alerts</h2></div>
    <div class="card">
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
      <div class="set-row"><span class="lbl">Dhan sandbox (test)<small>Simulated orders — no real money</small></span><label class="switch"><input type="checkbox" ${s.dhanSandbox ? 'checked' : ''} onchange="window.__sa.setSetting('dhanSandbox',this.checked)"><i></i></label></div>
      <div class="set-row"><span class="lbl">Test connection</span><button class="btn sm" onclick="window.__sa.dhanTest()">Test</button></div>
      <p class="tiny muted" style="margin-top:8px">Keys are free from <b>DhanHQ → API</b> (production) or the <b>Dhan sandbox portal</b> (test). In sandbox mode, orders and the connection test hit <b>api-sandbox.dhan.co</b> and fills are simulated. Production orders touch a real broker — they stay OFF until you pick <b>LIVE mode</b> above, enable live orders, are not in sandbox, and pass the risk checks.</p>
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
    </div>
    <div class="section-title"><h2>Data provider</h2><button class="btn sm" onclick="window.__sa.adminHealth()">Run health check</button></div>
    <div class="card" id="admin-health"><div class="tiny muted">Run a live provider probe for the latest status.</div></div>`;
  }

  function adminUsers(users) {
    return `
    <div class="section-title"><h2>Accounts</h2><span class="tiny muted">${users.length} total</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Trades</th><th>Signals</th><th>Joined</th><th>Actions</th></tr></thead><tbody>
      ${users.map((u) => `<tr>
        <td><b>${esc(u.email)}</b><div class="tiny muted">${esc(u.displayName || '')}</div></td>
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
  /* ── STRATEGY LAB ── */
  const opSym = (op) => ({ gt: '>', gte: '≥', lt: '<', lte: '≤' }[op] || op);
  function condText(c) {
    switch (c.kind) {
      case 'rsi': return `RSI(${c.period}) ${opSym(c.op)} ${c.value}${c.tf ? ' on ' + c.tf : ''}`;
      case 'htf_rsi': return `${(c.tf || 'HTF').toUpperCase()} RSI(${c.period}) ${opSym(c.op)} ${c.value}`;
      case 'ma_cross': return `${String(c.type).toUpperCase()} ${c.fast}/${c.slow} ${c.dir === 'bear' ? 'bearish' : 'bullish'} cross`;
      case 'price_vs_ma': return `price ${c.side} ${String(c.type).toUpperCase()}(${c.len})`;
      case 'wick_rejection': return `${c.dir === 'bear' ? 'Bearish' : 'Bullish'} wick rejection`;
      case 'order_block': return `${c.dir === 'bear' ? 'Bearish' : 'Bullish'} order block${c.unmitigated ? ' (unmitigated)' : ''}`;
      case 'fvg': return `${c.dir === 'bear' ? 'Bearish' : 'Bullish'} fair value gap`;
      case 'bos': return `break of structure (${c.dir})`;
      case 'choch': return `change of character (${c.dir})`;
      case 'liquidity_sweep': return `${c.side === 'buyside' ? 'Buy-side' : 'Sell-side'} liquidity sweep`;
      case 'htf_trend': return `${(c.tf || 'HTF').toUpperCase()} trend ${c.align}`;
      case 'candle_pattern': return `${c.pattern} (${c.dir})`;
      case 'volume': return `volume > ${c.mult}× avg(${c.period})`;
      default: return c.kind;
    }
  }
  const stopText = (s) => !s ? '—' : s.kind === 'pct' ? `${s.pct}%` : s.kind === 'atr' ? `${s.atrMult}×ATR(${s.atrPeriod})` : s.kind === 'swing' ? 'below/above invalidation swing' : s.kind === 'ob' ? 'beyond order block' : s.kind;
  const targetText = (t) => !t ? '—' : t.kind === 'rr' ? `1:${t.rr} R` : t.kind === 'pct' ? `${t.pct}%` : t.kind === 'atr' ? `${t.atrMult}×ATR` : 'no target (exit by stop/time)';
  const bullets = (items) => (items || []).map((x) => `<li>${esc(x)}</li>`).join('');

  function labSpecCard(p) {
    const s = p.spec || {};
    const d = p.diagnostics || {};
    return `
    <div class="section-title"><h2>Interpreted strategy</h2><span class="pill ${p.valid ? 'buy' : 'none'}">${p.valid ? 'valid' : 'needs attention'}</span></div>
    <div class="card">
      <div class="row wrap" style="gap:16px;align-items:flex-start">
        <div style="flex:1 1 200px">
          <div class="tiny muted">Name</div><b>${esc(s.name || 'Untitled')}</b>
          <div class="tiny muted" style="margin-top:6px">Timeframe</div><b>${esc(String(s.timeframe || '1d').toUpperCase())}${s.higherTimeframe ? ' · HTF ' + esc(String(s.higherTimeframe).toUpperCase()) : ''}</b>
          <div class="tiny muted" style="margin-top:6px">Direction</div><b>${esc(s.universe ? s.universe.direction : 'long')}</b>
        </div>
        <div style="flex:1.4 1 240px"><div class="tiny muted">Entry (${(s.entry || []).length})</div>
          <ul class="tiny" style="margin:4px 0 0 16px">${(s.entry || []).map((c) => `<li>${esc(condText(c))}</li>`).join('') || '<li class="muted">none</li>'}</ul>
          ${(s.filters || []).length ? `<div class="tiny muted" style="margin-top:6px">Filters</div><ul class="tiny" style="margin:4px 0 0 16px">${s.filters.map((c) => `<li>${esc(condText(c))}</li>`).join('')}</ul>` : ''}
        </div>
        <div style="flex:1 1 200px"><div class="tiny muted">Risk</div>
          <div>Stop: <b>${esc(stopText(s.stopLoss))}</b></div>
          <div>Target: <b>${esc(targetText(s.takeProfit))}</b></div>
          <div>Risk/trade: <b>${s.riskPct}%</b> · Max positions: <b>${s.maxPositions}</b></div>
          <div>Max bars: <b>${s.maxBars}</b> · Capital: <b>${inr(s.capital)}</b></div>
        </div>
      </div>
    </div>
    ${(!p.valid && p.errors && p.errors.length) ? `<div class="card"><div class="tiny d">Fix before running:</div><ul class="tiny" style="margin:6px 0 0 16px">${bullets(p.errors)}</ul></div>` : ''}
    ${(d.unsupported && d.unsupported.length) ? `<div class="card"><div class="tiny d">Not supported (reported, not used):</div><ul class="tiny" style="margin:6px 0 0 16px">${bullets(d.unsupported)}</ul></div>` : ''}
    ${(d.ambiguous && d.ambiguous.length) ? `<div class="card"><div class="tiny">Assumptions made:</div><ul class="tiny" style="margin:6px 0 0 16px">${bullets(d.ambiguous)}</ul></div>` : ''}`;
  }

  function labCoverage(c) {
    if (!c) return '';
    return `<div class="card"><div class="row between tiny muted"><span>Provider: <b style="color:var(--txt)">${esc(c.provider)}</b> · ${esc(String(c.timeframe || '').toUpperCase())}</span><span>${c.candles} verified candles</span></div>
      <div class="row between tiny muted" style="margin-top:4px"><span>${c.firstCandleTs ? dtDate(c.firstCandleTs) : '—'} → ${c.lastCandleTs ? dtDate(c.lastCandleTs) : '—'}</span>${c.rejectedCandles ? `<span class="d">${c.rejectedCandles} invalid candles dropped</span>` : '<span class="u">structure validated</span>'}</div>
      ${(c.notes && c.notes.length) ? `<ul class="tiny" style="margin:6px 0 0 16px">${bullets(c.notes)}</ul>` : ''}</div>`;
  }

  function labMcCard(mc) {
    if (!mc) return '';
    if (mc.ok === false) return `<div class="card empty"><div class="big">🎲</div>${esc(mc.error || 'Monte Carlo unavailable.')}</div>`;
    return `<div class="section-title"><h2>Monte Carlo</h2><span class="tiny muted">${mc.iterations} bootstrap runs · model-based estimate</span></div>
    <div class="stats-grid">
      ${stat('Median final', inrC(mc.medianFinal), mc.medianFinal >= mc.capital ? 'u' : 'd')}
      ${stat('5th–95th %ile', inrC(mc.p5Final) + ' → ' + inrC(mc.p95Final))}
      ${stat('P(profit)', mc.probProfitPct + '%', mc.probProfitPct >= 50 ? 'u' : 'd')}
      ${stat('Median max DD', mc.medianMaxDdPct + '%', 'd')}
      ${stat('95th %ile DD', mc.p95MaxDdPct + '%', 'd')}
      ${stat('P(ruin)', mc.ruinProbabilityPct + '%', mc.ruinProbabilityPct > 0 ? 'd' : 'u')}
    </div>
    <div class="card"><div class="tiny muted">Assumptions: ${mc.assumptions.map((a) => esc(a)).join(' ')}</div></div>`;
  }

  function labRunCard(r) {
    const s = r.stats || {};
    const noTrades = !s.totalTrades;
    const eqKind = (s.netPnl || 0) >= 0 ? 'u' : 'd';
    return `
    ${labCoverage(r.coverage)}
    <div class="section-title"><h2>${esc(r.symbol)} — backtest</h2><span class="pill ${noTrades ? 'none' : 'buy'}">${s.totalTrades || 0} trades · real data</span></div>
    <div class="stats-grid">
      ${stat('Trades', s.totalTrades)}
      ${stat('Win rate', s.winRate == null ? '—' : s.winRate + '%', s.winRate >= 50 ? 'u' : s.totalTrades ? 'd' : '')}
      ${stat('Profit factor', s.profitFactor == null ? '—' : s.profitFactor, s.profitFactor >= 1.5 ? 'u' : s.profitFactor != null && s.profitFactor < 1 ? 'd' : '')}
      ${stat('Net P&L', inrC(s.netPnl), eqKind)}
      ${stat('Net %', pct(s.netPnlPct), eqKind)}
      ${stat('Expectancy', s.expectancy == null ? '—' : inr(s.expectancy), s.expectancy >= 0 ? 'u' : 'd')}
      ${stat('Avg R', s.avgRMultiple == null ? '—' : s.avgRMultiple, s.avgRMultiple >= 0 ? 'u' : 'd')}
      ${stat('Realized RR', s.realizedRR == null ? '—' : '1:' + s.realizedRR)}
      ${stat('Max DD %', s.maxDrawdown ? s.maxDrawdown.pct + '%' : '—', 'd')}
      ${stat('Costs', inrC(s.totalCosts))}
    </div>
    ${noTrades ? `<div class="card empty"><div class="big">🔍</div>No closed trades in this window. The rules are selective — try a different instrument, a longer history, or relax a condition.</div>` : `
    <div class="section-title"><h2>Equity &amp; drawdown</h2><span class="tiny muted">${(r.equityCurve || []).length - 1} closed trades</span></div>
    <div class="card"><canvas id="lab-equity" style="width:100%;height:230px;display:block"></canvas></div>`}
    ${r.risk ? `<div class="section-title"><h2>Risk profile</h2><span class="tiny muted">from the actual trade ledger</span></div>
    <div class="stats-grid">
      ${stat('Mean R', r.risk.meanR == null ? '—' : r.risk.meanR, r.risk.meanR >= 0 ? 'u' : 'd')}
      ${stat('Median R', r.risk.medianR == null ? '—' : r.risk.medianR)}
      ${stat('Std dev R', r.risk.stdevR == null ? '—' : r.risk.stdevR)}
      ${stat('Worst R', r.risk.minR == null ? '—' : r.risk.minR, 'd')}
      ${stat('Best R', r.risk.maxR == null ? '—' : r.risk.maxR, 'u')}
      ${stat('Top-5 profit share', r.risk.profitConcentrationTop5Pct == null ? '—' : r.risk.profitConcentrationTop5Pct + '%')}
    </div>` : ''}
    ${labMcCard(r.monteCarlo)}
    <div class="section-title"><h2>Trade statistics</h2><span class="tiny muted">every figure from simulated trades</span></div>
    <div class="card"><div class="set-row"><span class="lbl">Wins / Losses / Breakeven</span><b>${s.wins || 0} / ${s.losses || 0} / ${s.breakeven || 0}</b></div>
      <div class="set-row"><span class="lbl">Avg win / Avg loss</span><b class="u">${inr(s.avgWin)}</b> / <b class="d">${inr(s.avgLoss)}</b></div>
      <div class="set-row"><span class="lbl">Gross profit / loss</span><b class="u">${inr(s.grossProfit)}</b> / <b class="d">${inr(s.grossLoss)}</b></div>
      <div class="set-row"><span class="lbl">Largest win / loss</span><b class="u">${inr(s.largestWin)}</b> / <b class="d">${inr(s.largestLoss)}</b></div>
      <div class="set-row"><span class="lbl">Max consecutive wins / losses</span><b>${s.maxConsecutiveWins || 0} / ${s.maxConsecutiveLosses || 0}</b></div>
      <div class="set-row"><span class="lbl">Avg holding (bars)</span><b>${s.avgHoldingBars == null ? '—' : s.avgHoldingBars}</b></div>
      <div class="set-row"><span class="lbl">Planned R:R</span><b>${s.plannedRR == null ? '—' : '1:' + s.plannedRR}</b></div>
    </div>
    ${r.report ? `<div class="section-title"><h2>Strategy report</h2><span class="tiny muted">${esc(r.report.method)} · every number computed, none invented</span></div>
      ${r.report.segments.map((seg) => `<div class="card"><div class="tiny muted">${esc(seg.q)}</div><div style="margin-top:4px">${esc(seg.a)}</div></div>`).join('')}` : ''}
    <div class="section-title"><h2>Trade history</h2><span class="tiny muted">${(r.trades || []).length} closed</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Entry Px</th><th>Exit Px</th><th>Stop</th><th>Target</th><th>Bars</th><th>Reason</th><th>P&amp;L</th><th>R</th></tr></thead><tbody>
      ${(r.trades || []).map((t) => `<tr><td>${t.seq}</td><td>${t.dir === 'long' ? '▲' : '▼'}</td><td>${dt(t.entryTs)}</td><td>${dt(t.exitTs)}</td><td>${inr(t.entry, 2)}</td><td>${inr(t.exit, 2)}</td><td>${inr(t.stop, 2)}</td><td>${t.target == null ? '—' : inr(t.target, 2)}</td><td>${t.barsHeld}</td><td>${esc(t.reason)}</td><td class="${t.netPnl >= 0 ? 'u' : 'd'}">${inrC(t.netPnl)}</td><td class="${t.rMultiple >= 0 ? 'u' : 'd'}">${t.rMultiple == null ? '—' : t.rMultiple + 'R'}</td></tr>`).join('') || '<tr><td colspan="12" class="empty">No trades</td></tr>'}
    </tbody></table></div>`;
  }

  function labOptimizeCard(o) {
    if (!o || o.ok === false) return `<div class="card empty"><div class="big">🧪</div>${esc((o && o.error) || 'Optimizer unavailable.')}</div>`;
    return `<div class="section-title"><h2>Optimizer (in-sample → out-of-sample)</h2><span class="tiny muted">${o.combosTested} combinations · ${o.trainBars} IS / ${o.oosBars} OOS bars</span></div>
    <div class="card"><div class="tiny muted">${esc(o.method)}</div></div>
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Parameters</th><th>IS trades</th><th>IS net%</th><th>OOS trades</th><th>OOS net%</th><th>OOS PF</th><th>OOS avg R</th></tr></thead><tbody>
      ${(o.ranked || []).map((x) => `<tr><td>${x.rank}</td><td class="tiny">${esc(JSON.stringify(x.params))}</td><td>${x.is.trades}</td><td class="${x.is.netPnlPct >= 0 ? 'u' : 'd'}">${pct(x.is.netPnlPct)}</td><td>${x.oos ? x.oos.trades : '—'}</td><td class="${x.oos && x.oos.netPnl >= 0 ? 'u' : 'd'}">${x.oos ? pct(x.oos.netPnlPct) : '—'}</td><td>${x.oos && x.oos.profitFactor != null ? x.oos.profitFactor : '—'}</td><td>${x.oos && x.oos.avgRMultiple != null ? x.oos.avgRMultiple : '—'}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No combinations produced trades.</td></tr>'}
    </tbody></table></div>
    <div class="card"><div class="tiny muted">${esc(o.note || '')}</div></div>`;
  }

  function labWfCard(wf) {
    if (!wf) return '';
    if (wf.ok === false) return `<div class="card empty"><div class="big">🧭</div>${esc(wf.error || 'Walk-forward unavailable.')}</div>`;
    const ag = wf.aggregate || {};
    return `<div class="section-title"><h2>Walk-forward validation</h2><span class="tiny muted">${ag.windowsScored || 0} unseen windows</span></div>
    <div class="stats-grid">
      ${stat('OOS trades', ag.oosTradesTotal == null ? '—' : ag.oosTradesTotal)}
      ${stat('OOS net P&L', inrC(ag.oosNetPnlTotal), ag.oosNetPnlTotal >= 0 ? 'u' : 'd')}
      ${stat('Profitable windows', ag.oosPositiveWindowsPct == null ? '—' : ag.oosPositiveWindowsPct + '%', ag.oosPositiveWindowsPct >= 50 ? 'u' : 'd')}
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>Window</th><th>Params</th><th>IS trades</th><th>OOS trades</th><th>OOS net</th></tr></thead><tbody>
      ${(wf.windows || []).map((w) => `<tr><td>${w.window}${w.skipped ? ' (skipped)' : ''}</td><td class="tiny">${w.params ? esc(JSON.stringify(w.params)) : '—'}</td><td>${w.is ? w.is.trades : '—'}</td><td>${w.oos ? w.oos.trades : '—'}</td><td class="${w.oos && w.oos.netPnl >= 0 ? 'u' : 'd'}">${w.oos ? inrC(w.oos.netPnl) : '—'}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><div class="tiny muted">${esc(wf.note || '')}</div></div>`;
  }

  function labSensCard(sn) {
    if (!sn || sn.ok === false) return `<div class="card empty"><div class="big">📐</div>${esc((sn && sn.error) || 'Sensitivity unavailable.')}</div>`;
    return `<div class="section-title"><h2>Stop × target sensitivity</h2><span class="tiny muted">full spread of outcomes</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Stop ${esc(sn.stopKind)}</th><th>R:R</th><th>Trades</th><th>Net P&amp;L</th><th>PF</th><th>Expectancy</th><th>Max DD%</th></tr></thead><tbody>
      ${sn.cells.map((c) => `<tr><td>${c.stop}</td><td>1:${c.rr}</td><td>${c.trades}</td><td class="${c.netPnl >= 0 ? 'u' : 'd'}">${inrC(c.netPnl)}</td><td>${c.profitFactor == null ? '—' : c.profitFactor}</td><td>${c.expectancy == null ? '—' : inr(c.expectancy)}</td><td class="d">${c.maxDrawdownPct == null ? '—' : c.maxDrawdownPct + '%'}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><div class="tiny muted">${esc(sn.note)}</div></div>`;
  }

  function labRiskCard(rl) {
    if (!rl || rl.ok === false) return `<div class="card empty"><div class="big">⚖️</div>${esc((rl && rl.error) || 'Risk-level comparison unavailable.')}</div>`;
    return `<div class="section-title"><h2>Risk-per-trade comparison</h2><span class="tiny muted">position sizing effect</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Risk/trade</th><th>Trades</th><th>Net P&amp;L</th><th>Net %</th><th>PF</th><th>Expectancy</th><th>Max DD%</th></tr></thead><tbody>
      ${rl.levels.map((l) => `<tr><td>${l.riskPct}%</td><td>${l.trades}</td><td class="${l.netPnl >= 0 ? 'u' : 'd'}">${inrC(l.netPnl)}</td><td class="${l.netPnlPct >= 0 ? 'u' : 'd'}">${pct(l.netPnlPct)}</td><td>${l.profitFactor == null ? '—' : l.profitFactor}</td><td>${l.expectancy == null ? '—' : inr(l.expectancy)}</td><td class="d">${l.maxDrawdownPct == null ? '—' : l.maxDrawdownPct + '%'}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><div class="tiny muted">${esc(rl.note)}</div></div>`;
  }

  function labSavedCard() {
    const L = state.lab;
    return `<div class="section-title"><h2>Saved strategies</h2><span class="tiny muted">${L.strategies.length} saved</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Version</th><th>Updated</th><th></th></tr></thead><tbody>
      ${L.strategies.map((s) => `<tr><td>${esc(s.name)}</td><td>v${s.current_ver}</td><td class="tiny muted">${dt(s.updated_at)}</td><td class="right"><button class="btn sm" onclick="window.__sa.labOpen(${s.id})">Load</button> <button class="btn sm" onclick="window.__sa.labDelete(${s.id})">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No saved strategies yet</td></tr>'}
    </tbody></table></div>`;
  }

  function renderLab() {
    const L = state.lab;
    const p = L.parsed;
    const hasSpec = !!(p && p.spec);
    return `
    <div class="section-title"><h2>Strategy Lab</h2><span class="tiny muted">Plain English → validated rules → real-data backtest · ₹0, no fake data</span></div>
    <div class="card">
      <label style="display:block">Describe your strategy
        <textarea id="lab-prompt" rows="3" style="width:100%;margin-top:6px" placeholder="e.g. Bullish NSE stocks with a liquidity sweep, wick rejection and an unmitigated order block, stop below the swing low, target 1:2">${esc(L.prompt)}</textarea>
      </label>
      <div class="row wrap" style="gap:10px;align-items:flex-end;margin-top:8px">
        <label style="flex:0 0 170px">Instrument (NSE)<input id="lab-symbol" value="${esc(L.symbol)}" placeholder="RELIANCE / NIFTY" /></label>
        <button class="btn" onclick="window.__sa.labParse()" ${L.parsing ? 'disabled' : ''}>${L.parsing ? 'Interpreting…' : '🧠 Interpret'}</button>
        <button class="btn primary" onclick="window.__sa.labRun()" ${(!hasSpec || L.running) ? 'disabled' : ''}>${L.running ? 'Backtesting…' : '▶ Run backtest'}</button>
        <button class="btn sm" onclick="window.__sa.labLoadSaved()">Saved strategies</button>
      </div>
      <div class="tiny muted" style="margin-top:6px">The interpreter is deterministic and offline — it maps your words to a fixed rule vocabulary and reports anything it cannot support. It never invents prices, signals or results.</div>
    </div>
    ${L.parseError ? `<div class="card empty"><div class="big">⚠️</div>${esc(L.parseError)}</div>` : ''}
    ${p ? labSpecCard(p) : ''}
    ${hasSpec ? `<div class="row wrap" style="gap:8px;margin:2px 0 10px">
      <button class="btn sm" onclick="window.__sa.labOptimize()" ${L.optimizing ? 'disabled' : ''}>${L.optimizing ? 'Optimizing…' : '🧪 Optimize (IS/OOS)'}</button>
      <button class="btn sm" onclick="window.__sa.labWF()">🧭 Walk-forward</button>
      <button class="btn sm" onclick="window.__sa.labMC()">🎲 Monte Carlo</button>
      <button class="btn sm" onclick="window.__sa.labSens()">📐 Sensitivity</button>
      <button class="btn sm" onclick="window.__sa.labRisk()">⚖️ Risk levels</button>
      <button class="btn sm" onclick="window.__sa.labSave()" ${L.saving ? 'disabled' : ''}>💾 ${L.saving ? 'Saving…' : 'Save strategy'}</button>
    </div>` : ''}
    ${L.runError ? `<div class="card empty"><div class="big">⚠️</div>${esc(L.runError)}</div>` : ''}
    ${L.running ? `<div class="card empty"><div class="big">⏳</div>Loading verified history and running the engine…</div>` : ''}
    ${L.result ? labRunCard(L.result) : ''}
    ${L.optimize ? labOptimizeCard(L.optimize) : ''}
    ${L.wf ? labWfCard(L.wf) : ''}
    ${L.sens ? labSensCard(L.sens) : ''}
    ${L.risklv ? labRiskCard(L.risklv) : ''}
    ${L.savedLoaded ? labSavedCard() : ''}`;
  }

  function drawLabEquity() {
    const cv = $('#lab-equity'); if (!cv) return;
    const r = state.lab.result; if (!r) return;
    const eq = (r.equityCurve || []).map((p) => p.equity);
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 320, H = cv.clientHeight || 230;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(148,163,184,.14)'; ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++) { const y = (H / 4) * g; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    if (eq.length < 2) { ctx.fillStyle = '#6b7896'; ctx.font = '12px Segoe UI,system-ui'; ctx.textAlign = 'center'; ctx.fillText('Need ≥2 closed trades to plot', W / 2, H / 2); return; }
    let lo = Math.min(...eq), hi = Math.max(...eq);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const x = (i) => (i / (eq.length - 1)) * W;
    const y = (v) => H - ((v - lo) / (hi - lo)) * H;
    const up = eq[eq.length - 1] >= eq[0];
    const col = up ? '#22c55e' : '#f43f5e';
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, up ? 'rgba(34,197,94,.28)' : 'rgba(244,63,94,.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.moveTo(x(0), y(eq[0]));
    eq.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); eq.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#93a1bd'; ctx.font = '10px Segoe UI,system-ui'; ctx.textAlign = 'left';
    ctx.fillText(inrC(hi), 4, 12); ctx.fillText(inrC(lo), 4, H - 4);
  }

  async function render() {
    const v = $('#view');
    const route = state.route;
    if (route === 'dashboard') v.innerHTML = renderDashboard();
    else if (route === 'scanner') { v.innerHTML = renderScanner(); wireScanVirtual(); }
    else if (route === 'backtest') { v.innerHTML = renderBacktest(); if (state.backtest.data) setTimeout(drawBacktest, 20); }
    else if (route === 'lab') { v.innerHTML = renderLab(); if (state.lab.result && state.lab.result.equityCurve) setTimeout(drawLabEquity, 20); }
    else if (route === 'options') { v.innerHTML = renderOptions(); if (!state.optSyms) setTimeout(actions.loadOptSyms, 20); if (!state.options.data && !state.options.loading && !state.options.error) setTimeout(actions.loadOptions, 40); }
    else if (route === 'stock') v.innerHTML = renderStock();
    else if (route === 'paper') v.innerHTML = await renderPaper();
    else if (route === 'alerts') v.innerHTML = await renderAlerts();
    else if (route === 'settings') { v.innerHTML = renderSettings(); if (state.user.isAdmin) setTimeout(actions.provLoad, 30); }
    else if (route === 'admin') { v.innerHTML = await renderAdmin(); actions.adminJobs(); }
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
    bootRetry() {
      const bs = $('#boot-screen'); if (bs) bs.classList.add('hidden');
      const m = $('#boot-msg'); if (m) m.textContent = 'Connecting to the server…';
      if (state.token) tryResume(3); else showAuth(true);
    },
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
      const inp = $('#opt-sym'); if (inp) inp.value = state.options.symbol;   // keep the text box in sync
      actions.loadOptions();
    },
    async loadOptSyms() {
      if (state.optSyms || state.optSymsLoading) return;
      state.optSymsLoading = true;
      try { state.optSyms = await api('/underlyings'); }
      catch { state.optSyms = { indices: [], stocks: [], total: 0 }; }
      finally { state.optSymsLoading = false; render(); }
    },
    filterOptSyms(v) {
      state.optFilter = String(v || '');
      const sel = $('#opt-pick');
      if (sel) sel.innerHTML = optOptionsHtml();
      const c = $('#opt-count');
      if (c) c.textContent = (optMatches().indices.length + optMatches().stocks.length) + ' shown';
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
    setPreset(p) { state.scanPreset = p; state.scanScrollTop = 0; render(); },
    filter(patch) { Object.assign(state.scanFilter, patch); state.scanScrollTop = 0; render(); },
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
      try {
        const j = await api('/paper/close', { method: 'POST', body: { id, price: price || undefined } });
        toast('Position closed · P&L ' + (j.pnlFmt || (j.trade && j.trade.pnl)), 'ok');
        render();
      } catch (e) { toast(e.message, 'err'); }
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
    async dhanTest() {
      try { const j = await api('/dhan/test', { method: 'POST' }); toast(j.ok ? 'Dhan connected (' + (j.env || 'PRODUCTION') + ') · funds loaded' : (j.error || 'Failed'), j.ok ? 'ok' : 'err'); }
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
          <div class="set-row"><span class="lbl">Market</span><b>${esc(j.market.state)} · ${esc(j.market.istTime)}</b></div>`;
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

    /* ── Strategy Lab ── */
    labSync() {
      const L = state.lab;
      const pEl = $('#lab-prompt'); if (pEl) L.prompt = pEl.value;
      const sEl = $('#lab-symbol'); if (sEl && sEl.value.trim()) L.symbol = sEl.value.trim().toUpperCase();
    },
    async labParse() {
      const L = state.lab; actions.labSync();
      if (!L.prompt.trim()) { toast('Describe your strategy first', 'err'); return; }
      L.parsing = true; L.parseError = null; render();
      try {
        const j = await api('/lab/parse', { method: 'POST', body: { prompt: L.prompt } });
        L.parsed = j;
        if (j.valid) toast('Strategy interpreted · ' + ((j.spec.entry || []).length) + ' entry rule(s)', 'ok');
        else toast('Parsed with ' + ((j.errors || []).length) + ' issue(s) to fix', '');
      } catch (e) { L.parsed = null; L.parseError = e.message; toast(e.message, 'err'); }
      finally { L.parsing = false; render(); }
    },
    async labRun() {
      const L = state.lab; actions.labSync();
      if (!L.parsed || !L.parsed.spec) { toast('Interpret a strategy first', 'err'); return; }
      if (L.running) return;
      L.running = true; L.runError = null; L.result = null;
      L.optimize = L.wf = L.mc = L.sens = L.risklv = null;
      render();
      try {
        const j = await api('/lab/run', { method: 'POST', body: { symbol: L.symbol, spec: L.parsed.spec } });
        if (j.ok === false) { L.runError = j.error || 'Backtest unavailable.'; toast('Backtest unavailable', ''); }
        else { L.result = j; toast(j.stats.totalTrades + ' trade(s) · net ' + inrC(j.stats.netPnl), 'ok'); }
      } catch (e) { L.runError = e.message; toast(e.message, 'err'); }
      finally { L.running = false; render(); setTimeout(drawLabEquity, 40); }
    },
    async labOptimize() {
      const L = state.lab; actions.labSync();
      if (!L.parsed || !L.parsed.spec) return;
      L.optimizing = true; render();
      try {
        const j = await api('/lab/optimize', { method: 'POST', body: { symbol: L.symbol, spec: L.parsed.spec } });
        L.optimize = j; toast(j.ok ? 'Optimizer tested ' + j.combosTested + ' combinations' : (j.error || 'Optimizer unavailable'), j.ok ? 'ok' : '');
      } catch (e) { L.optimize = { ok: false, error: e.message }; toast(e.message, 'err'); }
      finally { L.optimizing = false; render(); }
    },
    async labWF() {
      const L = state.lab; actions.labSync();
      if (!L.parsed || !L.parsed.spec) return;
      try {
        const j = await api('/lab/walkforward', { method: 'POST', body: { symbol: L.symbol, spec: L.parsed.spec } });
        L.wf = j; toast(j.ok ? 'Walk-forward complete' : (j.error || 'Walk-forward unavailable'), j.ok ? 'ok' : '');
      } catch (e) { L.wf = { ok: false, error: e.message }; toast(e.message, 'err'); }
      finally { render(); }
    },
    async labMC() {
      const L = state.lab; actions.labSync();
      if (!L.parsed || !L.parsed.spec) return;
      try {
        const j = await api('/lab/montecarlo', { method: 'POST', body: { symbol: L.symbol, spec: L.parsed.spec } });
        L.mc = j; toast(j.ok ? 'Monte Carlo complete' : (j.error || 'Monte Carlo unavailable'), j.ok ? 'ok' : '');
      } catch (e) { L.mc = { ok: false, error: e.message }; toast(e.message, 'err'); }
      finally { render(); }
    },
    async labSens() {
      const L = state.lab; actions.labSync();
      if (!L.parsed || !L.parsed.spec) return;
      try {
        const j = await api('/lab/sensitivity', { method: 'POST', body: { symbol: L.symbol, spec: L.parsed.spec } });
        L.sens = j; toast(j.ok ? 'Sensitivity grid ready' : (j.error || 'Sensitivity unavailable'), j.ok ? 'ok' : '');
      } catch (e) { L.sens = { ok: false, error: e.message }; toast(e.message, 'err'); }
      finally { render(); }
    },
    async labRisk() {
      const L = state.lab; actions.labSync();
      if (!L.parsed || !L.parsed.spec) return;
      try {
        const j = await api('/lab/risklevels', { method: 'POST', body: { symbol: L.symbol, spec: L.parsed.spec } });
        L.risklv = j; toast(j.ok ? 'Risk-level comparison ready' : (j.error || 'Risk-level comparison unavailable'), j.ok ? 'ok' : '');
      } catch (e) { L.risklv = { ok: false, error: e.message }; toast(e.message, 'err'); }
      finally { render(); }
    },
    async labSave() {
      const L = state.lab; actions.labSync();
      if (!L.parsed || !L.parsed.spec) { toast('Interpret a strategy first', 'err'); return; }
      const name = String(window.prompt('Strategy name', (L.parsed.spec && L.parsed.spec.name) || 'My strategy') || '').trim();
      if (!name) return;
      L.saving = true; render();
      try {
        const j = await api('/lab/strategies', { method: 'POST', body: { name, spec: L.parsed.spec } });
        if (j.ok) { toast('Saved "' + name + '" v' + j.version, 'ok'); L.savedLoaded = false; }
        else toast(j.error || 'Could not save', 'err');
      } catch (e) { toast(e.message, 'err'); }
      finally { L.saving = false; render(); }
    },
    async labLoadSaved() {
      const L = state.lab;
      try { const j = await api('/lab/strategies'); L.strategies = j.strategies || []; L.savedLoaded = true; toast(L.strategies.length + ' saved strateg' + (L.strategies.length === 1 ? 'y' : 'ies'), 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      render();
    },
    async labOpen(id) {
      const L = state.lab;
      try {
        const j = await api('/lab/strategies/' + id);
        if (!j.ok) { toast(j.error || 'Not found', 'err'); return; }
        L.prompt = j.strategy.name || L.prompt;
        L.parsed = { ok: true, spec: j.strategy.spec, valid: true, errors: [], warnings: [], diagnostics: {} };
        L.result = null; L.optimize = L.wf = L.mc = L.sens = L.risklv = null;
        toast('Loaded "' + j.strategy.name + '" v' + j.strategy.current_ver, 'ok');
      } catch (e) { toast(e.message, 'err'); }
      render();
    },
    async labDelete(id) {
      if (!window.confirm('Delete this saved strategy?')) return;
      const L = state.lab;
      try {
        await api('/lab/strategies/' + id, { method: 'DELETE' });
        L.strategies = (L.strategies || []).filter((s) => s.id !== id);
        toast('Strategy deleted', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      render();
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
      if (state.route !== 'backtest' && state.route !== 'lab') render();
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

  // Resume a saved session. A refresh must NOT sign the user out just because
  // the server was briefly unreachable (a free host cold-start returns 502/503,
  // not 401). We only log out on a definitive 401/403; for anything else we
  // retry with backoff and, if the server stays down, offer a Retry button.
  async function tryResume(retries = 3) {
    for (let i = 0; i <= retries; i++) {
      try {
        const j = await api('/me');
        state.user = j.user;
        showAuth(false);
        bootApp();
        return;
      } catch (e) {
        if (e.status === 401 || e.status === 403) {   // the server says the session is truly invalid
          localStorage.removeItem('sa_token'); state.token = null; showAuth(true);
          return;
        }
        if (i < retries) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      }
    }
    // Server unreachable after retries — keep the token, do NOT log out.
    const auth = $('#auth-screen'); if (auth) auth.classList.add('hidden');
    $('#app').classList.add('hidden');
    const bs = $('#boot-screen'); if (bs) bs.classList.remove('hidden');
    const m = $('#boot-msg'); if (m) m.textContent = 'Server not reachable — it may be waking up. Your session is safe; tap Retry.';
  }

  async function init() {
    bindAuth(); bindNav();
    if (state.token) tryResume(3);
    else showAuth(true);
    if ('Notification' in window && Notification.permission === 'default') {
      setTimeout(() => Notification.requestPermission().catch(() => { }), 4000);
    }
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
