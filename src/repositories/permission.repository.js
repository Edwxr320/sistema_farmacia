'use strict';

/**
 * Permisos efectivos desde la vista vw_user_effective_permissions
 * (rol + concedidos al usuario - denegados al usuario). Nunca se calculan en JS.
 */
async function findEffectiveByUserId(conn, userId) {
  const [rows] = await conn.execute(
    `SELECT DISTINCT permission_code, module, source
       FROM vw_user_effective_permissions
      WHERE user_id = ?
      ORDER BY module, permission_code`,
    [userId],
  );
  return rows;
}

async function userHasPermission(conn, userId, permissionCode) {
  const [rows] = await conn.execute(
    'SELECT 1 FROM vw_user_effective_permissions WHERE user_id = ? AND permission_code = ? LIMIT 1',
    [userId, permissionCode],
  );
  return rows.length > 0;
}

module.exports = { findEffectiveByUserId, userHasPermission };
