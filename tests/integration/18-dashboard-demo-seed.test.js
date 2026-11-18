'use strict';

/**
 * Generador de datos de demostración del Dashboard (scripts/lib/dashboard-demo.js).
 * Solo corre sobre la base TEMPORAL (npm run test:tempdb) y, además, cada escenario vive dentro de una
 * transacción que se revierte (transactional-db): nunca se escribe en pharma_plus.
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.PP_CONCURRENCY_DB === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';
const PASSWORD = 'Farmacia2026Segura';

test('generador de datos de demostración del Dashboard', { skip: !enabled && 'Requiere la base temporal (npm run test:tempdb)', timeout: 600000 }, async (t) => {
  const { closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const authService = require('../../src/services/auth.service');
  const saleService = require('../../src/services/sale.service');
  const { startTransactionalDb } = require('../helpers/transactional-db');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, stockedProduct, uid } = require('../helpers/http');
  const demo = require('../../scripts/lib/dashboard-demo');
  t.after(() => closePool());
  const app = createApp();

  /** Ejecuta un escenario dentro de una transacción que se revierte al final. */
  async function scenario(name, fn) {
    await t.test(name, async () => {
      const tx = await startTransactionalDb();
      try {
        await fn(tx);
      } finally {
        await tx.rollbackAll();
      }
    });
  }
  const q = async (tx, sql, params = []) => (await tx.conn.execute(sql, params))[0];
  const n1 = async (tx, sql, params = []) => Number(Object.values((await q(tx, sql, params))[0])[0]);
  const TABLES = ['sales', 'sale_items', 'sale_item_batches', 'payments', 'cash_registers', 'cash_sessions', 'cash_movements', 'orders',
    'order_items', 'order_status_history', 'sale_returns', 'sale_return_items', 'inventory_movements', 'users', 'customers', 'carts', 'audit_logs', 'user_sessions'];
  const counts = async (tx) => Object.fromEntries(await Promise.all(TABLES.map(async (tb) => [tb, await n1(tx, `SELECT COUNT(*) FROM ${tb}`)])));
  const sumStock = (tx) => n1(tx, 'SELECT COALESCE(SUM(current_quantity), 0) FROM product_batches');

  async function adminSession(tx, roleCode = 'ADMIN') {
    const user = await createTestUser(tx.conn, { roleCode, password: PASSWORD });
    const login = await authService.login({ email: user.email, password: PASSWORD }, { ip: '127.0.0.1', requestId: `qa-demo-login-${uid()}` }, { portal: 'staff' });
    return {
      user,
      auth: {
        userId: login.user.id, branchId: login.activeBranchId, jti: login.session.jti, sessionHash: login.session.sessionHash,
        user: login.user, branches: login.branches, permissions: new Set(login.permissions),
      },
    };
  }

  /** Catálogo con stock real (entradas contabilizadas): 6 productos, uno con receta y uno con dos lotes (FEFO). */
  async function catalog(admin, { units = 60, products = 6 } = {}) {
    const first = await stockedProduct(admin, { salePrice: '3.50', batches: [{ batchNumber: `FEFO-A-${uid()}`, days: 90, quantity: units }, { batchNumber: `FEFO-B-${uid()}`, days: 400, quantity: units }] });
    const ids = [first.productId];
    for (let i = 1; i < products; i += 1) {
      const p = await stockedProduct(admin, {
        salePrice: (2 + i * 1.25).toFixed(2), requiresPrescription: i === 2, categoryId: first.categoryId, supplierId: first.supplierId,
        batches: [{ batchNumber: `DM-${i}-${uid()}`, days: 200 + i * 10, quantity: units }],
      });
      ids.push(p.productId);
    }
    return ids;
  }

  await scenario('simulación sin escrituras, ejecución completa, verificación, idempotencia y caja real intacta', async (tx) => {
    const { user, auth } = await adminSession(tx);
    const admin = await loginClient(app, user);
    const products = await catalog(admin);
    assert.equal((await admin.post('/api/customers', { fullName: 'Cliente Real Existente' })).status, 201);
    const runId = `qa-demo-${uid().toLowerCase()}`;

    // Una caja REAL abierta por otro trabajador no debe verse afectada.
    const other = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
    const otherClient = await loginClient(app, other);
    const [caja01] = await q(tx, "SELECT id FROM cash_registers WHERE code = 'CAJA01'");
    const realOpen = await otherClient.post('/api/cash/sessions', { cashRegisterId: caja01.id, openingAmount: '50.00' });
    assert.equal(realOpen.status, 201, JSON.stringify(realOpen.body));
    const realBefore = (await q(tx, 'SELECT * FROM cash_sessions WHERE id = ?', [realOpen.body.data.id]))[0];

    // 1) Simulación: no escribe nada.
    const before = await counts(tx);
    const stockBefore = await sumStock(tx);
    const sim = await demo.dryRun({ runId });
    assert.deepEqual(await counts(tx), before, 'la simulación no debe escribir');
    assert.equal(await sumStock(tx), stockBefore);
    assert.deepEqual(sim.preflight.problems, []);
    assert.equal(sim.plan.sales.length, 25);
    assert.equal(sim.plan.orders.length, 10);
    assert.equal(sim.plan.returns.length, 3);
    assert.match(sim.text, /se creará: PPDEMO/);
    assert.match(sim.text, /CASH 5 · YAPE 5 · PLIN 5 · CARD 5 · TRANSFER 5/);
    // Mismo RUN_ID → mismo plan.
    const again = await demo.dryRun({ runId });
    assert.deepEqual(again.plan.sales.map((s) => [s.key, s.method, s.lines.map((l) => [l.productId, l.quantity])]),
      sim.plan.sales.map((s) => [s.key, s.method, s.lines.map((l) => [l.productId, l.quantity])]));
    for (const s of sim.plan.sales) assert.equal(new Set(s.lines.map((l) => l.productId)).size, s.lines.length, 'sin productos repetidos en una venta');

    // 2) Ejecución con los servicios reales.
    const startedAt = new Date(Date.now() - 2000);
    const r = await demo.execute({ runId, auth });
    assert.deepEqual(r.created, { sales: 25, orders: 10, returns: 3, customer: true, register: true, session: true });
    const v = r.verification;
    assert.deepEqual(v.issues, [], v.issues.join('\n'));
    assert.equal(v.pos.count, 25);
    assert.ok(v.pos.distinctDays >= 20, `días distintos: ${v.pos.distinctDays}`);
    assert.ok(v.pos.withCustomer > 0 && v.pos.quick > 0);
    for (const m of ['CASH', 'YAPE', 'PLIN', 'CARD', 'TRANSFER']) assert.equal(v.payments[m].count, 5, m);
    for (const m of ['YAPE', 'PLIN', 'CARD', 'TRANSFER']) assert.equal(v.payments[m].simulated, 5, `${m} simulado`);
    assert.equal(v.payments.CASH.simulated, 0);
    assert.deepEqual(v.orders.byStatus, { PENDING: 2, CONFIRMED: 2, PREPARING: 2, READY_FOR_PICKUP: 2, COMPLETED: 2 });
    assert.equal(v.orders.onlineSales, 8);
    assert.equal(v.orders.demoPayments, 10);
    assert.equal(v.returns.count, 3);
    assert.equal(v.returns.restockedUnits, 3);
    assert.equal(v.inventory.returnIn, 3);
    assert.ok(!v.returns.methods.includes('CASH'));
    assert.equal(v.integrity.previousSalesIntact, true);
    assert.equal(v.integrity.realCashIntact, true);
    assert.equal(v.integrity.stockMatchesMovements, true);
    assert.equal(v.cashSessions.length, 1);
    assert.equal(v.cashSessions[0].status, 'CLOSED');
    assert.equal(Number(v.cashSessions[0].difference), 0);

    // Fechas: sold_at histórico (últimos 30 días, nunca futuro); las demás fechas son las reales.
    const sales = await q(tx, `SELECT s.id, s.sold_at, s.cash_session_id FROM sales s JOIN audit_logs a ON a.entity_table = 'sales'
      AND a.action = 'CREATE' AND a.entity_id = s.id WHERE a.request_id LIKE ?`, [`${runId}-pos-%`]);
    const now = Date.now();
    for (const s of sales) {
      const at = new Date(s.sold_at).getTime();
      assert.ok(at <= now && at >= now - 30 * 86400000, `sold_at fuera de rango: ${s.sold_at}`);
    }
    assert.ok(sales.some((s) => new Date(s.sold_at).getTime() < now - 20 * 86400000), 'hay ventas antiguas');
    const ids = sales.map((s) => s.id);
    const marks = ids.map(() => '?').join(',');
    assert.equal(await n1(tx, `SELECT COUNT(*) FROM payments WHERE sale_id IN (${marks}) AND paid_at < ?`, [...ids, startedAt]), 0, 'paid_at real');
    assert.equal(await n1(tx, 'SELECT COUNT(*) FROM inventory_movements WHERE request_id LIKE ? AND created_at < ?', [`${runId}-%`, startedAt]), 0, 'movimientos con fecha real');
    assert.equal(await n1(tx, 'SELECT COUNT(*) FROM audit_logs WHERE request_id LIKE ? AND created_at < ?', [`${runId}-%`, startedAt]), 0, 'auditoría con fecha real');
    const [demoSession] = await q(tx, 'SELECT opened_at FROM cash_sessions WHERE opening_notes = ?', [demo.tagOf(runId)]);
    assert.ok(new Date(demoSession.opened_at) >= startedAt, 'apertura de caja con fecha real');
    assert.ok(sales.every((s) => s.cash_session_id), 'ventas en la sesión demo');

    // FEFO: el producto con dos lotes solo consume el que vence antes.
    const fefo = await q(tx, `SELECT pb.batch_number, SUM(sib.quantity) q FROM sale_item_batches sib JOIN sale_items si ON si.id = sib.sale_item_id
      JOIN product_batches pb ON pb.id = sib.batch_id WHERE si.product_id = ? GROUP BY pb.batch_number`, [products[0]]);
    assert.ok(fefo.length >= 1 && fefo.every((f) => f.batch_number.startsWith('FEFO-A-')), JSON.stringify(fefo));
    // Receta: las líneas del producto con receta llevan una referencia DEMO.
    const rx = await q(tx, 'SELECT prescription_reference FROM sale_items WHERE product_id = ?', [products[2]]);
    assert.ok(rx.every((x) => /^DEMO-RX-/.test(x.prescription_reference || '')), JSON.stringify(rx));
    // Pedidos pendientes siguen reservando stock; los confirmados ya tienen venta ONLINE con FEFO.
    assert.equal(await n1(tx, "SELECT COUNT(*) FROM orders o JOIN audit_logs a ON a.entity_id = o.id AND a.entity_table = 'orders' AND a.action = 'CREATE' WHERE a.request_id LIKE ? AND o.status = 'PENDING' AND o.fulfillment_type = 'PICKUP'", [`${runId}-ord-%`]), 2);
    // Caja real del otro trabajador intacta; cliente demo es CUSTOMER.
    assert.deepEqual((await q(tx, 'SELECT * FROM cash_sessions WHERE id = ?', [realOpen.body.data.id]))[0], realBefore);
    const [cust] = await q(tx, 'SELECT r.code, u.password_hash FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?', [demo.demoEmail(runId)]);
    assert.equal(cust.code, 'CUSTOMER');
    assert.match(cust.password_hash, /^\$2[aby]\$/);
    const [reg] = await q(tx, "SELECT name FROM cash_registers WHERE code = 'PPDEMO'");
    assert.equal(reg.name, demo.REGISTER.name);

    // 3) Idempotencia: el mismo RUN_ID no duplica nada.
    const mid = await counts(tx);
    const r2 = await demo.execute({ runId, auth });
    assert.deepEqual(r2.created, { sales: 0, orders: 0, returns: 0, customer: false, register: false, session: false });
    const after = await counts(tx);
    for (const tb of TABLES.filter((x) => !['audit_logs', 'user_sessions'].includes(x))) assert.equal(after[tb], mid[tb], `${tb} sin duplicados`);
    assert.equal(r2.verification.pos.count, 25);
    assert.deepEqual(r2.verification.issues, []);

    // El servicio público no admite fecha histórica: createForDemo valida el rango.
    await assert.rejects(saleService.createForDemo({ items: [], payments: [] }, auth, {}, { soldAt: new Date(Date.now() + 3600000) }), /futura/);
    await assert.rejects(saleService.createForDemo({ items: [], payments: [] }, auth, {}, { soldAt: new Date(Date.now() - 31 * 86400000) }), /30 días/);
  });

  await scenario('fallo a mitad de la ejecución y reanudación con el mismo RUN_ID', async (tx) => {
    const { user, auth } = await adminSession(tx);
    await catalog(await loginClient(app, user));
    const runId = `qa-demo-${uid().toLowerCase()}`;
    await assert.rejects(demo.execute({ runId, auth, hooks: { failAfterSale: 10 } }), /Falla simulada/);
    assert.equal(await n1(tx, "SELECT COUNT(*) FROM audit_logs WHERE entity_table = 'sales' AND action = 'CREATE' AND request_id LIKE ?", [`${runId}-pos-%`]), 10);
    const open = await q(tx, 'SELECT status FROM cash_sessions WHERE opening_notes = ?', [demo.tagOf(runId)]);
    assert.deepEqual(open.map((s) => s.status), ['OPEN'], 'la sesión demo queda abierta para reanudar');
    // Mismo plan al reanudar (el stock consumido por la propia ejecución se descuenta del cálculo).
    const sim = await demo.dryRun({ runId, executorId: auth.userId });
    assert.deepEqual(sim.preflight.problems, []);
    const r = await demo.execute({ runId, auth });
    assert.equal(r.created.sales, 15);
    assert.equal(r.created.session, false);
    assert.equal(r.verification.pos.count, 25);
    assert.deepEqual(r.verification.issues, []);
    assert.deepEqual((await q(tx, 'SELECT status FROM cash_sessions WHERE opening_notes = ?', [demo.tagOf(runId)])).map((s) => s.status), ['CLOSED']);
  });

  await scenario('precondiciones: sin productos, sin lotes, sin stock, sin clientes y sin motivos', async (tx) => {
    const runId = `qa-demo-${uid().toLowerCase()}`;
    // Sin productos activos ni clientes: otras pruebas de la suite pueden haber confirmado catálogo y clientes en la base
    // temporal; aquí se desactivan dentro de esta transacción (se revierte al terminar).
    await tx.conn.execute("UPDATE products SET status = 'INACTIVE' WHERE status = 'ACTIVE'");
    await tx.conn.execute('UPDATE customers SET is_active = FALSE WHERE is_active = TRUE');
    const empty = await demo.dryRun({ runId });
    assert.ok(empty.preflight.problems.some((p) => /No hay productos activos/.test(p)), empty.text);

    const { user, auth } = await adminSession(tx);
    const admin = await loginClient(app, user);
    // Producto sin lotes vendibles.
    await stockedProduct(admin, { salePrice: '5.00' });
    const noBatches = await demo.dryRun({ runId });
    assert.ok(noBatches.preflight.problems.some((p) => /lotes vendibles/.test(p)), noBatches.text);
    // Stock insuficiente: no se inicia ninguna venta.
    await stockedProduct(admin, { salePrice: '5.00', batches: [{ batchNumber: `LOW-${uid()}`, days: 120, quantity: 6 }] });
    const low = await demo.dryRun({ runId });
    assert.ok(low.preflight.problems.some((p) => /Stock insuficiente/.test(p)), low.text);
    const before = await counts(tx);
    await assert.rejects(demo.execute({ runId, auth }), (err) => err.code === 'DEMO_PRECONDITION' && err.problems.some((p) => /Stock insuficiente/.test(p)));
    const after = await counts(tx);
    for (const tb of ['sales', 'payments', 'cash_registers', 'cash_sessions', 'orders', 'customers', 'inventory_movements']) assert.equal(after[tb], before[tb], `${tb}: sin escrituras`);

    // Con stock suficiente, sin clientes registrados: todas las ventas son rápidas y se planifica el cliente demo.
    await catalog(admin);
    const noCustomers = await demo.dryRun({ runId });
    assert.deepEqual(noCustomers.preflight.problems, []);
    assert.equal(noCustomers.state.customersActive, 0);
    assert.equal(noCustomers.plan.sales.filter((s) => s.customerId).length, 0);
    assert.match(noCustomers.text, /Cliente demo \.+ se creará/);

    // Sin motivos de devolución activos: las devoluciones se omiten (el resto sigue siendo viable).
    await tx.conn.execute('UPDATE return_reasons SET is_active = FALSE');
    const noReasons = await demo.dryRun({ runId });
    assert.match(noReasons.preflight.skip.returns || '', /no hay motivos de devolución activos/);
    assert.deepEqual(noReasons.preflight.problems, []);
  });

  await scenario('precondiciones: usuario sin permisos, caja ajena con el código demo y sesión real abierta', async (tx) => {
    const runId = `qa-demo-${uid().toLowerCase()}`;
    const { user, auth } = await adminSession(tx);
    const admin = await loginClient(app, user);
    await catalog(admin);

    // Trabajador sin rol de administrador ni permisos completos.
    const staff = await adminSession(tx, 'STAFF');
    await assert.rejects(demo.execute({ runId, auth: staff.auth }), (err) => err.problems?.some((p) => /administrador/.test(p)));

    // Sesión de caja REAL abierta por el ejecutor: no se toca y se detiene.
    const [caja01] = await q(tx, "SELECT id FROM cash_registers WHERE code = 'CAJA01'");
    const real = await admin.post('/api/cash/sessions', { cashRegisterId: caja01.id, openingAmount: '20.00' });
    assert.equal(real.status, 201);
    const salesBefore = await n1(tx, 'SELECT COUNT(*) FROM sales');
    await assert.rejects(demo.execute({ runId, auth }), (err) => err.problems?.some((p) => /sesión de caja REAL abierta/.test(p)));
    assert.equal(await n1(tx, 'SELECT COUNT(*) FROM sales'), salesBefore);
    assert.equal((await q(tx, 'SELECT status FROM cash_sessions WHERE id = ?', [real.body.data.id]))[0].status, 'OPEN');
    assert.equal((await admin.post(`/api/cash/sessions/${real.body.data.id}/close`, { countedAmount: '20.00' })).status, 200);

    // Caja con el código PPDEMO que no es la caja de demostración: no se usa.
    const branchId = auth.branches[0].id;
    assert.equal((await admin.post(`/api/branches/${branchId}/registers`, { code: 'PPDEMO', name: 'Caja de mostrador' })).status, 201);
    await assert.rejects(demo.execute({ runId, auth }), (err) => err.problems?.some((p) => /no es la caja de demostración/.test(p)));
    assert.equal(await n1(tx, 'SELECT COUNT(*) FROM sales'), salesBefore);
  });
});
