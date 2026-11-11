'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const adjustmentRepository = require('../repositories/adjustment.repository');
const documentSequence = require('../repositories/document-sequence.repository');
const auditRepository = require('../repositories/audit.repository');
const { resolveBranch, assertBranchAccess, visibleBranchIds } = require('./branch-access.service');
const { emitToBranch, emitInventoryChanged } = require('./realtime.service');

/**
 * Tipo de ajuste → permiso y movimiento de salida.
 * - PHYSICAL_COUNT: la diferencia contra el stock real decide ADJUSTMENT_IN / ADJUSTMENT_OUT.
 * - CORRECTION / OTHER: el usuario indica la dirección (ADJUSTMENT_IN / ADJUSTMENT_OUT).
 * - Bajas: EXPIRED_WRITE_OFF, DAMAGE → DAMAGE_WRITE_OFF, LOSS → ADJUSTMENT_OUT.
 */
const TYPES = {
  PHYSICAL_COUNT: { permission: 'inventory.adjust', mode: 'count' },
  CORRECTION: { permission: 'inventory.adjust', mode: 'directed' },
  OTHER: { permission: 'inventory.adjust', mode: 'directed' },
  EXPIRED_WRITE_OFF: { permission: 'inventory.write_off', mode: 'writeoff', movement: 'EXPIRED_WRITE_OFF' },
  DAMAGE: { permission: 'inventory.write_off', mode: 'writeoff', movement: 'DAMAGE_WRITE_OFF' },
  LOSS: { permission: 'inventory.write_off', mode: 'writeoff', movement: 'ADJUSTMENT_OUT' },
};

function requiredPermission(type) {
  return TYPES[type]?.permission;
}

function headerDto(r) {
  return {
    id: r.id,
    adjustmentNumber: r.adjustment_number,
    branch: { id: r.branch_id, name: r.branch_name },
    adjustmentType: r.adjustment_type,
    reason: r.reason,
    performedBy: { id: r.performed_by, fullName: r.performed_by_name },
    approvedBy: r.approved_by ? { id: r.approved_by, fullName: r.approved_by_name } : null,
    createdAt: r.created_at,
    movementsCount: Number(r.movements_count),
    unitsIn: Number(r.units_in),
    unitsOut: Number(r.units_out),
  };
}

const movementDto = (m) => ({
  id: m.id,
  batchId: m.batch_id,
  batchNumber: m.batch_number,
  expiryDate: m.expiry_date,
  productId: m.product_id,
  sku: m.sku,
  productName: m.product_name,
  movementType: m.movement_type,
  direction: m.direction,
  quantity: Number(m.quantity),
  batchStockBefore: Number(m.batch_stock_before),
  batchStockAfter: Number(m.batch_stock_after),
  stockBefore: Number(m.stock_before),
  stockAfter: Number(m.stock_after),
  reason: m.reason,
  createdAt: m.created_at,
});

async function load(conn, id) {
  const header = await adjustmentRepository.findById(conn, id);
  if (!header) return null;
  return { ...headerDto(header), movements: (await adjustmentRepository.movements(conn, id)).map(movementDto) };
}

/** Calcula los movimientos a registrar a partir del stock REAL de los lotes bloqueados. */
function planMovements(type, items, batchesById, productId) {
  const def = TYPES[type];
  const plan = [];
  const lines = [];
  for (const [i, it] of items.entries()) {
    const b = batchesById.get(it.batchId);
    const label = `Línea ${i + 1} (lote ${b.batch_number})`;
    if (productId && b.product_id !== productId) throw AppError.badRequest(`${label}: el lote no pertenece al producto seleccionado`);
    const current = Number(b.current_quantity);

    if (def.mode === 'count') {
      const diff = it.countedQuantity - current;
      lines.push({ batchId: b.id, batchNumber: b.batch_number, systemQuantity: current, countedQuantity: it.countedQuantity, difference: diff });
      if (diff > 0) plan.push({ batchId: b.id, movementType: 'ADJUSTMENT_IN', quantity: diff });
      if (diff < 0) plan.push({ batchId: b.id, movementType: 'ADJUSTMENT_OUT', quantity: -diff });
      continue;
    }

    const movementType = def.mode === 'writeoff' ? def.movement : it.direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
    const isOut = movementType !== 'ADJUSTMENT_IN';
    if (type === 'EXPIRED_WRITE_OFF' && !Number(b.is_expired)) {
      throw new AppError(422, 'BATCH_NOT_EXPIRED', `${label}: el lote vence el ${b.expiry_date}; no corresponde una baja por vencimiento`);
    }
    if (isOut && it.quantity > current) {
      throw new AppError(422, 'INSUFFICIENT_STOCK', `${label}: stock insuficiente (${current} disponibles)`);
    }
    lines.push({ batchId: b.id, batchNumber: b.batch_number, systemQuantity: current, quantity: it.quantity, movementType });
    plan.push({ batchId: b.id, movementType, quantity: it.quantity });
  }
  return { plan, lines };
}

