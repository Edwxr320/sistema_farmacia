'use strict';

/**
 * Transferencias: branch_transfers (DRAFT → IN_TRANSIT → RECEIVED | DRAFT → CANCELLED)
 * y branch_transfer_items. El stock solo cambia con TRANSFER_OUT (despacho, en DRAFT) y
 * TRANSFER_IN (recepción, en IN_TRANSIT), validados por los triggers.
 */

const { WhereBuilder, pageParams, likeContains } = require('../utils/query');

async function insertTransfer(conn, t) {
  const [res] = await conn.execute(
    `INSERT INTO branch_transfers (transfer_number, origin_branch_id, destination_branch_id, status, requested_by, notes)
     VALUES (?, ?, ?, 'DRAFT', ?, ?)`,
    [t.number, t.originBranchId, t.destinationBranchId, t.requestedBy, t.notes ?? null],
  );
  return res.insertId;
}

async function insertItem(conn, { transferId, productId, batchId, quantity }) {
  const [res] = await conn.execute(
    'INSERT INTO branch_transfer_items (transfer_id, product_id, origin_batch_id, quantity) VALUES (?, ?, ?, ?)',
    [transferId, productId, batchId, quantity],
  );
  return res.insertId;
}

async function deleteItems(conn, transferId) {
  await conn.execute('DELETE FROM branch_transfer_items WHERE transfer_id = ?', [transferId]);
}

async function deleteItem(conn, itemId) {
  await conn.execute('DELETE FROM branch_transfer_items WHERE id = ?', [itemId]);
}

async function updateItemQuantity(conn, itemId, quantity) {
  await conn.execute('UPDATE branch_transfer_items SET quantity = ? WHERE id = ?', [quantity, itemId]);
}

async function lockById(conn, id) {
  const [rows] = await conn.execute(
    'SELECT id, transfer_number, origin_branch_id, destination_branch_id, status FROM branch_transfers WHERE id = ? FOR UPDATE',
    [id],
  );
  return rows[0] || null;
}

/** Lotes de origen bloqueados (orden estable por id) con su estado real. */
async function lockBatches(conn, batchIds) {
  const [rows] = await conn.execute(
    `SELECT id, product_id, branch_id, batch_number, expiry_date, manufacturing_date, unit_cost, current_quantity, status,
            (expiry_date <= CURDATE()) AS is_expired
       FROM product_batches WHERE id IN (${batchIds.map(() => '?').join(', ')}) ORDER BY id FOR UPDATE`,
    batchIds,
  );
  return rows;
}

