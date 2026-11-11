'use strict';

/**
 * Protección CSRF con "signed double-submit cookie" (recomendación OWASP):
 *   token = nonce.firmaHMAC(binding|nonce)
 * - Se entrega en una cookie legible por JS (pp_csrf) y el frontend lo
 *   reenvía en la cabecera X-CSRF-Token.
 * - binding = jti de la sesión (o 'anonymous' antes del login), de modo que un
 *   token robado de otra sesión o inyectado en la cookie no sirve.
 */

const crypto = require('node:crypto');
const { config } = require('../config/env');

const ANONYMOUS = 'anonymous';

function sign(binding, nonce) {
  return crypto.createHmac('sha256', config.auth.csrfSecret).update(`${binding}|${nonce}`).digest('base64url');
}

function generateCsrfToken(binding = ANONYMOUS) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  return `${nonce}.${sign(binding, nonce)}`;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyCsrfToken(token, binding = ANONYMOUS) {
  if (typeof token !== 'string' || token.length > 200) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  return safeEqual(parts[1], sign(binding, parts[0]));
}

module.exports = { generateCsrfToken, verifyCsrfToken, safeEqual, ANONYMOUS };
