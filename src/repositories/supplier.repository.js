'use strict';

const { likeContains, WhereBuilder, pageParams } = require('../utils/query');

const COLUMNS = [
  'business_name', 'trade_name', 'ruc', 'contact_name', 'phone', 'email', 'address_line', 'district',
  'province', 'department', 'notes', 'status',
];

const SELECT = `
  SELECT s.*,
         (SELECT COUNT(*) FROM stock_entries se WHERE se.supplier_id = s.id) AS entries_count,
         (SELECT MAX(se.received_at) FROM stock_entries se WHERE se.supplier_id = s.id AND se.status = 'POSTED') AS last_entry_at
    FROM suppliers s`;

async function list(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.q, '(s.business_name LIKE ? OR s.trade_name LIKE ?)', likeContains(f.q), likeContains(f.q))
    .addIf(f.ruc, 's.ruc LIKE ?', `${f.ruc}%`)
    .addIf(f.status, 's.status = ?', f.status);
  const [rows] = await conn.execute(`${SELECT} ${w.toSql()} ORDER BY s.business_name LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM suppliers s ${w.toSql()}`, w.params);
  return { rows, total };
}

async function findById(conn, id, { forUpdate = false } = {}) {
  const [rows] = await conn.execute(`${SELECT} WHERE s.id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
  return rows[0] || null;
}

async function rucTaken(conn, ruc, excludeId = null) {
  if (!ruc) return false;
  const [rows] = await conn.execute('SELECT id FROM suppliers WHERE ruc = ? AND (? IS NULL OR id <> ?) LIMIT 1', [
    ruc, excludeId, excludeId,
  ]);
  return rows.length > 0;
}

async function insert(conn, data) {
  const cols = COLUMNS.filter((c) => data[c] !== undefined);
  const [res] = await conn.execute(
    `INSERT INTO suppliers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => data[c]),
  );
  return res.insertId;
}

async function update(conn, id, data) {
  const cols = COLUMNS.filter((c) => data[c] !== undefined);
  if (cols.length === 0) return 0;
  const [res] = await conn.execute(`UPDATE suppliers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...cols.map((c) => data[c]), id,
  ]);
  return res.affectedRows;
}

/** Historial de entradas del proveedor (limitado a las sucursales visibles). */
async function listEntries(conn, supplierId, { branchIds, status, page, pageSize }) {
  const w = new WhereBuilder().add('se.supplier_id = ?', supplierId).addIf(status, 'se.status = ?', status);
  if (branchIds) w.add(`se.branch_id IN (${branchIds.map(() => '?').join(', ') || 'NULL'})`, ...branchIds);
  const [rows] = await conn.execute(
    `SELECT se.id, se.entry_number, se.branch_id, b.name AS branch_name, se.entry_type,
            se.reference_document_type, se.reference_document_number, se.status, se.received_at, se.posted_at,
            se.total_cost, (SELECT COUNT(*) FROM stock_entry_items i WHERE i.stock_entry_id = se.id) AS items_count
       FROM stock_entries se JOIN branches b ON b.id = se.branch_id
       ${w.toSql()} ORDER BY se.received_at DESC, se.id DESC LIMIT ? OFFSET ?`,
    [...w.params, ...pageParams({ page, pageSize })],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM stock_entries se ${w.toSql()}`, w.params);
  return { rows, total };
}

module.exports = { list, findById, rucTaken, insert, update, listEntries };
