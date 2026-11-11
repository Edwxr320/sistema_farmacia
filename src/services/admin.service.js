'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const adminRepository = require('../repositories/admin.repository');
const userRepository = require('../repositories/user.repository');
const roleRepository = require('../repositories/role.repository');
const customerRepository = require('../repositories/customer.repository');
const sessionRepository = require('../repositories/session.repository');
const auditRepository = require('../repositories/audit.repository');
const passwordService = require('./password.service');
const { visibleBranchIds } = require('./branch-access.service');

// =================================================================== clientes
const customerDto = (c) => ({
  id: c.id, fullName: c.full_name, documentType: c.document_type, documentNumber: c.document_number, phone: c.phone,
  email: c.email, birthDate: c.birth_date, isActive: Boolean(Number(c.is_active)), hasAccount: c.user_id !== null,
  purchases: c.purchases === undefined ? undefined : Number(c.purchases), orders: c.orders === undefined ? undefined : Number(c.orders),
  createdAt: c.created_at,
});

async function listCustomers(f, ctx) {
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await adminRepository.listCustomers(conn, f);
    return paginated(rows.map(customerDto), total, f);
  });
}

async function getCustomer(id, ctx) {
  return withConnection(ctx, async (conn) => {
    const c = await adminRepository.findCustomer(conn, id);
    if (!c) throw AppError.notFound('Cliente no encontrado');
    return customerDto(c);
  });
}

/** Cliente registrado en mostrador (sin cuenta web). customers no tiene trigger de auditoría. */
async function createCustomer(data, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    if (await customerRepository.documentTaken(conn, data.document_type, data.document_number)) {
      throw AppError.conflict('Ya existe un cliente con ese documento', 'DOCUMENT_TAKEN');
    }
    const id = await adminRepository.insertCustomer(conn, data, auth.userId);
    await auditRepository.log(conn, { action: 'CREATE', module: 'customers', table: 'customers', entityId: id, newValues: { full_name: data.full_name, document_number: data.document_number ?? null } });
    return customerDto(await adminRepository.findCustomer(conn, id));
  });
}

async function updateCustomer(id, data, ctx) {
  return withTransaction(ctx, async (conn) => {
    const c = await adminRepository.findCustomer(conn, id);
    if (!c) throw AppError.notFound('Cliente no encontrado');
    if (data.document_type && (await customerRepository.documentTaken(conn, data.document_type, data.document_number, id))) {
      throw AppError.conflict('Ya existe un cliente con ese documento', 'DOCUMENT_TAKEN');
    }
    if (c.user_id && data.email !== undefined && data.email !== c.email) {
      throw AppError.badRequest('El correo de un cliente con cuenta web lo gestiona el propio cliente');
    }
    await adminRepository.updateCustomer(conn, id, data);
    await auditRepository.log(conn, { action: 'UPDATE', module: 'customers', table: 'customers', entityId: id, newValues: data });
    return customerDto(await adminRepository.findCustomer(conn, id));
  });
}

// =============================================================== trabajadores
function userDto(u) {
  return {
    id: u.id, fullName: u.full_name, email: u.email, phone: u.phone, status: u.status,
    mustChangePassword: Boolean(Number(u.must_change_password)), lastLoginAt: u.last_login_at, lockedUntil: u.locked_until,
    createdAt: u.created_at, role: { id: u.role_id, code: u.role_code, name: u.role_name },
    branches: (u.branches || '').split(',').filter(Boolean).map((s) => {
      const [id, code, def] = s.split(':');
      return { id: Number(id), code, isDefault: def === '1' };
    }),
  };
}

async function listUsers(f, ctx) {
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await adminRepository.listUsers(conn, f);
    return paginated(rows.map(userDto), total, f);
  });
}

async function getUser(id, ctx) {
  return withConnection(ctx, (conn) => getUserInConn(conn, id));
}

async function assertStaffRole(conn, roleId) {
  const role = await adminRepository.findRole(conn, roleId);
  if (!role || !Number(role.is_active)) throw AppError.badRequest('Rol inválido o inactivo');
  if (role.code === 'CUSTOMER') throw AppError.badRequest('Las cuentas de clientes se crean desde la tienda virtual');
  return role;
}

async function assertBranches(conn, branchIds) {
  const [rows] = await conn.execute(`SELECT id FROM branches WHERE status = 'ACTIVE' AND id IN (${branchIds.map(() => '?').join(', ')})`, branchIds);
  if (rows.length !== branchIds.length) throw AppError.badRequest('Alguna sucursal no existe o está inactiva');
}

