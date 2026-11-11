'use strict';

const { AppError } = require('../utils/app-error');
const { SESSION_COOKIE, clearAuthCookies } = require('../utils/cookies');
const tokenService = require('../services/token.service');
const authService = require('../services/auth.service');

// Rutas permitidas mientras el usuario tenga must_change_password = TRUE.
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout']);

/**
 * Resuelve la sesión de la cookie HttpOnly: verifica la firma del JWT, la
 * vigencia en user_sessions y carga desde la base el estado actual del
 * usuario y sus permisos efectivos. No lanza error si no hay sesión.
 */
async function resolveSession(req, res) {
  const token = req.cookies ? req.cookies[SESSION_COOKIE] : undefined;
  if (!token) return null;

  const claims = tokenService.verifySessionToken(token);
  if (!claims) {
    clearAuthCookies(res);
    return null;
  }
  const session = await authService.loadSession(claims, req.dbContext);
  if (!session) {
    clearAuthCookies(res);
    return null;
  }

  req.auth = {
    userId: claims.userId,
    branchId: claims.branchId,
    jti: claims.jti,
    sessionHash: claims.sessionHash,
    exp: claims.exp,
    user: session.user,
    branches: session.branches,
    permissions: new Set(session.permissions),
  };
  // Contexto que usarán las consultas de esta petición (sp_set_app_context).
  req.dbContext = { ...req.dbContext, userId: claims.userId, branchId: claims.branchId, sessionRef: claims.jti };
  return req.auth;
}

/** Exige una sesión válida y, si corresponde, el cambio obligatorio de contraseña. */
async function authenticate(req, res, next) {
  const auth = await resolveSession(req, res);
  if (!auth) return next(AppError.unauthorized());
  if (auth.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(`${req.baseUrl}${req.path}`.replace(/\/$/, ''))) {
    return next(
      AppError.forbidden('Debe cambiar su contraseña antes de continuar', 'PASSWORD_CHANGE_REQUIRED'),
    );
  }
  return next();
}

/** Carga la sesión si existe, sin exigirla. */
async function optionalAuthenticate(req, res, next) {
  await resolveSession(req, res);
  next();
}

module.exports = { authenticate, optionalAuthenticate };
