/* StockArtha Chart Engine — dependency-free canvas candlestick chart with
   order-block zones, wick-rejection marks, inducement labels and RSI pane. */
(function () {
  const UP = '#22c55e', DOWN = '#ef4444', GRID = 'rgba(148,163,184,.10)';
  const TEXT = '#94a3b8', ZONE = 'rgba(59,130,246,.20)', ZONE_MIT = 'rgba(100,116,139,.14)';
  const ACCENT = '#38bdf8', WICK = '#a855f7', BUY = '#22c55e';

  function fmt(n) {
    if (n == null || !isFinite(n)) return '—';
    return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  class CandleChart {
    constructor(canvas, opts = {}) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({ padding: { top: 16, right: 62, bottom: 22, left: 8 }, rsiPane: true, rsiH: 64, volPane: false }, opts);
      this.candles = [];
      this.zones = [];
      this.signals = [];
      this.inducements = [];
      this.fvgs = [];
      this.structure = null;
      this.rsi = [];
      this.view = { from: 0, to: 0 };
      this.hover = null;
      this.animT = 0;
      this._bind();
      this._resize();
      window.addEventListener('resize', () => this._resize());
    }

    setData({ candles = [], zones = [], signals = [], inducements = [], fvgs = [], structure = null, rsi = [] }) {
      this.candles = candles;
      this.zones = zones;
      this.signals = signals;
      this.inducements = inducements;
      this.fvgs = fvgs;
      this.structure = structure;
      this.rsi = rsi;
      const n = candles.length;
      const show = Math.min(n, 110);
      this.view.from = Math.max(0, n - show);
      this.view.to = n;
      this.animT = 1;
      this.render();
      this._animate();
    }

    _animate() {
      const step = () => {
        this.animT -= 0.06;
        if (this.animT <= 0) { this.animT = 0; this.render(); return; }
        this.render();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.c.getBoundingClientRect();
      this.w = Math.max(320, rect.width || this.c.clientWidth || 360);
      this.h = Math.max(260, rect.height || this.c.clientHeight || 420);
      this.c.width = this.w * dpr;
      this.c.height = this.h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render();
    }

    _bind() {
      const move = (e) => {
        const rect = this.c.getBoundingClientRect();
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
        this.hover = { x, y };
        this.render();
      };
      const leave = () => { this.hover = null; this.render(); };
      this.c.addEventListener('mousemove', move);
      this.c.addEventListener('mouseleave', leave);
      this.c.addEventListener('touchstart', move, { passive: true });
      this.c.addEventListener('touchmove', move, { passive: true });
      this.c.addEventListener('touchend', leave);
      this.c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const n = this.view.to - this.view.from;
        const shift = e.deltaY > 0 ? Math.ceil(n * 0.12) : -Math.ceil(n * 0.12);
        this.view.from = Math.max(0, this.view.from + shift);
        this.view.to = Math.min(this.candles.length, this.view.to + shift);
        if (this.view.to - this.view.from < 20) { this.view.to = this.view.from + 20; }
        this.render();
      }, { passive: false });
    }

    render() {
      const ctx = this.ctx, W = this.w, H = this.h;
      const P = this.opts.padding;
      const rsiH = this.opts.rsiPane ? this.opts.rsiH : 0;
      const priceTop = P.top, priceBottom = H - P.bottom - rsiH - (rsiH ? 8 : 0);
      const priceH = priceBottom - priceTop;
      ctx.clearRect(0, 0, W, H);

      const view = this.candles.slice(this.view.from, this.view.to);
      if (!view.length) { ctx.fillStyle = TEXT; ctx.font = '13px system-ui'; ctx.fillText('No data', 12, 20); return; }

      // ── scales ──
      let hi = -Infinity, lo = Infinity;
      for (const c of view) { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); }
      for (const z of this.zones) {
        const inView = z.t >= view[0].t && z.t <= view[view.length - 1].t;
        if (inView) { hi = Math.max(hi, z.top); lo = Math.min(lo, z.bottom); }
      }
      for (const f of this.fvgs) {
        const inView = f.t >= view[0].t && f.t <= view[view.length - 1].t;
        if (inView && !f.filled) { hi = Math.max(hi, f.top); lo = Math.min(lo, f.bottom); }
      }
      for (const s of this.signals) { if (s.t >= view[0].t && s.t <= view[view.length - 1].t) hi = Math.max(hi, s.price * 1.01); }
      const pad = (hi - lo) * 0.06 || hi * 0.01;
      hi += pad; lo -= pad;
      const x0 = P.left, x1 = W - P.right;
      const n = view.length;
      const cw = Math.max(2, (x1 - x0) / n);
      const bodyW = Math.max(1.5, cw * 0.62);
      const yP = (p) => priceTop + ((hi - p) / (hi - lo)) * priceH;
      const xI = (i) => x0 + i * cw + cw / 2;

      // ── grid + price axis ──
      ctx.strokeStyle = GRID; ctx.fillStyle = TEXT; ctx.font = '10px system-ui'; ctx.lineWidth = 1;
      for (let g = 0; g <= 4; g++) {
        const p = lo + ((hi - lo) * g) / 4;
        const y = yP(p);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.fillText(fmt(p), x1 + 6, y + 3);
      }

      // ── order block zones ──
      const zoneA = Math.max(0.25, this.animT);
      for (const z of this.zones) {
        const i0 = view.findIndex((c) => c.t >= z.t);
        if (i0 < 0) continue;
        const yT = yP(z.top), yB = yP(z.bottom);
        const xStart = xI(i0) - bodyW / 2 - 1;
        ctx.globalAlpha = z.status === 'MITIGATED' || z.status === 'EXPIRED' ? 0.55 : 0.95;
        ctx.fillStyle = z.status === 'ACTIVE' ? ZONE : ZONE_MIT;
        ctx.fillRect(xStart, yT, x1 - xStart, Math.max(2, yB - yT));
        ctx.strokeStyle = z.status === 'ACTIVE' ? 'rgba(59,130,246,.55)' : 'rgba(100,116,139,.35)';
        ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.strokeRect(xStart, yT, x1 - xStart, Math.max(2, yB - yT));
        ctx.setLineDash([]);
        ctx.fillStyle = z.status === 'ACTIVE' ? 'rgba(147,197,253,.85)' : 'rgba(148,163,184,.5)';
        ctx.font = '9px system-ui';
        ctx.fillText(z.status === 'ACTIVE' ? (z.swept ? 'OB · swept' : 'OB') : 'mitigated', xStart + 3, yT - 3);
        ctx.globalAlpha = 1;
      }

      // ── fair value gaps (imbalance) ──
      for (const f of this.fvgs) {
        const i0 = view.findIndex((c) => c.t >= f.t);
        if (i0 < 0) continue;
        const yT = yP(f.top), yB = yP(f.bottom);
        const xStart = xI(i0) - bodyW / 2;
        // filled gaps stop at their fill bar; unfilled run to the right edge
        let xEnd = x1;
        if (f.filled && f.filledT) {
          const fi = view.findIndex((c) => c.t >= f.filledT);
          if (fi >= 0) xEnd = xI(fi) + bodyW / 2;
        }
        const bull = f.dir === 'BULL';
        ctx.globalAlpha = f.filled ? 0.35 : 0.85;
        ctx.fillStyle = bull ? 'rgba(34,197,94,.16)' : 'rgba(239,68,68,.13)';
        ctx.fillRect(xStart, yT, Math.max(1, xEnd - xStart), Math.max(2, yB - yT));
        ctx.strokeStyle = bull ? 'rgba(34,197,94,.5)' : 'rgba(239,68,68,.45)';
        ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
        ctx.strokeRect(xStart, yT, Math.max(1, xEnd - xStart), Math.max(2, yB - yT));
        ctx.setLineDash([]);
        ctx.fillStyle = bull ? 'rgba(134,239,172,.9)' : 'rgba(252,165,165,.85)';
        ctx.font = '9px system-ui';
        ctx.fillText('FVG' + (f.filled ? '' : ' · open'), xStart + 3, bull ? yT - 3 : yB + 9);
        ctx.globalAlpha = 1;
      }

      // ── candles ──
      const intro = this.animT * view.length;
      for (let i = 0; i < n; i++) {
        const c = view[i];
        const x = xI(i);
        const up = c.c >= c.o;
        const col = up ? UP : DOWN;
        const appear = i > intro ? 0 : Math.min(1, (intro - i) / 8 + 0.35);
        ctx.globalAlpha = appear;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, yP(c.h)); ctx.lineTo(x, yP(c.l)); ctx.stroke();
        const yo = yP(c.o), yc = yP(c.c);
        ctx.fillRect(x - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
        ctx.globalAlpha = 1;
      }

      // ── last price line ──
      const last = view[n - 1];
      const yl = yP(last.c);
      ctx.strokeStyle = 'rgba(56,189,248,.6)'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x0, yl); ctx.lineTo(x1, yl); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ACCENT;
      const lbl = fmt(last.c);
      const lw = ctx.measureText(lbl).width + 10;
      ctx.fillRect(x1 + 2, yl - 8, lw, 16);
      ctx.fillStyle = '#04263a'; ctx.font = 'bold 10px system-ui';
      ctx.fillText(lbl, x1 + 7, yl + 3);

      // ── wick rejection marks (local scan of marks passed via opts.marks) ──
      if (this.opts.marks) {
        ctx.fillStyle = WICK;
        for (const m of this.opts.marks) {
          const i = view.findIndex((c) => c.t === m.t);
          if (i < 0) continue;
          const x = xI(i), y = yP(view[i].l);
          ctx.beginPath();
          ctx.moveTo(x, y + 4); ctx.lineTo(x - 4, y + 12); ctx.lineTo(x + 4, y + 12);
          ctx.closePath(); ctx.fill();
        }
      }

      // ── inducement markers (filtered sweeps) ──
      for (const s of this.inducements) {
        const i = view.findIndex((c) => c.t === s.t);
        if (i < 0) continue;
        const x = xI(i), y = yP(view[i].l) + 4;
        ctx.fillStyle = 'rgba(251,191,36,.9)';
        ctx.beginPath(); ctx.arc(x, y + 18, 2.6, 0, Math.PI * 2); ctx.fill();
      }

      // ── BUY signals ──
      for (const s of this.signals) {
        const i = view.findIndex((c) => c.t === s.t);
        if (i < 0) continue;
        const x = xI(i);
        const y = yP(view[i].l);
        const pulse = this.animT ? Math.abs(Math.sin(Date.now() / 260)) * 6 * this.animT : 0;
        ctx.fillStyle = BUY;
        ctx.beginPath();
        ctx.moveTo(x, y + 18 + pulse); ctx.lineTo(x - 6, y + 30 + pulse); ctx.lineTo(x + 6, y + 30 + pulse);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(34,197,94,.95)';
        ctx.font = 'bold 9px system-ui';
        ctx.fillText('BUY', x - 9, y + 42 + pulse);
      }

      // ── market-structure events (BOS / CHoCH) ──
      const sEvents = (this.structure && this.structure.events) || [];
      for (const e of sEvents) {
        const i = view.findIndex((c) => c.t === e.t);
        if (i < 0) continue;
        const x = xI(i);
        const bull = e.dir === 'BULL';
        const y = bull ? yP(view[i].h) - 6 : yP(view[i].l) + 6;
        ctx.strokeStyle = bull ? 'rgba(34,197,94,.9)' : 'rgba(239,68,68,.9)';
        ctx.fillStyle = bull ? 'rgba(34,197,94,.95)' : 'rgba(239,68,68,.95)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        if (bull) { ctx.moveTo(x, y - 6); ctx.lineTo(x - 4, y + 2); ctx.lineTo(x + 4, y + 2); }
        else { ctx.moveTo(x, y + 6); ctx.lineTo(x - 4, y - 2); ctx.lineTo(x + 4, y - 2); }
        ctx.closePath(); ctx.fill();
        ctx.font = 'bold 8px system-ui';
        ctx.fillStyle = e.type === 'CHoCH' ? 'rgba(251,191,36,.95)' : (bull ? 'rgba(134,239,172,.95)' : 'rgba(252,165,165,.95)');
        ctx.fillText(e.type, x - (e.type === 'CHoCH' ? 13 : 8), bull ? y - 9 : y + 16);
      }

      // ── time axis ──
      ctx.fillStyle = TEXT; ctx.font = '9px system-ui';
      const step = Math.max(1, Math.floor(n / 6));
      for (let i = 0; i < n; i += step) {
        const d = new Date(view[i].t);
        const label = `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
        ctx.fillText(label, xI(i) - 12, H - 8);
      }

      // ── RSI pane ──
      if (this.opts.rsiPane) {
        const ry0 = priceBottom + 10, ry1 = ry0 + rsiH - 12;
        ctx.strokeStyle = GRID;
        ctx.strokeRect(x0, ry0, x1 - x0, ry1 - ry0);
        const yR = (v) => ry1 - (v / 100) * (ry1 - ry0);
        [30, 50, 70].forEach((lv) => {
          ctx.setLineDash(lv === 50 ? [4, 4] : []);
          ctx.strokeStyle = lv === 50 ? 'rgba(56,189,248,.35)' : 'rgba(239,68,68,.25)';
          ctx.beginPath(); ctx.moveTo(x0, yR(lv)); ctx.lineTo(x1, yR(lv)); ctx.stroke();
          ctx.setLineDash([]);
        });
        if (this.rsi.length) {
          ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.4; ctx.beginPath();
          let started = false;
          for (let i = 0; i < n; i++) {
            const c = view[i];
            const val = this.rsi.find((r) => r && r.t <= c.t);
            const v = val ? val.v : null;
            if (v == null) continue;
            const x = xI(i), y = yR(v);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.fillStyle = TEXT; ctx.font = '9px system-ui';
        ctx.fillText('4H RSI', x0 + 4, ry0 + 10);
      }

      // ── crosshair tooltip ──
      if (this.hover && this.hover.x > x0 && this.hover.x < x1) {
        const i = Math.max(0, Math.min(n - 1, Math.floor((this.hover.x - x0) / cw)));
        const c = view[i];
        const x = xI(i);
        ctx.strokeStyle = 'rgba(226,232,240,.25)'; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x, priceTop); ctx.lineTo(x, priceBottom); ctx.stroke(); ctx.setLineDash([]);
        const boxW = 150, boxH = 66;
        let bx = Math.min(x + 10, W - boxW - 4);
        let by = Math.max(priceTop + 4, Math.min(this.hover.y - 20, priceBottom - boxH));
        ctx.fillStyle = 'rgba(2,16,34,.94)';
        ctx.strokeStyle = 'rgba(56,189,248,.35)';
        ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 8); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#e2e8f0'; ctx.font = '10px system-ui';
        const d = new Date(c.t);
        const lines = [
          `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)}`,
          `O ${fmt(c.o)}  H ${fmt(c.h)}`,
          `L ${fmt(c.l)}  C ${fmt(c.c)}`,
          `Vol ${c.v >= 1e5 ? (c.v / 1e5).toFixed(1) + 'L' : fmt(c.v)}`,
        ];
        lines.forEach((l, k) => ctx.fillText(l, bx + 8, by + 14 + k * 13));
      }
    }
  }

  window.CandleChart = CandleChart;
})();
