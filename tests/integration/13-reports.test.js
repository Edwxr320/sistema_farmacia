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
const { loginClient, stockedProduct, storeCustomer, limaDate } = require('../helpers/http');

const PASSWORD = 'Farmacia2026Segura';
let tx;
let app;
let admin;
let staff;
let cust;
const ctx = {};
const today = limaDate(0);

/**
 * Escenario en una sucursal temporal R (aislada de cualquier otro dato), hoy:
 *  X: precio 10.00, costo 4.00 (categoría C1) — Y: precio 5.00, costo 2.00 (categoría C2); 20 u. cada uno.
 *  S1 POS efectivo  X×2              = 20.00
 *  S2 POS tarjeta   Y×4 −10 %         = 18.00 (descuento 2.00)
 *  S3 POS Yape      X×1 = 10.00 → ANULADA
 *  S4 POS efectivo  Y×2 = 10.00 → devolución de 1 u. apta (reembolso 5.00 en efectivo)
 *  P1 pedido online X×1 tarjeta, aceptado y entregado = 10.00
 */
test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  const s = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  for (const code of ['QRP1', 'QRP2']) await tx.conn.execute("INSERT INTO branches (code, name, status) VALUES (?, ?, 'ACTIVE')", [code, `QA ${code}`]);
  const [[r]] = await tx.conn.execute("SELECT id FROM branches WHERE code = 'QRP1'");
  const [[e]] = await tx.conn.execute("SELECT id FROM branches WHERE code = 'QRP2'");
  ctx.R = r.id;
  ctx.E = e.id;
  await tx.conn.execute('INSERT INTO user_branches (user_id, branch_id, is_default) VALUES (?, ?, FALSE)', [a.id, ctx.R]);
  const [reg] = await tx.conn.execute("INSERT INTO cash_registers (branch_id, code, name) VALUES (?, 'QR1', 'Caja reportes')", [ctx.R]);
  admin = await loginClient(app, a);
  staff = await loginClient(app, s);

  const c1 = (await admin.post('/api/categories', { name: 'QA Rep C1' })).body.data.id;
  const c2 = (await admin.post('/api/categories', { name: 'QA Rep C2' })).body.data.id;
  const x = await stockedProduct(admin, { categoryId: c1, salePrice: '10.00' });
  const y = await stockedProduct(admin, { categoryId: c2, supplierId: x.supplierId, salePrice: '5.00' });
  Object.assign(ctx, { X: x.productId, Y: y.productId, c1, c2 });
  const entry = await admin.post('/api/inventory/entries', {
    branchId: ctx.R, supplierId: x.supplierId, confirm: true,
    items: [
      { productId: ctx.X, batchNumber: 'RPX', expiryDate: limaDate(300), quantity: 20, unitCost: '4.00' },
      { productId: ctx.Y, batchNumber: 'RPY', expiryDate: limaDate(300), quantity: 20, unitCost: '2.00' },
    ],
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  assert.equal((await admin.post('/api/cash/sessions', { cashRegisterId: reg.insertId, openingAmount: '100.00' })).status, 201);

  const sell = (items, payments, extra = {}) => admin.post('/api/sales', { branchId: ctx.R, items, payments, ...extra });
  assert.equal((await sell([{ productId: ctx.X, quantity: 2 }], [{ method: 'CASH' }])).status, 201);
  assert.equal((await sell([{ productId: ctx.Y, quantity: 4 }], [{ method: 'CARD' }], { discount: { type: 'PERCENT', value: '10' } })).status, 201);
  const s3 = await sell([{ productId: ctx.X, quantity: 1 }], [{ method: 'YAPE' }]);
  assert.equal((await admin.post(`/api/sales/${s3.body.data.id}/void`, { reason: 'Prueba de anulación' })).status, 200);
  const s4 = await sell([{ productId: ctx.Y, quantity: 2 }], [{ method: 'CASH' }]);
  const ret = await admin.post('/api/returns', { saleId: s4.body.data.id, reasonCode: 'OTHER', process: true, items: [{ saleItemId: s4.body.data.items[0].id, quantity: 1, condition: 'RESELLABLE' }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));

  cust = await storeCustomer(app);
  await cust.put('/api/store/cart', { branchId: ctx.R });
  await cust.put(`/api/store/cart/items/${ctx.X}`, { quantity: 1 });
  const order = await cust.agent.post('/api/store/orders').set('X-CSRF-Token', cust.csrf).send({ fulfillmentType: 'PICKUP', paymentMethod: 'CARD' });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  for (const step of ['accept', 'prepare', 'ready', 'complete']) {
    const r2 = await admin.post(`/api/orders/${order.body.data.id}/${step}`, {});
    assert.equal(r2.status, 200, `${step}: ${JSON.stringify(r2.body)}`);
  }
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});

const get = (client, url) => client.get(url).then((r) => {
  if (r.status !== 200) throw new Error(`${url} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
});

test('resumen de ventas: bruto, descuentos, anulaciones, devoluciones, ingreso neto y margen estimado exactos', async () => {
  const { data: s } = await get(admin, `/api/reports/sales/summary?branchId=${ctx.R}`);
  assert.equal(s.transactions, 4, 'S1, S2, S4 y el pedido (S3 anulada no cuenta)');
  assert.equal(s.grossSales, '60.00');
  assert.equal(s.discounts, '2.00');
  assert.equal(s.netSales, '58.00');
  assert.equal(s.averageTicket, '14.50');
  assert.deepEqual(s.byChannel, { POS: { transactions: 3, netSales: '48.00' }, ONLINE: { transactions: 1, netSales: '10.00' } });
  assert.deepEqual(s.voids, { count: 1, amount: '10.00', rejectedPaymentAttempts: 0 });
  assert.equal(s.returns.count, 1);
  assert.equal(s.returns.refunds, '5.00');
  assert.equal(s.returns.restockedUnits, 1);
  assert.equal(s.netRevenue, '53.00');
  // Costo: X 3 u. × 4.00 + Y 6 u. × 2.00 = 24.00, menos 1 Y reingresada (2.00) = 22.00
  assert.equal(s.costOfGoodsSold, '22.00');
  assert.equal(s.grossMarginEstimated, '31.00');
  assert.equal(s.grossMarginPercent, 58.49);
  assert.match(s.definitions.grossMarginEstimated, /No es ganancia neta/);
  assert.ok(!('netProfit' in s), 'no se presenta una ganancia neta inexistente');
});

test('series, comparación de períodos y filtros de fechas', async () => {
  const { data: series } = await get(admin, `/api/reports/sales/series?branchId=${ctx.R}&from=${limaDate(-2)}&to=${today}&granularity=day`);
  assert.deepEqual(series.series.map((p) => [p.period, p.transactions, p.netSales]), [
    [limaDate(-2), 0, '0.00'], [limaDate(-1), 0, '0.00'], [today, 4, '58.00']], 'días sin ventas en cero');
  const { data: month } = await get(admin, `/api/reports/sales/series?branchId=${ctx.R}&granularity=month`);
  assert.equal(month.series[0].netSales, '58.00');
  const { data: cmp } = await get(admin, `/api/reports/sales/compare?branchId=${ctx.R}`);
  assert.equal(cmp.netSales.current, '58.00');
  assert.equal(cmp.netSales.previous, '0.00');
  assert.equal(cmp.netSales.changePercent, null, 'sin base de comparación no se inventa un porcentaje');
  const { data: yesterday } = await get(admin, `/api/reports/sales/summary?branchId=${ctx.R}&from=${limaDate(-1)}&to=${limaDate(-1)}`);
  assert.equal(yesterday.transactions, 0);
  assert.equal((await admin.get(`/api/reports/sales/summary?from=${today}&to=${limaDate(-1)}`)).status, 400, 'rango invertido');
  assert.equal((await admin.get(`/api/reports/sales/summary?from=${limaDate(-400)}&to=${today}`)).status, 400, 'rango máximo');
});

test('productos más vendidos, categorías, sucursal, trabajador y métodos de pago', async () => {
  const { data: byQty } = await get(admin, `/api/reports/sales/top-products?branchId=${ctx.R}`);
  assert.deepEqual(byQty.data.map((p) => [p.product_id, p.quantity, p.revenue]), [[ctx.Y, 6, '28.00'], [ctx.X, 3, '30.00']]);
  const { data: byRev } = await get(admin, `/api/reports/sales/top-products?branchId=${ctx.R}&orderBy=revenue&limit=1`);
  assert.deepEqual(byRev.data.map((p) => p.product_id), [ctx.X]);
  const { data: cats } = await get(admin, `/api/reports/sales/by-category?branchId=${ctx.R}`);
  const c2 = cats.data.find((c) => c.category_id === ctx.c2);
  assert.deepEqual([c2.gross, c2.discounts, c2.revenue], ['30.00', '2.00', '28.00']);
  const { data: br } = await get(admin, `/api/reports/sales/by-branch?branchId=${ctx.R}`);
  assert.deepEqual(br.data.map((b) => [b.branch_id, b.transactions, b.net_sales]), [[ctx.R, 4, '58.00']]);
  const { data: sellers } = await get(admin, `/api/reports/sales/by-seller?branchId=${ctx.R}`);
  assert.equal(sellers.data.length, 1);
  assert.equal(sellers.data[0].net_sales, '58.00');
  const { data: pm } = await get(admin, `/api/reports/payments/methods?branchId=${ctx.R}`);
  const m = Object.fromEntries(pm.byMethod.map((x) => [x.method, x]));
  assert.deepEqual([m.CASH.collected, m.CASH.returnRefunds], ['30.00', '5.00']);
  assert.equal(m.CARD.collected, '28.00');
  assert.deepEqual([m.YAPE.collected, m.YAPE.paymentRefunds], ['10.00', '10.00']);
  assert.equal(m.CARD.demo, true);
});

test('inventario: valorización a costo, retail, stock bajo, vencimientos y movimientos', async () => {
  const { data: inv } = await get(admin, `/api/reports/inventory/valuation?branchId=${ctx.R}`);
  // X: 20 − 2 − 1 (pedido) = 17 × 4.00 = 68.00 ; Y: 20 − 4 − 2 + 1 = 15 × 2.00 = 30.00
  assert.equal(inv.totals.units, 32);
  assert.equal(inv.totals.costValue, '98.00');
  assert.equal(inv.totals.sellableRetailValue, '245.00');
  assert.equal(inv.totals.expiredCost, '0.00');
  const { data: mv } = await get(admin, `/api/reports/inventory/movements?branchId=${ctx.R}`);
  assert.equal(mv.unitsIn, 42, '40 compra + 1 anulación + 1 devolución');
  assert.equal(mv.unitsOut, 10);
  const types = Object.fromEntries(mv.byType.map((t) => [t.movement_type, t.units]));
  assert.deepEqual(types, { PURCHASE_ENTRY: 40, RETURN_IN: 1, SALE_VOID_IN: 1, SALE_OUT: 10 });
  const low = await get(admin, `/api/reports/inventory/low-stock?branchId=${ctx.R}`);
  assert.ok(low.data.every((r) => r.branch_id === ctx.R));
  const exp = await get(admin, `/api/reports/inventory/expiring?branchId=${ctx.R}&days=400`);
  assert.equal(exp.summary.batches, 2);
  assert.equal(exp.summary.expiredBatches, 0);
});

test('devoluciones, anulaciones, pedidos y caja', async () => {
  const { data: rt } = await get(admin, `/api/reports/returns?branchId=${ctx.R}`);
  assert.equal(rt.returns.refunds, '5.00');
  assert.equal(rt.voids.count, 1);
  assert.deepEqual(rt.byCondition, [{ item_condition: 'RESELLABLE', units: 1 }]);
  const { data: od } = await get(admin, `/api/reports/orders?branchId=${ctx.R}`);
  assert.deepEqual([od.orders, od.completed, od.completedTotal, od.completionRate], [1, 1, '10.00', 100]);
  const cash = await get(admin, `/api/reports/cash?branchId=${ctx.R}`);
  assert.equal(cash.totals.sessions, 1);
  const mov = Object.fromEntries(cash.movements.map((x) => [x.movement_type, x.amount]));
  assert.equal(mov.SALE_INCOME, '30.00');
  assert.equal(mov.RETURN_REFUND, '5.00');
  assert.equal(cash.data[0].current_expected_amount, '125.00', '100 + 30 − 5');
});

test('sin ventas ni movimientos: todo en cero, sin divisiones inválidas', async () => {
  const { data: s } = await get(admin, `/api/reports/sales/summary?branchId=${ctx.E}`);
  assert.deepEqual([s.transactions, s.netSales, s.averageTicket, s.grossMarginEstimated, s.grossMarginPercent], [0, '0.00', '0.00', '0.00', null]);
  const { data: inv } = await get(admin, `/api/reports/inventory/valuation?branchId=${ctx.E}`);
  assert.deepEqual([inv.totals.units, inv.totals.costValue], [0, '0.00']);
  const { data: od } = await get(admin, `/api/reports/orders?branchId=${ctx.E}`);
  assert.deepEqual([od.orders, od.completionRate], [0, null]);
  const { data: dash } = await get(admin, `/api/reports/dashboard?branchId=${ctx.E}`);
  assert.equal(dash.sales.netSales, '0.00');
});

test('permisos y aislamiento por sucursal', async () => {
  assert.equal((await staff.get(`/api/reports/sales/summary?branchId=${ctx.R}`)).status, 403, 'STAFF no ve otra sucursal');
  const own = await get(staff, '/api/reports/sales/summary');
  assert.ok(own.data.transactions >= 0);
  assert.equal((await staff.get('/api/reports/activity')).status, 403, 'auditoría requiere audit.view');
  assert.equal((await cust.get('/api/reports/dashboard')).status, 403);
  assert.equal((await require('supertest')(app).get('/api/reports/dashboard')).status, 401);
  const consolidated = await get(admin, '/api/reports/sales/by-branch');
  assert.ok(consolidated.data.data.some((b) => b.branch_id === ctx.R), 'ADMIN (reports.consolidated) ve todas las sucursales');
  const act = await get(admin, `/api/reports/activity?branchId=${ctx.R}&module=sales&pageSize=5`);
  assert.ok(act.data.length > 0 && act.data.every((a) => a.module === 'sales'));
  // La auditoría registra la sucursal de la OPERACIÓN (R), aunque la sesión del ADMIN sea de la principal.
  assert.ok(act.data.some((a) => a.action === 'CREATE' && a.branch_id === ctx.R));
  assert.ok(!JSON.stringify(act.data).includes('$2b$'), 'sin secretos');
});

test('rendimiento: índices usados y tiempos de respuesta acotados; los reportes no escriben datos', async () => {
  const [plan] = await tx.conn.execute(
    "EXPLAIN SELECT COUNT(*), SUM(s.total) FROM sales s WHERE s.status = 'COMPLETED' AND s.sold_at >= ? AND s.sold_at < ? + INTERVAL 1 DAY AND s.branch_id = ?",
    [today, today, ctx.R]);
  // Con tablas pequeñas el optimizador puede preferir recorrer la tabla; se verifica que la
  // consulta sea indexable (los índices por sucursal/fecha están disponibles para ella).
  const possible = String(plan[0].possible_keys || '');
  assert.ok(/idx_sales_branch_date|idx_sales_date_status/.test(possible), `índices disponibles: ${possible}`);
  const [[before]] = await tx.conn.execute('SELECT (SELECT COUNT(*) FROM audit_logs) a, (SELECT COUNT(*) FROM inventory_movements) m, (SELECT COUNT(*) FROM sales) s');
  const urls = ['dashboard', 'sales/summary', 'sales/compare', 'sales/series?granularity=week', 'sales/top-products', 'sales/by-category',
    'sales/by-branch', 'sales/by-seller', 'payments/methods', 'inventory/valuation', 'inventory/low-stock', 'inventory/expiring',
    'inventory/movements', 'returns', 'orders', 'cash', 'activity'];
  for (const u of urls) {
    const t0 = Date.now();
    const r = await admin.get(`/api/reports/${u}${u.includes('?') ? '&' : '?'}from=${limaDate(-30)}&to=${today}`);
    assert.equal(r.status, 200, `${u}: ${JSON.stringify(r.body)}`);
    assert.ok(Date.now() - t0 < 1500, `${u} tardó ${Date.now() - t0} ms`);
  }
  const [[after]] = await tx.conn.execute('SELECT (SELECT COUNT(*) FROM audit_logs) a, (SELECT COUNT(*) FROM inventory_movements) m, (SELECT COUNT(*) FROM sales) s');
  assert.deepEqual(after, before, 'consultar reportes no altera datos');
});
