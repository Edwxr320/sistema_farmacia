'use strict';

/**
 * Entradas de mercadería. Flujo oficial de la base (README_DATABASE §8.3):
 *   stock_entries (DRAFT) → product_batches (existencia 0) → stock_entry_items
 *   → inventory_movements PURCHASE_ENTRY por línea → UPDATE stock_entries SET status = 'POSTED'.
 * Los triggers validan, bloquean el lote, calculan stock anterior/posterior y actualizan
 * product_batches. Este módulo NUNCA escribe current_quantity ni received_quantity.
 */

const { WhereBuilder, pageParams, likeContains } = require('../utils/query');
const documentSequence = require('./document-sequence.repository');

/** Número de documento seguro ante concurrencia. Debe ejecutarse dentro de la transacción. */
const nextEntryNumber = (conn, branchId) => documentSequence.nextNumber(conn, branchId, 'STOCK_ENTRY');

async function insertEntry(conn, e) {
  const [res] = await conn.execute(
    `INSERT INTO stock_entries (entry_number, branch_id, supplier_id, entry_type, reference_document_type,
                                reference_document_number, status, registered_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
    [e.entryNumber, e.branchId, e.supplierId ?? null, e.entryType, e.referenceDocumentType ?? null,
      e.referenceDocumentNumber ?? null, e.registeredBy, e.notes ?? null],
  );
  return res.insertId;
}

const HEADER_COLUMNS = { supplierId: 'supplier_id', entryType: 'entry_type', referenceDocumentType: 'reference_document_type',
  referenceDocumentNumber: 'reference_document_number', notes: 'notes' };

async function updateHeader(conn, id, data) {
  const keys = Object.keys(HEADER_COLUMNS).filter((k) => data[k] !== undefined);
  if (keys.length === 0) return 0;
  const [res] = await conn.execute(
    `UPDATE stock_entries SET ${keys.map((k) => `${HEADER_COLUMNS[k]} = ?`).join(', ')} WHERE id = ? AND status = 'DRAFT'`,
    [...keys.map((k) => data[k]), id],
  );
  return res.affectedRows;
}

const ENTRY_SELECT = `
  SELECT se.*, b.code AS branch_code, b.name AS branch_name, s.business_name AS supplier_name, s.ruc AS supplier_ruc,
         u.full_name AS registered_by_name,
         (SELECT COUNT(*) FROM stock_entry_items i WHERE i.stock_entry_id = se.id) AS items_count,
         (SELECT COALESCE(SUM(i.quantity), 0) FROM stock_entry_items i WHERE i.stock_entry_id = se.id) AS units_count,
         (SELECT COALESCE(SUM(i.line_total), 0) FROM stock_entry_items i WHERE i.stock_entry_id = se.id) AS items_total
    FROM stock_entries se
    JOIN branches b ON b.id = se.branch_id
    LEFT JOIN suppliers s ON s.id = se.supplier_id
    JOIN users u ON u.id = se.registered_by`;

async function findById(conn, id) {
  const [rows] = await conn.execute(`${ENTRY_SELECT} WHERE se.id = ?`, [id]);
  return rows[0] || null;
}

/** Bloquea la cabecera: serializa contabilizaciones y ediciones simultáneas de la misma entrada. */
async function lockById(conn, id) {
  const [rows] = await conn.execute('SELECT id, branch_id, status, supplier_id, entry_type FROM stock_entries WHERE id = ? FOR UPDATE', [id]);
  return rows[0] || null;
}

async function findByDocument(conn, supplierId, docType, docNumber) {
  if (!supplierId || !docType || !docNumber) return null;
  const [rows] = await conn.execute(
    `SELECT id, entry_number, status FROM stock_entries
      WHERE supplier_id = ? AND reference_document_type = ? AND reference_document_number = ?`,
    [supplierId, docType, docNumber],
  );
  return rows[0] || null;
}

async function list(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.branchId, 'se.branch_id = ?', f.branchId)
    .addIf(f.supplierId, 'se.supplier_id = ?', f.supplierId)
    .addIf(f.status, 'se.status = ?', f.status)
    .addIf(f.entryType, 'se.entry_type = ?', f.entryType)
    .addIf(f.q, '(se.entry_number LIKE ? OR se.reference_document_number LIKE ?)', likeContains(f.q), likeContains(f.q))
    .addIf(f.from, 'se.received_at >= ?', f.from)
    .addIf(f.to, 'se.received_at < ? + INTERVAL 1 DAY', f.to);
  if (f.branchIds) w.add(`se.branch_id IN (${f.branchIds.map(() => '?').join(', ') || 'NULL'})`, ...f.branchIds);
  const [rows] = await conn.execute(`${ENTRY_SELECT} ${w.toSql()} ORDER BY se.received_at DESC, se.id DESC LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM stock_entries se ${w.toSql()}`, w.params);
  return { rows, total };
}

async function findItems(conn, entryId) {
  const [rows] = await conn.execute(
    `SELECT i.id, i.product_id, p.sku, p.name AS product_name, i.batch_id, pb.batch_number, pb.manufacturing_date,
            pb.expiry_date, i.quantity, i.unit_cost, i.line_total, pb.current_quantity AS batch_current_quantity,
            (pb.expiry_date <= CURDATE()) AS is_expired,
            (SELECT im.id FROM inventory_movements im WHERE im.stock_entry_item_id = i.id) AS movement_id
       FROM stock_entry_items i
       JOIN products p ON p.id = i.product_id
       JOIN product_batches pb ON pb.id = i.batch_id
      WHERE i.stock_entry_id = ?
      ORDER BY i.id`,
    [entryId],
  );
  return rows;
}

async function findBatch(conn, branchId, productId, batchNumber) {
  const [rows] = await conn.execute(
    `SELECT id, expiry_date, manufacturing_date, status, stock_entry_id FROM product_batches
      WHERE branch_id = ? AND product_id = ? AND batch_number = ? FOR UPDATE`,
    [branchId, productId, batchNumber],
  );
  return rows[0] || null;
}

/** Crea el lote VACÍO (el trigger exige existencia 0; el stock entra con el movimiento). */
async function insertBatch(conn, b) {
  const [res] = await conn.execute(
    `INSERT INTO product_batches (product_id, branch_id, batch_number, manufacturing_date, expiry_date, unit_cost, stock_entry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [b.productId, b.branchId, b.batchNumber, b.manufacturingDate ?? null, b.expiryDate, b.unitCost, b.stockEntryId],
  );
  return res.insertId;
}

/** line_total lo calcula el trigger trg_stock_entry_items_bi (quantity * unit_cost en DECIMAL). */
async function insertItem(conn, { entryId, productId, batchId, quantity, unitCost }) {
  const [res] = await conn.execute(
    'INSERT INTO stock_entry_items (stock_entry_id, product_id, batch_id, quantity, unit_cost) VALUES (?, ?, ?, ?, ?)',
    [entryId, productId, batchId, quantity, unitCost],
  );
  return res.insertId;
}

/** Elimina las líneas de un DRAFT y los lotes vacíos que solo esa entrada había creado. */
async function deleteDraftItems(conn, entryId) {
  const [items] = await conn.execute('SELECT batch_id FROM stock_entry_items WHERE stock_entry_id = ?', [entryId]);
  await conn.execute('DELETE FROM stock_entry_items WHERE stock_entry_id = ?', [entryId]);
  const batchIds = items.map((i) => i.batch_id);
  if (batchIds.length === 0) return;
  await conn.execute(
    `DELETE FROM product_batches
      WHERE id IN (${batchIds.map(() => '?').join(', ')})
        AND stock_entry_id = ? AND current_quantity = 0 AND received_quantity = 0
        AND NOT EXISTS (SELECT 1 FROM inventory_movements im WHERE im.batch_id = product_batches.id)
        AND NOT EXISTS (SELECT 1 FROM stock_entry_items i WHERE i.batch_id = product_batches.id)
        AND NOT EXISTS (SELECT 1 FROM stock_alerts sa WHERE sa.batch_id = product_batches.id)`,
    [...batchIds, entryId],
  );
}

/** Bloquea los lotes de la entrada en orden de id (orden estable: evita interbloqueos). */
async function lockEntryBatches(conn, entryId) {
  const [rows] = await conn.execute(
    `SELECT pb.id, pb.expiry_date, pb.status, (pb.expiry_date <= CURDATE()) AS is_expired
       FROM product_batches pb
      WHERE pb.id IN (SELECT batch_id FROM stock_entry_items WHERE stock_entry_id = ?)
      ORDER BY pb.id FOR UPDATE`,
    [entryId],
  );
  return rows;
}

/**
 * Movimiento PURCHASE_ENTRY. Igual que el flujo de referencia de la base: el trigger
 * completa sucursal, producto, stock anterior/posterior y actualiza el lote.
 */
async function insertPurchaseMovement(conn, { batchId, quantity, itemId, performedBy, reason }) {
  const [res] = await conn.execute(
    `INSERT INTO inventory_movements (batch_id, movement_type, quantity, stock_entry_item_id, performed_by, reason)
     VALUES (?, 'PURCHASE_ENTRY', ?, ?, ?, ?)`,
    [batchId, quantity, itemId, performedBy, reason],
  );
  return res.insertId;
}

/** El trigger trg_stock_entries_bu exige un movimiento por línea y calcula total_cost y posted_at. */
async function markPosted(conn, id) {
  const [res] = await conn.execute("UPDATE stock_entries SET status = 'POSTED' WHERE id = ? AND status = 'DRAFT'", [id]);
  return res.affectedRows;
}

async function markCancelled(conn, id, notes) {
  const [res] = await conn.execute(
    "UPDATE stock_entries SET status = 'CANCELLED', notes = COALESCE(?, notes) WHERE id = ? AND status = 'DRAFT'",
    [notes ?? null, id],
  );
  return res.affectedRows;
}

/** ¿Algún lote de la entrada vence dentro de la ventana de alerta configurada? */
async function hasBatchesInExpiryWindow(conn, entryId) {
  const [[row]] = await conn.execute(
    `SELECT EXISTS (
        SELECT 1 FROM stock_entry_items i JOIN product_batches pb ON pb.id = i.batch_id
         WHERE i.stock_entry_id = ?
           AND pb.expiry_date <= CURDATE() + INTERVAL COALESCE((SELECT CAST(setting_value AS SIGNED) FROM settings
                                  WHERE setting_key = 'inventory.expiry_alert_days'), 90) DAY) AS in_window`,
    [entryId],
  );
  return Boolean(Number(row.in_window));
}

module.exports = {
  nextEntryNumber, insertEntry, updateHeader, findById, lockById, findByDocument, list, findItems, findBatch,
  insertBatch, insertItem, deleteDraftItems, lockEntryBatches, insertPurchaseMovement, markPosted, markCancelled,
  hasBatchesInExpiryWindow,
};
