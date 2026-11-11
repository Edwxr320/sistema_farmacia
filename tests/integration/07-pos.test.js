'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { closePool } = require('../../src/config/database');
const { config } = require('../../src/config/env');
const { createApp } = require('../../src/app');
const { initRealtime, closeRealtime, onEmit } = require('../../src/services/realtime.service');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const { loginClient, stockedProduct, uid } = require('../helpers/http');

const PASSWORD = 'Farmacia2026Segura';
let tx;
let app;
let admin;
let staff;
let outsider;
const ctx = {};
const events = [];

const n = (v) => Number(v);

async function stockOf(productId) {
  const [[r]] = await tx.conn.execute(
    "SELECT COALESCE(SUM(current_quantity), 0) q FROM product_batches WHERE product_id = ? AND branch_id = 1", [productId]);
  return n(r.q);
}

async function batchQty(productId, batchNumber) {
  const [[r]] = await tx.conn.execute('SELECT current_quantity q FROM product_batches WHERE product_id = ? AND batch_number = ?', [productId, batchNumber]);
  return n(r.q);
}

async function cashMovements(paymentId) {
  const [rows] = await tx.conn.execute('SELECT movement_type, amount, cash_session_id FROM cash_movements WHERE payment_id = ? ORDER BY id', [paymentId]);
  return rows;
}

async function count(sql, params = []) {
  const [[r]] = await tx.conn.execute(sql, params);
  return n(Object.values(r)[0]);
}

const cash = (amount, tenderedAmount) => ({ method: 'CASH', ...(amount ? { amount } : {}), ...(tenderedAmount ? { tenderedAmount } : {}) });

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  const s = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  ctx.adminId = a.id;
  ctx.staffId = s.id;
  // Sucursal y caja temporales (se revierten): un trabajador de otra sucursal y una segunda caja en SP01.
  await tx.conn.execute("INSERT INTO branches (code, name, status) VALUES ('QA09', 'QA Sucursal Externa', 'ACTIVE')");
  const [[b2]] = await tx.conn.execute("SELECT id FROM branches WHERE code = 'QA09'");
  ctx.branch2 = b2.id;
  const o = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD, withBranch: false });
  await tx.conn.execute('INSERT INTO user_branches (user_id, branch_id, is_default) VALUES (?, ?, TRUE)', [o.id, ctx.branch2]);
  const [reg] = await tx.conn.execute("INSERT INTO cash_registers (branch_id, code, name) VALUES (1, 'QA02', 'Caja de pruebas')");
  ctx.register2 = reg.insertId;
  const [[caja01]] = await tx.conn.execute("SELECT id FROM cash_registers WHERE branch_id = 1 AND code = 'CAJA01'");
  ctx.caja01 = caja01.id;

  admin = await loginClient(app, a);
  staff = await loginClient(app, s);
  outsider = await loginClient(app, o);

  const base = await stockedProduct(admin, { salePrice: '2.00', minimumStock: 5, batches: [
    { batchNumber: 'P1-A', days: 30, quantity: 20 }, { batchNumber: 'P1-B', days: 200, quantity: 30 }] });
  ctx.p1 = base.productId;
  const common = { categoryId: base.categoryId, supplierId: base.supplierId };
  ctx.p2 = (await stockedProduct(admin, { ...common, salePrice: '5.50', batches: [{ batchNumber: 'P2-A', days: 300, quantity: 50 }] })).productId;
  ctx.prx = (await stockedProduct(admin, { ...common, salePrice: '10.00', requiresPrescription: true, batches: [{ batchNumber: 'RX-A', days: 300, quantity: 10 }] })).productId;
  ctx.p3 = (await stockedProduct(admin, { ...common, salePrice: '1.00', batches: [{ batchNumber: 'P3-A', days: 300, quantity: 3 }] })).productId;
  ctx.pexp = (await stockedProduct(admin, { ...common, salePrice: '3.00', batches: [
    { batchNumber: 'EX-1', days: 3, quantity: 5 }, { batchNumber: 'EX-2', days: 100, quantity: 5 }] })).productId;

  onEmit((room, event, payload) => events.push({ room, event, payload }));
});

