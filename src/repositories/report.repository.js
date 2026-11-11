'use strict';

/**
 * Consultas de reportes (solo lectura). Cada agregado se calcula desde su tabla base para evitar
 * duplicados por joins (p. ej. totales de venta desde `sales`, nunca sumando sales × sale_items).
 * Fechas: sold_at/created_at están en hora de Lima; los rangos son [from, to + 1 día).
 */

const { WhereBuilder, pageParams } = require('../utils/query');

function inList(col, ids) {
  return { clause: `${col} IN (${ids.map(() => '?').join(', ') || 'NULL'})`, params: ids };
}

/** Filtro común de ventas (alias s). */
function salesWhere(f, { status = 'COMPLETED', dateCol = 's.sold_at' } = {}) {
  const w = new WhereBuilder()
    .addIf(status, 's.status = ?', status)
    .add(`${dateCol} >= ?`, f.from)
    .add(`${dateCol} < ? + INTERVAL 1 DAY`, f.to)
    .addIf(f.branchId, 's.branch_id = ?', f.branchId)
    .addIf(f.channel, 's.sale_channel = ?', f.channel)
    .addIf(f.sellerId, 's.seller_user_id = ?', f.sellerId);
  if (f.branchIds) {
    const { clause, params } = inList('s.branch_id', f.branchIds);
    w.add(clause, ...params);
  }
  return w;
}

function branchScope(w, col, f) {
  w.addIf(f.branchId, `${col} = ?`, f.branchId);
  if (f.branchIds) {
    const { clause, params } = inList(col, f.branchIds);
    w.add(clause, ...params);
  }
  return w;
}

async function salesTotals(conn, f) {
  const w = salesWhere(f);
  const [[r]] = await conn.execute(
    `SELECT COUNT(*) AS transactions, COALESCE(SUM(s.subtotal), 0) AS gross, COALESCE(SUM(s.discount_total), 0) AS discounts,
            COALESCE(SUM(s.delivery_fee), 0) AS delivery_fees, COALESCE(SUM(s.total), 0) AS net_sales,
            COALESCE(SUM(s.sale_channel = 'POS'), 0) AS pos_count, COALESCE(SUM(CASE WHEN s.sale_channel = 'POS' THEN s.total END), 0) AS pos_total,
            COALESCE(SUM(s.sale_channel = 'ONLINE'), 0) AS online_count, COALESCE(SUM(CASE WHEN s.sale_channel = 'ONLINE' THEN s.total END), 0) AS online_total
       FROM sales s ${w.toSql()}`,
    w.params,
  );
  return r;
}

/** Costo de lo vendido: unidades por lote × costo unitario del lote (ventas vigentes del período). */
async function costOfSales(conn, f) {
  const w = salesWhere(f);
  const [[r]] = await conn.execute(
    `SELECT COALESCE(SUM(sib.quantity * pb.unit_cost), 0) AS cost, COALESCE(SUM(sib.quantity), 0) AS units
       FROM sale_item_batches sib
       JOIN sale_items si ON si.id = sib.sale_item_id
       JOIN sales s ON s.id = si.sale_id
       JOIN product_batches pb ON pb.id = sib.batch_id
       ${w.toSql()}`,
    w.params,
  );
  return r;
}

/** Devoluciones completadas en el período: reembolsos y costo de lo reingresado al stock. */
async function returnsTotals(conn, f) {
  const w = branchScope(new WhereBuilder().add("sr.status = 'COMPLETED'").add('sr.completed_at >= ?', f.from).add('sr.completed_at < ? + INTERVAL 1 DAY', f.to), 's.branch_id', f);
  const [[r]] = await conn.execute(
    `SELECT COUNT(*) AS returns_count, COALESCE(SUM(sr.refund_amount), 0) AS refunded,
            COALESCE(SUM(sr.return_type = 'TOTAL'), 0) AS total_returns
       FROM sale_returns sr JOIN sales s ON s.id = sr.sale_id ${w.toSql()}`,
    w.params,
  );
  const [[c]] = await conn.execute(
    `SELECT COALESCE(SUM(CASE WHEN sri.restock THEN sri.quantity * pb.unit_cost END), 0) AS restocked_cost,
            COALESCE(SUM(sri.quantity), 0) AS units, COALESCE(SUM(CASE WHEN sri.restock THEN sri.quantity END), 0) AS restocked_units
       FROM sale_return_items sri
       JOIN sale_returns sr ON sr.id = sri.sale_return_id
       JOIN sales s ON s.id = sr.sale_id
       JOIN sale_item_batches sib ON sib.id = sri.sale_item_batch_id
       JOIN product_batches pb ON pb.id = sib.batch_id
       ${w.toSql()}`,
    w.params,
  );
  return { ...r, ...c };
}

