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
let originStaff;
let destStaff;
let thirdStaff;
const ctx = {};
const n = Number;

async function qty(branchId, number) {
  const [[r]] = await tx.conn.execute(
    'SELECT COALESCE(SUM(current_quantity), 0) q FROM product_batches WHERE branch_id = ? AND product_id = ? AND batch_number = ?',
    [branchId, ctx.product, number]);
  return n(r.q);
}

async function batchId(number) {
  const [[r]] = await tx.conn.execute('SELECT id FROM product_batches WHERE branch_id = 1 AND product_id = ? AND batch_number = ?', [ctx.product, number]);
  return r.id;
}

async function newBranch(code) {
  await tx.conn.execute("INSERT INTO branches (code, name, status) VALUES (?, ?, 'ACTIVE')", [code, `QA ${code}`]);
  const [[b]] = await tx.conn.execute('SELECT id FROM branches WHERE code = ?', [code]);
  return b.id;
}

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  ctx.dest = await newBranch('QT02');
  ctx.third = await newBranch('QT03');
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  const so = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD }); // sucursal 1
  const sd = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD, withBranch: false });
  const st = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD, withBranch: false });
  await tx.conn.execute('INSERT INTO user_branches (user_id, branch_id, is_default) VALUES (?, ?, TRUE)', [sd.id, ctx.dest]);
  await tx.conn.execute('INSERT INTO user_branches (user_id, branch_id, is_default) VALUES (?, ?, TRUE)', [st.id, ctx.third]);
  ctx.adminId = a.id;
  ctx.destStaffId = sd.id;
  admin = await loginClient(app, a);
  originStaff = await loginClient(app, so);
  destStaff = await loginClient(app, sd);
  thirdStaff = await loginClient(app, st);
  const p = await stockedProduct(admin, { salePrice: '3.00', batches: [{ batchNumber: 'TR-1', days: 200, quantity: 20 }, { batchNumber: 'TR-2', days: 300, quantity: 10 }] });
  ctx.product = p.productId;
  ctx.b1 = await batchId('TR-1');
  ctx.b2 = await batchId('TR-2');
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});

