'use strict';

/**
 * Tienda virtual: catálogo público y carrito persistente (carts / cart_items).
 * Disponibilidad online = stock vendible (ACTIVE, con existencias, no vencido)
 *                         − unidades comprometidas en pedidos PENDING de la sucursal.
 */

const { likeContains, WhereBuilder, pageParams } = require('../utils/query');

const SELLABLE_STOCK = `
  SELECT pb.product_id, SUM(pb.current_quantity) AS qty
    FROM product_batches pb
   WHERE pb.branch_id = ? AND pb.status = 'ACTIVE' AND pb.current_quantity > 0 AND pb.expiry_date > CURDATE()
   GROUP BY pb.product_id`;

const RESERVED = `
  SELECT oi.product_id, SUM(oi.quantity) AS qty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
   WHERE o.branch_id = ? AND o.status = 'PENDING'
   GROUP BY oi.product_id`;

const SORTS = { name: 'p.name ASC', price_asc: 'price ASC, p.name', price_desc: 'price DESC, p.name' };

async function catalog(conn, branchId, f) {
  const w = new WhereBuilder()
    .add("p.status = 'ACTIVE'")
    .add('c.is_active = TRUE')
    .add('COALESCE(bp.is_available, TRUE) = TRUE')
    .addIf(f.q, '(p.name LIKE ? OR p.active_ingredient LIKE ? OR p.description LIKE ?)', likeContains(f.q), likeContains(f.q), likeContains(f.q))
    .addIf(f.categoryId, 'p.category_id = ?', f.categoryId)
    .addIf(f.productId, 'p.id = ?', f.productId)
    .addIf(f.inStock === true, 'GREATEST(COALESCE(st.qty, 0) - COALESCE(rs.qty, 0), 0) > 0');
  const from = `
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN laboratories l ON l.id = p.laboratory_id
    LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
    LEFT JOIN (${SELLABLE_STOCK}) st ON st.product_id = p.id
    LEFT JOIN (${RESERVED}) rs ON rs.product_id = p.id
    ${w.toSql()}`;
  const params = [branchId, branchId, branchId, ...w.params];
  const [rows] = await conn.execute(
    `SELECT p.id, p.sku, p.name, p.description, p.image_url, p.presentation, p.concentration, p.dosage_form, p.unit,
            p.active_ingredient, p.requires_prescription, p.category_id, c.name AS category_name, l.name AS laboratory_name,
            COALESCE(bp.sale_price, p.sale_price) AS price,
            GREATEST(COALESCE(st.qty, 0) - COALESCE(rs.qty, 0), 0) AS available
       ${from}
      ORDER BY ${SORTS[f.sort] || SORTS.name} LIMIT ? OFFSET ?`,
    [...params, ...pageParams(f)],
  );
  const [[{ total }]] = await conn.execute(`SELECT COUNT(*) AS total ${from}`, params);
  return { rows, total };
}

async function categories(conn, branchId) {
  const [rows] = await conn.execute(
    `SELECT c.id, c.name, c.description, c.image_url, COUNT(p.id) AS products
       FROM categories c
       JOIN products p ON p.category_id = c.id AND p.status = 'ACTIVE'
       LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
      WHERE c.is_active = TRUE AND COALESCE(bp.is_available, TRUE) = TRUE
      GROUP BY c.id, c.name, c.description, c.image_url
      ORDER BY c.name`,
    [branchId],
  );
  return rows;
}

async function branches(conn) {
  const [rows] = await conn.query(
    "SELECT id, code, name, address_line, district, province, department, phone, is_main FROM branches WHERE status = 'ACTIVE' ORDER BY is_main DESC, name",
  );
  return rows;
}

async function mainBranchId(conn) {
  const [[r]] = await conn.query("SELECT id FROM branches WHERE is_main = TRUE AND status = 'ACTIVE' LIMIT 1");
  return r ? r.id : null;
}

