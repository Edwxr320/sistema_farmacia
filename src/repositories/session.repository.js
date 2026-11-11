'use strict';

/**
 * Sesiones persistentes (tabla user_sessions, migración 001).
 * Solo se guarda el SHA-256 del identificador de sesión.
 */

async function insert(conn, { sessionHash, userId, branchId, ttlMinutes, ip, userAgent }) {
  await conn.execute(
    `INSERT INTO user_sessions (session_hash, user_id, branch_id, expires_at, last_seen_at, ip_address, user_agent)
     VALUES (?, ?, ?, NOW() + INTERVAL ? MINUTE, NOW(), ?, ?)`,
    [sessionHash, userId, branchId, ttlMinutes, ip, userAgent],
  );
}

/** Sesión vigente: no revocada y no expirada. */
async function findActive(conn, sessionHash) {
  const [rows] = await conn.execute(
    `SELECT id, user_id, branch_id, expires_at
       FROM user_sessions
      WHERE session_hash = ? AND revoked_at IS NULL AND expires_at > NOW()`,
    [sessionHash],
  );
  return rows[0] || null;
}

/** Actualiza last_seen_at como máximo cada 5 minutos (evita una escritura por petición). */
async function touch(conn, id) {
  await conn.execute(
    `UPDATE user_sessions SET last_seen_at = NOW()
      WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL 5 MINUTE)`,
    [id],
  );
}

async function revoke(conn, sessionHash, reason) {
  const [result] = await conn.execute(
    'UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = ? WHERE session_hash = ? AND revoked_at IS NULL',
    [reason, sessionHash],
  );
  return result.affectedRows;
}

/** Revoca todas las sesiones vigentes del usuario (opcionalmente salvo una). */
async function revokeAllForUser(conn, userId, reason, exceptHash = null) {
  const [result] = await conn.execute(
    `UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = ?
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
        AND (? IS NULL OR session_hash <> ?)`,
    [reason, userId, exceptHash, exceptHash],
  );
  return result.affectedRows;
}

/** Elimina sesiones ya expiradas (revocadas o no). El historial queda en audit_logs. */
async function deleteExpired(conn, batchSize = 1000) {
  const [result] = await conn.execute('DELETE FROM user_sessions WHERE expires_at <= NOW() LIMIT ?', [String(batchSize)]);
  return result.affectedRows;
}

async function tableExists(conn) {
  const [rows] = await conn.execute(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_sessions'",
  );
  return rows.length > 0;
}

module.exports = { insert, findActive, touch, revoke, revokeAllForUser, deleteExpired, tableExists };