test.after(async () => {
  await closeRealtime();
  await tx.rollbackAll();
  await closePool();
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});

// ================================================================== CAJA
test('caja: sin sesión abierta no se puede vender', async () => {
  const res = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], payments: [cash()] });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CASH_SESSION_REQUIRED');
});

test('caja: apertura, apertura duplicada, caja ocupada y restricciones de sucursal', async () => {
  const regs = await admin.get('/api/cash/registers');
  assert.ok(regs.body.data.some((r) => r.code === 'CAJA01'));

  const open = await admin.post('/api/cash/sessions', { cashRegisterId: ctx.caja01, openingAmount: '100.00', notes: 'Turno mañana' });
  assert.equal(open.status, 201, JSON.stringify(open.body));
  ctx.adminSession = open.body.data.id;
  assert.match(open.body.data.sessionNumber, /^C-SP01-\d+$/);
  assert.equal(open.body.data.status, 'OPEN');
  assert.equal(open.body.data.openingAmount, '100.00');
  assert.equal(open.body.data.expectedAmount, '100.00');
  assert.ok(events.some((e) => e.event === 'cash:opened' && e.payload.cashSessionId === ctx.adminSession));

  const dup = await admin.post('/api/cash/sessions', { cashRegisterId: ctx.register2, openingAmount: '0' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CASH_SESSION_ALREADY_OPEN');
  const busy = await staff.post('/api/cash/sessions', { cashRegisterId: ctx.caja01, openingAmount: '0' });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'REGISTER_BUSY');
  const foreign = await outsider.post('/api/cash/sessions', { cashRegisterId: ctx.register2, openingAmount: '0' });
  assert.equal(foreign.status, 403, 'caja de otra sucursal');
  assert.equal((await admin.post('/api/cash/sessions', { cashRegisterId: ctx.caja01, openingAmount: '-5' })).status, 400);

  const st = await staff.post('/api/cash/sessions', { cashRegisterId: ctx.register2, openingAmount: '50.00' });
  assert.equal(st.status, 201);
  ctx.staffSession = st.body.data.id;
  assert.equal((await staff.get('/api/cash/sessions/current')).body.data.id, ctx.staffSession);
  assert.equal((await staff.get(`/api/cash/sessions/${ctx.adminSession}`)).status, 403, 'sin cash.view_all no ve sesiones ajenas');
});

// ================================================================== POS
test('catálogo POS: precio, stock disponible sin vencidos y alerta de vencimiento', async () => {
  const res = await staff.get(`/api/sales/catalog?branchId=1&q=${encodeURIComponent('QA Producto')}&pageSize=50`);
  assert.equal(res.status, 200);
  const p1 = res.body.data.find((p) => p.productId === ctx.p1);
  assert.equal(p1.price, '2.00');
  assert.equal(p1.availableStock, 50);
  assert.equal(p1.canSell, true);
  assert.equal(p1.expiringSoon, true, 'P1-A vence en 30 días');
});

test('carrito (cotización): precios desde MariaDB, nunca del navegador', async () => {
  const q = await staff.post('/api/sales/quote', { branchId: 1, items: [{ productId: ctx.p2, quantity: 3 }, { productId: ctx.p1, quantity: 1 }] });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.data.total, '18.50');
  assert.equal(q.body.data.items[0].lineTotal, '16.50');
  const tampered = await staff.post('/api/sales/quote', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1, unitPrice: '0.01' }] });
  assert.equal(tampered.status, 400, 'no se aceptan precios del cliente');
});

