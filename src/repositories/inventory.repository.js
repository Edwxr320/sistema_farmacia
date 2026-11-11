'use strict';

/**
 * Consultas de inventario. Solo LECTURA y bloqueo de lotes:
 * este módulo nunca modifica current_quantity ni received_quantity.
 * El stock cambia exclusivamente con INSERT en inventory_movements (ver stock-entry.repository).
 */

const { likeContains, WhereBuilder, pageParams } = require('../utils/query');

function inList(column, ids) {
  return { clause: `${column} IN (${ids.map(() => '?').join(', ') || 'NULL'})`, params: ids };
}

// ------------------------------------------------------------------ stock
async function listStock(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 's.branch_id = ?', f.branchId)
    .addIf(f.productId, 's.product_id = ?', f.productId)
    .addIf(f.q, '(s.product_name LIKE ? OR s.sku LIKE ?)', likeContains(f.q), likeContains(f.q))
    .addIf(f.stockStatus, 's.stock_status = ?', f.stockStatus)
    .addIf(f.productStatus, 's.product_status = ?', f.productStatus)
    .addIf(f.categoryId, 'p.category_id = ?', f.categoryId)
    .addIf(f.onlyAvailable, 's.available_stock > 0');
  if (f.branchIds) {
    const { clause, params } = inList('s.branch_id', f.branchIds);
    w.add(clause, ...params);
  }
  const from = `FROM vw_branch_product_stock s
                JOIN products p ON p.id = s.product_id
                LEFT JOIN branch_products bp ON bp.branch_id = s.branch_id AND bp.product_id = s.product_id`;
  const [rows] = await conn.execute(
    `SELECT s.*, bp.maximum_stock, bp.shelf_location, p.category_id, p.barcode
       ${from} ${w.toSql()}
      ORDER BY s.product_name, s.branch_id LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total ${from} ${w.toSql()}`, w.params);
  return { rows, total };
}

async function listLowStock(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 'branch_id = ?', f.branchId)
    .addIf(f.stockStatus, 'stock_status = ?', f.stockStatus);
  if (f.branchIds) {
    const { clause, params } = inList('branch_id', f.branchIds);
    w.add(clause, ...params);
  }
  const [rows] = await conn.execute(
    `SELECT * FROM vw_products_low_stock ${w.toSql()} ORDER BY units_to_minimum DESC, name LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM vw_products_low_stock ${w.toSql()}`, w.params);
  return { rows, total };
}

// ------------------------------------------------------------------ lotes
const BATCH_SELECT = `
  SELECT pb.id, pb.branch_id, b.name AS branch_name, pb.product_id, p.sku, p.name AS product_name,
         pb.batch_number, pb.manufacturing_date, pb.expiry_date, pb.received_quantity, pb.current_quantity,
         pb.unit_cost, pb.status, pb.stock_entry_id, se.entry_number, pb.created_at,
         DATEDIFF(pb.expiry_date, CURDATE()) AS days_to_expiry,
         CASE
           WHEN pb.expiry_date <= CURDATE() THEN 'EXPIRED'
           WHEN DATEDIFF(pb.expiry_date, CURDATE()) <= COALESCE((SELECT CAST(setting_value AS SIGNED) FROM settings
                 WHERE setting_key = 'inventory.expiry_critical_days'), 30) THEN 'CRITICAL'
           WHEN DATEDIFF(pb.expiry_date, CURDATE()) <= COALESCE((SELECT CAST(setting_value AS SIGNED) FROM settings
                 WHERE setting_key = 'inventory.expiry_alert_days'), 90) THEN 'WARNING'
           ELSE 'OK'
         END AS expiry_status,
         (pb.status = 'ACTIVE' AND pb.current_quantity > 0 AND pb.expiry_date > CURDATE()) AS is_sellable
    FROM product_batches pb
    JOIN branches b ON b.id = pb.branch_id
    JOIN products p ON p.id = pb.product_id
    LEFT JOIN stock_entries se ON se.id = pb.stock_entry_id`;

