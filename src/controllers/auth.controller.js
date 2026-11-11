'use strict';

const authService = require('../services/auth.service');
const { generateCsrfToken, ANONYMOUS } = require('../services/csrf.service');
const { csrfBinding } = require('../middlewares/csrf');
const { setSessionCookie, setCsrfCookie, clearAuthCookies } = require('../utils/cookies');

/** Entrega un token CSRF válido para el estado actual (anónimo o sesión). */
function getCsrfToken(req, res) {
  const token = generateCsrfToken(csrfBinding(req));
  setCsrfCookie(res, token);
  res.set('Cache-Control', 'no-store');
  res.json({ csrfToken: token });
}

/** Tipo de cuenta según el rol guardado en la base (CUSTOMER → cliente; cualquier otro → personal). */
function accountTypeOf(user) {
  return user.role && user.role.code === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF';
}

async function login(req, res) {
  const result = await authService.login(req.validated.body, req.dbContext, { portal: req.loginPortal || 'staff' });
  sendSession(res, result);
}

function sendSession(res, result) {
  const { session } = result;

  setSessionCookie(res, session.token, session.maxAgeMs);
  // Nuevo token CSRF ligado a la nueva sesión (rotación al autenticarse).
  const csrfToken = generateCsrfToken(session.jti);
  setCsrfCookie(res, csrfToken, session.maxAgeMs);

  res.set('Cache-Control', 'no-store');
  res.json({
    user: result.user,
    branches: result.branches,
    activeBranchId: result.activeBranchId,
    permissions: result.permissions,
    accountType: accountTypeOf(result.user),
    csrfToken,
    expiresAt: new Date(Date.now() + session.maxAgeMs).toISOString(),
  });
}

/**
 * Acceso único (/acceso) para personal y clientes. Usa el mismo servicio de login (contraseñas, bloqueo por
 * intentos, auditoría, sesiones y CSRF) sin restricción de portal. Si el navegador ya tenía una sesión, se
 * revoca al validar las nuevas credenciales: nunca quedan abiertas a la vez una sesión de personal y una de cliente.
 */
async function access(req, res) {
  const result = await authService.login(req.validated.body, req.dbContext, { portal: 'any' });
  // Solo con credenciales válidas se cierra la sesión anterior (si unas credenciales fallan, no se pierde).
  if (req.auth) await authService.logout(req.auth, req.dbContext);
  sendSession(res, result);
}

async function logout(req, res) {
  if (req.auth) await authService.logout(req.auth, req.dbContext);
  clearAuthCookies(res);
  // Token anónimo para que el frontend pueda volver a iniciar sesión.
  const csrfToken = generateCsrfToken(ANONYMOUS);
  setCsrfCookie(res, csrfToken);
  res.json({ message: 'Sesión cerrada', csrfToken });
}

/**
 * Cambia la contraseña. Todas las sesiones del usuario se revocan y este
 * cliente recibe una sesión nueva (cookie + token CSRF rotados).
 */
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.validated.body;
  const { session, revokedSessions } = await authService.changePassword(
    req.auth,
    { currentPassword, newPassword },
    req.dbContext,
  );
  setSessionCookie(res, session.token, session.maxAgeMs);
  const csrfToken = generateCsrfToken(session.jti);
  setCsrfCookie(res, csrfToken, session.maxAgeMs);
  res.set('Cache-Control', 'no-store');
  res.json({
    message: 'Contraseña actualizada. Las demás sesiones fueron cerradas.',
    revokedSessions,
    csrfToken,
    expiresAt: new Date(Date.now() + session.maxAgeMs).toISOString(),
  });
}

function me(req, res) {
  const { user, branches, branchId, permissions, exp } = req.auth;
  res.set('Cache-Control', 'no-store');
  res.json({
    user,
    branches,
    activeBranchId: branchId,
    permissions: [...permissions].sort(),
    expiresAt: new Date(exp * 1000).toISOString(),
  });
}

module.exports = { getCsrfToken, login, access, logout, changePassword, me };
