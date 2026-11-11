'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const { closePool } = require('../../src/config/database');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createFirstAdmin } = require('../../src/services/admin-bootstrap.service');
const userRepository = require('../../src/repositories/user.repository');

let tx;
test.before(async () => {
  tx = await startTransactionalDb();
});
test.after(async () => {
  await tx.rollbackAll();
  await closePool();
});

test('registro seguro del primer administrador y bloqueo de duplicados', async () => {
  const { conn } = tx;
  const existingAdmins = await userRepository.countByRoleCode(conn, 'ADMIN');
  const data = { fullName: 'Administrador De Prueba', email: 'qa.bootstrap@pharmaplus.test', password: 'Farmacia2026Segura' };

  if (existingAdmins === 0) {
    const result = await createFirstAdmin(data);
    assert.equal(result.role, 'ADMIN');
    assert.equal(result.branch.code, 'SP01');

    const [[u]] = await conn.execute(
      'SELECT u.password_hash, u.status, r.code role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?',
      [result.userId],
    );
    assert.match(u.password_hash, /^\$2b\$/);
    assert.notEqual(u.password_hash, data.password);
    assert.equal(u.status, 'ACTIVE');
    assert.equal(u.role, 'ADMIN');

    const [branches] = await conn.execute(
      'SELECT b.is_main, ub.is_default FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = ?',
      [result.userId],
    );
    assert.equal(branches.length, 1);
    assert.equal(Number(branches[0].is_main), 1);
    assert.equal(Number(branches[0].is_default), 1);

    const [audit] = await conn.execute(
      "SELECT action, new_values, request_id FROM audit_logs WHERE entity_table = 'users' AND entity_id = ? ORDER BY id",
      [String(result.userId)],
    );
    const actions = audit.map((a) => a.action);
    assert.ok(actions.includes('CREATE'), 'trigger trg_users_ai');
    assert.ok(actions.includes('BOOTSTRAP_ADMIN'), 'evento explícito');
    for (const a of audit) {
      assert.doesNotMatch(JSON.stringify(a.new_values), /\$2b\$|Farmacia2026Segura/);
      assert.match(a.request_id, /^cli-admin-create-/);
    }
  }

  // Segundo intento (o primero si ya existe un admin real): debe rechazarse.
  await assert.rejects(
    createFirstAdmin({ ...data, email: 'qa.bootstrap2@pharmaplus.test' }),
    (e) => e.code === 'ADMIN_ALREADY_EXISTS',
  );
});
