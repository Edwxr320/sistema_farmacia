'use strict';

const { logger } = require('../config/logger');
const { AppError } = require('../utils/app-error');
const { mapDbError } = require('../utils/db-errors');

function notFound(req, res, next) {
  next(AppError.notFound(`Ruta no encontrada: ${req.method} ${req.path}`));
}

/**
 * Manejador central. Al cliente solo llegan mensajes controlados; el detalle
 * técnico se registra en el servidor con el id de la petición.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let appErr = err instanceof AppError ? err : mapDbError(err);

  // JSON mal formado o cuerpo demasiado grande (body-parser)
  if (!appErr && err && err.type === 'entity.parse.failed') {
    appErr = AppError.badRequest('El cuerpo de la petición no es JSON válido');
  }
  if (!appErr && err && err.type === 'entity.too.large') {
    appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', 'La petición es demasiado grande');
  }

  const status = appErr ? appErr.status : 500;
  const logPayload = {
    requestId: req.id,
    method: req.method,
    path: req.path,
    status,
    errno: err && err.errno,
    code: (err && err.code) || (appErr && appErr.code),
  };

  if (status >= 500) {
    logger.error({ ...logPayload, err }, 'Error en la petición');
  } else {
    logger.debug(logPayload, 'Petición rechazada');
  }

  if (res.headersSent) return;

  const body = appErr
    ? { code: appErr.code, message: appErr.message, ...(appErr.details ? { details: appErr.details } : {}) }
    : { code: 'INTERNAL_ERROR', message: 'Ocurrió un error interno. Intente nuevamente.' };

  res.status(status).json({ error: { ...body, requestId: req.id } });
}

module.exports = { notFound, errorHandler };
