// Email delivery for OTP — integrates the free OTP service pattern from
// https://github.com/sauravhathi/otp-service (MIT License):
//   • Gmail SMTP via nodemailer (service: gmail, secure, pool) — free with an App Password
//   • Brevo HTTP API — free 300 emails/day
//   • dev mode — nothing configured; OTP printed to server log & shown in UI
// Runtime config can be saved by the owner from Settings → Email OTP (data/mail.json, never committed).
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { generateOTP } = require('./otp/generateOTP');

const RUNTIME_FILE = path.join(config.dataDir, 'mail.json');
let runtime = {};

function loadRuntime() {
  try {
    if (fs.existsSync(RUNTIME_FILE)) runtime = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  } catch { runtime = {}; }
  return runtime;
}
loadRuntime();

function cfg() {
  return {
    provider: runtime.provider || config.mail.provider,
    from: runtime.from || config.mail.from,
    fromName: runtime.fromName || config.mail.fromName,
    brevoKey: runtime.brevoKey || config.mail.brevoKey,
    otpType: runtime.otpType || 'numeric',
    smtp: { ...config.mail.smtp, ...(runtime.smtp || {}) },
  };
}

function status() {
  const c = cfg();
  const provider = c.provider;
  const ready =
    (provider === 'brevo' && !!c.brevoKey) ||
    (provider === 'smtp' && !!c.smtp.host && !!c.smtp.user) ||
    (provider === 'gmail' && !!c.smtp.user && !!c.smtp.pass);
  return { provider, ready, from: c.from, fromName: c.fromName, otpType: c.otpType, mode: ready ? provider : 'dev' };
}

// Gmail transport exactly like sauravhathi/otp-service (service gmail, secure, pool)
function gmailTransport() {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    service: 'gmail',
    secure: true,
    auth: { user: cfg().smtp.user, pass: cfg().smtp.pass },
    pool: true,
  });
}

async function send({ to, subject, html, text }) {
  const c = cfg();
  const provider = c.provider;
  try {
    if (provider === 'brevo' && c.brevoKey) {
      const res = await fetch(config.mail.brevoUrl, {
        method: 'POST',
        headers: { 'api-key': c.brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: c.fromName, email: c.from },
          to: [{ email: to }],
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || ('Brevo HTTP ' + res.status));
      return { ok: true, provider: 'brevo', id: body.messageId };
    }
    if ((provider === 'smtp' || provider === 'gmail') && c.smtp.user && c.smtp.pass) {
      const nodemailer = require('nodemailer');
      const transport = provider === 'gmail'
        ? gmailTransport()
        : nodemailer.createTransport({
            host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure,
            auth: { user: c.smtp.user, pass: c.smtp.pass }, pool: true,
          });
      await transport.sendMail({ from: `"${c.fromName}" <${c.from}>`, to, subject, html, text });
      return { ok: true, provider };
    }
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { ok: false, provider, error: err.message };
  }
  console.log(`[mailer] DEV MODE — no email service. Would send "${subject}" to ${to}`);
  return { ok: false, provider: 'dev', error: 'No email service configured' };
}

// ── Email templates (3D-styled, mobile friendly) ───────────────────────
function otpEmail(code, minutes, purpose = 'signup') {
  const title = purpose === 'login' ? 'Sign-in code' : 'Verify your email';
  const subject = `${code} is your StockArtha ${title.toLowerCase()}`;
  const html = `
  <div style="margin:0;padding:0;background:#040b1a;font-family:Segoe UI,Arial,sans-serif">
    <div style="max-width:420px;margin:0 auto;padding:26px 18px">
      <div style="text-align:center;margin-bottom:18px">
        <div style="display:inline-block;background:linear-gradient(120deg,#0ea5e9,#7c3aed);color:#fff;font-weight:800;
             font-size:19px;padding:10px 20px;border-radius:14px;box-shadow:0 14px 30px -12px #0ea5e9">StockArtha</div>
      </div>
      <div style="background:linear-gradient(165deg,rgba(18,36,68,.95),rgba(8,17,35,.96));border:1px solid rgba(56,189,248,.22);
           border-radius:20px;padding:28px 22px;text-align:center;box-shadow:0 30px 60px -30px #000">
        <h1 style="color:#e6eefc;font-size:20px;margin:0 0 8px">${title}</h1>
        <p style="color:#93a4c4;font-size:13.5px;margin:0 0 20px;line-height:1.6">
          ${purpose === 'login' ? 'Use this one-time code to finish signing in.' : 'Enter this one-time code to activate your StockArtha account.'}
        </p>
        <div style="font-size:38px;font-weight:800;letter-spacing:10px;color:#7dd3fc;
             background:rgba(56,189,248,.10);border:1px dashed rgba(125,211,252,.5);border-radius:16px;padding:16px 8px;margin-bottom:18px">
          ${code}
        </div>
        <p style="color:#6c81a8;font-size:12px;margin:0">Valid for ${minutes} minutes · never share this code</p>
      </div>
      <p style="color:#4b5f80;font-size:11px;text-align:center;margin:16px 4px 0;line-height:1.6">
        StockArtha — live NSE &amp; BSE smart-money scanner.<br/>This is an automated message, replies are not monitored.
      </p>
    </div>
  </div>`;
  const text = `${title}\n\nYour StockArtha code: ${code}\nValid for ${minutes} minutes.\n\nIf you did not request this, ignore this email.`;
  return { subject, html, text };
}

function saveRuntimeConfig(patch) {
  runtime = { ...runtime, ...patch };
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2)); } catch { }
  loadRuntime();
  return status();
}

module.exports = { send, status, otpEmail, saveRuntimeConfig, loadRuntime, generateOTP };
