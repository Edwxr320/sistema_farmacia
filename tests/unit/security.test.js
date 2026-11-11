'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCsrfToken, verifyCsrfToken } = require('../../src/services/csrf.service');
const tokenService = require('../../src/services/token.service');
const { mapDbError } = require('../../src/utils/db-errors');
const { requirePermission } = require('../../src/middlewares/authorize');
const { loginSchema, createAdminSchema, changePasswordSchema } = require('../../src/validators/auth.validator');
const { hashPassword, verifyPassword } = require('../../src/services/password.service');
const { withConnection } = require('../../src/config/database');
const db = require('../../src/config/database');

test('CSRF: token válido solo para su vínculo', () => {
  const t = generateCsrfToken('sesion-1');
  assert.equal(verifyCsrfToken(t, 'sesion-1'), true);
  assert.equal(verifyCsrfToken(t, 'sesion-2'), false);
  assert.equal(verifyCsrfToken(t, 'anonymous'), false);
  assert.equal(verifyCsrfToken(`${t}x`, 'sesion-1'), false);
  assert.equal(verifyCsrfToken('basura', 'sesion-1'), false);
});

test('JWT de sesión: emisión, verificación, hash del id y manipulación', () => {
  const s = tokenService.issueSessionToken({ userId: 7, branchId: 1 });
  const claims = tokenService.verifySessionToken(s.token);
  assert.equal(claims.userId, 7);
  assert.equal(claims.branchId, 1);
  assert.equal(claims.jti, s.jti);
  assert.match(s.sessionHash, /^[0-9a-f]{64}$/);
  assert.equal(claims.sessionHash, s.sessionHash);
  assert.notEqual(s.sessionHash, s.jti);
  assert.ok(!s.token.includes(s.sessionHash), 'el token no contiene el hash guardado');

  const [h, p, sig] = s.token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: '1' })).toString('base64url');
  assert.equal(tokenService.verifySessionToken(`${h}.${forged}.${sig}`), null, 'payload alterado');

  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
  assert.equal(tokenService.verifySessionToken(none), null, 'alg=none rechazado');
});

test('Validación del cambio de contraseña', () => {
  const ok = { currentPassword: 'Actual2026xx', newPassword: 'Nueva2026Segura', confirmPassword: 'Nueva2026Segura' };
  assert.equal(changePasswordSchema.safeParse(ok).success, true);
  assert.equal(changePasswordSchema.safeParse({ ...ok, confirmPassword: 'Otra2026Segura' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ ...ok, newPassword: 'debil', confirmPassword: 'debil' }).success, false);
  assert.equal(
    changePasswordSchema.safeParse({ currentPassword: 'Nueva2026Segura', newPassword: 'Nueva2026Segura', confirmPassword: 'Nueva2026Segura' }).success,
    false,
    'igual a la actual',
  );
  assert.equal(changePasswordSchema.safeParse({ ...ok, extra: 1 }).success, false);
});

test('bcrypt: hash compatible con el CHECK de users y verificación', async () => {
  const hash = await hashPassword('ClaveSegura123');
  assert.match(hash, /^\$2b\$\d{2}\$[./A-Za-z0-9]{53}$/);
  assert.equal(await verifyPassword('ClaveSegura123', hash), true);
  assert.equal(await verifyPassword('ClaveSegura124', hash), false);
  assert.equal(await verifyPassword('x', 'texto-plano'), false);
});

test('Errores MariaDB se traducen por errno sin filtrar SQL', () => {
  const pp = mapDbError({ errno: 1644, sqlMessage: 'PP: stock insuficiente', sql: 'INSERT ...' });
  assert.equal(pp.status, 422);
  assert.equal(pp.message, 'stock insuficiente');
  assert.equal(mapDbError({ errno: 1062, sqlMessage: "Duplicate entry 'a@b.c'" }).status, 409);
  assert.doesNotMatch(mapDbError({ errno: 1062, sqlMessage: "Duplicate entry 'a@b.c'" }).message, /a@b/);
  assert.equal(mapDbError({ errno: 4025 }).status, 422);
  assert.equal(mapDbError({ errno: 1213 }).status, 503);
  assert.equal(mapDbError({ errno: 1146, sqlMessage: "Table 'pharma_plus.user_sessions' doesn't exist" }).code, 'MIGRATION_PENDING');
  assert.equal(mapDbError(new Error('otro')), null);
});

