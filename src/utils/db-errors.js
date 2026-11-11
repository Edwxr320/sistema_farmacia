'use strict';

const { AppError } = require('./app-error');

/**
 * Traduce errores de MariaDB (por errno, nunca por texto) a AppError.
 * Devuelve null si el error no es de base de datos conocido.
 * Nunca incluye la sentencia SQL ni el texto interno del servidor, salvo los
 * mensajes de negocio "PP:" que la base diseñó para mostrarse al usuario.
 */
function mapDbError(err) {
  if (!err || typeof err.errno !== 'number') return null;

  switch (err.errno) {
    case 1644: {
      // SIGNAL de los triggers: "PP: mensaje de negocio"
      const msg = String(err.sqlMessage || err.message || '').replace(/^PP:\s*/, '');
      return new AppError(422, 'BUSINESS_RULE', msg || 'Operación rechazada por una regla de negocio');
    }
    case 4025: // CHECK violado (MariaDB)
    case 3819: // CHECK violado (MySQL)
      return new AppError(422, 'CONSTRAINT_VIOLATION', 'Los datos no cumplen las restricciones de la base de datos');
    case 1062:
      return new AppError(409, 'DUPLICATE', 'Ya existe un registro con esos datos');
    case 1452:
      return new AppError(409, 'FK_NOT_FOUND', 'Un registro relacionado no existe');
    case 1451:
      return new AppError(409, 'FK_IN_USE', 'El registro tiene datos dependientes');
    case 1213:
    case 1205:
      return new AppError(503, 'DB_BUSY', 'La base de datos está ocupada; intente nuevamente');
    case 1146: // tabla inexistente: migración pendiente (p. ej. user_sessions)
      return new AppError(503, 'MIGRATION_PENDING', 'Falta aplicar una migración de la base de datos');
    case 1045: // acceso denegado
    case 1044:
    case 1142: // comando denegado
    case 1370: // EXECUTE denegado
      return new AppError(503, 'DB_PERMISSION', 'La aplicación no tiene acceso a la base de datos');
    default:
      if (['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ENOTFOUND'].includes(err.code)) {
        return new AppError(503, 'DB_UNAVAILABLE', 'La base de datos no está disponible');
      }
      return null;
  }
}

/** Errores de red de mysql2 que no traen errno numérico. */
function isConnectionError(err) {
  return Boolean(
    err && ['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ENOTFOUND', 'ECONNRESET'].includes(err.code),
  );
}

module.exports = { mapDbError, isConnectionError };
