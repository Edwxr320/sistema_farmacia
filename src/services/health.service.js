'use strict';

const { withConnection } = require('../config/database');
const { config } = require('../config/env');
const { logger } = require('../config/logger');
const healthRepository = require('../repositories/health.repository');
const {
  EXPECTED_TABLES,
  EXPECTED_VIEWS,
  EXPECTED_PROCEDURES,
  EXPECTED_MIGRATIONS,
} = require('../utils/schema-catalog');

function missing(expected, found) {
  const set = new Set(found.map((n) => n.toLowerCase()));
  return expected.filter((n) => !set.has(n.toLowerCase()));
}

/**
 * Estado de la aplicación y de MariaDB. No expone host, usuario ni contraseñas.
 * @returns {Promise<{httpStatus:number, body:object}>}
 */
async function checkHealth() {
  const started = Date.now();
  const body = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    app: { name: 'Pharma Plus API', environment: config.nodeEnv, uptimeSeconds: Math.round(process.uptime()) },
    database: { status: 'unknown' },
  };

  try {
    await withConnection({ requestId: 'health-check' }, async (conn) => {
      const info = await healthRepository.getServerInfo(conn);
      const objects = await healthRepository.getSchemaObjects(conn, config.db.database);
      await healthRepository.probeView(conn);

      const missingTables = missing(EXPECTED_TABLES, objects.tables);
      const missingViews = missing(EXPECTED_VIEWS, objects.views);
      const missingProcedures = missing(EXPECTED_PROCEDURES, objects.procedures);
      const tableSet = new Set(objects.tables.map((n) => n.toLowerCase()));
      const pendingMigrations = EXPECTED_MIGRATIONS.filter((m) => !tableSet.has(m.table));
      const isMariaDb = /mariadb/i.test(info.version);
      const schemaOk =
        info.current_database === config.db.database &&
        missingTables.length === 0 &&
        missingViews.length === 0 &&
        missingProcedures.length === 0 &&
        pendingMigrations.length === 0;

      body.database = {
        status: schemaOk ? 'ok' : 'degraded',
        engine: isMariaDb ? 'MariaDB' : 'MySQL',
        version: info.version,
        name: info.current_database,
        timeZone: info.time_zone,
        collation: info.collation_connection,
        strictMode: /STRICT_TRANS_TABLES/.test(info.sql_mode),
        schema: {
          tables: { expected: EXPECTED_TABLES.length, found: objects.tables.length, missing: missingTables },
          views: { expected: EXPECTED_VIEWS.length, found: objects.views.length, missing: missingViews },
          procedures: {
            expected: EXPECTED_PROCEDURES.length,
            found: objects.procedures.length,
            missing: missingProcedures,
          },
        },
        migrations: {
          applied: EXPECTED_MIGRATIONS.filter((m) => tableSet.has(m.table)).map((m) => m.id),
          pending: pendingMigrations.map((m) => ({ id: m.id, file: m.file })),
        },
        latencyMs: Date.now() - started,
      };
      if (!schemaOk) body.status = 'degraded';
    });
  } catch (err) {
    logger.error({ errno: err.errno, code: err.code }, 'Health check: MariaDB no responde');
    body.status = 'error';
    body.database = {
      status: 'unreachable',
      // Solo el código de error, nunca el mensaje completo (puede contener usuario/host).
      errorCode: err.code || 'UNKNOWN',
    };
  }

  const httpStatus = body.status === 'ok' ? 200 : 503;
  return { httpStatus, body };
}

module.exports = { checkHealth };
