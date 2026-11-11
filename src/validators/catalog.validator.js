'use strict';

const {
  z, id, optionalText, requiredText, money, boolish, pagination, searchTerm, isValidRuc,
} = require('./common.validator');

/** Quita las claves undefined (para UPDATE parciales). */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const notEmpty = (o) => Object.keys(o).length > 0;

// ---------------------------------------------------------------- categorías
const categoryCreate = z
  .object({
    name: requiredText(100, 'El nombre'),
    description: optionalText(255),
  })
  .strict()
  .transform(compact);

const categoryUpdate = z
  .object({ name: requiredText(100, 'El nombre').optional(), description: optionalText(255) })
  .strict()
  .transform(compact)
  .refine(notEmpty, 'No hay cambios');

// -------------------------------------------------------------- laboratorios
const laboratoryCreate = z
  .object({ name: requiredText(150, 'El nombre'), country: optionalText(80) })
  .strict()
  .transform(compact);

const laboratoryUpdate = z
  .object({ name: requiredText(150, 'El nombre').optional(), country: optionalText(80) })
  .strict()
  .transform(compact)
  .refine(notEmpty, 'No hay cambios');

const catalogListQuery = z.object({ q: searchTerm, isActive: boolish.optional(), ...pagination });

const activeBody = z.object({ isActive: z.boolean({ error: 'isActive debe ser true o false' }) }).strict();

// ----------------------------------------------------------------- productos
const sku = z.string().trim().min(2, 'SKU inválido').max(60).regex(/^[A-Za-z0-9._-]+$/, 'El SKU solo admite letras, números, punto, guion y guion bajo');
const barcode = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim()))
  .refine((v) => v === undefined || v === null || /^[0-9A-Za-z-]{4,80}$/.test(v), 'Código de barras inválido');

const productFields = {
  sku,
  barcode,
  name: requiredText(180, 'El nombre'),
  description: optionalText(5000),
  categoryId: id,
  laboratoryId: z.union([id, z.null()]).optional(),
  activeIngredient: optionalText(255),
  concentration: optionalText(100),
  dosageForm: optionalText(80),
  presentation: optionalText(150),
  sanitaryRegistration: optionalText(50),
  unit: z.string().trim().min(1).max(30).optional(),
  purchasePrice: money(8).optional(),
  salePrice: money(8),
  requiresPrescription: z.boolean().optional(),
};

/** camelCase de la API → columnas de products. */
function toProductColumns(d) {
  return compact({
    sku: d.sku,
    barcode: d.barcode,
    name: d.name,
    description: d.description,
    category_id: d.categoryId,
    laboratory_id: d.laboratoryId,
    active_ingredient: d.activeIngredient,
    concentration: d.concentration,
    dosage_form: d.dosageForm,
    presentation: d.presentation,
    sanitary_registration: d.sanitaryRegistration,
    unit: d.unit,
    purchase_price: d.purchasePrice,
    sale_price: d.salePrice,
    requires_prescription: d.requiresPrescription === undefined ? undefined : d.requiresPrescription ? 1 : 0,
  });
}

const branchConfigFields = {
  minimumStock: z.coerce.number().int().min(0).max(4294967295).optional(),
  maximumStock: z.union([z.coerce.number().int().min(0).max(4294967295), z.null()]).optional(),
};

const productCreate = z
  .object({ ...productFields, ...branchConfigFields })
  .strict()
  .refine((d) => d.maximumStock == null || d.minimumStock === undefined || d.maximumStock >= d.minimumStock, {
    path: ['maximumStock'], message: 'El stock máximo no puede ser menor que el mínimo',
  })
  .transform((d) => ({
    product: toProductColumns(d),
    branchDefaults: compact({ minimum_stock: d.minimumStock, maximum_stock: d.maximumStock }),
  }));

const productUpdate = z
  .object(Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, v.optional()])))
  .strict()
  .transform(toProductColumns)
  .refine(notEmpty, 'No hay cambios');

const productStatusBody = z.object({ status: z.enum(['ACTIVE', 'INACTIVE', 'DISCONTINUED']) }).strict();

const productListQuery = z.object({
  q: searchTerm,
  sku: z.string().trim().min(1).max(60).optional(),
  barcode: z.string().trim().min(1).max(80).optional(),
  categoryId: id.optional(),
  laboratoryId: id.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'DISCONTINUED']).optional(),
  requiresPrescription: boolish.optional(),
  sort: z.enum(['name', 'sku', 'created_at', 'sale_price']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  ...pagination,
});

const branchProductUpdate = z
  .object({
    salePrice: z.union([money(8), z.null()]).optional(), // null = usar el precio general
    minimumStock: z.coerce.number().int().min(0).max(4294967295).optional(),
    maximumStock: z.union([z.coerce.number().int().min(0).max(4294967295), z.null()]).optional(),
    shelfLocation: optionalText(40),
    isAvailable: z.boolean().optional(),
  })
  .strict()
  .transform((d) => compact({
    sale_price: d.salePrice,
    minimum_stock: d.minimumStock,
    maximum_stock: d.maximumStock,
    shelf_location: d.shelfLocation,
    is_available: d.isAvailable === undefined ? undefined : d.isAvailable ? 1 : 0,
  }))
  .refine(notEmpty, 'No hay cambios');

const productBranchParams = z.object({ id, branchId: id });

// --------------------------------------------------------------- proveedores
const ruc = z
  .string()
  .trim()
  .regex(/^\d{11}$/, 'El RUC debe tener 11 dígitos')
  .refine(isValidRuc, 'RUC inválido (prefijo o dígito verificador incorrecto)');

const email = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim().toLowerCase()))
  .refine((v) => v === undefined || v === null || (v.length <= 190 && z.email().safeParse(v).success), 'Correo inválido');

const phone = optionalText(30).refine((v) => v == null || /^[0-9+()\s-]{6,30}$/.test(v), 'Teléfono inválido');

const supplierFields = {
  businessName: requiredText(180, 'La razón social'),
  tradeName: optionalText(180),
  ruc: z.union([ruc, z.null()]).optional(),
  contactName: optionalText(150),
  phone,
  email,
  addressLine: optionalText(255),
  district: optionalText(100),
  province: optionalText(100),
  department: optionalText(100),
  notes: optionalText(500),
};

function toSupplierColumns(d) {
  return compact({
    business_name: d.businessName,
    trade_name: d.tradeName,
    ruc: d.ruc,
    contact_name: d.contactName,
    phone: d.phone,
    email: d.email,
    address_line: d.addressLine,
    district: d.district,
    province: d.province,
    department: d.department,
    notes: d.notes,
  });
}

const supplierCreate = z.object(supplierFields).strict().transform(toSupplierColumns);
const supplierUpdate = z
  .object(Object.fromEntries(Object.entries(supplierFields).map(([k, v]) => [k, v.optional()])))
  .strict()
  .transform(toSupplierColumns)
  .refine(notEmpty, 'No hay cambios');

const supplierListQuery = z.object({
  q: searchTerm,
  ruc: z.string().trim().regex(/^\d{1,11}$/, 'RUC inválido').optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  ...pagination,
});

const supplierStatusBody = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) }).strict();

module.exports = {
  categoryCreate, categoryUpdate, laboratoryCreate, laboratoryUpdate, catalogListQuery, activeBody,
  productCreate, productUpdate, productStatusBody, productListQuery, branchProductUpdate, productBranchParams,
  supplierCreate, supplierUpdate, supplierListQuery, supplierStatusBody,
};