async function createUser(data, auth, ctx) {
  const hash = await passwordService.hashPassword(data.password);
  return withTransaction(ctx, async (conn) => {
    await assertStaffRole(conn, data.roleId);
    if (await userRepository.emailExists(conn, data.email)) throw AppError.conflict('Ya existe una cuenta con ese correo', 'EMAIL_TAKEN');
    await assertBranches(conn, data.branchIds);
    const id = await userRepository.insertUser(conn, { roleId: data.roleId, fullName: data.fullName, email: data.email, passwordHash: hash, phone: data.phone ?? null, mustChangePassword: true });
    await adminRepository.replaceUserBranches(conn, id, data.branchIds, data.defaultBranchId ?? data.branchIds[0], auth.userId);
    await auditRepository.log(conn, { action: 'ASSIGN_BRANCHES', module: 'users', table: 'user_branches', entityId: id, newValues: { branch_ids: data.branchIds } });
    return getUserInConn(conn, id);
  });
}

async function getUserInConn(conn, id) {
  const { rows } = await adminRepository.listUsers(conn, { userId: id, page: 1, pageSize: 1 });
  if (!rows[0]) throw AppError.notFound('Trabajador no encontrado');
  return { ...userDto(rows[0]), permissionOverrides: await adminRepository.userPermissionOverrides(conn, id) };
}

/** Edición: nombre, teléfono, rol, estado y sucursales. Protecciones: no autobloquearse ni dejar el sistema sin ADMIN. */
async function updateUser(id, data, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const u = await adminRepository.findUser(conn, id, { forUpdate: true });
    if (!u || u.role_code === 'CUSTOMER') throw AppError.notFound('Trabajador no encontrado');
    const cols = { full_name: data.fullName, phone: data.phone, role_id: data.roleId, status: data.status };
    if (data.roleId !== undefined) await assertStaffRole(conn, data.roleId);
    if (id === auth.userId && ((data.status && data.status !== 'ACTIVE') || (data.roleId && data.roleId !== u.role_id))) {
      throw AppError.conflict('No puede cambiar su propio rol ni bloquear su propia cuenta', 'SELF_CHANGE_FORBIDDEN');
    }
    const losesAdmin = u.role_code === 'ADMIN' && ((data.status && data.status !== 'ACTIVE') || (data.roleId && data.roleId !== u.role_id));
    if (losesAdmin && (await adminRepository.countActiveAdmins(conn, id)) === 0) {
      throw AppError.conflict('Debe quedar al menos un administrador activo', 'LAST_ADMIN');
    }
    await adminRepository.updateUser(conn, id, cols); // trg_users_au audita
    if (data.branchIds) {
      await assertBranches(conn, data.branchIds);
      await adminRepository.replaceUserBranches(conn, id, data.branchIds, data.defaultBranchId ?? data.branchIds[0], auth.userId);
      await auditRepository.log(conn, { action: 'ASSIGN_BRANCHES', module: 'users', table: 'user_branches', entityId: id, newValues: { branch_ids: data.branchIds } });
    }
    if (data.status && data.status !== 'ACTIVE') await sessionRepository.revokeAllForUser(conn, id, 'USER_DISABLED');
    return getUserInConn(conn, id);
  });
}

/** Restablece la contraseña (temporal): obliga a cambiarla y cierra todas sus sesiones. */
async function resetPassword(id, password, auth, ctx) {
  const hash = await passwordService.hashPassword(password);
  return withTransaction(ctx, async (conn) => {
    const u = await adminRepository.findUser(conn, id, { forUpdate: true });
    if (!u || u.role_code === 'CUSTOMER') throw AppError.notFound('Trabajador no encontrado');
    await adminRepository.setPassword(conn, id, hash);
    await sessionRepository.revokeAllForUser(conn, id, 'PASSWORD_CHANGED');
    await auditRepository.log(conn, { action: 'PASSWORD_RESET', module: 'users', table: 'users', entityId: id, newValues: { email: u.email } });
    return { reset: true };
  });
}

async function unlockUser(id, ctx) {
  return withTransaction(ctx, async (conn) => {
    if (!(await adminRepository.findUser(conn, id, { forUpdate: true }))) throw AppError.notFound('Trabajador no encontrado');
    await adminRepository.unlock(conn, id);
    await auditRepository.log(conn, { action: 'UNLOCK', module: 'users', table: 'users', entityId: id });
    return getUserInConn(conn, id);
  });
}

