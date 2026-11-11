'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const transferRepository = require('../repositories/transfer.repository');
const adjustmentRepository = require('../repositories/adjustment.repository');
const branchProductRepository = require('../repositories/branch-product.repository');
const documentSequence = require('../repositories/document-sequence.repository');
const auditRepository = require('../repositories/audit.repository');
const { canAccessAllBranches, visibleBranchIds, resolveBranch, bindOperationBranch } = require('./branch-access.service');
const { emitToBranch, emitInventoryChanged } = require('./realtime.service');

/**
 * Flujo (sobre los estados del esquema):
 *   SOLICITADA (DRAFT) → APROBADA (DRAFT + aprobación auditada; fija las cantidades aprobadas)
 *   → EN TRÁNSITO (TRANSFER_OUT por lote) → RECEPCIÓN PARCIAL (IN_TRANSIT con ítems recibidos)
 *   → RECIBIDA (TRANSFER_IN por ítem; faltantes, sobrantes y daños documentados) | CANCELADA (solo DRAFT).
 */

const hasBranch = (auth, branchId) => canAccessAllBranches(auth) || auth.branches.some((b) => b.id === Number(branchId));

function assertOrigin(auth, t) {
  if (!auth.permissions.has('inventory.transfers')) throw AppError.forbidden('No tiene permiso para gestionar transferencias', 'PERMISSION_DENIED');
  if (!hasBranch(auth, t.origin_branch_id)) throw AppError.forbidden('No tiene acceso a la sucursal de origen', 'BRANCH_FORBIDDEN');
}

function assertDestination(auth, t) {
  if (!auth.permissions.has('inventory.receive_transfers')) throw AppError.forbidden('No tiene permiso para recibir transferencias', 'PERMISSION_DENIED');
  if (!hasBranch(auth, t.destination_branch_id)) throw AppError.forbidden('No tiene acceso a la sucursal de destino', 'BRANCH_FORBIDDEN');
}

function assertView(auth, t) {
  if (!hasBranch(auth, t.origin_branch_id) && !hasBranch(auth, t.destination_branch_id)) {
    throw AppError.forbidden('No tiene acceso a esta transferencia', 'BRANCH_FORBIDDEN');
  }
}

function stage(t) {
  if (t.status === 'DRAFT') return t.approved_at ? 'APPROVED' : 'REQUESTED';
  if (t.status === 'IN_TRANSIT') return Number(t.received_items) > 0 ? 'PARTIALLY_RECEIVED' : 'IN_TRANSIT';
  if (t.status === 'RECEIVED') return Number(t.discrepancy_items) > 0 ? 'RECEIVED_WITH_DISCREPANCIES' : 'RECEIVED';
  return t.status;
}

function headerDto(t) {
  return {
    id: t.id,
    transferNumber: t.transfer_number,
    status: t.status,
    stage: stage(t),
    origin: { id: t.origin_branch_id, name: t.origin_branch_name },
    destination: { id: t.destination_branch_id, name: t.destination_branch_name },
    requestedBy: { id: t.requested_by, fullName: t.requested_by_name },
    requestedAt: t.requested_at,
    approvedAt: t.approved_at,
    approvedBy: t.approved_by ? { id: Number(t.approved_by) } : null,
    dispatchedBy: t.dispatched_by ? { id: t.dispatched_by, fullName: t.dispatched_by_name } : null,
    dispatchedAt: t.dispatched_at,
    receivedBy: t.received_by ? { id: t.received_by, fullName: t.received_by_name } : null,
    receivedAt: t.received_at,
    cancelledBy: t.cancelled_by ? { id: t.cancelled_by, fullName: t.cancelled_by_name } : null,
    cancelledAt: t.cancelled_at,
    itemsCount: Number(t.items_count),
    receivedItems: Number(t.received_items),
    units: Number(t.units),
    notes: t.notes,
  };
}

