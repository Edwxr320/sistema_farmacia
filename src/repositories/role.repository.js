'use strict';

async function findActiveByCode(conn, code) {
  const [rows] = await conn.execute(
    'SELECT id, code, name FROM roles WHERE code = ? AND is_active = TRUE',
    [code],
  );
  return rows[0] || null;
}

/** Roles con la cantidad de usuarios y la lista de permisos asignados. */
async function listWithPermissions(conn) {
  const [roles] = await conn.query(
    `SELECT r.id, r.code, r.name, r.description, r.is_system, r.is_active,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS users_count
       FROM roles r
      ORDER BY r.id`,
  );
  const [perms] = await conn.query(
    `SELECT rp.role_id, p.code, p.module
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      ORDER BY p.module, p.code`,
  );
  return roles.map((r) => ({
    ...r,
    users_count: Number(r.users_count),
    permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.code),
  }));
}

async function listPermissions(conn) {
  const [rows] = await conn.query(
    'SELECT id, code, module, name, description, is_active FROM permissions ORDER BY module, code',
  );
  return rows;
}

module.exports = { findActiveByCode, listWithPermissions, listPermissions };
