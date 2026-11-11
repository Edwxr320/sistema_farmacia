'use strict';

/**
 * Ventas POS. Orden exigido por los triggers:
 *   sales (COMPLETED) → sale_items → sale_item_batches → inventory_movements SALE_OUT
 *   → payments → sale_tickets.
 * Anulación: sale_voids (marca VOIDED) → SALE_VOID_IN por asignación → pagos REFUNDED/CANCELLED.
 * El stock lo modifican exclusivamente los triggers de inventory_movements.
 */

const { WhereBuilder, pageParams, likeContains } = require('../utils/query');

// ---------------------------------------------------------- catálogo del POS
async function catalog(conn, branchId, f) {
  const w = new WhereBuilder()
    .add("p.status = 'ACTIVE'")
    .addIf(f.q, '(p.name LIKE ? OR p.active_ingredient LIKE ? OR p.sku LIKE ? OR p.barcode = ?)',
      likeContains(f.q), likeContains(f.q), likeContains(f.q), f.q)
    .addIf(f.barcode, 'p.barcode = ?', f.barcode)
    .addIf(f.sku, 'p.sku = ?', f.sku);
  const stockSql = `
    SELECT pb.product_id,
           SUM(CASE WHEN pb.status = 'ACTIVE' AND pb.expiry_date > CURDATE() THEN pb.current_quantity ELSE 0 END) AS available_stock,
           SUM(CASE WHEN pb.expiry_date <= CURDATE() THEN pb.current_quantity ELSE 0 END) AS expired_stock,
           MIN(CASE WHEN pb.status = 'ACTIVE' AND pb.current_quantity > 0 AND pb.expiry_date > CURDATE() THEN pb.expiry_date END) AS next_expiry_date
      FROM product_batches pb WHERE pb.branch_id = ? GROUP BY pb.product_id`;
  const having = f.onlyAvailable ? 'AND COALESCE(st.available_stock, 0) > 0 AND COALESCE(bp.is_available, TRUE)' : '';
  const from = `FROM products p
                LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
                LEFT JOIN (${stockSql}) st ON st.product_id = p.id
                ${w.toSql()} ${having}`;
  const [rows] = await conn.execute(
    `SELECT p.id, p.sku, p.barcode, p.name, p.presentation, p.concentration, p.unit, p.image_url, p.requires_prescription,
            COALESCE(bp.sale_price, p.sale_price) AS price, COALESCE(bp.is_available, TRUE) AS is_available,
            COALESCE(st.available_stock, 0) AS available_stock, COALESCE(st.expired_stock, 0) AS expired_stock,
            st.next_expiry_date, DATEDIFF(st.next_expiry_date, CURDATE()) AS days_to_next_expiry,
            (st.next_expiry_date IS NOT NULL AND st.next_expiry_date <= CURDATE() + INTERVAL
               COALESCE((SELECT CAST(setting_value AS SIGNED) FROM settings WHERE setting_key = 'inventory.expiry_alert_days'), 90) DAY)
              AS expiring_soon
       ${from}
      ORDER BY p.name LIMIT ? OFFSET ?`,
    [branchId, branchId, ...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total ${from}`, [branchId, branchId, ...w.params]);
  return { rows, total };
}

/** Datos comerciales reales de los productos para la sucursal (precio efectivo, disponibilidad). */
async function productsForSale(conn, branchId, productIds) {
  const [rows] = await conn.execute(
    `SELECT p.id, p.sku, p.name, p.status, p.requires_prescription,
            COALESCE(bp.sale_price, p.sale_price) AS price, COALESCE(bp.is_available, TRUE) AS is_available,
            (SELECT COALESCE(SUM(pb.current_quantity), 0) FROM product_batches pb
              WHERE pb.branch_id = ? AND pb.product_id = p.id AND pb.status = 'ACTIVE'
                AND pb.current_quantity > 0 AND pb.expiry_date > CURDATE()) AS available_stock
       FROM products p
       LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
      WHERE p.id IN (${productIds.map(() => '?').join(', ')})`,
    [branchId, branchId, ...productIds],
  );
  return rows;
}

async function getSetting(conn, key) {
  const [rows] = await conn.execute('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
  return rows[0] ? rows[0].setting_value : null;
}

async function findCustomer(conn, id) {
  const [rows] = await conn.execute('SELECT id, full_name, is_active FROM customers WHERE id = ?', [id]);
  return rows[0] || null;
}

// ------------------------------------------------------------------ escritura
async function insertSale(conn, s) {
  const [res] = await conn.execute(
    `INSERT INTO sales (sale_number, branch_id, customer_id, customer_name_snapshot, customer_document_snapshot,
                        seller_user_id, cash_session_id, sale_channel, status, subtotal, discount_total, delivery_fee, total, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'POS', 'COMPLETED', ?, ?, 0.00, ?, ?)`,
    [s.saleNumber, s.branchId, s.customerId ?? null, s.customerName ?? null, s.customerDocument ?? null,
      s.sellerId, s.cashSessionId, s.subtotal, s.discountTotal, s.total, s.notes ?? null],
  );
  return res.insertId;
}

/** Venta generada al confirmar un pedido web (sale_channel ONLINE, con order_id; sin caja). */
async function insertOnlineSale(conn, s) {
  const [res] = await conn.execute(
    `INSERT INTO sales (sale_number, branch_id, order_id, customer_id, seller_user_id, cash_session_id, sale_channel, status,
                        subtotal, discount_total, delivery_fee, total, notes)
     VALUES (?, ?, ?, ?, ?, NULL, 'ONLINE', 'COMPLETED', ?, 0.00, ?, ?, ?)`,
    [s.saleNumber, s.branchId, s.orderId, s.customerId, s.sellerId, s.subtotal, s.deliveryFee, s.total, s.notes ?? null],
  );
  return res.insertId;
}

async function insertItem(conn, i) {
  const [res] = await conn.execute(
    `INSERT INTO sale_items (sale_id, product_id, product_name_snapshot, sku_snapshot, quantity, unit_price,
                             line_subtotal, discount_amount, line_total, prescription_reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [i.saleId, i.productId, i.name, i.sku, i.quantity, i.unitPrice, i.lineSubtotal, i.discountAmount, i.lineTotal,
      i.prescriptionReference ?? null],
  );
  return res.insertId;
}

/** El trigger completa batch_number_snapshot y expiry_date_snapshot y valida el lote. */
async function insertAllocation(conn, { saleItemId, batchId, quantity }) {
  const [res] = await conn.execute(
    'INSERT INTO sale_item_batches (sale_item_id, batch_id, quantity) VALUES (?, ?, ?)',
    [saleItemId, batchId, quantity],
  );
  return res.insertId;
}

async function insertStockMovement(conn, { batchId, movementType, quantity, saleItemBatchId, performedBy, reason }) {
  const [res] = await conn.execute(
    `INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_item_batch_id, performed_by, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [batchId, movementType, quantity, saleItemBatchId, performedBy, reason],
  );
  return res.insertId;
}

async function insertPayment(conn, p) {
  const [res] = await conn.execute(
    `INSERT INTO payments (operation_code, sale_id, cash_session_id, method, status, amount, tendered_amount, change_amount,
                           is_simulated, external_reference, failure_reason, processed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.operationCode, p.saleId, p.cashSessionId, p.method, p.status, p.amount, p.tenderedAmount ?? null,
      p.changeAmount ?? null, p.isSimulated ? 1 : 0, p.externalReference ?? null, p.failureReason ?? null, p.processedBy],
  );
  return res.insertId;
}

async function cancelPayment(conn, paymentId, reason) {
  await conn.execute(
    "UPDATE payments SET status = 'CANCELLED', failure_reason = ? WHERE id = ? AND status = 'PENDING'",
    [reason, paymentId],
  );
}

/** Reembolso: el trigger fija refunded_at y, en efectivo, registra el PAYMENT_REFUND en caja. */
async function refundPayment(conn, paymentId, refundCashSessionId) {
  const [res] = await conn.execute(
    "UPDATE payments SET status = 'REFUNDED', refund_cash_session_id = ? WHERE id = ? AND status = 'APPROVED'",
    [refundCashSessionId ?? null, paymentId],
  );
  return res.affectedRows;
}

async function insertVoid(conn, { saleId, reason, voidedBy }) {
  const [res] = await conn.execute(
    'INSERT INTO sale_voids (sale_id, reason, voided_by) VALUES (?, ?, ?)',
    [saleId, reason, voidedBy],
  );
  return res.insertId;
}

/** El trigger completa los snapshots del encabezado desde settings, sucursal y venta. */
async function insertTicket(conn, { ticketNumber, saleId, issuedBy, legend }) {
  const [res] = await conn.execute(
    `INSERT INTO sale_tickets (ticket_number, sale_id, issued_by, legend)
     VALUES (?, ?, ?, COALESCE(?, 'Ticket interno. No es un comprobante de pago electrónico.'))`,
    [ticketNumber, saleId, issuedBy, legend],
  );
  return res.insertId;
}

async function registerPrint(conn, saleId) {
  const [res] = await conn.execute(
    'UPDATE sale_tickets SET print_count = print_count + 1, last_printed_at = NOW() WHERE sale_id = ?',
    [saleId],
  );
  return res.affectedRows;
}

// ------------------------------------------------------------------- lectura
const SALE_SELECT = `
  SELECT s.*, b.name AS branch_name, u.full_name AS seller_name, cs.session_number,
         sv.reason AS void_reason, sv.voided_at, sv.voided_by, vu.full_name AS voided_by_name,
         ps.approved_amount, ps.refunded_amount, ps.balance_due, ps.payment_state,
         t.ticket_number, t.print_count
    FROM sales s
    JOIN branches b ON b.id = s.branch_id
    JOIN users u ON u.id = s.seller_user_id
    LEFT JOIN cash_sessions cs ON cs.id = s.cash_session_id
    LEFT JOIN sale_voids sv ON sv.sale_id = s.id
    LEFT JOIN users vu ON vu.id = sv.voided_by
    LEFT JOIN vw_sale_payment_summary ps ON ps.sale_id = s.id
    LEFT JOIN sale_tickets t ON t.sale_id = s.id`;

async function findSale(conn, id) {
  const [rows] = await conn.execute(`${SALE_SELECT} WHERE s.id = ?`, [id]);
  return rows[0] || null;
}

async function lockSale(conn, id) {
  const [rows] = await conn.execute('SELECT id, branch_id, status, total, sale_number FROM sales WHERE id = ? FOR UPDATE', [id]);
  return rows[0] || null;
}

async function findItems(conn, saleId) {
  const [items] = await conn.execute(
    `SELECT id, product_id, product_name_snapshot, sku_snapshot, quantity, unit_price, line_subtotal,
            discount_amount, line_total, prescription_reference
       FROM sale_items WHERE sale_id = ? ORDER BY id`,
    [saleId],
  );
  const [allocs] = await conn.execute(
    `SELECT sib.id, sib.sale_item_id, sib.batch_id, sib.quantity, sib.batch_number_snapshot, sib.expiry_date_snapshot,
            (SELECT im.id FROM inventory_movements im WHERE im.sale_item_batch_id = sib.id AND im.movement_type = 'SALE_OUT') AS sale_out_id,
            (SELECT im.id FROM inventory_movements im WHERE im.sale_item_batch_id = sib.id AND im.movement_type = 'SALE_VOID_IN') AS void_in_id
       FROM sale_item_batches sib JOIN sale_items si ON si.id = sib.sale_item_id
      WHERE si.sale_id = ? ORDER BY sib.id`,
    [saleId],
  );
  return items.map((i) => ({ ...i, allocations: allocs.filter((a) => a.sale_item_id === i.id) }));
}

async function findPayments(conn, saleId) {
  const [rows] = await conn.execute(
    `SELECT id, operation_code, method, status, amount, tendered_amount, change_amount, is_simulated,
            external_reference, failure_reason, processed_by, paid_at, refunded_at, refund_cash_session_id, created_at
       FROM payments WHERE sale_id = ? ORDER BY id`,
    [saleId],
  );
  return rows;
}

async function countActiveReturns(conn, saleId) {
  const [[r]] = await conn.execute("SELECT COUNT(*) AS n FROM sale_returns WHERE sale_id = ? AND status <> 'REJECTED'", [saleId]);
  return Number(r.n);
}

async function list(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 's.branch_id = ?', f.branchId)
    .addIf(f.status, 's.status = ?', f.status)
    .addIf(f.cashSessionId, 's.cash_session_id = ?', f.cashSessionId)
    .addIf(f.sellerId, 's.seller_user_id = ?', f.sellerId)
    .addIf(f.customerId, 's.customer_id = ?', f.customerId)
    .addIf(f.q, '(s.sale_number LIKE ? OR s.customer_name_snapshot LIKE ?)', likeContains(f.q), likeContains(f.q))
    .addIf(f.from, 's.sold_at >= ?', f.from)
    .addIf(f.to, 's.sold_at < ? + INTERVAL 1 DAY', f.to);
  if (f.branchIds) w.add(`s.branch_id IN (${f.branchIds.map(() => '?').join(', ') || 'NULL'})`, ...f.branchIds);
  const [rows] = await conn.execute(`${SALE_SELECT} ${w.toSql()} ORDER BY s.sold_at DESC, s.id DESC LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM sales s ${w.toSql()}`, w.params);
  return { rows, total };
}

/** Venta ya creada con la misma clave de idempotencia (request_id de su auditoría) por el mismo usuario. */
async function findByIdempotencyKey(conn, userId, key) {
  const [rows] = await conn.execute(
    `SELECT entity_id FROM audit_logs
      WHERE request_id = ? AND user_id = ? AND entity_table = 'sales' AND action IN ('CREATE', 'PAYMENT_REJECTED')
      ORDER BY id LIMIT 1`,
    [key, userId],
  );
  return rows[0] ? Number(rows[0].entity_id) : null;
}

async function findTicket(conn, saleId) {
  const [[header]] = await conn.execute('SELECT * FROM vw_sale_ticket_header WHERE sale_id = ?', [saleId]);
  if (!header) return null;
  const [lines] = await conn.execute('SELECT * FROM vw_sale_ticket_lines WHERE sale_id = ? ORDER BY sale_item_id', [saleId]);
  const [[meta]] = await conn.execute(
    `SELECT t.id, t.issued_by, t.last_printed_at, s.customer_document_snapshot, s.branch_id
       FROM sale_tickets t JOIN sales s ON s.id = t.sale_id WHERE t.sale_id = ?`,
    [saleId],
  );
  return { header, lines, meta };
}

async function listPayments(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 'ph.branch_id = ?', f.branchId)
    .addIf(f.saleId, 'ph.sale_id = ?', f.saleId)
    .addIf(f.cashSessionId, 'p.cash_session_id = ?', f.cashSessionId)
    .addIf(f.method, 'ph.method = ?', f.method)
    .addIf(f.status, 'ph.status = ?', f.status)
    .addIf(f.from, 'ph.created_at >= ?', f.from)
    .addIf(f.to, 'ph.created_at < ? + INTERVAL 1 DAY', f.to);
  if (f.branchIds) w.add(`ph.branch_id IN (${f.branchIds.map(() => '?').join(', ') || 'NULL'})`, ...f.branchIds);
  const from = 'FROM vw_payment_history ph JOIN payments p ON p.id = ph.id';
  const [rows] = await conn.execute(
    `SELECT ph.*, p.tendered_amount, p.change_amount, p.external_reference, p.cash_session_id, p.refund_cash_session_id
       ${from} ${w.toSql()} ORDER BY ph.created_at DESC, ph.id DESC LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total ${from} ${w.toSql()}`, w.params);
  return { rows, total };
}

module.exports = {
  catalog, productsForSale, getSetting, findCustomer, insertSale, insertOnlineSale, insertItem, insertAllocation, insertStockMovement,
  insertPayment, cancelPayment, refundPayment, insertVoid, insertTicket, registerPrint, findSale, lockSale, findItems,
  findPayments, countActiveReturns, list, findByIdempotencyKey, findTicket, listPayments,
};
