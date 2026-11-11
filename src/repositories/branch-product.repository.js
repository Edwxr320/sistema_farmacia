'use strict';

/**
 * branch_products: configuración del producto por sucursal (una fila por sucursal y producto).
 * El catálogo NO se duplica.
 */

/** Crea la configuración en todas las sucursales activas que aún no la tengan. */
async function createForActiveBranches(conn, productId, { minimum_stock, maximum_stock } = {}) {
  const [res] = await conn.execute(
    `INSERT INTO branch_products (branch_id, product_id, minimum_stock, maximum_stock)
     SELECT b.id, ?,
            COALESCE(?, (SELECT CAST(s.setting_value AS UNSIGNED) FROM settings s
                          WHERE s.setting_key = 'inventory.default_minimum_stock'), 20),
            ?
       FROM branches b
      WHERE b.status = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM branch_products bp WHERE bp.branch_id = b.id AND bp.product_id = ?)`,
    [productId, minimum_stock ?? null, maximum_stock ?? null, productId],
  );
  return res.affectedRows;
}

const SELECT = `
  SELECT bp.id, bp.branch_id, b.code AS branch_code, b.name AS branch_name, bp.product_id,
         bp.sale_price, p.sale_price AS general_sale_price, COALESCE(bp.sale_price, p.sale_price) AS effective_sale_price,
         bp.minimum_stock, bp.maximum_stock, bp.shelf_location, bp.is_available, bp.updated_at
    FROM branch_products bp
    JOIN branches b ON b.id = bp.branch_id
    JOIN products p ON p.id = bp.product_id`;

async function listByProduct(conn, productId, branchIds = null) {
  const filter = branchIds ? `AND bp.branch_id IN (${branchIds.map(() => '?').join(', ') || 'NULL'})` : '';
  const [rows] = await conn.execute(`${SELECT} WHERE bp.product_id = ? ${filter} ORDER BY b.is_main DESC, b.name`, [
    productId, ...(branchIds || []),
  ]);
  return rows;
}

async function findOne(conn, productId, branchId, { forUpdate = false } = {}) {
  const [rows] = await conn.execute(
    `${SELECT} WHERE bp.product_id = ? AND bp.branch_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`,
    [productId, branchId],
  );
  return rows[0] || null;
}

/** Crea la fila si falta (p. ej. sucursal abierta después del producto). */
async function ensure(conn, productId, branchId) {
  await conn.execute(
    `INSERT INTO branch_products (branch_id, product_id, minimum_stock)
     SELECT ?, ?, COALESCE((SELECT CAST(setting_value AS UNSIGNED) FROM settings
                             WHERE setting_key = 'inventory.default_minimum_stock'), 20)
       FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM branch_products WHERE branch_id = ? AND product_id = ?)`,
    [branchId, productId, branchId, productId],
  );
}

const COLUMNS = ['sale_price', 'minimum_stock', 'maximum_stock', 'shelf_location', 'is_available'];

async function update(conn, productId, branchId, data) {
  const cols = COLUMNS.filter((c) => data[c] !== undefined);
  if (cols.length === 0) return 0;
  const [res] = await conn.execute(
    `UPDATE branch_products SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE product_id = ? AND branch_id = ?`,
    [...cols.map((c) => data[c]), productId, branchId],
  );
  return res.affectedRows;
}

module.exports = { createForActiveBranches, listByProduct, findOne, ensure, update };
