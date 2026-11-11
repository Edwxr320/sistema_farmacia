'use strict';

/** Sucursales activas asignadas al usuario; la predeterminada primero. */
async function findUserBranches(conn, userId) {
  const [rows] = await conn.execute(
    `SELECT b.id, b.code, b.name, b.is_main, ub.is_default
       FROM user_branches ub
       JOIN branches b ON b.id = ub.branch_id
      WHERE ub.user_id = ? AND b.status = 'ACTIVE'
      ORDER BY ub.is_default DESC, b.is_main DESC, b.id`,
    [userId],
  );
  return rows;
}

async function findMainBranch(conn) {
  const [rows] = await conn.query(
    "SELECT id, code, name FROM branches WHERE is_main = TRUE AND status = 'ACTIVE' LIMIT 1",
  );
  return rows[0] || null;
}

async function assignUserBranch(conn, { userId, branchId, isDefault, assignedBy = null }) {
  await conn.execute(
    'INSERT INTO user_branches (user_id, branch_id, is_default, assigned_by) VALUES (?, ?, ?, ?)',
    [userId, branchId, isDefault ? 1 : 0, assignedBy],
  );
}

module.exports = { findUserBranches, findMainBranch, assignUserBranch };
