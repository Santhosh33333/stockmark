/* Generates PWA / Play Store PNG icons with zero dependencies (zlib + hand-rolled PNG encoder).
   Artwork matches public/logo.svg (rounded square, glow, ring, grid, candles, trend arrow, wordmark pill). */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

class Raster {
  constructor(size) {
    this.s = size;
    this.px = Buffer.alloc(size * size * 4, 0);
  }
  blend(x, y, r, g, b, a = 1) {
    if (x < 0 || y < 0 || x >= this.s || y >= this.s) return;
    const i = (y * this.s + x) * 4;
    const ia = this.px[i + 3] / 255;
    const oa = a + ia * (1 - a);
    if (oa <= 0) return;
    this.px[i] = (r * a + this.px[i] * ia * (1 - a)) / oa;
    this.px[i + 1] = (g * a + this.px[i + 1] * ia * (1 - a)) / oa;
    this.px[i + 2] = (b * a + this.px[i + 2] * ia * (1 - a)) / oa;
    this.px[i + 3] = Math.min(255, oa * 255);
  }
  disc(cx, cy, rad, col, alpha = 1, glow = 0) {
    if (glow) {
      for (let dy = -rad - glow; dy <= rad + glow; dy++) {
        for (let dx = -rad - glow; dx <= rad + glow; dx++) {
          const d = Math.hypot(dx, dy);
          if (d <= rad + glow && d > rad) {
            const t = 1 - (d - rad) / glow;
            this.blend(cx + dx, cy + dy, col[0], col[1], col[2], alpha * t * t);
          }
        }
      }
    }
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx * dx + dy * dy <= rad * rad) this.blend(cx + dx, cy + dy, col[0], col[1], col[2], alpha);
      }
    }
  }
  roundRect(x0, y0, w, h, rad, col, alpha = 1) {
    for (let y = Math.floor(y0); y < y0 + h; y++) {
      for (let x = Math.floor(x0); x < x0 + w; x++) {
        const cx = Math.min(Math.max(x, x0 + rad), x0 + w - rad);
        const cy = Math.min(Math.max(y, y0 + rad), y0 + h - rad);
        if (Math.hypot(x - cx, y - cy) > rad) continue;
        this.blend(x, y, col[0], col[1], col[2], alpha);
      }
    }
  }
  thickLine(x0, y0, x1, y1, w, col, glow = 0) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, col, 1, glow);
    }
  }
}

// ── PNG encoder ─────────────────────────────────────────────────────────
const table = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c >>> 0;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    const c = (crc ^ buf[n]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(raster) {
  const s = raster.s;
  const raw = Buffer.alloc(s * (s * 4 + 1));
  for (let y = 0; y < s; y++) {
    raw[y * (s * 4 + 1)] = 0;
    raster.px.copy(raw, y * (s * 4 + 1) + 1, y * s * 4, (y + 1) * s * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Artwork (matches public/logo.svg) ──────────────────────────────────
function drawLogo(S, { maskable = false } = {}) {
  const r = new Raster(S);
  const u = S / 512;
  const inset = maskable ? 0.10 : 0.04;

  // background gradient
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = y / S;
      const base = [
        Math.round(10 + t * 6 + (1 - Math.hypot(x / S - 0.8, y / S - 0.15) * 6) * 12),
        Math.round(37 + (1 - t) * 6),
        Math.round(71 + (1 - t) * 20),
      ];
      r.blend(x, y, Math.min(255, base[0]), Math.min(255, base[1]), Math.min(255, base[2]), 1);
    }
  }

  const pad = S * inset;
  const size = S - pad * 2;
  const scale = maskable ? 0.72 : 0.86;

  // rounded frame + ring
  const ringW = Math.max(3, 7 * u);
  r.roundRect(pad + ringW / 2, pad + ringW / 2, size - ringW, size - ringW, size * 0.20, [56, 189, 248], 0.55);

  // faint grid
  const grid = [140, 196, 292, 384].map((v) => pad + (v - 24) * (size / 464) * scale);
  for (const gy of grid) r.thickLine(pad + 30 * u * scale, gy, pad + size - 30 * u * scale, gy, 1.6 * u * scale, [56, 189, 248], 0);
  for (const gx of grid) r.thickLine(gx, pad + 60 * u * scale, gx, pad + size - 60 * u * scale, 1.6 * u * scale, [56, 189, 248], 0);

  const ox = pad + (maskable ? 0.14 : 0.07) * size, oy = pad + 0.14 * size;
  const C = (vx, vy) => [ox + (vx - 96) * (size / 320) * (maskable ? 0.82 : 0.86), oy + (vy - 150) * (size / 300) * 0.92];

  // candles (x, top, bottom) — matches logo.svg geometry
  const candles = [
    { x: 125, top: 150, bot: 380, col: [225, 29, 72], wick: [150, 380] },
    { x: 197, top: 110, bot: 380, col: [190, 18, 60], wick: [104, 380] },
    { x: 269, top: 166, bot: 380, col: [34, 197, 94], wick: [110, 380] },
    { x: 341, top: 110, bot: 380, col: [22, 163, 74], wick: [92, 380] },
  ];
  for (const c of candles) {
    const [wx] = C(c.x, 0);
    const [, y0] = C(0, c.wick[0]), [, y1] = C(0, c.wick[1]);
    r.thickLine(wx, y0, wx, y1, 5 * u * scale, c.col, 8 * u * scale);
    const [bx, by] = C(c.x, c.top);
    const [, byy] = C(0, c.bot);
    const w = 24 * u * scale * 0.6;
    r.roundRect(bx - w / 2, by, w, byy - by, w * 0.3, c.col, 0.95);
  }

  // trend arrow
  r.thickLine(...C(150, 380), ...C(268, 268), 13 * u * scale, [34, 197, 94], 14 * u * scale);
  r.thickLine(...C(268, 268), ...C(318, 320), 13 * u * scale, [74, 222, 128], 14 * u * scale);
  r.thickLine(...C(318, 320), ...C(408, 220), 13 * u * scale, [163, 230, 53], 16 * u * scale);
  const [ax, ay] = C(400, 220);
  r.thickLine(ax, ay, ax + 30 * u * scale, ay - 30 * u * scale, 12 * u * scale, [163, 230, 53], 12 * u * scale);
  r.thickLine(ax + 30 * u * scale, ay - 30 * u * scale, ax + 30 * u * scale, ay + 8 * u * scale, 12 * u * scale, [163, 230, 53], 12 * u * scale);

  // wordmark pill
  const pillW = 160 * u * scale, pillH = 34 * u * scale;
  const pillX = pad + (size - pillW) / 2, pillY = pad + size - pillH - 14 * u * scale;
  r.roundRect(pillX, pillY, pillW, pillH, pillH / 2, [14, 165, 233], 0.9);

  return encodePNG(r);
}

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];
for (const t of targets) {
  const raster = drawLogo(t.size, { maskable: t.maskable });
  fs.writeFileSync(path.join(OUT, t.file), raster);
  console.log('wrote', t.file, `(${t.size}px, ${(raster.length / 1024).toFixed(1)} KB)`);
}
console.log('icons done →', OUT);
