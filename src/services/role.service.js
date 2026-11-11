'use strict';

const { withConnection } = require('../config/database');
const roleRepository = require('../repositories/role.repository');

async function listRoles(dbContext) {
  return withConnection(dbContext, async (conn) => {
    const roles = await roleRepository.listWithPermissions(conn);
    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      isSystem: Boolean(r.is_system),
      isActive: Boolean(r.is_active),
      usersCount: r.users_count,
      permissions: r.permissions,
    }));
  });
}

async function listPermissions(dbContext) {
  return withConnection(dbContext, async (conn) => {
    const rows = await roleRepository.listPermissions(conn);
    return rows.map((p) => ({
      id: p.id,
      code: p.code,
      module: p.module,
      name: p.name,
      description: p.description,
      isActive: Boolean(p.is_active),
    }));
  });
}

module.exports = { listRoles, listPermissions };
