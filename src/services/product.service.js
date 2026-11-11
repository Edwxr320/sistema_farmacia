'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated, toBooleans } = require('../utils/query');
const { saveImage, deleteImage } = require('../utils/image-storage');
const productRepository = require('../repositories/product.repository');
const branchProductRepository = require('../repositories/branch-product.repository');
const inventoryRepository = require('../repositories/inventory.repository');
const auditRepository = require('../repositories/audit.repository');
const { visibleBranchIds, resolveBranch } = require('./branch-access.service');

// Campos que ya audita el trigger trg_products_au (no se duplican).
const TRIGGER_AUDITED = new Set(['sale_price', 'purchase_price', 'status', 'requires_prescription']);
const PRICE_FIELDS = ['sale_price', 'purchase_price'];

function toDto(r) {
  if (!r) return null;
  return {
    id: r.id,
    sku: r.sku,
    barcode: r.barcode,
    name: r.name,
    description: r.description,
    imageUrl: r.image_url,
    activeIngredient: r.active_ingredient,
    concentration: r.concentration,
    dosageForm: r.dosage_form,
    presentation: r.presentation,
    sanitaryRegistration: r.sanitary_registration,
    unit: r.unit,
    purchasePrice: r.purchase_price,
    salePrice: r.sale_price,
    requiresPrescription: Boolean(Number(r.requires_prescription)),
    status: r.status,
    category: { id: r.category_id, name: r.category_name, isActive: Boolean(Number(r.category_is_active)) },
    laboratory: r.laboratory_id ? { id: r.laboratory_id, name: r.laboratory_name } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function branchConfigDto(r) {
  const b = toBooleans(r, ['is_available']);
  return {
    branchId: b.branch_id,
    branchCode: b.branch_code,
    branchName: b.branch_name,
    salePrice: b.sale_price,
    generalSalePrice: b.general_sale_price,
    effectiveSalePrice: b.effective_sale_price,
    minimumStock: Number(b.minimum_stock),
    maximumStock: b.maximum_stock === null ? null : Number(b.maximum_stock),
    shelfLocation: b.shelf_location,
    isAvailable: b.is_available,
    updatedAt: b.updated_at,
  };
}

function stockDto(s) {
  return {
    branchId: s.branch_id,
    branchName: s.branch_name,
    physicalStock: Number(s.physical_stock),
    availableStock: Number(s.available_stock),
    expiredStock: Number(s.expired_stock),
    blockedStock: Number(s.blocked_stock),
    minimumStock: Number(s.minimum_stock),
    nextExpiryDate: s.next_expiry_date,
    stockStatus: s.stock_status,
    effectiveSalePrice: s.effective_sale_price,
    isAvailable: Boolean(Number(s.is_available)),
  };
}

async function assertReferences(conn, data) {
  if (data.category_id !== undefined) {
    const c = await productRepository.categoryState(conn, data.category_id);
    if (!c) throw AppError.badRequest('La categoría no existe');
    if (!Number(c.is_active)) throw AppError.badRequest('La categoría está inactiva');
  }
  if (data.laboratory_id !== undefined && data.laboratory_id !== null) {
    const l = await productRepository.laboratoryState(conn, data.laboratory_id);
    if (!l) throw AppError.badRequest('El laboratorio no existe');
    if (!Number(l.is_active)) throw AppError.badRequest('El laboratorio está inactivo');
  }
}

async function assertUnique(conn, data, excludeId = null) {
  if (data.sku === undefined && data.barcode === undefined) return;
  const c = await productRepository.findConflicts(conn, { sku: data.sku, barcode: data.barcode }, excludeId);
  if (c.sku) throw AppError.conflict('Ya existe un producto con ese SKU', 'SKU_TAKEN');
  if (c.barcode) throw AppError.conflict('Ya existe un producto con ese código de barras', 'BARCODE_TAKEN');
}

async function list(filters, ctx) {
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await productRepository.list(conn, filters);
    return paginated(rows.map(toDto), total, filters);
  });
}

/** Detalle completo: producto + configuración por sucursal + stock + lotes con existencias. */
async function get(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const row = await productRepository.findById(conn, id);
    if (!row) throw AppError.notFound('Producto no encontrado');
    const branchIds = visibleBranchIds(auth);
    // Misma conexión (mismo contexto): consultas secuenciales.
    const branches = await branchProductRepository.listByProduct(conn, id, branchIds);
    const stock = await inventoryRepository.stockByProduct(conn, id, branchIds);
    const batches = await inventoryRepository.listBatches(conn, {
      productId: id, branchIds, withStock: true, page: 1, pageSize: 100,
    });
    return {
      ...toDto(row),
      branches: branches.map(branchConfigDto),
      inventory: stock.map(stockDto),
      batches: batches.rows.map((b) => toBooleans(b, ['is_sellable'])),
    };
  });
}

async function create({ product, branchDefaults }, ctx) {
  return withTransaction(ctx, async (conn) => {
    await assertReferences(conn, product);
    await assertUnique(conn, product);
    const id = await productRepository.insert(conn, product);
    const branches = await branchProductRepository.createForActiveBranches(conn, id, branchDefaults);
    // INSERT de products no tiene trigger de auditoría: se registra aquí.
    await auditRepository.log(conn, {
      action: 'CREATE', module: 'products', table: 'products', entityId: id,
      newValues: { ...product, branch_configs_created: branches },
    });
    return toDto(await productRepository.findById(conn, id));
  });
}

