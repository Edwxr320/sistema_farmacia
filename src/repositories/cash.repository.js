'use strict';

/**
 * Caja: cash_registers, cash_sessions, cash_movements.
 * expected_amount lo calcula el trigger al cerrar y difference_amount es columna generada:
 * este módulo nunca los escribe.
 */

const { WhereBuilder, pageParams } = require('../utils/query');

async function listRegisters(conn, branchIds) {
  const filter = branchIds ? `WHERE cr.branch_id IN (${branchIds.map(() => '?').join(', ') || 'NULL'})` : '';
  const [rows] = await conn.execute(
    `SELECT cr.id, cr.branch_id, b.name AS branch_name, cr.code, cr.name, cr.is_active,
            cs.id AS open_session_id, cs.session_number AS open_session_number, cs.opened_by AS open_session_user_id,
            u.full_name AS open_session_user_name, cs.opened_at AS open_session_opened_at
       FROM cash_registers cr
       JOIN branches b ON b.id = cr.branch_id
       LEFT JOIN cash_sessions cs ON cs.cash_register_id = cr.id AND cs.status = 'OPEN'
       LEFT JOIN users u ON u.id = cs.opened_by
       ${filter}
      ORDER BY cr.branch_id, cr.code`,
    branchIds || [],
  );
  return rows;
}

async function findRegister(conn, id) {
  const [rows] = await conn.execute('SELECT id, branch_id, code, name, is_active FROM cash_registers WHERE id = ?', [id]);
  return rows[0] || null;
}

async function findOpenSessionByUser(conn, userId) {
  const [rows] = await conn.execute(
    `SELECT cs.id, cs.session_number, cs.cash_register_id, cr.branch_id
       FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id
      WHERE cs.opened_by = ? AND cs.status = 'OPEN'`,
    [userId],
  );
  return rows[0] || null;
}

async function findOpenSessionByRegister(conn, registerId) {
  const [rows] = await conn.execute("SELECT id, opened_by FROM cash_sessions WHERE cash_register_id = ? AND status = 'OPEN'", [registerId]);
  return rows[0] || null;
}

/**
 * Sesión abierta del usuario en la sucursal, bloqueada en modo compartido:
 * impide que la caja se cierre mientras se registra la venta (hasta el COMMIT).
 */
async function lockOpenSessionForSale(conn, userId, branchId) {
  const [rows] = await conn.execute(
    `SELECT cs.id, cs.session_number, cs.status, cr.branch_id
       FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id
      WHERE cs.opened_by = ? AND cs.status = 'OPEN' AND cr.branch_id = ?
      LOCK IN SHARE MODE`,
    [userId, branchId],
  );
  return rows[0] || null;
}

async function insertSession(conn, s) {
  const [res] = await conn.execute(
    `INSERT INTO cash_sessions (session_number, cash_register_id, opened_by, opening_amount, opening_notes)
     VALUES (?, ?, ?, ?, ?)`,
    [s.number, s.registerId, s.openedBy, s.openingAmount, s.notes ?? null],
  );
  return res.insertId;
}

const SESSION_SELECT = `
  SELECT v.*, cs.cash_register_id, cr.name AS register_name, cs.closed_by, cu.full_name AS closed_by_name,
         cs.opening_notes, cs.closing_notes
    FROM vw_cash_session_summary v
    JOIN cash_sessions cs ON cs.id = v.cash_session_id
    JOIN cash_registers cr ON cr.id = cs.cash_register_id
    LEFT JOIN users cu ON cu.id = cs.closed_by`;

async function findSession(conn, id) {
  const [rows] = await conn.execute(`${SESSION_SELECT} WHERE v.cash_session_id = ?`, [id]);
  return rows[0] || null;
}

async function lockSession(conn, id) {
  const [rows] = await conn.execute(
    `SELECT cs.id, cs.status, cs.opened_by, cr.branch_id
       FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id
      WHERE cs.id = ? FOR UPDATE`,
    [id],
  );
  return rows[0] || null;
}

