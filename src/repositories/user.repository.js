'use strict';

/**
 * Consultas SQL sobre users. Todas parametrizadas.
 * Ninguna función de este módulo devuelve password_hash salvo findForLogin.
 */

const PUBLIC_COLUMNS = `
  u.id, u.full_name, u.email, u.phone, u.status, u.must_change_password,
  u.failed_login_attempts, u.locked_until, u.password_changed_at, u.last_login_at,
  u.created_at, u.updated_at,
  r.id AS role_id, r.code AS role_code, r.name AS role_name, r.is_active AS role_is_active`;

/** Usuario con su hash, para verificar la contraseña. Bloquea la fila si forUpdate. */
async function findForLogin(conn, email, { forUpdate = false } = {}) {
  const [rows] = await conn.execute(
    `SELECT ${PUBLIC_COLUMNS}, u.password_hash,
            (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.email = ?
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [email],
  );
  return rows[0] || null;
}

async function findById(conn, id) {
  const [rows] = await conn.execute(
    `SELECT ${PUBLIC_COLUMNS},
            (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?`,
    [id],
  );
  return rows[0] || null;
}

async function emailExists(conn, email) {
  const [rows] = await conn.execute('SELECT 1 FROM users WHERE email = ? LIMIT 1', [email]);
  return rows.length > 0;
}

/**
 * Registra un intento fallido de forma atómica.
 * MariaDB evalúa las asignaciones de un UPDATE de izquierda a derecha: la
 * segunda expresión ya ve el contador actualizado.
 * Si un bloqueo anterior ya expiró, el contador se reinicia.
 */
async function registerFailedLogin(conn, userId, maxAttempts, lockoutMinutes) {
  await conn.execute(
    `UPDATE users
        SET failed_login_attempts = IF(locked_until IS NOT NULL AND locked_until <= NOW(),
                                       1, LEAST(failed_login_attempts + 1, 65535)),
            locked_until = IF(failed_login_attempts >= ?, NOW() + INTERVAL ? MINUTE, NULL)
      WHERE id = ?`,
    [maxAttempts, lockoutMinutes, userId],
  );
  const [rows] = await conn.execute(
    'SELECT failed_login_attempts, locked_until, (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked FROM users WHERE id = ?',
    [userId],
  );
  return rows[0];
}

async function registerSuccessfulLogin(conn, userId) {
  await conn.execute(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?',
    [userId],
  );
}

/** Hash actual del usuario, con la fila bloqueada para la transacción en curso. */
async function findPasswordHashForUpdate(conn, userId) {
  const [rows] = await conn.execute(
    'SELECT id, email, password_hash, status FROM users WHERE id = ? FOR UPDATE',
    [userId],
  );
  return rows[0] || null;
}

/** Nueva contraseña: limpia el cambio obligatorio y los intentos fallidos. */
async function updatePassword(conn, userId, passwordHash) {
  await conn.execute(
    `UPDATE users
        SET password_hash = ?, must_change_password = FALSE, password_changed_at = NOW(),
            failed_login_attempts = 0, locked_until = NULL
      WHERE id = ?`,
    [passwordHash, userId],
  );
}

async function insertUser(conn, { roleId, fullName, email, passwordHash, phone = null, mustChangePassword = false }) {
  const [result] = await conn.execute(
    `INSERT INTO users (role_id, full_name, email, password_hash, phone, must_change_password, password_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [roleId, fullName, email, passwordHash, phone, mustChangePassword ? 1 : 0],
  );
  return result.insertId;
}

/** Cuenta los usuarios (de cualquier estado) que tienen el rol indicado. */
async function countByRoleCode(conn, roleCode) {
  const [rows] = await conn.execute(
    'SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = ?',
    [roleCode],
  );
  return Number(rows[0].total);
}

async function list(conn, { limit, offset }) {
  const [rows] = await conn.execute(
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.must_change_password,
            u.last_login_at, u.created_at, r.code AS role_code, r.name AS role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
      ORDER BY u.id
      LIMIT ? OFFSET ?`,
    [String(limit), String(offset)],
  );
  const [count] = await conn.query('SELECT COUNT(*) AS total FROM users');
  return { rows, total: Number(count[0].total) };
}

module.exports = {
  findForLogin,
  findById,
  emailExists,
  registerFailedLogin,
  registerSuccessfulLogin,
  findPasswordHashForUpdate,
  updatePassword,
  insertUser,
  countByRoleCode,
  list,
};
