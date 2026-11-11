'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const customerRepository = require('../repositories/customer.repository');
const userRepository = require('../repositories/user.repository');
const roleRepository = require('../repositories/role.repository');
const auditRepository = require('../repositories/audit.repository');
const passwordService = require('./password.service');

function profileDto(c, user) {
  return {
    customerId: c.id,
    userId: c.user_id,
    fullName: c.full_name,
    email: c.email,
    phone: c.phone,
    documentType: c.document_type,
    documentNumber: c.document_number,
    birthDate: c.birth_date,
    memberSince: c.created_at,
    ...(user ? { mustChangePassword: user.mustChangePassword } : {}),
  };
}

const addressDto = (a) => ({
  id: a.id,
  label: a.label,
  recipientName: a.recipient_name,
  phone: a.phone,
  addressLine: a.address_line,
  referenceNote: a.reference_note,
  district: a.district,
  province: a.province,
  department: a.department,
  latitude: a.latitude,
  longitude: a.longitude,
  isDefault: Boolean(Number(a.is_default)),
});

/**
 * Registro de cliente: usuario con rol CUSTOMER (contraseña bcrypt) + ficha en customers,
 * en una transacción. Sin sucursal asignada: los clientes no operan el panel.
 */
async function register(data, ctx) {
  const passwordHash = await passwordService.hashPassword(data.password);
  return withTransaction({ ...ctx, userId: null, branchId: null }, async (conn) => {
    const role = await roleRepository.findActiveByCode(conn, 'CUSTOMER');
    if (!role) throw new AppError(500, 'CUSTOMER_ROLE_MISSING', 'No existe el rol de clientes');
    if (await userRepository.emailExists(conn, data.email)) throw AppError.conflict('Ya existe una cuenta con ese correo', 'EMAIL_TAKEN');
    if (await customerRepository.documentTaken(conn, data.documentType, data.documentNumber)) {
      throw AppError.conflict('Ya existe un cliente con ese documento', 'DOCUMENT_TAKEN');
    }
    const userId = await userRepository.insertUser(conn, {
      roleId: role.id, fullName: data.fullName, email: data.email, passwordHash, phone: data.phone ?? null,
    });
    const customerId = await customerRepository.insertCustomer(conn, {
      userId, fullName: data.fullName, email: data.email, phone: data.phone, documentType: data.documentType, documentNumber: data.documentNumber,
    });
    await auditRepository.log(conn, {
      action: 'REGISTER', module: 'store', table: 'customers', entityId: customerId, newValues: { user_id: userId, email: data.email },
    });
    return profileDto(await customerRepository.findByUserId(conn, userId));
  });
}

/** Ficha de cliente de la sesión actual (solo cuentas CUSTOMER con ficha activa). */
async function requireCustomer(conn, auth) {
  const c = await customerRepository.findByUserId(conn, auth.userId);
  if (!c || !Number(c.is_active)) throw AppError.forbidden('La cuenta no tiene una ficha de cliente activa', 'CUSTOMER_REQUIRED');
  return c;
}

async function me(auth, ctx) {
  return withConnection(ctx, async (conn) => profileDto(await requireCustomer(conn, auth), auth.user));
}

async function updateProfile(auth, data, ctx) {
  return withTransaction(ctx, async (conn) => {
    const c = await requireCustomer(conn, auth);
    const cols = {
      full_name: data.fullName, phone: data.phone, birth_date: data.birthDate,
      document_type: data.documentType, document_number: data.documentNumber,
    };
    if (data.documentType && (await customerRepository.documentTaken(conn, data.documentType, data.documentNumber, c.id))) {
      throw AppError.conflict('Ya existe un cliente con ese documento', 'DOCUMENT_TAKEN');
    }
    await customerRepository.updateProfile(conn, c.id, cols);
    if (data.fullName !== undefined || data.phone !== undefined) {
      // Mantiene coherente la cuenta de usuario (el trigger de users audita el cambio de nombre).
      await conn.execute('UPDATE users SET full_name = COALESCE(?, full_name), phone = COALESCE(?, phone) WHERE id = ?', [
        data.fullName ?? null, data.phone ?? null, auth.userId,
      ]);
    }
    await auditRepository.log(conn, {
      action: 'UPDATE', module: 'store', table: 'customers', entityId: c.id,
      newValues: Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== undefined)),
    });
    return profileDto(await customerRepository.findByUserId(conn, auth.userId));
  });
}

async function listAddresses(auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const c = await requireCustomer(conn, auth);
    return (await customerRepository.listAddresses(conn, c.id)).map(addressDto);
  });
}

async function createAddress(auth, data, ctx) {
  return withTransaction(ctx, async (conn) => {
    const c = await requireCustomer(conn, auth);
    const existing = await customerRepository.listAddresses(conn, c.id);
    if (existing.length >= 10) throw AppError.conflict('Máximo 10 direcciones por cliente', 'ADDRESS_LIMIT');
    const makeDefault = data.is_default || existing.length === 0;
    if (makeDefault) await customerRepository.clearDefault(conn, c.id);
    const id = await customerRepository.insertAddress(conn, c.id, { ...data, is_default: makeDefault });
    return addressDto(await customerRepository.findAddress(conn, c.id, id));
  });
}

async function updateAddress(auth, id, data, ctx) {
  return withTransaction(ctx, async (conn) => {
    const c = await requireCustomer(conn, auth);
    if (!(await customerRepository.findAddress(conn, c.id, id, { forUpdate: true }))) throw AppError.notFound('Dirección no encontrada');
    if (data.is_default) await customerRepository.clearDefault(conn, c.id);
    await customerRepository.updateAddress(conn, id, data);
    return addressDto(await customerRepository.findAddress(conn, c.id, id));
  });
}

async function deleteAddress(auth, id, ctx) {
  return withTransaction(ctx, async (conn) => {
    const c = await requireCustomer(conn, auth);
    if (!(await customerRepository.findAddress(conn, c.id, id, { forUpdate: true }))) throw AppError.notFound('Dirección no encontrada');
    await customerRepository.deactivateAddress(conn, id);
  });
}

module.exports = { register, requireCustomer, me, updateProfile, listAddresses, createAddress, updateAddress, deleteAddress, addressDto };
