// Free public symbol masters: all NSE equity, all BSE equity, NSE F&O, Nifty index lists.
// Sources are official NSE/BSE archive endpoints (no API key, no cost).
const fs = require('fs');
const { httpText, httpJson, parseCsv, pMap } = require('../util');
const config = require('../../config');

let universe = null;
let loadingPromise = null;

// ── NSE equity (EQ series) ───────────────────────────────────────────────
async function fetchNseEquity() {
  const text = await httpText('https://archives.nseindia.com/content/equities/EQUITY_L.csv', { timeoutMs: 45000, retry: 2 });
  const rows = parseCsv(text);
  const head = rows[0].map((h) => h.trim().toUpperCase());
  const iS = head.indexOf('SYMBOL'), iN = head.indexOf('NAME OF COMPANY'), iSer = head.indexOf('SERIES'), iIsin = head.indexOf('ISIN NUMBER');
  const out = [];
  for (const r of rows.slice(1)) {
    const series = (r[iSer] || '').trim();
    if (series !== 'EQ') continue;                 // tradeable equity series only
    const symbol = (r[iS] || '').trim().toUpperCase();
    if (!symbol || !/^[A-Z0-9&-]+$/.test(symbol)) continue;
    out.push({ symbol, name: (r[iN] || symbol).trim(), exchange: 'NSE', isin: (r[iIsin] || '').trim() });
  }
  return out;
}

// ── NSE F&O underlying list ──────────────────────────────────────────────
async function fetchNseFno() {
  const text = await httpText('https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv', { timeoutMs: 45000, retry: 2 });
  const rows = parseCsv(text).map((r) => r.map((c) => c.trim()));
  const head = rows[0].findIndex((c) => c.toUpperCase() === 'SYMBOL');
  const set = new Set();
  for (const r of rows.slice(1)) {
    let sym = (r[head] || '').toUpperCase();
    if (sym === 'SYMBOL' || !sym) continue;
    sym = sym.replace(/[^A-Z0-9&-]/g, '');
    if (sym.length >= 2 && sym.length <= 20) set.add(sym);
  }
  return set;
}

// ── BSE equity scrips ────────────────────────────────────────────────────
async function fetchBseEquity() {
  const data = await httpJson(
    'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active',
    { timeoutMs: 45000, retry: 2, headers: { Referer: 'https://www.bseindia.com/', Accept: 'application/json' } }
  );
  const out = [];
  for (const s of Array.isArray(data) ? data : []) {
    const code = String(s.SCRIP_CD || '').trim();
    if (!/^\d{6}$/.test(code)) continue;
    out.push({ symbol: code, name: (s.Scrip_Name || code).trim(), exchange: 'BSE' });
  }
  return out;
}

// Major indices (live from Yahoo, free)
const INDICES = [
  { symbol: '^NSEI',       name: 'NIFTY 50',        exchange: 'IDX' },
  { symbol: '^NSEBANK',    name: 'NIFTY BANK',      exchange: 'IDX' },
  { symbol: '^CNXIT',      name: 'NIFTY IT',        exchange: 'IDX' },
  { symbol: '^CNXFIN',     name: 'NIFTY FIN SERVICE', exchange: 'IDX' },
  { symbol: '^CNXMIDCAP',  name: 'NIFTY MIDCAP 100', exchange: 'IDX' },
  { symbol: '^CNXSC',      name: 'NIFTY SMALLCAP 100', exchange: 'IDX' },
  { symbol: '^INDIAVIX',   name: 'INDIA VIX',       exchange: 'IDX' },
  { symbol: '^BSESN',      name: 'BSE SENSEX',      exchange: 'IDX' },
];

// Returns the full universe, cached on disk for 24h.
async function buildUniverse({ force = false } = {}) {
  if (universe) return universe;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const cacheFile = config.universeCache;
    if (!force && fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (Date.now() - cached.updatedAt < 24 * 3600 * 1000) {
          universe = cached;
          return universe;
        }
      } catch { /* rebuild */ }
    }

    const [nseRes, bseRes, fnoRes] = await Promise.allSettled([
      fetchNseEquity(),
      fetchBseEquity(),
      fetchNseFno(),
    ]);

    const nse = nseRes.status === 'fulfilled' ? nseRes.value : [];
    const bse = bseRes.status === 'fulfilled' ? bseRes.value : [];
    const fno = fnoRes.status === 'fulfilled' ? [...fnoRes.value] : [];
    if (!nse.length && !bse.length) throw new Error('Failed to load symbol masters from NSE/BSE');

    // Attach F&O flag to NSE rows
    const fnoSet = new Set(fno);
    for (const r of nse) r.fno = fnoSet.has(r.symbol);

    universe = {
      updatedAt: Date.now(),
      counts: { nse: nse.length, bse: bse.length, fno: fno.length, total: nse.length + bse.length },
      nse, bse, fno, indices: INDICES,
    };
    try { fs.mkdirSync(require('path').dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(universe)); } catch { }
    return universe;
  })();

  return loadingPromise;
}

// Universe presets used by the scanner UI
async function getSymbolList(preset = 'all') {
  const u = await buildUniverse();
  const nse = u.nse.map((r) => ({ ...r, yahoo: `${r.symbol}.NS` }));
  const bse = u.bse.map((r) => ({ ...r, yahoo: `${r.symbol}.BO` }));
  const fno = nse.filter((r) => r.fno);
  switch (preset) {
    case 'nse': return nse;
    case 'fno': return fno;
    case 'bse': return bse;
    case 'all': return [...nse, ...bse];
    case 'nse_bse_fno': return [...fno, ...nse.filter((r) => !r.fno), ...bse];
    case 'indices': return u.indices.map((r) => ({ ...r, yahoo: r.symbol }));
    default: return nse;
  }
}

module.exports = { buildUniverse, getSymbolList, INDICES };
