'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { closePool } = require('../../src/config/database');
const { config } = require('../../src/config/env');
const { createApp } = require('../../src/app');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const { loginClient, stockedProduct } = require('../helpers/http');

const PASSWORD = 'Farmacia2026Segura';
let tx;
let app;
let admin;
let staff;
let outsider;
const ctx = {};
const n = Number;

async function batchQty(productId, number) {
  const [[r]] = await tx.conn.execute('SELECT current_quantity q FROM product_batches WHERE product_id = ? AND batch_number = ? AND branch_id = 1', [productId, number]);
  return n(r.q);
}

async function stockOf(productId) {
  const [[r]] = await tx.conn.execute('SELECT COALESCE(SUM(current_quantity),0) q FROM product_batches WHERE product_id = ? AND branch_id = 1', [productId]);
  return n(r.q);
}

const line = (sale, productId) => sale.items.find((i) => i.productId === productId);

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  const s = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  await tx.conn.execute("INSERT INTO branches (code, name, status) VALUES ('QR09', 'QA Sucursal Devoluciones', 'ACTIVE')");
  const [[b2]] = await tx.conn.execute("SELECT id FROM branches WHERE code = 'QR09'");
  const o = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD, withBranch: false });
  await tx.conn.execute('INSERT INTO user_branches (user_id, branch_id, is_default) VALUES (?, ?, TRUE)', [o.id, b2.id]);
  ctx.adminId = a.id;
  admin = await loginClient(app, a);
  staff = await loginClient(app, s);
  outsider = await loginClient(app, o);

  const [[caja]] = await tx.conn.execute("SELECT id FROM cash_registers WHERE branch_id = 1 AND code = 'CAJA01'");
  const open = await admin.post('/api/cash/sessions', { cashRegisterId: caja.id, openingAmount: '100.00' });
  ctx.session = open.body.data.id;

  const pa = await stockedProduct(admin, { salePrice: '4.00', batches: [{ batchNumber: 'RA-1', days: 200, quantity: 10 }, { batchNumber: 'RA-2', days: 300, quantity: 10 }] });
  ctx.pa = pa.productId;
  ctx.pb = (await stockedProduct(admin, { categoryId: pa.categoryId, supplierId: pa.supplierId, salePrice: '2.50', batches: [{ batchNumber: 'RB-1', days: 250, quantity: 10 }] })).productId;
  ctx.pe = (await stockedProduct(admin, { categoryId: pa.categoryId, supplierId: pa.supplierId, salePrice: '1.00', batches: [{ batchNumber: 'RE-1', days: 3, quantity: 5 }] })).productId;

  // Venta 1 (efectivo): 12 de A (10 de RA-1 + 2 de RA-2 por FEFO) y 2 de B = 53.00
  const s1 = await admin.post('/api/sales', { branchId: 1, items: [{ productId: ctx.pa, quantity: 12 }, { productId: ctx.pb, quantity: 2 }], payments: [{ method: 'CASH', tenderedAmount: '60.00' }] });
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  ctx.sale1 = s1.body.data;
  // Venta 2 (Yape DEMO): 3 de A
  const s2 = await admin.post('/api/sales', { branchId: 1, items: [{ productId: ctx.pa, quantity: 3 }], payments: [{ method: 'YAPE' }] });
  ctx.sale2 = s2.body.data;
  // Venta 3: producto que vencerá
  const s3 = await admin.post('/api/sales', { branchId: 1, items: [{ productId: ctx.pe, quantity: 2 }], payments: [{ method: 'CARD' }] });
  ctx.sale3 = s3.body.data;
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});

test('consulta de venta y ticket para iniciar la devolución', async () => {
  const byTicket = await staff.get(`/api/returns/lookup?ticketNumber=${ctx.sale1.ticket.ticketNumber}`);
  assert.equal(byTicket.status, 200, JSON.stringify(byTicket.body));
  const d = byTicket.body.data;
  assert.equal(d.sale.id, ctx.sale1.id);
  assert.equal(d.canReturn, true);
  assert.deepEqual(d.paymentMethods, ['CASH']);
  const a = d.items.filter((i) => i.productId === ctx.pa);
  assert.equal(a.reduce((x, i) => x + i.soldQuantity, 0), 12);
  assert.ok(a.every((i) => i.unitRefundAmount === '4.00'));
  assert.equal((await staff.get(`/api/returns/sales/${ctx.sale1.id}`)).body.data.sale.saleNumber, ctx.sale1.saleNumber);
  assert.equal((await staff.get('/api/returns/reasons')).body.data.length, 7);
  assert.equal((await staff.get('/api/returns/lookup?saleNumber=NO-EXISTE')).status, 404);
});

