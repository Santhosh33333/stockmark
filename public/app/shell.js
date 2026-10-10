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
    var b = $('#side-collapse');
    if (b) { b.textContent = on ? '›' : '‹'; b.setAttribute('aria-expanded', String(!on)); b.title = on ? 'Expand sidebar' : 'Collapse sidebar'; }
    try { localStorage.setItem('tm-sidebar', on ? 'collapsed' : 'open'); } catch (e) { }
    // charts resize after the layout change
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 220);
  }
  try { if (localStorage.getItem('tm-sidebar') === 'collapsed') setCollapsed(true); } catch (e) { }
  var collapseBtn = $('#side-collapse'); if (collapseBtn) collapseBtn.addEventListener('click', function () { setCollapsed(!(shellEl && shellEl.classList.contains('collapsed'))); });

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
      var cls = !at ? 'cached' : age < 5 * 60e3 ? 'live' : age < 20 * 60e3 ? 'cached' : 'stale';
      paintFresh(cls, src, ago(at));
    }).catch(function () { paintFresh('off', 'offline', 'unavailable'); });
  }
  loadFreshness(); setInterval(loadFreshness, 45000);

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
      { label: 'Sign out', sub: 'Session', ic: '⏻', run: function () { var b = $('#btn-logout'); if (b) b.click(); } }
    ];
    ACTS.forEach(function (a) { if (!ql || a.label.toLowerCase().indexOf(ql) > -1) add('Actions', { label: a.label, sub: a.sub, ic: a.ic, run: a.run }); });

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

  /* ── expose for debugging / tests ──────────────────────────────────── */
  window.__shell = { open: open, close: close, toggleTheme: toggleTheme, setCollapsed: setCollapsed };
})();
