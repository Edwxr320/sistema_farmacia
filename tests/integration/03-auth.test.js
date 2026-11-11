'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closePool } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const sessionRepository = require('../../src/repositories/session.repository');
const { getLockoutPolicy } = require('../../src/services/auth.service');
const { cleanupExpiredSessions } = require('../../src/services/session.service');
const { hashSessionId } = require('../../src/services/token.service');

const PASSWORD = 'Farmacia2026Segura';
const NEW_PASSWORD = 'Botica2027Nueva';
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
  users.inactive = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD, status: 'INACTIVE' });
  users.lockme = await createTestUser(tx.conn, { roleCode: 'STAFF', password: PASSWORD });
  users.changer = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
  users.forced = await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD });
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
});

/** Las pruebas que necesitan user_sessions se omiten (no se aprueban) si falta la migración. */
function dbTest(name, fn) {
  test(name, async (t) => {
    if (!migrationApplied) {
      t.skip('Falta aplicar database/migrations/001_user_sessions.sql');
      return;
    }
    await fn(t);
  });
}

async function newClient() {
  const agent = request.agent(app);
  const res = await agent.get('/api/auth/csrf-token').expect(200);
  return { agent, csrf: res.body.csrfToken };
}

async function login(user, password = PASSWORD) {
  const client = await newClient();
  const res = await client.agent.post('/api/auth/login').set('X-CSRF-Token', client.csrf).send({ email: user.email, password });
  if (res.status === 200) client.csrf = res.body.csrfToken;
  return { ...client, res };
}

function sessionCookieOf(res) {
  return res.headers['set-cookie'].find((c) => c.startsWith('pp_session=')).split(';')[0];
}

async function userRow(userId) {
  const [[r]] = await tx.conn.execute(
    'SELECT failed_login_attempts, locked_until, must_change_password, password_hash, password_changed_at FROM users WHERE id = ?',
    [userId],
  );
  return r;
}

test('login sin token CSRF es rechazado', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: users.admin.email, password: PASSWORD });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'CSRF_INVALID');
});

test('login con Origin ajeno es rechazado', async () => {
  const { agent, csrf } = await newClient();
  const res = await agent.post('/api/auth/login').set('Origin', 'https://sitio-malicioso.example').set('X-CSRF-Token', csrf)
    .send({ email: users.admin.email, password: PASSWORD });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'CSRF_ORIGIN');
});

test('validación del backend: correo inválido y campos extra', async () => {
  const { agent, csrf } = await newClient();
  const r1 = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: "' OR 1=1 --", password: 'x' });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error.code, 'VALIDATION_ERROR');
  const r2 = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: users.admin.email, password: PASSWORD, role: 'ADMIN' });
  assert.equal(r2.status, 400);
});

dbTest('inicio de sesión: cookies seguras, permisos de la vista, sesión persistida como hash', async () => {
  const requestId = `test-login-${Date.now()}`;
  const client = await newClient();
  const res = await client.agent.post('/api/auth/login').set('X-CSRF-Token', client.csrf).set('X-Request-Id', requestId)
    .send({ email: users.admin.email.toUpperCase(), password: PASSWORD });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.user.id, users.admin.id);
  assert.equal(res.body.user.role.code, 'ADMIN');
  assert.equal(res.body.branches[0].code, 'SP01');
  assert.ok(res.body.permissions.includes('users.view'));
  assert.doesNotMatch(JSON.stringify(res.body), /password_hash|\$2b\$/);

  const [[count]] = await tx.conn.execute(
    'SELECT COUNT(DISTINCT permission_code) n FROM vw_user_effective_permissions WHERE user_id = ?', [users.admin.id]);
  assert.equal(res.body.permissions.length, Number(count.n));

  const cookies = res.headers['set-cookie'].join('\n');
  assert.match(cookies, /pp_session=[^;]+;.*HttpOnly/i);
  assert.match(cookies, /pp_session=[^;]+;.*SameSite=Strict/i);
  assert.match(cookies, /pp_session=[^;]+;.*Max-Age=\d+/i);
  assert.doesNotMatch(cookies.split('\n').find((c) => c.startsWith('pp_csrf')), /HttpOnly/i);

  // Sesión guardada solo como SHA-256; ni el token ni el jti aparecen en la tabla.
  const token = sessionCookieOf(res).slice('pp_session='.length);
  const jti = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).jti;
  const [rows] = await tx.conn.execute('SELECT * FROM user_sessions WHERE user_id = ?', [users.admin.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_hash, hashSessionId(jti));
  assert.equal(rows[0].revoked_at, null);
  assert.ok(new Date(rows[0].expires_at) > new Date());
  assert.ok(!JSON.stringify(rows).includes(jti) && !JSON.stringify(rows).includes(token));

  const [[audit]] = await tx.conn.execute(
    "SELECT user_id, branch_id, ip_address, session_ref FROM audit_logs WHERE action = 'LOGIN' AND request_id = ?", [requestId]);
  assert.equal(Number(audit.user_id), users.admin.id);
  assert.equal(Number(audit.branch_id), res.body.activeBranchId);
  assert.ok(audit.ip_address);

  const u = await userRow(users.admin.id);
  assert.equal(Number(u.failed_login_attempts), 0);
});

