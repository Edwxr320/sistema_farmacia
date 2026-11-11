'use strict';

/** Consultas de diagnóstico (solo lectura). */

async function getServerInfo(conn) {
  const [rows] = await conn.query(
    'SELECT VERSION() AS version, DATABASE() AS current_database, @@session.time_zone AS time_zone, ' +
      '@@collation_connection AS collation_connection, @@session.sql_mode AS sql_mode',
  );
  return rows[0];
}

async function getSchemaObjects(conn, schemaName) {
  const [tables] = await conn.execute(
    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [schemaName],
  );
  const [routines] = await conn.execute(
    "SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'",
    [schemaName],
  );
  return {
    tables: tables.filter((r) => r.type === 'BASE TABLE').map((r) => r.name),
    views: tables.filter((r) => r.type === 'VIEW').map((r) => r.name),
    procedures: routines.map((r) => r.name),
  };
}

/** Comprueba que una vista crítica se pueda leer realmente. */
async function probeView(conn) {
  await conn.query('SELECT 1 FROM vw_user_effective_permissions LIMIT 1');
}

module.exports = { getServerInfo, getSchemaObjects, probeView };
