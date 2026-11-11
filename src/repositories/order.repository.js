'use strict';

/**
 * Pedidos web: orders (PENDING no descuenta stock), order_items y order_status_history
 * (lo escriben los triggers). Confirmar = venta ONLINE con SALE_OUT + UPDATE status CONFIRMED.
 */

const { WhereBuilder, pageParams, likeContains } = require('../utils/query');

async function insertOrder(conn, o) {
  const [res] = await conn.execute(
    `INSERT INTO orders (order_number, customer_id, branch_id, fulfillment_type, status, address_id,
                         subtotal, discount_total, delivery_fee, total, customer_note)
     VALUES (?, ?, ?, ?, 'PENDING', ?, ?, 0.00, ?, ?, ?)`,
    [o.orderNumber, o.customerId, o.branchId, o.fulfillmentType, o.addressId ?? null, o.subtotal, o.deliveryFee, o.total, o.customerNote ?? null],
  );
  return res.insertId;
}

async function insertItem(conn, i) {
  await conn.execute(
    `INSERT INTO order_items (order_id, product_id, product_name_snapshot, sku_snapshot, quantity, unit_price, line_total)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [i.orderId, i.productId, i.name, i.sku, i.quantity, i.unitPrice, i.lineTotal],
  );
}

async function lockById(conn, id) {
  const [rows] = await conn.execute(
    'SELECT id, order_number, customer_id, branch_id, fulfillment_type, status, total, delivery_fee, subtotal, assigned_user_id FROM orders WHERE id = ? FOR UPDATE',
    [id],
  );
  return rows[0] || null;
}

/** Cambio de estado: el trigger valida la transición, fija fechas/usuarios y escribe el historial. */
async function setStatus(conn, id, fromStatus, toStatus, extra = {}) {
  const cols = Object.keys(extra);
  const [res] = await conn.execute(
    `UPDATE orders SET status = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ? AND status = ?`,
    [toStatus, ...cols.map((c) => extra[c]), id, fromStatus],
  );
  return res.affectedRows;
}

async function setAssigned(conn, id, userId) {
  await conn.execute('UPDATE orders SET assigned_user_id = ? WHERE id = ?', [userId, id]);
}

async function insertPayment(conn, p) {
  const [res] = await conn.execute(
    `INSERT INTO payments (operation_code, order_id, method, status, amount, is_simulated, external_reference, failure_reason, processed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.operationCode, p.orderId, p.method, p.status, p.amount, p.isSimulated ? 1 : 0, p.externalReference ?? null, p.failureReason ?? null, p.processedBy ?? null],
  );
  return res.insertId;
}

async function payments(conn, orderId) {
  const [rows] = await conn.execute(
    `SELECT id, operation_code, sale_id, method, status, amount, tendered_amount, change_amount, is_simulated, external_reference,
            failure_reason, paid_at, refunded_at, created_at
       FROM payments WHERE order_id = ? ORDER BY id`,
    [orderId],
  );
  return rows;
}

/** Enlaza a la venta los pagos hechos sobre el pedido (el trigger lo permite solo para la venta del mismo pedido). */
async function linkPaymentsToSale(conn, orderId, saleId) {
  await conn.execute('UPDATE payments SET sale_id = ? WHERE order_id = ? AND sale_id IS NULL', [saleId, orderId]);
}

async function refundOrderPayment(conn, paymentId) {
  await conn.execute("UPDATE payments SET status = 'REFUNDED' WHERE id = ? AND status = 'APPROVED'", [paymentId]);
}

async function items(conn, orderId) {
  const [rows] = await conn.execute(
    `SELECT oi.id, oi.product_id, oi.product_name_snapshot, oi.sku_snapshot, oi.quantity, oi.unit_price, oi.line_total,
            p.requires_prescription
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.id`,
    [orderId],
  );
  return rows;
}

async function history(conn, orderId) {
  const [rows] = await conn.execute(
    `SELECT h.from_status, h.to_status, h.changed_by, u.full_name AS changed_by_name, r.code AS changed_by_role, h.note, h.changed_at
       FROM order_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE h.order_id = ? ORDER BY h.id`,
    [orderId],
  );
  return rows;
}

const SELECT = `
  SELECT o.*, b.name AS branch_name, c.full_name AS customer_name, c.phone AS customer_phone, c.user_id AS customer_user_id,
         s.id AS sale_id, s.sale_number, s.status AS sale_status, au.full_name AS assigned_user_name,
         (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.order_id = o.id AND p.status = 'APPROVED') AS paid_amount,
         (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS items_count
    FROM orders o
    JOIN branches b ON b.id = o.branch_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN sales s ON s.order_id = o.id
    LEFT JOIN users au ON au.id = o.assigned_user_id`;

async function findById(conn, id) {
  const [rows] = await conn.execute(`${SELECT} WHERE o.id = ?`, [id]);
  return rows[0] || null;
}

async function list(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.customerId, 'o.customer_id = ?', f.customerId)
    .addIf(f.branchId, 'o.branch_id = ?', f.branchId)
    .addIf(f.status, 'o.status = ?', f.status)
    .addIf(f.fulfillmentType, 'o.fulfillment_type = ?', f.fulfillmentType)
    .addIf(f.assignedUserId, 'o.assigned_user_id = ?', f.assignedUserId)
    .addIf(f.q, '(o.order_number LIKE ? OR c.full_name LIKE ?)', likeContains(f.q), likeContains(f.q))
    .addIf(f.from, 'o.created_at >= ?', f.from)
    .addIf(f.to, 'o.created_at < ? + INTERVAL 1 DAY', f.to);
  if (f.branchIds) w.add(`o.branch_id IN (${f.branchIds.map(() => '?').join(', ') || 'NULL'})`, ...f.branchIds);
  const [rows] = await conn.execute(`${SELECT} ${w.toSql()} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM orders o JOIN customers c ON c.id = o.customer_id ${w.toSql()}`, w.params);
  return { rows, total };
}

/** Pedido ya creado con esta clave de idempotencia por el mismo usuario (request_id de su auditoría). */
async function findByIdempotencyKey(conn, userId, key) {
  const [rows] = await conn.execute(
    `SELECT entity_id FROM audit_logs WHERE request_id = ? AND user_id = ? AND entity_table = 'orders'
        AND action IN ('CREATE', 'PAYMENT_REJECTED') ORDER BY id LIMIT 1`,
    [key, userId],
  );
  return rows[0] ? Number(rows[0].entity_id) : null;
}

module.exports = {
  insertOrder, insertItem, lockById, setStatus, setAssigned, insertPayment, payments, linkPaymentsToSale, refundOrderPayment,
  items, history, findById, list, findByIdempotencyKey,
};