async function update(id, data, auth, ctx) {
  if (PRICE_FIELDS.some((f) => data[f] !== undefined) && !auth.permissions.has('products.prices')) {
    throw AppError.forbidden('No tiene permiso para modificar precios', 'PERMISSION_DENIED');
  }
  return withTransaction(ctx, async (conn) => {
    const before = await productRepository.findById(conn, id, { forUpdate: true });
    if (!before) throw AppError.notFound('Producto no encontrado');
    await assertReferences(conn, data);
    await assertUnique(conn, data, id);
    await productRepository.update(conn, id, data);

    // Solo se auditan aquí los campos que el trigger no registra.
    const extra = Object.keys(data).filter((k) => !TRIGGER_AUDITED.has(k) && String(data[k] ?? '') !== String(before[k] ?? ''));
    if (extra.length > 0) {
      await auditRepository.log(conn, {
        action: 'UPDATE', module: 'products', table: 'products', entityId: id,
        oldValues: Object.fromEntries(extra.map((k) => [k, before[k]])),
        newValues: Object.fromEntries(extra.map((k) => [k, data[k]])),
      });
    }
    return toDto(await productRepository.findById(conn, id));
  });
}

/** Activar / desactivar / descontinuar. El trigger trg_products_au audita el cambio de estado. */
async function setStatus(id, status, ctx) {
  return withTransaction(ctx, async (conn) => {
    const before = await productRepository.findById(conn, id, { forUpdate: true });
    if (!before) throw AppError.notFound('Producto no encontrado');
    if (status === 'ACTIVE' && !Number(before.category_is_active)) {
      throw AppError.conflict('No se puede activar: la categoría del producto está inactiva', 'CATEGORY_INACTIVE');
    }
    await productRepository.update(conn, id, { status });
    return toDto(await productRepository.findById(conn, id));
  });
}

async function setImage(id, file, ctx) {
  const publicPath = await saveImage('products', `p${id}`, file);
  try {
    const previous = await withTransaction(ctx, async (conn) => {
      const before = await productRepository.findById(conn, id, { forUpdate: true });
      if (!before) throw AppError.notFound('Producto no encontrado');
      await productRepository.update(conn, id, { image_url: publicPath });
      await auditRepository.log(conn, {
        action: 'UPDATE', module: 'products', table: 'products', entityId: id,
        oldValues: { image_url: before.image_url }, newValues: { image_url: publicPath },
      });
      return before.image_url;
    });
    await deleteImage(previous);
  } catch (err) {
    await deleteImage(publicPath); // si falla la base, no queda archivo huérfano
    throw err;
  }
  return withConnection(ctx, async (conn) => toDto(await productRepository.findById(conn, id)));
}

// --------------------------------------------------- configuración por sucursal
async function listBranchConfigs(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    if (!(await productRepository.findById(conn, id))) throw AppError.notFound('Producto no encontrado');
    return (await branchProductRepository.listByProduct(conn, id, visibleBranchIds(auth))).map(branchConfigDto);
  });
}

// Permiso requerido por cada campo de branch_products.
const FIELD_PERMISSION = {
  sale_price: 'products.prices',
  minimum_stock: 'inventory.minimum_stock',
  maximum_stock: 'inventory.minimum_stock',
  shelf_location: 'products.update',
  is_available: 'products.update',
};

async function updateBranchConfig(id, branchId, data, auth, ctx) {
  const missing = [...new Set(Object.keys(data).map((k) => FIELD_PERMISSION[k]))].filter((p) => !auth.permissions.has(p));
  if (missing.length > 0) throw AppError.forbidden('No tiene permiso para modificar esos campos', 'PERMISSION_DENIED');

  return withTransaction(ctx, async (conn) => {
    await resolveBranch(auth, branchId, { conn });
    if (!(await productRepository.findById(conn, id, { forUpdate: true }))) throw AppError.notFound('Producto no encontrado');
    await branchProductRepository.ensure(conn, id, branchId);
    const before = await branchProductRepository.findOne(conn, id, branchId, { forUpdate: true });

    const min = data.minimum_stock ?? Number(before.minimum_stock);
    const max = data.maximum_stock !== undefined ? data.maximum_stock : before.maximum_stock;
    if (max !== null && max !== undefined && Number(max) < min) {
      throw AppError.badRequest('El stock máximo no puede ser menor que el mínimo');
    }
    await branchProductRepository.update(conn, id, branchId, data);

    // trg_branch_products_au audita precio, mínimo y disponibilidad; aquí solo máximo y ubicación.
    const extra = ['maximum_stock', 'shelf_location'].filter((k) => data[k] !== undefined && String(data[k] ?? '') !== String(before[k] ?? ''));
    if (extra.length > 0) {
      await auditRepository.log(conn, {
        action: 'UPDATE', module: 'inventory', table: 'branch_products', entityId: before.id,
        oldValues: Object.fromEntries(extra.map((k) => [k, before[k]])),
        newValues: Object.fromEntries(extra.map((k) => [k, data[k]])),
      });
    }
    return branchConfigDto(await branchProductRepository.findOne(conn, id, branchId));
  });
}

module.exports = { list, get, create, update, setStatus, setImage, listBranchConfigs, updateBranchConfig, toDto };