test('venta de un producto en efectivo: vuelto, SALE_OUT, caja, ticket y notificación', async () => {
  const before = await stockOf(ctx.p2);
  events.length = 0;
  const res = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 2 }], payments: [cash(undefined, '20.00')] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const s = res.body.data;
  ctx.cashSale = s;
  assert.equal(s.status, 'COMPLETED');
  assert.match(s.saleNumber, /^V-SP01-\d+$/);
  assert.equal(s.total, '11.00');
  assert.equal(s.customer, null, 'venta rápida sin cliente');
  assert.equal(s.paymentState, 'PAID');
  const pay = s.payments[0];
  assert.equal(pay.status, 'APPROVED');
  assert.equal(pay.tenderedAmount, '20.00');
  assert.equal(pay.changeAmount, '9.00');
  assert.equal(pay.isSimulated, false);
  assert.equal(await stockOf(ctx.p2), before - 2);
  const moves = await cashMovements(pay.id);
  assert.deepEqual(moves.map((m) => [m.movement_type, m.amount]), [['SALE_INCOME', '11.00']], 'un solo ingreso, generado por el trigger');
  assert.equal(n(moves[0].cash_session_id), ctx.staffSession);
  assert.ok(s.ticket.ticketNumber.startsWith('T-SP01-'));
  assert.equal(await count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type = 'SALE_OUT' AND sale_item_batch_id = ?", [s.items[0].batches[0].allocationId]), 1);
  assert.ok(events.some((e) => e.event === 'sale:created' && e.payload.saleId === s.id));
  assert.ok(events.some((e) => e.event === 'inventory:changed'));
});

test('venta de varios productos con FEFO repartido entre lotes y pago Yape simulado', async () => {
  const res = await staff.post('/api/sales', {
    branchId: 1,
    items: [{ productId: ctx.p1, quantity: 40 }, { productId: ctx.p2, quantity: 1 }],
    payments: [{ method: 'YAPE' }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const s = res.body.data;
  ctx.yapeSale = s;
  assert.equal(s.total, '85.50');
  const p1Line = s.items.find((i) => i.productId === ctx.p1);
  assert.deepEqual(p1Line.batches.map((b) => [b.batchNumber, b.quantity]), [['P1-A', 20], ['P1-B', 20]], 'vence antes, sale primero');
  assert.ok(p1Line.batches.every((b) => b.saleOutMovementId));
  assert.equal(await batchQty(ctx.p1, 'P1-A'), 0);
  assert.equal(await batchQty(ctx.p1, 'P1-B'), 10);
  const pay = s.payments[0];
  assert.equal(pay.isSimulated, true);
  assert.equal(pay.mode, 'DEMO');
  assert.match(pay.externalReference, /^DEMO-YAPE-[0-9A-F]{12}$/);
  assert.equal((await cashMovements(pay.id)).length, 0, 'un pago electrónico no mueve efectivo');
});

test('venta con cliente registrado y con datos de cliente sin registro', async () => {
  const [c] = await tx.conn.execute("INSERT INTO customers (full_name, document_type, document_number) VALUES ('QA Cliente Pérez', 'DNI', '45678912')");
  const withId = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], customer: { customerId: c.insertId }, payments: [{ method: 'CARD' }] });
  assert.equal(withId.status, 201, JSON.stringify(withId.body));
  assert.equal(withId.body.data.customer.id, c.insertId);
  assert.equal(withId.body.data.customer.name, 'QA Cliente Pérez');
  assert.equal(withId.body.data.customer.document, 'DNI 45678912');
  const snap = await staff.post('/api/sales', {
    branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], customer: { fullName: 'Juana Ríos', documentType: 'DNI', documentNumber: '12345678' },
    payments: [{ method: 'PLIN' }],
  });
  assert.equal(snap.body.data.customer.name, 'Juana Ríos');
  assert.equal(snap.body.data.customer.id, null);
});