async function voidsTotals(conn, f) {
  const w = branchScope(new WhereBuilder().add('sv.voided_at >= ?', f.from).add('sv.voided_at < ? + INTERVAL 1 DAY', f.to), 's.branch_id', f);
  const [[r]] = await conn.execute(
    `SELECT COUNT(*) AS voids_count, COALESCE(SUM(sv.sale_total_snapshot), 0) AS voided_amount,
            COALESCE(SUM(EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.status = 'REJECTED')), 0) AS rejected_payment_attempts
       FROM sale_voids sv JOIN sales s ON s.id = sv.sale_id ${w.toSql()}`,
    w.params,
  );
  return r;
}

const PERIOD_EXPR = {
  day: "DATE_FORMAT(s.sold_at, '%Y-%m-%d')",
  week: "DATE_FORMAT(DATE_SUB(DATE(s.sold_at), INTERVAL WEEKDAY(s.sold_at) DAY), '%Y-%m-%d')", // lunes de la semana
  month: "DATE_FORMAT(s.sold_at, '%Y-%m')",
};

async function salesSeries(conn, f, granularity) {
  const w = salesWhere(f);
  const expr = PERIOD_EXPR[granularity];
  const [rows] = await conn.execute(
    `SELECT ${expr} AS period, COUNT(*) AS transactions, SUM(s.subtotal) AS gross, SUM(s.discount_total) AS discounts, SUM(s.total) AS net_sales
       FROM sales s ${w.toSql()} GROUP BY period ORDER BY period`,
    w.params,
  );
  return rows;
}

async function topProducts(conn, f, { limit, orderBy }) {
  const w = salesWhere(f);
  w.addIf(f.categoryId, 'p.category_id = ?', f.categoryId);
  const order = orderBy === 'revenue' ? 'revenue DESC' : 'quantity DESC';
  const [rows] = await conn.execute(
    `SELECT si.product_id, p.sku, p.name, c.name AS category_name,
            SUM(si.quantity) AS quantity, SUM(si.line_total) AS revenue, SUM(si.discount_amount) AS discounts,
            COUNT(DISTINCT s.id) AS transactions
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       JOIN categories c ON c.id = p.category_id
       ${w.toSql()}
      GROUP BY si.product_id, p.sku, p.name, c.name
      ORDER BY ${order}, si.product_id LIMIT ?`,
    [...w.params, String(limit)],
  );
  return rows;
}

async function byCategory(conn, f) {
  const w = salesWhere(f);
  const [rows] = await conn.execute(
    `SELECT c.id AS category_id, c.name AS category_name, SUM(si.quantity) AS quantity, SUM(si.line_subtotal) AS gross,
            SUM(si.discount_amount) AS discounts, SUM(si.line_total) AS revenue, COUNT(DISTINCT s.id) AS transactions
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       JOIN categories c ON c.id = p.category_id
       ${w.toSql()}
      GROUP BY c.id, c.name ORDER BY revenue DESC`,
    w.params,
  );
  return rows;
}

async function byBranch(conn, f) {
  const w = salesWhere(f);
  const [rows] = await conn.execute(
    `SELECT s.branch_id, b.name AS branch_name, COUNT(*) AS transactions, SUM(s.subtotal) AS gross, SUM(s.discount_total) AS discounts,
            SUM(s.total) AS net_sales
       FROM sales s JOIN branches b ON b.id = s.branch_id ${w.toSql()}
      GROUP BY s.branch_id, b.name ORDER BY net_sales DESC`,
    w.params,
  );
  return rows;
}

