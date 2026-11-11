'use strict';

/**
 * Usuarios temporales para pruebas. Se crean dentro de la transacción de
 * prueba (ver transactional-db.js) y desaparecen con el ROLLBACK final.
 */

const crypto = require('node:crypto');
const { hashPassword } = require('../../src/services/password.service');
const userRepository = require('../../src/repositories/user.repository');
const roleRepository = require('../../src/repositories/role.repository');
const branchRepository = require('../../src/repositories/branch.repository');

async function createTestUser(conn, { roleCode, password, status = 'ACTIVE', withBranch = true }) {
  const role = await roleRepository.findActiveByCode(conn, roleCode);
  const email = `qa.${roleCode.toLowerCase()}.${crypto.randomBytes(5).toString('hex')}@pharmaplus.test`;
  const id = await userRepository.insertUser(conn, {
    roleId: role.id,
    fullName: `Prueba ${roleCode}`,
    email,
    passwordHash: await hashPassword(password),
  });
  if (status !== 'ACTIVE') await conn.execute('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  if (withBranch) {
    const main = await branchRepository.findMainBranch(conn);
    await branchRepository.assignUserBranch(conn, { userId: id, branchId: main.id, isDefault: true });
  }
  return { id, email, password };
}

module.exports = { createTestUser };
