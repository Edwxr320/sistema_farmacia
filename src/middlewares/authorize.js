'use strict';

const { AppError } = require('../utils/app-error');

/**
 * Exige TODOS los permisos indicados. Los permisos provienen de
 * vw_user_effective_permissions, leídos en esta misma petición.
 * Debe usarse después de authenticate.
 */
function requirePermission(...codes) {
  return (req, res, next) => {
    if (!req.auth) return next(AppError.unauthorized());
    const missing = codes.filter((c) => !req.auth.permissions.has(c));
    if (missing.length > 0) {
      return next(AppError.forbidden('No tiene permiso para realizar esta acción', 'PERMISSION_DENIED'));
    }
    return next();
  };
}

/** Exige AL MENOS UNO de los permisos indicados. */
function requireAnyPermission(...codes) {
  return (req, res, next) => {
    if (!req.auth) return next(AppError.unauthorized());
    if (!codes.some((c) => req.auth.permissions.has(c))) {
      return next(AppError.forbidden('No tiene permiso para realizar esta acción', 'PERMISSION_DENIED'));
    }
    return next();
  };
}

module.exports = { requirePermission, requireAnyPermission };
