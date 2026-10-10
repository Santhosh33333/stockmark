// Technical indicators (Wilder-smoothed, matches Pine ta.* implementations)
function sma(values, len) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

function ema(values, len) {
  const out = new Array(values.length).fill(null);
  if (values.length < len) return out;
  const k = 2 / (len + 1);
  let seed = 0;
  for (let i = 0; i < len; i++) seed += values[i];
  let prev = seed / len;
  out[len - 1] = prev;
  for (let i = len; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, len = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= len) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / len, avgL = loss / len;
  out[len] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = len + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (len - 1) + Math.max(d, 0)) / len;
    avgL = (avgL * (len - 1) + Math.max(-d, 0)) / len;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function trueRange(candles) {
  const tr = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { tr[i] = candles[i].h - candles[i].l; continue; }
    tr[i] = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
  }
  return tr;
}

function atr(candles, len = 14) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  if (candles.length < len) return out;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += tr[i];
  let prev = sum / len;
  out[len - 1] = prev;
  for (let i = len; i < candles.length; i++) {
    prev = (prev * (len - 1) + tr[i]) / len;
    out[i] = prev;
  }
  return out;
}

function macdHistogram(values, fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast), es = ema(values, slow);
  const macdLine = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const definedIdx = macdLine.findIndex((v) => v != null);
  const valid = macdLine.slice(definedIdx);
  const sig = ema(valid, signal);
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < sig.length; i++) {
    if (sig[i] != null && valid[i] != null) out[definedIdx + i] = valid[i] - sig[i];
  }
  return out;
}

// Aggregate 1H candles into 4H candles (IST session aligned: 09:15 start block)
function resample4h(hourly) {
  if (!hourly || hourly.length < 4) return [];
  const out = [];
  let bucketKey = null, cur = null;
  const istDate = (t) => {
    const d = new Date(t + 5.5 * 3600000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  };
  const istHour = (t) => new Date(t + 5.5 * 3600000).getUTCHours();
  for (const c of hourly) {
    const day = istDate(c.t);
    const hr = istHour(c.t);
    const block = hr < 9 ? 0 : hr < 13 ? 1 : hr < 17 ? 2 : 3;   // 09-13, 13-17, 17-21...
    const key = `${day}|${block}`;
    if (key !== bucketKey) {
      if (cur) out.push(cur);
      bucketKey = key;
      cur = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { sma, ema, rsi, atr, macdHistogram, resample4h };
