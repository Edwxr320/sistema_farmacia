'use strict';

const crypto = require('node:crypto');
const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated, toBooleans } = require('../utils/query');
const { toCents, fromCents, percentOf, allocateProportionally } = require('../utils/money');
const saleRepository = require('../repositories/sale.repository');
const cashRepository = require('../repositories/cash.repository');
const documentSequence = require('../repositories/document-sequence.repository');
const auditRepository = require('../repositories/audit.repository');
const { reserveFefoInTransaction } = require('./inventory.service');
const { resolveBranch, assertBranchAccess, assertBranchAccessInTx, visibleBranchIds } = require('./branch-access.service');
const { emitToBranch, emitInventoryChanged } = require('./realtime.service');
const paymentGateway = require('./payment-gateway.service');

const DEMO_REJECTION = 'DEMO: operación rechazada por el emisor simulado';

// ======================================================================= cotización
/**
 * Recalcula la venta con precios y datos REALES de MariaDB (nunca con importes del navegador).
 * Valida estado, disponibilidad, receta, stock no vencido y descuento.
 * @returns líneas en céntimos y totales
 */
async function computeQuote(conn, branchId, { items, discount }, auth) {
  const products = await saleRepository.productsForSale(conn, branchId, items.map((i) => i.productId));
  const byId = new Map(products.map((p) => [p.id, p]));
  const rxSetting = (await saleRepository.getSetting(conn, 'sales.require_prescription_reference')) ?? 'true';
  const maxDiscountPercent = (await saleRepository.getSetting(conn, 'sales.max_discount_percent')) ?? '0';

  const lines = items.map((it, i) => {
    const p = byId.get(it.productId);
    const label = `Línea ${i + 1}`;
    if (!p) throw AppError.badRequest(`${label}: el producto no existe`);
    if (p.status !== 'ACTIVE') throw new AppError(422, 'PRODUCT_INACTIVE', `${label}: ${p.name} no está activo`);
    if (!Number(p.is_available)) throw new AppError(422, 'PRODUCT_NOT_AVAILABLE', `${label}: ${p.name} no está habilitado en esta sucursal`);
    if (Number(p.requires_prescription) && rxSetting === 'true' && !it.prescriptionReference) {
      throw new AppError(422, 'PRESCRIPTION_REQUIRED', `${label}: ${p.name} requiere la referencia de la receta médica`, { productId: p.id });
    }
    const unitCents = toCents(p.price);
    return {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      quantity: it.quantity,
      unitCents,
      subtotalCents: unitCents * it.quantity,
      prescriptionReference: Number(p.requires_prescription) ? it.prescriptionReference ?? null : it.prescriptionReference ?? null,
      requiresPrescription: Boolean(Number(p.requires_prescription)),
      availableStock: Number(p.available_stock),
    };
  });

  const subtotalCents = lines.reduce((a, l) => a + l.subtotalCents, 0);
  let discountCents = 0;
  if (discount) {
    if (!auth.permissions.has('sales.discount')) {
      throw AppError.forbidden('No tiene permiso para aplicar descuentos', 'DISCOUNT_NOT_ALLOWED');
    }
    discountCents = discount.type === 'PERCENT' ? percentOf(subtotalCents, discount.value) : toCents(discount.value);
    const maxCents = percentOf(subtotalCents, maxDiscountPercent);
    if (discountCents > subtotalCents) throw new AppError(422, 'DISCOUNT_TOO_HIGH', 'El descuento no puede superar el importe de la venta');
    if (discountCents > maxCents) {
      throw new AppError(422, 'DISCOUNT_TOO_HIGH', `El descuento supera el máximo permitido (${maxDiscountPercent}%)`, {
        maxDiscount: fromCents(maxCents),
      });
    }
  }
  // El descuento se reparte entre las líneas en proporción a su importe (suma exacta).
  const perLine = allocateProportionally(discountCents, lines.map((l) => l.subtotalCents));
  lines.forEach((l, i) => {
    l.discountCents = perLine[i];
    l.totalCents = l.subtotalCents - perLine[i];
  });
  return { lines, subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

function quoteDto({ lines, subtotalCents, discountCents, totalCents }) {
  return {
    items: lines.map((l) => ({
      productId: l.productId,
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      unitPrice: fromCents(l.unitCents),
      lineSubtotal: fromCents(l.subtotalCents),
      discountAmount: fromCents(l.discountCents),
      lineTotal: fromCents(l.totalCents),
      requiresPrescription: l.requiresPrescription,
      availableStock: l.availableStock,
      stockSufficient: l.availableStock >= l.quantity,
    })),
    subtotal: fromCents(subtotalCents),
    discountTotal: fromCents(discountCents),
    total: fromCents(totalCents),
  };
}

/** Carrito: el cliente envía productos y cantidades; el servidor devuelve precios y totales reales. */
async function quote(data, auth, ctx) {
  const branchId = await resolveBranch(auth, data.branchId);
  return withConnection(ctx, async (conn) => ({ branchId, ...quoteDto(await computeQuote(conn, branchId, data, auth)) }));
}

async function catalog(filters, auth, ctx) {
  const branchId = await resolveBranch(auth, filters.branchId);
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await saleRepository.catalog(conn, branchId, filters);
    return paginated(rows.map((r) => {
      const b = toBooleans(r, ['requires_prescription', 'is_available', 'expiring_soon']);
      return {
        productId: b.id, sku: b.sku, barcode: b.barcode, name: b.name, presentation: b.presentation,
        concentration: b.concentration, unit: b.unit, imageUrl: b.image_url, price: b.price,
        requiresPrescription: b.requires_prescription, isAvailable: b.is_available,
        availableStock: Number(b.available_stock), canSell: b.is_available && Number(b.available_stock) > 0,
        nextExpiryDate: b.next_expiry_date, daysToNextExpiry: b.days_to_next_expiry === null ? null : Number(b.days_to_next_expiry),
        expiringSoon: b.expiring_soon, expiredStockNotSellable: Number(b.expired_stock),
      };
    }), total, filters);
  });
}