test('solicitud: validación de sucursales, lotes y stock', async () => {
  const base = { originBranchId: 1, destinationBranchId: ctx.dest };
  assert.equal((await admin.post('/api/inventory/transfers', { ...base, destinationBranchId: 1, items: [{ batchId: ctx.b1, quantity: 1 }] })).status, 400, 'mismo origen y destino');
  const insufficient = await admin.post('/api/inventory/transfers', { ...base, items: [{ batchId: ctx.b1, quantity: 999 }] });
  assert.equal(insufficient.status, 422);
  assert.equal(insufficient.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal((await admin.post('/api/inventory/transfers', { originBranchId: ctx.dest, destinationBranchId: 1, items: [{ batchId: ctx.b1, quantity: 1 }] })).status, 400, 'lote de otra sucursal');
  assert.equal((await admin.post('/api/inventory/transfers', { ...base, destinationBranchId: 999999, items: [{ batchId: ctx.b1, quantity: 1 }] })).status, 400);
  assert.equal((await originStaff.post('/api/inventory/transfers', { ...base, items: [{ batchId: ctx.b1, quantity: 1 }] })).status, 403, 'STAFF sin inventory.transfers');

  const res = await admin.post('/api/inventory/transfers', { ...base, notes: 'Reposición semanal', items: [{ batchId: ctx.b1, quantity: 8 }, { batchId: ctx.b2, quantity: 5 }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  ctx.t1 = res.body.data;
  assert.match(ctx.t1.transferNumber, /^TR-SP01-\d+$/);
  assert.equal(ctx.t1.status, 'DRAFT');
  assert.equal(ctx.t1.stage, 'REQUESTED');
  assert.equal(await qty(1, 'TR-1'), 20, 'solicitar no mueve stock');
});

test('aprobación con cantidades aprobadas menores a las solicitadas', async () => {
  const dispatchFirst = await admin.post(`/api/inventory/transfers/${ctx.t1.id}/dispatch`, {});
  assert.equal(dispatchFirst.status, 409);
  assert.equal(dispatchFirst.body.error.code, 'TRANSFER_NOT_APPROVED');
  const i1 = ctx.t1.items.find((i) => i.originBatchId === ctx.b1);
  assert.equal((await admin.post(`/api/inventory/transfers/${ctx.t1.id}/approve`, { items: [{ itemId: i1.id, approvedQuantity: 9 }] })).status, 400, 'no se aprueba más de lo solicitado');
  const ok = await admin.post(`/api/inventory/transfers/${ctx.t1.id}/approve`, { items: [{ itemId: i1.id, approvedQuantity: 6 }], notes: 'Stock reservado para la principal' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.stage, 'APPROVED');
  assert.equal(ok.body.data.items.find((i) => i.id === i1.id).quantity, 6);
  const [[audit]] = await tx.conn.execute("SELECT new_values FROM audit_logs WHERE entity_table = 'branch_transfers' AND entity_id = ? AND action = 'APPROVE'", [String(ctx.t1.id)]);
  const detail = (typeof audit.new_values === 'string' ? JSON.parse(audit.new_values) : audit.new_values).items;
  assert.deepEqual(detail.find((d) => d.item_id === i1.id), { item_id: i1.id, batch_id: ctx.b1, requested: 8, approved: 6 }, 'se conserva lo solicitado');
  assert.equal((await admin.put(`/api/inventory/transfers/${ctx.t1.id}`, { notes: 'cambio' })).status, 409, 'aprobada no se modifica');
  assert.equal((await admin.post(`/api/inventory/transfers/${ctx.t1.id}/approve`, {})).status, 409, 'no se aprueba dos veces');
});

test('despacho: TRANSFER_OUT por lote, sin doble despacho', async () => {
  assert.equal((await destStaff.post(`/api/inventory/transfers/${ctx.t1.id}/dispatch`, {})).status, 403);
  const res = await admin.post(`/api/inventory/transfers/${ctx.t1.id}/dispatch`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'IN_TRANSIT');
  assert.equal(res.body.data.dispatchedBy.id, ctx.adminId);
  assert.ok(res.body.data.items.every((i) => i.transferOutMovementId));
  assert.equal(await qty(1, 'TR-1'), 14);
  assert.equal(await qty(1, 'TR-2'), 5);
  const again = await admin.post(`/api/inventory/transfers/${ctx.t1.id}/dispatch`, {});
  assert.equal(again.status, 409);
  const [[outs]] = await tx.conn.execute(
    "SELECT COUNT(*) c FROM inventory_movements im JOIN branch_transfer_items i ON i.id = im.transfer_item_id WHERE i.transfer_id = ? AND im.movement_type = 'TRANSFER_OUT'", [ctx.t1.id]);
  assert.equal(n(outs.c), 2);
  assert.equal((await admin.post(`/api/inventory/transfers/${ctx.t1.id}/cancel`, { reason: 'Ya salió del almacén' })).status, 409, 'despachada no se cancela');
});

test('recepción parcial: un lote ahora, mismo lote creado en destino, sin doble recepción', async () => {
  const i1 = ctx.t1.items.find((i) => i.originBatchId === ctx.b1);
  assert.equal((await originStaff.post(`/api/inventory/transfers/${ctx.t1.id}/receive`, { items: [{ itemId: i1.id, receivedQuantity: 6 }] })).status, 403, 'la sucursal de origen no recibe');
  assert.equal((await thirdStaff.post(`/api/inventory/transfers/${ctx.t1.id}/receive`, { items: [{ itemId: i1.id, receivedQuantity: 6 }] })).status, 403, 'sucursal no autorizada');
  const res = await destStaff.post(`/api/inventory/transfers/${ctx.t1.id}/receive`, { items: [{ itemId: i1.id, receivedQuantity: 6 }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'IN_TRANSIT');
  assert.equal(res.body.data.stage, 'PARTIALLY_RECEIVED');
  const item = res.body.data.items.find((i) => i.id === i1.id);
  assert.equal(item.receivedQuantity, 6);
  assert.ok(item.transferInMovementId);
  assert.equal(await qty(ctx.dest, 'TR-1'), 6);
  const [[db]] = await tx.conn.execute('SELECT expiry_date, stock_entry_id FROM product_batches WHERE id = ?', [item.destinationBatchId]);
  const [[ob]] = await tx.conn.execute('SELECT expiry_date FROM product_batches WHERE id = ?', [ctx.b1]);
  assert.equal(db.expiry_date, ob.expiry_date, 'mismo vencimiento');
  const twice = await destStaff.post(`/api/inventory/transfers/${ctx.t1.id}/receive`, { items: [{ itemId: i1.id, receivedQuantity: 6 }] });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error.code, 'ITEM_ALREADY_RECEIVED');
  assert.equal(await qty(ctx.dest, 'TR-1'), 6, 'no se recibe dos veces');
});

test('rollback: si un ítem de la recepción es inválido, no se registra ninguno', async () => {
  const t = await admin.post('/api/inventory/transfers', { originBranchId: 1, destinationBranchId: ctx.dest, items: [{ batchId: ctx.b1, quantity: 2 }, { batchId: ctx.b2, quantity: 1 }] });
  await admin.post(`/api/inventory/transfers/${t.body.data.id}/approve`, {});
  await admin.post(`/api/inventory/transfers/${t.body.data.id}/dispatch`, {});
  const [a, b] = t.body.data.items;
  const destBefore = await qty(ctx.dest, 'TR-1');
  const bad = await destStaff.post(`/api/inventory/transfers/${t.body.data.id}/receive`, { items: [{ itemId: a.id, receivedQuantity: 2 }, { itemId: b.id, receivedQuantity: 5 }] });
  assert.equal(bad.status, 400);
  assert.equal(await qty(ctx.dest, 'TR-1'), destBefore, 'el primer ítem se revirtió');
  const after = await admin.get(`/api/inventory/transfers/${t.body.data.id}`);
  assert.ok(after.body.data.items.every((i) => i.receivedQuantity === null && i.transferInMovementId === null));
  ctx.t2 = t.body.data;
});

test('faltantes, daños y sobrantes documentados; recepción completa', async () => {
  const i2 = ctx.t1.items.find((i) => i.originBatchId === ctx.b2); // despachadas: 5
  const noNote = await destStaff.post(`/api/inventory/transfers/${ctx.t1.id}/receive`, { items: [{ itemId: i2.id, receivedQuantity: 4 }] });
  assert.equal(noNote.status, 400, 'la diferencia exige una nota');
  const res = await destStaff.post(`/api/inventory/transfers/${ctx.t1.id}/receive`, {
    items: [{ itemId: i2.id, receivedQuantity: 4, damagedQuantity: 1, note: 'Caja golpeada; falta una unidad' }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const t = res.body.data;
  assert.equal(t.status, 'RECEIVED');
  assert.equal(t.stage, 'RECEIVED_WITH_DISCREPANCIES');
  assert.equal(t.receivedBy.id, ctx.destStaffId);
  const item = t.items.find((i) => i.id === i2.id);
  assert.equal(item.receivedQuantity, 4);
  assert.equal(item.shortage, 1);
  assert.match(item.discrepancyNote, /Faltante: 1.*Dañado: 1/);
  assert.equal(await qty(ctx.dest, 'TR-2'), 3, '4 recibidas − 1 dada de baja por daño');
  const [[dmg]] = await tx.conn.execute(
    "SELECT ia.adjustment_type, im.movement_type, im.quantity FROM inventory_adjustments ia JOIN inventory_movements im ON im.adjustment_id = ia.id WHERE ia.branch_id = ? ORDER BY ia.id DESC LIMIT 1", [ctx.dest]);
  assert.deepEqual([dmg.adjustment_type, dmg.movement_type, n(dmg.quantity)], ['DAMAGE', 'DAMAGE_WRITE_OFF', 1]);
  assert.equal((await destStaff.post(`/api/inventory/transfers/${ctx.t1.id}/receive`, { items: [{ itemId: i2.id, receivedQuantity: 4, note: 'x' }] })).status, 409, 'recibida es final');

  // Sobrante: llegó más de lo despachado → se documenta, no ingresa.
  const [a, b] = ctx.t2.items;
  const s = await destStaff.post(`/api/inventory/transfers/${ctx.t2.id}/receive`, {
    items: [{ itemId: a.id, receivedQuantity: 2, surplusQuantity: 1, note: 'Llegó una unidad extra' }, { itemId: b.id, receivedQuantity: 1 }],
  });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.match(s.body.data.items.find((i) => i.id === a.id).discrepancyNote, /Sobrante: 1/);
  assert.equal(s.body.data.status, 'RECEIVED');
});

test('cancelación de una solicitud y permisos de consulta', async () => {
  const t = await admin.post('/api/inventory/transfers', { originBranchId: 1, destinationBranchId: ctx.dest, items: [{ batchId: ctx.b1, quantity: 1 }] });
  const c = await admin.post(`/api/inventory/transfers/${t.body.data.id}/cancel`, { reason: 'Pedido duplicado' });
  assert.equal(c.body.data.status, 'CANCELLED');
  assert.ok(c.body.data.cancelledBy);
  assert.equal((await admin.post(`/api/inventory/transfers/${t.body.data.id}/dispatch`, {})).status, 409);

  assert.equal((await destStaff.get(`/api/inventory/transfers/${ctx.t1.id}`)).status, 200, 'destino ve la transferencia');
  assert.equal((await thirdStaff.get(`/api/inventory/transfers/${ctx.t1.id}`)).status, 403, 'sucursal ajena no la ve');
  assert.equal((await thirdStaff.get('/api/inventory/transfers')).body.pagination.total, 0);
  const incoming = await destStaff.get(`/api/inventory/transfers?branchId=${ctx.dest}&direction=INCOMING`);
  assert.ok(incoming.body.data.length >= 2);
});

test('integridad del kardex: lo que sale del origen = recibido + faltantes', async () => {
  const [[k]] = await tx.conn.execute(
    `SELECT
       (SELECT COALESCE(SUM(im.quantity),0) FROM inventory_movements im JOIN branch_transfer_items i ON i.id = im.transfer_item_id
         JOIN branch_transfers t ON t.id = i.transfer_id WHERE t.destination_branch_id = ? AND im.movement_type = 'TRANSFER_OUT') AS out_units,
       (SELECT COALESCE(SUM(im.quantity),0) FROM inventory_movements im JOIN branch_transfer_items i ON i.id = im.transfer_item_id
         JOIN branch_transfers t ON t.id = i.transfer_id WHERE t.destination_branch_id = ? AND im.movement_type = 'TRANSFER_IN') AS in_units,
       (SELECT COALESCE(SUM(i.quantity - i.received_quantity),0) FROM branch_transfer_items i JOIN branch_transfers t ON t.id = i.transfer_id
         WHERE t.destination_branch_id = ? AND t.status = 'RECEIVED') AS shortage`, [ctx.dest, ctx.dest, ctx.dest]);
  assert.equal(n(k.out_units), n(k.in_units) + n(k.shortage));
  const kardex = await admin.get(`/api/inventory/movements?productId=${ctx.product}&movementType=TRANSFER_OUT`);
  assert.ok(kardex.body.data.every((m) => m.source_document && m.source_document.startsWith('TR-SP01-')));
  const [issues] = await tx.conn.execute('SELECT * FROM vw_integrity_issues');
  assert.deepEqual(issues, [], 'kardex y lotes cuadran');
});
