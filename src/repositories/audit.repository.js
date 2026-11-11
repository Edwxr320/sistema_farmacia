'use strict';

/**
 * Registra eventos de auditoría con el procedimiento sp_audit, que toma
 * usuario, sucursal, IP y petición del contexto fijado en ESTA conexión.
 * newValues nunca debe contener contraseñas ni tokens (la base lo rechaza).
 */
async function log(conn, { action, module, table = null, entityId = null, oldValues = null, newValues = null }) {
  await conn.query('CALL sp_audit(?, ?, ?, ?, ?, ?)', [
    action,
    module,
    table,
    entityId === null ? null : String(entityId),
    oldValues === null ? null : JSON.stringify(oldValues),
    newValues === null ? null : JSON.stringify(newValues),
  ]);
}

module.exports = { log };
