// Ported from https://github.com/sauravhathi/otp-service (MIT License)
// OTP generation: numeric / alphanumeric / alphabet based codes.
const crypto = require('crypto');

function generateOTP(size = 6, type = 'numeric') {
  if (size < 1 || size > 10) throw new Error('Invalid OTP size');
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  let otpChars = '';
  if (type === 'numeric') otpChars = numbers;
  else if (type === 'alphanumeric') otpChars = numbers + characters;
  else if (type === 'alphabet') otpChars = characters;
  else throw new Error('Invalid OTP type');

  // crypto-strong random (improved over the original Math.random)
  let otp = '';
  for (let i = 0; i < size; i++) {
    otp += otpChars[crypto.randomInt(0, otpChars.length)];
  }
  return otp;
}

module.exports = { generateOTP };
