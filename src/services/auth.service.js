'use strict';

const { withConnection, withTransaction, applyContext } = require('../config/database');
const { config } = require('../config/env');
const { AppError } = require('../utils/app-error');
const userRepository = require('../repositories/user.repository');
const permissionRepository = require('../repositories/permission.repository');
const branchRepository = require('../repositories/branch.repository');
const settingsRepository = require('../repositories/settings.repository');
const sessionRepository = require('../repositories/session.repository');
const auditRepository = require('../repositories/audit.repository');
const passwordService = require('./password.service');
const tokenService = require('./token.service');

const POLICY_KEYS = ['security.max_failed_logins', 'security.lockout_minutes'];

function toBool(v) {
  return v === true || v === 1 || v === '1';
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Política de bloqueo: settings de la base; si faltan, variables de entorno. */
async function getLockoutPolicy(conn) {
  const values = await settingsRepository.getValues(conn, POLICY_KEYS);
  return {
    maxAttempts: positiveInt(values['security.max_failed_logins'], config.auth.maxFailedAttempts),
    lockoutMinutes: positiveInt(values['security.lockout_minutes'], config.auth.lockoutMinutes),
    source: {
      maxAttempts: values['security.max_failed_logins'] !== undefined ? 'settings' : 'env',
      lockoutMinutes: values['security.lockout_minutes'] !== undefined ? 'settings' : 'env',
    },
  };
}

function toPublicUser(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    mustChangePassword: toBool(row.must_change_password),
    lastLoginAt: row.last_login_at,
    role: { id: row.role_id, code: row.role_code, name: row.role_name },
  };
}

function toBranch(b) {
  return { id: b.id, code: b.code, name: b.name, isMain: toBool(b.is_main), isDefault: toBool(b.is_default) };
}

/** Crea la sesión persistente y deja la conexión operando como el usuario. */
async function openSession(conn, { userId, branchId }, reqCtx) {
  const session = tokenService.issueSessionToken({ userId, branchId });
  await applyContext(conn, { ...reqCtx, userId, branchId, sessionRef: session.jti });
  await sessionRepository.insert(conn, {
    sessionHash: session.sessionHash,
    userId,
    branchId,
    ttlMinutes: session.ttlMinutes,
    ip: reqCtx.ip ? String(reqCtx.ip).slice(0, 45) : null,
    userAgent: reqCtx.userAgent ? String(reqCtx.userAgent).slice(0, 255) : null,
  });
  return session;
}

/**
 * Inicia sesión en UNA conexión y UNA transacción, con la fila del usuario
 * bloqueada (FOR UPDATE) para contar bien los intentos simultáneos.
 * Los rechazos se devuelven como resultado (no se lanzan dentro de la
 * transacción) para que el contador de intentos y la auditoría se confirmen.
 */
/**
 * @param {{ portal?: 'staff'|'store'|'any' }} [opts] portal de acceso: en 'staff' y 'store' los clientes
 *   (rol CUSTOMER) solo inician sesión en la tienda y los trabajadores solo en el panel. 'any' es el acceso
 *   único (/api/auth/access): el tipo de cuenta lo determina el rol guardado en la base, nunca el navegador.
 */
