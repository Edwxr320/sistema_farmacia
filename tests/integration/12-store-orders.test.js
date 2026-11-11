'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const request = require('supertest');
const { closePool } = require('../../src/config/database');
const { config } = require('../../src/config/env');
const { createApp } = require('../../src/app');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const { loginClient, stockedProduct, storeCustomer, uid } = require('../helpers/http');

const PASSWORD = 'Farmacia2026Segura';
let tx;
let app;
let admin;
let staff;
let outsider;
let cust;
let cust2;
const ctx = {};
const n = Number;

async function stockOf(productId) {
  const [[r]] = await tx.conn.execute('SELECT COALESCE(SUM(current_quantity),0) q FROM product_batches WHERE product_id = ? AND branch_id = 1', [productId]);
  return n(r.q);
}
async function batchQty(productId, number) {
  const [[r]] = await tx.conn.execute('SELECT current_quantity q FROM product_batches WHERE product_id = ? AND batch_number = ?', [productId, number]);
  return n(r.q);
}
const key = () => `qa-ord-${uid()}${uid()}`;
const checkout = (client, body, idem) => {
  const r = client.agent.post('/api/store/orders').set('X-CSRF-Token', client.csrf);
  if (idem) r.set('Idempotency-Key', idem);
  return r.send(body);
};
async function fillCart(client, items) {
  await client.del('/api/store/cart');
  for (const [productId, quantity] of items) {
    const r = await client.put(`/api/store/cart/items/${productId}`, { quantity });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
}

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  const s = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  await tx.conn.execute("INSERT INTO branches (code, name, status) VALUES ('QS02', 'QA Sucursal Tienda', 'ACTIVE')");
  const [[b2]] = await tx.conn.execute("SELECT id FROM branches WHERE code = 'QS02'");
  ctx.branch2 = b2.id;
  const o = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD, withBranch: false });
  await tx.conn.execute('INSERT INTO user_branches (user_id, branch_id, is_default) VALUES (?, ?, TRUE)', [o.id, b2.id]);
  ctx.staffId = s.id;
  admin = await loginClient(app, a);
  staff = await loginClient(app, s);
  outsider = await loginClient(app, o);
  const [reg] = await tx.conn.execute("INSERT INTO cash_registers (branch_id, code, name) VALUES (1, 'QS1', 'Caja pedidos')");
  await staff.post('/api/cash/sessions', { cashRegisterId: reg.insertId, openingAmount: '20.00' });

  const p = await stockedProduct(admin, { salePrice: '5.00', batches: [{ batchNumber: 'ST-A', days: 120, quantity: 10 }, { batchNumber: 'ST-B', days: 300, quantity: 10 }] });
  ctx.cat = p.categoryId;
  const common = { categoryId: p.categoryId, supplierId: p.supplierId };
  ctx.p = p.productId;
  ctx.rx = (await stockedProduct(admin, { ...common, salePrice: '12.00', requiresPrescription: true, batches: [{ batchNumber: 'RX-S', days: 300, quantity: 5 }] })).productId;
  ctx.last = (await stockedProduct(admin, { ...common, salePrice: '3.00', batches: [{ batchNumber: 'LS-1', days: 300, quantity: 2 }] })).productId;
  ctx.exp = (await stockedProduct(admin, { ...common, salePrice: '2.00', batches: [{ batchNumber: 'EX-S1', days: 3, quantity: 4 }, { batchNumber: 'EX-S2', days: 100, quantity: 4 }] })).productId;
  ctx.hidden = (await stockedProduct(admin, { ...common, salePrice: '1.00', batches: [{ batchNumber: 'HD-1', days: 300, quantity: 5 }] })).productId;
  await admin.patch(`/api/products/${ctx.hidden}/status`, { status: 'INACTIVE' });

  cust = await storeCustomer(app);
  cust2 = await storeCustomer(app);
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});