test('contraseña incorrecta: 401 genérico e incremento de intentos', async () => {
  const { res } = await login(users.staff, 'Incorrecta123');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'AUTH_INVALID_CREDENTIALS');
  assert.equal(Number((await userRow(users.staff.id)).failed_login_attempts), 1);

  const { res: r2 } = await login({ email: 'no.existe@pharmaplus.test' }, 'Incorrecta123');
  assert.equal(r2.status, 401);
  assert.equal(r2.body.error.message, res.body.error.message);
  await tx.conn.execute('UPDATE users SET failed_login_attempts = 0 WHERE id = ?', [users.staff.id]);
});

test('la política de bloqueo se lee de settings', async () => {
  const policy = await getLockoutPolicy(tx.conn);
  const [rows] = await tx.conn.execute(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('security.max_failed_logins','security.lockout_minutes')");
  const map = Object.fromEntries(rows.map((r) => [r.setting_key, Number(r.setting_value)]));
  if (map['security.max_failed_logins']) {
    assert.equal(policy.maxAttempts, map['security.max_failed_logins']);
    assert.equal(policy.source.maxAttempts, 'settings');
  }
  if (map['security.lockout_minutes']) assert.equal(policy.lockoutMinutes, map['security.lockout_minutes']);
});

dbTest('bloqueo temporal tras N intentos fallidos (incluso con la contraseña correcta)', async () => {
  const { maxAttempts } = await getLockoutPolicy(tx.conn);
  for (let i = 1; i < maxAttempts; i += 1) {
    const { res } = await login(users.lockme, 'Incorrecta123');
    assert.equal(res.status, 401, `intento ${i}`);
  }
  const { res: last } = await login(users.lockme, 'Incorrecta123');
  assert.equal(last.status, 423);
  assert.equal(last.body.error.code, 'AUTH_LOCKED');
  const state = await userRow(users.lockme.id);
  assert.equal(Number(state.failed_login_attempts), maxAttempts);
  assert.ok(state.locked_until);

  assert.equal((await login(users.lockme)).res.status, 423, 'la contraseña correcta tampoco entra');

  await tx.conn.execute('UPDATE users SET locked_until = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [users.lockme.id]);
  assert.equal((await login(users.lockme)).res.status, 200);
  const reset = await userRow(users.lockme.id);
  assert.equal(Number(reset.failed_login_attempts), 0);
  assert.equal(reset.locked_until, null);
});

test('usuario bloqueado (BLOCKED) e inactivo no pueden iniciar sesión', async () => {
  const { res: b } = await login(users.blocked);
  assert.equal(b.status, 403);
  assert.equal(b.body.error.code, 'AUTH_USER_BLOCKED');
  assert.equal((await login(users.blocked, 'Incorrecta123')).res.status, 401, 'no revela el estado');
  const { res: i } = await login(users.inactive);
  assert.equal(i.status, 403);
  assert.equal(i.body.error.code, 'AUTH_USER_INACTIVE');
});

dbTest('usuario autenticado y restricción de rutas privadas', async () => {
  const anon = await request(app).get('/api/auth/me');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'AUTH_REQUIRED');
  assert.equal((await request(app).get('/api/auth/me').set('Cookie', 'pp_session=eyJhbGciOiJub25lIn0.e30.')).status, 401);
  assert.equal((await request(app).get('/api/users')).status, 401);
  assert.equal((await request(app).get('/api/roles')).status, 401);

  const { agent } = await login(users.staff);
  const me = await agent.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, users.staff.email);
  assert.ok(me.body.permissions.includes('sales.create'));
  assert.ok(!me.body.permissions.includes('users.view'));
});

