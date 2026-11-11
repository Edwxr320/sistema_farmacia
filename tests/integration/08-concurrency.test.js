'use strict';

/**
 * Ventas SIMULTÁNEAS con conexiones reales y paralelas del pool (sin transacción de prueba).
 * Como confirma datos, solo se ejecuta contra una base TEMPORAL indicada explícitamente:
 *   PP_CONCURRENCY_DB=1 DB_NAME=<base_temporal> node --test tests/integration/08-concurrency.test.js
 * En la suite normal (base real pharma_plus) se omite.
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.PP_CONCURRENCY_DB === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';

test('ventas simultáneas: sin stock negativo, sin doble descuento', { skip: !enabled && 'Requiere PP_CONCURRENCY_DB=1 y una base temporal (DB_NAME)' }, async (t) => {
  const { withTransaction, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, stockedProduct, uid } = require('../helpers/http');
  t.after(() => closePool());

  const PASSWORD = 'Farmacia2026Segura';
  const app = createApp();
  const ids = await withTransaction({ requestId: 'qa-concurrency-setup' }, async (conn) => {
    const a = await createTestUser(conn, { roleCode: 'ADMIN', password: PASSWORD });
    const s1 = await createTestUser(conn, { roleCode: 'STAFF', password: PASSWORD });
    const s2 = await createTestUser(conn, { roleCode: 'STAFF', password: PASSWORD });
    const s3 = await createTestUser(conn, { roleCode: 'STAFF', password: PASSWORD });
    const regs = [];
    for (const code of ['QC1', 'QC2', 'QC3']) {
      const [r] = await conn.execute('INSERT INTO cash_registers (branch_id, code, name) VALUES (1, ?, ?)', [code, `Caja ${code}`]);
      regs.push(r.insertId);
    }
    return { a, staff: [s1, s2, s3], regs };
  });
  const admin = await loginClient(app, ids.a);
  const sellers = [];
  for (const [i, s] of ids.staff.entries()) {
    const c = await loginClient(app, s);
    const open = await c.post('/api/cash/sessions', { cashRegisterId: ids.regs[i], openingAmount: '10.00' });
    assert.equal(open.status, 201, JSON.stringify(open.body));
    sellers.push(c);
  }

  const { productId } = await stockedProduct(admin, { salePrice: '3.00', batches: [{ batchNumber: `CC-${uid()}`, days: 200, quantity: 5 }] });
  const sell = (client, quantity, headers = {}) => {
    const r = client.agent.post('/api/sales').set('X-CSRF-Token', client.csrf);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r.send({ branchId: 1, items: [{ productId, quantity }], payments: [{ method: 'CARD' }] });
  };
  const stock = async () => withTransaction({ requestId: 'qa-cc' }, async (conn) => {
    const [[r]] = await conn.execute('SELECT SUM(current_quantity) q, (SELECT COALESCE(SUM(quantity),0) FROM inventory_movements WHERE product_id = ? AND movement_type = \'SALE_OUT\') sold FROM product_batches WHERE product_id = ?', [productId, productId]);
    return { stock: Number(r.q), sold: Number(r.sold) };
  });

  // 1) Dos ventas simultáneas de 4 unidades sobre 5 disponibles: solo una puede completarse.
  const [r1, r2] = await Promise.all([sell(sellers[0], 4), sell(sellers[1], 4)]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 422], JSON.stringify([r1.body, r2.body]));
  assert.equal([r1, r2].find((r) => r.status === 422).body.error.code, 'INSUFFICIENT_STOCK');
  assert.deepEqual(await stock(), { stock: 1, sold: 4 });

  // 2) Tres ventas simultáneas de 1 unidad sobre 1 disponible: exactamente una.
  const three = await Promise.all(sellers.map((c) => sell(c, 1)));
  assert.equal(three.filter((r) => r.status === 201).length, 1, JSON.stringify(three.map((r) => r.status)));
  assert.deepEqual(await stock(), { stock: 0, sold: 5 });

  // 3) Doble envío simultáneo con la misma Idempotency-Key: una sola venta y un solo descuento.
  const { productId: p2 } = await stockedProduct(admin, { salePrice: '1.00', batches: [{ batchNumber: `CI-${uid()}`, days: 200, quantity: 10 }] });
  const key = `qa-cc-${uid()}${uid()}`;
  const body = { branchId: 1, items: [{ productId: p2, quantity: 3 }], payments: [{ method: 'CARD' }] };
  const send = () => sellers[0].agent.post('/api/sales').set('X-CSRF-Token', sellers[0].csrf).set('Idempotency-Key', key).send(body);
  const [d1, d2] = await Promise.all([send(), send()]);
  assert.deepEqual([d1.status, d2.status].sort(), [200, 201]);
  assert.equal(d1.body.data.id, d2.body.data.id);
  const after = await withTransaction({ requestId: 'qa-cc2' }, async (conn) => {
    const [[r]] = await conn.execute('SELECT SUM(current_quantity) q FROM product_batches WHERE product_id = ?', [p2]);
    const [issues] = await conn.execute('SELECT * FROM vw_integrity_issues');
    return { q: Number(r.q), issues };
  });
  assert.equal(after.q, 7, 'descontado una sola vez');
  assert.deepEqual(after.issues, []);
});
