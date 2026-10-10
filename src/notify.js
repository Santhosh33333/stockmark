// Free alerting channels: in-app feed + optional Telegram bot (free).
const { stmt, now } = require('./db');

async function sendTelegram(settings, text) {
  if (!settings.telegramToken || !settings.telegramChat) return { ok: false, error: 'Telegram not configured' };
  try {
    const url = `https://api.telegram.org/bot${settings.telegramToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.telegramChat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const j = await res.json();
    return { ok: !!j.ok, error: j.ok ? null : j.description };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function recordSignal(userId, row, note) {
  try {
    stmt.addSignal.run(userId ?? null, row.symbol, row.name, row.exchange, row.price, 'BUY', note,
      JSON.stringify({ htfRsi: row.rsi4h, zone: row.activeZones?.[0] || null, volRatio: row.volRatio }), now());
  } catch { }
}

function formatSignalMessage(row) {
  return `🟢 <b>SMC BUY — ${row.symbol}</b>\n` +
    `${row.name || ''} (${row.exchange})\n` +
    `Price: ₹${Number(row.price).toLocaleString('en-IN')}\n` +
    `4H RSI: ${row.rsi4h} (< 50)\n` +
    `Vol vs 20MA: ${row.volRatio ?? '—'}x\n` +
    `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
}

module.exports = { sendTelegram, recordSignal, formatSignalMessage };
