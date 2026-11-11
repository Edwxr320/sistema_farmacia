'use strict';

const crypto = require('node:crypto');
const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const { toCents, fromCents } = require('../utils/money');
const orderRepository = require('../repositories/order.repository');
const storeRepository = require('../repositories/store.repository');
const saleRepository = require('../repositories/sale.repository');
const inventoryRepository = require('../repositories/inventory.repository');
const cashRepository = require('../repositories/cash.repository');
const customerRepository = require('../repositories/customer.repository');
const documentSequence = require('../repositories/document-sequence.repository');
const auditRepository = require('../repositories/audit.repository');
const { requireCustomer, addressDto } = require('./customer.service');
const { resolveStoreBranch } = require('./store.service');
const { reserveFefoInTransaction } = require('./inventory.service');
const { voidSaleInTransaction, restockAllocations } = require('./sale.service');
const { assertBranchAccess, assertBranchAccessInTx, visibleBranchIds, resolveBranch } = require('./branch-access.service');
const { emitToBranch, emitToUser, emitInventoryChanged } = require('./realtime.service');

const DEMO_REJECTION = 'DEMO: operación rechazada por el emisor simulado';

// ------------------------------------------------------------------- DTOs
function orderDto(o, { items, history, payments, internal = false } = {}) {
  const dto = {
    id: o.id,
    orderNumber: o.order_number,
    status: o.status,
    fulfillmentType: o.fulfillment_type,
    branch: { id: o.branch_id, name: o.branch_name },
    delivery: o.fulfillment_type === 'DELIVERY' ? {
      recipientName: o.delivery_recipient_name, phone: o.delivery_phone, addressLine: o.delivery_address_line,
      reference: o.delivery_reference, district: o.delivery_district, province: o.delivery_province, department: o.delivery_department,
    } : null,
    subtotal: o.subtotal,
    deliveryFee: o.delivery_fee,
    total: o.total,
    paidAmount: o.paid_amount,
    balanceDue: fromCents(toCents(o.total) - toCents(o.paid_amount)),
    customerNote: o.customer_note,
    createdAt: o.created_at,
    confirmedAt: o.confirmed_at,
    completedAt: o.completed_at,
    cancelledAt: o.cancelled_at,
    cancelReason: o.cancel_reason,
    itemsCount: Number(o.items_count),
  };
  if (internal) {
    Object.assign(dto, {
      customer: { id: o.customer_id, userId: o.customer_user_id, name: o.customer_name, phone: o.customer_phone },
      sale: o.sale_id ? { id: o.sale_id, saleNumber: o.sale_number, status: o.sale_status } : null,
      assignedUser: o.assigned_user_id ? { id: o.assigned_user_id, fullName: o.assigned_user_name } : null,
      internalNote: o.internal_note,
      confirmedBy: o.confirmed_by,
      cancelledBy: o.cancelled_by,
    });
  }
  if (items) {
    dto.items = items.map((i) => ({
      productId: i.product_id, sku: i.sku_snapshot, name: i.product_name_snapshot, quantity: Number(i.quantity),
      unitPrice: i.unit_price, lineTotal: i.line_total, requiresPrescription: Boolean(Number(i.requires_prescription)),
    }));
  }
  if (history) {
    dto.history = history.map((h) => ({
      from: h.from_status, to: h.to_status, at: h.changed_at, note: h.note,
      by: h.changed_by ? (internal ? { id: h.changed_by, fullName: h.changed_by_name, role: h.changed_by_role } : { role: h.changed_by_role === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF' }) : null,
    }));
  }
  if (payments) {
    dto.payments = payments.map((p) => ({
      id: p.id, operationCode: p.operation_code, method: p.method, status: p.status, amount: p.amount,
      mode: Number(p.is_simulated) ? 'DEMO' : 'REAL', reference: p.external_reference, failureReason: p.failure_reason,
      tenderedAmount: p.tendered_amount, changeAmount: p.change_amount, paidAt: p.paid_at, refundedAt: p.refunded_at,
    }));
  }
  return dto;
}

async function loadOrder(conn, id, internal) {
  const o = await orderRepository.findById(conn, id);
  if (!o) return null;
  return orderDto(o, {
    internal,
    items: await orderRepository.items(conn, id),
    history: await orderRepository.history(conn, id),
    payments: await orderRepository.payments(conn, id),
  });
}

// --------------------------------------------------------------- cobertura
/**
 * Cobertura de delivery (configuración existente, sin datos inventados):
 * - Si existe settings 'orders.delivery_districts' (JSON con distritos), el distrito debe estar en la lista.
 * - Si no, y la sucursal tiene provincia registrada, la dirección debe ser de esa provincia.
 */
async function assertCoverage(conn, branch, address) {
  const raw = await saleRepository.getSetting(conn, 'orders.delivery_districts');
  const norm = (s) => String(s || '').trim().toLowerCase();
  if (raw) {
    let list = [];
    try { list = JSON.parse(raw); } catch { list = []; }
    if (!Array.isArray(list) || !list.map(norm).includes(norm(address.district))) {
      throw new AppError(422, 'OUT_OF_COVERAGE', 'La dirección está fuera de la zona de reparto', { districts: list });
    }
    return;
  }
  if (branch.province && address.province && norm(branch.province) !== norm(address.province)) {
    throw new AppError(422, 'OUT_OF_COVERAGE', 'La dirección está fuera de la zona de reparto de la sucursal');
  }
}

// ---------------------------------------------------------------- checkout
/**
 * Checkout: crea el pedido PENDING (no descuenta stock, como define la base) en UNA transacción.
 * - Precios y totales desde MariaDB; si el total cambió respecto del que vio el cliente → 409 PRICE_CHANGED.
 * - Bloquea los lotes vendibles (FOR UPDATE) y descuenta lo comprometido en otros pedidos PENDING:
 *   dos clientes no pueden comprometer las mismas últimas unidades.
 * - Pago electrónico DEMO al confirmar el pedido; efectivo se cobra al recoger o entregar.
 * - Idempotency-Key: un reintento devuelve el mismo pedido (bloqueo con nombre hasta el COMMIT).
 */
async function checkout(data, auth, ctx, { idempotencyKey } = {}) {
  const lock = idempotencyKey
    ? { name: `pp_order_${crypto.createHash('sha1').update(`${auth.userId}:${idempotencyKey}`).digest('hex')}`.slice(0, 64), timeoutSeconds: 15 }
    : null;
  let outcome;
  try {
    outcome = await withTransaction(ctx, (conn) => checkoutInTransaction(conn, data, auth, idempotencyKey), { lock });
  } catch (err) {
    if (err.code === 'LOCK_TIMEOUT') throw AppError.conflict('El pedido se está procesando; intente nuevamente', 'ORDER_IN_PROGRESS');
    throw err;
  }
  if (outcome.rejected) {
    throw new AppError(422, 'PAYMENT_REJECTED', 'El pago fue rechazado (simulación DEMO). El pedido se canceló; su carrito se conserva.', {
      orderId: outcome.order.id, orderNumber: outcome.order.orderNumber, status: outcome.order.status,
    });
  }
  if (!outcome.replay) {
    emitToBranch(outcome.order.branch.id, 'order:created', { orderId: outcome.order.id, orderNumber: outcome.order.orderNumber, total: outcome.order.total });
  }
  return { ...outcome.order, idempotentReplay: outcome.replay };
}

async function checkoutInTransaction(conn, data, auth, idempotencyKey) {
  const customer = await requireCustomer(conn, auth);
  if (idempotencyKey) {
    const existingId = await orderRepository.findByIdempotencyKey(conn, auth.userId, idempotencyKey);
    if (existingId) {
      const order = await loadOrder(conn, existingId, false);
      return { order, replay: true, rejected: order.status === 'CANCELLED' && order.payments.some((p) => p.status === 'REJECTED') };
    }
  }

  const cart = await storeRepository.findActiveCart(conn, customer.id, { forUpdate: true });
  const branch = await resolveStoreBranch(conn, data.branchId ?? cart?.branch_id);
  const cartRows = cart ? await storeRepository.cartItems(conn, cart.id, branch.id) : [];
  if (cartRows.length === 0) throw AppError.conflict('El carrito está vacío', 'CART_EMPTY');

  // Productos y precios reales de la sucursal elegida.
  const products = new Map((await saleRepository.productsForSale(conn, branch.id, cartRows.map((r) => r.product_id))).map((p) => [p.id, p]));
  const rxSetting = (await saleRepository.getSetting(conn, 'sales.require_prescription_reference')) ?? 'true';
  const prescriptions = data.prescriptions || {};
  const lines = cartRows.map((r) => {
    const p = products.get(r.product_id);
    if (!p || p.status !== 'ACTIVE' || !Number(p.is_available)) {
      throw new AppError(422, 'PRODUCT_NOT_AVAILABLE', `${r.name} ya no está disponible en ${branch.name}`, { productId: r.product_id });
    }
    if (Number(p.requires_prescription) && rxSetting === 'true' && !prescriptions[String(p.id)]) {
      throw new AppError(422, 'PRESCRIPTION_REQUIRED', `${p.name} requiere receta médica: indique el número de receta`, { productId: p.id });
    }
    const unit = toCents(p.price);
    return { productId: p.id, sku: p.sku, name: p.name, quantity: Number(r.quantity), unit, total: unit * Number(r.quantity), rx: Number(p.requires_prescription) === 1 };
  });

  // Stock: PRIMERO se bloquean los lotes vendibles (orden de producto; serializa checkouts y ventas
  // concurrentes del mismo producto) y DESPUÉS se leen, con lectura bloqueante, las unidades ya
  // comprometidas en pedidos PENDING (incluidos los que otra transacción acaba de confirmar).
  const sellable = new Map();
  for (const l of [...lines].sort((a, b) => a.productId - b.productId)) {
    const locked = await inventoryRepository.lockFefoBatches(conn, branch.id, l.productId);
    sellable.set(l.productId, locked.reduce((a, b) => a + Number(b.current_quantity), 0));
  }
  const reserved = await storeRepository.reservedByProducts(conn, branch.id, lines.map((l) => l.productId), { locking: true });
  const shortages = [];
  for (const l of lines) {
    const available = sellable.get(l.productId) - (reserved.get(l.productId) ?? 0);
    if (l.quantity > available) shortages.push({ productId: l.productId, name: l.name, requested: l.quantity, available: Math.max(available, 0) });
  }
  if (shortages.length > 0) throw new AppError(422, 'INSUFFICIENT_STOCK', 'Algunos productos ya no tienen stock suficiente', { items: shortages });

  let address = null;
  let deliveryFee = 0;
  if (data.fulfillmentType === 'DELIVERY') {
    address = await customerRepository.findAddress(conn, customer.id, data.addressId);
    if (!address) throw AppError.badRequest('La dirección no existe o no le pertenece');
    await assertCoverage(conn, branch, address);
    deliveryFee = toCents((await saleRepository.getSetting(conn, 'orders.default_delivery_fee')) ?? '0');
  }
  const subtotal = lines.reduce((a, l) => a + l.total, 0);
  const total = subtotal + deliveryFee;
  if (data.expectedTotal !== undefined) {
    let expected = null;
    try { expected = toCents(data.expectedTotal); } catch { expected = null; }
    if (expected !== total) {
      throw new AppError(409, 'PRICE_CHANGED', 'Los precios o el costo de envío cambiaron; revise el nuevo total', { total: fromCents(total) });
    }
  }

  const rxNote = lines.filter((l) => l.rx).map((l) => `${l.sku}: ${prescriptions[String(l.productId)]}`).join('; ');
  const note = [data.customerNote, rxNote ? `Recetas declaradas — ${rxNote}` : null].filter(Boolean).join(' | ').slice(0, 500) || null;
  const orderNumber = await documentSequence.nextNumber(conn, branch.id, 'ORDER');
  const orderId = await orderRepository.insertOrder(conn, {
    orderNumber, customerId: customer.id, branchId: branch.id, fulfillmentType: data.fulfillmentType,
    addressId: address ? address.id : null, subtotal: fromCents(subtotal), deliveryFee: fromCents(deliveryFee), total: fromCents(total), customerNote: note,
  });
  for (const l of lines) {
    await orderRepository.insertItem(conn, {
      orderId, productId: l.productId, name: l.name, sku: l.sku, quantity: l.quantity, unitPrice: fromCents(l.unit), lineTotal: fromCents(l.total),
    });
  }

  let rejected = false;
  if (data.paymentMethod !== 'CASH') {
    rejected = data.simulatePayment === 'REJECT';
    await orderRepository.insertPayment(conn, {
      operationCode: await documentSequence.nextNumber(conn, branch.id, 'PAYMENT'),
      orderId, method: data.paymentMethod, status: rejected ? 'REJECTED' : 'APPROVED', amount: fromCents(total), isSimulated: true,
      externalReference: `DEMO-${data.paymentMethod}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      failureReason: rejected ? DEMO_REJECTION : null,
    });
  }

  if (rejected) {
    // El intento queda registrado; el pedido se cancela y el carrito se conserva para reintentar.
    await orderRepository.setStatus(conn, orderId, 'PENDING', 'CANCELLED', { cancel_reason: 'Pago rechazado (DEMO)' });
    await auditRepository.log(conn, {
      action: 'PAYMENT_REJECTED', module: 'orders', table: 'orders', entityId: orderId,
      newValues: { order_number: orderNumber, method: data.paymentMethod, total: fromCents(total) },
    });
    return { order: await loadOrder(conn, orderId, false), rejected: true, replay: false };
  }

  await storeRepository.markConverted(conn, cart.id);
  await auditRepository.log(conn, {
    action: 'CREATE', module: 'orders', table: 'orders', entityId: orderId,
    newValues: { order_number: orderNumber, branch_id: branch.id, fulfillment: data.fulfillmentType, total: fromCents(total), payment: data.paymentMethod },
  });
  return { order: await loadOrder(conn, orderId, false), rejected: false, replay: false };
}

// ------------------------------------------------------------ vista cliente
async function myOrders(auth, filters, ctx) {
  return withConnection(ctx, async (conn) => {
    const customer = await requireCustomer(conn, auth);
    const { rows, total } = await orderRepository.list(conn, { ...filters, customerId: customer.id });
    return paginated(rows.map((o) => orderDto(o)), total, filters);
  });
}

async function myOrder(auth, id, ctx) {
  return withConnection(ctx, async (conn) => {
    const customer = await requireCustomer(conn, auth);
    const o = await orderRepository.findById(conn, id);
    if (!o || o.customer_id !== customer.id) throw AppError.notFound('Pedido no encontrado');
    return loadOrder(conn, id, false);
  });
}

async function refundApprovedOrderPayments(conn, orderId) {
  const pays = await orderRepository.payments(conn, orderId);
  for (const p of pays.filter((x) => x.status === 'APPROVED' && !x.sale_id)) {
    if (p.method === 'CASH') throw AppError.conflict('El pedido tiene un cobro en efectivo; gestione el reembolso en caja', 'CASH_REFUND_REQUIRED');
    await orderRepository.refundOrderPayment(conn, p.id); // reembolso DEMO simulado
  }
}

/** El cliente solo cancela pedidos PENDING (aún sin venta ni stock descontado). */
async function cancelMine(auth, id, reason, ctx) {
  const order = await withTransaction(ctx, async (conn) => {
    const customer = await requireCustomer(conn, auth);
    const o = await orderRepository.lockById(conn, id);
    if (!o || o.customer_id !== customer.id) throw AppError.notFound('Pedido no encontrado');
    if (o.status !== 'PENDING') {
      throw AppError.conflict('El pedido ya fue aceptado por la botica; comuníquese con la sucursal para cancelarlo', 'ORDER_NOT_CANCELLABLE');
    }
    await refundApprovedOrderPayments(conn, id);
    await orderRepository.setStatus(conn, id, 'PENDING', 'CANCELLED', { cancel_reason: `Cancelado por el cliente: ${reason}`.slice(0, 500) });
    return loadOrder(conn, id, false);
  });
  emitToBranch(order.branch.id, 'order:status', { orderId: id, status: order.status });
  return order;
}

// ------------------------------------------------------------- panel admin
async function lockForStaff(conn, id, auth) {
  const o = await orderRepository.lockById(conn, id);
  if (!o) throw AppError.notFound('Pedido no encontrado');
  await assertBranchAccessInTx(conn, auth, o.branch_id);
  return o;
}

function notifyStatus(order) {
  const payload = { orderId: order.id, orderNumber: order.orderNumber, status: order.status };
  emitToBranch(order.branch.id, 'order:status', payload);
  // Aviso al cliente dueño del pedido (solo id, número y estado).
  if (order.customer && order.customer.userId) emitToUser(order.customer.userId, 'order:status', payload);
}

async function list(filters, auth, ctx) {
  const branchId = filters.branchId ? await resolveBranch(auth, filters.branchId) : undefined;
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await orderRepository.list(conn, { ...filters, branchId, branchIds: branchId ? null : visibleBranchIds(auth) });
    return paginated(rows.map((o) => orderDto(o, { internal: true })), total, filters);
  });
}

async function get(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const o = await orderRepository.findById(conn, id);
    if (!o) throw AppError.notFound('Pedido no encontrado');
    assertBranchAccess(auth, o.branch_id);
    const dto = await loadOrder(conn, id, true);
    if (o.address_id) {
      const [rows] = await conn.execute('SELECT * FROM customer_addresses WHERE id = ?', [o.address_id]);
      if (rows[0]) dto.address = addressDto(rows[0]);
    }
    return dto;
  });
}

/**
 * Aceptar (confirmar) un pedido PENDING: venta ONLINE con FEFO y SALE_OUT (descuenta stock UNA vez),
 * enlace de pagos y estado CONFIRMED (el trigger exige que la venta exista). El personal valida
 * la receta de los productos que la requieren.
 */
async function accept(id, { prescriptions = {}, note } = {}, auth, ctx) {
  const result = await withTransaction(ctx, async (conn) => {
    const o = await lockForStaff(conn, id, auth);
    if (o.status !== 'PENDING') throw AppError.conflict('Solo se aceptan pedidos pendientes', 'ORDER_INVALID_STATE');
    const items = await orderRepository.items(conn, id);
    const rxSetting = (await saleRepository.getSetting(conn, 'sales.require_prescription_reference')) ?? 'true';
    for (const it of items) {
      if (Number(it.requires_prescription) && rxSetting === 'true' && !prescriptions[String(it.product_id)]) {
        throw new AppError(422, 'PRESCRIPTION_REQUIRED', `Valide la receta de ${it.product_name_snapshot} (prescriptions)`, { productId: it.product_id });
      }
    }
    const allocations = new Map();
    for (const it of [...items].sort((a, b) => a.product_id - b.product_id)) {
      allocations.set(it.product_id, await reserveFefoInTransaction(conn, o.branch_id, it.product_id, Number(it.quantity)));
    }
    const saleNumber = await documentSequence.nextNumber(conn, o.branch_id, 'SALE');
    const saleId = await saleRepository.insertOnlineSale(conn, {
      saleNumber, branchId: o.branch_id, orderId: id, customerId: o.customer_id, sellerId: auth.userId,
      subtotal: o.subtotal, deliveryFee: o.delivery_fee, total: o.total, notes: `Pedido ${o.order_number}`,
    });
    for (const it of items) {
      const saleItemId = await saleRepository.insertItem(conn, {
        saleId, productId: it.product_id, name: it.product_name_snapshot, sku: it.sku_snapshot, quantity: Number(it.quantity),
        unitPrice: it.unit_price, lineSubtotal: it.line_total, discountAmount: '0.00', lineTotal: it.line_total,
        prescriptionReference: prescriptions[String(it.product_id)] ?? null,
      });
      for (const a of allocations.get(it.product_id)) {
        const allocationId = await saleRepository.insertAllocation(conn, { saleItemId, batchId: a.batchId, quantity: a.quantity });
        await saleRepository.insertStockMovement(conn, {
          batchId: a.batchId, movementType: 'SALE_OUT', quantity: a.quantity, saleItemBatchId: allocationId,
          performedBy: auth.userId, reason: `Pedido ${o.order_number}`,
        });
      }
    }
    await orderRepository.linkPaymentsToSale(conn, id, saleId);
    await orderRepository.setStatus(conn, id, 'PENDING', 'CONFIRMED', note ? { internal_note: note.slice(0, 500) } : {});
    await auditRepository.log(conn, {
      action: 'CONFIRM', module: 'orders', table: 'orders', entityId: id, newValues: { sale_id: saleId, sale_number: saleNumber },
    });
    return { order: await loadOrder(conn, id, true), productIds: items.map((i) => i.product_id) };
  });
  notifyStatus(result.order);
  emitInventoryChanged(result.order.branch.id, { source: 'order', orderId: id, productIds: result.productIds });
  return result.order;
}

async function reject(id, reason, auth, ctx) {
  const order = await withTransaction(ctx, async (conn) => {
    const o = await lockForStaff(conn, id, auth);
    if (o.status !== 'PENDING') throw AppError.conflict('Solo se rechazan pedidos pendientes', 'ORDER_INVALID_STATE');
    if ((await orderRepository.payments(conn, id)).some((p) => p.status === 'APPROVED') && !auth.permissions.has('payments.refund')) {
      throw AppError.forbidden('El pedido tiene un pago aprobado y no tiene permiso para reembolsarlo', 'PERMISSION_DENIED');
    }
    await refundApprovedOrderPayments(conn, id);
    await orderRepository.setStatus(conn, id, 'PENDING', 'REJECTED', { cancel_reason: reason });
    return loadOrder(conn, id, true);
  });
  notifyStatus(order);
  return order;
}

async function prepare(id, auth, ctx) {
  const order = await withTransaction(ctx, async (conn) => {
    const o = await lockForStaff(conn, id, auth);
    if (o.status !== 'CONFIRMED') throw AppError.conflict('Solo se preparan pedidos confirmados', 'ORDER_INVALID_STATE');
    if (!o.assigned_user_id) await orderRepository.setAssigned(conn, id, auth.userId);
    await orderRepository.setStatus(conn, id, 'CONFIRMED', 'PREPARING');
    return loadOrder(conn, id, true);
  });
  notifyStatus(order);
  return order;
}

/** Listo: READY_FOR_PICKUP (recojo) u OUT_FOR_DELIVERY (delivery), según la modalidad. */
async function ready(id, auth, ctx) {
  const order = await withTransaction(ctx, async (conn) => {
    const o = await lockForStaff(conn, id, auth);
    if (o.status !== 'PREPARING') throw AppError.conflict('El pedido debe estar en preparación', 'ORDER_INVALID_STATE');
    await orderRepository.setStatus(conn, id, 'PREPARING', o.fulfillment_type === 'PICKUP' ? 'READY_FOR_PICKUP' : 'OUT_FOR_DELIVERY');
    return loadOrder(conn, id, true);
  });
  notifyStatus(order);
  return order;
}

/**
 * Entrega o recojo. Si hay saldo (pago en efectivo contra entrega), se cobra en la caja abierta
 * del trabajador: pago CASH APPROVED sobre la venta; el trigger registra el ingreso en caja.
 */
async function complete(id, { tenderedAmount } = {}, auth, ctx) {
  const order = await withTransaction(ctx, async (conn) => {
    const o = await lockForStaff(conn, id, auth);
    if (!['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'].includes(o.status)) {
      throw AppError.conflict('El pedido debe estar listo para recojo o en reparto', 'ORDER_INVALID_STATE');
    }
    const current = await orderRepository.findById(conn, id);
    const due = toCents(current.total) - toCents(current.paid_amount);
    if (due > 0) {
      if (!auth.permissions.has('payments.register')) throw AppError.forbidden('No tiene permiso para registrar cobros', 'PERMISSION_DENIED');
      const session = await cashRepository.lockOpenSessionForSale(conn, auth.userId, o.branch_id);
      if (!session) throw AppError.conflict('Para cobrar en efectivo debe tener una caja abierta en la sucursal', 'CASH_SESSION_REQUIRED');
      const tendered = tenderedAmount === undefined ? due : toCents(tenderedAmount);
      if (tendered < due) throw new AppError(422, 'INSUFFICIENT_TENDERED', 'El efectivo recibido es menor que el saldo del pedido', { due: fromCents(due) });
      await saleRepository.insertPayment(conn, {
        operationCode: await documentSequence.nextNumber(conn, o.branch_id, 'PAYMENT'), saleId: current.sale_id, cashSessionId: session.id,
        method: 'CASH', status: 'APPROVED', amount: fromCents(due), tenderedAmount: fromCents(tendered), changeAmount: fromCents(tendered - due),
        isSimulated: false, processedBy: auth.userId,
      });
    }
    await orderRepository.setStatus(conn, id, o.status, 'COMPLETED');
    // Ticket interno de la venta del pedido.
    const [[t]] = await conn.execute('SELECT COUNT(*) c FROM sale_tickets WHERE sale_id = ?', [current.sale_id]);
    if (Number(t.c) === 0) {
      await saleRepository.insertTicket(conn, {
        ticketNumber: await documentSequence.nextNumber(conn, o.branch_id, 'TICKET'), saleId: current.sale_id, issuedBy: auth.userId,
        legend: await saleRepository.getSetting(conn, 'tickets.legend'),
      });
    }
    return loadOrder(conn, id, true);
  });
  notifyStatus(order);
  return order;
}

/**
 * Cancelación por el personal. Si ya hubo venta (CONFIRMED en adelante), primero se anula la venta:
 * SALE_VOID_IN repone cada lote una sola vez y los pagos aprobados se reembolsan; luego CANCELLED.
 */
async function cancelByStaff(id, reason, auth, ctx) {
  const result = await withTransaction(ctx, async (conn) => {
    const o = await lockForStaff(conn, id, auth);
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status)) throw AppError.conflict('El pedido está en un estado final', 'ORDER_INVALID_STATE');
    const current = await orderRepository.findById(conn, id);
    let productIds = [];
    if (current.sale_id && current.sale_status === 'COMPLETED') {
      const voided = await voidSaleInTransaction(conn, current.sale_id, `Cancelación del pedido ${o.order_number}: ${reason}`.slice(0, 500), auth);
      productIds = voided.productIds;
    } else {
      await refundApprovedOrderPayments(conn, id);
    }
    await orderRepository.setStatus(conn, id, o.status, 'CANCELLED', { cancel_reason: reason });
    return { order: await loadOrder(conn, id, true), productIds };
  });
  notifyStatus(result.order);
  if (result.productIds.length) emitInventoryChanged(result.order.branch.id, { source: 'order_cancel', orderId: id, productIds: result.productIds });
  return result.order;
}

async function assign(id, userId, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const o = await lockForStaff(conn, id, auth);
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status)) throw AppError.conflict('El pedido está en un estado final', 'ORDER_INVALID_STATE');
    const [rows] = await conn.execute(
      `SELECT u.id FROM users u JOIN user_branches ub ON ub.user_id = u.id JOIN roles r ON r.id = u.role_id
        WHERE u.id = ? AND ub.branch_id = ? AND u.status = 'ACTIVE' AND r.code <> 'CUSTOMER'`,
      [userId, o.branch_id],
    );
    if (rows.length === 0) throw AppError.badRequest('El trabajador no existe o no pertenece a la sucursal del pedido');
    await orderRepository.setAssigned(conn, id, userId); // el trigger audita la asignación
    return loadOrder(conn, id, true);
  });
}

module.exports = {
  checkout, myOrders, myOrder, cancelMine, list, get, accept, reject, prepare, ready, complete, cancelByStaff, assign,
  restockAllocations,
};