dbTest('control de permisos por rol (ADMIN, STAFF, CUSTOMER)', async () => {
  const admin = await login(users.admin);
  const usersRes = await admin.agent.get('/api/users?page=1&pageSize=50');
  assert.equal(usersRes.status, 200);
  assert.ok(usersRes.body.data.some((u) => u.id === users.admin.id));
  assert.doesNotMatch(JSON.stringify(usersRes.body), /password/);
  assert.equal((await admin.agent.get('/api/roles')).status, 200);
  assert.ok((await admin.agent.get('/api/roles/permissions')).body.data.length > 0);

  const staff = await login(users.staff);
  const s1 = await staff.agent.get('/api/users');
  assert.equal(s1.status, 403);
  assert.equal(s1.body.error.code, 'PERMISSION_DENIED');
  assert.equal((await staff.agent.get('/api/roles')).status, 403);

  // Portales separados: un cliente no entra por el login del panel, sí por el de la tienda.
  const wrongPortal = await login(users.customer);
  assert.equal(wrongPortal.res.status, 403);
  assert.equal(wrongPortal.res.body.error.code, 'AUTH_WRONG_PORTAL');
  const customer = await newClient();
  customer.res = await customer.agent.post('/api/store/auth/login').set('X-CSRF-Token', customer.csrf)
    .send({ email: users.customer.email, password: PASSWORD });
  assert.equal(customer.res.status, 200, JSON.stringify(customer.res.body));
  assert.equal(customer.res.body.activeBranchId, null);
  assert.deepEqual(customer.res.body.permissions.sort(), ['store.browse', 'store.cart', 'store.orders', 'store.profile']);
  assert.equal((await customer.agent.get('/api/users')).status, 403);
  assert.equal((await admin.agent.get('/api/users?pageSize=1000')).status, 400);
});

dbTest('permisos individuales (user_permissions) se aplican de inmediato vía la vista', async () => {
  const [[perm]] = await tx.conn.execute("SELECT id FROM permissions WHERE code = 'users.view'");
  const staff = await login(users.staff);
  assert.equal((await staff.agent.get('/api/users')).status, 403);
  await tx.conn.execute("INSERT INTO user_permissions (user_id, permission_id, effect) VALUES (?, ?, 'GRANT')", [users.staff.id, perm.id]);
  assert.equal((await staff.agent.get('/api/users')).status, 200, 'GRANT individual');

  const admin = await login(users.admin);
  await tx.conn.execute("INSERT INTO user_permissions (user_id, permission_id, effect) VALUES (?, ?, 'DENY')", [users.admin.id, perm.id]);
  assert.equal((await admin.agent.get('/api/users')).status, 403, 'DENY individual');
  await tx.conn.execute('DELETE FROM user_permissions WHERE user_id IN (?, ?)', [users.admin.id, users.staff.id]);
});

