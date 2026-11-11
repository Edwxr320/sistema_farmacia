'use strict';

/**
 * Concurrencia REAL (conexiones paralelas del pool, datos confirmados) para devoluciones y
 * transferencias. Solo corre contra una base temporal (npm run test:tempdb). Con pharma_plus se omite.
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.PP_CONCURRENCY_DB === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';

test('devoluciones y transferencias simultáneas: sin duplicados ni stock inconsistente', { skip: !enabled && 'Requiere la base temporal (npm run test:tempdb)' }, async (t) => {
  const { withTransaction, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, stockedProduct, uid } = require('../helpers/http');
  t.after(() => closePool());

  const PASSWORD = 'Farmacia2026Segura';
  const app = createApp();
  const code = `QC${uid().slice(0, 4)}`;
  const ids = await withTransaction({ requestId: 'qa-cc-ops-setup' }, async (conn) => {
    await conn.execute("INSERT INTO branches (code, name, status) VALUES (?, ?, 'ACTIVE')", [code, `QA ${code}`]);
    const [[b]] = await conn.execute('SELECT id FROM branches WHERE code = ?', [code]);
    const a = await createTestUser(conn, { roleCode: 'ADMIN', password: PASSWORD });
    const d = await createTestUser(conn, { roleCode: 'STAFF', password: PASSWORD, withBranch: false });
    await conn.execute('INSERT INTO user_branches (user_id, branch_id, is_default) VALUES (?, ?, TRUE)', [d.id, b.id]);
    const [r] = await conn.execute('INSERT INTO cash_registers (branch_id, code, name) VALUES (1, ?, ?)', [code, `Caja ${code}`]);
    return { a, d, dest: b.id, register: r.insertId };
  });
  const admin = await loginClient(app, ids.a);
  const dest = await loginClient(app, ids.d);
  assert.equal((await admin.post('/api/cash/sessions', { cashRegisterId: ids.register, openingAmount: '50.00' })).status, 201);
  const { productId } = await stockedProduct(admin, { salePrice: '2.00', batches: [{ batchNumber: `CO-${uid()}`, days: 200, quantity: 20 }] });
  const read = (sql, params) => withTransaction({ requestId: 'qa-cc-read' }, async (conn) => (await conn.execute(sql, params))[0]);

  // ---------------------------------------------------------- devoluciones
  const sale = await admin.post('/api/sales', { branchId: 1, items: [{ productId, quantity: 3 }], payments: [{ method: 'CARD' }] });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  const saleItemId = sale.body.data.items[0].id;
  const ret = () => admin.post('/api/returns', { saleId: sale.body.data.id, reasonCode: 'OTHER', process: true, items: [{ saleItemId, quantity: 2, condition: 'RESELLABLE' }] });
  const [r1, r2] = await Promise.all([ret(), ret()]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 422], JSON.stringify([r1.body, r2.body]));
  const [returned] = await read(
    "SELECT COALESCE(SUM(sri.quantity),0) q, COALESCE(SUM(sri.line_refund_amount),0) amt FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.sale_return_id WHERE sr.sale_id = ? AND sr.status <> 'REJECTED'",
    [sale.body.data.id]);
  assert.equal(Number(returned.q), 2, 'una sola devolución registrada');
  assert.equal(returned.amt, '4.00');

  // -------------------------------------------------------- transferencias
  const [batch] = await read('SELECT id FROM product_batches WHERE branch_id = 1 AND product_id = ? LIMIT 1', [productId]);
  const tr = await admin.post('/api/inventory/transfers', { originBranchId: 1, destinationBranchId: ids.dest, items: [{ batchId: batch.id, quantity: 5 }] });
  assert.equal(tr.status, 201, JSON.stringify(tr.body));
  const id = tr.body.data.id;
  await admin.post(`/api/inventory/transfers/${id}/approve`, {});
  const [d1, d2] = await Promise.all([1, 2].map(() => admin.post(`/api/inventory/transfers/${id}/dispatch`, {})));
  assert.deepEqual([d1.status, d2.status].sort(), [200, 409], JSON.stringify([d1.body, d2.body]));
  const itemId = tr.body.data.items[0].id;
  const [v1, v2] = await Promise.all([1, 2].map(() => dest.post(`/api/inventory/transfers/${id}/receive`, { items: [{ itemId, receivedQuantity: 5 }] })));
  assert.deepEqual([v1.status, v2.status].sort(), [200, 409], JSON.stringify([v1.body, v2.body]));

  const [moves] = await read(
    "SELECT SUM(movement_type = 'TRANSFER_OUT') o, SUM(movement_type = 'TRANSFER_IN') i FROM inventory_movements WHERE transfer_item_id = ?", [itemId]);
  assert.deepEqual([Number(moves.o), Number(moves.i)], [1, 1], 'un solo despacho y una sola recepción');
  const [stock] = await read(
    'SELECT (SELECT SUM(current_quantity) FROM product_batches WHERE product_id = ? AND branch_id = 1) origin, (SELECT SUM(current_quantity) FROM product_batches WHERE product_id = ? AND branch_id = ?) dest',
    [productId, productId, ids.dest]);
  // 20 − 3 vendidas + 2 devueltas − 5 transferidas = 14 en origen; 5 en destino
  assert.deepEqual([Number(stock.origin), Number(stock.dest)], [14, 5]);
  assert.deepEqual(await read('SELECT * FROM vw_integrity_issues'), []);
});
