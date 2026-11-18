'use strict';

const { config, validateConfig } = require('./config/env');
const { logger } = require('./config/logger');
const { getPool, closePool } = require('./config/database');
const { createApp } = require('./app');
const { scheduleSessionCleanup } = require('./services/session.service');
const { scheduleDailyExpiryAlerts } = require('./services/alert.service');
const { initRealtime, closeRealtime } = require('./services/realtime.service');

const problems = validateConfig();
if (problems.length > 0) {
  for (const p of problems) logger.fatal(p);
  logger.fatal('Configuración incompleta: revise el archivo .env (ver .env.example)');
  process.exit(1);
}

// Avisos de despliegue (no bloquean el arranque).
if (config.payments.provider === 'demo') {
  logger.warn('PAYMENT_PROVIDER=demo: los pagos electrónicos son SIMULADOS (sin cobro real)');
}
if (config.isProduction && config.uploads.dir.startsWith(require('node:path').resolve(__dirname, '..'))) {
  logger.warn({ dir: config.uploads.dir }, 'UPLOADS_DIR está dentro del proyecto: use un volumen persistente para no perder imágenes al desplegar');
}

async function verifyDatabase() {
  const conn = await getPool().getConnection();
  try {
    const [[row]] = await conn.query('SELECT VERSION() AS version, DATABASE() AS db');
    logger.info({ version: row.version, database: row.db }, 'Conectado a MariaDB');
  } finally {
    conn.release();
  }
}

async function main() {
  try {
    await verifyDatabase();
  } catch (err) {
    // El servidor arranca igualmente: /api/health informará el estado real.
    logger.error({ errno: err.errno, code: err.code }, 'No se pudo conectar a MariaDB al iniciar');
  }

  // Limpieza de sesiones expiradas al iniciar y cada hora.
  scheduleSessionCleanup(60);
  // Alertas de vencimiento: CALL sp_refresh_expiry_alerts() a diario a las 06:00 (America/Lima).
  if (config.jobs.enabled) scheduleDailyExpiryAlerts();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`Pharma Plus API escuchando en http://localhost:${config.port}`);
  });
  // Notificaciones en tiempo real (mismo puerto, autenticadas con la cookie de sesión).
  initRealtime(server);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Cerrando servidor...');
    const force = setTimeout(() => {
      logger.error('Cierre forzado por tiempo de espera');
      process.exit(1);
    }, 10000);
    force.unref();
    await closeRealtime().catch(() => {});
    server.close(async () => {
      try {
        await closePool();
        logger.info('Pool de MariaDB cerrado. Hasta luego.');
        process.exit(0);
      } catch (err) {
        logger.error({ code: err.code }, 'Error al cerrar el pool');
        process.exit(1);
      }
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Promesa rechazada sin manejar');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Excepción no controlada');
    shutdown('uncaughtException');
  });
}

main();