/**
 * Registra un ajuste en UNA transacción: bloquea los lotes (FOR UPDATE), valida sucursal,
 * estado y existencias reales, crea el encabezado y los movimientos. Los triggers aplican el stock.
 */
async function create(data, auth, ctx) {
  const permission = requiredPermission(data.adjustmentType);
  if (!auth.permissions.has(permission)) {
    throw AppError.forbidden('No tiene permiso para este tipo de ajuste', 'PERMISSION_DENIED');
  }

  const result = await withTransaction(ctx, async (conn) => {
    const branchId = await resolveBranch(auth, data.branchId, { conn });
    const batchIds = data.items.map((i) => i.batchId);
    const locked = await adjustmentRepository.lockBatches(conn, batchIds);
    const byId = new Map(locked.map((b) => [b.id, b]));
    for (const id of batchIds) {
      const b = byId.get(id);
      if (!b) throw AppError.badRequest(`El lote ${id} no existe`);
      if (b.branch_id !== branchId) throw AppError.badRequest(`El lote ${b.batch_number} pertenece a otra sucursal`);
    }

    const { plan, lines } = planMovements(data.adjustmentType, data.items, byId, data.productId);
    const number = await documentSequence.nextNumber(conn, branchId, 'ADJUSTMENT');
    // Las bajas exigen inventory.write_off: quien la registra con ese permiso la autoriza.
    const approvedBy = TYPES[data.adjustmentType].mode === 'writeoff' ? auth.userId : null;
    const adjustmentId = await adjustmentRepository.insert(conn, {
      number, branchId, type: data.adjustmentType, reason: data.reason, performedBy: auth.userId, approvedBy,
    });

    for (const m of plan) {
      await adjustmentRepository.insertMovement(conn, {
        ...m, adjustmentId, performedBy: auth.userId, reason: `${number}: ${data.reason}`.slice(0, 500),
      });
    }
    // inventory_adjustments no tiene trigger de auditoría.
    await auditRepository.log(conn, {
      action: 'CREATE', module: 'inventory', table: 'inventory_adjustments', entityId: adjustmentId,
      newValues: {
        adjustment_number: number, branch_id: branchId, adjustment_type: data.adjustmentType,
        movements: plan.length, units_in: plan.filter((p) => p.movementType === 'ADJUSTMENT_IN').reduce((a, p) => a + p.quantity, 0),
        units_out: plan.filter((p) => p.movementType !== 'ADJUSTMENT_IN').reduce((a, p) => a + p.quantity, 0),
      },
    });
    const adjustment = await load(conn, adjustmentId);
    return { ...adjustment, lines, noDifferences: plan.length === 0, productIds: [...new Set(locked.map((b) => b.product_id))] };
  });

  const { productIds, ...adjustment } = result;
  if (adjustment.movementsCount > 0) {
    emitInventoryChanged(adjustment.branch.id, { source: 'adjustment', adjustmentId: adjustment.id, productIds });
  }
  return adjustment;
}

async function get(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const adj = await load(conn, id);
    if (!adj) throw AppError.notFound('Ajuste no encontrado');
    assertBranchAccess(auth, adj.branch.id);
    return adj;
  });
}

async function list(filters, auth, ctx) {
  const branchId = filters.branchId ? await resolveBranch(auth, filters.branchId) : undefined;
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await adjustmentRepository.list(conn, { ...filters, branchId, branchIds: branchId ? null : visibleBranchIds(auth) });
    return paginated(rows.map(headerDto), total, filters);
  });
}

module.exports = { create, get, list, requiredPermission, TYPES };