async function login({ email, password }, reqCtx, { portal = 'staff' } = {}) {
  const anonymousCtx = { ...reqCtx, userId: null, branchId: null, sessionRef: null };

  const outcome = await withTransaction(anonymousCtx, async (conn) => {
    const user = await userRepository.findForLogin(conn, email, { forUpdate: true });

    if (!user) {
      await passwordService.consumeDummyVerification(password);
      await auditRepository.log(conn, {
        action: 'LOGIN_FAILED', module: 'auth', table: 'users',
        newValues: { email, reason: 'UNKNOWN_EMAIL' },
      });
      return { error: 'INVALID' };
    }

    if (toBool(user.is_locked)) {
      await auditRepository.log(conn, {
        action: 'LOGIN_REJECTED', module: 'auth', table: 'users', entityId: user.id,
        newValues: { email: user.email, reason: 'LOCKED' },
      });
      return { error: 'LOCKED', lockedUntil: user.locked_until };
    }

    const passwordOk = await passwordService.verifyPassword(password, user.password_hash);

    if (!passwordOk) {
      let state = null;
      if (user.status === 'ACTIVE') {
        const policy = await getLockoutPolicy(conn);
        state = await userRepository.registerFailedLogin(conn, user.id, policy.maxAttempts, policy.lockoutMinutes);
      }
      await auditRepository.log(conn, {
        action: 'LOGIN_FAILED', module: 'auth', table: 'users', entityId: user.id,
        newValues: {
          email: user.email,
          reason: 'BAD_PASSWORD',
          failed_attempts: state ? state.failed_login_attempts : null,
          locked: state ? toBool(state.is_locked) : false,
        },
      });
      if (state && toBool(state.is_locked)) return { error: 'LOCKED', lockedUntil: state.locked_until };
      return { error: 'INVALID' };
    }

    // Contraseña correcta: recién ahora se revela el estado de la cuenta.
    let statusError = null;
    if (user.status === 'BLOCKED') statusError = 'BLOCKED';
    else if (user.status !== 'ACTIVE') statusError = 'INACTIVE';
    else if (!toBool(user.role_is_active)) statusError = 'ROLE_INACTIVE';
    else if (portal !== 'any' && (portal === 'store') !== (user.role_code === 'CUSTOMER')) statusError = 'WRONG_PORTAL';

    if (statusError) {
      await auditRepository.log(conn, {
        action: 'LOGIN_REJECTED', module: 'auth', table: 'users', entityId: user.id,
        newValues: { email: user.email, reason: statusError },
      });
      return { error: statusError };
    }

    const branches = await branchRepository.findUserBranches(conn, user.id);
    const branchId = branches.length > 0 ? branches[0].id : null;
    const session = await openSession(conn, { userId: user.id, branchId }, reqCtx);

    await userRepository.registerSuccessfulLogin(conn, user.id);
    await auditRepository.log(conn, {
      action: 'LOGIN', module: 'auth', table: 'users', entityId: user.id,
      newValues: { email: user.email, branch_id: branchId },
    });

    const permissions = await permissionRepository.findEffectiveByUserId(conn, user.id);
    const fresh = await userRepository.findById(conn, user.id);

    return {
      session,
      user: toPublicUser(fresh),
      branches: branches.map(toBranch),
      activeBranchId: branchId,
      permissions: permissions.map((p) => p.permission_code),
    };
  });

  if (outcome.error) {
    switch (outcome.error) {
      case 'LOCKED':
        throw new AppError(423, 'AUTH_LOCKED', 'Cuenta bloqueada temporalmente por intentos fallidos. Intente más tarde.', {
          lockedUntil: outcome.lockedUntil,
        });
      case 'BLOCKED':
        throw new AppError(403, 'AUTH_USER_BLOCKED', 'La cuenta está bloqueada. Contacte al administrador.');
      case 'INACTIVE':
        throw new AppError(403, 'AUTH_USER_INACTIVE', 'La cuenta está inactiva. Contacte al administrador.');
      case 'ROLE_INACTIVE':
        throw new AppError(403, 'AUTH_ROLE_INACTIVE', 'El rol asignado a la cuenta está inactivo.');
      case 'WRONG_PORTAL':
        throw new AppError(403, 'AUTH_WRONG_PORTAL', portal === 'store'
          ? 'Las cuentas de trabajadores ingresan por el panel administrativo.'
          : 'Las cuentas de clientes ingresan por la tienda virtual.');
      default:
        throw new AppError(401, 'AUTH_INVALID_CREDENTIALS', 'Correo o contraseña incorrectos');
    }
  }
  return outcome;
}

/**
 * Valida la sesión contra user_sessions y carga el estado actual del usuario.
 * Devuelve null si la sesión fue revocada, expiró o el usuario ya no puede operar.
 */
