'use strict';

/**
 * PAYMENT_PROVIDER=disabled (solo efectivo), end-to-end contra MariaDB:
 *  - /api/settings/public informa que no hay pagos electrónicos;
 *  - el checkout con Yape se rechaza con 503 y NO crea pedido ni pago (el carrito se conserva);
 *  - el checkout en efectivo sí registra el pedido.
 * Corre en su propio proceso: el proveedor se fija antes de cargar src/.
 */
process.env.PAYMENT_PROVIDER = 'disabled';
require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closePool } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const { loginClient, stockedProduct, storeCustomer } = require('../helpers/http');

let tx;
let app;
let cust;
let productId;

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: 'Farmacia2026Segura' });
  const admin = await loginClient(app, a);
  productId = (await stockedProduct(admin, { salePrice: '4.00', batches: [{ batchNumber: 'PG-1', days: 200, quantity: 10 }] })).productId;
  cust = await storeCustomer(app);
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
});

const count = async (sql, args) => Number((await tx.conn.execute(sql, args))[0][0].n);

test('sin pasarela: la tienda solo acepta efectivo y no registra pagos simulados', async () => {
  const pub = await request(app).get('/api/settings/public');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.payments.electronicEnabled, false);
  assert.equal(pub.body.data.payments.mode, 'DISABLED');

  assert.equal((await cust.put(`/api/store/cart/items/${productId}`, { quantity: 2 })).status, 200);
  const custRow = await tx.conn.execute('SELECT c.id FROM customers c JOIN users u ON u.id = c.user_id ORDER BY c.id DESC LIMIT 1');
  const customerId = custRow[0][0].id;
  const before = await count('SELECT COUNT(*) n FROM orders WHERE customer_id = ?', [customerId]);

  const yape = await cust.post('/api/store/orders', { fulfillmentType: 'PICKUP', paymentMethod: 'YAPE', expectedTotal: '8.00' });
  assert.equal(yape.status, 503, JSON.stringify(yape.body));
  assert.equal(yape.body.error.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
  assert.equal(await count('SELECT COUNT(*) n FROM orders WHERE customer_id = ?', [customerId]), before, 'no se crea el pedido');
  assert.equal((await cust.get('/api/store/cart')).body.data.items.length, 1, 'el carrito se conserva');

  const cash = await cust.post('/api/store/orders', { fulfillmentType: 'PICKUP', paymentMethod: 'CASH', expectedTotal: '8.00' });
  assert.equal(cash.status, 201, JSON.stringify(cash.body));
  assert.equal(cash.body.data.status, 'PENDING');
  assert.equal(await count('SELECT COUNT(*) n FROM payments WHERE order_id = ?', [cash.body.data.id]), 0, 'efectivo: se cobra al recoger');
});