const itemDto = (i) => ({
  id: i.id,
  productId: i.product_id,
  sku: i.sku,
  productName: i.product_name,
  originBatchId: i.origin_batch_id,
  batchNumber: i.batch_number,
  expiryDate: i.expiry_date,
  quantity: Number(i.quantity),
  receivedQuantity: i.received_quantity === null ? null : Number(i.received_quantity),
  shortage: i.received_quantity === null ? null : Number(i.quantity) - Number(i.received_quantity),
  destinationBatchId: i.destination_batch_id,
  discrepancyNote: i.discrepancy_note,
  transferOutMovementId: i.out_movement_id ?? null,
  transferInMovementId: i.in_movement_id ?? null,
});

async function load(conn, id) {
  const t = await transferRepository.findById(conn, id);
  if (!t) return null;
  return { ...headerDto(t), items: (await transferRepository.findItems(conn, id)).map(itemDto) };
}

/** Valida lotes del origen (bloqueados): sucursal, vencimiento, estado y stock suficiente. */
async function validateOriginBatches(conn, originBranchId, items) {
  const locked = await transferRepository.lockBatches(conn, items.map((i) => i.batchId));
  const byId = new Map(locked.map((b) => [b.id, b]));
  return items.map((it, idx) => {
    const b = byId.get(it.batchId);
    const label = `Línea ${idx + 1}`;
    if (!b) throw AppError.badRequest(`${label}: el lote no existe`);
    if (b.branch_id !== originBranchId) throw AppError.badRequest(`${label}: el lote ${b.batch_number} no pertenece a la sucursal de origen`);
    if (Number(b.is_expired)) throw new AppError(422, 'BATCH_EXPIRED', `${label}: el lote ${b.batch_number} está vencido`);
    if (b.status !== 'ACTIVE') throw new AppError(422, 'BATCH_NOT_ACTIVE', `${label}: el lote ${b.batch_number} no está activo (${b.status})`);
    if (it.quantity > Number(b.current_quantity)) {
      throw new AppError(422, 'INSUFFICIENT_STOCK', `${label}: stock insuficiente en el lote ${b.batch_number} (${b.current_quantity} disponibles)`);
    }
    return { ...it, batch: b };
  });
}

async function create(data, auth, ctx) {
  const t = { origin_branch_id: data.originBranchId, destination_branch_id: data.destinationBranchId };
  assertOrigin(auth, t);
  return withTransaction(ctx, async (conn) => {
    await resolveBranch(auth, data.originBranchId, { conn });
    const [dest] = await conn.execute("SELECT id FROM branches WHERE id = ? AND status = 'ACTIVE'", [data.destinationBranchId]);
    if (dest.length === 0) throw AppError.badRequest('La sucursal destino no existe o está inactiva');
    const items = await validateOriginBatches(conn, data.originBranchId, data.items);
    const number = await documentSequence.nextNumber(conn, data.originBranchId, 'TRANSFER');
    const id = await transferRepository.insertTransfer(conn, {
      number, originBranchId: data.originBranchId, destinationBranchId: data.destinationBranchId, requestedBy: auth.userId, notes: data.notes,
    });
    for (const it of items) {
      await transferRepository.insertItem(conn, { transferId: id, productId: it.batch.product_id, batchId: it.batchId, quantity: it.quantity });
    }
    await auditRepository.log(conn, {
      action: 'CREATE', module: 'inventory', table: 'branch_transfers', entityId: id,
      newValues: {
        transfer_number: number, origin_branch_id: data.originBranchId, destination_branch_id: data.destinationBranchId,
        requested: items.map((i) => ({ batch_id: i.batchId, quantity: i.quantity })),
      },
    });
    return load(conn, id);
  });
}

async function update(id, data, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const t = await transferRepository.lockById(conn, id);
    if (!t) throw AppError.notFound('Transferencia no encontrada');
    assertOrigin(auth, t);
    await bindOperationBranch(conn, t.origin_branch_id);
    if (t.status !== 'DRAFT') throw AppError.conflict('Solo se modifican transferencias en borrador', 'TRANSFER_INVALID_STATE');
    if (await transferRepository.hasApproval(conn, id)) throw AppError.conflict('La transferencia ya fue aprobada; no se modifica', 'TRANSFER_APPROVED');
    if (data.items) {
      const items = await validateOriginBatches(conn, t.origin_branch_id, data.items);
      await transferRepository.deleteItems(conn, id);
      for (const it of items) {
        await transferRepository.insertItem(conn, { transferId: id, productId: it.batch.product_id, batchId: it.batchId, quantity: it.quantity });
      }
    }
    if (data.notes !== undefined) await conn.execute('UPDATE branch_transfers SET notes = ? WHERE id = ?', [data.notes, id]);
    await auditRepository.log(conn, {
      action: 'UPDATE', module: 'inventory', table: 'branch_transfers', entityId: id,
      newValues: { lines: data.items ? data.items.length : undefined, notes: data.notes },
    });
    return load(conn, id);
  });
}

