'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/authenticate');
const { requirePermission, requireAnyPermission } = require('../middlewares/authorize');
const { validate } = require('../middlewares/validate');
const { withConnection } = require('../config/database');
const { z, id, idParam, optionalText, isoDate, boolish, pagination, searchTerm } = require('../validators/common.validator');
const { emailField, fullNameField, strongPassword } = require('../validators/auth.validator');
const admin = require('../services/admin.service');
const adminRepository = require('../repositories/admin.repository');
const roleService = require('../services/role.service');

const params = validate(idParam, 'params');
const data = (fn) => async (req, res) => res.json({ data: await fn(req) });
const created = (fn) => async (req, res) => res.status(201).json({ data: await fn(req) });
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const v = (req) => req.validated;

// ------------------------------------------------------------------ clientes
const customerFields = {
  fullName: fullNameField,
  documentType: z.union([z.enum(['DNI', 'CE', 'PASSPORT', 'RUC', 'OTHER']), z.null()]).optional(),
  documentNumber: optionalText(30),
  phone: optionalText(30),
  email: z.union([emailField, z.null()]).optional(),
  birthDate: z.union([isoDate, z.null()]).optional(),
  isActive: z.boolean().optional(),
};
const toCustomerCols = (d) => compact({
  full_name: d.fullName, document_type: d.documentType, document_number: d.documentNumber, phone: d.phone, email: d.email,
  birth_date: d.birthDate, is_active: d.isActive === undefined ? undefined : d.isActive ? 1 : 0,
});
const docPair = (d, ctx) => {
  if ((d.documentType != null) !== (d.documentNumber != null) && (d.documentType !== undefined || d.documentNumber !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'Indique tipo y número de documento, o ninguno' });
  }
  if (d.documentType === 'DNI' && d.documentNumber && !/^\d{8}$/.test(d.documentNumber)) ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'El DNI debe tener 8 dígitos' });
  if (d.documentType === 'RUC' && d.documentNumber && !/^[12]\d{10}$/.test(d.documentNumber)) ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'RUC inválido' });
};

const customersRouter = Router();
customersRouter.use(authenticate);
customersRouter.get('/', requirePermission('customers.view'), validate(z.object({
  q: searchTerm, isActive: boolish.optional(), hasAccount: boolish.optional(), ...pagination,
}), 'query'), async (req, res) => res.json(await admin.listCustomers(v(req).query, req.dbContext)));
customersRouter.get('/:id', requirePermission('customers.view'), params, data((req) => admin.getCustomer(v(req).params.id, req.dbContext)));
customersRouter.post('/', requirePermission('customers.manage'), validate(z.object(customerFields).strict().superRefine(docPair).transform(toCustomerCols)),
  created((req) => admin.createCustomer(v(req).body, req.auth, req.dbContext)));
customersRouter.put('/:id', requirePermission('customers.manage'), params,
  validate(z.object(Object.fromEntries(Object.entries(customerFields).map(([k, s]) => [k, s.optional()]))).strict().superRefine(docPair).transform(toCustomerCols)),
  data((req) => admin.updateCustomer(v(req).params.id, v(req).body, req.dbContext)));

// --------------------------------------------------------------- trabajadores
const usersRouter = Router();
usersRouter.use(authenticate);
const branchesField = z.array(id).min(1, 'Asigne al menos una sucursal').max(50);
usersRouter.get('/', requirePermission('users.view'), validate(z.object({
  q: searchTerm, status: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(), roleId: id.optional(), branchId: id.optional(), ...pagination,
}), 'query'), async (req, res) => res.json(await admin.listUsers(v(req).query, req.dbContext)));
usersRouter.get('/:id', requirePermission('users.view'), params, data((req) => admin.getUser(v(req).params.id, req.dbContext)));
usersRouter.post('/', requirePermission('users.manage'), validate(z.object({
  fullName: fullNameField, email: emailField, password: strongPassword, phone: optionalText(30), roleId: id,
  branchIds: branchesField, defaultBranchId: id.optional(),
}).strict().refine((d) => !d.defaultBranchId || d.branchIds.includes(d.defaultBranchId), { path: ['defaultBranchId'], message: 'La sucursal predeterminada debe estar asignada' })),
created((req) => admin.createUser(v(req).body, req.auth, req.dbContext)));
usersRouter.put('/:id', requirePermission('users.manage'), params, validate(z.object({
  fullName: fullNameField.optional(), phone: optionalText(30), roleId: id.optional(), status: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
  branchIds: branchesField.optional(), defaultBranchId: id.optional(),
}).strict().refine((d) => !d.defaultBranchId || (d.branchIds && d.branchIds.includes(d.defaultBranchId)), { path: ['defaultBranchId'], message: 'Indique la sucursal predeterminada dentro de las asignadas' })),
data((req) => admin.updateUser(v(req).params.id, v(req).body, req.auth, req.dbContext)));
usersRouter.post('/:id/reset-password', requirePermission('users.manage'), params, validate(z.object({ password: strongPassword }).strict()),
  data((req) => admin.resetPassword(v(req).params.id, v(req).body.password, req.auth, req.dbContext)));