async function listBatches(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 'pb.branch_id = ?', f.branchId)
    .addIf(f.productId, 'pb.product_id = ?', f.productId)
    .addIf(f.status, 'pb.status = ?', f.status)
    .addIf(f.batchNumber, 'pb.batch_number = ?', f.batchNumber)
    .addIf(f.withStock, 'pb.current_quantity > 0')
    .addIf(f.expiringWithinDays !== undefined, 'pb.expiry_date <= CURDATE() + INTERVAL ? DAY', f.expiringWithinDays)
    .addIf(f.expired === true, 'pb.expiry_date <= CURDATE()')
    .addIf(f.expired === false, 'pb.expiry_date > CURDATE()');
  if (f.branchIds) {
    const { clause, params } = inList('pb.branch_id', f.branchIds);
    w.add(clause, ...params);
  }
  const [rows] = await conn.execute(
    `${BATCH_SELECT} ${w.toSql()} ORDER BY pb.expiry_date ASC, pb.id ASC LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM product_batches pb ${w.toSql()}`, w.params);
  return { rows, total };
}

async function findBatchById(conn, id) {
  const [rows] = await conn.execute(`${BATCH_SELECT} WHERE pb.id = ?`, [id]);
  return rows[0] || null;
}

// ------------------------------------------------------------------- FEFO
/** Lotes vendibles en orden FEFO (vista vw_fefo_batches), sin bloqueo. */
async function listFefo(conn, branchId, productId) {
  const [rows] = await conn.execute(
    'SELECT * FROM vw_fefo_batches WHERE branch_id = ? AND product_id = ? ORDER BY fefo_rank',
    [branchId, productId],
  );
  return rows;
}

/**
 * Bloquea (FOR UPDATE) los lotes vendibles del producto en la sucursal, en orden FEFO.
 * Debe llamarse DENTRO de una transacción: los lotes quedan bloqueados hasta COMMIT/ROLLBACK,
 * lo que impide que dos ventas simultáneas consuman las mismas unidades.
 */
async function lockFefoBatches(conn, branchId, productId) {
  const [rows] = await conn.execute(
    `SELECT id AS batch_id, batch_number, expiry_date, current_quantity, unit_cost
       FROM product_batches
      WHERE branch_id = ? AND product_id = ? AND status = 'ACTIVE'
        AND current_quantity > 0 AND expiry_date > CURDATE()
      ORDER BY expiry_date ASC, id ASC
      FOR UPDATE`,
    [branchId, productId],
  );
  return rows;
}

// ------------------------------------------------------------- movimientos
async function listMovements(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 'k.branch_id = ?', f.branchId)
    .addIf(f.productId, 'k.product_id = ?', f.productId)
    .addIf(f.batchId, 'k.batch_id = ?', f.batchId)
    .addIf(f.movementType, 'k.movement_type = ?', f.movementType)
    .addIf(f.direction, 'k.direction = ?', f.direction)
    .addIf(f.from, 'k.created_at >= ?', f.from)
    .addIf(f.to, 'k.created_at < ? + INTERVAL 1 DAY', f.to);
  if (f.branchIds) {
    const { clause, params } = inList('k.branch_id', f.branchIds);
    w.add(clause, ...params);
  }
  const [rows] = await conn.execute(
    `SELECT k.* FROM vw_kardex k ${w.toSql()} ORDER BY k.created_at DESC, k.id DESC LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM vw_kardex k ${w.toSql()}`, w.params);
  return { rows, total };
}

/** Stock por sucursal de un producto (para el detalle del producto). */
async function stockByProduct(conn, productId, branchIds = null) {
  const w = new WhereBuilder().add('product_id = ?', productId);
  if (branchIds) {
    const { clause, params } = inList('branch_id', branchIds);
    w.add(clause, ...params);
  }
  const [rows] = await conn.execute(`SELECT * FROM vw_branch_product_stock ${w.toSql()} ORDER BY branch_id`, w.params);
  return rows;
}

module.exports = {
  listStock, listLowStock, listBatches, findBatchById, listFefo, lockFefoBatches, listMovements, stockByProduct,
};
