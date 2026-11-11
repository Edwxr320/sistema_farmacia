'use strict';

const { likeContains, WhereBuilder, pageParams } = require('../utils/query');

/**
 * Repositorio para catálogos con nombre único y estado activo (categories, laboratories).
 * Los nombres de tabla/columnas son constantes del código, nunca datos del usuario.
 * @param {{ table: string, columns: string[] }} def columnas editables además de name
 */
function createNamedCatalogRepository({ table, columns, productFk }) {
  const selectCols = ['t.id', 't.name', ...columns.map((c) => `t.${c}`), 't.is_active', 't.created_at', 't.updated_at'].join(', ');
  const countExpr = `(SELECT COUNT(*) FROM products p WHERE p.${productFk} = t.id)`;

  async function list(conn, { q, isActive, page, pageSize }) {
    const w = new WhereBuilder()
      .addIf(q, 't.name LIKE ?', likeContains(q))
      .addIf(isActive !== undefined, 't.is_active = ?', isActive ? 1 : 0);
    const [rows] = await conn.execute(
      `SELECT ${selectCols}, ${countExpr} AS products_count
         FROM ${table} t ${w.toSql()}
        ORDER BY t.name LIMIT ? OFFSET ?`,
      [...w.params, ...pageParams({ page, pageSize })],
    );
    const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total FROM ${table} t ${w.toSql()}`, w.params);
    return { rows, total };
  }

  async function findById(conn, id, { forUpdate = false } = {}) {
    const [rows] = await conn.execute(
      `SELECT ${selectCols}, ${countExpr} AS products_count,
              (SELECT COUNT(*) FROM products p WHERE p.${productFk} = t.id AND p.status = 'ACTIVE') AS active_products_count
         FROM ${table} t WHERE t.id = ? ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] || null;
  }

  async function nameTaken(conn, name, excludeId = null) {
    const [rows] = await conn.execute(
      `SELECT id FROM ${table} WHERE name = ? AND (? IS NULL OR id <> ?) LIMIT 1`,
      [name, excludeId, excludeId],
    );
    return rows.length > 0;
  }

  async function insert(conn, data) {
    const cols = ['name', ...columns.filter((c) => data[c] !== undefined)];
    const [res] = await conn.execute(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => data[c] ?? null),
    );
    return res.insertId;
  }

  async function update(conn, id, data) {
    const cols = ['name', ...columns, 'is_active'].filter((c) => data[c] !== undefined);
    if (cols.length === 0) return 0;
    const [res] = await conn.execute(
      `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => (c === 'is_active' ? (data[c] ? 1 : 0) : data[c])), id],
    );
    return res.affectedRows;
  }

  async function remove(conn, id) {
    const [res] = await conn.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
    return res.affectedRows;
  }

  return { list, findById, nameTaken, insert, update, remove };
}

const categoryRepository = createNamedCatalogRepository({
  table: 'categories', columns: ['description', 'image_url'], productFk: 'category_id',
});
const laboratoryRepository = createNamedCatalogRepository({
  table: 'laboratories', columns: ['country'], productFk: 'laboratory_id',
});

module.exports = { createNamedCatalogRepository, categoryRepository, laboratoryRepository };
