/* ═══════════════════════════════════════════════════════════════════════════
   TradeMind Future — app shell layer.
   Loaded AFTER app.js. Uses the public action bridge (window.__sa) so the
   main SPA bundle stays untouched. Adds: global symbol search, command
   palette (Ctrl/Cmd-K), data-freshness chip, collapsible sidebar, keyboard
   navigation and an optional light theme.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var root = document.documentElement;

  /* ── theme (persisted) ─────────────────────────────────────────────── */
  try {
    var savedTheme = localStorage.getItem('tm-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') root.setAttribute('data-theme', savedTheme);
  } catch (e) { }
  function toggleTheme() {
    var cur = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    var next = cur === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('tm-theme', next); } catch (e) { }
    var b = $('#btn-theme'); if (b) b.title = 'Switch to ' + (next === 'light' ? 'dark' : 'light') + ' theme';
  }
  var themeBtn = $('#btn-theme'); if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  /* ── collapsible sidebar (persisted) ───────────────────────────────── */
  var shellEl = document.querySelector('.app-shell');
  function setCollapsed(on) {
    if (!shellEl) return;
    shellEl.classList.toggle('collapsed', on);
    root.classList.toggle('tm-side-collapsed', on);
    var b = $('#side-collapse');
    if (b) { b.textContent = on ? '›' : '‹'; b.setAttribute('aria-expanded', String(!on)); b.title = on ? 'Expand sidebar' : 'Collapse sidebar'; }
    try { localStorage.setItem('tm-sidebar', on ? 'collapsed' : 'open'); } catch (e) { }
    // charts resize after the layout change
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 220);
  }
  try { if (localStorage.getItem('tm-sidebar') === 'collapsed') setCollapsed(true); } catch (e) { }
  var collapseBtn = $('#side-collapse'); if (collapseBtn) collapseBtn.addEventListener('click', function () { setCollapsed(!(shellEl && shellEl.classList.contains('collapsed'))); });

  /* ── resizable sidebar (saved layout; desktop) ─────────────────────── */
  var SIDE_DEFAULT = 236, SIDE_MIN = 180, SIDE_MAX = 420;
  function applySideWidth(w) {
    w = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(w)));
    root.style.setProperty('--sidebar', w + 'px');
    return w;
  }
  function saveSideWidth() { try { localStorage.setItem('tm-sidebar-w', String(currentSideWidth())); } catch (e) { } }
  function currentSideWidth() { return parseInt(getComputedStyle(root).getPropertyValue('--sidebar'), 10) || SIDE_DEFAULT; }
  try { var savedW = parseInt(localStorage.getItem('tm-sidebar-w'), 10); if (savedW) applySideWidth(savedW); } catch (e) { }
  var resetSideWidth = function () { applySideWidth(SIDE_DEFAULT); saveSideWidth(); setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60); };
  (function initResizer() {
    var st = document.createElement('style'); st.id = 'tm-layout-style';
    st.textContent =
      '.side-resizer{position:fixed;top:0;left:calc(var(--sidebar) - 3px);width:8px;height:100dvh;cursor:col-resize;z-index:60;background:transparent;touch-action:none}'
      + '.side-resizer::after{content:"";position:absolute;top:0;bottom:0;left:3px;width:2px;background:transparent;transition:background .15s}'
      + '.side-resizer:hover::after,.side-resizer.active::after{background:linear-gradient(180deg,#22d3ee,#34d399)}'
      + 'html.tm-dragging{cursor:col-resize;user-select:none}html.tm-dragging *{cursor:col-resize!important}'
      + 'html.tm-side-collapsed .side-resizer{display:none}'
      + '@media (max-width:959px){.side-resizer{display:none}}'
      + '.tm-split{display:flex;align-items:flex-start}'
      + '.tm-col{min-width:0}'
      + '.tm-col-l{flex:0 0 var(--tm-split-left,58%);padding-right:5px}'
      + '.tm-col-r{flex:1 1 0;padding-left:5px}'
      + '.tm-divider{flex:0 0 9px;align-self:stretch;cursor:col-resize;position:relative;touch-action:none}'
      + '.tm-divider::after{content:"";position:absolute;top:0;bottom:0;left:3.5px;width:2px;background:transparent;transition:background .15s}'
      + '.tm-divider:hover::after,.tm-divider.active::after{background:linear-gradient(180deg,#22d3ee,#34d399)}'
      + '@media (max-width:1100px){.tm-split{display:block}.tm-divider{display:none}.tm-col-l,.tm-col-r{flex:none;width:auto;padding:0}}';
    document.head.appendChild(st);
    var handle = document.createElement('div');
    handle.className = 'side-resizer'; handle.id = 'side-resizer';
    handle.title = 'Drag to resize sidebar · double-click to reset';
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-label', 'Resize sidebar');
    document.body.appendChild(handle);
    var dragging = false, startX = 0, startW = 0;
    handle.addEventListener('dblclick', resetSideWidth);
    handle.addEventListener('pointerdown', function (e) {
      dragging = true; startX = e.clientX; startW = currentSideWidth();
      handle.classList.add('active'); root.classList.add('tm-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (er) { }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      applySideWidth(startW + (e.clientX - startX));
      window.dispatchEvent(new Event('resize'));
    });
    function end() {
      if (!dragging) return;
      dragging = false; handle.classList.remove('active'); root.classList.remove('tm-dragging');
      saveSideWidth();
      setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60);
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  })();

  /* ── stock detail: two-column resizable panes (saved layout; desktop) ──
     app.js renders the detail as one flat column inside #view. We wrap the
     body (everything from the chart down) into a left chart/analysis pane and
     a right tables pane, joined by a draggable divider. Pure DOM, no app.js
     changes; on narrow screens the CSS collapses back to one column. */
  var SPLIT_DEFAULT = 58, SPLIT_MIN = 30, SPLIT_MAX = 82;
  function applySplitRatio(pct) {
    pct = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, Math.round(pct)));
    root.style.setProperty('--tm-split-left', pct + '%');
    return pct;
  }
  try { var sv = parseFloat(localStorage.getItem('tm-split-ratio')); if (sv) applySplitRatio(sv); } catch (e) { }
  function resetSplitRatio() { applySplitRatio(SPLIT_DEFAULT); try { localStorage.setItem('tm-split-ratio', String(SPLIT_DEFAULT)); } catch (e) { } setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60); }
  function currentSplitPct() { return parseFloat(getComputedStyle(root).getPropertyValue('--tm-split-left')) || SPLIT_DEFAULT; }

  function applySplit() {
    var view = document.getElementById('view');
    if (!view || view.querySelector(':scope > .tm-split')) return;
    var chart = view.querySelector(':scope > .chart-box');
    if (!chart) return;
    var kids = Array.prototype.slice.call(view.children);
    var chartIdx = kids.indexOf(chart);
    if (chartIdx < 1) return; // need the header card above the chart
    var body = kids.slice(chartIdx);
    var grids = [];
    body.forEach(function (el, i) { if (el.classList && el.classList.contains('stats-grid')) grids.push(i); });
    if (grids.length < 2) return; // unexpected layout → leave untouched
    var leftNodes = body.slice(0, grids[1] + 1);
    var rightNodes = body.slice(grids[1] + 1);
    if (!rightNodes.length) return;

    var wrapper = h('div', 'tm-split');
    var colL = h('div', 'tm-col tm-col-l');
    var divider = h('div', 'tm-divider');
    divider.title = 'Drag to resize panes · double-click to reset';
    divider.setAttribute('role', 'separator'); divider.setAttribute('aria-orientation', 'vertical'); divider.setAttribute('aria-label', 'Resize detail panes');
    var colR = h('div', 'tm-col tm-col-r');
    leftNodes.forEach(function (n) { colL.appendChild(n); });
    rightNodes.forEach(function (n) { colR.appendChild(n); });
    wrapper.appendChild(colL); wrapper.appendChild(divider); wrapper.appendChild(colR);
    view.appendChild(wrapper);

    var dragging = false, startX = 0, startPct = 0;
    divider.addEventListener('dblclick', resetSplitRatio);
    divider.addEventListener('pointerdown', function (e) {
      dragging = true; startX = e.clientX; startPct = currentSplitPct();
      divider.classList.add('active'); root.classList.add('tm-dragging');
      try { divider.setPointerCapture(e.pointerId); } catch (er) { }
      e.preventDefault();
    });
    divider.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var w = wrapper.getBoundingClientRect().width || 1;
      applySplitRatio(startPct + ((e.clientX - startX) / w) * 100);
      window.dispatchEvent(new Event('resize'));
    });
    function end() {
      if (!dragging) return;
      dragging = false; divider.classList.remove('active'); root.classList.remove('tm-dragging');
      try { localStorage.setItem('tm-split-ratio', String(currentSplitPct())); } catch (er) { }
      setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60);
    }
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);
    // let the chart (and any canvas) re-measure at the new column width
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 30);
  }

  (function observeDetail() {
    var view = document.getElementById('view');
    if (!view) { setTimeout(observeDetail, 250); return; }
    try {
      new MutationObserver(function () { applySplit(); }).observe(view, { childList: true });
    } catch (e) { }
    applySplit();
  })();

  /* ── data-freshness + provider chip ─────────────────────────────────── */
  var NAMES = { yahoo: 'Yahoo Finance', angelone: 'Angel One', fyers: 'Fyers', tapetide: 'Tapetide', dhan: 'Dhan' };
  function ago(ts) {
    if (!ts) return 'no data yet';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  var freshEl = $('#fresh');
  function paintFresh(cls, src, when) {
    if (!freshEl) return;
    freshEl.className = 'fresh ' + cls;
    var s = $('#fresh-src'); if (s) s.textContent = src;
    var w = $('#fresh-when'); if (w) w.textContent = when;
    freshEl.title = 'Market data — source: ' + src + ' · last update: ' + when;
  }
  function loadFreshness() {
    fetch('/api/providers/source').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      var ids = j.active || []; var id = (j.lastUsed && j.lastUsed.id) || ids[0] || 'yahoo';
      var src = NAMES[id] || id;
      var at = j.lastUsed && j.lastUsed.at;
      var age = at ? (Date.now() - at) : Infinity;
      var q = j.quality || null;
      var cls = !at ? 'cached' : age < 5 * 60e3 ? 'live' : age < 20 * 60e3 ? 'cached' : 'stale';
      if (q && q.status) {
        if (q.status === 'LIVE') cls = 'live';
        else if (q.status === 'DELAYED') cls = 'cached';
        else if (q.status === 'STALE' || q.status === 'UNAVAILABLE') cls = 'stale';
        else if (q.status === 'CLOSED') cls = 'cached';
      }
      paintFresh(cls, src + (q && q.status ? ' · ' + q.status : ''), ago(at));
      if (freshEl && q && q.note) freshEl.title = 'Market data — source: ' + src + ' · status: ' + q.status + ' · ' + q.note;
    }).catch(function () { paintFresh('off', 'offline', 'unavailable'); });
  }
  loadFreshness(); setInterval(loadFreshness, 45000);

  /* ── live quote stream (free, SSE — no paid WebSocket needed) ────────── */
  // Subscribes to /api/stream/quotes; the server pushes only changed values.
  // EventSource auto-reconnects; we also pause while the tab is hidden.
  var liveEl = null, liveES = null;
  function ensureLiveStyle() {
    if (document.getElementById('tm-live-style')) return;
    var st = document.createElement('style'); st.id = 'tm-live-style';
    st.textContent =
      '.tm-live{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border:1px solid var(--line,#1f2a44);border-radius:999px;font-size:12px;background:var(--bg-2,#0f1a30);white-space:nowrap}'
      + '.tm-live .d{width:7px;height:7px;border-radius:50%;background:#64748b;flex:0 0 auto}'
      + '.tm-live.live .d{background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.6);animation:tmpulse 1.8s infinite}'
      + '.tm-live.err .d{background:#fb7185}'
      + '.tm-live .v{font-variant-numeric:tabular-nums;font-weight:600}'
      + '.tm-live .c.up{color:#34d399}.tm-live .c.down{color:#fb7185}'
      + '@keyframes tmpulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}70%{box-shadow:0 0 0 7px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}'
      + '@media (prefers-reduced-motion: reduce){.tm-live.live .d{animation:none}}'
      + '@media (max-width:900px){.tm-live{display:none}}';
    document.head.appendChild(st);
  }
  function liveConnect() {
    if (liveES || typeof EventSource === 'undefined' || !liveEl) return;
    try { liveES = new EventSource('/api/stream/quotes?symbols=^NSEI,^NSEBANK&interval=5000'); }
    catch (e) { return; }
    liveES.addEventListener('quotes', function (ev) {
      var d; try { d = JSON.parse(ev.data || '{}'); } catch (e) { return; }
      var ch = d.changed || {};
      var sym = ch['^NSEI'] ? 'NIFTY' : ch['^NSEBANK'] ? 'BANK' : null;
      if (!sym) return;
      var q = ch[sym === 'NIFTY' ? '^NSEI' : '^NSEBANK'];
      var pct = q.changePct != null ? q.changePct : (q.change != null && q.prevClose ? (q.change / q.prevClose) * 100 : null);
      var up = pct == null ? true : pct >= 0;
      var v = q.price != null ? Number(q.price).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
      var c = pct == null ? '' : (up ? '+' : '') + Number(pct).toFixed(2) + '%';
      liveEl.className = 'tm-live live';
      liveEl.innerHTML = '<span class="d"></span><span class="lbl">' + sym + ' <b class="v">' + v + '</b> <span class="c ' + (up ? 'up' : 'down') + '">' + c + '</span></span>';
      liveEl.title = 'Live stream (SSE) · ' + sym + ' ' + v + ' ' + c + ' · ' + (d.ts ? new Date(d.ts).toLocaleTimeString() : '');
    });
    liveES.addEventListener('heartbeat', function () { if (liveEl) { liveEl.className = 'tm-live live'; } });
    liveES.onerror = function () { if (liveEl) { liveEl.classList.remove('live'); liveEl.classList.add('err'); } };
  }
  function initLive() {
    var top = document.querySelector('.topbar-right');
    if (!top) return;
    ensureLiveStyle();
    liveEl = document.createElement('div');
    liveEl.className = 'tm-live'; liveEl.id = 'tm-live';
    liveEl.title = 'Live stream (SSE) — connecting…';
    liveEl.innerHTML = '<span class="d"></span><span class="lbl">NIFTY <b class="v">—</b></span>';
    top.insertBefore(liveEl, top.firstChild);
    liveConnect();
  }
  initLive();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (liveES) { try { liveES.close(); } catch (e) { } liveES = null; } }
    else liveConnect();
  });

  /* ── symbol + watchlist cache for search ───────────────────────────── */
  var SYMS = [], symMap = {}, loadedSyms = false;
  function loadSymbols() {
    fetch('/api/scan/latest?limit=9999').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      SYMS = (j.rows || []).map(function (r) { return { symbol: r.symbol, name: r.name, exchange: r.exchange }; });
      SYMS.forEach(function (s) { symMap[s.symbol] = s; });
      loadedSyms = true;
      var el = $('#cmdk-src'); if (el) el.textContent = j.total + ' symbols';
      if (cmdk && cmdk.classList.contains('open')) refresh();
    }).catch(function () { loadedSyms = true; });
  }
  var WATCH = [];
  function loadWatch() {
    fetch('/api/watchlist').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      WATCH = (j && j.watchlist) || [];
    }).catch(function () { });
  }

  /* ── command palette ───────────────────────────────────────────────── */
  var PAGES = [
    { id: 'dashboard', label: 'Dashboard', sub: 'Overview', ic: '📊' },
    { id: 'scanner', label: 'Scanner', sub: 'SMC full universe', ic: '🔎' },
    { id: 'backtest', label: 'Backtesting', sub: 'Historical simulation', ic: '📈' },
    { id: 'options', label: 'Options', sub: 'Chain & analytics', ic: '🧾' },
    { id: 'paper', label: 'Paper trading', sub: 'Simulated orders', ic: '💼' },
    { id: 'alerts', label: 'Alerts', sub: 'Price & signal alerts', ic: '🔔' },
    { id: 'settings', label: 'Settings', sub: 'Account & integrations', ic: '⚙️' }
  ];
  if (window.__sa && typeof window.__sa.go !== 'function') { /* noop */ }

  var cmdk = $('#cmdk'), input = $('#cmdk-input'), list = $('#cmdk-list');
  var items = [], sel = 0;

  function matches(q, s) { return !q || (s.symbol + ' ' + (s.name || '')).toLowerCase().indexOf(q) > -1; }

  function build(query) {
    var q = String(query || '').trim();
    var ql = q.toLowerCase();
    var out = [];
    var add = function (group, it) { it.group = group; out.push(it); };

    // pages
    PAGES.forEach(function (p) {
      if (!ql || (p.label + ' ' + p.sub).toLowerCase().indexOf(ql) > -1) add('Pages', { label: p.label, sub: p.sub, ic: p.ic, run: function () { window.__sa.go(p.id); } });
    });
    // actions
    var ACTS = [
      { label: 'Toggle light / dark theme', sub: 'Appearance', ic: '◐', run: toggleTheme },
      { label: 'Toggle sidebar', sub: 'Layout', ic: '▤', run: function () { setCollapsed(!(shellEl && shellEl.classList.contains('collapsed'))); } },
      { label: 'Collapse sidebar', sub: 'Layout', ic: '▤', run: function () { setCollapsed(true); } },
      { label: 'Risk controls & kill switch', sub: 'Risk management', ic: '🛡', run: openRiskPanel },
      { label: 'Research brief for a symbol…', sub: 'Evidence-based analysis', ic: '🔬', run: openResearchPrompt },
      { label: 'Options analytics for a symbol…', sub: 'Chain · Greeks · OI · IV', ic: '🧾', run: openOptionsPrompt },
      { label: 'Options strategy builder…', sub: 'Payoff · breakevens · max P/L', ic: '🧮', run: function () { openPayoff(); } },
      { label: 'Advanced backtest (with costs)…', sub: 'Brokerage · STT · slippage · train/test', ic: '📈', run: function () { openBacktest(); } },
      { label: 'Reset sidebar width', sub: 'Layout', ic: '▤', run: resetSideWidth },
      { label: 'Reset detail pane split', sub: 'Layout · stock view', ic: '⫲', run: resetSplitRatio },
      { label: 'Sign out', sub: 'Session', ic: '⏻', run: function () { var b = $('#btn-logout'); if (b) b.click(); } }
    ];
    ACTS.forEach(function (a) { if (!ql || a.label.toLowerCase().indexOf(ql) > -1) add('Actions', { label: a.label, sub: a.sub, ic: a.ic, run: a.run }); });

    // "Research <SYM>" shortcut when the query looks like a ticker
    if (q && /^[\^A-Za-z0-9.&-]{1,15}$/.test(q)) {
      var U = q.toUpperCase();
      add('Research', { label: 'Research brief: ' + U, sub: 'Deterministic evidence + levels', ic: '🔬', run: function () { openResearch(U); } });
      add('Options', { label: 'Options analytics: ' + U, sub: 'Chain · Greeks · OI · IV', ic: '🧾', run: function () { openOptions(U); } });
      add('Backtest', { label: 'Backtest: ' + U, sub: 'Cost-aware, train/test split', ic: '📈', run: function () { openBacktest(U); } });
    }

    // watchlist shortcuts
    if (WATCH.length) WATCH.forEach(function (w) {
      if (!ql || matches(ql, w)) add('Watchlist', { label: w.symbol, sub: w.name || 'watchlist', ic: '★', run: function () { window.__sa.openStock(w.symbol); } });
    });
    // symbols
    if (SYMS.length) {
      var n = 0;
      for (var i = 0; i < SYMS.length && n < 40; i++) {
        if (matches(ql, SYMS[i])) { add('Symbols', { label: SYMS[i].symbol, sub: (SYMS[i].name || '') + (SYMS[i].exchange ? ' · ' + SYMS[i].exchange : ''), ic: '◇', run: (function (sym) { return function () { window.__sa.openStock(sym); }; })(SYMS[i].symbol) }); n++; }
      }
    }
    return out;
  }

  function renderList() {
    if (!list) return;
    if (!items.length) { list.innerHTML = '<div class="cmdk-lab">No matches</div>'; return; }
    var html = '', last = '';
    items.forEach(function (it, i) {
      if (it.group !== last) { html += '<div class="cmdk-lab">' + it.group + '</div>'; last = it.group; }
      html += '<div class="cmdk-item' + (i === sel ? ' sel' : '') + '" data-i="' + i + '" role="option">'
        + '<span class="ic">' + it.ic + '</span><b>' + it.label + '</b><span class="sub">' + (it.sub || '') + '</span></div>';
    });
    list.innerHTML = html;
    var cur = list.querySelector('.cmdk-item.sel'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function refresh() { items = build(input ? input.value : ''); sel = 0; renderList(); }

  function open(q) {
    if (!cmdk) return;
    if (!loadedSyms) loadSymbols();
    loadWatch();
    cmdk.hidden = false; cmdk.classList.add('open');
    if (input) { input.value = q || ''; }
    refresh();
    setTimeout(function () { if (input) input.focus(); }, 10);
  }
  function close() { if (!cmdk) return; cmdk.classList.remove('open'); cmdk.hidden = true; var g = $('#gsearch-input'); if (g) g.value = ''; }

  function activate(i) {
    var it = items[i]; if (!it || !it.run) return;
    close();
    try { it.run(); } catch (e) { if (window.__sa && window.__sa.toast) window.__sa.toast(e.message || 'Action failed', 'err'); }
  }

  var searchInput = $('#gsearch-input'), searchBox = $('#gsearch');
  function openFromSearch() { open(searchInput ? searchInput.value : ''); }
  if (searchBox) searchBox.addEventListener('click', function (e) { if (e.target !== searchInput) { e.preventDefault(); openFromSearch(); } });
  if (searchInput) {
    searchInput.addEventListener('focus', openFromSearch);
    searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); openFromSearch(); } });
  }
  if (input) {
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); renderList(); }
      else if (e.key === 'Enter') { e.preventDefault(); activate(sel); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }
  if (list) list.addEventListener('click', function (e) { var el = e.target.closest('.cmdk-item'); if (el) activate(Number(el.getAttribute('data-i'))); });
  if (cmdk) cmdk.addEventListener('mousedown', function (e) { if (e.target === cmdk) close(); });

  /* ── keyboard navigation ───────────────────────────────────────────── */
  var GO = { d: 'dashboard', s: 'scanner', b: 'backtest', o: 'options', p: 'paper', a: 'alerts', e: 'settings' };
  var pendingG = false, gTimer = null;
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && tmPanel) { closePanel(); return; }
    var appEl = document.getElementById('app');
    var appVisible = !!(appEl && !appEl.classList.contains('hidden'));
    if (!appVisible) { if (e.key === 'Escape' && cmdk && cmdk.classList.contains('open')) close(); return; }
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);

    // Ctrl/Cmd-K opens the palette
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (cmdk && cmdk.classList.contains('open')) close(); else open(); return; }
    if (e.key === 'Escape' && cmdk && cmdk.classList.contains('open')) { close(); return; }
    if (typing) return;

    // '/' focuses search
    if (e.key === '/') { e.preventDefault(); open(); return; }
    // 'g' then a route key
    if (pendingG) {
      pendingG = false; if (gTimer) clearTimeout(gTimer);
      var r = GO[(e.key || '').toLowerCase()];
      if (r) { e.preventDefault(); window.__sa.go(r); return; }
    }
    if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      pendingG = true; gTimer = setTimeout(function () { pendingG = false; }, 1200); return;
    }
  });

  /* ── panels: research brief + risk controls (injected, no app.js changes) ── */
  function ensureShellStyle() {
    if (document.getElementById('tm-shell-style')) return;
    var st = document.createElement('style');
    st.id = 'tm-shell-style';
    st.textContent =
      '.tm-modal{position:fixed;inset:0;z-index:9000;background:rgba(2,6,23,.62);backdrop-filter:blur(3px);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;overflow:auto}'
      + '.tm-card{width:min(720px,100%);background:var(--bg-1,#0b1220);color:var(--fg,#e5e7eb);border:1px solid var(--line,#1f2a44);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.5)}'
      + '.tm-card-h{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line,#1f2a44)}'
      + '.tm-card-h h2{margin:0;font-size:16px}'
      + '.tm-card-h .tm-x{margin-left:auto;border:0;background:transparent;color:inherit;font-size:22px;cursor:pointer;line-height:1}'
      + '.tm-card-b{padding:16px 18px;font-size:13.5px;line-height:1.55}'
      + '.tm-pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.02em;border:1px solid currentColor}'
      + '.tm-sec{margin:14px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.7}'
      + '.tm-li{display:flex;gap:8px;padding:5px 0;border-bottom:1px dashed rgba(148,163,184,.18)}'
      + '.tm-li b{font-weight:600}.tm-mut{opacity:.7}'
      + '.tm-grid{display:grid;grid-template-columns:1fr auto;gap:4px 12px}'
      + '.tm-row{display:contents}.tm-row .v{text-align:right;font-variant-numeric:tabular-nums}'
      + '.tm-btn{border:1px solid var(--line,#1f2a44);background:var(--bg-2,#0f1a30);color:inherit;border-radius:10px;padding:8px 14px;cursor:pointer;font:inherit}'
      + '.tm-btn:hover{border-color:var(--accent,#22d3ee)}.tm-btn.danger{border-color:#f43f5e;color:#fb7185}'
      + '.tm-in{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line,#1f2a44);background:var(--bg-2,#0f1a30);color:inherit;font:inherit}'
      + '.tm-bad{color:#fb7185}.tm-good{color:#34d399}'
      + '.tm-tbl{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}'
      + '.tm-tbl th,.tm-tbl td{padding:5px 7px;border-bottom:1px solid rgba(148,163,184,.18);text-align:right;white-space:nowrap}'
      + '.tm-tbl th:first-child,.tm-tbl td:first-child{text-align:left}'
      + '.tm-tbl thead th{position:sticky;top:0;background:var(--bg-1,#0b1220);opacity:.9}'
      + '.tm-scroll{max-height:320px;overflow:auto;border:1px solid var(--line,#1f2a44);border-radius:10px}'
      + '.tm-chart{width:100%;height:180px;display:block;margin-top:8px}'
      + '.tm-leg{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed rgba(148,163,184,.18)}'
      + '.tm-leg button{margin-left:auto}';
    document.head.appendChild(st);
  }
  var tmPanel = null;
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function closePanel() { if (tmPanel) { tmPanel.remove(); tmPanel = null; } }
  function openPanel(title) {
    ensureShellStyle(); closePanel();
    var modal = h('div', 'tm-modal');
    var card = h('div', 'tm-card'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
    var head = h('div', 'tm-card-h'); head.appendChild(h('h2', null, title));
    var x = h('button', 'tm-x', '×'); x.setAttribute('aria-label', 'Close'); x.addEventListener('click', closePanel);
    head.appendChild(x);
    var body = h('div', 'tm-card-b');
    card.appendChild(head); card.appendChild(body); modal.appendChild(card);
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) closePanel(); });
    document.body.appendChild(modal);
    tmPanel = modal;
    return body;
  }
  function row(grid, label, value, cls) {
    var r = h('div', 'tm-row');
    r.appendChild(h('span', 'l tm-mut', label));
    r.appendChild(h('span', 'v ' + (cls || ''), value));
    grid.appendChild(r);
  }

  function openResearchPrompt() {
    var body = openPanel('Research brief');
    body.appendChild(h('div', 'tm-mut', 'Enter a symbol (e.g. RELIANCE, NIFTY, ^NSEI). Analysis uses live provider data and deterministic rules — no invented numbers.'));
    var form = h('form'); form.style.marginTop = '12px';
    var inp = h('input', 'tm-in'); inp.placeholder = 'Symbol'; inp.setAttribute('aria-label', 'Symbol');
    var go = h('button', 'tm-btn', 'Analyse'); go.type = 'submit'; go.style.marginTop = '10px';
    form.appendChild(inp); form.appendChild(go);
    form.addEventListener('submit', function (e) { e.preventDefault(); var s = String(inp.value || '').trim().toUpperCase(); if (s) openResearch(s); });
    body.appendChild(form);
    setTimeout(function () { inp.focus(); }, 20);
  }

  function openResearch(sym) {
    var body = openPanel('Research — ' + sym);
    body.appendChild(h('div', 'tm-mut', 'Fetching live data & running deterministic analysis…'));
    fetch('/api/research/' + encodeURIComponent(sym)).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
      var j = res.j;
      body.textContent = '';
      if (!res.ok || !j.ok) { body.appendChild(h('div', 'tm-bad', 'Unavailable: ' + (j.error || 'no data'))); return; }
      var head = h('div'); head.style.display = 'flex'; head.style.gap = '10px'; head.style.alignItems = 'center'; head.style.flexWrap = 'wrap';
      var color = /BULLISH/.test(j.stance) ? '#34d399' : /BEARISH/.test(j.stance) ? '#fb7185' : '#fbbf24';
      var pill = h('span', 'tm-pill', j.stance); pill.style.color = color; head.appendChild(pill);
      if (j.quality) head.appendChild(h('span', 'tm-mut', j.quality.status + ' · ' + j.quality.source));
      body.appendChild(head);
      body.appendChild(h('p', null, j.headline));

      function section(title, arr, good) {
        if (!arr || !arr.length) return;
        body.appendChild(h('div', 'tm-sec', title + ' (' + arr.length + ')'));
        arr.forEach(function (it) {
          var li = h('div', 'tm-li');
          li.appendChild(h('span', null, good === true ? '▲' : good === false ? '▼' : '•'));
          var t = h('div'); t.appendChild(h('b', null, it.label));
          if (it.detail) t.appendChild(h('span', 'tm-mut', ' — ' + it.detail));
          li.appendChild(t); body.appendChild(li);
        });
      }
      section('Bullish evidence', j.bullEvidence, true);
      section('Bearish evidence', j.bearEvidence, false);
      section('Conflicting signals', j.conflicts, null);
      section('Risks', j.risks, false);
      section('Missing / unavailable data', j.missingData, null);

      body.appendChild(h('div', 'tm-sec', 'Reference levels'));
      var g = h('div', 'tm-grid');
      var L = j.levels || {};
      row(g, 'Entry reference', L.entryReference != null ? '₹' + L.entryReference : '—');
      row(g, 'Invalidation', L.invalidation ? '₹' + L.invalidation.price + '  (' + L.invalidation.label + ')' : '—', 'tm-bad');
      (L.targets || []).forEach(function (t, i) { row(g, 'Target ' + (i + 1), '₹' + t.price + '  (' + t.label + ')', 'tm-good'); });
      row(g, 'Reference R:R', L.referenceRiskReward != null ? '1:' + L.referenceRiskReward : '—');
      body.appendChild(g);

      body.appendChild(h('div', 'tm-sec', 'Probability'));
      body.appendChild(h('div', 'tm-mut', j.probability.note));
      var ph = j.probability.historical || {};
      var pg = h('div', 'tm-grid');
      row(pg, 'Historical sample', ph.sampleSize != null ? ph.sampleSize + ' trades' : '—');
      row(pg, 'Win rate (in-sample)', ph.winRate != null ? ph.winRate + '%' : '—');
      row(pg, 'Profit factor', ph.profitFactor != null ? ph.profitFactor : '—');
      row(pg, 'Max drawdown', ph.maxDrawdownPct != null ? ph.maxDrawdownPct + '%' : '—');
      body.appendChild(pg);
      body.appendChild(h('p', 'tm-mut', j.disclaimer));
    }).catch(function (e) { body.appendChild(h('div', 'tm-bad', 'Failed: ' + e.message)); });
  }

  /* ── options analytics + strategy builder (injected; uses real endpoints) ── */
  function fmtN(v) { return v == null ? '—' : Number(v).toLocaleString('en-IN'); }
  function fmtDate(ts, short) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleDateString('en-IN', short ? { day: '2-digit', month: 'short', year: '2-digit' } : { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch (e) { return '—'; }
  }
  function pill(text, color) { var p = h('span', 'tm-pill', text); if (color) p.style.color = color; return p; }

  function openOptionsPrompt() {
    var body = openPanel('Options analytics');
    body.appendChild(h('div', 'tm-mut', 'Enter an underlying (e.g. NIFTY, BANKNIFTY, RELIANCE). Uses the free NSE chain, or your Dhan token when configured. Greeks are computed from provider IV — never invented.'));
    var form = h('form'); form.style.marginTop = '12px';
    var inp = h('input', 'tm-in'); inp.placeholder = 'Underlying'; inp.setAttribute('aria-label', 'Underlying');
    var go = h('button', 'tm-btn', 'Load chain'); go.type = 'submit'; go.style.marginTop = '10px';
    form.appendChild(inp); form.appendChild(go);
    form.addEventListener('submit', function (e) { e.preventDefault(); var s = String(inp.value || '').trim().toUpperCase(); if (s) openOptions(s); });
    body.appendChild(form);
    setTimeout(function () { inp.focus(); }, 20);
  }

  function strikeTable(j) {
    var S = j.underlyingValue || j.atm || 0;
    var rows = (j.strikes || []).slice().sort(function (a, b) { return Math.abs(a.strike - S) - Math.abs(b.strike - S); }).slice(0, 11).sort(function (a, b) { return a.strike - b.strike; });
    var nearest = rows.reduce(function (a, b) { return (!a || Math.abs(b.strike - S) < Math.abs(a.strike - S)) ? b : a; }, null);
    var box = h('div', 'tm-scroll');
    var t = document.createElement('table'); t.className = 'tm-tbl';
    t.innerHTML = '<thead><tr><th>Strike</th><th>CE LTP</th><th>CE Δ</th><th>CE IV</th><th>PE LTP</th><th>PE Δ</th><th>PE IV</th><th>CE OI</th><th>PE OI</th></tr></thead>';
    var tb = document.createElement('tbody');
    rows.forEach(function (s) {
      var ce = s.ce || {}, pe = s.pe || {};
      var tr = document.createElement('tr');
      if (nearest && s.strike === nearest.strike) tr.style.background = 'rgba(34,211,238,.10)';
      var cells = [s.strike, ce.ltp, ce.greeks ? ce.greeks.delta : null, ce.iv, pe.ltp, pe.greeks ? pe.greeks.delta : null, pe.iv, ce.oi, pe.oi];
      cells.forEach(function (v, i) {
        var td = document.createElement('td');
        if (v == null) td.textContent = '—';
        else if (i === 0) td.textContent = v;
        else if (i === 2 || i === 5) td.textContent = (v >= 0 ? '+' : '') + Number(v).toFixed(3);
        else if (i >= 7) td.textContent = fmtN(v);
        else td.textContent = typeof v === 'number' ? (Math.round(v * 100) / 100) : v;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb); box.appendChild(t); return box;
  }

  function openOptions(sym, expiry) {
    var body = openPanel('Options analytics — ' + sym);
    body.appendChild(h('div', 'tm-mut', 'Loading option chain…'));
    var url = '/api/options/' + encodeURIComponent(sym) + '/analytics' + (expiry ? '?expiry=' + encodeURIComponent(expiry) : '');
    fetch(url).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
      var j = res.j; body.textContent = '';
      if (!res.ok || !j.ok) { body.appendChild(h('div', 'tm-bad', 'Unavailable: ' + (j.error || 'no chain'))); return; }
      var head = h('div'); head.style.display = 'flex'; head.style.gap = '10px'; head.style.alignItems = 'center'; head.style.flexWrap = 'wrap';
      head.appendChild(pill(String(j.source || 'NSE').toUpperCase()));
      head.appendChild(h('span', 'tm-mut', (j.expiry || '') + ' · updated ' + (j.updatedAt ? new Date(j.updatedAt).toLocaleTimeString() : '—')));
      if (j.expiries && j.expiries.length > 1) {
        var sel = document.createElement('select'); sel.className = 'tm-in'; sel.style.width = 'auto'; sel.style.padding = '5px 8px'; sel.setAttribute('aria-label', 'Expiry');
        j.expiries.forEach(function (x) { var o = document.createElement('option'); o.value = x; o.textContent = x; if (x === j.expiry) o.selected = true; sel.appendChild(o); });
        sel.addEventListener('change', function () { openOptions(sym, sel.value); });
        head.appendChild(sel);
      }
      body.appendChild(head);

      body.appendChild(h('div', 'tm-sec', 'Snapshot'));
      var g = h('div', 'tm-grid');
      row(g, 'Underlying', j.underlyingValue != null ? '₹' + j.underlyingValue : '—');
      row(g, 'ATM strike', j.atm != null ? j.atm : '—');
      row(g, 'ATM IV', j.atmIV != null ? j.atmIV + '%' : '—');
      row(g, 'IV skew (put − call)', j.ivSkew != null ? j.ivSkew : '—');
      row(g, 'PCR (OI)', j.pcr != null ? j.pcr : '—');
      row(g, 'Max pain', j.maxPain && j.maxPain.strike != null ? '₹' + j.maxPain.strike + '  (' + fmtN(j.maxPain.pain) + ' pain)' : '—');
      body.appendChild(g);

      body.appendChild(h('div', 'tm-sec', 'Greeks'));
      body.appendChild(h('div', 'tm-mut', j.greeks.note + (j.greeks.available ? '  Model: ' + j.greeks.model + ' · r = ' + j.greeks.riskFreeRate + '%' : '')));

      body.appendChild(h('div', 'tm-sec', 'IV rank / percentile'));
      if (j.ivRank && j.ivRank.available) {
        var rg = h('div', 'tm-grid');
        row(rg, 'Snapshots', j.ivRank.samples);
        row(rg, 'Recorded range', j.ivRank.min + '% – ' + j.ivRank.max + '%');
        row(rg, 'IV rank', j.ivRank.rank + '%');
        row(rg, 'IV percentile', j.ivRank.percentile + '%');
        body.appendChild(rg);
      } else body.appendChild(h('div', 'tm-mut', (j.ivRank && j.ivRank.note) || 'Not available yet'));

      body.appendChild(h('div', 'tm-sec', 'Open interest — top strikes'));
      var og = h('div', 'tm-grid');
      (j.oi && j.oi.highestCeOi || []).slice(0, 3).forEach(function (s) { row(og, 'CE OI ' + s.strike, fmtN(s.oi)); });
      (j.oi && j.oi.highestPeOi || []).slice(0, 3).forEach(function (s) { row(og, 'PE OI ' + s.strike, fmtN(s.oi)); });
      body.appendChild(og);
      if (j.oi && j.oi.biggestCeOiAdd) body.appendChild(h('div', 'tm-mut', 'Biggest CE OI add: ' + j.oi.biggestCeOiAdd.strike + ' (' + fmtN(j.oi.biggestCeOiAdd.oiChange) + ')'));
      if (j.oi && j.oi.biggestPeOiAdd) body.appendChild(h('div', 'tm-mut', 'Biggest PE OI add: ' + j.oi.biggestPeOiAdd.strike + ' (' + fmtN(j.oi.biggestPeOiAdd.oiChange) + ')'));

      body.appendChild(h('div', 'tm-sec', 'Near-ATM chain'));
      body.appendChild(strikeTable(j));

      body.appendChild(h('div', 'tm-sec', 'Expiry comparison'));
      var cmpBox = h('div');
      cmpBox.appendChild(h('div', 'tm-mut', 'Compare ATM IV, PCR, max pain and OI across the nearest expiries.'));
      var cmpBtn = h('button', 'tm-btn', '⇄ Compare nearest expiries'); cmpBtn.type = 'button'; cmpBtn.style.marginTop = '8px';
      cmpBox.appendChild(cmpBtn);
      cmpBtn.addEventListener('click', function () { loadExpiryCompare(cmpBox, sym); });
      body.appendChild(cmpBox);

      var btns = h('div'); btns.style.marginTop = '14px';
      var b = h('button', 'tm-btn', 'Build a strategy from this chain'); b.type = 'button';
      b.addEventListener('click', function () { openPayoff(j); });
      btns.appendChild(b); body.appendChild(btns);
    }).catch(function (e) { body.appendChild(h('div', 'tm-bad', 'Failed: ' + e.message)); });
  }

  function loadExpiryCompare(box, sym) {
    box.textContent = '';
    box.appendChild(h('div', 'tm-mut', 'Loading nearest expiries… NSE rate-limits requests, so this can take a few seconds.'));
    fetch('/api/options/' + encodeURIComponent(sym) + '/expiries/compare?count=3')
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        box.textContent = '';
        var j = res.j;
        if (!res.ok || !j.ok) { box.appendChild(h('div', 'tm-bad', 'Unavailable: ' + (j.error || 'no chain'))); return; }
        var head = h('div'); head.style.display = 'flex'; head.style.gap = '10px'; head.style.alignItems = 'center'; head.style.flexWrap = 'wrap';
        head.appendChild(pill(String(j.source || 'NSE').toUpperCase()));
        head.appendChild(h('span', 'tm-mut', 'underlying ₹' + (j.underlyingValue != null ? j.underlyingValue : '—') + ' · nearest ' + (j.expiries || []).length));
        box.appendChild(head);
        var t = document.createElement('table'); t.className = 'tm-tbl';
        t.innerHTML = '<thead><tr><th>Expiry</th><th>Days</th><th>ATM</th><th>ATM IV</th><th>Skew</th><th>PCR</th><th>Max pain</th><th>CE OI</th><th>PE OI</th></tr></thead>';
        var tb = document.createElement('tbody');
        (j.expiries || []).forEach(function (r2) {
          var tr = document.createElement('tr');
          if (r2.error) {
            var td = document.createElement('td'); td.colSpan = 9; td.className = 'tm-bad';
            td.textContent = r2.expiry + ' — ' + r2.error; tr.appendChild(td); tb.appendChild(tr); return;
          }
          [r2.expiry, r2.daysToExpiry, r2.atmStrike, r2.atmIV != null ? r2.atmIV + '%' : '—', r2.ivSkew, r2.pcr, r2.maxPain, fmtN(r2.ceOi), fmtN(r2.peOi)].forEach(function (v) {
            var td = document.createElement('td'); td.textContent = v == null ? '—' : String(v); tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
        t.appendChild(tb);
        var wrap = h('div', 'tm-scroll'); wrap.appendChild(t); box.appendChild(wrap);
        if (j.note) box.appendChild(h('div', 'tm-mut', j.note));
      }).catch(function (e) { box.textContent = ''; box.appendChild(h('div', 'tm-bad', 'Failed: ' + e.message)); });
  }

  function payoffChart(grid) {
    var ns = 'http://www.w3.org/2000/svg';
    function el(n, attrs) { var e = document.createElementNS(ns, n); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
    var W = 560, H = 170, pad = 10;
    var xs = grid.map(function (g) { return g.price; }), ys = grid.map(function (g) { return g.pnl; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys.concat([0])), y1 = Math.max.apply(null, ys.concat([0]));
    var sx = function (x) { return pad + ((x - x0) / ((x1 - x0) || 1)) * (W - 2 * pad); };
    var sy = function (y) { return pad + ((y1 - y) / ((y1 - y0) || 1)) * (H - 2 * pad); };
    var pts = grid.map(function (g) { return sx(g.price).toFixed(1) + ',' + sy(g.pnl).toFixed(1); }).join(' ');
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'tm-chart', preserveAspectRatio: 'none' });
    svg.appendChild(el('line', { x1: pad, y1: sy(0).toFixed(1), x2: W - pad, y2: sy(0).toFixed(1), stroke: '#64748b', 'stroke-width': 1, 'stroke-dasharray': '4 4', 'vector-effect': 'non-scaling-stroke' }));
    svg.appendChild(el('polyline', { points: pts, fill: 'none', stroke: '#22d3ee', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
    var lbl = el('text', { x: pad, y: H - 3, fill: '#94a3b8', 'font-size': 10 });
    lbl.textContent = '₹' + x0.toFixed(0) + ' → ₹' + x1.toFixed(0) + '   (dashed = break-even)';
    svg.appendChild(lbl);
    return svg;
  }

  function openPayoff(chain) {
    var body = openPanel('Options strategy builder');
    var model = { lotSize: 1, legs: [] };
    body.appendChild(h('div', 'tm-mut', 'Signed qty: positive = long (buy), negative = short (sell). Premium is per unit, ₹. Payoff is expiry P&L per lot — excludes brokerage/taxes/slippage.'));
    var wrap = h('div'); body.appendChild(wrap);

    function mkIn(val, ph, w) { var i = h('input', 'tm-in'); i.type = 'number'; i.value = val == null ? '' : val; i.placeholder = ph || ''; if (w) { i.style.width = w; } return i; }

    function render() {
      wrap.textContent = '';
      var g = h('div', 'tm-grid');
      var lotIn = mkIn(model.lotSize, 'Lot size');
      g.appendChild(h('span', 'l tm-mut', 'Lot size')); g.appendChild(lotIn);
      wrap.appendChild(g);

      wrap.appendChild(h('div', 'tm-sec', 'Legs (' + model.legs.length + ')'));
      model.legs.forEach(function (l, i) {
        var lr = h('div', 'tm-leg');
        lr.appendChild(h('span', null, l.qty > 0 ? '▲' : '▼'));
        var t = h('div'); t.appendChild(h('b', null, (l.qty > 0 ? 'LONG ' : 'SHORT ') + l.type + ' ' + l.strike));
        t.appendChild(h('span', 'tm-mut', '  qty ' + l.qty + ' @ ₹' + l.premium));
        lr.appendChild(t);
        var rm = h('button', 'tm-btn', 'remove'); rm.type = 'button';
        rm.addEventListener('click', function () { model.legs.splice(i, 1); render(); });
        lr.appendChild(rm);
        wrap.appendChild(lr);
      });

      var addRow = h('div'); addRow.style.display = 'flex'; addRow.style.gap = '8px'; addRow.style.flexWrap = 'wrap'; addRow.style.marginTop = '8px';
      var typeSel = document.createElement('select'); typeSel.className = 'tm-in'; typeSel.style.width = '70px'; typeSel.setAttribute('aria-label', 'Option type');
      ['CE', 'PE'].forEach(function (x) { var o = document.createElement('option'); o.value = x; o.textContent = x; typeSel.appendChild(o); });
      var strike = mkIn('', 'Strike', '100px'), qty = mkIn('', 'Qty', '80px'), prem = mkIn('', 'Premium', '100px');
      var add = h('button', 'tm-btn', '+ Add leg'); add.type = 'button';
      add.addEventListener('click', function () {
        var s = Number(strike.value), q = Number(qty.value), p = Number(prem.value) || 0;
        if (!isFinite(s) || !isFinite(q) || q === 0) { return; }
        model.legs.push({ type: typeSel.value, strike: s, qty: q, premium: p });
        strike.value = ''; qty.value = ''; prem.value = '';
        render();
      });
      addRow.appendChild(typeSel); addRow.appendChild(strike); addRow.appendChild(qty); addRow.appendChild(prem); addRow.appendChild(add);
      wrap.appendChild(addRow);

      if (chain && chain.atm != null) {
        var quick = h('button', 'tm-btn', 'Quick add ATM ' + chain.atm + ' straddle'); quick.type = 'button'; quick.style.marginTop = '8px';
        quick.addEventListener('click', function () {
          model.legs.push({ type: 'CE', strike: chain.atm, qty: -1, premium: 0 });
          model.legs.push({ type: 'PE', strike: chain.atm, qty: -1, premium: 0 });
          render();
        });
        wrap.appendChild(quick);
        wrap.appendChild(h('div', 'tm-mut', 'Tip: long ATM CE = qty +1; short straddle = CE −1 and PE −1. Set the real premium from the chain above.'));
      }

      var calc = h('button', 'tm-btn', 'Compute payoff'); calc.type = 'button'; calc.style.marginTop = '12px';
      var out = h('div'); out.style.marginTop = '10px';
      calc.addEventListener('click', function () {
        if (!model.legs.length) { out.textContent = ''; out.appendChild(h('div', 'tm-bad', 'Add at least one leg.')); return; }
        out.textContent = ''; out.appendChild(h('div', 'tm-mut', 'Computing…'));
        fetch('/api/options/strategy/payoff', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ legs: model.legs, lotSize: Number(lotIn.value) || 1 }),
        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
          out.textContent = ''; var j = res.j;
          if (!res.ok || !j.ok) { out.appendChild(h('div', 'tm-bad', 'Error: ' + (j.error || 'failed'))); return; }
          var rg = h('div', 'tm-grid');
          row(rg, 'Position', j.position);
          row(rg, 'Net premium', (j.netPremium < 0 ? '₹' + Math.abs(j.netPremium) + ' credit' : '₹' + j.netPremium + ' debit'), j.netPremium < 0 ? 'tm-good' : '');
          row(rg, 'Max profit', j.maxProfit === 'unlimited' ? 'unlimited' : '₹' + j.maxProfit, 'tm-good');
          row(rg, 'Max loss', j.maxLoss === 'unlimited' ? 'unlimited' : '₹' + j.maxLoss, 'tm-bad');
          row(rg, 'Breakeven(s)', (j.breakevens && j.breakevens.length) ? j.breakevens.join(' · ') : '—');
          out.appendChild(rg);
          out.appendChild(payoffChart(j.payoff));
          out.appendChild(h('p', 'tm-mut', j.note));
        }).catch(function (e) { out.textContent = ''; out.appendChild(h('div', 'tm-bad', 'Failed: ' + e.message)); });
      });
      wrap.appendChild(calc); wrap.appendChild(out);
    }
    render();
  }

  /* ── advanced backtest (cost-aware; same deterministic engine) ──────── */
  function openBacktest(sym) {
    var body = openPanel('Advanced backtest');
    body.appendChild(h('div', 'tm-mut', 'Runs the same deterministic SMC engine over real daily history. Optionally subtracts Indian brokerage / STT / GST / stamp / slippage and reports a chronological train/test split. No curve-fitting, no look-ahead.'));
    var form = h('div'); form.style.marginTop = '12px';

    var r1 = h('div'); r1.style.display = 'flex'; r1.style.gap = '8px'; r1.style.flexWrap = 'wrap'; r1.style.alignItems = 'center';
    var symIn = h('input', 'tm-in'); symIn.placeholder = 'Symbol (e.g. RELIANCE)'; symIn.value = sym || ''; symIn.style.flex = '1 1 180px'; symIn.setAttribute('aria-label', 'Symbol');
    var presetSel = document.createElement('select'); presetSel.className = 'tm-in'; presetSel.style.width = 'auto'; presetSel.setAttribute('aria-label', 'Preset');
    [['improved', 'improved'], ['strict', 'strict']].forEach(function (p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; presetSel.appendChild(o); });
    r1.appendChild(symIn); r1.appendChild(presetSel); form.appendChild(r1);

    var r2 = h('div'); r2.style.display = 'flex'; r2.style.gap = '14px'; r2.style.flexWrap = 'wrap'; r2.style.alignItems = 'center'; r2.style.marginTop = '10px';
    var costWrap = h('label'); costWrap.style.display = 'inline-flex'; costWrap.style.gap = '6px'; costWrap.style.alignItems = 'center'; costWrap.style.cursor = 'pointer';
    var costChk = document.createElement('input'); costChk.type = 'checkbox'; costChk.checked = true;
    costWrap.appendChild(costChk); costWrap.appendChild(document.createTextNode('Include costs'));
    var modeSel = document.createElement('select'); modeSel.className = 'tm-in'; modeSel.style.width = 'auto'; modeSel.setAttribute('aria-label', 'Cost mode');
    [['DELIVERY', 'Delivery'], ['INTRADAY', 'Intraday']].forEach(function (m) { var o = document.createElement('option'); o.value = m[0]; o.textContent = m[1]; modeSel.appendChild(o); });
    var trainWrap = h('label'); trainWrap.style.display = 'inline-flex'; trainWrap.style.gap = '6px'; trainWrap.style.alignItems = 'center';
    var trainIn = document.createElement('input'); trainIn.type = 'number'; trainIn.className = 'tm-in'; trainIn.style.width = '72px'; trainIn.min = '0'; trainIn.max = '0.9'; trainIn.step = '0.1'; trainIn.value = '0'; trainIn.setAttribute('aria-label', 'Train split');
    trainWrap.appendChild(document.createTextNode('Train split')); trainWrap.appendChild(trainIn);
    r2.appendChild(costWrap); r2.appendChild(modeSel); r2.appendChild(trainWrap); form.appendChild(r2);

    var run = h('button', 'tm-btn', '▶ Run backtest'); run.type = 'button'; run.style.marginTop = '12px';
    form.appendChild(run);
    body.appendChild(form);
    var out = h('div'); out.style.marginTop = '12px'; body.appendChild(out);

    run.addEventListener('click', function () {
      var s = String(symIn.value || '').trim().toUpperCase();
      if (!s) { out.textContent = ''; out.appendChild(h('div', 'tm-bad', 'Enter a symbol.')); return; }
      var q = ['preset=' + encodeURIComponent(presetSel.value)];
      if (costChk.checked) { q.push('costs=1'); q.push('mode=' + modeSel.value); }
      var v = Number(trainIn.value) || 0; if (v > 0 && v < 1) q.push('train=' + v);
      out.textContent = ''; out.appendChild(h('div', 'tm-mut', 'Running… (fetching history)'));
      fetch('/api/backtest/' + encodeURIComponent(s) + '?' + q.join('&'))
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          out.textContent = '';
          if (!res.ok) { out.appendChild(h('div', 'tm-bad', res.j.error || 'Backtest failed')); return; }
          var j = res.j, st = j.stats || {};
          var head = h('div'); head.style.display = 'flex'; head.style.gap = '10px'; head.style.alignItems = 'center'; head.style.flexWrap = 'wrap';
          head.appendChild(pill(j.symbol));
          head.appendChild(h('span', 'tm-mut', (j.bars || '—') + ' bars · ' + fmtDate(j.dataFrom) + ' → ' + fmtDate(j.dataTo) + ' · ' + j.preset));
          out.appendChild(head);

          var g = h('div', 'tm-grid');
          row(g, 'Trades', st.trades);
          row(g, 'Win rate', st.winRate != null ? st.winRate + '%' : '—');
          row(g, 'Profit factor', st.profitFactor);
          row(g, 'Net P&L (sum)', st.netProfitPct != null ? st.netProfitPct + '%' : '—', (st.netProfitPct || 0) < 0 ? 'tm-bad' : 'tm-good');
          row(g, 'Max drawdown', st.maxDrawdownPct != null ? st.maxDrawdownPct + '%' : '—', 'tm-bad');
          row(g, 'Avg trade', st.avgTradePct != null ? st.avgTradePct + '%' : '—');
          if (st.costsApplied) row(g, 'Total costs', (st.totalCostsPct || 0) + '%');
          out.appendChild(g);
          if (st.costModel) out.appendChild(h('div', 'tm-mut', 'Cost model: ' + st.costModel.mode + ' · brokerage ' + st.costModel.brokeragePct + '% (min ₹' + st.costModel.brokerageMin + ') · slippage ' + st.costModel.slippagePct + '%/side · deployed ₹' + st.costModel.notional));

          if (st.inSample && st.outOfSample) {
            out.appendChild(h('div', 'tm-sec', 'Train / test split (chronological)'));
            var sg = h('div', 'tm-grid');
            row(sg, 'In-sample', st.inSample.trades + ' trades · ' + st.inSample.winRate + '% · PF ' + st.inSample.profitFactor + ' · ' + st.inSample.netProfitPct + '%');
            row(sg, 'Out-of-sample', st.outOfSample.trades + ' trades · ' + st.outOfSample.winRate + '% · PF ' + st.outOfSample.profitFactor + ' · ' + st.outOfSample.netProfitPct + '%');
            out.appendChild(sg);
          }

          var trs = (j.trades || []).slice(-20).reverse();
          if (trs.length) {
            out.appendChild(h('div', 'tm-sec', 'Trades (latest ' + trs.length + ')'));
            var box = h('div', 'tm-scroll');
            var t = document.createElement('table'); t.className = 'tm-tbl';
            t.innerHTML = '<thead><tr><th>Entry</th><th>Exit</th><th>Reason</th><th>Gross%</th><th>Cost%</th><th>Net%</th></tr></thead>';
            var tb = document.createElement('tbody');
            trs.forEach(function (x) {
              var tr = document.createElement('tr');
              [fmtDate(x.entryTs, true), fmtDate(x.exitTs, true), x.reason, x.grossPct, x.costPct, x.pct].forEach(function (val, i) {
                var td = document.createElement('td');
                if (i >= 3) { td.textContent = (val == null ? '—' : (val >= 0 ? '+' : '') + Number(val).toFixed(2)); if (i === 5 && val != null) td.style.color = val >= 0 ? '#34d399' : '#fb7185'; }
                else td.textContent = val == null ? '—' : String(val);
                tr.appendChild(td);
              });
              tb.appendChild(tr);
            });
            t.appendChild(tb); box.appendChild(t); out.appendChild(box);
          }
          out.appendChild(h('p', 'tm-mut', 'Deterministic engine output over real history. Past performance is not indicative of future results.'));
        })
        .catch(function (e) { out.textContent = ''; out.appendChild(h('div', 'tm-bad', 'Failed: ' + e.message)); });
    });
    setTimeout(function () { if (!sym) symIn.focus(); }, 20);
  }

  function openRiskPanel() {
    var body = openPanel('Risk controls');
    function load() {
      body.textContent = '';
      body.appendChild(h('div', 'tm-mut', 'Loading risk state…'));
      fetch('/api/risk/state').then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
        body.textContent = '';
        if (!res.ok) { body.appendChild(h('div', 'tm-bad', res.j.error || 'Sign in to manage risk')); return; }
        var j = res.j;
        var head = h('div'); head.style.display = 'flex'; head.style.alignItems = 'center'; head.style.gap = '10px';
        head.appendChild(h('span', 'tm-pill', 'Mode: ' + j.mode));
        var ks = h('button', 'tm-btn' + (j.killSwitch ? ' danger' : ''), j.killSwitch ? 'Kill switch: ON — click to arm trading' : 'Kill switch: OFF — click to block new orders');
        ks.addEventListener('click', function () {
          ks.disabled = true;
          fetch('/api/risk/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !j.killSwitch }) })
            .then(function () { load(); });
        });
        head.appendChild(ks);
        body.appendChild(head);

        body.appendChild(h('div', 'tm-sec', 'Limits'));
        var lg = h('div', 'tm-grid');
        row(lg, 'Max risk per trade', j.limits.maxRiskPerTradePct + '% of capital');
        row(lg, 'Max daily loss', j.limits.maxDailyLossPct + '%  (₹' + j.usage.dailyLossLimit + ')');
        row(lg, 'Max drawdown', j.limits.maxDrawdownPct + '%  (₹' + j.usage.drawdownLimit + ')');
        row(lg, 'Max open positions', j.limits.maxPositions);
        row(lg, 'Stop / target', j.limits.slPct + '% / ' + j.limits.tpPct + '%');
        body.appendChild(lg);

        body.appendChild(h('div', 'tm-sec', 'Today'));
        var ug = h('div', 'tm-grid');
        row(ug, 'Day P&L', j.usage.dayPnlFmt, j.usage.dayPnl < 0 ? 'tm-bad' : 'tm-good');
        row(ug, 'Open positions', j.usage.openCount);
        row(ug, 'Trades closed today', j.usage.tradesToday);
        row(ug, 'Peak drawdown', '₹' + j.usage.maxDrawdown, j.usage.drawdownBreached ? 'tm-bad' : '');
        row(ug, 'Daily loss breached', j.usage.dailyLossBreached ? 'YES' : 'no', j.usage.dailyLossBreached ? 'tm-bad' : 'tm-good');
        body.appendChild(ug);

        body.appendChild(h('p', 'tm-mut', 'Live-mode orders remain disabled by default and require an explicit broker authorisation. The kill switch blocks every new position (paper and live) and is written to the audit log.'));
      }).catch(function (e) { body.appendChild(h('div', 'tm-bad', 'Failed: ' + e.message)); });
    }
    load();
  }

  /* ── expose for debugging / tests ──────────────────────────────────── */
  window.__shell = { open: open, close: close, toggleTheme: toggleTheme, setCollapsed: setCollapsed, openResearch: openResearch, openRiskPanel: openRiskPanel, openOptions: openOptions, openPayoff: openPayoff, openBacktest: openBacktest, resetSideWidth: resetSideWidth, resetSplitRatio: resetSplitRatio };
})();
