'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { closePool, withTransaction } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const { loginClient, validRuc, limaDate, uid } = require('../helpers/http');
const { reserveFefoInTransaction } = require('../../src/services/inventory.service');

const PASSWORD = 'Farmacia2026Segura';
let tx;
let app;
let admin;
let staff;
const ctx = {};

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  const s = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  ctx.adminId = a.id;
  admin = await loginClient(app, a);
  staff = await loginClient(app, s);

  const cat = await admin.post('/api/categories', { name: `QA Inv ${uid()}` });
  ctx.categoryId = cat.body.data.id;
  const pa = await admin.post('/api/products', { sku: `QA-A-${uid()}`, name: 'QA Amoxicilina 500', categoryId: ctx.categoryId, salePrice: '1.20', minimumStock: 50 });
  const pb = await admin.post('/api/products', { sku: `QA-B-${uid()}`, name: 'QA Loratadina 10', categoryId: ctx.categoryId, salePrice: '0.90', minimumStock: 20 });
  const pc = await admin.post('/api/products', { sku: `QA-C-${uid()}`, name: 'QA Inactivo', categoryId: ctx.categoryId, salePrice: '1.00' });
  ctx.productA = pa.body.data.id;
  ctx.productB = pb.body.data.id;
  ctx.productInactive = pc.body.data.id;
  await admin.patch(`/api/products/${ctx.productInactive}/status`, { status: 'INACTIVE' });
  const sup = await admin.post('/api/suppliers', { businessName: 'QA Droguería SAC', ruc: validRuc() });
  ctx.supplierId = sup.body.data.id;
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
  fs.rmSync(require('../../src/config/env').config.uploads.dir, { recursive: true, force: true });
});

async function movementsFor(entryId) {
  const [rows] = await tx.conn.execute(
    `SELECT im.* FROM inventory_movements im JOIN stock_entry_items i ON i.id = im.stock_entry_item_id
      WHERE i.stock_entry_id = ? ORDER BY im.id`, [entryId]);
  return rows;
}

async function openAlerts(productId, type) {
  const [rows] = await tx.conn.execute(
    "SELECT * FROM stock_alerts WHERE product_id = ? AND alert_type = ? AND status = 'OPEN'", [productId, type]);
  return rows;
}