// ================================================================ CLIENTES
test('registro, validaciones y portales separados', async () => {
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/auth/csrf-token')).body.csrfToken;
  assert.equal((await agent.post('/api/store/auth/register').set('X-CSRF-Token', csrf).send({ fullName: 'Otro', email: cust.email, password: 'Cliente2026Seguro' })).status, 409);
  assert.equal((await agent.post('/api/store/auth/register').set('X-CSRF-Token', csrf).send({ fullName: 'Débil Uno', email: `x${uid()}@pharmaplus.test`, password: 'abc' })).status, 400);
  assert.equal((await agent.post('/api/store/auth/register').set('X-CSRF-Token', csrf).send({ fullName: 'Doc Malo', email: `y${uid()}@pharmaplus.test`, password: 'Cliente2026Seguro', documentType: 'DNI', documentNumber: '123' })).status, 400);

  const [[u]] = await tx.conn.execute('SELECT u.password_hash, r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', [cust.userId]);
  assert.match(u.password_hash, /^\$2b\$/);
  assert.equal(u.code, 'CUSTOMER');

  const staffAsCustomer = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: cust.email, password: cust.password });
  assert.equal(staffAsCustomer.body.error.code, 'AUTH_WRONG_PORTAL');
  const [[staffUser]] = await tx.conn.execute('SELECT email FROM users WHERE id = ?', [ctx.staffId]);
  const customerAsStaff = await agent.post('/api/store/auth/login').set('X-CSRF-Token', csrf).send({ email: staffUser.email, password: PASSWORD });
  assert.equal(customerAsStaff.body.error.code, 'AUTH_WRONG_PORTAL');

  for (const url of ['/api/products', '/api/orders', '/api/inventory', '/api/reports/dashboard', '/api/sales', '/api/users']) {
    assert.equal((await cust.get(url)).status, 403, `cliente bloqueado en ${url}`);
  }
  assert.equal((await staff.get('/api/store/cart')).status, 403, 'un trabajador no usa el carrito de clientes');
  assert.equal((await staff.get('/api/store/me')).status, 403);
});

test('perfil y direcciones', async () => {
  const me = await cust.get('/api/store/me');
  assert.equal(me.body.data.email, cust.email);
  const upd = await cust.put('/api/store/me', { phone: '987654321', documentType: 'DNI', documentNumber: '41234567' });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.data.documentNumber, '41234567');

  const a1 = await cust.post('/api/store/me/addresses', { recipientName: 'Ana Ruiz', phone: '987654321', addressLine: 'Av. Larco 123', district: 'Miraflores', province: 'Lima' });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.data.isDefault, true, 'la primera es la predeterminada');
  ctx.addr = a1.body.data.id;
  const a2 = await cust.post('/api/store/me/addresses', { recipientName: 'Ana Ruiz', phone: '987654321', addressLine: 'Jr. Cusco 456', district: 'Lima', province: 'Lima', isDefault: true });
  ctx.addrOther = a2.body.data.id;
  const list = await cust.get('/api/store/me/addresses');
  assert.deepEqual(list.body.data.filter((a) => a.isDefault).map((a) => a.id), [a2.body.data.id]);
  assert.equal((await cust2.put(`/api/store/me/addresses/${ctx.addr}`, { label: 'robo' })).status, 404, 'no se accede a direcciones ajenas');
  const tmp = await cust.post('/api/store/me/addresses', { recipientName: 'Temporal', phone: '999888777', addressLine: 'Calle Falsa 1' });
  assert.equal((await cust.del(`/api/store/me/addresses/${tmp.body.data.id}`)).status, 204);
  assert.equal((await cust.get('/api/store/me/addresses')).body.data.length, 2);
});