test('devolución parcial: solicitud (STAFF), aprobación y cierre con RETURN_IN y reembolso en efectivo', async () => {
  const before = await stockOf(ctx.pa);
  const req = await staff.post('/api/returns', {
    saleId: ctx.sale1.id, reasonCode: 'CUSTOMER_CHANGE', notes: 'Cliente compró de más',
    items: [{ saleItemId: line(ctx.sale1, ctx.pa).id, quantity: 3, condition: 'RESELLABLE' }],
  });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  const r = req.body.data;
  ctx.ret1 = r;
  assert.match(r.returnNumber, /^D-SP01-\d+$/);
  assert.equal(r.status, 'REQUESTED');
  assert.equal(r.returnType, 'PARTIAL');
  assert.equal(r.refundAmount, '12.00');
  assert.equal(r.refundStatus, 'PENDING');
  // Reparto: primero el lote de vencimiento más lejano (RA-2 tenía 2 vendidas) y luego RA-1.
  assert.deepEqual(r.items.map((i) => [i.batchNumber, i.quantity]), [['RA-2', 2], ['RA-1', 1]]);
  assert.equal(await stockOf(ctx.pa), before, 'solicitar no mueve stock');

  assert.equal((await staff.post(`/api/returns/${r.id}/approve`, {})).status, 403, 'STAFF no aprueba');
  assert.equal((await staff.post(`/api/returns/${r.id}/complete`, {})).status, 403);
  const appr = await admin.post(`/api/returns/${r.id}/approve`, {});
  assert.equal(appr.body.data.status, 'APPROVED');
  assert.equal(appr.body.data.reviewedBy.id, ctx.adminId);

  const done = await admin.post(`/api/returns/${r.id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const c = done.body.data;
  assert.equal(c.status, 'COMPLETED');
  assert.equal(c.refundStatus, 'REFUNDED');
  assert.equal(c.refundMethod, 'CASH');
  assert.equal(c.refundAmount, '12.00');
  assert.equal(c.refundCashSessionId, ctx.session);
  assert.ok(c.items.every((i) => i.restock && i.returnInMovementId));
  assert.equal(await stockOf(ctx.pa), before + 3);
  // RA-2: 10 − 2 (venta 1) − 3 (venta 2, FEFO tras agotarse RA-1) + 2 devueltas = 7
  assert.equal(await batchQty(ctx.pa, 'RA-2'), 7, 'reingresa al mismo lote vendido');
  const [[cm]] = await tx.conn.execute("SELECT movement_type, amount FROM cash_movements WHERE sale_return_id = ?", [r.id]);
  assert.deepEqual([cm.movement_type, cm.amount], ['RETURN_REFUND', '12.00']);
  const kardex = await admin.get(`/api/inventory/movements?productId=${ctx.pa}&movementType=RETURN_IN`);
  assert.ok(kardex.body.data.every((k) => k.source_document === r.returnNumber));
  assert.equal((await admin.get(`/api/sales/${ctx.sale1.id}`)).body.data.status, 'COMPLETED', 'la venta no se altera');
  assert.equal((await admin.post(`/api/returns/${r.id}/complete`, {})).status, 409, 'no se completa dos veces');
});

test('cantidades superiores a las vendidas o ya devueltas', async () => {
  const res = await staff.post('/api/returns', {
    saleId: ctx.sale1.id, reasonCode: 'OTHER', items: [{ saleItemId: line(ctx.sale1, ctx.pa).id, quantity: 10, condition: 'RESELLABLE' }],
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'RETURN_EXCEEDS_SOLD');
  assert.equal(res.body.error.details.available, 9);
  const foreignItem = await staff.post('/api/returns', {
    saleId: ctx.sale1.id, reasonCode: 'OTHER', items: [{ saleItemId: line(ctx.sale2, ctx.pa).id, quantity: 1, condition: 'RESELLABLE' }],
  });
  assert.equal(foreignItem.status, 400, 'línea de otra venta');
  assert.equal((await staff.post('/api/returns', { saleId: ctx.sale1.id, reasonCode: 'OTHER', items: [{ saleItemId: line(ctx.sale1, ctx.pa).id, quantity: 0, condition: 'RESELLABLE' }] })).status, 400);
  assert.equal((await staff.post('/api/returns', { saleId: ctx.sale1.id, items: [{ saleItemId: line(ctx.sale1, ctx.pa).id, quantity: 1, condition: 'RESELLABLE' }] })).status, 400, 'motivo obligatorio');
});

test('producto no apto (dañado): se reembolsa pero no reingresa al stock', async () => {
  const before = await stockOf(ctx.pb);
  const res = await admin.post('/api/returns', {
    saleId: ctx.sale1.id, reasonCode: 'DEFECTIVE', process: true,
    items: [{ saleItemId: line(ctx.sale1, ctx.pb).id, quantity: 1, condition: 'DAMAGED', notes: 'Envase roto' }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'COMPLETED');
  assert.equal(res.body.data.items[0].restock, false);
  assert.equal(res.body.data.items[0].returnInMovementId, null);
  assert.equal(res.body.data.refundAmount, '2.50');
  assert.equal(await stockOf(ctx.pb), before);
});

test('rechazo: queda como historial y libera las cantidades', async () => {
  const req = await staff.post('/api/returns', { saleId: ctx.sale1.id, reasonCode: 'OTHER', items: [{ saleItemId: line(ctx.sale1, ctx.pa).id, quantity: 9, condition: 'RESELLABLE' }] });
  assert.equal(req.status, 201);
  assert.equal((await staff.post('/api/returns', { saleId: ctx.sale1.id, reasonCode: 'OTHER', items: [{ saleItemId: line(ctx.sale1, ctx.pa).id, quantity: 1, condition: 'RESELLABLE' }] })).status, 422, 'una solicitud pendiente reserva las unidades');
  const rej = await admin.post(`/api/returns/${req.body.data.id}/reject`, { reason: 'Producto abierto, no procede' });
  assert.equal(rej.body.data.status, 'REJECTED');
  assert.equal(rej.body.data.refundStatus, 'NONE');
  assert.equal((await admin.post(`/api/returns/${req.body.data.id}/approve`, {})).status, 409, 'el rechazo es final');
  const avail = await staff.get(`/api/returns/sales/${ctx.sale1.id}`);
  assert.equal(avail.body.data.items.filter((i) => i.productId === ctx.pa).reduce((x, i) => x + i.returnableQuantity, 0), 9);
});

test('rollback: si el reembolso en efectivo no tiene fondos, nada cambia', async () => {
  const req = await admin.post('/api/returns', { saleId: ctx.sale1.id, reasonCode: 'OTHER', items: [{ saleItemId: line(ctx.sale1, ctx.pa).id, quantity: 2, condition: 'RESELLABLE' }] });
  await admin.post(`/api/returns/${req.body.data.id}/approve`, {});
  const sum = await admin.get(`/api/cash/sessions/${ctx.session}`);
  await admin.post('/api/cash/movements', { movementType: 'CASH_OUT', amount: sum.body.data.expectedAmount, description: 'Depósito' });
  const before = await stockOf(ctx.pa);
  const res = await admin.post(`/api/returns/${req.body.data.id}/complete`, {});
  assert.equal(res.status, 422);
  assert.match(res.body.error.message, /efectivo insuficiente/i);
  assert.equal(await stockOf(ctx.pa), before, 'el RETURN_IN se revirtió');
  const after = await admin.get(`/api/returns/${req.body.data.id}`);
  assert.equal(after.body.data.status, 'APPROVED');
  assert.ok(after.body.data.items.every((i) => i.returnInMovementId === null));
  await admin.post('/api/cash/movements', { movementType: 'CASH_IN', amount: '100.00', description: 'Fondo' });
  const ok = await admin.post(`/api/returns/${req.body.data.id}/complete`, {});
  assert.equal(ok.body.data.status, 'COMPLETED');
});

test('devolución total y bloqueo de devoluciones posteriores (doble devolución)', async () => {
  const avail = (await staff.get(`/api/returns/sales/${ctx.sale1.id}`)).body.data.items.filter((i) => i.returnableQuantity > 0);
  const res = await admin.post('/api/returns', {
    saleId: ctx.sale1.id, reasonCode: 'SALE_ERROR', process: true,
    items: avail.map((i) => ({ saleItemBatchId: i.saleItemBatchId, quantity: i.returnableQuantity, condition: 'RESELLABLE' })),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.returnType, 'TOTAL');
  const again = await admin.post('/api/returns', { saleId: ctx.sale1.id, reasonCode: 'OTHER', items: [{ saleItemId: line(ctx.sale1, ctx.pa).id, quantity: 1, condition: 'RESELLABLE' }] });
  assert.equal(again.status, 422);
  assert.equal((await staff.get(`/api/returns/sales/${ctx.sale1.id}`)).body.data.canReturn, false);
  const [[refunded]] = await tx.conn.execute("SELECT COALESCE(SUM(refund_amount),0) t FROM sale_returns WHERE sale_id = ? AND status = 'COMPLETED'", [ctx.sale1.id]);
  assert.equal(refunded.t, '53.00', 'nunca se reembolsa más de lo cobrado');
  const v = await admin.post(`/api/sales/${ctx.sale1.id}/void`, { reason: 'Intento de anular tras devoluciones' });
  assert.equal(v.status, 409);
  assert.equal(v.body.error.code, 'SALE_HAS_RETURNS');
});

test('reembolso DEMO por el medio original (Yape) y rechazo de otro medio', async () => {
  const wrong = await admin.post('/api/returns', { saleId: ctx.sale2.id, reasonCode: 'OTHER', process: true, refundMethod: 'CASH', items: [{ saleItemId: line(ctx.sale2, ctx.pa).id, quantity: 1, condition: 'RESELLABLE' }] });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.code, 'REFUND_METHOD_INVALID');
  assert.equal((await admin.get(`/api/returns?saleId=${ctx.sale2.id}`)).body.pagination.total, 0, 'rollback: no quedó la devolución');

  const ok = await admin.post('/api/returns', { saleId: ctx.sale2.id, reasonCode: 'WRONG_PRODUCT', process: true, items: [{ saleItemId: line(ctx.sale2, ctx.pa).id, quantity: 1, condition: 'OPENED' }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const r = ok.body.data;
  assert.equal(r.refundMethod, 'YAPE');
  assert.match(r.refundOperationCode, /^DEMO-REFUND-YAPE-[0-9A-F]{10}$/);
  assert.equal(r.refundCashSessionId, null);
  const [[cm]] = await tx.conn.execute('SELECT COUNT(*) c FROM cash_movements WHERE sale_return_id = ?', [r.id]);
  assert.equal(n(cm.c), 0, 'un reembolso DEMO no mueve efectivo');
});

test('lote vencido: no puede reingresar como apto; sí como vencido', async () => {
  await tx.conn.execute('UPDATE user_sessions SET expires_at = NOW() + INTERVAL 30 DAY WHERE revoked_at IS NULL');
  await tx.conn.query('SET TIMESTAMP = UNIX_TIMESTAMP(NOW() + INTERVAL 10 DAY)');
  try {
    const item = line(ctx.sale3, ctx.pe).id;
    const bad = await admin.post('/api/returns', { saleId: ctx.sale3.id, reasonCode: 'EXPIRED_AT_SALE', items: [{ saleItemId: item, quantity: 1, condition: 'RESELLABLE' }] });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, 'BATCH_EXPIRED');
    const ok = await admin.post('/api/returns', { saleId: ctx.sale3.id, reasonCode: 'EXPIRED_AT_SALE', process: true, items: [{ saleItemId: item, quantity: 1, condition: 'EXPIRED' }] });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.items[0].restock, false);
  } finally {
    await tx.conn.query('SET TIMESTAMP = DEFAULT');
  }
});

test('permisos y sucursales', async () => {
  assert.equal((await staff.post('/api/returns', { saleId: ctx.sale2.id, reasonCode: 'OTHER', process: true, items: [{ saleItemId: line(ctx.sale2, ctx.pa).id, quantity: 1, condition: 'RESELLABLE' }] })).status, 403);
  const foreign = await outsider.post('/api/returns', { saleId: ctx.sale2.id, reasonCode: 'OTHER', items: [{ saleItemId: line(ctx.sale2, ctx.pa).id, quantity: 1, condition: 'RESELLABLE' }] });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error.code, 'BRANCH_FORBIDDEN');
  assert.equal((await outsider.get(`/api/returns/sales/${ctx.sale2.id}`)).status, 403);
  assert.equal((await outsider.get(`/api/returns/${ctx.ret1.id}`)).status, 403);
  assert.equal((await outsider.get('/api/returns')).body.pagination.total, 0);
  assert.equal((await require('supertest')(app).get('/api/returns')).status, 401);
});

test('integridad y auditoría', async () => {
  const [issues] = await tx.conn.execute('SELECT * FROM vw_integrity_issues');
  assert.deepEqual(issues, []);
  const [[a]] = await tx.conn.execute("SELECT COUNT(*) c FROM audit_logs WHERE entity_table = 'sale_returns' AND entity_id = ? AND action IN ('CREATE','APPROVED','COMPLETED')", [String(ctx.ret1.id)]);
  assert.equal(n(a.c), 3, 'creación explícita + cambios de estado por trigger');
});
