'use strict';

/** Error controlado de la aplicación: su mensaje se puede mostrar al cliente. */
class AppError extends Error {
  /**
   * @param {number} status código HTTP
   * @param {string} code código estable para el frontend (p. ej. AUTH_INVALID_CREDENTIALS)
   * @param {string} message mensaje para el usuario
   * @param {object} [details] datos adicionales NO sensibles
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  static badRequest(message, details) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Debe iniciar sesión', code = 'AUTH_REQUIRED') {
    return new AppError(401, code, message);
  }

  static forbidden(message = 'No tiene permiso para realizar esta acción', code = 'FORBIDDEN') {
    return new AppError(403, code, message);
  }

  static notFound(message = 'Recurso no encontrado') {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message, code = 'CONFLICT') {
    return new AppError(409, code, message);
  }
}

module.exports = { AppError };
