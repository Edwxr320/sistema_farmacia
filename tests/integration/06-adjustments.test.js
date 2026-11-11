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
const ctx = {};

async function batch(number) {
  const [[b]] = await tx.conn.execute('SELECT id, current_quantity, status FROM product_batches WHERE batch_number = ? AND product_id = ?', [number, ctx.productId]);
  return { id: b.id, qty: Number(b.current_quantity), status: b.status };
}

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  const s = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  ctx.adminId = a.id;
  admin = await loginClient(app, a);
  staff = await loginClient(app, s);
  const p = await stockedProduct(admin, {
    minimumStock: 5,
    batches: [{ batchNumber: 'AJ-A', days: 300, quantity: 20 }, { batchNumber: 'AJ-B', days: 60, quantity: 10 }, { batchNumber: 'AJ-X', days: 3, quantity: 4 }],
  });
  ctx.productId = p.productId;
  ctx.A = (await batch('AJ-A')).id;
  ctx.B = (await batch('AJ-B')).id;
  ctx.X = (await batch('AJ-X')).id;
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});

test('conteo físico: diferencia positiva (IN), negativa (OUT) y lote sin diferencia sin movimiento', async () => {
  const res = await admin.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'PHYSICAL_COUNT', productId: ctx.productId, reason: 'Inventario mensual de anaquel',
    items: [{ batchId: ctx.A, countedQuantity: 23 }, { batchId: ctx.B, countedQuantity: 7 }, { batchId: ctx.X, countedQuantity: 4 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const d = res.body.data;
  assert.match(d.adjustmentNumber, /^AJ-SP01-\d+$/);
  assert.equal(d.movementsCount, 2, 'el lote sin diferencia no genera movimiento');
  assert.equal(d.unitsIn, 3);
  assert.equal(d.unitsOut, 3);
  assert.equal(d.performedBy.id, ctx.adminId);
  assert.equal(d.approvedBy, null);
  assert.deepEqual(d.lines.map((l) => l.difference), [3, -3, 0]);
  const types = Object.fromEntries(d.movements.map((m) => [m.batchNumber, m.movementType]));
  assert.deepEqual(types, { 'AJ-A': 'ADJUSTMENT_IN', 'AJ-B': 'ADJUSTMENT_OUT' });
  assert.equal((await batch('AJ-A')).qty, 23);
  assert.equal((await batch('AJ-B')).qty, 7);
  assert.equal((await batch('AJ-X')).qty, 4);

  const kardex = await admin.get(`/api/inventory/movements?productId=${ctx.productId}&movementType=ADJUSTMENT_IN`);
  assert.equal(kardex.body.data[0].source_document, d.adjustmentNumber, 'kardex enlazado al ajuste');
  assert.equal(Number(kardex.body.data[0].batch_stock_after), 23);
});

test('conteo físico sin diferencias: encabezado registrado, cero movimientos', async () => {
  const res = await admin.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'PHYSICAL_COUNT', productId: ctx.productId, reason: 'Conteo de control',
    items: [{ batchId: ctx.A, countedQuantity: 23 }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.noDifferences, true);
  assert.equal(res.body.data.movementsCount, 0);
});

test('corrección dirigida y pérdida', async () => {
  const corr = await admin.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'CORRECTION', reason: 'Error de digitación en la recepción',
    items: [{ batchId: ctx.A, quantity: 2, direction: 'OUT' }],
  });
  assert.equal(corr.status, 201, JSON.stringify(corr.body));
  assert.equal(corr.body.data.movements[0].movementType, 'ADJUSTMENT_OUT');
  const loss = await admin.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'LOSS', reason: 'Faltante detectado en anaquel', items: [{ batchId: ctx.A, quantity: 1 }],
  });
  assert.equal(loss.body.data.movements[0].movementType, 'ADJUSTMENT_OUT');
  assert.equal(loss.body.data.approvedBy.id, ctx.adminId, 'baja autorizada por quien tiene inventory.write_off');
  assert.equal((await batch('AJ-A')).qty, 20);
});

test('baja por deterioro (DAMAGE_WRITE_OFF)', async () => {
  const res = await admin.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'DAMAGE', reason: 'Blíster dañado por humedad', items: [{ batchId: ctx.B, quantity: 2 }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.movements[0].movementType, 'DAMAGE_WRITE_OFF');
  assert.equal((await batch('AJ-B')).qty, 5);
});

test('baja por vencimiento: solo lotes vencidos', async () => {
  const notExpired = await admin.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'EXPIRED_WRITE_OFF', reason: 'Medicamento vencido', items: [{ batchId: ctx.X, quantity: 4 }],
  });
  assert.equal(notExpired.status, 422);
  assert.equal(notExpired.body.error.code, 'BATCH_NOT_EXPIRED');

  // Se simula la fecha de la sesión de MariaDB 10 días después (el lote AJ-X vence en 3).
  // Las sesiones de prueba (8 h) se extienden para que sigan vigentes en esa fecha simulada.
  await tx.conn.execute('UPDATE user_sessions SET expires_at = NOW() + INTERVAL 30 DAY WHERE revoked_at IS NULL');
  await tx.conn.query('SET TIMESTAMP = UNIX_TIMESTAMP(NOW() + INTERVAL 10 DAY)');
  try {
    const ok = await admin.post('/api/inventory/adjustments', {
      branchId: 1, adjustmentType: 'EXPIRED_WRITE_OFF', reason: 'Medicamento vencido', items: [{ batchId: ctx.X, quantity: 4 }],
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.movements[0].movementType, 'EXPIRED_WRITE_OFF');
    const x = await batch('AJ-X');
    assert.equal(x.qty, 0);
    assert.equal(x.status, 'DEPLETED');
  } finally {
    await tx.conn.query('SET TIMESTAMP = DEFAULT');
  }
});