/** Permisos individuales GRANT/DENY (user_permissions; los triggers auditan). */
async function setUserOverrides(id, overrides, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const u = await adminRepository.findUser(conn, id, { forUpdate: true });
    if (!u || u.role_code === 'CUSTOMER') throw AppError.notFound('Trabajador no encontrado');
    if (id === auth.userId) throw AppError.conflict('No puede modificar sus propios permisos', 'SELF_CHANGE_FORBIDDEN');
    const ids = await adminRepository.permissionIdsByCode(conn, overrides.map((o) => o.code));
    const missing = overrides.filter((o) => !ids.has(o.code)).map((o) => o.code);
    if (missing.length) throw AppError.badRequest(`Permisos inexistentes: ${missing.join(', ')}`);
    await adminRepository.replaceUserOverrides(conn, id, overrides.map((o) => ({ permissionId: ids.get(o.code), effect: o.effect, reason: o.reason })), auth.userId);
    return getUserInConn(conn, id);
  });
}

// ======================================================================= roles
async function createRole(data, ctx) {
  return withTransaction(ctx, async (conn) => {
    const [dup] = await conn.execute('SELECT id FROM roles WHERE code = ?', [data.code]);
    if (dup.length) throw AppError.conflict('Ya existe un rol con ese código', 'ROLE_TAKEN');
    const id = await adminRepository.insertRole(conn, data);
    await auditRepository.log(conn, { action: 'CREATE', module: 'security', table: 'roles', entityId: id, newValues: data });
    return (await roleRepository.listWithPermissions(conn)).find((r) => r.id === id);
  });
}

/** Reemplaza los permisos de un rol. ADMIN y CUSTOMER son roles protegidos del sistema. */
async function setRolePermissions(id, codes, ctx) {
  return withTransaction(ctx, async (conn) => {
    const role = await adminRepository.findRole(conn, id);
    if (!role) throw AppError.notFound('Rol no encontrado');
    if (['ADMIN', 'CUSTOMER'].includes(role.code)) throw AppError.conflict(`Los permisos del rol ${role.code} están protegidos`, 'ROLE_PROTECTED');
    if (codes.some((c) => c.startsWith('store.'))) throw AppError.badRequest('Los permisos de la tienda son exclusivos de clientes');
    const ids = await adminRepository.permissionIdsByCode(conn, codes);
    const missing = codes.filter((c) => !ids.has(c));
    if (missing.length) throw AppError.badRequest(`Permisos inexistentes: ${missing.join(', ')}`);
    const diff = await adminRepository.syncRolePermissions(conn, id, [...ids.values()]);
    const updated = (await roleRepository.listWithPermissions(conn)).find((r) => r.id === id);
    return { ...updated, ...diff };
  });
}

// ================================================================== sucursales
const branchDto = (b) => ({
  id: b.id, code: b.code, name: b.name, addressLine: b.address_line, district: b.district, province: b.province,
  department: b.department, phone: b.phone, email: b.email, isMain: Boolean(Number(b.is_main)), status: b.status,
  openedOn: b.opened_on, users: Number(b.users ?? 0), registers: Number(b.registers ?? 0),
});

async function listBranches(auth, ctx) {
  return withConnection(ctx, async (conn) => (await adminRepository.listBranches(conn, visibleBranchIds(auth))).map(branchDto));
}

async function createBranch(data, ctx) {
  return withTransaction(ctx, async (conn) => {
    const [dup] = await conn.execute('SELECT id FROM branches WHERE code = ? OR name = ?', [data.code, data.name]);
    if (dup.length) throw AppError.conflict('Ya existe una sucursal con ese código o nombre', 'BRANCH_TAKEN');
    const id = await adminRepository.insertBranch(conn, data); // el trigger crea las secuencias y audita
    return branchDto((await adminRepository.listBranches(conn, [id]))[0]);
  });
}

async function updateBranch(id, data, ctx) {
  return withTransaction(ctx, async (conn) => {
    const [rows] = await conn.execute('SELECT id, is_main FROM branches WHERE id = ? FOR UPDATE', [id]);
    if (!rows[0]) throw AppError.notFound('Sucursal no encontrada');
    if (data.status === 'INACTIVE' && Number(rows[0].is_main)) throw AppError.conflict('La sucursal principal no puede desactivarse', 'MAIN_BRANCH');
    if (data.status === 'INACTIVE') {
      const [[open]] = await conn.execute("SELECT COUNT(*) c FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id WHERE cr.branch_id = ? AND cs.status = 'OPEN'", [id]);
      if (Number(open.c) > 0) throw AppError.conflict('La sucursal tiene cajas abiertas', 'OPEN_CASH');
    }
    await adminRepository.updateBranch(conn, id, data);
    await auditRepository.log(conn, { action: 'UPDATE', module: 'branches', table: 'branches', entityId: id, newValues: data });
    return branchDto((await adminRepository.listBranches(conn, [id]))[0]);
  });
}