usersRouter.post('/:id/unlock', requirePermission('users.manage'), params, data((req) => admin.unlockUser(v(req).params.id, req.dbContext)));
usersRouter.put('/:id/permissions', requirePermission('roles.manage'), params, validate(z.object({
  overrides: z.array(z.object({ code: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/), effect: z.enum(['GRANT', 'DENY']), reason: optionalText(255) }).strict()).max(100),
}).strict()), data((req) => admin.setUserOverrides(v(req).params.id, v(req).body.overrides, req.auth, req.dbContext)));

// ---------------------------------------------------------------------- roles
const rolesAdminRouter = Router();
rolesAdminRouter.use(authenticate, requirePermission('roles.manage'));
rolesAdminRouter.get('/', data((req) => roleService.listRoles(req.dbContext)));
rolesAdminRouter.get('/permissions', data((req) => roleService.listPermissions(req.dbContext)));
rolesAdminRouter.post('/', validate(z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Código en mayúsculas (A-Z, 0-9, _)'), name: z.string().trim().min(3).max(100), description: optionalText(255),
}).strict()), created((req) => admin.createRole(v(req).body, req.dbContext)));
rolesAdminRouter.put('/:id/permissions', params, validate(z.object({ permissions: z.array(z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/)).max(200) }).strict()),
  data((req) => admin.setRolePermissions(v(req).params.id, [...new Set(v(req).body.permissions)], req.dbContext)));

// ------------------------------------------------------------------ sucursales
const branchFields = {
  name: z.string().trim().min(3).max(120), addressLine: optionalText(255), district: optionalText(100), province: optionalText(100),
  department: optionalText(100), phone: optionalText(30), email: z.union([emailField, z.null()]).optional(), openedOn: z.union([isoDate, z.null()]).optional(),
};
const toBranchCols = (d) => compact({
  code: d.code, name: d.name, address_line: d.addressLine, district: d.district, province: d.province, department: d.department,
  phone: d.phone, email: d.email, opened_on: d.openedOn, status: d.status,
});
const branchesRouter = Router();
branchesRouter.use(authenticate);
branchesRouter.get('/', data((req) => admin.listBranches(req.auth, req.dbContext)));
branchesRouter.post('/', requirePermission('branches.manage'), validate(z.object({
  code: z.string().trim().regex(/^[A-Z0-9]{2,20}$/, 'Código de 2 a 20 caracteres (A-Z, 0-9)'), ...branchFields,
}).strict().transform(toBranchCols)), created((req) => admin.createBranch(v(req).body, req.dbContext)));
branchesRouter.put('/:id', requirePermission('branches.manage'), params, validate(z.object({
  ...Object.fromEntries(Object.entries(branchFields).map(([k, s]) => [k, s.optional()])), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
}).strict().transform(toBranchCols)), data((req) => admin.updateBranch(v(req).params.id, v(req).body, req.dbContext)));
branchesRouter.post('/:id/registers', requirePermission('branches.manage'), params, validate(z.object({
  code: z.string().trim().regex(/^[A-Z0-9_-]{2,20}$/), name: z.string().trim().min(3).max(80),
}).strict()), created((req) => admin.createRegister(v(req).params.id, v(req).body, req.dbContext)));

// --------------------------------------------------------------- configuración
const settingsRouter = Router();
/** Datos públicos para los portales (marca, moneda, delivery). Sin datos sensibles. */
settingsRouter.get('/public', async (req, res) => {
  const rows = await withConnection(req.dbContext, (conn) => adminRepository.listSettings(conn));
  const get = (k) => rows.find((r) => r.setting_key === k)?.setting_value ?? null;
  let districts = null;
  try { districts = get('orders.delivery_districts') ? JSON.parse(get('orders.delivery_districts')) : null; } catch { districts = null; }
  res.set('Cache-Control', 'no-store').json({
    data: {
      businessName: get('business.name'), currencySymbol: get('app.currency_symbol'), currency: get('app.currency'),
      deliveryFee: get('orders.default_delivery_fee'), deliveryDistricts: districts, paymentsMode: get('payments.mode'),
      requirePrescriptionReference: get('sales.require_prescription_reference') === 'true', ticketLegend: get('tickets.legend'),
    },
  });
});
settingsRouter.get('/', authenticate, requirePermission('settings.manage'), data((req) => admin.listSettings(req.dbContext)));
settingsRouter.put('/:key', authenticate, requirePermission('settings.manage'),
  validate(z.object({ key: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/).max(80) }), 'params'),
  validate(z.object({ value: z.union([z.string().max(1000), z.number(), z.boolean(), z.array(z.string().max(100)).max(200)]) }).strict()),
  data((req) => {
    const raw = v(req).body.value;
    const value = Array.isArray(raw) ? JSON.stringify(raw.map((s) => s.trim()).filter(Boolean)) : String(raw);
    return admin.updateSetting(v(req).params.key, value, req.auth, req.dbContext);
  }));

module.exports = { customersRouter, usersRouter, rolesAdminRouter, branchesRouter, settingsRouter, requireAnyPermission };
