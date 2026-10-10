// Ported from https://github.com/sauravhathi/otp-service (MIT License)
// Email format validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

module.exports = { isValidEmail };
