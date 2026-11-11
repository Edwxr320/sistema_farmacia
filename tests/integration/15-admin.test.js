'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closePool } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const { loginClient, storeCustomer, uid } = require('../helpers/http');

const PASSWORD = 'Farmacia2026Segura';
let tx;
let app;
let admin;
let staff;
const ctx = {};

async function emailOf(id) {
  const [[r]] = await tx.conn.execute('SELECT email FROM users WHERE id = ?', [id]);
  return r.email;
}

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  const a = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  const s = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  ctx.adminId = a.id;
  ctx.staffId = s.id;
  admin = await loginClient(app, a);
  staff = await loginClient(app, s);
  const [[r]] = await tx.conn.execute("SELECT id FROM roles WHERE code = 'STAFF'");
  ctx.staffRole = r.id;
  const [[ar]] = await tx.conn.execute("SELECT id FROM roles WHERE code = 'ADMIN'");
  ctx.adminRole = ar.id;
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
});

test('clientes de mostrador: alta, documento único, búsqueda y edición', async () => {
  const c = await staff.post('/api/customers', { fullName: 'Rosa Quispe', documentType: 'DNI', documentNumber: '70123456', phone: '988777666' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.data.hasAccount, false);
  assert.equal((await staff.post('/api/customers', { fullName: 'Otra Rosa', documentType: 'DNI', documentNumber: '70123456' })).status, 409);
  assert.equal((await staff.post('/api/customers', { fullName: 'Doc Malo', documentType: 'DNI', documentNumber: '12' })).status, 400);
  const found = await staff.get('/api/customers?q=70123456');
  assert.equal(found.body.data[0].id, c.body.data.id);
  const upd = await staff.put(`/api/customers/${c.body.data.id}`, { phone: '911222333' });
  assert.equal(upd.body.data.phone, '911222333');
  const web = await storeCustomer(app);
  assert.equal((await web.get('/api/customers')).status, 403, 'un cliente no accede a la gestión de clientes');
  assert.equal((await staff.put(`/api/customers/${web.customerId}`, { email: 'otro@x.pe' })).status, 400, 'el correo web lo gestiona el cliente');
});

test('trabajadores: alta con sucursales, contraseña temporal y cambio obligatorio', async () => {
  const email = `qa.worker.${uid().toLowerCase()}@pharmaplus.test`;
  const res = await admin.post('/api/users', { fullName: 'Luis Torres', email, password: 'Temporal2026Abc', roleId: ctx.staffRole, branchIds: [1] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.mustChangePassword, true);
  assert.deepEqual(res.body.data.branches.map((b) => [b.id, b.isDefault]), [[1, true]]);
  ctx.workerId = res.body.data.id;
  assert.equal((await admin.post('/api/users', { fullName: 'Dup', email, password: 'Temporal2026Abc', roleId: ctx.staffRole, branchIds: [1] })).status, 409);
  const [[cust]] = await tx.conn.execute("SELECT id FROM roles WHERE code = 'CUSTOMER'");
  assert.equal((await admin.post('/api/users', { fullName: 'Cliente Falso', email: `c${uid()}@pharmaplus.test`, password: 'Temporal2026Abc', roleId: cust.id, branchIds: [1] })).status, 400);
  assert.equal((await staff.post('/api/users', { fullName: 'X Y', email: `s${uid()}@pharmaplus.test`, password: 'Temporal2026Abc', roleId: ctx.staffRole, branchIds: [1] })).status, 403);

  const worker = await loginClient(app, { email, password: 'Temporal2026Abc' });
  assert.equal((await worker.get('/api/products')).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  const list = await admin.get('/api/users?q=Luis%20Torres');
  assert.equal(list.body.data[0].id, ctx.workerId);
  assert.ok(!JSON.stringify(list.body).includes('password_hash'));
  assert.ok((await admin.get('/api/users?pageSize=100')).body.data.every((u) => u.role.code !== 'CUSTOMER'), 'no lista clientes');
});

test('trabajadores: edición, bloqueo con cierre de sesiones, restablecer contraseña y desbloqueo', async () => {
  const upd = await admin.put(`/api/users/${ctx.staffId}`, { phone: '955444333', branchIds: [1] });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.data.phone, '955444333');
  const blocked = await admin.put(`/api/users/${ctx.staffId}`, { status: 'BLOCKED' });
  assert.equal(blocked.body.data.status, 'BLOCKED');
  assert.equal((await staff.get('/api/auth/me')).status, 401, 'sus sesiones quedaron revocadas');
  await admin.put(`/api/users/${ctx.staffId}`, { status: 'ACTIVE' });
  staff = await loginClient(app, { email: await emailOf(ctx.staffId), password: PASSWORD });

  const reset = await admin.post(`/api/users/${ctx.workerId}/reset-password`, { password: 'NuevaTemp2026Xyz' });
  assert.equal(reset.status, 200);
  const [[w]] = await tx.conn.execute('SELECT must_change_password FROM users WHERE id = ?', [ctx.workerId]);
  assert.equal(Number(w.must_change_password), 1, 'la contraseña restablecida es temporal');
  await tx.conn.execute('UPDATE users SET failed_login_attempts = 5, locked_until = NOW() + INTERVAL 10 MINUTE WHERE id = ?', [ctx.workerId]);
  const unlocked = await admin.post(`/api/users/${ctx.workerId}/unlock`);
  assert.equal(unlocked.body.data.lockedUntil, null);
});

test('protecciones: nadie se bloquea ni cambia su rol, y siempre queda un administrador activo', async () => {
  assert.equal((await admin.put(`/api/users/${ctx.adminId}`, { status: 'BLOCKED' })).body.error.code, 'SELF_CHANGE_FORBIDDEN');
  assert.equal((await admin.put(`/api/users/${ctx.adminId}`, { roleId: ctx.staffRole })).body.error.code, 'SELF_CHANGE_FORBIDDEN');

  // Supervisor STAFF con users.manage concedido individualmente; ctx.adminId queda como ÚNICO
  // administrador activo (los demás se desactivan solo dentro de la transacción de prueba).
  const [[perm]] = await tx.conn.execute("SELECT id FROM permissions WHERE code = 'users.manage'");
  await tx.conn.execute("INSERT INTO user_permissions (user_id, permission_id, effect) VALUES (?, ?, 'GRANT')", [ctx.staffId, perm.id]);
  await tx.conn.execute("UPDATE users u JOIN roles r ON r.id = u.role_id SET u.status = 'INACTIVE' WHERE r.code = 'ADMIN' AND u.id <> ?", [ctx.adminId]);
  const demote = await staff.put(`/api/users/${ctx.adminId}`, { roleId: ctx.staffRole });
  assert.equal(demote.status, 409);
  assert.equal(demote.body.error.code, 'LAST_ADMIN');
  assert.equal((await staff.put(`/api/users/${ctx.adminId}`, { status: 'BLOCKED' })).body.error.code, 'LAST_ADMIN');

  // Con otro administrador activo, bloquear a uno de los dos sí está permitido.
  const other = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  assert.equal((await staff.put(`/api/users/${other.id}`, { status: 'BLOCKED' })).status, 200);
  // Pero ahora ctx.adminId vuelve a ser el último: no puede degradarse.
  assert.equal((await staff.put(`/api/users/${ctx.adminId}`, { roleId: ctx.staffRole })).body.error.code, 'LAST_ADMIN');
  await tx.conn.execute('DELETE FROM user_permissions WHERE user_id = ?', [ctx.staffId]);
});

test('permisos individuales y roles: GRANT/DENY, rol nuevo, roles protegidos', async () => {
  const grant = await admin.put(`/api/users/${ctx.staffId}/permissions`, { overrides: [{ code: 'users.view', effect: 'GRANT', reason: 'Supervisor' }] });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal((await staff.get('/api/users')).status, 200);
  assert.equal((await admin.put(`/api/users/${ctx.adminId}/permissions`, { overrides: [] })).body.error.code, 'SELF_CHANGE_FORBIDDEN');
  assert.equal((await admin.put(`/api/users/${ctx.staffId}/permissions`, { overrides: [{ code: 'no.existe', effect: 'GRANT' }] })).status, 400);
  await admin.put(`/api/users/${ctx.staffId}/permissions`, { overrides: [] });
  assert.equal((await staff.get('/api/users')).status, 403);

  const role = await admin.post('/api/roles', { code: `QA_${uid()}`, name: 'Cajero de prueba' });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  const perms = await admin.put(`/api/roles/${role.body.data.id}/permissions`, { permissions: ['sales.create', 'sales.view', 'cash.open'] });
  assert.equal(perms.status, 200);
  assert.deepEqual(perms.body.data.permissions.sort(), ['cash.open', 'sales.create', 'sales.view']);
  assert.equal((await admin.put(`/api/roles/${ctx.adminRole}/permissions`, { permissions: [] })).body.error.code, 'ROLE_PROTECTED');
  assert.equal((await admin.put(`/api/roles/${role.body.data.id}/permissions`, { permissions: ['store.cart'] })).status, 400);
  assert.equal((await staff.post('/api/roles', { code: 'X1', name: 'Nope' })).status, 403);
  assert.ok((await admin.get('/api/roles')).body.data.some((r) => r.code === 'STAFF'));
});

test('sucursales y cajas', async () => {
  const b = await admin.post('/api/branches', { code: `QB${uid().slice(0, 4)}`, name: `QA Sucursal ${uid()}`, district: 'Surco', province: 'Lima' });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const [[seq]] = await tx.conn.execute('SELECT COUNT(*) c FROM document_sequences WHERE branch_id = ?', [b.body.data.id]);
  assert.equal(Number(seq.c), 9, 'el trigger creó las secuencias');
  const reg = await admin.post(`/api/branches/${b.body.data.id}/registers`, { code: 'CAJA01', name: 'Caja 1' });
  assert.equal(reg.status, 201);
  assert.equal((await admin.post(`/api/branches/${b.body.data.id}/registers`, { code: 'CAJA01', name: 'Dup' })).status, 409);
  assert.equal((await admin.put(`/api/branches/${b.body.data.id}`, { phone: '014445566' })).body.data.phone, '014445566');
  assert.equal((await admin.put('/api/branches/1', { status: 'INACTIVE' })).body.error.code, 'MAIN_BRANCH');
  assert.equal((await staff.post('/api/branches', { code: 'QZ99', name: 'No autorizada' })).status, 403);
  const visible = await staff.get('/api/branches');
  assert.deepEqual(visible.body.data.map((x) => x.id), [1], 'STAFF ve solo su sucursal');
});

test('configuración: valores actuales, edición validada, parámetros protegidos y cobertura opcional', async () => {
  const list = await admin.get('/api/settings');
  assert.equal(list.status, 200);
  const fee = list.body.data.settings.find((s) => s.key === 'orders.default_delivery_fee');
  assert.equal(fee.editable, true);
  assert.equal(list.body.data.settings.find((s) => s.key === 'payments.mode').editable, false);
  const existing = list.body.data.settings.some((s) => s.key === 'orders.delivery_districts');
  if (!existing) assert.ok(list.body.data.optional.some((o) => o.key === 'orders.delivery_districts' && o.configured === false));

  const upd = await admin.put('/api/settings/orders.default_delivery_fee', { value: '5.50' });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.data.value, '5.50');
  const [[audit]] = await tx.conn.execute("SELECT COUNT(*) c FROM audit_logs WHERE entity_table = 'settings' AND entity_id = 'orders.default_delivery_fee'");
  assert.ok(Number(audit.c) >= 1, 'auditado por el trigger');
  assert.equal((await admin.put('/api/settings/orders.default_delivery_fee', { value: '-1' })).status, 400);
  assert.equal((await admin.put('/api/settings/payments.mode', { value: 'REAL' })).body.error.code, 'SETTING_LOCKED');
  assert.equal((await admin.put('/api/settings/no.existe', { value: 'x' })).status, 404);
  const cov = await admin.put('/api/settings/orders.delivery_districts', { value: ['Miraflores', 'San Isidro'] });
  assert.equal(cov.status, 200, JSON.stringify(cov.body));
  assert.equal(cov.body.data.value, '["Miraflores","San Isidro"]');
  assert.equal((await admin.put('/api/settings/orders.delivery_districts', { value: '{"a":1}' })).status, 400);

  const pub = await request(app).get('/api/settings/public');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.deliveryFee, '5.50');
  assert.deepEqual(pub.body.data.deliveryDistricts, ['Miraflores', 'San Isidro']);
  assert.ok(!JSON.stringify(pub.body).includes('security'), 'sin parámetros de seguridad');
  assert.equal((await staff.get('/api/settings')).status, 403);
});