async function insertMovement(conn, { batchId, movementType, quantity, transferItemId, performedBy, reason }) {
  const [res] = await conn.execute(
    `INSERT INTO inventory_movements (batch_id, movement_type, quantity, transfer_item_id, performed_by, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [batchId, movementType, quantity, transferItemId, performedBy, reason],
  );
  return res.insertId;
}

async function setStatus(conn, id, fromStatus, status) {
  const [res] = await conn.execute('UPDATE branch_transfers SET status = ? WHERE id = ? AND status = ?', [status, id, fromStatus]);
  return res.affectedRows;
}

async function appendNotes(conn, id, text) {
  await conn.execute(
    "UPDATE branch_transfers SET notes = LEFT(CONCAT_WS(' | ', NULLIF(notes, ''), ?), 500) WHERE id = ?",
    [text, id],
  );
}

/** Lote destino = mismo número y vencimiento en la sucursal destino (lo exige el trigger). */
async function findOrCreateDestinationBatch(conn, origin, destinationBranchId) {
  const [rows] = await conn.execute(
    'SELECT id, expiry_date FROM product_batches WHERE branch_id = ? AND product_id = ? AND batch_number = ? FOR UPDATE',
    [destinationBranchId, origin.product_id, origin.batch_number],
  );
  if (rows[0]) return { id: rows[0].id, expiryDate: rows[0].expiry_date };
  const [res] = await conn.execute(
    `INSERT INTO product_batches (product_id, branch_id, batch_number, manufacturing_date, expiry_date, unit_cost, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'Creado por transferencia')`,
    [origin.product_id, destinationBranchId, origin.batch_number, origin.manufacturing_date, origin.expiry_date, origin.unit_cost],
  );
  return { id: res.insertId, expiryDate: origin.expiry_date };
}

async function registerReception(conn, itemId, { destinationBatchId, receivedQuantity, note }) {
  await conn.execute(
    'UPDATE branch_transfer_items SET destination_batch_id = ?, received_quantity = ?, discrepancy_note = ? WHERE id = ?',
    [destinationBatchId, receivedQuantity, note, itemId],
  );
}

const SELECT = `
  SELECT t.*, ob.name AS origin_branch_name, db.name AS destination_branch_name,
         ru.full_name AS requested_by_name, du.full_name AS dispatched_by_name, rcu.full_name AS received_by_name,
         cu.full_name AS cancelled_by_name,
         (SELECT COUNT(*) FROM branch_transfer_items i WHERE i.transfer_id = t.id) AS items_count,
         (SELECT COUNT(*) FROM branch_transfer_items i WHERE i.transfer_id = t.id AND i.received_quantity IS NOT NULL) AS received_items,
         (SELECT COUNT(*) FROM branch_transfer_items i WHERE i.transfer_id = t.id AND i.discrepancy_note IS NOT NULL) AS discrepancy_items,
         (SELECT COALESCE(SUM(i.quantity), 0) FROM branch_transfer_items i WHERE i.transfer_id = t.id) AS units,
         (SELECT a.created_at FROM audit_logs a WHERE a.entity_table = 'branch_transfers' AND a.entity_id = CAST(t.id AS CHAR)
             AND a.action = 'APPROVE' ORDER BY a.id DESC LIMIT 1) AS approved_at,
         (SELECT a.user_id FROM audit_logs a WHERE a.entity_table = 'branch_transfers' AND a.entity_id = CAST(t.id AS CHAR)
             AND a.action = 'APPROVE' ORDER BY a.id DESC LIMIT 1) AS approved_by
    FROM branch_transfers t
    JOIN branches ob ON ob.id = t.origin_branch_id
    JOIN branches db ON db.id = t.destination_branch_id
    JOIN users ru ON ru.id = t.requested_by
    LEFT JOIN users du ON du.id = t.dispatched_by
    LEFT JOIN users rcu ON rcu.id = t.received_by
    LEFT JOIN users cu ON cu.id = t.cancelled_by`;

async function findById(conn, id) {
  const [rows] = await conn.execute(`${SELECT} WHERE t.id = ?`, [id]);
  return rows[0] || null;
}

async function findItems(conn, transferId) {
  const [rows] = await conn.execute(
    `SELECT i.*, p.sku, p.name AS product_name, ob.batch_number, ob.expiry_date, ob.current_quantity AS origin_batch_stock,
            (SELECT im.id FROM inventory_movements im WHERE im.transfer_item_id = i.id AND im.movement_type = 'TRANSFER_OUT') AS out_movement_id,
            (SELECT im.id FROM inventory_movements im WHERE im.transfer_item_id = i.id AND im.movement_type = 'TRANSFER_IN') AS in_movement_id
       FROM branch_transfer_items i
       JOIN products p ON p.id = i.product_id
       JOIN product_batches ob ON ob.id = i.origin_batch_id
      WHERE i.transfer_id = ? ORDER BY i.id`,
    [transferId],
  );
  return rows;
}

async function hasApproval(conn, id) {
  const [rows] = await conn.execute(
    "SELECT 1 FROM audit_logs WHERE entity_table = 'branch_transfers' AND entity_id = ? AND action = 'APPROVE' LIMIT 1",
    [String(id)],
  );
  return rows.length > 0;
}

async function list(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.status, 't.status = ?', f.status)
    .addIf(f.q, 't.transfer_number LIKE ?', likeContains(f.q))
    .addIf(f.from, 't.requested_at >= ?', f.from)
    .addIf(f.to, 't.requested_at < ? + INTERVAL 1 DAY', f.to);
  if (f.branchId) {
    if (f.direction === 'OUTGOING') w.add('t.origin_branch_id = ?', f.branchId);
    else if (f.direction === 'INCOMING') w.add('t.destination_branch_id = ?', f.branchId);
    else w.add('(t.origin_branch_id = ? OR t.destination_branch_id = ?)', f.branchId, f.branchId);
  }
  if (f.branchIds) {
    const ph = f.branchIds.map(() => '?').join(', ') || 'NULL';
    w.add(`(t.origin_branch_id IN (${ph}) OR t.destination_branch_id IN (${ph}))`, ...f.branchIds, ...f.branchIds);
  }
  const [rows] = await conn.execute(`${SELECT} ${w.toSql()} ORDER BY t.requested_at DESC, t.id DESC LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM branch_transfers t ${w.toSql()}`, w.params);
  return { rows, total };
}

module.exports = {
  insertTransfer, insertItem, deleteItems, deleteItem, updateItemQuantity, lockById, lockBatches, insertMovement, setStatus,
  appendNotes, findOrCreateDestinationBatch, registerReception, findById, findItems, hasApproval, list,
};
