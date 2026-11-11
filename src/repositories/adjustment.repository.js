'use strict';

/**
 * Ajustes de inventario: inventory_adjustments es el encabezado y cada línea es un
 * movimiento de inventory_movements (adjustment_id + batch_id, únicos juntos).
 * Las existencias las modifican SOLO los triggers de inventory_movements.
 */

const { WhereBuilder, pageParams, likeContains } = require('../utils/query');

async function insert(conn, a) {
  const [res] = await conn.execute(
    `INSERT INTO inventory_adjustments (adjustment_number, branch_id, adjustment_type, reason, performed_by, approved_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [a.number, a.branchId, a.type, a.reason, a.performedBy, a.approvedBy ?? null],
  );
  return res.insertId;
}

/** Bloquea los lotes (orden estable por id) y devuelve su estado real. */
async function lockBatches(conn, batchIds) {
  const [rows] = await conn.execute(
    `SELECT id, product_id, branch_id, batch_number, expiry_date, current_quantity, status,
            (expiry_date <= CURDATE()) AS is_expired
       FROM product_batches
      WHERE id IN (${batchIds.map(() => '?').join(', ')})
      ORDER BY id FOR UPDATE`,
    batchIds,
  );
  return rows;
}

async function insertMovement(conn, { batchId, movementType, quantity, adjustmentId, performedBy, reason }) {
  const [res] = await conn.execute(
    `INSERT INTO inventory_movements (batch_id, movement_type, quantity, adjustment_id, performed_by, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [batchId, movementType, quantity, adjustmentId, performedBy, reason],
  );
  return res.insertId;
}

const SELECT = `
  SELECT ia.id, ia.adjustment_number, ia.branch_id, b.name AS branch_name, ia.adjustment_type, ia.reason,
         ia.performed_by, pu.full_name AS performed_by_name, ia.approved_by, au.full_name AS approved_by_name,
         ia.created_at,
         (SELECT COUNT(*) FROM inventory_movements im WHERE im.adjustment_id = ia.id) AS movements_count,
         (SELECT COALESCE(SUM(CASE WHEN im.direction = 'IN' THEN im.quantity ELSE 0 END), 0)
            FROM inventory_movements im WHERE im.adjustment_id = ia.id) AS units_in,
         (SELECT COALESCE(SUM(CASE WHEN im.direction = 'OUT' THEN im.quantity ELSE 0 END), 0)
            FROM inventory_movements im WHERE im.adjustment_id = ia.id) AS units_out
    FROM inventory_adjustments ia
    JOIN branches b ON b.id = ia.branch_id
    JOIN users pu ON pu.id = ia.performed_by
    LEFT JOIN users au ON au.id = ia.approved_by`;

async function findById(conn, id) {
  const [rows] = await conn.execute(`${SELECT} WHERE ia.id = ?`, [id]);
  return rows[0] || null;
}

async function list(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 'ia.branch_id = ?', f.branchId)
    .addIf(f.adjustmentType, 'ia.adjustment_type = ?', f.adjustmentType)
    .addIf(f.q, 'ia.adjustment_number LIKE ?', likeContains(f.q))
    .addIf(f.productId, 'EXISTS (SELECT 1 FROM inventory_movements im WHERE im.adjustment_id = ia.id AND im.product_id = ?)', f.productId)
    .addIf(f.from, 'ia.created_at >= ?', f.from)
    .addIf(f.to, 'ia.created_at < ? + INTERVAL 1 DAY', f.to);
  if (f.branchIds) w.add(`ia.branch_id IN (${f.branchIds.map(() => '?').join(', ') || 'NULL'})`, ...f.branchIds);
  const [rows] = await conn.execute(`${SELECT} ${w.toSql()} ORDER BY ia.created_at DESC, ia.id DESC LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM inventory_adjustments ia ${w.toSql()}`, w.params);
  return { rows, total };
}

async function movements(conn, adjustmentId) {
  const [rows] = await conn.execute(
    `SELECT im.id, im.batch_id, pb.batch_number, pb.expiry_date, im.product_id, p.sku, p.name AS product_name,
            im.movement_type, im.direction, im.quantity, im.batch_stock_before, im.batch_stock_after,
            im.stock_before, im.stock_after, im.reason, im.created_at
       FROM inventory_movements im
       JOIN product_batches pb ON pb.id = im.batch_id
       JOIN products p ON p.id = im.product_id
      WHERE im.adjustment_id = ?
      ORDER BY im.id`,
    [adjustmentId],
  );
  return rows;
}

module.exports = { insert, lockBatches, insertMovement, findById, list, movements };
