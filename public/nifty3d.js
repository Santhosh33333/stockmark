/* NIFTY 50 — live rotating 3D candlestick landscape.
   Real data only: daily / 4H candles from /api/analysis/^NSEI, live index price from /api/market/status.
   No fabricated prices. If the provider is unreachable we say so and draw nothing. */
(function () {
  'use strict';
  const canvas = document.getElementById('n3d');
  const ctx = canvas.getContext('2d');
  const els = {
    loading: document.getElementById('loading'),
    px: document.getElementById('px'), chg: document.getElementById('chg'),
    rsi: document.getElementById('rsi'), rng: document.getElementById('rng'),
    bars: document.getElementById('bars'), mkt: document.getElementById('mkt'),
    updated: document.getElementById('updated'),
  };
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    W: 0, H: 0, dpr: 1,
    daily: [], h4: [], tf: 'D',
    price: null, changePct: null, rsi4h: null, market: null,
    bars: [], lo: 0, hi: 1, dataLo: 0, dataHi: 0,
    spin: !reduceMotion, yawBase: -0.55, t0: performance.now(),
    loaded: false, live: null,
  };
  const N_BARS = 56;
  const DX = 16, HW = 5, SCENE_H = 430;

  // ── helpers ──
  function inr(v, d) {
    if (v == null || !isFinite(v)) return '₹—';
    return '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 });
  }
  const pct = (v) => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
    const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
    const b = Math.min(255, Math.round((n & 255) * f));
    return `rgb(${r},${g},${b})`;
  }
  const UP = '#22e08a', DOWN = '#ff4d6d';

  function resize() {
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    state.W = canvas.clientWidth || window.innerWidth;
    state.H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(state.W * state.dpr);
    canvas.height = Math.round(state.H * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }
  window.addEventListener('resize', () => { resize(); render(); });

  // ── camera + projection ──
  function camera(t) {
    const spin = state.spin ? Math.sin(t / 8000) * 0.5 : 0;
    return {
      yaw: state.yawBase + spin,
      pitch: 0.30 + (state.spin ? Math.sin(t / 11000) * 0.06 : 0),
      dist: 1180, fov: 900,
      cx: state.W / 2, cy: state.H * 0.60,
    };
  }
  function project(x, y, z, cam) {
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
    const rx = x * c - z * s;
    let rz = x * s + z * c;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const ry = y * cp - rz * sp;
    rz = y * sp + rz * cp;
    const zc = rz + cam.dist;
    const k = cam.fov / Math.max(80, zc);
    return { x: cam.cx + rx * k, y: cam.cy - ry * k, z: zc };
  }

  // ── build bar geometry from the current candles ──
  function buildBars() {
    const src = (state.tf === '4H' ? state.h4 : state.daily) || [];
    const view = src.slice(-N_BARS);
    if (!view.length) { state.bars = []; return; }
    let lo = Infinity, hi = -Infinity, vmax = 1, dlo = Infinity, dhi = -Infinity;
    for (const c of view) {
      lo = Math.min(lo, c.c); hi = Math.max(hi, c.c);
      vmax = Math.max(vmax, c.v || 0);
      dlo = Math.min(dlo, c.l); dhi = Math.max(dhi, c.h);
    }
    const pad = (hi - lo) * 0.14 || 1;
    state.lo = lo - pad; state.hi = hi + pad;
    state.dataLo = dlo; state.dataHi = dhi;
    const n = view.length;
    const yOf = (p) => ((p - state.lo) / (state.hi - state.lo)) * SCENE_H - SCENE_H / 2;
    state.bars = view.map((c, i) => ({
      bx: (i - (n - 1) / 2) * DX,
      yT: yOf(c.c),
      yB: -SCENE_H / 2,
      d: 8 + ((c.v || 0) / vmax) * 26,
      up: c.c >= c.o,
      live: i === n - 1,
    }));
  }

  function quad(pts, fill) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function drawGround(cam) {
    const base = -SCENE_H / 2;
    const halfW = (N_BARS * DX) / 2 + 40;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,150,200,.10)';
    for (const gz of [-60, -30, 0, 30, 60]) {
      const a = project(-halfW, base, gz, cam), b = project(halfW, base, gz, cam);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let gx = -halfW; gx <= halfW; gx += halfW / 6) {
      const a = project(gx, base, -60, cam), b = project(gx, base, 60, cam);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }

  function drawBars(cam) {
    const bars = state.bars;
    if (!bars.length) return;
    // depth-sort far → near
    const order = bars.map((b, i) => ({ i, z: project(b.bx, (b.yT + b.yB) / 2, 0, cam).z }))
      .sort((a, b) => b.z - a.z);

    for (const { i } of order) {
      const b = bars[i];
      const base = b.up ? UP : DOWN;
      const xL = b.bx - HW, xR = b.bx + HW;
      const zF = -b.d / 2, zB = b.d / 2;
      // pick near/far z-planes by projected depth
      const nearZ = project(b.bx, 0, zF, cam).z < project(b.bx, 0, zB, cam).z ? zF : zB;
      const farZ = nearZ === zF ? zB : zF;
      const corners = (z) => [
        project(xL, b.yT, z, cam), project(xR, b.yT, z, cam),
        project(xR, b.yB, z, cam), project(xL, b.yB, z, cam),
      ];
      const f = corners(farZ), nr = corners(nearZ);
      // far face (dark)
      quad(f, shade(base, 0.42));
      // connecting faces: 0-1 top, 1-2 right, 2-3 bottom, 3-0 left
      const faceShade = [1.30, 0.74, 0.34, 0.86];
      for (let e = 0; e < 4; e++) {
        const j = (e + 1) % 4;
        quad([f[e], f[j], nr[j], nr[e]], shade(base, faceShade[e]));
      }
      // near face (main)
      quad(nr, shade(base, 1));
      ctx.strokeStyle = 'rgba(0,0,0,.22)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // glow on the newest live bar
      if (b.live) {
        const top = project(b.bx, b.yT, nearZ, cam);
        const grd = ctx.createRadialGradient(top.x, top.y, 0, top.x, top.y, 46);
        grd.addColorStop(0, b.up ? 'rgba(34,224,138,.55)' : 'rgba(255,77,109,.5)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(top.x, top.y, 46, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function render(now) {
    ctx.clearRect(0, 0, state.W, state.H);
    if (!state.loaded) return;
    const t = now == null ? performance.now() : now;
    const cam = camera(t);
    drawGround(cam);
    drawBars(cam);
  }
  function frame(now) {
    render(now);
    requestAnimationFrame(frame);
  }

  // ── HUD ──
  function updateHud() {
    const px = state.live != null ? state.live : state.price;
    // Derive % change from the SAME series we draw, so the label and the chart always agree.
    if (px != null && state.prevClose) state.changePct = +(((px - state.prevClose) / state.prevClose) * 100).toFixed(2);
    els.px.textContent = inr(px, 2);
    els.chg.textContent = pct(state.changePct);
    els.chg.className = 'chg ' + ((state.changePct || 0) >= 0 ? 'u' : 'd');
    els.rsi.textContent = state.rsi4h ?? '—';
    els.rng.textContent = inr(state.dataLo, 0) + ' – ' + inr(state.dataHi, 0);
    els.bars.textContent = state.bars.length;
    els.mkt.textContent = state.market || '—';
    els.updated.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  // ── data ──
  async function load() {
    els.loading.classList.remove('hidden');
    els.loading.querySelector('div').innerHTML = '<div class="spin"></div>Fetching live NIFTY data…';
    try {
      const r = await fetch('/api/analysis/' + encodeURIComponent('^NSEI'));
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'no data');
      state.daily = j.candles || [];
      state.h4 = j.candles4h || [];
      state.price = j.price ?? null;
      state.changePct = j.changePct ?? null;
      state.rsi4h = j.rsi4h ?? null;
      state.live = j.price ?? null;
      state.prevClose = state.daily.length > 1 ? state.daily[state.daily.length - 2].c : null;
      buildBars();
      updateHud();
      state.loaded = true;
      els.loading.classList.add('hidden');
      render();
    } catch (e) {
      state.loaded = false;
      els.loading.querySelector('div').innerHTML = '<div style="font-size:34px">⚠️</div>Live NIFTY data unavailable right now.<br><span style="color:var(--dim2)">' + String(e.message) + '</span><br>Showing nothing rather than a fake chart.';
    }
  }

  async function poll() {
    try {
      const j = await (await fetch('/api/market/status')).json();
      const n = (j.indices || []).find((x) => x.symbol === '^NSEI');
      if (n && n.price != null) { state.live = n.price; }
      state.market = j.status && j.status.state;
      updateHud();
    } catch { /* keep last known */ }
  }

  // ── controls ──
  document.querySelectorAll('#tf-seg button').forEach((b) => {
    b.onclick = () => {
      state.tf = b.dataset.tf;
      document.querySelectorAll('#tf-seg button').forEach((x) => x.classList.toggle('active', x === b));
      buildBars(); updateHud(); render();
    };
  });
  const btnSpin = document.getElementById('btn-spin');
  btnSpin.onclick = () => { state.spin = !state.spin; btnSpin.textContent = state.spin ? '⏸ Pause' : '▶ Play'; render(); };
  if (reduceMotion) btnSpin.textContent = '▶ Play';
  document.getElementById('btn-refresh').onclick = () => load();

  // harmless debug handle (used to force a frame from tests/tools)
  window.__nifty3d = { render, state };

  // ── boot ──
  resize();
  render();
  requestAnimationFrame(frame);
  load();
  poll();
  setInterval(poll, 20000);
})();