dbTest('un usuario bloqueado pierde su sesión activa y la sesión queda revocada', async () => {
  const staff = await login(users.staff);
  const hash = hashSessionId(JSON.parse(Buffer.from(sessionCookieOf(staff.res).split('.')[1], 'base64url')).jti);
  assert.equal((await staff.agent.get('/api/auth/me')).status, 200);
  await tx.conn.execute("UPDATE users SET status = 'BLOCKED' WHERE id = ?", [users.staff.id]);
  assert.equal((await staff.agent.get('/api/auth/me')).status, 401);
  await tx.conn.execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [users.staff.id]);
  const [[row]] = await tx.conn.execute('SELECT revoked_reason FROM user_sessions WHERE session_hash = ?', [hash]);
  assert.equal(row.revoked_reason, 'USER_DISABLED');
});

dbTest('cierre de sesión persistente: el token revocado no sirve ni con una app recién iniciada', async () => {
  const client = await login(users.admin);
  const cookie = sessionCookieOf(client.res);

  assert.equal((await client.agent.post('/api/auth/logout')).status, 403, 'logout exige CSRF');
  const out = await client.agent.post('/api/auth/logout').set('X-CSRF-Token', client.csrf);
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie'].join(';'), /pp_session=;/);
  assert.equal((await client.agent.get('/api/auth/me')).status, 401);

  // Simula un reinicio de Node.js: instancia nueva de la app, sin estado en memoria.
  const freshApp = createApp();
  assert.equal((await request(freshApp).get('/api/auth/me').set('Cookie', cookie)).status, 401);

  const hash = hashSessionId(JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url')).jti);
  const [[row]] = await tx.conn.execute('SELECT revoked_at, revoked_reason FROM user_sessions WHERE session_hash = ?', [hash]);
  assert.ok(row.revoked_at);
  assert.equal(row.revoked_reason, 'LOGOUT');
  const [[audit]] = await tx.conn.execute("SELECT COUNT(*) n FROM audit_logs WHERE action = 'LOGOUT' AND user_id = ?", [users.admin.id]);
  assert.ok(Number(audit.n) >= 1);
});

dbTest('sesión expirada en la base es rechazada aunque el JWT siga vigente', async () => {
  const client = await login(users.staff);
  const hash = hashSessionId(JSON.parse(Buffer.from(sessionCookieOf(client.res).split('.')[1], 'base64url')).jti);
  await tx.conn.execute(
    'UPDATE user_sessions SET created_at = NOW() - INTERVAL 2 DAY, expires_at = NOW() - INTERVAL 1 MINUTE WHERE session_hash = ?', [hash]);
  assert.equal((await client.agent.get('/api/auth/me')).status, 401);
});

dbTest('limpieza de sesiones expiradas', async () => {
  await tx.conn.execute(
    `INSERT INTO user_sessions (session_hash, user_id, created_at, expires_at)
     VALUES (?, ?, NOW() - INTERVAL 3 DAY, NOW() - INTERVAL 2 DAY)`,
    [hashSessionId('sesion-vieja-de-prueba'), users.staff.id]);
  const active = await login(users.staff);
  const deleted = await cleanupExpiredSessions();
  assert.ok(deleted >= 1);
  const [[old]] = await tx.conn.execute('SELECT COUNT(*) n FROM user_sessions WHERE session_hash = ?', [hashSessionId('sesion-vieja-de-prueba')]);
  assert.equal(Number(old.n), 0);
  assert.equal((await active.agent.get('/api/auth/me')).status, 200, 'las sesiones vigentes no se tocan');
});

dbTest('cambio de contraseña: valida, actualiza, revoca otras sesiones y audita', async () => {
  const other = await login(users.changer); // otra sesión (otro dispositivo)
  const client = await login(users.changer);
  const before = await userRow(users.changer.id);

  const noCsrf = await client.agent.post('/api/auth/change-password')
    .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  assert.equal(noCsrf.status, 403);

  const anon = await request(app).post('/api/auth/change-password').set('X-CSRF-Token', client.csrf)
    .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  assert.equal(anon.status, 403, 'sin cookies no pasa CSRF ni autenticación');

  const weak = await client.agent.post('/api/auth/change-password').set('X-CSRF-Token', client.csrf)
    .send({ currentPassword: PASSWORD, newPassword: 'debil', confirmPassword: 'debil' });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.code, 'VALIDATION_ERROR');

  const wrong = await client.agent.post('/api/auth/change-password').set('X-CSRF-Token', client.csrf)
    .send({ currentPassword: 'Incorrecta123', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'AUTH_INVALID_CURRENT_PASSWORD');
  assert.equal(Number((await userRow(users.changer.id)).failed_login_attempts), 1, 'cuenta como intento fallido');

  const ok = await client.agent.post('/api/auth/change-password').set('X-CSRF-Token', client.csrf)
    .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.revokedSessions >= 2);
  client.csrf = ok.body.csrfToken;

  const after = await userRow(users.changer.id);
  assert.notEqual(after.password_hash, before.password_hash);
  assert.match(after.password_hash, /^\$2b\$/);
  assert.equal(Number(after.must_change_password), 0);
  assert.equal(Number(after.failed_login_attempts), 0);

  assert.equal((await client.agent.get('/api/auth/me')).status, 200, 'este cliente recibe una sesión nueva');
  assert.equal((await other.agent.get('/api/auth/me')).status, 401, 'las demás sesiones quedan cerradas');

  assert.equal((await login(users.changer, PASSWORD)).res.status, 401, 'la contraseña anterior ya no sirve');
  assert.equal((await login(users.changer, NEW_PASSWORD)).res.status, 200, 'la nueva contraseña funciona');

  const [audit] = await tx.conn.execute(
    "SELECT action, new_values FROM audit_logs WHERE entity_table = 'users' AND entity_id = ? AND action IN ('UPDATE','PASSWORD_CHANGE','PASSWORD_CHANGE_FAILED')",
    [String(users.changer.id)]);
  const actions = audit.map((a) => a.action);
  assert.ok(actions.includes('PASSWORD_CHANGE'));
  assert.ok(actions.includes('PASSWORD_CHANGE_FAILED'));
  const asObject = (v) => (typeof v === 'string' ? JSON.parse(v) : v); // mysql2 ya convierte JSON
  assert.ok(audit.some((a) => a.action === 'UPDATE' && asObject(a.new_values).password_changed === true), 'trigger trg_users_au');
  assert.doesNotMatch(JSON.stringify(audit), /\$2b\$|Farmacia2026Segura|Botica2027Nueva/);
});