test('requirePermission permite y deniega según req.auth.permissions', () => {
  const mw = requirePermission('users.view');
  let result;
  mw({ auth: { permissions: new Set(['users.view']) } }, {}, (e) => (result = e));
  assert.equal(result, undefined);
  mw({ auth: { permissions: new Set(['sales.view']) } }, {}, (e) => (result = e));
  assert.equal(result.status, 403);
  mw({}, {}, (e) => (result = e));
  assert.equal(result.status, 401);
});

test('Validación de login y de política de contraseñas', () => {
  assert.equal(loginSchema.safeParse({ email: ' Admin@Botica.PE ', password: 'x' }).data.email, 'admin@botica.pe');
  assert.equal(loginSchema.safeParse({ email: "' OR 1=1 --", password: 'x' }).success, false);
  assert.equal(loginSchema.safeParse({ email: 'a@b.pe', password: '' }).success, false);
  assert.equal(loginSchema.safeParse({ email: 'a@b.pe', password: 'x', role: 'ADMIN' }).success, false, 'campos extra');

  const ok = { fullName: 'María Pérez', email: 'maria@botica.pe', password: 'Farmacia2026x' };
  assert.equal(createAdminSchema.safeParse(ok).success, true);
  assert.equal(createAdminSchema.safeParse({ ...ok, password: 'corta1A' }).success, false);
  assert.equal(createAdminSchema.safeParse({ ...ok, password: 'sinnumerosAA' }).success, false);
  assert.equal(createAdminSchema.safeParse({ ...ok, password: 'Maria12345XX' }).success, false, 'contiene el correo');
  assert.equal(createAdminSchema.safeParse({ ...ok, password: `Aa1${'x'.repeat(70)}` }).success, false, '> 72 bytes');
  assert.equal(createAdminSchema.safeParse({ ...ok, fullName: '<script>' }).success, false);
});

test('withConnection fija y limpia el contexto en la MISMA conexión y la libera', async () => {
  const calls = [];
  const fake = {
    query: async (sql, params) => calls.push([sql, params]),
    release: () => calls.push(['release']),
    destroy: () => calls.push(['destroy']),
  };
  db.setConnectionProvider({ getConnection: async () => fake });
  try {
    await withConnection({ userId: 5, branchId: 1, requestId: 'r1', ip: '::1', userAgent: 'ua', sessionRef: 'j' }, async (c) => {
      assert.equal(c, fake);
      await c.query('SELECT 1');
    });
    assert.deepEqual(calls[0], ['CALL sp_set_app_context(?, ?, ?, ?)', [5, 1, 'r1', '::1']]);
    assert.deepEqual(calls[1], ['SET @app_user_agent = ?, @app_session_ref = ?', ['ua', 'j']]);
    assert.equal(calls[2][0], 'SELECT 1');
    assert.equal(calls[3][0], 'CALL sp_set_app_context(NULL, NULL, NULL, NULL)');
    assert.deepEqual(calls.at(-1), ['release']);

    // Si la limpieza falla, la conexión se destruye en vez de volver al pool.
    calls.length = 0;
    let n = 0;
    fake.query = async (sql) => {
      n += 1;
      calls.push([sql]);
      if (sql.startsWith('CALL sp_set_app_context(NULL')) throw new Error('fallo');
      return n;
    };
    await assert.rejects(withConnection({}, async () => { throw new Error('error de negocio'); }), /error de negocio/);
    assert.deepEqual(calls.at(-1), ['destroy']);
  } finally {
    db.resetConnectionProvider();
  }
});