async function bySeller(conn, f) {
  const w = salesWhere(f);
  const [rows] = await conn.execute(
    `SELECT s.seller_user_id, u.full_name AS seller_name, COUNT(*) AS transactions, SUM(s.total) AS net_sales,
            SUM(s.discount_total) AS discounts
       FROM sales s JOIN users u ON u.id = s.seller_user_id ${w.toSql()}
      GROUP BY s.seller_user_id, u.full_name ORDER BY net_sales DESC`,
    w.params,
  );
  return rows;
}

async function paymentMethods(conn, f) {
  const w = branchScope(new WhereBuilder().add('COALESCE(p.paid_at, p.created_at) >= ?', f.from).add('COALESCE(p.paid_at, p.created_at) < ? + INTERVAL 1 DAY', f.to), 'ph.branch_id', f);
  const [rows] = await conn.execute(
    `SELECT p.method, p.status, p.is_simulated, COUNT(*) AS count, SUM(p.amount) AS amount
       FROM payments p JOIN vw_payment_history ph ON ph.id = p.id ${w.toSql()}
      GROUP BY p.method, p.status, p.is_simulated ORDER BY p.method, p.status`,
    w.params,
  );
  const rw = branchScope(new WhereBuilder().add("sr.refund_status = 'REFUNDED'").add('sr.completed_at >= ?', f.from).add('sr.completed_at < ? + INTERVAL 1 DAY', f.to), 's.branch_id', f);
  const [refunds] = await conn.execute(
    `SELECT sr.refund_method AS method, COUNT(*) AS count, SUM(sr.refund_amount) AS amount
       FROM sale_returns sr JOIN sales s ON s.id = sr.sale_id ${rw.toSql()} GROUP BY sr.refund_method`,
    rw.params,
  );
  return { rows, refunds };
}

// ------------------------------------------------------------------ inventario
async function inventoryValuation(conn, f) {
  const w = branchScope(new WhereBuilder().add('pb.current_quantity > 0'), 'pb.branch_id', f);
  w.addIf(f.categoryId, 'p.category_id = ?', f.categoryId);
  const [rows] = await conn.execute(
    `SELECT c.id AS category_id, c.name AS category_name,
            COUNT(DISTINCT pb.product_id) AS products, COUNT(*) AS batches, SUM(pb.current_quantity) AS units,
            SUM(pb.current_quantity * pb.unit_cost) AS cost_value,
            SUM(CASE WHEN pb.status = 'ACTIVE' AND pb.expiry_date > CURDATE() THEN pb.current_quantity * pb.unit_cost ELSE 0 END) AS sellable_cost,
            SUM(CASE WHEN pb.expiry_date <= CURDATE() THEN pb.current_quantity * pb.unit_cost ELSE 0 END) AS expired_cost,
            SUM(CASE WHEN pb.status IN ('QUARANTINE','RECALLED') AND pb.expiry_date > CURDATE() THEN pb.current_quantity * pb.unit_cost ELSE 0 END) AS blocked_cost,
            SUM(CASE WHEN pb.status = 'ACTIVE' AND pb.expiry_date > CURDATE() THEN pb.current_quantity * COALESCE(bp.sale_price, p.sale_price) ELSE 0 END) AS sellable_retail
       FROM product_batches pb
       JOIN products p ON p.id = pb.product_id
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN branch_products bp ON bp.branch_id = pb.branch_id AND bp.product_id = pb.product_id
       ${w.toSql()}
      GROUP BY c.id, c.name ORDER BY cost_value DESC`,
    w.params,
  );
  return rows;
}

async function lowStock(conn, f) {
  const w = branchScope(new WhereBuilder(), 'branch_id', f);
  const [rows] = await conn.execute(
    `SELECT branch_id, branch_name, id AS product_id, sku, name, category_name, current_stock, minimum_stock, units_to_minimum, stock_status
       FROM vw_products_low_stock ${w.toSql()} ORDER BY stock_status DESC, units_to_minimum DESC LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM vw_products_low_stock ${w.toSql()}`, w.params);
  return { rows, total };
}

