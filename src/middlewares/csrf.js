'use strict';

const { config } = require('../config/env');
const { AppError } = require('../utils/app-error');
const { SESSION_COOKIE, CSRF_COOKIE } = require('../utils/cookies');
const tokenService = require('../services/token.service');
const { verifyCsrfToken, safeEqual, ANONYMOUS } = require('../services/csrf.service');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** jti de la sesión actual (si la cookie es válida) o 'anonymous'. */
function csrfBinding(req) {
  const token = req.cookies ? req.cookies[SESSION_COOKIE] : undefined;
  const claims = token ? tokenService.verifySessionToken(token) : null;
  return claims ? claims.jti : ANONYMOUS;
}

function originAllowed(req) {
  const origin = req.get('origin');
  if (!origin) return true; // clientes no navegador o mismo origen sin cabecera
  const self = `${req.protocol}://${req.get('host')}`;
  return origin === self || config.allowedOrigins.includes(origin);
}

/**
 * Para métodos que modifican datos exige:
 *  1. Origin permitido (si el navegador lo envía).
 *  2. Cabecera X-CSRF-Token igual a la cookie pp_csrf.
 *  3. Token firmado para la sesión actual.
 */
function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  if (!originAllowed(req)) {
    return next(AppError.forbidden('Origen no permitido', 'CSRF_ORIGIN'));
  }
  const header = req.get('x-csrf-token');
  const cookie = req.cookies ? req.cookies[CSRF_COOKIE] : undefined;
  if (!header || !cookie || !safeEqual(header, cookie) || !verifyCsrfToken(header, csrfBinding(req))) {
    return next(AppError.forbidden('Token CSRF ausente o inválido', 'CSRF_INVALID'));
  }
  return next();
}

module.exports = { csrfProtection, csrfBinding };