// ================================================================ CATÁLOGO
test('catálogo público: activos y disponibles, búsqueda, filtros y sin exponer el inventario exacto', async () => {
  const pub = request(app);
  const res = await pub.get(`/api/store/products?categoryId=${ctx.cat}&pageSize=50`);
  assert.equal(res.status, 200);
  const ids = res.body.data.map((p) => p.id);
  assert.ok(ids.includes(ctx.p) && !ids.includes(ctx.hidden), 'el producto inactivo no aparece');
  const p = res.body.data.find((x) => x.id === ctx.p);
  assert.equal(p.price, '5.00');
  assert.equal(p.inStock, true);
  assert.ok(!('available' in p) && !('current_quantity' in p));
  await tx.conn.execute('UPDATE branch_products SET is_available = FALSE WHERE product_id = ? AND branch_id = 1', [ctx.last]);
  assert.ok(!(await pub.get(`/api/store/products?categoryId=${ctx.cat}&pageSize=50`)).body.data.some((x) => x.id === ctx.last), 'no habilitado en la sucursal');
  await tx.conn.execute('UPDATE branch_products SET is_available = TRUE WHERE product_id = ? AND branch_id = 1', [ctx.last]);
  assert.equal((await pub.get(`/api/store/products/${ctx.hidden}`)).status, 404);
  assert.equal((await pub.get(`/api/store/products/${ctx.rx}`)).body.data.requiresPrescription, true);
  assert.ok((await pub.get('/api/store/categories')).body.data.some((c) => c.id === ctx.cat));
  assert.ok((await pub.get('/api/store/branches')).body.data.some((b) => b.isMain));
  assert.equal((await pub.get('/api/store/products?pageSize=500')).status, 400);
});

// ================================================================ CARRITO
test('carrito: alta, modificación sin duplicados, validación de stock, eliminación y persistencia', async () => {
  const add = await cust.put(`/api/store/cart/items/${ctx.p}`, { quantity: 2 });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.data.subtotal, '10.00');
  const again = await cust.put(`/api/store/cart/items/${ctx.p}`, { quantity: 3 });
  assert.equal(again.body.data.items.length, 1, 'un producto aparece una sola vez');
  assert.equal(again.body.data.items[0].quantity, 3);
  assert.equal((await cust.put(`/api/store/cart/items/${ctx.p}`, { quantity: 0 })).status, 400);
  assert.equal((await cust.put(`/api/store/cart/items/${ctx.p}`, { quantity: 25 })).status, 422, 'supera el stock');
  assert.equal((await cust.put(`/api/store/cart/items/${ctx.hidden}`, { quantity: 1 })).status, 422);
  assert.equal((await cust.put(`/api/store/cart/items/${ctx.p}`, { quantity: 3, unitPrice: '0.01' })).status, 400, 'no se aceptan importes del cliente');
  await cust.put(`/api/store/cart/items/${ctx.rx}`, { quantity: 1 });
  assert.equal((await cust.del(`/api/store/cart/items/${ctx.rx}`)).body.data.items.length, 1);

  // Persistencia: una sesión nueva del mismo cliente ve el mismo carrito.
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/auth/csrf-token')).body.csrfToken;
  await agent.post('/api/store/auth/login').set('X-CSRF-Token', csrf).send({ email: cust.email, password: cust.password });
  const persisted = await agent.get('/api/store/cart');
  assert.deepEqual(persisted.body.data.items.map((i) => [i.productId, i.quantity]), [[ctx.p, 3]]);
});

