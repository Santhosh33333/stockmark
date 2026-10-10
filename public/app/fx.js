/* ═══════════════════════════════════════════════════════════════════
   TradeMind 2.0 — fx.js
   Shared 3D + motion layer for the landing page AND the app.
   - Parallax aurora background
   - 3D pointer-tilt on cards / panels
   - Cursor-follow glow on hover
   - Staggered list reveals + route transitions
   All effects are disabled for users who prefer reduced motion.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* selectors that become 3D-tiltable surfaces */
  const TILT = ['[data-tilt]', '.card', '.feat', '.plan', '.terminal', '.stat', '.res'].join(',');
  const MAX_TILT = 7;      // degrees
  const GLOW = true;

  /* ── parallax aurora background ── */
  const scene = document.getElementById('bg-scene');
  if (scene && !reduce) {
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    window.addEventListener('pointermove', (e) => {
      tx = (e.clientX / window.innerWidth - 0.5);
      ty = (e.clientY / window.innerHeight - 0.5);
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
    function loop() {
      cx += (tx - cx) * 0.05;
      cy += (ty - cy) * 0.05;
      scene.style.transform = `translate3d(${(cx * 26).toFixed(1)}px, ${(cy * 26).toFixed(1)}px, 0)`;
      raf = (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) ? requestAnimationFrame(loop) : 0;
    }
  }

  /* ── 3D tilt + cursor glow ── */
  function enhance(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll(TILT).forEach((el) => {
      if (el.__fx) return;
      el.__fx = true;
      if (GLOW) el.classList.add('fx-glow');
      if (reduce) return;
      el.classList.add('fx-tilt');
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerleave', onLeave);
    });
    /* staggered entrance for repeated children inside a freshly rendered panel */
    const groups = ['.stats-grid', '.features', '.plans', '.steps', '.results', '.sig-grid', '.admin-tabs'];
    root.querySelectorAll(groups.join(',')).forEach((g) => {
      [...g.children].forEach((c, i) => {
        if (c.__st) return; c.__st = true;
        c.style.animationDelay = Math.min(i * 55, 380) + 'ms';
      });
    });
  }

  function onMove(e) {
    const el = e.currentTarget, r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty('--mx', (e.clientX - r.left).toFixed(0) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top).toFixed(0) + 'px');
    el.style.transform = `perspective(1000px) rotateX(${(-py * MAX_TILT).toFixed(2)}deg) rotateY(${(px * MAX_TILT).toFixed(2)}deg) translateZ(0)`;
  }
  function onLeave(e) {
    const el = e.currentTarget;
    el.style.transform = '';
  }

  /* ── route/content transition for the SPA ── */
  const view = document.getElementById('view');
  if (view) {
    const obs = new MutationObserver(() => {
      if (reduce) return;
      view.classList.remove('view-anim'); void view.offsetWidth; view.classList.add('view-anim');
      enhance(view);
    });
    obs.observe(view, { childList: true });
  }

  /* ── initial pass ── */
  function boot() { enhance(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  /* re-run once images/fonts settle */
  window.addEventListener('load', boot);
})();