async function listSessions(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.status, 'v.status = ?', f.status)
    .addIf(f.cashRegisterId, 'cs.cash_register_id = ?', f.cashRegisterId)
    .addIf(f.userId, 'v.opened_by = ?', f.userId)
    .addIf(f.branchId, 'v.branch_id = ?', f.branchId)
    .addIf(f.from, 'v.opened_at >= ?', f.from)
    .addIf(f.to, 'v.opened_at < ? + INTERVAL 1 DAY', f.to);
  if (f.branchIds) w.add(`v.branch_id IN (${f.branchIds.map(() => '?').join(', ') || 'NULL'})`, ...f.branchIds);
  const [rows] = await conn.execute(`${SESSION_SELECT} ${w.toSql()} ORDER BY v.opened_at DESC, v.cash_session_id DESC LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(
    `SELECT COUNT(*) AS total FROM vw_cash_session_summary v JOIN cash_sessions cs ON cs.id = v.cash_session_id ${w.toSql()}`,
    w.params,
  );
  return { rows, total };
}

/** Cierre: el trigger trg_cash_sessions_bu calcula expected_amount y audita el cierre. */
async function closeSession(conn, id, { countedAmount, notes, closedBy }) {
  const [res] = await conn.execute(
    `UPDATE cash_sessions SET status = 'CLOSED', counted_amount = ?, closing_notes = ?, closed_by = ?, closed_at = NOW()
      WHERE id = ? AND status = 'OPEN'`,
    [countedAmount, notes ?? null, closedBy, id],
  );
  return res.affectedRows;
}

async function insertMovement(conn, m) {
  const [res] = await conn.execute(
    `INSERT INTO cash_movements (cash_session_id, movement_type, amount, description, performed_by)
     VALUES (?, ?, ?, ?, ?)`,
    [m.sessionId, m.movementType, m.amount, m.description, m.performedBy],
  );
  return res.insertId;
}

async function listMovements(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.cashSessionId, 'cm.cash_session_id = ?', f.cashSessionId)
    .addIf(f.movementType, 'cm.movement_type = ?', f.movementType)
    .addIf(f.userId, 'cs.opened_by = ?', f.userId);
  if (f.branchIds) w.add(`cr.branch_id IN (${f.branchIds.map(() => '?').join(', ') || 'NULL'})`, ...f.branchIds);
  const from = `FROM cash_movements cm
                JOIN cash_sessions cs ON cs.id = cm.cash_session_id
                JOIN cash_registers cr ON cr.id = cs.cash_register_id
                JOIN users u ON u.id = cm.performed_by
                LEFT JOIN payments p ON p.id = cm.payment_id
                LEFT JOIN sales s ON s.id = p.sale_id`;
  const [rows] = await conn.execute(
    `SELECT cm.id, cm.cash_session_id, cs.session_number, cr.branch_id, cm.movement_type, cm.direction, cm.amount,
            cm.payment_id, p.operation_code, s.sale_number, cm.sale_return_id, cm.description,
            cm.performed_by, u.full_name AS performed_by_name, cm.created_at
       ${from} ${w.toSql()} ORDER BY cm.created_at DESC, cm.id DESC LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total ${from} ${w.toSql()}`, w.params);
  return { rows, total };
}

/** Resumen comercial de la sesión: ventas y pagos por método. */
async function sessionSalesSummary(conn, sessionId) {
  const [[sales]] = await conn.execute(
    `SELECT COUNT(*) AS sales_count,
            COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed_count,
            COALESCE(SUM(CASE WHEN status = 'VOIDED' THEN 1 ELSE 0 END), 0) AS voided_count,
            COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN total ELSE 0 END), 0) AS completed_total,
            COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN discount_total ELSE 0 END), 0) AS discount_total
       FROM sales WHERE cash_session_id = ?`,
    [sessionId],
  );
  const [byMethod] = await conn.execute(
    `SELECT method, status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
       FROM payments WHERE cash_session_id = ? GROUP BY method, status ORDER BY method, status`,
    [sessionId],
  );
  return { sales, byMethod };
}

module.exports = {
  listRegisters, findRegister, findOpenSessionByUser, findOpenSessionByRegister, lockOpenSessionForSale, insertSession,
  findSession, lockSession, listSessions, closeSession, insertMovement, listMovements, sessionSalesSummary,
};