test('descuentos: autorizado, no autorizado, sobre el máximo y mayor que la venta', async () => {
  const ok = await admin.post('/api/sales', {
    branchId: 1, items: [{ productId: ctx.p2, quantity: 2 }, { productId: ctx.p1, quantity: 1 }], discount: { type: 'PERCENT', value: '10' },
    payments: [{ method: 'TRANSFER' }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const s = ok.body.data;
  assert.equal(s.subtotal, '13.00');
  assert.equal(s.discountTotal, '1.30');
  assert.equal(s.total, '11.70');
  assert.deepEqual(s.items.map((i) => i.discountAmount), ['1.10', '0.20'], 'reparto proporcional exacto');
  assert.equal(s.seller.id, ctx.adminId);

  const denied = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], discount: { type: 'AMOUNT', value: '1' }, payments: [cash()] });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'DISCOUNT_NOT_ALLOWED');
  const tooBig = await admin.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], discount: { type: 'AMOUNT', value: '6.00' }, payments: [cash()] });
  assert.equal(tooBig.status, 422);
  await tx.conn.execute("UPDATE settings SET setting_value = '20' WHERE setting_key = 'sales.max_discount_percent'");
  const overMax = await admin.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], discount: { type: 'PERCENT', value: '30' }, payments: [cash()] });
  assert.equal(overMax.status, 422);
  assert.equal(overMax.body.error.code, 'DISCOUNT_TOO_HIGH');
  await tx.conn.execute("UPDATE settings SET setting_value = '100' WHERE setting_key = 'sales.max_discount_percent'");
  assert.equal((await admin.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], discount: { type: 'PERCENT', value: '-5' }, payments: [cash()] })).status, 400);
});

test('stock insuficiente: rechazo sin dejar registros', async () => {
  const salesBefore = await count('SELECT COUNT(*) FROM sales');
  const res = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p3, quantity: 5 }], payments: [cash()] });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(await count('SELECT COUNT(*) FROM sales'), salesBefore);
  assert.equal(await stockOf(ctx.p3), 3);
});

test('lotes vencidos: nunca se venden aunque tengan existencias', async () => {
  await tx.conn.execute('UPDATE user_sessions SET expires_at = NOW() + INTERVAL 30 DAY WHERE revoked_at IS NULL');
  await tx.conn.query('SET TIMESTAMP = UNIX_TIMESTAMP(NOW() + INTERVAL 10 DAY)'); // EX-1 queda vencido
  try {
    const cat = await staff.get('/api/sales/catalog?branchId=1&pageSize=100');
    const p = cat.body.data.find((x) => x.productId === ctx.pexp);
    assert.equal(p.availableStock, 5, 'el lote vencido no cuenta como disponible');
    assert.equal(p.expiredStockNotSellable, 5);
    const tooMany = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.pexp, quantity: 6 }], payments: [cash()] });
    assert.equal(tooMany.status, 422);
    const ok = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.pexp, quantity: 5 }], payments: [cash()] });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.items[0].batches.map((b) => b.batchNumber), ['EX-2']);
    assert.equal(await batchQty(ctx.pexp, 'EX-1'), 5, 'el lote vencido no se tocó');
  } finally {
    await tx.conn.query('SET TIMESTAMP = DEFAULT');
  }
});

test('producto con receta: exige referencia y la registra', async () => {
  const missing = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.prx, quantity: 1 }], payments: [cash()] });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, 'PRESCRIPTION_REQUIRED');
  const ok = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.prx, quantity: 1, prescriptionReference: 'RX-2026-0001' }], payments: [cash()] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.items[0].prescriptionReference, 'RX-2026-0001');
});

test('producto inactivo o no habilitado en la sucursal', async () => {
  await tx.conn.execute('UPDATE branch_products SET is_available = FALSE WHERE product_id = ? AND branch_id = 1', [ctx.p3]);
  const na = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p3, quantity: 1 }], payments: [cash()] });
  assert.equal(na.body.error.code, 'PRODUCT_NOT_AVAILABLE');
  await tx.conn.execute('UPDATE branch_products SET is_available = TRUE WHERE product_id = ? AND branch_id = 1', [ctx.p3]);
  await admin.patch(`/api/products/${ctx.p3}/status`, { status: 'INACTIVE' });
  const inactive = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p3, quantity: 1 }], payments: [cash()] });
  assert.equal(inactive.body.error.code, 'PRODUCT_INACTIVE');
  await admin.patch(`/api/products/${ctx.p3}/status`, { status: 'ACTIVE' });
});

