'use strict';

/**
 * Devoluciones: sale_returns (REQUESTED → APPROVED/REJECTED → COMPLETED) y sale_return_items.
 * Los triggers validan cantidades vendidas/devueltas, importes y estados; el reingreso de unidades
 * aptas es un movimiento RETURN_IN y el reembolso en efectivo lo registra el trigger en caja.
 */

const { WhereBuilder, pageParams, likeContains } = require('../utils/query');

/** Asignaciones de la venta con lo vendido, lo ya devuelto y lo ya reembolsado (devoluciones no rechazadas). */
async function returnableBySale(conn, saleId) {
  const [rows] = await conn.execute(
    `SELECT sib.id AS sale_item_batch_id, si.id AS sale_item_id, si.product_id, si.product_name_snapshot AS product_name,
            si.sku_snapshot AS sku, si.quantity AS line_quantity, si.unit_price, si.line_total, si.discount_amount,
            sib.batch_id, sib.batch_number_snapshot AS batch_number, sib.expiry_date_snapshot AS expiry_date,
            sib.quantity AS sold_quantity, (sib.expiry_date_snapshot <= CURDATE()) AS is_expired,
            (SELECT COALESCE(SUM(sri.quantity), 0) FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.sale_return_id
              WHERE sri.sale_item_batch_id = sib.id AND sr.status <> 'REJECTED') AS returned_quantity,
            (SELECT COALESCE(SUM(sri.line_refund_amount), 0) FROM sale_return_items sri
               JOIN sale_returns sr ON sr.id = sri.sale_return_id
               JOIN sale_item_batches x ON x.id = sri.sale_item_batch_id
              WHERE x.sale_item_id = si.id AND sr.status <> 'REJECTED') AS line_refunded
       FROM sale_item_batches sib
       JOIN sale_items si ON si.id = sib.sale_item_id
      WHERE si.sale_id = ?
      ORDER BY si.id, sib.expiry_date_snapshot DESC, sib.id`,
    [saleId],
  );
  return rows;
}

async function findSaleIdByNumber(conn, { saleNumber, ticketNumber }) {
  if (saleNumber) {
    const [rows] = await conn.execute('SELECT id FROM sales WHERE sale_number = ?', [saleNumber]);
    return rows[0]?.id ?? null;
  }
  const [rows] = await conn.execute('SELECT sale_id AS id FROM sale_tickets WHERE ticket_number = ?', [ticketNumber]);
  return rows[0]?.id ?? null;
}

async function findReason(conn, { reasonId, reasonCode }) {
  const [rows] = reasonId
    ? await conn.execute('SELECT id, code, name, is_active FROM return_reasons WHERE id = ?', [reasonId])
    : await conn.execute('SELECT id, code, name, is_active FROM return_reasons WHERE code = ?', [reasonCode]);
  return rows[0] || null;
}

async function listReasons(conn) {
  const [rows] = await conn.query('SELECT id, code, name, description FROM return_reasons WHERE is_active = TRUE ORDER BY id');
  return rows;
}

async function insertReturn(conn, r) {
  const [res] = await conn.execute(
    `INSERT INTO sale_returns (return_number, sale_id, return_type, reason_id, status, requested_by, refund_status, notes)
     VALUES (?, ?, ?, ?, 'REQUESTED', ?, ?, ?)`,
    [r.number, r.saleId, r.returnType, r.reasonId, r.requestedBy, r.refundStatus, r.notes ?? null],
  );
  return res.insertId;
}

