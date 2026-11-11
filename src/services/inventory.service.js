'use strict';

const { withConnection } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated, toBooleans } = require('../utils/query');
const inventoryRepository = require('../repositories/inventory.repository');
const { resolveBranch, visibleBranchIds, assertBranchAccess } = require('./branch-access.service');

function stockRowDto(s) {
  return {
    branchId: s.branch_id,
    branchName: s.branch_name,
    productId: s.product_id,
    sku: s.sku,
    barcode: s.barcode,
    productName: s.product_name,
    categoryId: s.category_id,
    categoryName: s.category_name,
    productStatus: s.product_status,
    isAvailable: Boolean(Number(s.is_available)),
    effectiveSalePrice: s.effective_sale_price,
    physicalStock: Number(s.physical_stock),
    availableStock: Number(s.available_stock),
    expiredStock: Number(s.expired_stock),
    blockedStock: Number(s.blocked_stock),
    minimumStock: Number(s.minimum_stock),
    maximumStock: s.maximum_stock === null || s.maximum_stock === undefined ? null : Number(s.maximum_stock),
    shelfLocation: s.shelf_location ?? null,
    nextExpiryDate: s.next_expiry_date,
    stockStatus: s.stock_status,
  };
}

const batchDto = (b) => toBooleans({ ...b, days_to_expiry: Number(b.days_to_expiry) }, ['is_sellable']);

/** Filtro de sucursal: la pedida (validada) o todas las visibles para el usuario. */
async function branchScope(auth, branchId) {
  if (branchId) return { branchId: await resolveBranch(auth, branchId), branchIds: null };
  return { branchId: undefined, branchIds: visibleBranchIds(auth) };
}

async function stock(filters, auth, ctx) {
  const scope = await branchScope(auth, filters.branchId);
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await inventoryRepository.listStock(conn, { ...filters, ...scope });
    return paginated(rows.map(stockRowDto), total, filters);
  });
}

async function lowStock(filters, auth, ctx) {
  const scope = await branchScope(auth, filters.branchId);
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await inventoryRepository.listLowStock(conn, { ...filters, ...scope });
    return paginated(rows.map((r) => ({
      branchId: r.branch_id, branchName: r.branch_name, productId: r.id, sku: r.sku, productName: r.name,
      categoryName: r.category_name, availableStock: Number(r.current_stock), minimumStock: Number(r.minimum_stock),
      unitsToMinimum: Number(r.units_to_minimum), stockStatus: r.stock_status,
    })), total, filters);
  });
}

async function batches(filters, auth, ctx) {
  const scope = await branchScope(auth, filters.branchId);
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await inventoryRepository.listBatches(conn, { ...filters, ...scope });
    return paginated(rows.map(batchDto), total, filters);
  });
}

async function batch(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const row = await inventoryRepository.findBatchById(conn, id);
    if (!row) throw AppError.notFound('Lote no encontrado');
    assertBranchAccess(auth, row.branch_id);
    return batchDto(row);
  });
}

async function movements(filters, auth, ctx) {
  const scope = await branchScope(auth, filters.branchId);
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await inventoryRepository.listMovements(conn, { ...filters, ...scope });
    return paginated(rows.map((m) => ({ ...m, quantity: Number(m.quantity) })), total, filters);
  });
}

/**
 * Reparte una cantidad entre lotes en orden FEFO (vencimiento más próximo primero).
 * @param {Array<{batch_id:number, current_quantity:number}>} fefoBatches ya ordenados
 * @returns {{ allocations: Array<{batchId:number, quantity:number}>, shortfall: number }}
 */
function allocateFefo(fefoBatches, quantity) {
  const allocations = [];
  let remaining = quantity;
  for (const b of fefoBatches) {
    if (remaining <= 0) break;
    const take = Math.min(Number(b.current_quantity), remaining);
    if (take > 0) {
      allocations.push({ batchId: b.batch_id, batchNumber: b.batch_number, expiryDate: b.expiry_date, quantity: take });
      remaining -= take;
    }
  }
  return { allocations, shortfall: remaining };
}

/**
 * Para el módulo POS: dentro de una transacción ya abierta, BLOQUEA los lotes vendibles
 * (FOR UPDATE) y devuelve el reparto FEFO. Rechaza si no alcanza el stock no vencido.
 * Los lotes vencidos, agotados, en cuarentena o retirados nunca se incluyen.
 */
async function reserveFefoInTransaction(conn, branchId, productId, quantity) {
  const locked = await inventoryRepository.lockFefoBatches(conn, branchId, productId);
  const plan = allocateFefo(locked, quantity);
  if (plan.shortfall > 0) {
    throw new AppError(422, 'INSUFFICIENT_STOCK', 'Stock disponible insuficiente (sin contar lotes vencidos o bloqueados)', {
      requested: quantity, available: quantity - plan.shortfall,
    });
  }
  return plan.allocations;
}

/** Consulta (sin bloqueo) del orden FEFO y, opcionalmente, del reparto de una cantidad. */
async function fefo({ branchId, productId, quantity }, auth, ctx) {
  const resolved = await resolveBranch(auth, branchId);
  return withConnection(ctx, async (conn) => {
    const rows = await inventoryRepository.listFefo(conn, resolved, productId);
    const available = rows.reduce((acc, r) => acc + Number(r.current_quantity), 0);
    const result = {
      branchId: resolved,
      productId,
      availableStock: available,
      batches: rows.map((r) => ({
        batchId: r.batch_id, batchNumber: r.batch_number, expiryDate: r.expiry_date,
        currentQuantity: Number(r.current_quantity), daysToExpiry: Number(r.days_to_expiry), fefoRank: Number(r.fefo_rank),
      })),
    };
    if (quantity) {
      const plan = allocateFefo(rows, quantity);
      result.allocation = { requested: quantity, fulfilled: plan.shortfall === 0, shortfall: plan.shortfall, lines: plan.allocations };
    }
    return result;
  });
}

module.exports = { stock, lowStock, batches, batch, movements, fefo, allocateFefo, reserveFefoInTransaction };