test('pagos divididos: deben cubrir exactamente el total', async () => {
  const mismatch = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 4 }], payments: [cash('10.00'), { method: 'CARD', amount: '11.00' }] });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.error.code, 'PAYMENT_TOTAL_MISMATCH');
  const ok = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 4 }], payments: [cash('10.00', '15.00'), { method: 'CARD', amount: '12.00' }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const [c, card] = ok.body.data.payments;
  assert.equal(c.changeAmount, '5.00');
  assert.equal(card.isSimulated, true);
  assert.equal(ok.body.data.paymentState, 'PAID');
  assert.deepEqual((await cashMovements(c.id)).map((m) => m.amount), ['10.00']);
  assert.equal((await cashMovements(card.id)).length, 0);
  const shortCash = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], payments: [cash(undefined, '5.00')] });
  assert.equal(shortCash.body.error.code, 'INSUFFICIENT_TENDERED');
});

test('pago simulado rechazado: intento trazable, venta anulada y stock repuesto', async () => {
  const before = await stockOf(ctx.p2);
  events.length = 0;
  const res = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 3 }], payments: [{ method: 'CARD', simulate: 'REJECT' }] });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'PAYMENT_REJECTED');
  const { saleId } = res.body.error.details;
  assert.equal(await stockOf(ctx.p2), before, 'sin stock descontado');
  const sale = await admin.get(`/api/sales/${saleId}`);
  assert.equal(sale.body.data.status, 'VOIDED');
  assert.equal(sale.body.data.payments[0].status, 'REJECTED');
  assert.match(sale.body.data.payments[0].failureReason, /DEMO/);
  assert.ok(sale.body.data.items[0].batches.every((b) => b.saleOutMovementId && b.voidInMovementId), 'SALE_OUT y SALE_VOID_IN');
  assert.equal(sale.body.data.ticket, null, 'no se emite ticket');
  assert.ok(!events.some((e) => e.event === 'sale:created'), 'no se notifica una venta rechazada');

  const split = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 2 }], payments: [cash('5.00'), { method: 'YAPE', amount: '6.00', simulate: 'REJECT' }] });
  assert.equal(split.status, 422);
  const s2 = await admin.get(`/api/sales/${split.body.error.details.saleId}`);
  assert.deepEqual(s2.body.data.payments.map((p) => p.status), ['CANCELLED', 'REJECTED']);
  assert.equal((await cashMovements(s2.body.data.payments[0].id)).length, 0, 'el efectivo de un intento rechazado no entra a caja');
  assert.equal(await stockOf(ctx.p2), before);
});

test('tickets: generación, consulta, HTML interno y reimpresión con contador', async () => {
  const id = ctx.yapeSale.id;
  const t = await staff.get(`/api/sales/${id}/ticket`);
  assert.equal(t.status, 200);
  const d = t.body.data;
  assert.equal(d.isTaxReceipt, false);
  assert.equal(d.documentType, 'TICKET_INTERNO');
  assert.equal(d.logoUrl, '/img/Logo-pharma-plus.jpeg');
  assert.equal(d.business.name, 'Pharma Plus');
  assert.equal(d.branch.name, 'Sucursal Principal');
  assert.match(d.legend, /no es un comprobante/i);
  assert.equal(d.items.length, 2);
  assert.equal(d.total, '85.50');
  assert.equal(d.payments[0].mode, 'DEMO');
  assert.match(d.payments[0].reference, /^DEMO-YAPE-/);
  assert.equal(d.printCount, 0);

  const html = await staff.get(`/api/sales/${id}/ticket?format=html`);
  assert.equal(html.status, 200);
  assert.match(html.headers['content-type'], /text\/html/);
  assert.match(html.text, /TICKET INTERNO/);
  assert.match(html.text, /No válido como boleta ni factura/);
  assert.doesNotMatch(html.text, /<script/i);

  assert.equal((await staff.post(`/api/sales/${id}/ticket/print`)).body.data.printCount, 1);
  const reprint = await staff.post(`/api/sales/${id}/ticket/print`);
  assert.equal(reprint.body.data.printCount, 2);
  assert.match((await staff.get(`/api/sales/${id}/ticket?format=html`)).text, /REIMPRESIÓN/);
  assert.equal(await count("SELECT COUNT(*) FROM audit_logs WHERE entity_table = 'sale_tickets' AND entity_id = ? AND action = 'REPRINT'", [String(id)]), 1);
  assert.equal((await staff.post(`/api/sales/${id}/ticket`)).body.data.ticketNumber, d.ticketNumber, 'emitir de nuevo no duplica');
});

