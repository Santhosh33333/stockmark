// Zero-dependency response compression (gzip) for text/binary-safe types.
//
// Spec A (speed): cold loads ship ~180 KB of JS/CSS and JSON APIs uncompressed.
// This middleware gzips compressible responses on the fly using Node's built-in
// `zlib` — no new dependency, no paid tier. It deliberately does NOT touch:
//   • Server-Sent Events (text/event-stream / Cache-Control: no-transform)
//   • Range responses (206 / Content-Range) — partial bodies must stay raw
//   • already-encoded bodies, 204/304, HEAD requests, opt-out via x-no-compress
'use strict';
const zlib = require('zlib');

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|problem\+json|ld\+json|x-ndjson)|image\/svg\+xml)/i;

function isCompressibleType(type) {
  if (!type || /event-stream/i.test(type)) return false;
  return COMPRESSIBLE.test(type);
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

module.exports = function compress() {
  return function compressMw(req, res, next) {
    if (req.method === 'HEAD' || !acceptsGzip(req)) return next();

    const rawWrite = res.write.bind(res);
    const rawEnd = res.end.bind(res);
    let mode = null;          // null (undecided) | 'gzip' | 'plain'
    let gz = null;
    let endCb = null;

    function start() {
      const status = res.statusCode;
      const type = String(res.getHeader('Content-Type') || '');
      const cc = String(res.getHeader('Cache-Control') || '');
      const len = Number(res.getHeader('Content-Length'));
      const tiny = Number.isFinite(len) && len > 0 && len < 512; // gzip overhead not worth it
      const skip = tiny
        || res.getHeader('x-no-compress') != null
        || /no-transform/i.test(cc)
        || res.getHeader('Content-Encoding') != null
        || res.getHeader('Content-Range') != null
        || status < 200 || status === 204 || status === 304 || status === 206
        || !isCompressibleType(type);
      if (skip) { mode = 'plain'; return; }

      mode = 'gzip';
      gz = zlib.createGzip({ level: 6 });
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');
      gz.on('data', (d) => { rawWrite(d); });
      gz.on('end', () => { try { rawEnd(endCb); } catch { /* socket closed */ } });
      gz.on('error', () => { try { rawEnd(); } catch { /* socket closed */ } });
    }

    res.write = function (chunk, enc, cb) {
      if (mode === null) start();
      if (mode === 'gzip') {
        if (chunk != null) gz.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : undefined));
        if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
        return true;
      }
      return rawWrite(chunk, enc, cb);
    };

    res.end = function (chunk, enc, cb) {
      if (mode === null) start();
      if (mode === 'gzip') {
        const done = typeof chunk === 'function' ? chunk : (typeof enc === 'function' ? enc : cb);
        endCb = typeof done === 'function' ? done : null;
        if (chunk != null && typeof chunk !== 'function') gz.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : undefined));
        gz.end();
        return res;
      }
      return rawEnd(chunk, enc, cb);
    };

    next();
  };
};
