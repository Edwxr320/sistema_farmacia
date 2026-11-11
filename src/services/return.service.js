'use strict';

const crypto = require('node:crypto');
const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const { toCents, fromCents } = require('../utils/money');
const returnRepository = require('../repositories/return.repository');
const saleRepository = require('../repositories/sale.repository');
const cashRepository = require('../repositories/cash.repository');
const documentSequence = require('../repositories/document-sequence.repository');
const auditRepository = require('../repositories/audit.repository');
const { assertBranchAccess, assertBranchAccessInTx, visibleBranchIds, resolveBranch } = require('./branch-access.service');
const { emitToBranch, emitInventoryChanged } = require('./realtime.service');

/**
 * Reembolso unitario de una línea: lo efectivamente cobrado (line_total, ya con descuento)
 * dividido entre las unidades, redondeado hacia abajo al céntimo. Nunca supera lo cobrado.
 */
const unitRefundCents = (lineTotal, lineQuantity) => Math.floor(toCents(lineTotal) / Number(lineQuantity));

function returnableDto(rows) {
  return rows.map((r) => {
    const sold = Number(r.sold_quantity);
    const returned = Number(r.returned_quantity);
    return {
      saleItemBatchId: r.sale_item_batch_id,
      saleItemId: r.sale_item_id,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      batchId: r.batch_id,
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date,
      isExpired: Boolean(Number(r.is_expired)),
      soldQuantity: sold,
      returnedQuantity: returned,
      returnableQuantity: sold - returned,
      unitPrice: r.unit_price,
      unitRefundAmount: fromCents(unitRefundCents(r.line_total, r.line_quantity)),
    };
  });
}

function headerDto(r) {
  return {
    id: r.id,
    returnNumber: r.return_number,
    sale: { id: r.sale_id, saleNumber: r.sale_number },
    branch: { id: r.branch_id, name: r.branch_name },
    returnType: r.return_type,
    reason: { id: r.reason_id, code: r.reason_code, name: r.reason_name },
    status: r.status,
    requestedBy: { id: r.requested_by, fullName: r.requested_by_name },
    requestedAt: r.requested_at,
    reviewedBy: r.reviewed_by ? { id: r.reviewed_by, fullName: r.reviewed_by_name } : null,
    reviewedAt: r.reviewed_at,
    completedAt: r.completed_at,
    // Mientras no se completa, el importe es el de las líneas; al completar lo fija el trigger.
    refundAmount: r.status === 'COMPLETED' ? r.refund_amount : r.items_refund_total,
    refundMethod: r.refund_method,
    refundStatus: r.refund_status,
    refundCashSessionId: r.refund_cash_session_id,
    refundOperationCode: r.refund_operation_code,
    units: Number(r.units),
    notes: r.notes,
    rejectionReason: r.rejection_reason,
  };
}

const itemDto = (i) => ({
  id: i.id,
  saleItemBatchId: i.sale_item_batch_id,
  productId: i.product_id,
  sku: i.sku,
  productName: i.product_name,
  batchId: i.batch_id,
  batchNumber: i.batch_number,
  expiryDate: i.expiry_date,
  quantity: Number(i.quantity),
  unitRefundAmount: i.unit_refund_amount,
  lineRefundAmount: i.line_refund_amount,
  condition: i.item_condition,
  restock: Boolean(Number(i.restock)),
  returnInMovementId: i.movement_id ?? null,
  notes: i.notes,
});

async function load(conn, id) {
  const h = await returnRepository.findById(conn, id);
  if (!h) return null;
  return { ...headerDto(h), items: (await returnRepository.findItems(conn, id)).map(itemDto) };
}

// ------------------------------------------------------------------ consulta
async function lookupSale(query, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const saleId = await returnRepository.findSaleIdByNumber(conn, query);
    if (!saleId) throw AppError.notFound('No se encontró la venta o el ticket');
    return returnableInternal(conn, saleId, auth);
  });
}