test('stock insuficiente, datos inválidos y ROLLBACK completo', async () => {
  const insufficient = await admin.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'DAMAGE', reason: 'Prueba de exceso', items: [{ batchId: ctx.B, quantity: 999 }],
  });
  assert.equal(insufficient.status, 422);
  assert.equal(insufficient.body.error.code, 'INSUFFICIENT_STOCK');

  const bad = [
    { adjustmentType: 'PHYSICAL_COUNT', productId: ctx.productId, reason: 'Conteo', items: [{ batchId: ctx.A, countedQuantity: -1 }] },
    { adjustmentType: 'DAMAGE', reason: 'x', items: [{ batchId: ctx.A, quantity: 1 }] },
    { adjustmentType: 'DAMAGE', reason: 'Motivo válido', items: [{ batchId: ctx.A, quantity: 0 }] },
    { adjustmentType: 'INVENTADO', reason: 'Motivo válido', items: [{ batchId: ctx.A, quantity: 1 }] },
    { adjustmentType: 'DAMAGE', reason: 'Motivo válido', items: [{ batchId: ctx.A, quantity: 1 }, { batchId: ctx.A, quantity: 1 }] },
    { adjustmentType: 'PHYSICAL_COUNT', reason: 'Sin producto', items: [{ batchId: ctx.A, countedQuantity: 1 }] },
  ];
  for (const body of bad) assert.equal((await admin.post('/api/inventory/adjustments', { branchId: 1, ...body })).status, 400, JSON.stringify(body));

  // La segunda línea falla tras procesar la primera: no queda ni encabezado ni movimiento.
  const [[before]] = await tx.conn.execute('SELECT (SELECT COUNT(*) FROM inventory_adjustments) a, (SELECT COUNT(*) FROM inventory_movements) m');
  const qtyA = (await batch('AJ-A')).qty;
  const rb = await admin.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'DAMAGE', reason: 'Debe revertirse',
    items: [{ batchId: ctx.A, quantity: 1 }, { batchId: ctx.B, quantity: 500 }],
  });
  assert.equal(rb.status, 422);
  const [[after]] = await tx.conn.execute('SELECT (SELECT COUNT(*) FROM inventory_adjustments) a, (SELECT COUNT(*) FROM inventory_movements) m');
  assert.deepEqual(after, before);
  assert.equal((await batch('AJ-A')).qty, qtyA);

  // Lote de otra sucursal o de otro producto.
  const other = await admin.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'PHYSICAL_COUNT', productId: ctx.productId + 999999, reason: 'Conteo', items: [{ batchId: ctx.A, countedQuantity: 1 }],
  });
  assert.equal(other.status, 400);
});

test('consultas, filtros e historial', async () => {
  const list = await admin.get(`/api/inventory/adjustments?branchId=1&productId=${ctx.productId}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.pagination.total >= 5);
  const damage = await admin.get('/api/inventory/adjustments?adjustmentType=DAMAGE');
  assert.ok(damage.body.data.every((a) => a.adjustmentType === 'DAMAGE'));
  const number = list.body.data[0].adjustmentNumber;
  const byNumber = await admin.get(`/api/inventory/adjustments?q=${number}`);
  assert.equal(byNumber.body.data[0].adjustmentNumber, number);
  const detail = await admin.get(`/api/inventory/adjustments/${list.body.data[0].id}`);
  assert.ok(Array.isArray(detail.body.data.movements));
  const [[audit]] = await tx.conn.execute("SELECT COUNT(*) n FROM audit_logs WHERE entity_table = 'inventory_adjustments'");
  assert.ok(Number(audit.n) >= 5);
});

test('permisos: STAFF sin inventory.adjust ni inventory.write_off', async () => {
  const r1 = await staff.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'PHYSICAL_COUNT', productId: ctx.productId, reason: 'Conteo', items: [{ batchId: ctx.A, countedQuantity: 1 }],
  });
  assert.equal(r1.status, 403);
  const r2 = await staff.post('/api/inventory/adjustments', { branchId: 1, adjustmentType: 'DAMAGE', reason: 'Dañado', items: [{ batchId: ctx.A, quantity: 1 }] });
  assert.equal(r2.status, 403);
  assert.equal((await staff.get('/api/inventory/adjustments')).status, 200, 'consulta con inventory.view');

  // Con inventory.adjust concedido individualmente, puede contar pero no dar de baja.
  const [[perm]] = await tx.conn.execute("SELECT id FROM permissions WHERE code = 'inventory.adjust'");
  const [[staffRow]] = await tx.conn.execute("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'STAFF' ORDER BY u.id DESC LIMIT 1");
  await tx.conn.execute("INSERT INTO user_permissions (user_id, permission_id, effect) VALUES (?, ?, 'GRANT')", [staffRow.id, perm.id]);
  const ok = await staff.post('/api/inventory/adjustments', {
    branchId: 1, adjustmentType: 'PHYSICAL_COUNT', productId: ctx.productId, reason: 'Conteo delegado', items: [{ batchId: ctx.A, countedQuantity: 20 }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await staff.post('/api/inventory/adjustments', { branchId: 1, adjustmentType: 'DAMAGE', reason: 'Dañado', items: [{ batchId: ctx.A, quantity: 1 }] })).status, 403);
  await tx.conn.execute('DELETE FROM user_permissions WHERE user_id = ?', [staffRow.id]);
});