test('idempotencia: reintentar la misma venta no cobra ni descuenta dos veces', async () => {
  const key = `qa-idem-${uid()}${uid()}`;
  const body = { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], payments: [{ method: 'CARD' }] };
  const before = await stockOf(ctx.p2);
  const first = await staff.agent.post('/api/sales').set('X-CSRF-Token', staff.csrf).set('Idempotency-Key', key).send(body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await staff.agent.post('/api/sales').set('X-CSRF-Token', staff.csrf).set('Idempotency-Key', key).send(body);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.id, first.body.data.id);
  assert.equal(again.body.data.idempotentReplay, true);
  assert.equal(await stockOf(ctx.p2), before - 1);
  assert.equal(await count('SELECT COUNT(*) FROM payments WHERE sale_id = ?', [first.body.data.id]), 1);
  assert.equal((await staff.agent.post('/api/sales').set('X-CSRF-Token', staff.csrf).set('Idempotency-Key', 'mal').send(body)).status, 400);
});

test('anulación: repone lotes, reembolsa efectivo desde caja y DEMO electrónico; sin doble reposición', async () => {
  const s = ctx.cashSale;
  const before = await stockOf(ctx.p2);
  assert.equal((await staff.post(`/api/sales/${s.id}/void`, { reason: 'Cliente desistió' })).status, 403, 'STAFF sin sales.void');
  assert.equal((await admin.post(`/api/sales/${s.id}/void`, { reason: 'x' })).status, 400, 'motivo obligatorio');
  events.length = 0;
  const v = await admin.post(`/api/sales/${s.id}/void`, { reason: 'Error en el producto entregado' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.data.status, 'VOIDED');
  assert.equal(v.body.data.void.reason, 'Error en el producto entregado');
  assert.equal(await stockOf(ctx.p2), before + 2);
  const pay = v.body.data.payments[0];
  assert.equal(pay.status, 'REFUNDED');
  const moves = await cashMovements(pay.id);
  assert.deepEqual(moves.map((m) => [m.movement_type, m.amount, n(m.cash_session_id)]),
    [['SALE_INCOME', '11.00', ctx.staffSession], ['PAYMENT_REFUND', '11.00', ctx.adminSession]], 'reembolso desde la caja de quien anula');
  assert.ok(events.some((e) => e.event === 'sale:voided'));

  const again = await admin.post(`/api/sales/${s.id}/void`, { reason: 'Intento repetido' });
  assert.equal(again.status, 409);
  assert.equal(await stockOf(ctx.p2), before + 2, 'sin doble reposición');
  assert.equal(await count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type = 'SALE_VOID_IN' AND sale_item_batch_id = ?", [s.items[0].batches[0].allocationId]), 1);

  const e = await admin.post(`/api/sales/${ctx.yapeSale.id}/void`, { reason: 'Anulación de prueba DEMO' });
  assert.equal(e.body.data.payments[0].status, 'REFUNDED');
  assert.equal((await cashMovements(e.body.data.payments[0].id)).length, 0, 'reembolso DEMO sin efectivo');
  assert.equal(await batchQty(ctx.p1, 'P1-A'), 20);
});

test('anulación con efectivo insuficiente en caja: se rechaza y no cambia nada', async () => {
  const sale = await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 10 }], payments: [cash()] });
  assert.equal(sale.status, 201);
  const sum = await admin.get(`/api/cash/sessions/${ctx.adminSession}`);
  // Se retira todo el efectivo de la caja del administrador.
  const out = await admin.post('/api/cash/movements', { movementType: 'CASH_OUT', amount: sum.body.data.expectedAmount, description: 'Depósito bancario' });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const v = await admin.post(`/api/sales/${sale.body.data.id}/void`, { reason: 'Sin fondos para reembolsar' });
  assert.equal(v.status, 422);
  assert.match(v.body.error.message, /efectivo insuficiente/i);
  assert.equal((await admin.get(`/api/sales/${sale.body.data.id}`)).body.data.status, 'COMPLETED', 'ROLLBACK completo');
  await admin.post('/api/cash/movements', { movementType: 'CASH_IN', amount: '200.00', description: 'Fondo de caja' });
});