/** Aprobación: fija las cantidades aprobadas (≤ solicitadas). La auditoría guarda solicitadas y aprobadas. */
async function approve(id, data, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const t = await transferRepository.lockById(conn, id);
    if (!t) throw AppError.notFound('Transferencia no encontrada');
    assertOrigin(auth, t);
    await bindOperationBranch(conn, t.origin_branch_id);
    if (t.status !== 'DRAFT') throw AppError.conflict('Solo se aprueban transferencias en borrador', 'TRANSFER_INVALID_STATE');
    if (await transferRepository.hasApproval(conn, id)) throw AppError.conflict('La transferencia ya fue aprobada', 'TRANSFER_APPROVED');

    const items = await transferRepository.findItems(conn, id);
    const byId = new Map(items.map((i) => [i.id, i]));
    const changes = new Map((data.items || []).map((i) => [i.itemId, i.approvedQuantity]));
    for (const itemId of changes.keys()) if (!byId.has(itemId)) throw AppError.badRequest(`El ítem ${itemId} no pertenece a la transferencia`);

    const detail = [];
    for (const it of items) {
      const requested = Number(it.quantity);
      const approved = changes.has(it.id) ? changes.get(it.id) : requested;
      if (approved > requested) throw AppError.badRequest(`La cantidad aprobada del lote ${it.batch_number} supera la solicitada`);
      if (approved === 0) await transferRepository.deleteItem(conn, it.id);
      else if (approved !== requested) await transferRepository.updateItemQuantity(conn, it.id, approved);
      detail.push({ item_id: it.id, batch_id: it.origin_batch_id, requested, approved });
    }
    if (!detail.some((d) => d.approved > 0)) throw AppError.badRequest('Debe aprobar al menos una unidad');
    await validateOriginBatches(conn, t.origin_branch_id, detail.filter((d) => d.approved > 0).map((d) => ({ batchId: d.batch_id, quantity: d.approved })));
    if (data.notes) await transferRepository.appendNotes(conn, id, `Aprobación: ${data.notes}`);
    await auditRepository.log(conn, {
      action: 'APPROVE', module: 'inventory', table: 'branch_transfers', entityId: id, newValues: { items: detail },
    });
    return load(conn, id);
  });
}

/** Despacho: TRANSFER_OUT por cada lote (descuenta el origen) y estado IN_TRANSIT. */
async function dispatch(id, auth, ctx) {
  const result = await withTransaction(ctx, async (conn) => {
    const t = await transferRepository.lockById(conn, id);
    if (!t) throw AppError.notFound('Transferencia no encontrada');
    assertOrigin(auth, t);
    await bindOperationBranch(conn, t.origin_branch_id);
    if (t.status !== 'DRAFT') throw AppError.conflict('La transferencia ya fue despachada o cancelada', 'TRANSFER_INVALID_STATE');
    if (!(await transferRepository.hasApproval(conn, id))) throw AppError.conflict('La transferencia debe aprobarse antes del despacho', 'TRANSFER_NOT_APPROVED');
    const items = await transferRepository.findItems(conn, id);
    await validateOriginBatches(conn, t.origin_branch_id, items.map((i) => ({ batchId: i.origin_batch_id, quantity: Number(i.quantity) })));
    for (const it of items) {
      if (it.out_movement_id) continue;
      await transferRepository.insertMovement(conn, {
        batchId: it.origin_batch_id, movementType: 'TRANSFER_OUT', quantity: Number(it.quantity), transferItemId: it.id,
        performedBy: auth.userId, reason: `Despacho ${t.transfer_number}`,
      });
    }
    if ((await transferRepository.setStatus(conn, id, 'DRAFT', 'IN_TRANSIT')) !== 1) {
      throw AppError.conflict('La transferencia cambió de estado; reintente', 'TRANSFER_INVALID_STATE');
    }
    await auditRepository.log(conn, {
      action: 'DISPATCH', module: 'inventory', table: 'branch_transfers', entityId: id,
      newValues: { items: items.length, units: items.reduce((a, i) => a + Number(i.quantity), 0) },
    });
    return { transfer: await load(conn, id), productIds: [...new Set(items.map((i) => i.product_id))] };
  });
  emitInventoryChanged(result.transfer.origin.id, { source: 'transfer_out', transferId: id, productIds: result.productIds });
  emitToBranch(result.transfer.destination.id, 'transfer:dispatched', { transferId: id, transferNumber: result.transfer.transferNumber });
  return result.transfer;
}