test('14-15. entrada DRAFT con varios lotes: lotes vacíos, sin movimientos, total calculado en la base', async () => {
  ctx.doc = `F001-${uid()}`;
  const res = await admin.post('/api/inventory/entries', {
    branchId: 1, supplierId: ctx.supplierId, referenceDocumentType: 'FACTURA', referenceDocumentNumber: ctx.doc,
    items: [
      { productId: ctx.productA, batchNumber: 'QA-L3', expiryDate: limaDate(400), quantity: 10, unitCost: '0.50' },
      { productId: ctx.productA, batchNumber: 'QA-L1', manufacturingDate: limaDate(-30), expiryDate: limaDate(40), quantity: 12, unitCost: '0.45' },
      { productId: ctx.productA, batchNumber: 'QA-L2', expiryDate: limaDate(200), quantity: 8, unitCost: '0.33' },
      { productId: ctx.productB, batchNumber: 'QA-B1', expiryDate: limaDate(300), quantity: 5, unitCost: '1.10' },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const e = res.body.data;
  ctx.entryId = e.id;
  assert.equal(e.status, 'DRAFT');
  assert.match(e.entryNumber, /^E-SP01-\d+$/);
  assert.equal(e.items.length, 4);
  assert.equal(e.unitsCount, 35);
  // 10*0.50 + 12*0.45 + 8*0.33 + 5*1.10 = 5.00 + 5.40 + 2.64 + 5.50 = 18.54 (calculado en DECIMAL por la base)
  assert.equal(e.totalCost, '18.54');
  assert.ok(e.items.every((i) => i.movementId === null));
  assert.equal((await movementsFor(ctx.entryId)).length, 0);
  const [batches] = await tx.conn.execute('SELECT current_quantity, received_quantity FROM product_batches WHERE stock_entry_id = ?', [ctx.entryId]);
  assert.equal(batches.length, 4);
  assert.ok(batches.every((b) => Number(b.current_quantity) === 0 && Number(b.received_quantity) === 0), 'lotes creados con existencia 0');

  const review = await admin.get(`/api/inventory/entries/${ctx.entryId}`);
  assert.equal(review.body.data.totalCost, '18.54', 'revisión previa a confirmar');
});

test('editar el borrador reemplaza líneas y limpia lotes vacíos', async () => {
  const draft = await admin.post('/api/inventory/entries', {
    branchId: 1, supplierId: ctx.supplierId,
    items: [{ productId: ctx.productB, batchNumber: 'QA-TMP', expiryDate: limaDate(100), quantity: 1, unitCost: '1' }],
  });
  const id = draft.body.data.id;
  const upd = await admin.put(`/api/inventory/entries/${id}`, {
    notes: 'corregido',
    items: [{ productId: ctx.productB, batchNumber: 'QA-TMP2', expiryDate: limaDate(120), quantity: 2, unitCost: '1.5' }],
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.data.items[0].batchNumber, 'QA-TMP2');
  const [[gone]] = await tx.conn.execute("SELECT COUNT(*) n FROM product_batches WHERE batch_number = 'QA-TMP'");
  assert.equal(Number(gone.n), 0, 'el lote vacío reemplazado se elimina');
  const cancel = await admin.post(`/api/inventory/entries/${id}/cancel`, { reason: 'Prueba de anulación' });
  assert.equal(cancel.body.data.status, 'CANCELLED');
  assert.equal((await admin.post(`/api/inventory/entries/${id}/post`)).status, 409, 'una entrada anulada no se contabiliza');
});

test('16-18. contabilizar: POSTED, stock real por movimientos PURCHASE_ENTRY', async () => {
  const requestId = `qa-post-${uid()}`;
  const res = await admin.agent.post(`/api/inventory/entries/${ctx.entryId}/post`).set('X-CSRF-Token', admin.csrf).set('X-Request-Id', requestId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'POSTED');
  assert.equal(res.body.data.alreadyPosted, false);
  assert.equal(res.body.data.totalCost, '18.54');
  assert.ok(res.body.data.postedAt);

  const moves = await movementsFor(ctx.entryId);
  assert.equal(moves.length, 4);
  for (const m of moves) {
    assert.equal(m.movement_type, 'PURCHASE_ENTRY');
    assert.equal(m.direction, 'IN');
    assert.equal(Number(m.performed_by), ctx.adminId);
    assert.equal(m.request_id, requestId, 'contexto de la petición en la misma conexión');
    assert.equal(Number(m.batch_stock_after), Number(m.batch_stock_before) + Number(m.quantity));
    assert.equal(Number(m.stock_after), Number(m.stock_before) + Number(m.quantity));
  }
  const [batches] = await tx.conn.execute(
    'SELECT batch_number, current_quantity, received_quantity FROM product_batches WHERE stock_entry_id = ? ORDER BY batch_number', [ctx.entryId]);
  assert.deepEqual(batches.map((b) => [b.batch_number, Number(b.current_quantity), Number(b.received_quantity)]),
    [['QA-B1', 5, 5], ['QA-L1', 12, 12], ['QA-L2', 8, 8], ['QA-L3', 10, 10]]);

  const stock = await admin.get(`/api/inventory?branchId=1&productId=${ctx.productA}`);
  assert.equal(stock.status, 200);
  const row = stock.body.data[0];
  assert.equal(row.physicalStock, 30);
  assert.equal(row.availableStock, 30);
  assert.equal(row.expiredStock, 0);
  assert.equal(row.minimumStock, 50);
  assert.equal(row.stockStatus, 'LOW_STOCK');

  const kardex = await admin.get(`/api/inventory/movements?productId=${ctx.productA}&movementType=PURCHASE_ENTRY`);
  assert.equal(kardex.body.pagination.total, 3);
  assert.ok(kardex.body.data.every((k) => k.source_document === res.body.data.entryNumber));

  const [[audit]] = await tx.conn.execute(
    "SELECT COUNT(*) n FROM audit_logs WHERE entity_table = 'stock_entries' AND entity_id = ? AND action = 'POST'", [String(ctx.entryId)]);
  assert.equal(Number(audit.n), 1);
});

test('23. repetir la contabilización no duplica movimientos ni entradas', async () => {
  const again = await admin.post(`/api/inventory/entries/${ctx.entryId}/post`);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.alreadyPosted, true);
  assert.equal((await movementsFor(ctx.entryId)).length, 4);

  const dup = await admin.post('/api/inventory/entries', {
    branchId: 1, supplierId: ctx.supplierId, referenceDocumentType: 'FACTURA', referenceDocumentNumber: ctx.doc,
    items: [{ productId: ctx.productB, batchNumber: 'QA-X', expiryDate: limaDate(100), quantity: 1, unitCost: '1' }],
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_DOCUMENT');
  assert.equal(dup.body.error.details.entryId, ctx.entryId);

  // A nivel de base: un segundo PURCHASE_ENTRY para la misma línea es imposible.
  const [[item]] = await tx.conn.execute('SELECT id, batch_id, quantity FROM stock_entry_items WHERE stock_entry_id = ? LIMIT 1', [ctx.entryId]);
  await assert.rejects(tx.conn.execute(
    "INSERT INTO inventory_movements (batch_id, movement_type, quantity, stock_entry_item_id, performed_by) VALUES (?, 'PURCHASE_ENTRY', ?, ?, ?)",
    [item.batch_id, item.quantity, item.id, ctx.adminId]));
  assert.equal((await movementsFor(ctx.entryId)).length, 4);
});

test('19. FEFO: orden por vencimiento, reparto y bloqueo FOR UPDATE', async () => {
  const res = await admin.get(`/api/inventory/fefo?branchId=1&productId=${ctx.productA}&quantity=15`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.deepEqual(d.batches.map((b) => b.batchNumber), ['QA-L1', 'QA-L2', 'QA-L3'], 'vencimiento más próximo primero');
  assert.equal(d.availableStock, 30);
  assert.deepEqual(d.allocation.lines.map((l) => [l.batchNumber, l.quantity]), [['QA-L1', 12], ['QA-L2', 3]]);
  assert.equal(d.allocation.fulfilled, true);

  // Servicio para el POS: bloquea lotes dentro de la transacción y reparte por FEFO.
  const plan = await withTransaction({ requestId: 'qa-fefo' }, (conn) => reserveFefoInTransaction(conn, 1, ctx.productA, 25));
  assert.deepEqual(plan.map((p) => p.quantity), [12, 8, 5]);
  await assert.rejects(
    withTransaction({ requestId: 'qa-fefo2' }, (conn) => reserveFefoInTransaction(conn, 1, ctx.productA, 31)),
    (e) => e.code === 'INSUFFICIENT_STOCK',
  );

  // Un lote en cuarentena deja de ser vendible.
  await tx.conn.execute("UPDATE product_batches SET status = 'QUARANTINE' WHERE batch_number = 'QA-L1' AND product_id = ?", [ctx.productA]);
  const after = await admin.get(`/api/inventory/fefo?branchId=1&productId=${ctx.productA}`);
  assert.deepEqual(after.body.data.batches.map((b) => b.batchNumber), ['QA-L2', 'QA-L3']);
  const blocked = await admin.get(`/api/inventory?branchId=1&productId=${ctx.productA}`);
  assert.equal(blocked.body.data[0].blockedStock, 12);
  assert.equal(blocked.body.data[0].availableStock, 18);
  await tx.conn.execute("UPDATE product_batches SET status = 'ACTIVE' WHERE batch_number = 'QA-L1' AND product_id = ?", [ctx.productA]);
});

test('20. lotes vencidos: se rechazan en la API y en la base', async () => {
  const past = await admin.post('/api/inventory/entries', {
    branchId: 1, supplierId: ctx.supplierId,
    items: [{ productId: ctx.productB, batchNumber: 'QA-OLD', expiryDate: limaDate(-1), quantity: 1, unitCost: '1' }],
  });
  assert.equal(past.status, 400);
  const today = await admin.post('/api/inventory/entries', {
    branchId: 1, supplierId: ctx.supplierId,
    items: [{ productId: ctx.productB, batchNumber: 'QA-HOY', expiryDate: limaDate(0), quantity: 1, unitCost: '1' }],
  });
  assert.equal(today.status, 400, 'vence hoy = vencido');

  // Borrador cuyo lote se vence antes de contabilizar: el POST se rechaza sin mover stock.
  const draft = await admin.post('/api/inventory/entries', {
    branchId: 1, supplierId: ctx.supplierId,
    items: [{ productId: ctx.productB, batchNumber: 'QA-EXP', expiryDate: limaDate(10), quantity: 3, unitCost: '1' }],
  });
  await tx.conn.execute("UPDATE product_batches SET expiry_date = CURDATE() - INTERVAL 1 DAY WHERE batch_number = 'QA-EXP'");
  const post = await admin.post(`/api/inventory/entries/${draft.body.data.id}/post`);
  assert.equal(post.status, 422);
  assert.equal(post.body.error.code, 'BATCH_EXPIRED');
  // El trigger de la base también lo impide si se intenta directamente.
  const [[item]] = await tx.conn.execute('SELECT id, batch_id, quantity FROM stock_entry_items WHERE stock_entry_id = ?', [draft.body.data.id]);
  await assert.rejects(
    tx.conn.execute("INSERT INTO inventory_movements (batch_id, movement_type, quantity, stock_entry_item_id, performed_by) VALUES (?, 'PURCHASE_ENTRY', ?, ?, ?)",
      [item.batch_id, item.quantity, item.id, ctx.adminId]),
    (e) => e.errno === 1644 && /vencido/.test(e.sqlMessage),
  );
  assert.equal((await movementsFor(draft.body.data.id)).length, 0);
});

test('24. ROLLBACK completo si una entrada falla a mitad de la transacción', async () => {
  const doc = `F009-${uid()}`;
  const [[before]] = await tx.conn.execute('SELECT (SELECT COUNT(*) FROM stock_entries) e, (SELECT COUNT(*) FROM product_batches) b, (SELECT COUNT(*) FROM inventory_movements) m');
  const res = await admin.post('/api/inventory/entries', {
    branchId: 1, supplierId: ctx.supplierId, referenceDocumentType: 'FACTURA', referenceDocumentNumber: doc, confirm: true,
    items: [
      { productId: ctx.productB, batchNumber: 'QA-RB1', expiryDate: limaDate(200), quantity: 4, unitCost: '1' },
      { productId: ctx.productInactive, batchNumber: 'QA-RB2', expiryDate: limaDate(200), quantity: 4, unitCost: '1' },
    ],
  });
  assert.equal(res.status, 400, 'la segunda línea falla');
  const [[after]] = await tx.conn.execute('SELECT (SELECT COUNT(*) FROM stock_entries) e, (SELECT COUNT(*) FROM product_batches) b, (SELECT COUNT(*) FROM inventory_movements) m');
  assert.deepEqual(after, before, 'ni cabecera, ni lotes, ni movimientos');
  const [[byDoc]] = await tx.conn.execute('SELECT COUNT(*) n FROM stock_entries WHERE reference_document_number = ?', [doc]);
  assert.equal(Number(byDoc.n), 0);
});

test('registrar y contabilizar en una sola transacción (confirm=true)', async () => {
  const res = await admin.post('/api/inventory/entries', {
    branchId: 1, supplierId: ctx.supplierId, confirm: true,
    items: [{ productId: ctx.productA, batchNumber: 'QA-L4', expiryDate: limaDate(500), quantity: 40, unitCost: '0.50' }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'POSTED');
  assert.equal((await movementsFor(res.body.data.id)).length, 1);
});

test('21-22. alertas: stock bajo automático, resolución por reposición y vencimientos', async () => {
  // Producto B: 5 unidades con mínimo 20 → LOW_STOCK abierta (trigger de la base).
  const low = await openAlerts(ctx.productB, 'LOW_STOCK');
  assert.equal(low.length, 1, 'sin duplicados');
  assert.equal(Number(low[0].stock_at_alert), 5);
  // Producto A pasó de 30 a 70 (> 50): su LOW_STOCK quedó resuelta automáticamente.
  assert.equal((await openAlerts(ctx.productA, 'LOW_STOCK')).length, 0);
  const [[resolved]] = await tx.conn.execute(
    "SELECT COUNT(*) n FROM stock_alerts WHERE product_id = ? AND alert_type = 'LOW_STOCK' AND status = 'RESOLVED'", [ctx.productA]);
  assert.equal(Number(resolved.n), 1);

  // QA-L1 vence en 40 días (< 90): al contabilizar se ejecutó sp_refresh_expiry_alerts.
  const expiring = await openAlerts(ctx.productA, 'EXPIRING_SOON');
  assert.equal(expiring.length, 1);
  const refresh = await admin.post('/api/inventory/alerts/refresh-expiry');
  assert.equal(refresh.status, 200);
  assert.equal(refresh.body.data.executed, true);
  assert.equal((await openAlerts(ctx.productA, 'EXPIRING_SOON')).length, 1, 'repetir no duplica alertas');

  const list = await admin.get(`/api/inventory/alerts?branchId=1&productId=${ctx.productB}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data[0].alertType, 'LOW_STOCK');
  assert.ok(list.body.openSummary.LOW_STOCK >= 1);

  const id = low[0].id;
  assert.equal((await staff.post(`/api/inventory/alerts/${id}/close`, { note: 'Pedido realizado' })).status, 403);
  const closed = await admin.post(`/api/inventory/alerts/${id}/close`, { status: 'DISMISSED', note: 'Producto de baja rotación' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.data.status, 'DISMISSED');
  assert.equal(closed.body.data.resolvedBy.id, ctx.adminId);
  assert.equal((await admin.post(`/api/inventory/alerts/${id}/close`, { note: 'otra vez' })).status, 409);

  const lowView = await admin.get('/api/inventory/low-stock?branchId=1&pageSize=100');
  assert.ok(lowView.body.data.some((r) => r.productId === ctx.productB && r.stockStatus === 'LOW_STOCK'));
});

test('consultas de lotes y detalle de producto con inventario', async () => {
  const batches = await admin.get(`/api/inventory/batches?productId=${ctx.productA}&withStock=true`);
  assert.equal(batches.status, 200);
  assert.deepEqual(batches.body.data.map((b) => b.batch_number), ['QA-L1', 'QA-L2', 'QA-L3', 'QA-L4']);
  assert.equal(batches.body.data[0].expiry_status, 'WARNING');
  assert.equal(batches.body.data[0].is_sellable, true);
  const expiring = await admin.get(`/api/inventory/batches?productId=${ctx.productA}&expiringWithinDays=90`);
  assert.deepEqual(expiring.body.data.map((b) => b.batch_number), ['QA-L1']);

  const detail = await admin.get(`/api/products/${ctx.productA}`);
  const inv = detail.body.data.inventory.find((i) => i.branchId === 1);
  assert.equal(inv.availableStock, 70);
  assert.equal(detail.body.data.batches.length, 4);

  const history = await admin.get(`/api/suppliers/${ctx.supplierId}/entries?status=POSTED`);
  assert.ok(history.body.pagination.total >= 2);
});

test('25. permisos y sucursal asignada en inventario', async () => {
  // Segunda sucursal temporal (se revierte al final): el STAFF no está asignado a ella.
  await tx.conn.execute("INSERT INTO branches (code, name, status) VALUES ('QA02', 'QA Sucursal Temporal', 'ACTIVE')");
  const [[b2]] = await tx.conn.execute("SELECT id FROM branches WHERE code = 'QA02'");

  assert.equal((await staff.get('/api/inventory?branchId=1')).status, 200);
  const other = await staff.get(`/api/inventory?branchId=${b2.id}`);
  assert.equal(other.status, 403);
  assert.equal(other.body.error.code, 'BRANCH_FORBIDDEN');

  const item = { productId: ctx.productB, batchNumber: `QA-S${uid()}`, expiryDate: limaDate(200), quantity: 2, unitCost: '1' };
  const own = await staff.post('/api/inventory/entries', { branchId: 1, supplierId: ctx.supplierId, items: [item] });
  assert.equal(own.status, 201, 'STAFF registra entradas en su sucursal (inventory.entries)');
  const foreign = await staff.post('/api/inventory/entries', { branchId: b2.id, supplierId: ctx.supplierId, items: [item] });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error.code, 'BRANCH_FORBIDDEN');

  const adminOther = await admin.post('/api/inventory/entries', { branchId: b2.id, supplierId: ctx.supplierId, items: [item] });
  assert.equal(adminOther.status, 201, 'ADMIN (branches.manage) opera en cualquier sucursal');
  assert.equal((await staff.get(`/api/inventory/entries/${adminOther.body.data.id}`)).status, 403);
  assert.equal((await staff.post(`/api/inventory/entries/${adminOther.body.data.id}/post`)).status, 403);

  assert.equal((await staff.post('/api/inventory/alerts/refresh-expiry')).status, 403);
  assert.equal((await staff.get('/api/inventory/alerts')).status, 200, 'STAFF ve alertas (alerts.view)');
  assert.equal((await require('supertest')(app).get('/api/inventory')).status, 401);
});

test('regla absoluta: el código nunca actualiza directamente el stock de los lotes', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (p.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        if (/UPDATE\s+product_batches[^;`]*SET[^;`]*(current_quantity|received_quantity)\s*=/i.test(src)) offenders.push(p);
      }
    }
  };
  walk(path.join(__dirname, '..', '..', 'src'));
  assert.deepEqual(offenders, []);
});