test('cambios de precio y de stock entre el carrito y el checkout', async () => {
  await fillCart(cust, [[ctx.p, 2]]);
  await admin.put(`/api/products/${ctx.p}`, { salePrice: '6.00' });
  const cart = await cust.get('/api/store/cart');
  assert.equal(cart.body.data.subtotal, '12.00', 'el carrito muestra el precio vigente');
  const stale = await checkout(cust, { fulfillmentType: 'PICKUP', paymentMethod: 'YAPE', expectedTotal: '10.00' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'PRICE_CHANGED');
  assert.equal(stale.body.error.details.total, '12.00');
  await admin.put(`/api/products/${ctx.p}`, { salePrice: '5.00' });

  await fillCart(cust2, [[ctx.last, 2]]);
  // Una venta en mostrador consume una unidad: el checkout debe detectarlo.
  const [[caja]] = await tx.conn.execute("SELECT id FROM cash_registers WHERE branch_id = 1 AND code = 'CAJA01'");
  await admin.post('/api/cash/sessions', { cashRegisterId: caja.id, openingAmount: '50.00' });
  assert.equal((await admin.post('/api/sales', { branchId: 1, items: [{ productId: ctx.last, quantity: 1 }], payments: [{ method: 'CARD' }] })).status, 201);
  assert.deepEqual((await cust2.get('/api/store/cart')).body.data.items[0].issues, ['INSUFFICIENT_STOCK']);
  const short = await checkout(cust2, { fulfillmentType: 'PICKUP', paymentMethod: 'CARD' });
  assert.equal(short.status, 422);
  assert.equal(short.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(short.body.error.details.items[0].available, 1);
});

// ================================================================ PEDIDOS
test('recojo con Yape DEMO aprobado: pedido PENDING, sin descontar stock todavía', async () => {
  await fillCart(cust, [[ctx.p, 2]]);
  const before = await stockOf(ctx.p);
  const res = await checkout(cust, { fulfillmentType: 'PICKUP', paymentMethod: 'YAPE', expectedTotal: '10.00', customerNote: 'Recojo a las 6 pm' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const o = res.body.data;
  ctx.pickup = o;
  assert.match(o.orderNumber, /^P-SP01-\d+$/);
  assert.equal(o.status, 'PENDING');
  assert.equal(o.total, '10.00');
  assert.equal(o.balanceDue, '0.00');
  assert.equal(o.payments[0].status, 'APPROVED');
  assert.match(o.payments[0].reference, /^DEMO-YAPE-/);
  assert.equal(o.history[0].to, 'PENDING');
  assert.equal(await stockOf(ctx.p), before, 'PENDING no descuenta stock');
  assert.equal((await cust.get('/api/store/cart')).body.data.items.length, 0, 'el carrito se convirtió');
  assert.equal((await checkout(cust, { fulfillmentType: 'PICKUP', paymentMethod: 'YAPE' })).body.error.code, 'CART_EMPTY');
});

test('idempotencia: reintentar el checkout devuelve el mismo pedido', async () => {
  await fillCart(cust, [[ctx.p, 1]]);
  const k = key();
  const first = await checkout(cust, { fulfillmentType: 'PICKUP', paymentMethod: 'CARD' }, k);
  assert.equal(first.status, 201);
  const again = await checkout(cust, { fulfillmentType: 'PICKUP', paymentMethod: 'CARD' }, k);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.id, first.body.data.id);
  assert.equal(again.body.data.idempotentReplay, true);
  const [[c]] = await tx.conn.execute('SELECT COUNT(*) c FROM payments WHERE order_id = ?', [first.body.data.id]);
  assert.equal(n(c.c), 1, 'sin doble cobro');
  ctx.cardOrder = first.body.data;
});

test('pago DEMO rechazado: pedido cancelado con el intento registrado y carrito conservado', async () => {
  await fillCart(cust2, [[ctx.p, 1]]);
  const res = await checkout(cust2, { fulfillmentType: 'PICKUP', paymentMethod: 'CARD', simulatePayment: 'REJECT' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'PAYMENT_REJECTED');
  const o = await cust2.get(`/api/store/orders/${res.body.error.details.orderId}`);
  assert.equal(o.body.data.status, 'CANCELLED');
  assert.equal(o.body.data.payments[0].status, 'REJECTED');
  assert.equal((await cust2.get('/api/store/cart')).body.data.items.length, 1);
});

test('delivery: dirección propia, cobertura configurada y costo de envío', async () => {
  await fillCart(cust, [[ctx.p, 1]]);
  assert.equal((await checkout(cust, { fulfillmentType: 'DELIVERY', paymentMethod: 'CASH' })).status, 400, 'requiere dirección');
  assert.equal((await checkout(cust, { fulfillmentType: 'DELIVERY', addressId: 999999999, paymentMethod: 'CASH' })).status, 400, 'dirección inexistente o ajena');
  await tx.conn.execute("INSERT INTO settings (setting_key, setting_value, value_type) VALUES ('orders.delivery_districts', '[\"Miraflores\"]', 'JSON')");
  await tx.conn.execute("UPDATE settings SET setting_value = '7.50' WHERE setting_key = 'orders.default_delivery_fee'");
  const out = await checkout(cust, { fulfillmentType: 'DELIVERY', addressId: ctx.addrOther, paymentMethod: 'CASH' });
  assert.equal(out.status, 422);
  assert.equal(out.body.error.code, 'OUT_OF_COVERAGE');
  const ok = await checkout(cust, { fulfillmentType: 'DELIVERY', addressId: ctx.addr, paymentMethod: 'CASH' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.deliveryFee, '7.50');
  assert.equal(ok.body.data.total, '12.50');
  assert.equal(ok.body.data.delivery.addressLine, 'Av. Larco 123');
  assert.equal(ok.body.data.balanceDue, '12.50', 'efectivo contra entrega');
  ctx.delivery = ok.body.data;
});

test('productos con receta: el cliente la declara y el personal la valida al aceptar', async () => {
  await fillCart(cust, [[ctx.rx, 1]]);
  const missing = await checkout(cust, { fulfillmentType: 'PICKUP', paymentMethod: 'PLIN' });
  assert.equal(missing.body.error.code, 'PRESCRIPTION_REQUIRED');
  const ok = await checkout(cust, { fulfillmentType: 'PICKUP', paymentMethod: 'PLIN', prescriptions: { [ctx.rx]: 'RX-2026-777' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.match(ok.body.data.customerNote, /RX-2026-777/);
  const noVal = await staff.post(`/api/orders/${ok.body.data.id}/accept`, {});
  assert.equal(noVal.body.error.code, 'PRESCRIPTION_REQUIRED');
  const acc = await staff.post(`/api/orders/${ok.body.data.id}/accept`, { prescriptions: { [ctx.rx]: 'RX-2026-777' } });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  const sale = await admin.get(`/api/sales/${acc.body.data.sale.id}`);
  assert.equal(sale.body.data.items[0].prescriptionReference, 'RX-2026-777');
});

test('últimas unidades: un pedido pendiente las compromete para los demás', async () => {
  // ctx.last tiene 1 unidad (la otra se vendió en mostrador).
  await fillCart(cust, [[ctx.last, 1]]);
  const first = await checkout(cust, { fulfillmentType: 'PICKUP', paymentMethod: 'CARD' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  ctx.lastOrder = first.body.data;
  assert.equal((await cust2.put(`/api/store/cart/items/${ctx.last}`, { quantity: 1 })).status, 422, 'ya no hay unidades disponibles');
  assert.equal((await request(app).get(`/api/store/products/${ctx.last}`)).body.data.inStock, false);
});

test('panel: aceptar (venta ONLINE + FEFO), preparar, listo y recojo; trazabilidad', async () => {
  const before = { a: await batchQty(ctx.p, 'ST-A'), b: await batchQty(ctx.p, 'ST-B') };
  const list = await staff.get('/api/orders?status=PENDING&branchId=1&pageSize=50');
  assert.ok(list.body.data.some((o) => o.id === ctx.pickup.id));
  assert.equal((await outsider.get(`/api/orders/${ctx.pickup.id}`)).status, 403, 'otra sucursal');
  assert.equal((await outsider.get('/api/orders')).body.pagination.total, 0);

  const acc = await staff.post(`/api/orders/${ctx.pickup.id}/accept`, {});
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  const o = acc.body.data;
  assert.equal(o.status, 'CONFIRMED');
  assert.equal(o.sale.status, 'COMPLETED');
  assert.equal(await batchQty(ctx.p, 'ST-A'), before.a - 2, 'FEFO: el lote que vence antes');
  assert.equal(await batchQty(ctx.p, 'ST-B'), before.b);
  const sale = await admin.get(`/api/sales/${o.sale.id}`);
  assert.equal(sale.body.data.channel, 'ONLINE');
  assert.equal(sale.body.data.payments[0].status, 'APPROVED', 'el pago del pedido quedó enlazado a la venta');
  assert.equal((await staff.post(`/api/orders/${ctx.pickup.id}/accept`, {})).status, 409, 'sin doble aceptación');
  assert.equal(await batchQty(ctx.p, 'ST-A'), before.a - 2, 'sin doble descuento');

  assert.equal((await staff.post(`/api/orders/${ctx.pickup.id}/ready`, {})).status, 409, 'debe prepararse primero');
  assert.equal((await staff.post(`/api/orders/${ctx.pickup.id}/prepare`, {})).body.data.status, 'PREPARING');
  assert.equal((await staff.post(`/api/orders/${ctx.pickup.id}/ready`, {})).body.data.status, 'READY_FOR_PICKUP');
  const done = await staff.post(`/api/orders/${ctx.pickup.id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.status, 'COMPLETED');
  assert.ok((await admin.get(`/api/sales/${o.sale.id}`)).body.data.ticket, 'ticket interno emitido');
  const detail = await staff.get(`/api/orders/${ctx.pickup.id}`);
  assert.deepEqual(detail.body.data.history.map((h) => h.to), ['PENDING', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'COMPLETED']);
  assert.ok(detail.body.data.history.slice(1).every((h) => h.by && h.by.id === ctx.staffId), 'quién realizó cada paso');
  const mine = await cust.get(`/api/store/orders/${ctx.pickup.id}`);
  assert.equal(mine.body.data.status, 'COMPLETED');
  assert.ok(!('internalNote' in mine.body.data) && !mine.body.data.history.some((h) => h.by && h.by.id), 'el cliente no ve datos internos');
});

test('delivery con efectivo contra entrega: se cobra en la caja del repartidor', async () => {
  const id = ctx.delivery.id;
  await admin.post(`/api/orders/${id}/accept`, {});
  await admin.post(`/api/orders/${id}/prepare`, {});
  assert.equal((await admin.post(`/api/orders/${id}/ready`, {})).body.data.status, 'OUT_FOR_DELIVERY');
  // ADMIN ya tiene caja abierta (CAJA01); el outsider no tiene acceso a la sucursal.
  assert.equal((await outsider.post(`/api/orders/${id}/complete`, {})).status, 403);
  assert.equal((await staff.post(`/api/orders/${id}/complete`, { tenderedAmount: '5.00' })).body.error.code, 'INSUFFICIENT_TENDERED');
  const done = await staff.post(`/api/orders/${id}/complete`, { tenderedAmount: '20.00' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const cashPay = done.body.data.payments.find((p) => p.method === 'CASH');
  assert.deepEqual([cashPay.amount, cashPay.changeAmount, cashPay.mode], ['12.50', '7.50', 'REAL']);
  const [[cm]] = await tx.conn.execute("SELECT movement_type, amount FROM cash_movements WHERE payment_id = ?", [cashPay.id]);
  assert.deepEqual([cm.movement_type, cm.amount], ['SALE_INCOME', '12.50']);
  assert.equal(done.body.data.balanceDue, '0.00');
});

test('lotes vencidos: no se ofrecen ni se descuentan al confirmar', async () => {
  await tx.conn.execute('UPDATE user_sessions SET expires_at = NOW() + INTERVAL 30 DAY WHERE revoked_at IS NULL');
  await tx.conn.query('SET TIMESTAMP = UNIX_TIMESTAMP(NOW() + INTERVAL 10 DAY)');
  try {
    assert.equal((await cust2.put(`/api/store/cart/items/${ctx.exp}`, { quantity: 5 })).status, 422, 'solo 4 unidades no vencidas');
    await fillCart(cust2, [[ctx.exp, 4]]);
    const o = await checkout(cust2, { fulfillmentType: 'PICKUP', paymentMethod: 'CARD' });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    const acc = await staff.post(`/api/orders/${o.body.data.id}/accept`, {});
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal(await batchQty(ctx.exp, 'EX-S1'), 4, 'el lote vencido no se tocó');
    assert.equal(await batchQty(ctx.exp, 'EX-S2'), 0);
  } finally {
    await tx.conn.query('SET TIMESTAMP = DEFAULT');
  }
});

test('cancelaciones y reembolsos según estado y permisos', async () => {
  // Cliente: cancela su pedido PENDING pagado → reembolso DEMO.
  const c1 = await cust.post(`/api/store/orders/${ctx.cardOrder.id}/cancel`, { reason: 'Ya no lo necesito' });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c1.body.data.status, 'CANCELLED');
  assert.equal(c1.body.data.payments[0].status, 'REFUNDED');
  assert.equal((await cust.post(`/api/store/orders/${ctx.pickup.id}/cancel`, { reason: 'Tarde' })).body.error.code, 'ORDER_NOT_CANCELLABLE');
  assert.equal((await cust2.get(`/api/store/orders/${ctx.lastOrder.id}`)).status, 404, 'pedido ajeno');

  // Personal: confirmar y luego cancelar → anula la venta y repone stock una sola vez.
  const before = await stockOf(ctx.last);
  await admin.post(`/api/orders/${ctx.lastOrder.id}/accept`, {});
  assert.equal(await stockOf(ctx.last), before - 1);
  assert.equal((await staff.post(`/api/orders/${ctx.lastOrder.id}/cancel`, { reason: 'Sin repartidor' })).status, 403, 'STAFF sin payments.refund');
  const cx = await admin.post(`/api/orders/${ctx.lastOrder.id}/cancel`, { reason: 'Cliente no se presentó' });
  assert.equal(cx.status, 200, JSON.stringify(cx.body));
  assert.equal(cx.body.data.status, 'CANCELLED');
  assert.equal(cx.body.data.sale.status, 'VOIDED');
  assert.equal(cx.body.data.payments[0].status, 'REFUNDED');
  assert.equal(await stockOf(ctx.last), before, 'stock repuesto');
  assert.equal((await admin.post(`/api/orders/${ctx.lastOrder.id}/cancel`, { reason: 'Otra vez' })).status, 409);
  assert.equal(await stockOf(ctx.last), before, 'sin doble liberación');

  // Rechazo de un pendiente con pago aprobado.
  await fillCart(cust2, [[ctx.p, 1]]);
  const pend = await checkout(cust2, { fulfillmentType: 'PICKUP', paymentMethod: 'TRANSFER' });
  assert.equal((await staff.post(`/api/orders/${pend.body.data.id}/reject`, { reason: 'Producto en revisión' })).status, 403);
  const rj = await admin.post(`/api/orders/${pend.body.data.id}/reject`, { reason: 'Producto en revisión' });
  assert.equal(rj.body.data.status, 'REJECTED');
  assert.equal(rj.body.data.payments[0].status, 'REFUNDED');
});

test('historial de pedidos del cliente e integridad', async () => {
  const mine = await cust.get('/api/store/orders?pageSize=50');
  assert.ok(mine.body.pagination.total >= 4);
  assert.ok(mine.body.data.every((o) => !('customer' in o)));
  const [issues] = await tx.conn.execute('SELECT * FROM vw_integrity_issues');
  assert.deepEqual(issues, []);
});
