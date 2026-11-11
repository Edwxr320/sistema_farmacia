'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const supplierRepository = require('../repositories/supplier.repository');
const auditRepository = require('../repositories/audit.repository');
const { visibleBranchIds } = require('./branch-access.service');

function toDto(r) {
  return {
    id: r.id,
    businessName: r.business_name,
    tradeName: r.trade_name,
    ruc: r.ruc,
    contactName: r.contact_name,
    phone: r.phone,
    email: r.email,
    addressLine: r.address_line,
    district: r.district,
    province: r.province,
    department: r.department,
    status: r.status,
    notes: r.notes,
    entriesCount: Number(r.entries_count ?? 0),
    lastEntryAt: r.last_entry_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function list(filters, ctx) {
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await supplierRepository.list(conn, filters);
    return paginated(rows.map(toDto), total, filters);
  });
}

async function get(id, ctx) {
  return withConnection(ctx, async (conn) => {
    const row = await supplierRepository.findById(conn, id);
    if (!row) throw AppError.notFound('Proveedor no encontrado');
    return toDto(row);
  });
}

// suppliers no tiene triggers de auditoría: se audita explícitamente.
async function create(data, ctx) {
  return withTransaction(ctx, async (conn) => {
    if (await supplierRepository.rucTaken(conn, data.ruc)) throw AppError.conflict('Ya existe un proveedor con ese RUC', 'RUC_TAKEN');
    const id = await supplierRepository.insert(conn, data);
    await auditRepository.log(conn, { action: 'CREATE', module: 'suppliers', table: 'suppliers', entityId: id, newValues: data });
    return toDto(await supplierRepository.findById(conn, id));
  });
}

async function update(id, data, ctx) {
  return withTransaction(ctx, async (conn) => {
    const before = await supplierRepository.findById(conn, id, { forUpdate: true });
    if (!before) throw AppError.notFound('Proveedor no encontrado');
    if (data.ruc && (await supplierRepository.rucTaken(conn, data.ruc, id))) {
      throw AppError.conflict('Ya existe un proveedor con ese RUC', 'RUC_TAKEN');
    }
    await supplierRepository.update(conn, id, data);
    await auditRepository.log(conn, {
      action: 'UPDATE', module: 'suppliers', table: 'suppliers', entityId: id,
      oldValues: Object.fromEntries(Object.keys(data).map((k) => [k, before[k]])), newValues: data,
    });
    return toDto(await supplierRepository.findById(conn, id));
  });
}

async function setStatus(id, status, ctx) {
  return withTransaction(ctx, async (conn) => {
    const before = await supplierRepository.findById(conn, id, { forUpdate: true });
    if (!before) throw AppError.notFound('Proveedor no encontrado');
    await supplierRepository.update(conn, id, { status });
    await auditRepository.log(conn, {
      action: status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE', module: 'suppliers', table: 'suppliers', entityId: id,
      oldValues: { status: before.status }, newValues: { status },
    });
    return toDto(await supplierRepository.findById(conn, id));
  });
}

async function entries(id, filters, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    if (!(await supplierRepository.findById(conn, id))) throw AppError.notFound('Proveedor no encontrado');
    const { rows, total } = await supplierRepository.listEntries(conn, id, { ...filters, branchIds: visibleBranchIds(auth) });
    return paginated(rows.map((r) => ({ ...r, items_count: Number(r.items_count) })), total, filters);
  });
}

module.exports = { list, get, create, update, setStatus, entries };