dbTest('must_change_password obliga a cambiar la contraseña antes de operar', async () => {
  await tx.conn.execute('UPDATE users SET must_change_password = TRUE WHERE id = ?', [users.forced.id]);
  const client = await login(users.forced);
  assert.equal(client.res.status, 200);
  assert.equal(client.res.body.user.mustChangePassword, true);

  assert.equal((await client.agent.get('/api/auth/me')).status, 200, '/me permitido');
  const blocked = await client.agent.get('/api/users');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

  const ok = await client.agent.post('/api/auth/change-password').set('X-CSRF-Token', client.csrf)
    .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal((await client.agent.get('/api/users')).status, 200, 'tras el cambio puede operar');
  assert.equal((await client.agent.get('/api/auth/me')).body.user.mustChangePassword, false);
});

dbTest('token CSRF de otra sesión no sirve', async () => {
  const a = await login(users.admin);
  const b = await login(users.staff);
  assert.equal((await a.agent.post('/api/auth/logout').set('X-CSRF-Token', b.csrf)).status, 403);
});

test('rutas inexistentes y JSON inválido devuelven errores controlados', async () => {
  const nf = await request(app).get('/api/no-existe');
  assert.equal(nf.status, 404);
  assert.ok(nf.body.error.requestId);
  const { agent, csrf } = await newClient();
  const bad = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).set('Content-Type', 'application/json').send('{"email":');
  assert.equal(bad.status, 400);
  assert.doesNotMatch(JSON.stringify(bad.body), /stack|at \w+ \(/);
});

test('sin la migración, el login falla de forma controlada (503 MIGRATION_PENDING)', async (t) => {
  if (migrationApplied) {
    t.skip('La migración ya está aplicada');
    return;
  }
  const { res } = await login(users.admin);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'MIGRATION_PENDING');
});