async function expiringBatches(conn, f, days) {
  const w = branchScope(new WhereBuilder().add('pb.current_quantity > 0').add('pb.expiry_date <= CURDATE() + INTERVAL ? DAY', days), 'pb.branch_id', f);
  const [rows] = await conn.execute(
    `SELECT pb.id AS batch_id, pb.branch_id, b.name AS branch_name, pb.product_id, p.sku, p.name AS product_name, pb.batch_number,
            pb.expiry_date, DATEDIFF(pb.expiry_date, CURDATE()) AS days_to_expiry, pb.current_quantity,
            pb.current_quantity * pb.unit_cost AS cost_value, (pb.expiry_date <= CURDATE()) AS is_expired
       FROM product_batches pb JOIN products p ON p.id = pb.product_id JOIN branches b ON b.id = pb.branch_id
       ${w.toSql()} ORDER BY pb.expiry_date, pb.id LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[t]] = await conn.execute(
    `SELECT COUNT(*) AS total, COALESCE(SUM(pb.expiry_date <= CURDATE()), 0) AS expired,
            COALESCE(SUM(CASE WHEN pb.expiry_date <= CURDATE() THEN pb.current_quantity * pb.unit_cost END), 0) AS expired_cost,
            COALESCE(SUM(CASE WHEN pb.expiry_date > CURDATE() THEN pb.current_quantity * pb.unit_cost END), 0) AS expiring_cost
       FROM product_batches pb ${w.toSql()}`,
    w.params,
  );
  return { rows, summary: t };
}

async function inventoryMovements(conn, f) {
  const w = branchScope(new WhereBuilder().add('im.created_at >= ?', f.from).add('im.created_at < ? + INTERVAL 1 DAY', f.to), 'im.branch_id', f);
  w.addIf(f.productId, 'im.product_id = ?', f.productId);
  const [rows] = await conn.execute(
    `SELECT im.movement_type, im.direction, COUNT(*) AS movements, SUM(im.quantity) AS units, SUM(im.quantity * pb.unit_cost) AS cost_value
       FROM inventory_movements im JOIN product_batches pb ON pb.id = im.batch_id
       ${w.toSql()} GROUP BY im.movement_type, im.direction ORDER BY im.direction, im.movement_type`,
    w.params,
  );
  return rows;
}

// ---------------------------------------------------------- devoluciones/pedidos/caja
async function returnsBreakdown(conn, f) {
  const w = branchScope(new WhereBuilder().add('sr.requested_at >= ?', f.from).add('sr.requested_at < ? + INTERVAL 1 DAY', f.to), 's.branch_id', f);
  const [byStatus] = await conn.execute(
    `SELECT sr.status, COUNT(*) AS count, SUM(sr.refund_amount) AS refund_amount FROM sale_returns sr JOIN sales s ON s.id = sr.sale_id
      ${w.toSql()} GROUP BY sr.status`,
    w.params,
  );
  const [byReason] = await conn.execute(
    `SELECT rr.code, rr.name, COUNT(*) AS count FROM sale_returns sr JOIN sales s ON s.id = sr.sale_id JOIN return_reasons rr ON rr.id = sr.reason_id
      ${w.toSql()} GROUP BY rr.code, rr.name ORDER BY count DESC`,
    w.params,
  );
  const [byCondition] = await conn.execute(
    `SELECT sri.item_condition, SUM(sri.quantity) AS units FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.sale_return_id
       JOIN sales s ON s.id = sr.sale_id ${w.toSql()} AND sr.status <> 'REJECTED' GROUP BY sri.item_condition`,
    w.params,
  );
  return { byStatus, byReason, byCondition };
}

async function ordersBreakdown(conn, f) {
  const w = branchScope(new WhereBuilder().add('o.created_at >= ?', f.from).add('o.created_at < ? + INTERVAL 1 DAY', f.to), 'o.branch_id', f);
  const [byStatus] = await conn.execute(
    `SELECT o.status, o.fulfillment_type, COUNT(*) AS count, SUM(o.total) AS total FROM orders o ${w.toSql()}
      GROUP BY o.status, o.fulfillment_type ORDER BY o.status`,
    w.params,
  );
  const [[t]] = await conn.execute(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(o.status = 'COMPLETED'), 0) AS completed,
            COALESCE(SUM(o.status IN ('CANCELLED','REJECTED')), 0) AS cancelled_or_rejected,
            COALESCE(SUM(CASE WHEN o.status = 'COMPLETED' THEN o.total END), 0) AS completed_total,
            COALESCE(AVG(CASE WHEN o.status = 'COMPLETED' THEN o.total END), 0) AS average_completed
       FROM orders o ${w.toSql()}`,
    w.params,
  );
  return { byStatus, totals: t };
}

