'use strict';

const { config } = require('../config/env');

const SESSION_COOKIE = 'pp_session';
const CSRF_COOKIE = 'pp_csrf';

function baseOptions() {
  return {
    secure: config.isProduction, // en producción solo por HTTPS
    sameSite: 'strict',
    path: '/',
  };
}

function setSessionCookie(res, token, maxAgeMs) {
  res.cookie(SESSION_COOKIE, token, { ...baseOptions(), httpOnly: true, maxAge: maxAgeMs });
}

/** El token CSRF debe ser legible por el JavaScript del frontend (no HttpOnly). */
function setCsrfCookie(res, token, maxAgeMs) {
  res.cookie(CSRF_COOKIE, token, { ...baseOptions(), httpOnly: false, ...(maxAgeMs ? { maxAge: maxAgeMs } : {}) });
}

function clearAuthCookies(res) {
  res.clearCookie(SESSION_COOKIE, { ...baseOptions(), httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...baseOptions(), httpOnly: false });
}

module.exports = { SESSION_COOKIE, CSRF_COOKIE, setSessionCookie, setCsrfCookie, clearAuthCookies };
