// Central configuration. Everything defaults to FREE public endpoints.
const path = require('path');

const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',

  // Local folders (created at runtime)
  dataDir: path.join(__dirname, 'data'),
  dbFile: path.join(__dirname, 'data', 'app.db'),
  universeCache: path.join(__dirname, 'data', 'universe.json'),

  // Free public data providers (no API key required)
  yahooBase: 'https://query1.finance.yahoo.com',
  yahooBase2: 'https://query2.finance.yahoo.com',
  nseEquityCsv: 'https://archives.nseindia.com/content/equities/EQUITY_L.csv',
  nseFnoCsv: 'https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv',
  nseNiftyCsv: 'https://archives.nseindia.com/content/indices/ind_nifty500list.csv',
  bseListApi: 'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active',

  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  // Scanner behaviour
  scan: {
    concurrency: Number(process.env.SCAN_CONCURRENCY || 12), // parallel requests to Yahoo
    dailyRange: process.env.SCAN_DAILY_RANGE || '8mo',
    hourlyRange: process.env.SCAN_HOURLY_RANGE || '45d',
    retry: 2,
    retryDelayMs: 700,
    staleAfterMs: 6 * 60 * 60 * 1000,   // rescan symbol if older than 6h
    maxAutoScanMs: 25 * 60 * 1000,      // hard cap for a background scan
  },

  // Indian market hours (IST) used for market-status badge + live refresh
  market: {
    timezone: 'Asia/Kolkata',
    open: '09:15',
    close: '15:30',
    preOpen: '09:00',
  },

  // Email OTP — FREE senders only:
  //  • Brevo HTTP API  → free 300 emails/day  (BREVO_API_KEY)
  //  • Gmail SMTP      → free with an App Password (SMTP_HOST/USER/PASS)
  //  • dev             → nothing configured, OTP printed to server log & UI
  mail: {
    provider: process.env.MAIL_PROVIDER || (process.env.BREVO_API_KEY ? 'brevo' : process.env.SMTP_HOST ? 'smtp' : 'dev'),
    from: process.env.MAIL_FROM || 'no-reply@stockartha.app',
    fromName: process.env.MAIL_FROM_NAME || 'StockArtha',
    brevoKey: process.env.BREVO_API_KEY || '',
    brevoUrl: 'https://api.brevo.com/v3/smtp/email',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },

  otp: {
    length: 6,
    ttlMinutes: Number(process.env.OTP_TTL_MINUTES || 10),
    maxAttempts: 5,
    resendCooldownSec: 45,
  },

  // Dhan (optional, live execution). Free API keys from https://dhanhq.co -> DhanHQ APIs
  dhan: {
    baseUrl: process.env.DHAN_BASE_URL || 'https://api.dhan.co',
  },
};

module.exports = config;