async function returnableInternal(conn, saleId, auth) {
  const sale = await saleRepository.findSale(conn, saleId);
  if (!sale) throw AppError.notFound('Venta no encontrada');
  assertBranchAccess(auth, sale.branch_id);
  const items = returnableDto(await returnRepository.returnableBySale(conn, saleId));
  const payments = (await saleRepository.findPayments(conn, saleId)).filter((p) => p.status === 'APPROVED');
  return {
    sale: {
      id: sale.id, saleNumber: sale.sale_number, status: sale.status, soldAt: sale.sold_at, total: sale.total,
      branchId: sale.branch_id, ticketNumber: sale.ticket_number,
    },
    canReturn: sale.status === 'COMPLETED' && items.some((i) => i.returnableQuantity > 0),
    paymentMethods: [...new Set(payments.map((p) => p.method))],
    items,
  };
}

async function returnable(saleId, auth, ctx) {
  return withConnection(ctx, (conn) => returnableInternal(conn, saleId, auth));
}

async function reasons(ctx) {
  return withConnection(ctx, async (conn) => returnRepository.listReasons(conn));
}

// ------------------------------------------------------------- operaciones
/**
 * Resuelve las líneas pedidas contra lo realmente vendido y aún no devuelto.
 * Con saleItemId se reparte entre los lotes de esa línea (primero los de vencimiento más lejano).
 */
function resolveItems(requested, allocations) {
  const remaining = new Map(allocations.map((a) => [a.sale_item_batch_id, Number(a.sold_quantity) - Number(a.returned_quantity)]));
  const out = [];
  for (const [i, it] of requested.entries()) {
    const label = `Línea ${i + 1}`;
    const candidates = it.saleItemBatchId
      ? allocations.filter((a) => a.sale_item_batch_id === it.saleItemBatchId)
      : allocations.filter((a) => a.sale_item_id === it.saleItemId);
    if (candidates.length === 0) throw AppError.badRequest(`${label}: el producto no pertenece a esta venta`);
    let need = it.quantity;
    for (const a of candidates) {
      const free = remaining.get(a.sale_item_batch_id);
      const take = Math.min(free, need);
      if (take <= 0) continue;
      if (it.condition === 'RESELLABLE' && Number(a.is_expired)) {
        throw new AppError(422, 'BATCH_EXPIRED', `${label}: el lote ${a.batch_number} está vencido; registre la condición EXPIRED`);
      }
      out.push({ allocation: a, quantity: take, condition: it.condition, notes: it.notes });
      remaining.set(a.sale_item_batch_id, free - take);
      need -= take;
      if (need === 0) break;
    }
    if (need > 0) {
      throw new AppError(422, 'RETURN_EXCEEDS_SOLD', `${label}: la cantidad supera lo vendido y aún no devuelto`, {
        requested: it.quantity, available: it.quantity - need,
      });
    }
  }
  // Una fila por lote (uq_sale_return_items): agrupa líneas del mismo lote y condición.
  const merged = new Map();
  for (const r of out) {
    const key = r.allocation.sale_item_batch_id;
    const prev = merged.get(key);
    if (prev && prev.condition !== r.condition) {
      throw AppError.badRequest('Un mismo lote no puede devolverse con dos condiciones distintas en la misma solicitud');
    }
    merged.set(key, prev ? { ...prev, quantity: prev.quantity + r.quantity } : r);
  }
  const totalSold = allocations.reduce((a, x) => a + Number(x.sold_quantity), 0);
  const totalReturned = allocations.reduce((a, x) => a + Number(x.returned_quantity), 0) + out.reduce((a, x) => a + x.quantity, 0);
  return { items: [...merged.values()], returnType: totalReturned === totalSold ? 'TOTAL' : 'PARTIAL' };
}

async function approveInTx(conn, id) {
  if ((await returnRepository.setStatus(conn, id, 'REQUESTED', { status: 'APPROVED' })) !== 1) {
    throw AppError.conflict('Solo se aprueban devoluciones solicitadas', 'RETURN_INVALID_STATE');
  }
}

/** Valida que el reembolso respete los medios de pago originales y sus importes. */
async function chooseRefundMethod(conn, saleId, returnId, amountCents, requested) {
  const { paid, refunded } = await returnRepository.refundCapacityByMethod(conn, saleId, returnId);
  const capacity = new Map(paid.map((p) => [p.method, toCents(p.amount)]));
  for (const r of refunded) capacity.set(r.method, (capacity.get(r.method) ?? 0) - toCents(r.amount));
  const methods = [...capacity.keys()];
  if (methods.length === 0) throw new AppError(422, 'NO_PAYMENTS', 'La venta no tiene pagos aprobados para reembolsar');
  let method = requested;
  if (!method) {
    if (methods.length > 1) {
      throw new AppError(422, 'REFUND_METHOD_REQUIRED', 'La venta tuvo varios medios de pago: indique refundMethod', { methods });
    }
    [method] = methods;
  }
  if (!capacity.has(method)) {
    throw new AppError(422, 'REFUND_METHOD_INVALID', 'El reembolso debe hacerse por un medio de pago usado en la venta', { methods });
  }
  if (amountCents > capacity.get(method)) {
    throw new AppError(422, 'REFUND_EXCEEDS_PAID', 'El reembolso supera lo cobrado con ese medio de pago', {
      method, available: fromCents(Math.max(capacity.get(method), 0)),
    });
  }
  return method;
}