async function branchById(conn, id) {
  const [rows] = await conn.execute("SELECT id, code, name, district, province, department FROM branches WHERE id = ? AND status = 'ACTIVE'", [id]);
  return rows[0] || null;
}

/**
 * Unidades comprometidas en pedidos PENDING (opcionalmente excluyendo uno).
 * locking: lectura bloqueante (LOCK IN SHARE MODE) que ve lo último confirmado, no la instantánea
 * de la transacción. Necesaria en el checkout, después de bloquear los lotes, para que un pedido
 * confirmado por otra transacción concurrente se tenga en cuenta.
 */
async function reservedByProducts(conn, branchId, productIds, { excludeOrderId = null, locking = false } = {}) {
  if (productIds.length === 0) return new Map();
  const [rows] = await conn.execute(
    `SELECT oi.product_id, SUM(oi.quantity) AS qty
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.branch_id = ? AND o.status = 'PENDING' AND (? IS NULL OR o.id <> ?)
        AND oi.product_id IN (${productIds.map(() => '?').join(', ')})
      GROUP BY oi.product_id ${locking ? 'LOCK IN SHARE MODE' : ''}`,
    [branchId, excludeOrderId, excludeOrderId, ...productIds],
  );
  return new Map(rows.map((r) => [r.product_id, Number(r.qty)]));
}

// --------------------------------------------------------------------- carrito
async function findActiveCart(conn, customerId, { forUpdate = false } = {}) {
  const [rows] = await conn.execute(
    `SELECT id, customer_id, branch_id, status, updated_at FROM carts WHERE customer_id = ? AND status = 'ACTIVE' ${forUpdate ? 'FOR UPDATE' : ''}`,
    [customerId],
  );
  return rows[0] || null;
}

async function createCart(conn, customerId, branchId) {
  const [res] = await conn.execute("INSERT INTO carts (customer_id, branch_id, status) VALUES (?, ?, 'ACTIVE')", [customerId, branchId]);
  return res.insertId;
}

async function setCartBranch(conn, cartId, branchId) {
  await conn.execute('UPDATE carts SET branch_id = ? WHERE id = ?', [branchId, cartId]);
}

async function cartItems(conn, cartId, branchId) {
  const [rows] = await conn.execute(
    `SELECT ci.product_id, ci.quantity, ci.updated_at, p.sku, p.name, p.image_url, p.status, p.requires_prescription,
            COALESCE(bp.sale_price, p.sale_price) AS price, COALESCE(bp.is_available, TRUE) AS is_available,
            GREATEST(COALESCE(st.qty, 0) - COALESCE(rs.qty, 0), 0) AS available
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
       LEFT JOIN (${SELLABLE_STOCK}) st ON st.product_id = p.id
       LEFT JOIN (${RESERVED}) rs ON rs.product_id = p.id
      WHERE ci.cart_id = ?
      ORDER BY ci.id`,
    [branchId, branchId, branchId, cartId],
  );
  return rows;
}

/** Inserta o reemplaza la cantidad (un producto aparece una sola vez: uq_cart_product). */
async function upsertItem(conn, cartId, productId, quantity) {
  await conn.execute(
    `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)`,
    [cartId, productId, quantity],
  );
}

async function deleteItem(conn, cartId, productId) {
  const [res] = await conn.execute('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?', [cartId, productId]);
  return res.affectedRows;
}

async function clearCart(conn, cartId) {
  await conn.execute('DELETE FROM cart_items WHERE cart_id = ?', [cartId]);
}

async function markConverted(conn, cartId) {
  await conn.execute("UPDATE carts SET status = 'CONVERTED' WHERE id = ? AND status = 'ACTIVE'", [cartId]);
}

module.exports = {
  catalog, categories, branches, mainBranchId, branchById, reservedByProducts, findActiveCart, createCart, setCartBranch,
  cartItems, upsertItem, deleteItem, clearCart, markConverted,
};
