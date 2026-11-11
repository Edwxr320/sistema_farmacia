'use strict';

const { likeContains, WhereBuilder, pageParams } = require('../utils/query');

const EDITABLE = [
  'sku', 'barcode', 'name', 'description', 'category_id', 'laboratory_id', 'active_ingredient', 'concentration',
  'dosage_form', 'presentation', 'sanitary_registration', 'unit', 'purchase_price', 'sale_price',
  'requires_prescription', 'image_url', 'status',
];

const SELECT = `
  SELECT p.id, p.sku, p.barcode, p.name, p.description, p.image_url, p.active_ingredient, p.concentration,
         p.dosage_form, p.presentation, p.sanitary_registration, p.unit, p.purchase_price, p.sale_price,
         p.requires_prescription, p.status, p.created_at, p.updated_at,
         p.category_id, c.name AS category_name, c.is_active AS category_is_active,
         p.laboratory_id, l.name AS laboratory_name
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN laboratories l ON l.id = p.laboratory_id`;

const SORTS = { name: 'p.name', sku: 'p.sku', created_at: 'p.created_at', sale_price: 'p.sale_price' };

async function list(conn, f) {
  const w = new WhereBuilder()
    .addIf(f.q, '(p.name LIKE ? OR p.active_ingredient LIKE ? OR p.sku LIKE ? OR p.barcode = ?)',
      likeContains(f.q), likeContains(f.q), likeContains(f.q), f.q)
    .addIf(f.sku, 'p.sku = ?', f.sku)
    .addIf(f.barcode, 'p.barcode = ?', f.barcode)
    .addIf(f.categoryId, 'p.category_id = ?', f.categoryId)
    .addIf(f.laboratoryId, 'p.laboratory_id = ?', f.laboratoryId)
    .addIf(f.status, 'p.status = ?', f.status)
    .addIf(f.requiresPrescription !== undefined, 'p.requires_prescription = ?', f.requiresPrescription ? 1 : 0);
  // sort/order vienen de un enum validado: se mapean a columnas fijas.
  const orderBy = `${SORTS[f.sort] || 'p.name'} ${f.order === 'desc' ? 'DESC' : 'ASC'}, p.id ASC`;
  const [rows] = await conn.execute(`${SELECT} ${w.toSql()} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
    ...w.params, ...pageParams(f),
  ]);
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM products p ${w.toSql()}`, w.params);
  return { rows, total };
}

async function findById(conn, id, { forUpdate = false } = {}) {
  const [rows] = await conn.execute(`${SELECT} WHERE p.id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
  return rows[0] || null;
}

async function findConflicts(conn, { sku, barcode }, excludeId = null) {
  const [rows] = await conn.execute(
    `SELECT id, sku, barcode FROM products
      WHERE (sku = ? OR (? IS NOT NULL AND barcode = ?)) AND (? IS NULL OR id <> ?)`,
    [sku ?? null, barcode ?? null, barcode ?? null, excludeId, excludeId],
  );
  return {
    sku: sku != null && rows.some((r) => r.sku === sku),
    barcode: barcode != null && rows.some((r) => r.barcode === barcode),
  };
}

async function insert(conn, data) {
  const cols = EDITABLE.filter((c) => data[c] !== undefined);
  const [res] = await conn.execute(
    `INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => data[c]),
  );
  return res.insertId;
}

async function update(conn, id, data) {
  const cols = EDITABLE.filter((c) => data[c] !== undefined);
  if (cols.length === 0) return 0;
  const [res] = await conn.execute(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...cols.map((c) => data[c]), id,
  ]);
  return res.affectedRows;
}

async function categoryState(conn, categoryId) {
  const [rows] = await conn.execute('SELECT id, is_active FROM categories WHERE id = ?', [categoryId]);
  return rows[0] || null;
}

async function laboratoryState(conn, laboratoryId) {
  const [rows] = await conn.execute('SELECT id, is_active FROM laboratories WHERE id = ?', [laboratoryId]);
  return rows[0] || null;
}

module.exports = { list, findById, findConflicts, insert, update, categoryState, laboratoryState, EDITABLE };