async function loadSession(claims, reqCtx) {
  const ctx = { ...reqCtx, userId: claims.userId, branchId: claims.branchId, sessionRef: claims.jti };
  return withConnection(ctx, async (conn) => {
    const stored = await sessionRepository.findActive(conn, claims.sessionHash);
    if (!stored || stored.user_id !== claims.userId) return null;

    const user = await userRepository.findById(conn, claims.userId);
    if (!user || user.status !== 'ACTIVE' || !toBool(user.role_is_active)) {
      await sessionRepository.revoke(conn, claims.sessionHash, 'USER_DISABLED');
      return null;
    }

    // Defensa adicional: un cambio de contraseña posterior a la emisión invalida el token.
    if (user.password_changed_at) {
      const changedAt = Math.floor(new Date(user.password_changed_at).getTime() / 1000);
      if (Number.isFinite(changedAt) && claims.iat < changedAt) {
        await sessionRepository.revoke(conn, claims.sessionHash, 'PASSWORD_CHANGED');
        return null;
      }
    }

    const branches = await branchRepository.findUserBranches(conn, user.id);
    if (claims.branchId !== null && !branches.some((b) => b.id === claims.branchId)) return null;

    await sessionRepository.touch(conn, stored.id);
    const permissions = await permissionRepository.findEffectiveByUserId(conn, user.id);
    return {
      user: toPublicUser(user),
      branches: branches.map(toBranch),
      activeBranchId: claims.branchId,
      permissions: permissions.map((p) => p.permission_code),
    };
  });
}

/** Cierra la sesión: la revoca en user_sessions y lo registra en auditoría. */
async function logout(auth, reqCtx) {
  await withTransaction({ ...reqCtx, userId: auth.userId, branchId: auth.branchId, sessionRef: auth.jti }, async (conn) => {
    await sessionRepository.revoke(conn, auth.sessionHash, 'LOGOUT');
    await auditRepository.log(conn, {
      action: 'LOGOUT', module: 'auth', table: 'users', entityId: auth.userId,
      newValues: { email: auth.user.email },
    });
  });
}

/**
 * Cambio de contraseña del usuario autenticado.
 * - Verifica la contraseña actual (un fallo cuenta como intento fallido y puede bloquear).
 * - Guarda el nuevo hash, must_change_password = FALSE, password_changed_at = NOW().
 * - Revoca TODAS las sesiones del usuario y abre una nueva para este cliente.
 * - Auditoría: trigger trg_users_au (password_changed = true) + evento PASSWORD_CHANGE.
 */
async function changePassword(auth, { currentPassword, newPassword }, reqCtx) {
  // El hash nuevo se calcula fuera de la transacción (bcrypt es lento).
  const newHash = await passwordService.hashPassword(newPassword);
  const ctx = { ...reqCtx, userId: auth.userId, branchId: auth.branchId, sessionRef: auth.jti };

  const outcome = await withTransaction(ctx, async (conn) => {
    const row = await userRepository.findPasswordHashForUpdate(conn, auth.userId);
    if (!row || row.status !== 'ACTIVE') return { error: 'UNAVAILABLE' };

    const currentOk = await passwordService.verifyPassword(currentPassword, row.password_hash);
    if (!currentOk) {
      const policy = await getLockoutPolicy(conn);
      const state = await userRepository.registerFailedLogin(conn, auth.userId, policy.maxAttempts, policy.lockoutMinutes);
      await auditRepository.log(conn, {
        action: 'PASSWORD_CHANGE_FAILED', module: 'auth', table: 'users', entityId: auth.userId,
        newValues: { email: row.email, reason: 'BAD_CURRENT_PASSWORD', failed_attempts: state.failed_login_attempts },
      });
      return { error: 'BAD_CURRENT' };
    }

    if (await passwordService.verifyPassword(newPassword, row.password_hash)) {
      return { error: 'SAME_PASSWORD' };
    }

    await userRepository.updatePassword(conn, auth.userId, newHash);
    const revoked = await sessionRepository.revokeAllForUser(conn, auth.userId, 'PASSWORD_CHANGED');
    const session = await openSession(conn, { userId: auth.userId, branchId: auth.branchId }, reqCtx);
    await auditRepository.log(conn, {
      action: 'PASSWORD_CHANGE', module: 'auth', table: 'users', entityId: auth.userId,
      newValues: { email: row.email, sessions_revoked: revoked },
    });
    return { session, revokedSessions: revoked };
  });

  if (outcome.error === 'BAD_CURRENT') {
    throw new AppError(400, 'AUTH_INVALID_CURRENT_PASSWORD', 'La contraseña actual no es correcta');
  }
  if (outcome.error === 'SAME_PASSWORD') {
    throw new AppError(400, 'AUTH_PASSWORD_REUSED', 'La nueva contraseña debe ser distinta de la actual');
  }
  if (outcome.error) throw AppError.unauthorized();
  return outcome;
}

module.exports = { login, loadSession, logout, changePassword, getLockoutPolicy };
