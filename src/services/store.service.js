'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const { toCents, fromCents } = require('../utils/money');
const storeRepository = require('../repositories/store.repository');
const { requireCustomer } = require('./customer.service');

async function resolveStoreBranch(conn, branchId) {
  const id = branchId ?? (await storeRepository.mainBranchId(conn));
  const branch = id ? await storeRepository.branchById(conn, id) : null;
  if (!branch) throw AppError.badRequest('Sucursal no disponible');
  return branch;
}

const productDto = (p) => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  description: p.description,
  imageUrl: p.image_url,
  presentation: p.presentation,
  concentration: p.concentration,
  dosageForm: p.dosage_form,
  unit: p.unit,
  activeIngredient: p.active_ingredient,
  laboratory: p.laboratory_name,
  category: { id: p.category_id, name: p.category_name },
  price: p.price,
  requiresPrescription: Boolean(Number(p.requires_prescription)),
  // Solo se informa si hay stock y un tope razonable: no se expone el inventario exacto.
  inStock: Number(p.available) > 0,
  maxPurchasable: Math.min(Number(p.available), 100),
});

// -------------------------------------------------------------------- catálogo
async function catalog(filters, ctx) {
  return withConnection(ctx, async (conn) => {
    const branch = await resolveStoreBranch(conn, filters.branchId);
    const { rows, total } = await storeRepository.catalog(conn, branch.id, filters);
    return { ...paginated(rows.map(productDto), total, filters), branch: { id: branch.id, name: branch.name } };
  });
}

async function product(id, branchId, ctx) {
  return withConnection(ctx, async (conn) => {
    const branch = await resolveStoreBranch(conn, branchId);
    const { rows } = await storeRepository.catalog(conn, branch.id, { productId: id, page: 1, pageSize: 1 });
    if (!rows[0]) throw AppError.notFound('Producto no disponible');
    return { ...productDto(rows[0]), branch: { id: branch.id, name: branch.name } };
  });
}

async function categories(branchId, ctx) {
  return withConnection(ctx, async (conn) => {
    const branch = await resolveStoreBranch(conn, branchId);
    return (await storeRepository.categories(conn, branch.id)).map((c) => ({
      id: c.id, name: c.name, description: c.description, imageUrl: c.image_url, products: Number(c.products),
    }));
  });
}

async function branches(ctx) {
  return withConnection(ctx, async (conn) => (await storeRepository.branches(conn)).map((b) => ({
    id: b.id, code: b.code, name: b.name, address: b.address_line, district: b.district, province: b.province,
    department: b.department, phone: b.phone, isMain: Boolean(Number(b.is_main)),
  })));
}

// --------------------------------------------------------------------- carrito
/** Carrito con precios y disponibilidad ACTUALES (MariaDB), con avisos si algo cambió. */
async function buildCart(conn, cart) {
  const branch = await resolveStoreBranch(conn, cart.branch_id);
  const rows = await storeRepository.cartItems(conn, cart.id, branch.id);
  let subtotal = 0;
  const items = rows.map((r) => {
    const price = toCents(r.price);
    const lineTotal = price * Number(r.quantity);
    const sellable = r.status === 'ACTIVE' && Number(r.is_available) === 1;
    const issues = [];
    if (!sellable) issues.push('NOT_AVAILABLE');
    else if (Number(r.available) < Number(r.quantity)) issues.push(Number(r.available) === 0 ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK');
    if (sellable) subtotal += lineTotal;
    return {
      productId: r.product_id, sku: r.sku, name: r.name, imageUrl: r.image_url, quantity: Number(r.quantity),
      unitPrice: r.price, lineTotal: fromCents(lineTotal), requiresPrescription: Boolean(Number(r.requires_prescription)),
      maxPurchasable: Math.min(Number(r.available), 100), issues,
    };
  });
  return {
    cartId: cart.id,
    branch: { id: branch.id, name: branch.name },
    items,
    itemsCount: items.length,
    subtotal: fromCents(subtotal),
    canCheckout: items.length > 0 && items.every((i) => i.issues.length === 0),
    updatedAt: cart.updated_at,
  };
}

async function getOrCreateCart(conn, customerId, { forUpdate = false } = {}) {
  let cart = await storeRepository.findActiveCart(conn, customerId, { forUpdate });
  if (!cart) {
    const id = await storeRepository.createCart(conn, customerId, await storeRepository.mainBranchId(conn));
    cart = await storeRepository.findActiveCart(conn, customerId, { forUpdate });
    if (!cart || cart.id !== id) throw AppError.conflict('No se pudo crear el carrito', 'CART_CONFLICT');
  }
  return cart;
}

async function getCart(auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const customer = await requireCustomer(conn, auth);
    return buildCart(conn, await getOrCreateCart(conn, customer.id));
  });
}

async function setBranch(auth, branchId, ctx) {
  return withTransaction(ctx, async (conn) => {
    const customer = await requireCustomer(conn, auth);
    const branch = await resolveStoreBranch(conn, branchId);
    const cart = await getOrCreateCart(conn, customer.id, { forUpdate: true });
    await storeRepository.setCartBranch(conn, cart.id, branch.id);
    return buildCart(conn, { ...cart, branch_id: branch.id });
  });
}

/** Fija la cantidad de un producto (alta o modificación). Valida producto y stock en el servidor. */
async function setItem(auth, productId, quantity, ctx) {
  return withTransaction(ctx, async (conn) => {
    const customer = await requireCustomer(conn, auth);
    const cart = await getOrCreateCart(conn, customer.id, { forUpdate: true });
    const branch = await resolveStoreBranch(conn, cart.branch_id);
    const { rows } = await storeRepository.catalog(conn, branch.id, { productId, page: 1, pageSize: 1 });
    if (!rows[0]) throw new AppError(422, 'PRODUCT_NOT_AVAILABLE', 'El producto no está disponible en esta sucursal');
    if (quantity > Number(rows[0].available)) {
      throw new AppError(422, 'INSUFFICIENT_STOCK', 'No hay stock suficiente para esa cantidad', { available: Math.min(Number(rows[0].available), 100) });
    }
    await storeRepository.upsertItem(conn, cart.id, productId, quantity);
    return buildCart(conn, cart);
  });
}

async function removeItem(auth, productId, ctx) {
  return withTransaction(ctx, async (conn) => {
    const customer = await requireCustomer(conn, auth);
    const cart = await getOrCreateCart(conn, customer.id, { forUpdate: true });
    if ((await storeRepository.deleteItem(conn, cart.id, productId)) === 0) throw AppError.notFound('El producto no está en el carrito');
    return buildCart(conn, cart);
  });
}

async function clear(auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const customer = await requireCustomer(conn, auth);
    const cart = await getOrCreateCart(conn, customer.id, { forUpdate: true });
    await storeRepository.clearCart(conn, cart.id);
    return buildCart(conn, cart);
  });
}

module.exports = { catalog, product, categories, branches, getCart, setBranch, setItem, removeItem, clear, resolveStoreBranch };
