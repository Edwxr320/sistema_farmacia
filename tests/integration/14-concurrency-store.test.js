'use strict';

/**
 * Concurrencia REAL de la tienda (conexiones paralelas, datos confirmados): solo con la base
 * temporal (npm run test:tempdb). Con pharma_plus se omite.
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.PP_CONCURRENCY_DB === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';

test('tienda: últimas unidades, doble confirmación y doble aceptación simultáneas', { skip: !enabled && 'Requiere la base temporal (npm run test:tempdb)' }, async (t) => {
  const { withTransaction, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, stockedProduct, storeCustomer, uid } = require('../helpers/http');
  t.after(() => closePool());

  const app = createApp();
  const a = await withTransaction({ requestId: 'qa-cc-store' }, (conn) => createTestUser(conn, { roleCode: 'ADMIN', password: 'Farmacia2026Segura' }));
  const admin = await loginClient(app, a);
  const read = (sql, params) => withTransaction({ requestId: 'qa-cc-read' }, async (conn) => (await conn.execute(sql, params))[0]);

  // 1) Dos clientes compran a la vez las 2 últimas unidades.
  const { productId } = await stockedProduct(admin, { salePrice: '4.00', batches: [{ batchNumber: `CS-${uid()}`, days: 200, quantity: 2 }] });
  const c1 = await storeCustomer(app);
  const c2 = await storeCustomer(app);
  for (const c of [c1, c2]) assert.equal((await c.put(`/api/store/cart/items/${productId}`, { quantity: 2 })).status, 200);
  const buy = (c, key) => {
    const r = c.agent.post('/api/store/orders').set('X-CSRF-Token', c.csrf);
    if (key) r.set('Idempotency-Key', key);
    return r.send({ fulfillmentType: 'PICKUP', paymentMethod: 'CARD' });
  };
  const [o1, o2] = await Promise.all([buy(c1), buy(c2)]);
  assert.deepEqual([o1.status, o2.status].sort(), [201, 422], JSON.stringify([o1.body, o2.body]));
  const won = [o1, o2].find((r) => r.status === 201).body.data;
  const [pending] = await read("SELECT COUNT(*) c FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE oi.product_id = ? AND o.status = 'PENDING'", [productId]);
  assert.equal(Number(pending.c), 1, 'solo un pedido comprometió las unidades');
  const [charged] = await read("SELECT COUNT(*) c FROM payments p JOIN order_items oi ON oi.order_id = p.order_id WHERE oi.product_id = ? AND p.status = 'APPROVED'", [productId]);
  assert.equal(Number(charged.c), 1, 'solo un cobro');

  // 2) Doble envío simultáneo del checkout con la misma clave: un solo pedido y un solo cobro.
  const { productId: p2 } = await stockedProduct(admin, { salePrice: '1.50', batches: [{ batchNumber: `CK-${uid()}`, days: 200, quantity: 10 }] });
  const c3 = await storeCustomer(app);
  await c3.put(`/api/store/cart/items/${p2}`, { quantity: 3 });
  const key = `qa-cc-co-${uid()}${uid()}`;
  const [k1, k2] = await Promise.all([buy(c3, key), buy(c3, key)]);
  assert.deepEqual([k1.status, k2.status].sort(), [200, 201], JSON.stringify([k1.body, k2.body]));
  assert.equal(k1.body.data.id, k2.body.data.id);
  const [orders] = await read('SELECT COUNT(DISTINCT o.id) c FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE oi.product_id = ?', [p2]);
  assert.equal(Number(orders.c), 1);

  // 3) Dos trabajadores aceptan a la vez el mismo pedido: un solo descuento de stock.
  const [acc1, acc2] = await Promise.all([1, 2].map(() => admin.post(`/api/orders/${won.id}/accept`, {})));
  assert.deepEqual([acc1.status, acc2.status].sort(), [200, 409], JSON.stringify([acc1.body, acc2.body]));
  const [stock] = await read("SELECT SUM(current_quantity) q, (SELECT COUNT(*) FROM sales WHERE order_id = ?) sales FROM product_batches WHERE product_id = ?", [won.id, productId]);
  assert.deepEqual([Number(stock.q), Number(stock.sales)], [0, 1]);
  assert.deepEqual(await read('SELECT * FROM vw_integrity_issues'), []);
});