test('movimientos de caja manuales y validación de fondos', async () => {
  const over = await staff.post('/api/cash/movements', { movementType: 'CASH_OUT', amount: '99999.00', description: 'Exceso' });
  assert.equal(over.status, 422);
  const inc = await staff.post('/api/cash/movements', { movementType: 'CASH_IN', amount: '20.00', description: 'Sencillo' });
  assert.equal(inc.status, 201);
  assert.equal((await staff.post('/api/cash/movements', { movementType: 'SALE_INCOME', amount: '1', description: 'x' })).status, 400);
  const list = await staff.get(`/api/cash/movements?cashSessionId=${ctx.staffSession}`);
  assert.ok(list.body.data.some((m) => m.movementType === 'CASH_IN'));
});

test('cierre de caja: saldo esperado del trigger, diferencia y caja cerrada inoperable', async () => {
  const live = (await staff.get(`/api/cash/sessions/${ctx.staffSession}`)).body.data;
  const expected = live.expectedAmount;
  // Comprobación independiente: apertura + ingresos - egresos.
  const [[calc]] = await tx.conn.execute(
    `SELECT cs.opening_amount + COALESCE(SUM(CASE WHEN cm.direction='IN' THEN cm.amount END),0)
            - COALESCE(SUM(CASE WHEN cm.direction='OUT' THEN cm.amount END),0) AS e
       FROM cash_sessions cs LEFT JOIN cash_movements cm ON cm.cash_session_id = cs.id WHERE cs.id = ? GROUP BY cs.id`, [ctx.staffSession]);
  assert.equal(expected, calc.e);

  events.length = 0;
  const closed = await staff.post(`/api/cash/sessions/${ctx.staffSession}/close`, { countedAmount: '100.00', notes: 'Arqueo final' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const c = closed.body.data;
  assert.equal(c.status, 'CLOSED');
  assert.equal(c.expectedAmount, expected);
  assert.equal(c.countedAmount, '100.00');
  assert.equal(n(c.differenceAmount).toFixed(2), (100 - n(expected)).toFixed(2));
  assert.equal(c.closedBy.id, ctx.staffId);
  assert.ok(c.closedAt);
  assert.ok(c.sales.completed >= 1);
  assert.ok(events.some((e) => e.event === 'cash:closed'));
  assert.equal(await count("SELECT COUNT(*) FROM audit_logs WHERE entity_table = 'cash_sessions' AND entity_id = ? AND action = 'CLOSE'", [String(ctx.staffSession)]), 1);

  assert.equal((await staff.post(`/api/cash/sessions/${ctx.staffSession}/close`, { countedAmount: '1' })).body.error.code, 'CASH_SESSION_CLOSED');
  assert.equal((await staff.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], payments: [cash()] })).body.error.code, 'CASH_SESSION_REQUIRED');
  assert.equal((await staff.post('/api/cash/movements', { cashSessionId: ctx.staffSession, movementType: 'CASH_IN', amount: '1.00', description: 'x tarde' })).status, 409);
  await assert.rejects(tx.conn.execute("UPDATE cash_sessions SET status = 'OPEN' WHERE id = ?", [ctx.staffSession]), /cerrada no se reabre/);
  const hist = await staff.get('/api/cash/sessions?status=CLOSED');
  assert.ok(hist.body.data.some((x) => x.id === ctx.staffSession));
});

