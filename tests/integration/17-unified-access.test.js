'use strict';

/**
 * Acceso único (POST /api/auth/access): el backend reconoce el tipo de cuenta por el rol guardado en la base
 * (users.email es UNIQUE: un correo = una cuenta) y emite solo esa sesión. Reutiliza el login existente:
 * mismo hash, bloqueo por intentos, auditoría, cookies y CSRF. Todo dentro de una transacción revertida.
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closePool } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const sessionRepository = require('../../src/repositories/session.repository');

const PASSWORD = 'Farmacia2026Segura';
let tx;
let app;
let migrationApplied = false;
const users = {};

test.before(async () => {
  tx = await startTransactionalDb();
  migrationApplied = await sessionRepository.tableExists(tx.conn);
  app = createApp();
  users.admin = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  users.staff = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  users.customer = await createTestUser(tx.conn, { roleCode: 'CUSTOMER', password: PASSWORD, withBranch: false });
  users.blocked = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD, status: 'BLOCKED' });
  users.counter = await createTestUser(tx.conn, { roleCode: 'CUSTOMER', password: PASSWORD, withBranch: false });
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
});

function dbTest(name, fn) {
  test(name, async (t) => {
    if (!migrationApplied) { t.skip('Falta aplicar database/migrations/001_user_sessions.sql'); return; }
    await fn(t);
  });
}

async function client() {
  const agent = request.agent(app);
  const res = await agent.get('/api/auth/csrf-token').expect(200);
  return { agent, csrf: res.body.csrfToken };
}

async function access(c, email, password = PASSWORD) {
  const res = await c.agent.post('/api/auth/access').set('X-CSRF-Token', c.csrf).send({ email, password });
  if (res.body.csrfToken) c.csrf = res.body.csrfToken;
  return res;
}

const sessionCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('pp_session='))?.split(';')[0];

dbTest('administrador y trabajador → sesión de personal con su rol, permisos y sucursal', async () => {
  for (const [u, role] of [[users.admin, 'ADMIN'], [users.staff, 'STAFF']]) {
    const c = await client();
    const res = await access(c, u.email);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.accountType, 'STAFF');
    assert.equal(res.body.user.role.code, role);
    assert.ok(res.body.permissions.length > 0);
    assert.ok(res.body.activeBranchId);
    const me = await c.agent.get('/api/auth/me').expect(200);
    assert.equal(me.body.user.email, u.email);
    // Un trabajador no opera como cliente en la tienda.
    assert.equal((await c.agent.get('/api/store/me')).status, 403);
  }
});

dbTest('cliente → sesión de cliente; sin acceso a las APIs administrativas', async () => {
  const c = await client();
  const res = await access(c, users.customer.email);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.accountType, 'CUSTOMER');
  assert.equal(res.body.user.role.code, 'CUSTOMER');
  const me = await c.agent.get('/api/auth/me').expect(200);
  assert.equal(me.body.user.role.code, 'CUSTOMER');
  assert.ok(me.body.permissions.every((p) => p.startsWith('store.')), 'solo permisos de tienda');
  assert.equal((await c.agent.get('/api/users')).status, 403);
  assert.equal((await c.agent.get('/api/sales')).status, 403);
});

dbTest('mismo error para correo inexistente y contraseña incorrecta; estados de cuenta se respetan', async () => {
  const c = await client();
  const unknown = await access(c, `no.existe.${Date.now()}@pharmaplus.test`);
  const wrong = await access(c, users.staff.email, 'Incorrecta2026X');
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.body.error.code, wrong.body.error.code);
  assert.equal(unknown.body.error.message, wrong.body.error.message);
  assert.equal(sessionCookie(unknown), undefined);
  const blocked = await access(c, users.blocked.email);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'AUTH_USER_BLOCKED');
});

dbTest('el intento fallido cuenta para el bloqueo por intentos (misma política)', async () => {
  const before = (await tx.conn.execute('SELECT failed_login_attempts FROM users WHERE id = ?', [users.counter.id]))[0][0].failed_login_attempts;
  const c = await client();
  await access(c, users.counter.email, 'Incorrecta2026X');
  const after = (await tx.conn.execute('SELECT failed_login_attempts FROM users WHERE id = ?', [users.counter.id]))[0][0].failed_login_attempts;
  assert.equal(Number(after), Number(before) + 1);
});

dbTest('exige CSRF', async () => {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/access').send({ email: users.staff.email, password: PASSWORD });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'CSRF_INVALID');
});

dbTest('cambiar de cuenta revoca la sesión anterior; credenciales inválidas no la cierran', async () => {
  const c = await client();
  const first = await access(c, users.staff.email);
  const staffCookie = sessionCookie(first);
  assert.ok(staffCookie);

  // Intento fallido con sesión abierta: la sesión de personal sigue activa.
  const bad = await access(c, users.customer.email, 'Incorrecta2026X');
  assert.equal(bad.status, 401);
  assert.equal((await c.agent.get('/api/auth/me').expect(200)).body.user.email, users.staff.email);

  // Ingreso como cliente en el mismo navegador: solo queda la sesión de cliente.
  const second = await access(c, users.customer.email);
  assert.equal(second.status, 200);
  assert.equal(second.body.accountType, 'CUSTOMER');
  assert.equal((await c.agent.get('/api/auth/me').expect(200)).body.user.email, users.customer.email);
  const old = await request(app).get('/api/auth/me').set('Cookie', staffCookie);
  assert.equal(old.status, 401, 'la sesión de personal anterior quedó revocada');
});