/**
 * Recepción (parcial o completa) en destino. Por ítem: una sola vez (TRANSFER_IN único).
 * - receivedQuantity: unidades que llegaron (≤ despachado; la diferencia es faltante).
 * - damagedQuantity: de las recibidas, dañadas → ingresan y se dan de baja con un ajuste DAMAGE.
 * - surplusQuantity: llegaron de más → se documentan (no ingresan por la transferencia).
 * Cuando todos los ítems quedan recibidos, la transferencia pasa a RECEIVED.
 */
async function receive(id, data, auth, ctx) {
  const result = await withTransaction(ctx, async (conn) => {
    const t = await transferRepository.lockById(conn, id);
    if (!t) throw AppError.notFound('Transferencia no encontrada');
    assertDestination(auth, t);
    await bindOperationBranch(conn, t.destination_branch_id);
    if (t.status !== 'IN_TRANSIT') throw AppError.conflict('Solo se reciben transferencias en tránsito', 'TRANSFER_INVALID_STATE');

    const items = await transferRepository.findItems(conn, id);
    const byId = new Map(items.map((i) => [i.id, i]));
    const damaged = [];
    const received = [];
    for (const r of data.items) {
      const it = byId.get(r.itemId);
      if (!it) throw AppError.badRequest(`El ítem ${r.itemId} no pertenece a la transferencia`);
      if (it.received_quantity !== null || it.in_movement_id) {
        throw AppError.conflict(`El lote ${it.batch_number} ya fue recibido`, 'ITEM_ALREADY_RECEIVED');
      }
      const sent = Number(it.quantity);
      if (r.receivedQuantity > sent) {
        throw AppError.badRequest(`Lote ${it.batch_number}: no puede recibir más de lo despachado (${sent}); registre el excedente en surplusQuantity`);
      }
      const notes = [];
      if (r.receivedQuantity < sent) notes.push(`Faltante: ${sent - r.receivedQuantity}`);
      if (r.damagedQuantity > 0) notes.push(`Dañado: ${r.damagedQuantity}`);
      if (r.surplusQuantity > 0) notes.push(`Sobrante: ${r.surplusQuantity}`);
      if (r.note) notes.push(r.note);
      if (notes.length > 0 && !r.note && (r.receivedQuantity < sent || r.damagedQuantity > 0 || r.surplusQuantity > 0)) {
        throw AppError.badRequest(`Lote ${it.batch_number}: describa la diferencia en "note"`);
      }
      const note = notes.length > 0 ? notes.join('. ').slice(0, 255) : null;

      let destinationBatchId = null;
      if (r.receivedQuantity > 0) {
        await branchProductRepository.ensure(conn, it.product_id, t.destination_branch_id);
        const [origin] = await transferRepository.lockBatches(conn, [it.origin_batch_id]);
        const dest = await transferRepository.findOrCreateDestinationBatch(conn, origin, t.destination_branch_id);
        if (dest.expiryDate !== origin.expiry_date) {
          throw new AppError(409, 'BATCH_EXPIRY_MISMATCH', `El lote ${origin.batch_number} ya existe en destino con otro vencimiento`);
        }
        destinationBatchId = dest.id;
      }
      await transferRepository.registerReception(conn, it.id, { destinationBatchId, receivedQuantity: r.receivedQuantity, note });
      if (r.receivedQuantity > 0) {
        await transferRepository.insertMovement(conn, {
          batchId: destinationBatchId, movementType: 'TRANSFER_IN', quantity: r.receivedQuantity, transferItemId: it.id,
          performedBy: auth.userId, reason: `Recepción ${t.transfer_number}`,
        });
      }
      if (r.damagedQuantity > 0) damaged.push({ batchId: destinationBatchId, quantity: r.damagedQuantity, batchNumber: it.batch_number });
      received.push({ item_id: it.id, sent, received: r.receivedQuantity, damaged: r.damagedQuantity, surplus: r.surplusQuantity });
    }

    // Unidades dañadas: baja inmediata en destino con trazabilidad (ajuste DAMAGE → DAMAGE_WRITE_OFF).
    let adjustmentNumber = null;
    if (damaged.length > 0) {
      adjustmentNumber = await documentSequence.nextNumber(conn, t.destination_branch_id, 'ADJUSTMENT');
      const adjustmentId = await adjustmentRepository.insert(conn, {
        number: adjustmentNumber, branchId: t.destination_branch_id, type: 'DAMAGE',
        reason: `Mercadería dañada recibida en ${t.transfer_number}`, performedBy: auth.userId, approvedBy: auth.userId,
      });
      for (const d of damaged) {
        await adjustmentRepository.insertMovement(conn, {
          batchId: d.batchId, movementType: 'DAMAGE_WRITE_OFF', quantity: d.quantity, adjustmentId, performedBy: auth.userId,
          reason: `Dañado en transferencia ${t.transfer_number}`,
        });
      }
    }

    const pending = (await transferRepository.findItems(conn, id)).filter((i) => i.received_quantity === null).length;
    if (pending === 0) await transferRepository.setStatus(conn, id, 'IN_TRANSIT', 'RECEIVED');
    await auditRepository.log(conn, {
      action: pending === 0 ? 'RECEIVE' : 'RECEIVE_PARTIAL', module: 'inventory', table: 'branch_transfers', entityId: id,
      newValues: { items: received, pending_items: pending, damage_adjustment: adjustmentNumber },
    });
    return { transfer: await load(conn, id), productIds: [...new Set(items.filter((i) => byId.has(i.id)).map((i) => i.product_id))] };
  });
  emitInventoryChanged(result.transfer.destination.id, { source: 'transfer_in', transferId: id, productIds: result.productIds });
  emitToBranch(result.transfer.origin.id, 'transfer:received', { transferId: id, stage: result.transfer.stage });
  return result.transfer;
}