// ========================================================================= pagos
/** Valida los pagos contra el total del servidor y prepara su simulación DEMO. */
function planPayments(payments, totalCents) {
  const plan = payments.map((p) => {
    const amountCents = p.amount === undefined ? totalCents : toCents(p.amount);
    const item = { method: p.method, amountCents, outcome: p.method === 'CASH' ? 'APPROVE' : p.simulate };
    if (p.method === 'CASH') {
      const tendered = p.tenderedAmount === undefined ? amountCents : toCents(p.tenderedAmount);
      if (tendered < amountCents) {
        throw new AppError(422, 'INSUFFICIENT_TENDERED', 'El efectivo recibido es menor que el importe a cobrar');
      }
      item.tenderedCents = tendered;
      item.changeCents = tendered - amountCents;
    }
    return item;
  });
  const paidCents = plan.reduce((a, p) => a + p.amountCents, 0);
  if (paidCents !== totalCents) {
    throw new AppError(422, 'PAYMENT_TOTAL_MISMATCH', 'La suma de los pagos debe coincidir exactamente con el total de la venta', {
      total: fromCents(totalCents), paid: fromCents(paidCents),
    });
  }
  return plan;
}

const demoReference = (method) => `DEMO-${method}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

// ======================================================================== detalle
function saleDto(s, items, payments) {
  return {
    id: s.id,
    saleNumber: s.sale_number,
    status: s.status,
    channel: s.sale_channel,
    branch: { id: s.branch_id, name: s.branch_name },
    seller: { id: s.seller_user_id, fullName: s.seller_name },
    cashSession: s.cash_session_id ? { id: s.cash_session_id, sessionNumber: s.session_number } : null,
    customer: s.customer_id || s.customer_name_snapshot
      ? { id: s.customer_id, name: s.customer_name_snapshot, document: s.customer_document_snapshot } : null,
    subtotal: s.subtotal,
    discountTotal: s.discount_total,
    total: s.total,
    soldAt: s.sold_at,
    notes: s.notes,
    paymentState: s.payment_state,
    approvedAmount: s.approved_amount,
    refundedAmount: s.refunded_amount,
    ticket: s.ticket_number ? { ticketNumber: s.ticket_number, printCount: Number(s.print_count) } : null,
    void: s.status === 'VOIDED' ? { reason: s.void_reason, voidedAt: s.voided_at, voidedBy: { id: s.voided_by, fullName: s.voided_by_name } } : null,
    items: items && items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      sku: i.sku_snapshot,
      name: i.product_name_snapshot,
      quantity: Number(i.quantity),
      unitPrice: i.unit_price,
      lineSubtotal: i.line_subtotal,
      discountAmount: i.discount_amount,
      lineTotal: i.line_total,
      prescriptionReference: i.prescription_reference,
      batches: i.allocations.map((a) => ({
        allocationId: a.id, batchId: a.batch_id, batchNumber: a.batch_number_snapshot, expiryDate: a.expiry_date_snapshot,
        quantity: Number(a.quantity), saleOutMovementId: a.sale_out_id, voidInMovementId: a.void_in_id,
      })),
    })),
    payments: payments && payments.map(paymentDto),
  };
}

function paymentDto(p) {
  return {
    id: p.id,
    operationCode: p.operation_code,
    method: p.method,
    status: p.status,
    amount: p.amount,
    tenderedAmount: p.tendered_amount,
    changeAmount: p.change_amount,
    isSimulated: Boolean(Number(p.is_simulated)),
    mode: Number(p.is_simulated) ? 'DEMO' : 'REAL',
    externalReference: p.external_reference,
    failureReason: p.failure_reason,
    paidAt: p.paid_at,
    refundedAt: p.refunded_at,
    createdAt: p.created_at,
  };
}

async function loadSale(conn, id) {
  const s = await saleRepository.findSale(conn, id);
  if (!s) return null;
  return saleDto(s, await saleRepository.findItems(conn, id), await saleRepository.findPayments(conn, id));
}

// ========================================================================= venta
/** Repone cada asignación de lote con SALE_VOID_IN (la venta ya debe estar VOIDED). */
async function restockAllocations(conn, saleId, performedBy, reason) {
  const items = await saleRepository.findItems(conn, saleId);
  let count = 0;
  for (const item of items) {
    for (const a of item.allocations) {
      if (a.void_in_id) continue;
      await saleRepository.insertStockMovement(conn, {
        batchId: a.batch_id, movementType: 'SALE_VOID_IN', quantity: Number(a.quantity), saleItemBatchId: a.id, performedBy, reason,
      });
      count += 1;
    }
  }
  return { count, productIds: items.map((i) => i.product_id) };
}

/**
 * Registra una venta POS completa en UNA transacción, en el orden que exigen los triggers.
 * Si un pago simulado es rechazado, el intento queda registrado (pago REJECTED), la venta
 * se anula con sale_voids y cada lote se repone con SALE_VOID_IN, todo en la misma transacción.
 */
async function create(data, auth, ctx, { idempotencyKey } = {}) {
  return createWithOptions(data, auth, ctx, { idempotencyKey });
}

/** Ventana de fechas que admite el generador de demostración (scripts/seed-dashboard-demo.js). */
const DEMO_MAX_AGE_DAYS = 30;

/**
 * USO INTERNO EXCLUSIVO del generador de datos de demostración (no se expone en ninguna ruta ni validador).
 * Misma venta que create() —cotización, validaciones, FEFO, detalle, pagos DEMO, ticket, auditoría y
 * movimientos— con una única diferencia: sold_at toma la fecha histórica indicada, validada aquí:
 * no futura y dentro de los últimos 30 días. Las demás fechas (pagos, movimientos, auditoría) son las reales.
 */
async function createForDemo(data, auth, ctx, { idempotencyKey, soldAt } = {}) {
  const when = soldAt instanceof Date ? new Date(soldAt.getTime()) : null;
  if (!when || Number.isNaN(when.getTime())) throw AppError.badRequest('Fecha de venta de demostración inválida');
  const now = Date.now();
  if (when.getTime() > now) throw AppError.badRequest('La fecha de venta de demostración no puede ser futura');
  if (when.getTime() < now - DEMO_MAX_AGE_DAYS * 86400000) {
    throw AppError.badRequest(`La fecha de venta de demostración debe estar dentro de los últimos ${DEMO_MAX_AGE_DAYS} días`);
  }
  when.setMilliseconds(0);
  return createWithOptions(data, auth, ctx, { idempotencyKey, soldAt: when });
}

async function createWithOptions(data, auth, ctx, { idempotencyKey, soldAt = null }) {
  // Idempotencia: con la misma clave del mismo usuario se devuelve la venta ya registrada.
  // El bloqueo con nombre se toma ANTES del BEGIN y se libera DESPUÉS del COMMIT: un reintento
  // simultáneo espera y luego ve la venta ya confirmada, en lugar de duplicarla.
  paymentGateway.assertMethodsAvailable((data.payments || []).map((p) => p.method));
  const lock = idempotencyKey
    ? { name: `pp_sale_${crypto.createHash('sha1').update(`${auth.userId}:${idempotencyKey}`).digest('hex')}`.slice(0, 64), timeoutSeconds: 15 }
    : null;
  let outcome;
  try {
    outcome = await withTransaction(ctx, (conn) => createInTransaction(conn, data, auth, idempotencyKey, soldAt), { lock });
  } catch (err) {
    if (err.code === 'LOCK_TIMEOUT') throw AppError.conflict('La venta se está procesando; intente nuevamente', 'SALE_IN_PROGRESS');
    throw err;
  }
  return finishCreate(outcome);
}

async function createInTransaction(conn, data, auth, idempotencyKey, soldAt = null) {
    const branchId = await resolveBranch(auth, data.branchId, { conn });
    {
      if (idempotencyKey) {
        const existingId = await saleRepository.findByIdempotencyKey(conn, auth.userId, idempotencyKey);
        if (existingId) {
          const sale = await loadSale(conn, existingId);
          return { sale, replay: true, rejected: sale.status === 'VOIDED' && sale.payments.some((p) => p.status === 'REJECTED') };
        }
      }

      const session = await cashRepository.lockOpenSessionForSale(conn, auth.userId, branchId);
      if (!session) throw AppError.conflict('Debe abrir una sesión de caja en esta sucursal para vender', 'CASH_SESSION_REQUIRED');

      const q = await computeQuote(conn, branchId, data, auth);
      if (q.totalCents <= 0) throw new AppError(422, 'INVALID_TOTAL', 'El total de la venta debe ser mayor que 0');
      const paymentPlan = planPayments(data.payments, q.totalCents);

      let customerId = null;
      let customerName = null;
      let customerDocument = null;
      if (data.customer?.customerId) {
        const c = await saleRepository.findCustomer(conn, data.customer.customerId);
        if (!c || !Number(c.is_active)) throw AppError.badRequest('El cliente no existe o está inactivo');
        customerId = c.id; // el trigger completa los datos del cliente
      } else if (data.customer?.fullName) {
        customerName = data.customer.fullName;
        customerDocument = data.customer.documentNumber
          ? `${data.customer.documentType ?? 'OTHER'} ${data.customer.documentNumber}`.slice(0, 40) : null;
      }

      // FEFO: se bloquean (FOR UPDATE) los lotes de todos los productos antes de escribir,
      // en orden de producto para evitar interbloqueos entre ventas simultáneas.
      const allocationsByProduct = new Map();
      for (const line of [...q.lines].sort((a, b) => a.productId - b.productId)) {
        allocationsByProduct.set(line.productId, await reserveFefoInTransaction(conn, branchId, line.productId, line.quantity));
      }

      const saleNumber = await documentSequence.nextNumber(conn, branchId, 'SALE');
      const saleId = await saleRepository.insertSale(conn, {
        saleNumber, branchId, customerId, customerName, customerDocument, sellerId: auth.userId, cashSessionId: session.id,
        subtotal: fromCents(q.subtotalCents), discountTotal: fromCents(q.discountCents), total: fromCents(q.totalCents), notes: data.notes,
        soldAt,
      });

      for (const line of q.lines) {
        const saleItemId = await saleRepository.insertItem(conn, {
          saleId, productId: line.productId, name: line.name, sku: line.sku, quantity: line.quantity,
          unitPrice: fromCents(line.unitCents), lineSubtotal: fromCents(line.subtotalCents),
          discountAmount: fromCents(line.discountCents), lineTotal: fromCents(line.totalCents),
          prescriptionReference: line.prescriptionReference,
        });
        for (const alloc of allocationsByProduct.get(line.productId)) {
          const allocationId = await saleRepository.insertAllocation(conn, { saleItemId, batchId: alloc.batchId, quantity: alloc.quantity });
          await saleRepository.insertStockMovement(conn, {
            batchId: alloc.batchId, movementType: 'SALE_OUT', quantity: alloc.quantity, saleItemBatchId: allocationId,
            performedBy: auth.userId, reason: `Venta ${saleNumber}`,
          });
        }
      }

      // ------------------------------------------------------------------ pagos
      const rejected = paymentPlan.some((p) => p.outcome === 'REJECT');
      for (const p of paymentPlan) {
        const operationCode = await documentSequence.nextNumber(conn, branchId, 'PAYMENT');
        const electronic = p.method !== 'CASH';
        const status = !rejected ? 'APPROVED' : p.outcome === 'REJECT' ? 'REJECTED' : 'PENDING';
        const paymentId = await saleRepository.insertPayment(conn, {
          operationCode, saleId, cashSessionId: session.id, method: p.method, status,
          amount: fromCents(p.amountCents),
          tenderedAmount: p.tenderedCents !== undefined ? fromCents(p.tenderedCents) : null,
          changeAmount: p.changeCents !== undefined ? fromCents(p.changeCents) : null,
          isSimulated: electronic,
          externalReference: electronic ? demoReference(p.method) : null,
          failureReason: status === 'REJECTED' ? DEMO_REJECTION : null,
          processedBy: auth.userId,
        });
        // Los demás pagos de un intento rechazado no se cobran: quedan CANCELLED (trazables).
        if (status === 'PENDING') await saleRepository.cancelPayment(conn, paymentId, 'Cancelado: otro pago del intento fue rechazado');
      }

      if (rejected) {
        await saleRepository.insertVoid(conn, { saleId, reason: `Pago rechazado (DEMO). ${DEMO_REJECTION}`, voidedBy: auth.userId });
        await restockAllocations(conn, saleId, auth.userId, `Reposición: pago rechazado en ${saleNumber}`);
        await auditRepository.log(conn, {
          action: 'PAYMENT_REJECTED', module: 'sales', table: 'sales', entityId: saleId,
          newValues: { sale_number: saleNumber, total: fromCents(q.totalCents), methods: paymentPlan.map((p) => p.method) },
        });
        return { sale: await loadSale(conn, saleId), rejected: true, replay: false };
      }

      const ticketNumber = await documentSequence.nextNumber(conn, branchId, 'TICKET');
      await saleRepository.insertTicket(conn, {
        ticketNumber, saleId, issuedBy: auth.userId, legend: await saleRepository.getSetting(conn, 'tickets.legend'),
      });
      // La inserción de ventas no tiene trigger de auditoría.
      await auditRepository.log(conn, {
        action: 'CREATE', module: 'sales', table: 'sales', entityId: saleId,
        newValues: {
          sale_number: saleNumber, branch_id: branchId, cash_session_id: session.id, subtotal: fromCents(q.subtotalCents),
          discount_total: fromCents(q.discountCents), total: fromCents(q.totalCents), lines: q.lines.length,
          payments: paymentPlan.map((p) => ({ method: p.method, amount: fromCents(p.amountCents) })),
        },
      });
      return { sale: await loadSale(conn, saleId), rejected: false, replay: false };
    }
}

/** Después del COMMIT: error de pago rechazado o notificaciones de la venta confirmada. */
function finishCreate(outcome) {
  const { sale } = outcome;
  if (outcome.rejected) {
    throw new AppError(422, 'PAYMENT_REJECTED', 'El pago fue rechazado (simulación DEMO). La venta se anuló y el stock fue repuesto.', {
      saleId: sale.id, saleNumber: sale.saleNumber, status: sale.status,
      payments: sale.payments.map((p) => ({ method: p.method, status: p.status, amount: p.amount, failureReason: p.failureReason })),
    });
  }
  if (!outcome.replay) {
    // Solo después del COMMIT.
    emitToBranch(sale.branch.id, 'sale:created', { saleId: sale.id, saleNumber: sale.saleNumber, total: sale.total });
    emitInventoryChanged(sale.branch.id, { source: 'sale', saleId: sale.id, productIds: sale.items.map((i) => i.productId) });
  }
  return { ...sale, idempotentReplay: outcome.replay };
}

// ===================================================================== anulación
/**
 * Anula una venta COMPLETED: sale_voids (el trigger la marca VOIDED y audita), repone cada lote
 * con SALE_VOID_IN y reembolsa los pagos aprobados (efectivo: desde la caja abierta del usuario;
 * DEMO electrónico: reembolso simulado). Todo en una transacción.
 */
async function voidSale(id, reason, auth, ctx) {
  const result = await withTransaction(ctx, (conn) => voidSaleInTransaction(conn, id, reason, auth));
  emitToBranch(result.sale.branch.id, 'sale:voided', { saleId: result.sale.id, saleNumber: result.sale.saleNumber });
  emitInventoryChanged(result.sale.branch.id, { source: 'sale_void', saleId: result.sale.id, productIds: result.productIds });
  return result.sale;
}

/** Anulación dentro de una transacción existente (la reutiliza la cancelación de pedidos online). */
async function voidSaleInTransaction(conn, id, reason, auth) {
  {
    const locked = await saleRepository.lockSale(conn, id);
    if (!locked) throw AppError.notFound('Venta no encontrada');
    await assertBranchAccessInTx(conn, auth, locked.branch_id);
    if (locked.status !== 'COMPLETED') throw AppError.conflict('La venta ya está anulada', 'SALE_ALREADY_VOIDED');
    if ((await saleRepository.countActiveReturns(conn, id)) > 0) {
      throw AppError.conflict('La venta tiene devoluciones registradas; no puede anularse', 'SALE_HAS_RETURNS');
    }

    const payments = await saleRepository.findPayments(conn, id);
    const approved = payments.filter((p) => p.status === 'APPROVED');
    if (approved.length > 0 && !auth.permissions.has('payments.refund')) {
      throw AppError.forbidden('La venta tiene pagos aprobados y no tiene permiso para reembolsarlos', 'PERMISSION_DENIED');
    }
    let refundSession = null;
    if (approved.some((p) => p.method === 'CASH')) {
      refundSession = await cashRepository.lockOpenSessionForSale(conn, auth.userId, locked.branch_id);
      if (!refundSession) {
        throw AppError.conflict('Para reembolsar efectivo debe tener una sesión de caja abierta en la sucursal', 'CASH_SESSION_REQUIRED');
      }
    }

    await saleRepository.insertVoid(conn, { saleId: id, reason, voidedBy: auth.userId });
    const restock = await restockAllocations(conn, id, auth.userId, `Anulación ${locked.sale_number}`);
    for (const p of approved) {
      // Efectivo: el trigger registra PAYMENT_REFUND y valida que haya fondos en la caja.
      await saleRepository.refundPayment(conn, p.id, p.method === 'CASH' ? refundSession.id : null);
    }
    for (const p of payments.filter((x) => x.status === 'PENDING')) {
      await saleRepository.cancelPayment(conn, p.id, 'Cancelado por anulación de la venta');
    }
    return { sale: await loadSale(conn, id), productIds: restock.productIds };
  }
}

async function get(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const sale = await loadSale(conn, id);
    if (!sale) throw AppError.notFound('Venta no encontrada');
    assertBranchAccess(auth, sale.branch.id);
    return sale;
  });
}

async function list(filters, auth, ctx) {
  const branchId = filters.branchId ? await resolveBranch(auth, filters.branchId) : undefined;
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await saleRepository.list(conn, { ...filters, branchId, branchIds: branchId ? null : visibleBranchIds(auth) });
    return paginated(rows.map((r) => saleDto(r)), total, filters);
  });
}

async function payments(filters, auth, ctx) {
  const branchId = filters.branchId ? await resolveBranch(auth, filters.branchId) : undefined;
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await saleRepository.listPayments(conn, { ...filters, branchId, branchIds: branchId ? null : visibleBranchIds(auth) });
    return paginated(rows.map((p) => ({
      ...paymentDto(p), saleId: p.sale_id, saleNumber: p.sale_number, branchId: p.branch_id,
      processedBy: p.processed_by ? { id: p.processed_by, fullName: p.processed_by_name } : null,
      cashSessionId: p.cash_session_id, refundCashSessionId: p.refund_cash_session_id,
    })), total, filters);
  });
}

module.exports = {
  quote, catalog, create, createForDemo, DEMO_MAX_AGE_DAYS, voidSale, voidSaleInTransaction, get, list, payments, computeQuote, planPayments, loadSale,
  restockAllocations, demoReference,
};