async function cashBreakdown(conn, f) {
  const w = branchScope(new WhereBuilder().add('v.opened_at >= ?', f.from).add('v.opened_at < ? + INTERVAL 1 DAY', f.to), 'v.branch_id', f);
  const [sessions] = await conn.execute(
    `SELECT v.cash_session_id, v.session_number, v.branch_id, v.register_code, v.status, v.opened_by_name, v.opened_at, v.closed_at,
            v.opening_amount, v.total_in, v.total_out, v.current_expected_amount, v.closing_expected_amount, v.counted_amount, v.difference_amount
       FROM vw_cash_session_summary v ${w.toSql()} ORDER BY v.opened_at DESC LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[t]] = await conn.execute(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(v.status = 'OPEN'), 0) AS open_sessions,
            COALESCE(SUM(v.closing_expected_amount), 0) AS expected_closed, COALESCE(SUM(v.counted_amount), 0) AS counted,
            COALESCE(SUM(v.difference_amount), 0) AS difference
       FROM vw_cash_session_summary v ${w.toSql()}`,
    w.params,
  );
  const mw = branchScope(new WhereBuilder().add('cm.created_at >= ?', f.from).add('cm.created_at < ? + INTERVAL 1 DAY', f.to), 'cr.branch_id', f);
  const [movements] = await conn.execute(
    `SELECT cm.movement_type, cm.direction, COUNT(*) AS count, SUM(cm.amount) AS amount
       FROM cash_movements cm JOIN cash_sessions cs ON cs.id = cm.cash_session_id JOIN cash_registers cr ON cr.id = cs.cash_register_id
       ${mw.toSql()} GROUP BY cm.movement_type, cm.direction`,
    mw.params,
  );
  return { sessions, totals: t, movements };
}

async function activity(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.from, 'a.created_at >= ?', f.from)
    .addIf(f.to, 'a.created_at < ? + INTERVAL 1 DAY', f.to)
    .addIf(f.module, 'a.module = ?', f.module)
    .addIf(f.action, 'a.action = ?', f.action)
    .addIf(f.userId, 'a.user_id = ?', f.userId)
    .addIf(f.entityTable, 'a.entity_table = ?', f.entityTable);
  branchScope(w, 'a.branch_id', f);
  const [rows] = await conn.execute(
    `SELECT a.id, a.created_at, a.action, a.module, a.entity_table, a.entity_id, a.user_id, u.full_name AS user_name,
            a.branch_id, a.request_id, a.new_values
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${w.toSql()} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM audit_logs a ${w.toSql()}`, w.params);
  return { rows, total };
}

async function dashboardCounters(conn, f) {
  const scope = (col) => branchScope(new WhereBuilder(), col, f);
  const a = scope('sa.branch_id').add("sa.status = 'OPEN'");
  const [alerts] = await conn.execute(`SELECT sa.alert_type, COUNT(*) AS count FROM stock_alerts sa ${a.toSql()} GROUP BY sa.alert_type`, a.params);
  const o = scope('o.branch_id').add("o.status IN ('PENDING','CONFIRMED','PREPARING','READY_FOR_PICKUP','OUT_FOR_DELIVERY')");
  const [orders] = await conn.execute(`SELECT o.status, COUNT(*) AS count FROM orders o ${o.toSql()} GROUP BY o.status`, o.params);
  const c = scope('cr.branch_id').add("cs.status = 'OPEN'");
  const [[cash]] = await conn.execute(
    `SELECT COUNT(*) AS open_sessions FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id ${c.toSql()}`, c.params);
  return { alerts, orders, cash };
}

module.exports = {
  salesTotals, costOfSales, returnsTotals, voidsTotals, salesSeries, topProducts, byCategory, byBranch, bySeller, paymentMethods,
  inventoryValuation, lowStock, expiringBatches, inventoryMovements, returnsBreakdown, ordersBreakdown, cashBreakdown, activity,
  dashboardCounters,
};