async function cancel(id, reason, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const t = await transferRepository.lockById(conn, id);
    if (!t) throw AppError.notFound('Transferencia no encontrada');
    assertOrigin(auth, t);
    await bindOperationBranch(conn, t.origin_branch_id);
    if (t.status !== 'DRAFT') throw AppError.conflict('Solo se cancelan transferencias no despachadas', 'TRANSFER_INVALID_STATE');
    await transferRepository.appendNotes(conn, id, `Cancelada: ${reason}`);
    await transferRepository.setStatus(conn, id, 'DRAFT', 'CANCELLED'); // el trigger fija cancelled_by/at
    await auditRepository.log(conn, { action: 'CANCEL', module: 'inventory', table: 'branch_transfers', entityId: id, newValues: { reason } });
    return load(conn, id);
  });
}

async function get(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const t = await transferRepository.findById(conn, id);
    if (!t) throw AppError.notFound('Transferencia no encontrada');
    assertView(auth, t);
    return load(conn, id);
  });
}

async function list(filters, auth, ctx) {
  const branchId = filters.branchId ? await resolveBranch(auth, filters.branchId) : undefined;
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await transferRepository.list(conn, { ...filters, branchId, branchIds: branchId ? null : visibleBranchIds(auth) });
    return paginated(rows.map(headerDto), total, filters);
  });
}

module.exports = { create, update, approve, dispatch, receive, cancel, get, list };
