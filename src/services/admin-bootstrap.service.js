'use strict';

/**
 * Registro del PRIMER administrador (npm run admin:create).
 *
 * - Usa el rol ADMIN existente y la Sucursal Principal existente.
 * - Se niega si ya existe cualquier usuario con rol ADMIN (de cualquier estado).
 * - Un bloqueo con nombre (GET_LOCK) evita que dos ejecuciones simultáneas
 *   creen dos administradores.
 * - La auditoría la generan el trigger trg_users_ai y un evento BOOTSTRAP_ADMIN
 *   explícito; ninguno contiene el hash.
 */

const crypto = require('node:crypto');
const { withConnection } = require('../config/database');
const { AppError } = require('../utils/app-error');
const userRepository = require('../repositories/user.repository');
const roleRepository = require('../repositories/role.repository');
const branchRepository = require('../repositories/branch.repository');
const auditRepository = require('../repositories/audit.repository');
const passwordService = require('./password.service');

const LOCK_NAME = 'pharma_plus.bootstrap_admin';

/**
 * @param {{fullName:string, email:string, password:string}} data (ya validados)
 * @param {{ connectionRunner?: Function }} [opts] para pruebas
 */
async function createFirstAdmin({ fullName, email, password }) {
  // El hash se calcula antes de abrir la transacción (bcrypt es lento).
  const passwordHash = await passwordService.hashPassword(password);
  const ctx = {
    userId: null,
    branchId: null,
    requestId: `cli-admin-create-${crypto.randomUUID()}`.slice(0, 64),
    ip: '127.0.0.1',
    userAgent: 'pharma-plus-cli/admin:create',
  };

  return withConnection(ctx, async (conn) => {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 10) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) {
      throw AppError.conflict('Otro proceso está creando el administrador. Intente nuevamente.', 'ADMIN_BOOTSTRAP_BUSY');
    }
    try {
      await conn.beginTransaction();
      try {
        const role = await roleRepository.findActiveByCode(conn, 'ADMIN');
        if (!role) throw new AppError(500, 'ADMIN_ROLE_MISSING', 'No existe el rol ADMIN activo en la base de datos');

        const admins = await userRepository.countByRoleCode(conn, 'ADMIN');
        if (admins > 0) {
          throw AppError.conflict(
            'Ya existe un administrador registrado. Este procedimiento solo crea el primero.',
            'ADMIN_ALREADY_EXISTS',
          );
        }
        if (await userRepository.emailExists(conn, email)) {
          throw AppError.conflict('Ya existe un usuario con ese correo', 'EMAIL_TAKEN');
        }

        const branch = await branchRepository.findMainBranch(conn);
        if (!branch) throw new AppError(500, 'MAIN_BRANCH_MISSING', 'No existe una Sucursal Principal activa');

        const userId = await userRepository.insertUser(conn, {
          roleId: role.id,
          fullName,
          email,
          passwordHash,
          // La contraseña la elige el propio administrador en este momento.
          mustChangePassword: false,
        });
        await branchRepository.assignUserBranch(conn, { userId, branchId: branch.id, isDefault: true });
        await auditRepository.log(conn, {
          action: 'BOOTSTRAP_ADMIN',
          module: 'security',
          table: 'users',
          entityId: userId,
          newValues: { email, full_name: fullName, role: role.code, branch_id: branch.id, source: 'cli' },
        });

        await conn.commit();
        return { userId, email, fullName, role: role.code, branch: { id: branch.id, code: branch.code, name: branch.name } };
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      }
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    }
  });
}

module.exports = { createFirstAdmin };