test('restricciones por rol y sucursal', async () => {
  const saleId = ctx.yapeSale.id;
  assert.equal((await outsider.get(`/api/sales/${saleId}`)).status, 403, 'venta de otra sucursal');
  assert.equal((await outsider.get(`/api/sales/${saleId}/ticket`)).status, 403);
  const forbidden = await outsider.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], payments: [cash()] });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'BRANCH_FORBIDDEN');
  const list = await outsider.get('/api/sales');
  assert.equal(list.body.pagination.total, 0, 'no ve ventas de otras sucursales');
  assert.equal((await outsider.get('/api/payments')).body.pagination.total, 0);
  assert.ok((await admin.get('/api/payments?branchId=1&method=YAPE')).body.data.length >= 1);
  assert.equal((await require('supertest')(app).get('/api/sales')).status, 401);

  const [[perm]] = await tx.conn.execute("SELECT id FROM permissions WHERE code = 'sales.create'");
  await tx.conn.execute("INSERT INTO user_permissions (user_id, permission_id, effect) VALUES (?, ?, 'DENY')", [ctx.staffId, perm.id]);
  assert.equal((await staff.post('/api/sales/quote', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }] })).status, 403);
  await tx.conn.execute('DELETE FROM user_permissions WHERE user_id = ?', [ctx.staffId]);
});

test('integridad: la base no reporta inconsistencias tras todas las operaciones', async () => {
  const [issues] = await tx.conn.execute('SELECT * FROM vw_integrity_issues');
  assert.deepEqual(issues, []);
});

test('tiempo real: Socket.IO autenticado con la cookie de sesión y aislado por sucursal', async () => {
  const { io: ioc } = require('socket.io-client');
  const server = http.createServer(app);
  initRealtime(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const cookieOf = (client) => client.agent.jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false })
    .map((c) => `${c.name}=${c.value}`).join('; ');
  const connect = (cookie) => new Promise((resolve) => {
    const sock = ioc(url, { transports: ['websocket'], extraHeaders: cookie ? { Cookie: cookie } : {}, reconnection: false, forceNew: true });
    sock.on('ready', (msg) => resolve({ sock, ok: true, msg }));
    sock.on('connect_error', (err) => resolve({ sock, ok: false, err: err.message }));
  });
  try {
    const anon = await connect(null);
    assert.equal(anon.ok, false);
    assert.equal(anon.err, 'AUTH_REQUIRED');
    const s1 = await connect(cookieOf(staff));
    assert.equal(s1.ok, true, s1.err);
    assert.deepEqual(s1.msg.branches, [1]);
    const s2 = await connect(cookieOf(outsider));
    assert.equal(s2.ok, true, s2.err);

    const got1 = [];
    const got2 = [];
    s1.sock.on('sale:created', (m) => got1.push(m));
    s2.sock.on('sale:created', (m) => got2.push(m));
    const sale = await admin.post('/api/sales', { branchId: 1, items: [{ productId: ctx.p2, quantity: 1 }], payments: [{ method: 'CARD' }] });
    assert.equal(sale.status, 201);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(got1.length, 1);
    assert.equal(got1[0].saleId, sale.body.data.id);
    assert.equal(got2.length, 0, 'otra sucursal no recibe la notificación');
    assert.ok(!('payments' in got1[0]) && !('customer' in got1[0]), 'sin datos confidenciales');
    s1.sock.close();
    s2.sock.close();
  } finally {
    await closeRealtime();
    await new Promise((r) => server.close(r));
  }
});