/** line_refund_amount lo recalcula el trigger (quantity * unit_refund_amount). */
async function insertItem(conn, i) {
  const [res] = await conn.execute(
    `INSERT INTO sale_return_items (sale_return_id, sale_item_batch_id, quantity, unit_refund_amount, line_refund_amount, item_condition, notes)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [i.returnId, i.saleItemBatchId, i.quantity, i.unitRefund, i.condition, i.notes ?? null],
  );
  return res.insertId;
}

const SELECT = `
  SELECT sr.*, s.sale_number, s.branch_id, b.name AS branch_name, rr.code AS reason_code, rr.name AS reason_name,
         ru.full_name AS requested_by_name, vu.full_name AS reviewed_by_name,
         (SELECT COALESCE(SUM(line_refund_amount), 0) FROM sale_return_items WHERE sale_return_id = sr.id) AS items_refund_total,
         (SELECT COALESCE(SUM(quantity), 0) FROM sale_return_items WHERE sale_return_id = sr.id) AS units
    FROM sale_returns sr
    JOIN sales s ON s.id = sr.sale_id
    JOIN branches b ON b.id = s.branch_id
    JOIN return_reasons rr ON rr.id = sr.reason_id
    JOIN users ru ON ru.id = sr.requested_by
    LEFT JOIN users vu ON vu.id = sr.reviewed_by`;

async function findById(conn, id) {
  const [rows] = await conn.execute(`${SELECT} WHERE sr.id = ?`, [id]);
  return rows[0] || null;
}

async function lockById(conn, id) {
  const [rows] = await conn.execute(
    `SELECT sr.id, sr.sale_id, sr.status, sr.return_number, s.branch_id
       FROM sale_returns sr JOIN sales s ON s.id = sr.sale_id WHERE sr.id = ? FOR UPDATE`,
    [id],
  );
  return rows[0] || null;
}

async function findItems(conn, returnId) {
  const [rows] = await conn.execute(
    `SELECT sri.id, sri.sale_item_batch_id, sri.quantity, sri.unit_refund_amount, sri.line_refund_amount, sri.item_condition,
            sri.restock, sri.notes, sib.batch_id, sib.batch_number_snapshot AS batch_number, sib.expiry_date_snapshot AS expiry_date,
            si.product_id, si.product_name_snapshot AS product_name, si.sku_snapshot AS sku,
            (SELECT im.id FROM inventory_movements im WHERE im.sale_return_item_id = sri.id) AS movement_id
       FROM sale_return_items sri
       JOIN sale_item_batches sib ON sib.id = sri.sale_item_batch_id
       JOIN sale_items si ON si.id = sib.sale_item_id
      WHERE sri.sale_return_id = ? ORDER BY sri.id`,
    [returnId],
  );
  return rows;
}

async function insertReturnMovement(conn, { batchId, quantity, returnItemId, performedBy, reason }) {
  const [res] = await conn.execute(
    `INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_return_item_id, performed_by, reason)
     VALUES (?, 'RETURN_IN', ?, ?, ?, ?)`,
    [batchId, quantity, returnItemId, performedBy, reason],
  );
  return res.insertId;
}

async function setStatus(conn, id, fromStatus, fields) {
  const cols = Object.keys(fields);
  const [res] = await conn.execute(
    `UPDATE sale_returns SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status = ?`,
    [...cols.map((c) => fields[c]), id, fromStatus],
  );
  return res.affectedRows;
}

/** Cobrado por método (pagos aprobados) y ya reembolsado por devoluciones por método. */
async function refundCapacityByMethod(conn, saleId, excludeReturnId) {
  const [paid] = await conn.execute(
    "SELECT method, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE sale_id = ? AND status = 'APPROVED' GROUP BY method",
    [saleId],
  );
  const [refunded] = await conn.execute(
    `SELECT refund_method AS method, COALESCE(SUM(refund_amount), 0) AS amount FROM sale_returns
      WHERE sale_id = ? AND refund_status = 'REFUNDED' AND id <> ? GROUP BY refund_method`,
    [saleId, excludeReturnId],
  );
  return { paid, refunded };
}

async function list(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 's.branch_id = ?', f.branchId)
    .addIf(f.saleId, 'sr.sale_id = ?', f.saleId)
    .addIf(f.status, 'sr.status = ?', f.status)
    .addIf(f.q, '(sr.return_number LIKE ? OR s.sale_number LIKE ?)', likeContains(f.q), likeContains(f.q))
    .addIf(f.from, 'sr.requested_at >= ?', f.from)
    .addIf(f.to, 'sr.requested_at < ? + INTERVAL 1 DAY', f.to);
  if (f.branchIds) w.add(`s.branch_id IN (${f.branchIds.map(() => '?').join(', ') || 'NULL'})`, ...f.branchIds);
  const [rows] = await conn.execute(`${SELECT} ${w.toSql()} ORDER BY sr.requested_at DESC, sr.id DESC LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM sale_returns sr JOIN sales s ON s.id = sr.sale_id ${w.toSql()}`, w.params);
  return { rows, total };
}

module.exports = {
  returnableBySale, findSaleIdByNumber, findReason, listReasons, insertReturn, insertItem, findById, lockById, findItems,
  insertReturnMovement, setStatus, refundCapacityByMethod, list,
};
