'use strict';

/**
 * Generador de alertas reales de inventario (scripts/lib/inventory-alerts.js).
 * Solo corre sobre la base TEMPORAL (npm run test:tempdb) y cada escenario vive en una transacción que se
 * revierte (transactional-db): nunca se escribe en pharma_plus.
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.PP_CONCURRENCY_DB === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';
const PASSWORD = 'Farmacia2026Segura';

test('generador de alertas reales de inventario', { skip: !enabled && 'Requiere la base temporal (npm run test:tempdb)', timeout: 600000 }, async (t) => {
  const { closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const authService = require('../../src/services/auth.service');
  const { startTransactionalDb } = require('../helpers/transactional-db');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, storeCustomer, validRuc, limaDate, uid } = require('../helpers/http');
  const alerts = require('../../scripts/lib/inventory-alerts');
  t.after(() => closePool());
  const app = createApp();

  async function scenario(name, fn) {
    await t.test(name, async () => {
      const tx = await startTransactionalDb();
      try { await fn(tx); } finally { await tx.rollbackAll(); }
    });
  }
  const q = async (tx, sql, params = []) => (await tx.conn.execute(sql, params))[0];
  const n1 = async (tx, sql, params = []) => Number(Object.values((await q(tx, sql, params))[0])[0]);
  const TABLES = ['inventory_adjustments', 'inventory_movements', 'stock_entries', 'stock_entry_items', 'product_batches', 'stock_alerts', 'sales', 'orders', 'payments', 'audit_logs'];
  const counts = async (tx) => Object.fromEntries(await Promise.all(TABLES.map(async (tb) => [tb, await n1(tx, `SELECT COUNT(*) FROM ${tb}`)])));

  async function session(tx, roleCode = 'ADMIN') {
    const user = await createTestUser(tx.conn, { roleCode, password: PASSWORD });
    const login = await authService.login({ email: user.email, password: PASSWORD }, { ip: '127.0.0.1', requestId: `qa-alerts-${uid()}` }, { portal: 'staff' });
    return {
      user, client: await loginClient(app, user),
      auth: { userId: login.user.id, branchId: login.activeBranchId, jti: login.session.jti, user: login.user, branches: login.branches, permissions: new Set(login.permissions) },
    };
  }

  /**
   * Catálogo demo en la sucursal principal: productos con códigos 9990000000001… (mínimo 10), stock por entradas
   * contabilizadas y, opcionalmente, un proveedor «Demo». lots: [[cantidad, días], …] por producto.
   */
  async function demoCatalog(admin, specs, { demoSupplier = true } = {}) {
    const categoryId = (await admin.post('/api/categories', { name: `QA Cat ${uid()}` })).body.data.id;
    const supplierId = (await admin.post('/api/suppliers', { businessName: `QA Proveedor ${uid()}`, ruc: validRuc() })).body.data.id;
    if (demoSupplier) {
      const s = await admin.post('/api/suppliers', { businessName: `Distribuidora Demo ${uid()}`, ruc: validRuc() });
      assert.equal(s.status, 201, JSON.stringify(s.body));
    }
    const ids = [];
    for (const spec of specs) {
      const p = await admin.post('/api/products', {
        sku: `QA-AL-${uid()}`, name: `Demo alerta ${uid()}`, barcode: spec.barcode, categoryId, salePrice: '4.00', minimumStock: 10,
      });
      assert.equal(p.status, 201, JSON.stringify(p.body));
      ids.push(p.body.data.id);
      if (spec.lots.length) {
        const e = await admin.post('/api/inventory/entries', {
          branchId: 1, supplierId, confirm: true,
          items: spec.lots.map(([quantity, days], i) => ({ productId: p.body.data.id, batchNumber: `QA-L${i}-${uid()}`, expiryDate: limaDate(days), quantity, unitCost: '2.00' })),
        });
        assert.equal(e.status, 201, JSON.stringify(e.body));
      }
    }
    return ids;
  }
  const bc = (i) => `99900000000${String(i).padStart(2, '0')}`;

  await scenario('simulación sin escrituras, alertas reales, FEFO, Dashboard, idempotencia y protección', async (tx) => {
    const { client: admin, auth } = await session(tx);
    // 01: 35 u. en dos lotes · 02: reservado por un pedido pendiente · 03: 43 u. en dos lotes · 04–06: 50 u.
    const ids = await demoCatalog(admin, [
      { barcode: bc(1), lots: [[15, 200], [20, 400]] },
      { barcode: bc(2), lots: [[30, 300]] },
      { barcode: bc(3), lots: [[18, 150], [25, 500]] },
      { barcode: bc(4), lots: [[50, 300]] },
      { barcode: bc(5), lots: [[50, 300]] },
      { barcode: bc(6), lots: [[50, 300]] },
    ]);
    // Producto «real» (fuera del rango demo) con poco stock: nunca debe tocarse.
    const [real] = await demoCatalog(admin, [{ barcode: '9990000000021', lots: [[11, 300]] }], { demoSupplier: false });
    const realBatch = (await q(tx, 'SELECT id, current_quantity FROM product_batches WHERE product_id = ?', [real]))[0];
    // Pedido web pendiente que reserva 2 unidades del producto 02.
    const shopper = await storeCustomer(app);
    assert.equal((await shopper.put(`/api/store/cart/items/${ids[1]}`, { quantity: 2 })).status, 200);
    const order = await shopper.post('/api/store/orders', { fulfillmentType: 'PICKUP', paymentMethod: 'CARD' });
    assert.equal(order.status, 201, JSON.stringify(order.body));

    const runId = `qa-alerts-${uid().toLowerCase()}`;
    const before = await counts(tx);
    const sim = await alerts.dryRun({ runId });
    assert.deepEqual(await counts(tx), before, 'la simulación no escribe');
    assert.deepEqual(sim.preflight.problems, [], sim.text);
    assert.deepEqual(sim.plan.need, { low: 2, out: 1, expiring: 2 });
    assert.ok(!sim.state.products.some((p) => p.id === real), 'solo productos demo');
    const out = sim.plan.adjustments.find((a) => a.role === 'OUT_OF_STOCK');
    assert.equal(out.product.id, ids[0]);
    assert.deepEqual(sim.plan.adjustments.filter((a) => a.role === 'LOW_STOCK').map((a) => a.product.id), [ids[2], ids[3]]);
    assert.ok(!sim.plan.adjustments.some((a) => a.product.id === ids[1]), 'no se reduce un producto con reservas');
    assert.match(sim.text, /Productos demo analizados/);

    const r = await alerts.execute({ runId, auth });
    const v = r.verification;
    assert.deepEqual(v.issues, [], v.issues.join('\n'));
    assert.equal(r.created.adjustments.length, 3);
    assert.equal(r.created.entries.length, 1);
    // Stock bajo y agotado según la vista real; alertas abiertas por el trigger.
    const status = await q(tx, 'SELECT product_id, available_stock, minimum_stock, stock_status FROM vw_branch_product_stock WHERE branch_id = 1 AND product_id IN (?, ?, ?)', [ids[0], ids[2], ids[3]]);
    const st = Object.fromEntries(status.map((s) => [s.product_id, s]));
    assert.equal(st[ids[0]].stock_status, 'OUT_OF_STOCK');
    assert.deepEqual([st[ids[2]], st[ids[3]]].map((s) => [s.stock_status, Number(s.available_stock)]), [['LOW_STOCK', 5], ['LOW_STOCK', 5]]);
    assert.equal(await n1(tx, "SELECT COUNT(*) FROM stock_alerts WHERE product_id = ? AND alert_type = 'OUT_OF_STOCK' AND status = 'OPEN'", [ids[0]]), 1);
    assert.equal(await n1(tx, "SELECT COUNT(*) FROM stock_alerts WHERE product_id IN (?, ?) AND alert_type = 'LOW_STOCK' AND status = 'OPEN'", [ids[2], ids[3]]), 2);
    // FEFO: en el producto 03 se descuenta primero el lote que vence antes (18 u.) y luego el otro (20 u.).
    const mv = await q(tx, `SELECT pb.expiry_date, m.quantity, m.movement_type FROM inventory_movements m JOIN product_batches pb ON pb.id = m.batch_id
      WHERE m.product_id = ? AND m.adjustment_id IS NOT NULL ORDER BY m.id`, [ids[2]]);
    assert.deepEqual(mv.map((m) => [m.movement_type, Number(m.quantity)]), [['ADJUSTMENT_OUT', 18], ['ADJUSTMENT_OUT', 20]]);
    assert.ok(mv[0].expiry_date < mv[1].expiry_date);
    // Lotes próximos a vencer: nuevos, identificables, futuros y dentro del período configurado (y de los 30 días).
    const lots = await q(tx, "SELECT batch_number, DATEDIFF(expiry_date, CURDATE()) d, current_quantity FROM product_batches WHERE batch_number LIKE 'DEMO-ALERT-%'");
    assert.equal(lots.length, 2);
    for (const l of lots) assert.ok(Number(l.d) > 0 && Number(l.d) <= 30 && Number(l.current_quantity) === 12, JSON.stringify(l));
    assert.equal(await n1(tx, "SELECT COUNT(*) FROM stock_alerts sa JOIN product_batches pb ON pb.id = sa.batch_id WHERE pb.batch_number LIKE 'DEMO-ALERT-%' AND sa.alert_type = 'EXPIRING_SOON' AND sa.status = 'OPEN'"), 2);
    // Producto real, pedido pendiente y reservas intactos.
    assert.equal(Number((await q(tx, 'SELECT current_quantity FROM product_batches WHERE id = ?', [realBatch.id]))[0].current_quantity), Number(realBatch.current_quantity));
    assert.equal((await q(tx, 'SELECT status FROM orders WHERE id = ?', [order.body.data.id]))[0].status, 'PENDING');
    for (const k of ['sales', 'orders', 'returns', 'payments', 'cash', 'users', 'suppliers', 'minimums', 'nonDemoBatches']) assert.equal(v.integrity[k], true, k);

    // Endpoint real del Dashboard que usa el panel.
    const dash = await admin.get('/api/reports/dashboard?branchId=1');
    assert.equal(dash.status, 200);
    assert.ok(dash.body.data.lowStockProducts >= 3, JSON.stringify(dash.body.data));
    assert.ok(dash.body.data.batchesExpiringIn30Days >= 2);
    assert.ok(dash.body.data.openAlerts.LOW_STOCK >= 2 && dash.body.data.openAlerts.OUT_OF_STOCK >= 1 && dash.body.data.openAlerts.EXPIRING_SOON >= 2);
    const lowList = await admin.get('/api/inventory/low-stock?branchId=1&pageSize=100');
    assert.equal(lowList.status, 200);

    // Idempotencia: la misma ejecución no repite operaciones.
    const mid = await counts(tx);
    const again = await alerts.dryRun({ runId });
    assert.deepEqual(again.plan.need, { low: 0, out: 0, expiring: 0 });
    assert.equal(again.state.runAdjustments.length, 3);
    const r2 = await alerts.execute({ runId, auth });
    assert.deepEqual(r2.created, { adjustments: [], entries: [] });
    const after = await counts(tx);
    for (const k of TABLES.filter((x) => x !== 'audit_logs')) assert.equal(after[k], mid[k], `${k} sin duplicados`);
    assert.deepEqual(r2.verification.issues, []);
  });

  await scenario('reanudación tras una interrupción con el mismo RUN_ID', async (tx) => {
    const { client: admin, auth } = await session(tx);
    await demoCatalog(admin, [1, 2, 3, 4, 5].map((i) => ({ barcode: bc(i), lots: [[40 + i, 300]] })));
    const runId = `qa-alerts-${uid().toLowerCase()}`;
    await assert.rejects(alerts.execute({ runId, auth, hooks: { failAfterAdjustments: 1 } }), /Falla simulada/);
    const partial = await alerts.dryRun({ runId });
    assert.deepEqual(partial.plan.need, { low: 2, out: 0, expiring: 2 }, 'el agotado ya quedó registrado');
    const r = await alerts.execute({ runId, auth });
    assert.equal(r.created.adjustments.length, 2);
    assert.deepEqual(r.verification.issues, []);
    assert.equal(r.verification.adjustments.length, 3, 'tres ajustes en total, sin duplicados');
    assert.equal(r.verification.entries.length, 1);
  });

  await scenario('precondiciones: sin permisos, stock comprometido, sin proveedor demo y protección', async (tx) => {
    const { client: admin, auth } = await session(tx);
    const runId = `qa-alerts-${uid().toLowerCase()}`;
    // Un solo producto demo cuyo stock está reservado por un pedido pendiente; sin proveedor demo.
    const [only] = await demoCatalog(admin, [{ barcode: bc(1), lots: [[15, 300]] }], { demoSupplier: false });
    const shopper = await storeCustomer(app);
    await shopper.put(`/api/store/cart/items/${only}`, { quantity: 1 });
    assert.equal((await shopper.post('/api/store/orders', { fulfillmentType: 'PICKUP', paymentMethod: 'YAPE' })).status, 201);
    const sim = await alerts.dryRun({ runId });
    assert.ok(sim.preflight.problems.some((p) => /pueda agotarse/.test(p)), sim.text);
    assert.ok(sim.preflight.problems.some((p) => /stock sobre el mínimo y sin reservas/.test(p)), sim.text);
    assert.ok(sim.preflight.problems.some((p) => /proveedor de demostración/.test(p)), sim.text);
    const before = await counts(tx);
    await assert.rejects(alerts.execute({ runId, auth }), (err) => err.code === 'ALERTS_PRECONDITION');
    assert.deepEqual(await counts(tx), before, 'sin escrituras');

    // Con catálogo suficiente, un trabajador sin inventory.adjust no puede ejecutar.
    await demoCatalog(admin, [2, 3, 4, 5].map((i) => ({ barcode: bc(i), lots: [[60, 300]] })));
    const staff = await session(tx, 'STAFF');
    await assert.rejects(alerts.execute({ runId, auth: staff.auth }), (err) => err.problems?.some((p) => /Faltan permisos: .*inventory\.adjust/.test(p)));
    assert.equal(await n1(tx, 'SELECT COUNT(*) FROM inventory_adjustments'), before.inventory_adjustments);
    // Fuera del rango de códigos demo nada se considera.
    assert.equal(alerts.isDemoBarcode('9990000000021'), false);
    assert.equal(alerts.isDemoBarcode('9990000000020'), true);
  });
});
