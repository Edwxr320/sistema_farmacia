'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { config, validateConfig } = require('../../src/config/env');
const { getPool, withConnection, closePool } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const userRepository = require('../../src/repositories/user.repository');
const { EXPECTED_TABLES, EXPECTED_VIEWS } = require('../../src/utils/schema-catalog');

test.after(() => closePool());

test('configuración: usa pharma_app y no root', () => {
  assert.deepEqual(validateConfig({ requireAuthSecrets: false }), []);
  assert.notEqual(config.db.user, 'root');
});

test('conexión real a MariaDB: versión, base, collation, zona horaria y sql_mode', async () => {
  const conn = await getPool().getConnection();
  try {
    const [[row]] = await conn.query(
      'SELECT VERSION() v, DATABASE() d, @@collation_connection c, @@session.time_zone tz, @@session.sql_mode m, CURRENT_USER() u',
    );
    assert.match(row.v, /^10\.11\.\d+-MariaDB/);
    assert.equal(row.d, config.db.database);
    assert.equal(row.c, 'utf8mb4_unicode_ci');
    assert.equal(row.tz, '-05:00');
    assert.match(row.m, /STRICT_TRANS_TABLES/);
    assert.match(row.u, /^pharma_app@/);
  } finally {
    conn.release();
  }
});

test('el usuario pharma_app NO puede modificar el esquema', async () => {
  const conn = await getPool().getConnection();
  try {
    await assert.rejects(conn.query('CREATE TABLE pp_should_not_exist (id INT)'), (e) => [1142, 1044].includes(e.errno));
    await assert.rejects(conn.query('DROP VIEW vw_kardex'), (e) => [1142, 1044].includes(e.errno));
  } finally {
    conn.release();
  }
});

test('existen las 42 tablas y 17 vistas esperadas', async () => {
  await withConnection({}, async (conn) => {
    const [rows] = await conn.execute(
      'SELECT TABLE_NAME n, TABLE_TYPE t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [config.db.database],
    );
    const tables = rows.filter((r) => r.t === 'BASE TABLE').map((r) => r.n);
    const views = rows.filter((r) => r.t === 'VIEW').map((r) => r.n);
    for (const t of EXPECTED_TABLES) assert.ok(tables.includes(t), `falta tabla ${t}`);
    for (const v of EXPECTED_VIEWS) assert.ok(views.includes(v), `falta vista ${v}`);
  });
});

test('DECIMAL llega como texto (sin pérdida de precisión)', async () => {
  await withConnection({}, async (conn) => {
    const [[row]] = await conn.query('SELECT CAST(? AS DECIMAL(12,2)) AS monto', ['12345678.99']);
    assert.equal(row.monto, '12345678.99');
  });
});

test('consultas parametrizadas: una inyección no altera la consulta', async () => {
  await withConnection({}, async (conn) => {
    assert.equal(await userRepository.findForLogin(conn, "' OR '1'='1"), null);
    assert.equal(await userRepository.findForLogin(conn, "x@y.pe' UNION SELECT 1,2,3 -- "), null);
    const [rows] = await conn.execute('SELECT code FROM roles WHERE code = ?', ["ADMIN' OR 1=1 -- "]);
    assert.equal(rows.length, 0);
  });
});

test('el contexto de auditoría no se filtra entre peticiones que reutilizan una conexión', async () => {
  const ids = [];
  await withConnection({ userId: 999999, branchId: 1, requestId: 'req-a' }, async (conn) => {
    const [[r]] = await conn.query('SELECT CONNECTION_ID() id, @app_user_id u, @app_request_id q');
    ids.push(r.id);
    assert.equal(Number(r.u), 999999);
    assert.equal(r.q, 'req-a');
  });
  await withConnection({ requestId: 'req-b' }, async (conn) => {
    const [[r]] = await conn.query('SELECT CONNECTION_ID() id, @app_user_id u, @app_request_id q');
    ids.push(r.id);
    assert.equal(r.u, null);
    assert.equal(r.q, 'req-b');
  });
  // Sin otras peticiones concurrentes, el pool reutiliza la misma conexión física.
  assert.equal(ids[0], ids[1], 'se esperaba reutilizar la misma conexión');
});

test('GET /api/health informa MariaDB, esquema y migraciones, sin credenciales', async (t) => {
  const res = await request(createApp()).get('/api/health');
  assert.equal(res.body.database.engine, 'MariaDB');
  assert.match(res.body.database.version, /^10\.11/);
  assert.equal(res.body.database.name, config.db.database);
  assert.deepEqual(res.body.database.schema.tables.missing, []);
  assert.deepEqual(res.body.database.schema.views.missing, []);
  assert.equal(res.body.database.schema.views.found, 17);
  const pending = res.body.database.migrations.pending;
  if (pending.length === 0) {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'ok');
    assert.deepEqual(res.body.database.migrations.applied, ['001']);
  } else {
    // Migración sin aplicar: el health check debe reportarlo como degradado (503).
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'degraded');
    assert.equal(pending[0].file, 'database/migrations/001_user_sessions.sql');
  }
  const raw = JSON.stringify(res.body);
  assert.doesNotMatch(raw, /pharma_app|password|127\.0\.0\.1|3306/i);
  if (config.db.password) assert.ok(!raw.includes(config.db.password));
  assert.ok(res.headers['content-security-policy'], 'Helmet activo');
  assert.equal(res.headers['x-powered-by'], undefined);
});
