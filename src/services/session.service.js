'use strict';

const { withConnection } = require('../config/database');
const { logger } = require('../config/logger');
const sessionRepository = require('../repositories/session.repository');

/** Elimina todas las sesiones expiradas, en lotes. Devuelve la cantidad eliminada. */
async function cleanupExpiredSessions() {
  return withConnection({ requestId: 'session-cleanup' }, async (conn) => {
    let total = 0;
    for (;;) {
      const deleted = await sessionRepository.deleteExpired(conn, 1000);
      total += deleted;
      if (deleted < 1000) break;
    }
    return total;
  });
}

/** Ejecuta la limpieza al iniciar y luego periódicamente (sin impedir el cierre del proceso). */
function scheduleSessionCleanup(intervalMinutes = 60) {
  const run = async () => {
    try {
      const n = await cleanupExpiredSessions();
      if (n > 0) logger.info({ deleted: n }, 'Sesiones expiradas eliminadas');
    } catch (err) {
      logger.warn({ errno: err.errno, code: err.code }, 'No se pudo limpiar sesiones expiradas');
    }
  };
  run();
  const timer = setInterval(run, intervalMinutes * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { cleanupExpiredSessions, scheduleSessionCleanup };