async function createRegister(branchId, data, ctx) {
  return withTransaction(ctx, async (conn) => {
    const [b] = await conn.execute("SELECT id FROM branches WHERE id = ? AND status = 'ACTIVE'", [branchId]);
    if (!b.length) throw AppError.notFound('Sucursal no encontrada o inactiva');
    const [dup] = await conn.execute('SELECT id FROM cash_registers WHERE branch_id = ? AND code = ?', [branchId, data.code]);
    if (dup.length) throw AppError.conflict('Ya existe una caja con ese código en la sucursal', 'REGISTER_TAKEN');
    const id = await adminRepository.insertRegister(conn, { branchId, ...data });
    await auditRepository.log(conn, { action: 'CREATE', module: 'cash', table: 'cash_registers', entityId: id, newValues: { branch_id: branchId, ...data } });
    return { id, branchId, ...data, isActive: true };
  });
}

// ================================================================ configuración
/**
 * Parámetros que el backend utiliza. Algunos son de solo lectura desde el panel porque cambiarlos
 * rompería reglas del sistema (zona horaria, modo DEMO de pagos, método FEFO).
 */
const LOCKED = new Set(['app.timezone', 'app.utc_offset', 'payments.mode', 'inventory.method', 'app.currency']);
/** Claves opcionales que el backend lee si existen y que pueden crearse desde el panel. */
const OPTIONAL = {
  'orders.delivery_districts': { type: 'JSON', description: 'Distritos con cobertura de delivery (lista JSON). Si no existe, se exige la misma provincia que la sucursal.' },
};

function validateValue(type, value, key) {
  const v = String(value).trim();
  if (type === 'INTEGER' && !/^-?\d+$/.test(v)) throw AppError.badRequest('Debe ser un número entero');
  if (type === 'DECIMAL' && !/^\d+(\.\d{1,2})?$/.test(v)) throw AppError.badRequest('Debe ser un número con hasta 2 decimales');
  if (type === 'BOOLEAN' && !['true', 'false'].includes(v)) throw AppError.badRequest('Debe ser true o false');
  if (type === 'JSON') {
    let parsed;
    try { parsed = JSON.parse(v); } catch { throw AppError.badRequest('JSON inválido'); }
    if (key === 'orders.delivery_districts' && (!Array.isArray(parsed) || parsed.some((d) => typeof d !== 'string' || !d.trim()))) {
      throw AppError.badRequest('Debe ser una lista de nombres de distritos');
    }
  }
  if (key === 'sales.max_discount_percent' && Number(v) > 100) throw AppError.badRequest('Máximo 100');
  if ((key === 'security.max_failed_logins' || key === 'security.lockout_minutes') && Number(v) < 1) throw AppError.badRequest('Debe ser mayor que 0');
  if (key.startsWith('inventory.') && type === 'INTEGER' && Number(v) < 0) throw AppError.badRequest('No puede ser negativo');
  return v;
}

async function listSettings(ctx) {
  return withConnection(ctx, async (conn) => {
    const rows = await adminRepository.listSettings(conn);
    const existing = new Set(rows.map((r) => r.setting_key));
    return {
      settings: rows.map((r) => ({
        key: r.setting_key, value: r.setting_value, type: r.value_type, description: r.description,
        editable: Boolean(Number(r.is_editable)) && !LOCKED.has(r.setting_key), updatedAt: r.updated_at,
      })),
      optional: Object.entries(OPTIONAL).filter(([k]) => !existing.has(k)).map(([key, d]) => ({ key, type: d.type, description: d.description, configured: false })),
    };
  });
}

async function updateSetting(key, value, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const s = await adminRepository.findSetting(conn, key);
    if (!s) {
      if (!OPTIONAL[key]) throw AppError.notFound('Parámetro no encontrado');
      const v = validateValue(OPTIONAL[key].type, value, key);
      await adminRepository.insertSetting(conn, { key, value: v, type: OPTIONAL[key].type, description: OPTIONAL[key].description, userId: auth.userId });
      await auditRepository.log(conn, { action: 'CREATE', module: 'settings', table: 'settings', entityId: key, newValues: { setting_value: v } });
      return { key, value: v, type: OPTIONAL[key].type, created: true };
    }
    if (!Number(s.is_editable) || LOCKED.has(key)) throw AppError.conflict('Este parámetro no se modifica desde el panel', 'SETTING_LOCKED');
    const v = validateValue(s.value_type, value, key);
    await adminRepository.updateSetting(conn, key, v, auth.userId); // trg_settings_au audita
    return { key, value: v, type: s.value_type, created: false };
  });
}

module.exports = {
  listCustomers, getCustomer, createCustomer, updateCustomer, listUsers, getUser, createUser, updateUser, resetPassword, unlockUser,
  setUserOverrides, createRole, setRolePermissions, listBranches, createBranch, updateBranch, createRegister, listSettings, updateSetting,
};
