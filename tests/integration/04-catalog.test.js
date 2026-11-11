'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { closePool } = require('../../src/config/database');
const { config } = require('../../src/config/env');
const { createApp } = require('../../src/app');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const { loginClient, validRuc, uid } = require('../helpers/http');

const PASSWORD = 'Farmacia2026Segura';
let tx;
let app;
let admin;
let staff;
const ctx = {};

// PNG 1x1 real.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  const s = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  admin = await loginClient(app, a);
  staff = await loginClient(app, s);
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});

async function auditCount(table, entityId, action) {
  const [[r]] = await tx.conn.execute(
    'SELECT COUNT(*) n FROM audit_logs WHERE entity_table = ? AND entity_id = ? AND action = ?', [table, String(entityId), action]);
  return Number(r.n);
}

test('1-3. categorías: crear, editar, buscar, desactivar y no eliminar si tiene productos', async () => {
  const name = `QA Categoría ${uid()}`;
  const created = await admin.post('/api/categories', { name, description: 'Prueba' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.categoryId = created.body.data.id;
  assert.equal(created.body.data.isActive, true);
  assert.equal(created.body.data.productsCount, 0);
  assert.equal(await auditCount('categories', ctx.categoryId, 'CREATE'), 1);

  assert.equal((await admin.post('/api/categories', { name })).status, 409, 'nombre duplicado');
  assert.equal((await admin.post('/api/categories', { name: '' })).status, 400);

  const edited = await admin.put(`/api/categories/${ctx.categoryId}`, { name: `${name} Editada`, description: null });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.name, `${name} Editada`);
  assert.equal(edited.body.data.description, null);

  const found = await admin.get(`/api/categories?q=${encodeURIComponent('Editada')}&pageSize=50`);
  assert.ok(found.body.data.some((c) => c.id === ctx.categoryId));
  assert.ok(found.body.pagination.total >= 1);

  const off = await admin.patch(`/api/categories/${ctx.categoryId}/status`, { isActive: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.isActive, false);
  assert.equal(await auditCount('categories', ctx.categoryId, 'DEACTIVATE'), 1);
  const inactiveList = await admin.get('/api/categories?isActive=false&pageSize=100');
  assert.ok(inactiveList.body.data.some((c) => c.id === ctx.categoryId));
  assert.equal((await admin.patch(`/api/categories/${ctx.categoryId}/status`, { isActive: true })).status, 200);

  const temp = await admin.post('/api/categories', { name: `QA Borrable ${uid()}` });
  assert.equal((await admin.del(`/api/categories/${temp.body.data.id}`)).status, 204, 'sin productos: se elimina');
});

test('9. laboratorios: crear, editar, buscar y desactivar', async () => {
  const created = await admin.post('/api/laboratories', { name: `QA Lab ${uid()}`, country: 'Perú' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.labId = created.body.data.id;
  assert.equal(created.body.data.country, 'Perú');
  const edited = await admin.put(`/api/laboratories/${ctx.labId}`, { country: 'Chile' });
  assert.equal(edited.body.data.country, 'Chile');
  const search = await admin.get('/api/laboratories?q=QA%20Lab&pageSize=100');
  assert.ok(search.body.data.some((l) => l.id === ctx.labId));
  const lab2 = await admin.post('/api/laboratories', { name: `QA Lab2 ${uid()}` });
  ctx.lab2Id = lab2.body.data.id;
});

test('4. crear producto: se configura en todas las sucursales activas y se audita', async () => {
  ctx.sku = `QA-${uid()}`;
  ctx.barcode = `775${Date.now().toString().slice(-10)}`;
  const res = await admin.post('/api/products', {
    sku: ctx.sku, barcode: ctx.barcode, name: 'QA Paracetamol 500 mg', categoryId: ctx.categoryId,
    activeIngredient: 'Paracetamol', concentration: '500 mg', dosageForm: 'Tableta', presentation: 'Caja x 100',
    sanitaryRegistration: 'EN-00001', unit: 'tableta', purchasePrice: '0.15', salePrice: 0.5, requiresPrescription: false,
    minimumStock: 30,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  ctx.productId = res.body.data.id;
  assert.equal(res.body.data.salePrice, '0.50', 'DECIMAL como texto, sin float');
  assert.equal(res.body.data.purchasePrice, '0.15');
  assert.equal(res.body.data.status, 'ACTIVE');

  const [[{ active }]] = await tx.conn.execute("SELECT COUNT(*) active FROM branches WHERE status = 'ACTIVE'");
  const [cfg] = await tx.conn.execute('SELECT minimum_stock FROM branch_products WHERE product_id = ?', [ctx.productId]);
  assert.equal(cfg.length, Number(active), 'una fila por sucursal activa');
  assert.ok(cfg.every((r) => Number(r.minimum_stock) === 30));
  assert.equal(await auditCount('products', ctx.productId, 'CREATE'), 1);

  const del = await admin.del(`/api/categories/${ctx.categoryId}`);
  assert.equal(del.status, 409, 'categoría con productos: no se elimina');
  assert.equal(del.body.error.code, 'IN_USE');
  assert.equal((await admin.get(`/api/categories/${ctx.categoryId}`)).body.data.productsCount, 1);
});

test('5-6, 15. validaciones: SKU y código de barras únicos, precios y obligatorios', async () => {
  const base = { name: 'QA Duplicado', categoryId: ctx.categoryId, salePrice: '1.00' };
  const dupSku = await admin.post('/api/products', { ...base, sku: ctx.sku });
  assert.equal(dupSku.status, 409);
  assert.equal(dupSku.body.error.code, 'SKU_TAKEN');
  const dupBar = await admin.post('/api/products', { ...base, sku: `QA-${uid()}`, barcode: ctx.barcode });
  assert.equal(dupBar.status, 409);
  assert.equal(dupBar.body.error.code, 'BARCODE_TAKEN');

  assert.equal((await admin.post('/api/products', { ...base, sku: `QA-${uid()}`, salePrice: '-1' })).status, 400, 'precio negativo');
  assert.equal((await admin.post('/api/products', { ...base, sku: `QA-${uid()}`, salePrice: '1.234' })).status, 400, '3 decimales');
  assert.equal((await admin.post('/api/products', { sku: `QA-${uid()}`, salePrice: '1' })).status, 400, 'faltan obligatorios');
  assert.equal((await admin.post('/api/products', { ...base, sku: 'QA 1;DROP' })).status, 400, 'SKU inseguro');
  const badCat = await admin.post('/api/products', { ...base, sku: `QA-${uid()}`, categoryId: 999999999 });
  assert.equal(badCat.status, 400);
});

test('7, 10. editar producto, asociar laboratorio y auditoría sin duplicados', async () => {
  const res = await admin.put(`/api/products/${ctx.productId}`, { name: 'QA Paracetamol 500 mg x100', salePrice: '0.60', laboratoryId: ctx.labId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.salePrice, '0.60');
  assert.equal(res.body.data.laboratory.id, ctx.labId);

  const [audits] = await tx.conn.execute(
    "SELECT old_values, new_values FROM audit_logs WHERE entity_table = 'products' AND entity_id = ? AND action = 'UPDATE' ORDER BY id",
    [String(ctx.productId)]);
  assert.equal(audits.length, 2, 'una del trigger (precio) y una explícita (nombre/laboratorio)');
  const obj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const explicit = audits.map((a) => obj(a.new_values)).find((n) => 'name' in n);
  assert.ok(explicit && !('sale_price' in explicit), 'la auditoría explícita no repite el precio');
  assert.ok(audits.some((a) => obj(a.new_values).sale_price === 0.6 || String(obj(a.new_values).sale_price) === '0.60'));

  const relink = await admin.put(`/api/products/${ctx.productId}`, { laboratoryId: ctx.lab2Id });
  assert.equal(relink.body.data.laboratory.id, ctx.lab2Id);
  const lab = await admin.get(`/api/laboratories/${ctx.lab2Id}`);
  assert.equal(lab.body.data.productsCount, 1, 'laboratorio asociado al producto');
});

test('8. listar productos con filtros y paginación real', async () => {
  const second = await admin.post('/api/products', {
    sku: `QA-${uid()}`, name: 'QA Ibuprofeno 400 mg', categoryId: ctx.categoryId, laboratoryId: ctx.labId, salePrice: '0.80',
  });
  assert.equal(second.status, 201);
  const enc = encodeURIComponent;
  const byName = await admin.get(`/api/products?q=${enc('QA Ibuprofeno')}`);
  assert.deepEqual(byName.body.data.map((p) => p.id), [second.body.data.id]);
  assert.equal((await admin.get(`/api/products?sku=${enc(ctx.sku)}`)).body.data[0].id, ctx.productId);
  assert.equal((await admin.get(`/api/products?barcode=${ctx.barcode}`)).body.data[0].id, ctx.productId);
  const byCat = await admin.get(`/api/products?categoryId=${ctx.categoryId}&pageSize=1&page=1`);
  assert.equal(byCat.body.pagination.total, 2);
  assert.equal(byCat.body.pagination.totalPages, 2);
  assert.equal(byCat.body.data.length, 1);
  const page2 = await admin.get(`/api/products?categoryId=${ctx.categoryId}&pageSize=1&page=2`);
  assert.notEqual(page2.body.data[0].id, byCat.body.data[0].id);
  assert.equal((await admin.get(`/api/products?laboratoryId=${ctx.labId}`)).body.data[0].id, second.body.data.id);
  assert.equal((await admin.get('/api/products?status=BAD')).status, 400);
  assert.equal((await admin.get('/api/products?pageSize=1000')).status, 400);
});

test('desactivar y reactivar producto (auditado por el trigger)', async () => {
  const off = await admin.patch(`/api/products/${ctx.productId}/status`, { status: 'INACTIVE' });
  assert.equal(off.body.data.status, 'INACTIVE');
  const inactive = await admin.get(`/api/products?status=INACTIVE&categoryId=${ctx.categoryId}`);
  assert.ok(inactive.body.data.some((p) => p.id === ctx.productId));
  assert.equal((await admin.patch(`/api/products/${ctx.productId}/status`, { status: 'ACTIVE' })).body.data.status, 'ACTIVE');
});

test('13. configuración por sucursal: precio particular, mínimo, máximo, ubicación y disponibilidad', async () => {
  const res = await admin.put(`/api/products/${ctx.productId}/branches/1`, {
    salePrice: '0.55', minimumStock: 40, maximumStock: 500, shelfLocation: 'A-01', isAvailable: true,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.salePrice, '0.55');
  assert.equal(res.body.data.effectiveSalePrice, '0.55');
  assert.equal(res.body.data.generalSalePrice, '0.60');
  assert.equal(res.body.data.shelfLocation, 'A-01');

  const fallback = await admin.put(`/api/products/${ctx.productId}/branches/1`, { salePrice: null });
  assert.equal(fallback.body.data.effectiveSalePrice, '0.60', 'sin precio particular usa el general');
  assert.equal((await admin.put(`/api/products/${ctx.productId}/branches/1`, { maximumStock: 10 })).status, 400, 'máximo < mínimo');

  const detail = await admin.get(`/api/products/${ctx.productId}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.data.branches.some((b) => b.branchId === 1 && b.minimumStock === 40));
  assert.ok(Array.isArray(detail.body.data.inventory));
  assert.ok(Array.isArray(detail.body.data.batches));
});

test('imágenes: se guarda solo la ruta; se rechazan tipos falsos y extensiones no permitidas', async () => {
  const ok = await admin.agent.put(`/api/products/${ctx.productId}/image`).set('X-CSRF-Token', admin.csrf)
    .attach('image', PNG, { filename: '../../etc/passwd.png', contentType: 'image/png' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const url = ok.body.data.imageUrl;
  assert.match(url, /^\/uploads\/products\/p\d+-[0-9a-f-]{36}\.png$/, 'nombre generado por el servidor');
  assert.ok(fs.existsSync(path.join(config.uploads.dir, 'products', path.basename(url))));
  assert.equal((await admin.get(url)).status, 200, 'servida como estático');

  const fake = await admin.agent.put(`/api/products/${ctx.productId}/image`).set('X-CSRF-Token', admin.csrf)
    .attach('image', Buffer.from('<script>alert(1)</script>xxxxxxxx'), { filename: 'x.png', contentType: 'image/png' });
  assert.equal(fake.status, 400, 'contenido que no es imagen');
  const exe = await admin.agent.put(`/api/products/${ctx.productId}/image`).set('X-CSRF-Token', admin.csrf)
    .attach('image', PNG, { filename: 'x.exe', contentType: 'application/octet-stream' });
  assert.equal(exe.status, 400);

  const second = await admin.agent.put(`/api/products/${ctx.productId}/image`).set('X-CSRF-Token', admin.csrf)
    .attach('image', PNG, { filename: 'otra.png', contentType: 'image/png' });
  assert.equal(second.status, 200);
  assert.ok(!fs.existsSync(path.join(config.uploads.dir, 'products', path.basename(url))), 'la imagen anterior se elimina');
});

test('11-12. proveedores: crear, validar RUC/correo, duplicados, buscar y desactivar', async () => {
  ctx.ruc = validRuc();
  const res = await admin.post('/api/suppliers', {
    businessName: 'QA Distribuidora SAC', tradeName: 'QA Dist', ruc: ctx.ruc, email: 'Ventas@QA-Dist.pe', phone: '+51 999 888 777',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  ctx.supplierId = res.body.data.id;
  assert.equal(res.body.data.email, 'ventas@qa-dist.pe');
  assert.equal(await auditCount('suppliers', ctx.supplierId, 'CREATE'), 1);

  const dup = await admin.post('/api/suppliers', { businessName: 'Otra', ruc: ctx.ruc });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'RUC_TAKEN');
  const badRuc = ctx.ruc.slice(0, 10) + String((Number(ctx.ruc[10]) + 1) % 10);
  assert.equal((await admin.post('/api/suppliers', { businessName: 'X', ruc: badRuc })).status, 400, 'dígito verificador');
  assert.equal((await admin.post('/api/suppliers', { businessName: 'X', ruc: '123' })).status, 400);
  assert.equal((await admin.post('/api/suppliers', { businessName: 'X', email: 'no-es-correo' })).status, 400);
  assert.equal((await admin.post('/api/suppliers', { ruc: validRuc() })).status, 400, 'razón social obligatoria');

  assert.equal((await admin.get(`/api/suppliers?ruc=${ctx.ruc}`)).body.data[0].id, ctx.supplierId);
  assert.ok((await admin.get('/api/suppliers?q=QA%20Distribuidora')).body.data.some((s) => s.id === ctx.supplierId));
  const edit = await admin.put(`/api/suppliers/${ctx.supplierId}`, { contactName: 'Ana Torres' });
  assert.equal(edit.body.data.contactName, 'Ana Torres');
  const off = await admin.patch(`/api/suppliers/${ctx.supplierId}/status`, { status: 'INACTIVE' });
  assert.equal(off.body.data.status, 'INACTIVE');
  assert.equal((await admin.patch(`/api/suppliers/${ctx.supplierId}/status`, { status: 'ACTIVE' })).body.data.status, 'ACTIVE');
  const history = await admin.get(`/api/suppliers/${ctx.supplierId}/entries`);
  assert.equal(history.status, 200);
  assert.equal(history.body.pagination.total, 0);
});

test('25. permisos: STAFF consulta pero no administra catálogo ni proveedores', async () => {
  assert.equal((await staff.get('/api/products')).status, 200);
  assert.equal((await staff.get('/api/categories')).status, 200);
  assert.equal((await staff.get('/api/suppliers')).status, 200);
  const denied = [
    await staff.post('/api/products', { sku: `QA-${uid()}`, name: 'X', categoryId: ctx.categoryId, salePrice: '1' }),
    await staff.put(`/api/products/${ctx.productId}`, { name: 'X' }),
    await staff.patch(`/api/products/${ctx.productId}/status`, { status: 'INACTIVE' }),
    await staff.post('/api/categories', { name: `QA ${uid()}` }),
    await staff.post('/api/laboratories', { name: `QA ${uid()}` }),
    await staff.post('/api/suppliers', { businessName: 'X' }),
    await staff.put(`/api/products/${ctx.productId}/branches/1`, { salePrice: '9.99' }),
  ];
  for (const r of denied) {
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PERMISSION_DENIED');
  }
  const anon = await require('supertest')(app).get('/api/products');
  assert.equal(anon.status, 401);
});
