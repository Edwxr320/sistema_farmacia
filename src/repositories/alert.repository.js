'use strict';

const { WhereBuilder, pageParams } = require('../utils/query');

const SELECT = `
  SELECT sa.id, sa.alert_type, sa.status, sa.branch_id, b.name AS branch_name, sa.product_id, p.sku,
         p.name AS product_name, sa.batch_id, pb.batch_number, pb.expiry_date AS batch_expiry_date,
         pb.current_quantity AS batch_current_quantity, sa.stock_at_alert, sa.threshold_at_alert,
         sa.expiry_date_at_alert, sa.message, sa.created_at, sa.updated_at, sa.resolved_at, sa.resolved_by,
         u.full_name AS resolved_by_name, sa.resolution_note
    FROM stock_alerts sa
    JOIN branches b ON b.id = sa.branch_id
    JOIN products p ON p.id = sa.product_id
    LEFT JOIN product_batches pb ON pb.id = sa.batch_id
    LEFT JOIN users u ON u.id = sa.resolved_by`;

async function list(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 'sa.branch_id = ?', f.branchId)
    .addIf(f.productId, 'sa.product_id = ?', f.productId)
    .addIf(f.alertType, 'sa.alert_type = ?', f.alertType)
    .addIf(f.status, 'sa.status = ?', f.status);
  if (f.branchIds) w.add(`sa.branch_id IN (${f.branchIds.map(() => '?').join(', ') || 'NULL'})`, ...f.branchIds);
  const [rows] = await conn.execute(`${SELECT} ${w.toSql()} ORDER BY sa.created_at DESC, sa.id DESC LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM stock_alerts sa ${w.toSql()}`, w.params);
  return { rows, total };
}

async function summary(conn, branchIds) {
  const filter = branchIds ? `AND branch_id IN (${branchIds.map(() => '?').join(', ') || 'NULL'})` : '';
  const [rows] = await conn.execute(
    `SELECT alert_type, COUNT(*) AS total FROM stock_alerts WHERE status = 'OPEN' ${filter} GROUP BY alert_type`,
    branchIds || [],
  );
  return rows;
}

async function findById(conn, id, { forUpdate = false } = {}) {
  const [rows] = await conn.execute(`${SELECT} WHERE sa.id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
  return rows[0] || null;
}

/** Cierra una alerta abierta. Las alertas nunca se eliminan (trigger trg_stock_alerts_bd). */
async function close(conn, id, { status, userId, note }) {
  const [res] = await conn.execute(
    `UPDATE stock_alerts SET status = ?, resolved_at = NOW(), resolved_by = ?, resolution_note = ?
      WHERE id = ? AND status = 'OPEN'`,
    [status, userId, note, id],
  );
  return res.affectedRows;
}

module.exports = { list, summary, findById, close };
