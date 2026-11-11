'use strict';

/** Administración: clientes (vista interna), trabajadores, roles/permisos, sucursales, cajas y configuración. */

const { WhereBuilder, pageParams, likeContains } = require('../utils/query');

// ------------------------------------------------------------------ clientes
async function listCustomers(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.q, '(c.full_name LIKE ? OR c.document_number LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)',
      likeContains(f.q), likeContains(f.q), likeContains(f.q), likeContains(f.q))
    .addIf(f.isActive !== undefined, 'c.is_active = ?', f.isActive ? 1 : 0)
    .addIf(f.hasAccount === true, 'c.user_id IS NOT NULL')
    .addIf(f.hasAccount === false, 'c.user_id IS NULL');
  const [rows] = await conn.execute(
    `SELECT c.*, (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'COMPLETED') AS purchases,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders
       FROM customers c ${w.toSql()} ORDER BY c.full_name, c.id LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM customers c ${w.toSql()}`, w.params);
  return { rows, total };
}

async function findCustomer(conn, id) {
  const [rows] = await conn.execute('SELECT * FROM customers WHERE id = ?', [id]);
  return rows[0] || null;
}

const CUSTOMER_COLS = ['full_name', 'document_type', 'document_number', 'phone', 'email', 'birth_date', 'is_active'];

async function insertCustomer(conn, data, createdBy) {
  const cols = CUSTOMER_COLS.filter((c) => data[c] !== undefined);
  const [res] = await conn.execute(
    `INSERT INTO customers (${cols.join(', ')}, created_by) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
    [...cols.map((c) => data[c]), createdBy],
  );
  return res.insertId;
}

async function updateCustomer(conn, id, data) {
  const cols = CUSTOMER_COLS.filter((c) => data[c] !== undefined);
  if (cols.length === 0) return 0;
  const [res] = await conn.execute(`UPDATE customers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => data[c]), id]);
  return res.affectedRows;
}