/**
 * Completa una devolución APPROVED: RETURN_IN de cada unidad apta (al mismo lote vendido)
 * y reembolso. El trigger calcula refund_amount y, en efectivo, registra RETURN_REFUND en caja
 * (validando que la caja esté abierta y tenga fondos).
 */
async function completeInTx(conn, id, auth, { refundMethod } = {}) {
  const locked = await returnRepository.lockById(conn, id);
  if (locked.status !== 'APPROVED') throw AppError.conflict('Solo se completan devoluciones aprobadas', 'RETURN_INVALID_STATE');
  await saleRepository.lockSale(conn, locked.sale_id);

  const items = await returnRepository.findItems(conn, id);
  let restocked = 0;
  for (const it of items) {
    if (!Number(it.restock) || it.movement_id) continue;
    await returnRepository.insertReturnMovement(conn, {
      batchId: it.batch_id, quantity: Number(it.quantity), returnItemId: it.id, performedBy: auth.userId,
      reason: `Devolución ${locked.return_number}`,
    });
    restocked += 1;
  }

  const amountCents = items.reduce((a, it) => a + toCents(it.line_refund_amount), 0);
  const fields = { status: 'COMPLETED' };
  if (amountCents > 0) {
    if (!auth.permissions.has('payments.refund')) {
      throw AppError.forbidden('No tiene permiso para registrar reembolsos', 'PERMISSION_DENIED');
    }
    const method = await chooseRefundMethod(conn, locked.sale_id, id, amountCents, refundMethod);
    fields.refund_method = method;
    fields.refund_status = 'REFUNDED';
    if (method === 'CASH') {
      const session = await cashRepository.lockOpenSessionForSale(conn, auth.userId, locked.branch_id);
      if (!session) throw AppError.conflict('Para reembolsar efectivo debe tener una caja abierta en la sucursal', 'CASH_SESSION_REQUIRED');
      fields.refund_cash_session_id = session.id;
    } else {
      // Pago electrónico DEMO: reembolso simulado con referencia identificable.
      fields.refund_operation_code = `DEMO-REFUND-${method}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    }
  } else {
    fields.refund_status = 'NONE';
  }
  if ((await returnRepository.setStatus(conn, id, 'APPROVED', fields)) !== 1) {
    throw AppError.conflict('La devolución cambió de estado; reintente', 'RETURN_INVALID_STATE');
  }
  return { restocked, productIds: [...new Set(items.filter((i) => Number(i.restock)).map((i) => i.product_id))] };
}

async function create(data, auth, ctx) {
  if (data.process && !auth.permissions.has('returns.approve')) {
    throw AppError.forbidden('Procesar la devolución de inmediato requiere returns.approve', 'PERMISSION_DENIED');
  }
  const result = await withTransaction(ctx, async (conn) => {
    // Bloquear la venta serializa devoluciones simultáneas de la misma venta.
    const sale = await saleRepository.lockSale(conn, data.saleId);
    if (!sale) throw AppError.notFound('Venta no encontrada');
    await assertBranchAccessInTx(conn, auth, sale.branch_id);
    if (sale.status !== 'COMPLETED') throw AppError.conflict('Solo se devuelven productos de ventas vigentes', 'SALE_NOT_COMPLETED');
    const reason = await returnRepository.findReason(conn, data);
    if (!reason || !Number(reason.is_active)) throw AppError.badRequest('Motivo de devolución inválido');

    const allocations = await returnRepository.returnableBySale(conn, data.saleId);
    const { items, returnType } = resolveItems(data.items, allocations);

    // Tope de reembolso por línea: lo cobrado menos lo ya comprometido en devoluciones previas.
    const lineBudget = new Map();
    for (const a of allocations) lineBudget.set(a.sale_item_id, toCents(a.line_total) - toCents(a.line_refunded));
    const prepared = items.map((it) => {
      const unit = unitRefundCents(it.allocation.line_total, it.allocation.line_quantity);
      const budget = lineBudget.get(it.allocation.sale_item_id);
      const unitCapped = Math.min(unit, Math.floor(budget / it.quantity));
      lineBudget.set(it.allocation.sale_item_id, budget - unitCapped * it.quantity);
      return { ...it, unitCents: unitCapped };
    });
    const totalCents = prepared.reduce((a, p) => a + p.unitCents * p.quantity, 0);

    const number = await documentSequence.nextNumber(conn, sale.branch_id, 'RETURN');
    const returnId = await returnRepository.insertReturn(conn, {
      number, saleId: sale.id, returnType, reasonId: reason.id, requestedBy: auth.userId,
      refundStatus: totalCents > 0 ? 'PENDING' : 'NONE', notes: data.notes,
    });
    for (const p of prepared) {
      await returnRepository.insertItem(conn, {
        returnId, saleItemBatchId: p.allocation.sale_item_batch_id, quantity: p.quantity, unitRefund: fromCents(p.unitCents),
        condition: p.condition, notes: p.notes,
      });
    }
    // La creación no tiene trigger de auditoría (los cambios de estado sí).
    await auditRepository.log(conn, {
      action: 'CREATE', module: 'returns', table: 'sale_returns', entityId: returnId,
      newValues: { return_number: number, sale_id: sale.id, return_type: returnType, reason: reason.code, lines: prepared.length, refund_amount: fromCents(totalCents) },
    });

    let completion = null;
    if (data.process) {
      await approveInTx(conn, returnId);
      completion = await completeInTx(conn, returnId, auth, { refundMethod: data.refundMethod });
    }
    return { ret: await load(conn, returnId), completion };
  });
  notifyCompletion(result.ret, result.completion);
  return result.ret;
}

function notifyCompletion(ret, completion) {
  if (!completion) return;
  emitToBranch(ret.branch.id, 'return:completed', { returnId: ret.id, returnNumber: ret.returnNumber, saleId: ret.sale.id });
  if (completion.restocked > 0) {
    emitInventoryChanged(ret.branch.id, { source: 'return', returnId: ret.id, productIds: completion.productIds });
  }
}

async function approve(id, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const locked = await returnRepository.lockById(conn, id);
    if (!locked) throw AppError.notFound('Devolución no encontrada');
    await assertBranchAccessInTx(conn, auth, locked.branch_id);
    await approveInTx(conn, id); // el trigger fija reviewed_by/at y audita
    return load(conn, id);
  });
}

async function reject(id, reason, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const locked = await returnRepository.lockById(conn, id);
    if (!locked) throw AppError.notFound('Devolución no encontrada');
    await assertBranchAccessInTx(conn, auth, locked.branch_id);
    if ((await returnRepository.setStatus(conn, id, 'REQUESTED', { status: 'REJECTED', rejection_reason: reason })) !== 1) {
      throw AppError.conflict('Solo se rechazan devoluciones solicitadas', 'RETURN_INVALID_STATE');
    }
    return load(conn, id);
  });
}

async function complete(id, body, auth, ctx) {
  const result = await withTransaction(ctx, async (conn) => {
    const locked = await returnRepository.lockById(conn, id);
    if (!locked) throw AppError.notFound('Devolución no encontrada');
    await assertBranchAccessInTx(conn, auth, locked.branch_id);
    const completion = await completeInTx(conn, id, auth, body);
    return { ret: await load(conn, id), completion };
  });
  notifyCompletion(result.ret, result.completion);
  return result.ret;
}

async function get(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const ret = await load(conn, id);
    if (!ret) throw AppError.notFound('Devolución no encontrada');
    assertBranchAccess(auth, ret.branch.id);
    return ret;
  });
}

async function list(filters, auth, ctx) {
  const branchId = filters.branchId ? await resolveBranch(auth, filters.branchId) : undefined;
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await returnRepository.list(conn, { ...filters, branchId, branchIds: branchId ? null : visibleBranchIds(auth) });
    return paginated(rows.map(headerDto), total, filters);
  });
}

module.exports = { lookupSale, returnable, reasons, create, approve, reject, complete, get, list, resolveItems };