// --------------------------------------------------------------- trabajadores
async function listUsers(conn, f) {
  const w = new WhereBuilder()
    .add("r.code <> 'CUSTOMER'")
    .addIf(f.userId, 'u.id = ?', f.userId)
    .addIf(f.q, '(u.full_name LIKE ? OR u.email LIKE ?)', likeContains(f.q), likeContains(f.q))
    .addIf(f.status, 'u.status = ?', f.status)
    .addIf(f.roleId, 'u.role_id = ?', f.roleId)
    .addIf(f.branchId, 'EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = ?)', f.branchId);
  const [rows] = await conn.execute(
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.must_change_password, u.last_login_at, u.locked_until, u.created_at,
            r.id AS role_id, r.code AS role_code, r.name AS role_name,
            (SELECT GROUP_CONCAT(CONCAT(b.id, ':', b.code, ':', ub.is_default) ORDER BY ub.is_default DESC, b.id SEPARATOR ',')
               FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = u.id) AS branches
       FROM users u JOIN roles r ON r.id = u.role_id ${w.toSql()} ORDER BY u.full_name LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id = u.role_id ${w.toSql()}`, w.params);
  return { rows, total };
}

async function findUser(conn, id, { forUpdate = false } = {}) {
  const [rows] = await conn.execute(
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.role_id, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] || null;
}

async function countActiveAdmins(conn, excludeId) {
  const [[r]] = await conn.execute(
    "SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'ADMIN' AND u.status = 'ACTIVE' AND u.id <> ?",
    [excludeId],
  );
  return Number(r.c);
}

async function updateUser(conn, id, data) {
  const cols = ['full_name', 'phone', 'role_id', 'status'].filter((c) => data[c] !== undefined);
  if (cols.length === 0) return 0;
  const [res] = await conn.execute(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => data[c]), id]);
  return res.affectedRows;
}

async function setPassword(conn, id, hash) {
  await conn.execute('UPDATE users SET password_hash = ?, must_change_password = TRUE, password_changed_at = NOW(), failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [hash, id]);
}

async function unlock(conn, id) {
  await conn.execute('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [id]);
}

async function replaceUserBranches(conn, userId, branchIds, defaultBranchId, assignedBy) {
  await conn.execute('DELETE FROM user_branches WHERE user_id = ?', [userId]);
  for (const b of branchIds) {
    await conn.execute('INSERT INTO user_branches (user_id, branch_id, is_default, assigned_by) VALUES (?, ?, ?, ?)', [userId, b, b === defaultBranchId ? 1 : 0, assignedBy]);
  }
}

async function userPermissionOverrides(conn, userId) {
  const [rows] = await conn.execute(
    `SELECT p.code, p.module, up.effect, up.reason, up.created_at FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
      WHERE up.user_id = ? ORDER BY p.module, p.code`,
    [userId],
  );
  return rows;
}

async function permissionIdsByCode(conn, codes) {
  if (codes.length === 0) return new Map();
  const [rows] = await conn.execute(`SELECT id, code FROM permissions WHERE is_active = TRUE AND code IN (${codes.map(() => '?').join(', ')})`, codes);
  return new Map(rows.map((r) => [r.code, r.id]));
}

async function replaceUserOverrides(conn, userId, overrides, grantedBy) {
  await conn.execute('DELETE FROM user_permissions WHERE user_id = ?', [userId]);
  for (const o of overrides) {
    await conn.execute('INSERT INTO user_permissions (user_id, permission_id, effect, reason, granted_by) VALUES (?, ?, ?, ?, ?)', [userId, o.permissionId, o.effect, o.reason ?? null, grantedBy]);
  }
}

// ---------------------------------------------------------------------- roles
async function findRole(conn, id) {
  const [rows] = await conn.execute('SELECT id, code, name, is_system, is_active FROM roles WHERE id = ?', [id]);
  return rows[0] || null;
}

async function insertRole(conn, { code, name, description }) {
  const [res] = await conn.execute('INSERT INTO roles (code, name, description, is_system) VALUES (?, ?, ?, FALSE)', [code, name, description ?? null]);
  return res.insertId;
}

/** Sincroniza los permisos del rol (los triggers auditan cada GRANT/REVOKE). */
async function syncRolePermissions(conn, roleId, permissionIds) {
  const [current] = await conn.execute('SELECT permission_id FROM role_permissions WHERE role_id = ?', [roleId]);
  const have = new Set(current.map((r) => r.permission_id));
  const want = new Set(permissionIds);
  for (const id of have) if (!want.has(id)) await conn.execute('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?', [roleId, id]);
  for (const id of want) if (!have.has(id)) await conn.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, id]);
  return { added: [...want].filter((x) => !have.has(x)).length, removed: [...have].filter((x) => !want.has(x)).length };
}

// ------------------------------------------------------------------- sucursales
async function listBranches(conn, branchIds) {
  const filter = branchIds ? `WHERE b.id IN (${branchIds.map(() => '?').join(', ') || 'NULL'})` : '';
  const [rows] = await conn.execute(
    `SELECT b.*, (SELECT COUNT(*) FROM user_branches ub WHERE ub.branch_id = b.id) AS users,
            (SELECT COUNT(*) FROM cash_registers cr WHERE cr.branch_id = b.id) AS registers
       FROM branches b ${filter} ORDER BY b.is_main DESC, b.name`,
    branchIds || [],
  );
  return rows;
}

const BRANCH_COLS = ['code', 'name', 'address_line', 'district', 'province', 'department', 'phone', 'email', 'status', 'opened_on'];

async function insertBranch(conn, data) {
  const cols = BRANCH_COLS.filter((c) => data[c] !== undefined);
  const [res] = await conn.execute(`INSERT INTO branches (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => data[c]));
  return res.insertId;
}

async function updateBranch(conn, id, data) {
  const cols = BRANCH_COLS.filter((c) => c !== 'code' && data[c] !== undefined);
  if (cols.length === 0) return 0;
  const [res] = await conn.execute(`UPDATE branches SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => data[c]), id]);
  return res.affectedRows;
}

async function insertRegister(conn, { branchId, code, name }) {
  const [res] = await conn.execute('INSERT INTO cash_registers (branch_id, code, name) VALUES (?, ?, ?)', [branchId, code, name]);
  return res.insertId;
}

// ----------------------------------------------------------------- configuración
async function listSettings(conn) {
  const [rows] = await conn.query('SELECT setting_key, setting_value, value_type, description, is_editable, updated_by, updated_at FROM settings ORDER BY setting_key');
  return rows;
}

async function findSetting(conn, key) {
  const [rows] = await conn.execute('SELECT setting_key, setting_value, value_type, is_editable FROM settings WHERE setting_key = ? FOR UPDATE', [key]);
  return rows[0] || null;
}

async function updateSetting(conn, key, value, userId) {
  await conn.execute('UPDATE settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?', [value, userId, key]);
}

async function insertSetting(conn, { key, value, type, description, userId }) {
  await conn.execute('INSERT INTO settings (setting_key, setting_value, value_type, description, is_editable, updated_by) VALUES (?, ?, ?, ?, TRUE, ?)', [key, value, type, description, userId]);
}

module.exports = {
  listCustomers, findCustomer, insertCustomer, updateCustomer, listUsers, findUser, countActiveAdmins, updateUser, setPassword, unlock,
  replaceUserBranches, userPermissionOverrides, permissionIdsByCode, replaceUserOverrides, findRole, insertRole, syncRolePermissions,
  listBranches, insertBranch, updateBranch, insertRegister, listSettings, findSetting, updateSetting, insertSetting,
};
