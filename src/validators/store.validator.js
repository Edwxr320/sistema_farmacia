'use strict';

const { z, id, optionalText, isoDate, pagination, searchTerm } = require('./common.validator');
const { emailField, fullNameField, strongPassword } = require('./auth.validator');

const phone = z.string().trim().regex(/^[0-9+()\s-]{6,30}$/, 'Teléfono inválido');
const optionalPhone = z.union([phone, z.null()]).optional();

const documentFields = {
  documentType: z.union([z.enum(['DNI', 'CE', 'PASSPORT', 'RUC', 'OTHER']), z.null()]).optional(),
  documentNumber: optionalText(30),
};

function checkDocument(d, ctx) {
  const hasType = d.documentType != null;
  const hasNumber = d.documentNumber != null;
  if (d.documentType !== undefined || d.documentNumber !== undefined) {
    if (hasType !== hasNumber) ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'Indique tipo y número de documento, o ninguno' });
  }
  if (d.documentType === 'DNI' && d.documentNumber && !/^\d{8}$/.test(d.documentNumber)) {
    ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'El DNI debe tener 8 dígitos' });
  }
  if (d.documentType === 'RUC' && d.documentNumber && !/^[12]\d{10}$/.test(d.documentNumber)) {
    ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'RUC inválido' });
  }
}

const register = z
  .object({ fullName: fullNameField, email: emailField, password: strongPassword, phone: optionalPhone, ...documentFields })
  .strict()
  .superRefine((d, ctx) => {
    checkDocument(d, ctx);
    const local = d.email.split('@')[0];
    if (local.length >= 4 && d.password.toLowerCase().includes(local)) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'La contraseña no debe contener el correo' });
    }
  });

const profileUpdate = z
  .object({ fullName: fullNameField.optional(), phone: optionalPhone, birthDate: z.union([isoDate, z.null()]).optional(), ...documentFields })
  .strict()
  .superRefine(checkDocument)
  .refine((d) => Object.values(d).some((v) => v !== undefined), 'No hay cambios');

const addressFields = {
  label: optionalText(60),
  recipientName: z.string().trim().min(3).max(150),
  phone,
  addressLine: z.string().trim().min(5, 'Dirección muy corta').max(255),
  referenceNote: optionalText(255),
  district: optionalText(100),
  province: optionalText(100),
  department: optionalText(100),
  latitude: z.union([z.coerce.number().min(-90).max(90), z.null()]).optional(),
  longitude: z.union([z.coerce.number().min(-180).max(180), z.null()]).optional(),
  isDefault: z.boolean().optional(),
};

const toAddressColumns = (d) => Object.fromEntries(Object.entries({
  label: d.label, recipient_name: d.recipientName, phone: d.phone, address_line: d.addressLine,
  reference_note: d.referenceNote, district: d.district, province: d.province, department: d.department,
  latitude: d.latitude, longitude: d.longitude, is_default: d.isDefault,
}).filter(([, v]) => v !== undefined));

const addressCreate = z.object(addressFields).strict().transform(toAddressColumns);
const addressUpdate = z
  .object(Object.fromEntries(Object.entries(addressFields).map(([k, v]) => [k, v.optional()])))
  .strict()
  .transform(toAddressColumns)
  .refine((d) => Object.keys(d).length > 0, 'No hay cambios');

const catalogQuery = z.object({
  branchId: id.optional(),
  q: searchTerm,
  categoryId: id.optional(),
  inStock: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['name', 'price_asc', 'price_desc']).default('name'),
  ...pagination,
});

const cartBranch = z.object({ branchId: id }).strict();
const cartItem = z.object({ quantity: z.coerce.number().int('Cantidad entera').min(1, 'Mínimo 1').max(100, 'Máximo 100 unidades') }).strict();
const productParam = z.object({ productId: id });

const checkout = z
  .object({
    branchId: id.optional(), // por defecto, la sucursal del carrito
    fulfillmentType: z.enum(['PICKUP', 'DELIVERY']),
    addressId: id.optional(),
    paymentMethod: z.enum(['CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN']),
    simulatePayment: z.enum(['APPROVE', 'REJECT']).default('APPROVE'), // solo DEMO electrónico
    customerNote: optionalText(300),
    // Referencia de receta por producto que la requiere: { "<productId>": "N.º de receta" }
    prescriptions: z.record(z.string().regex(/^\d+$/), z.string().trim().min(3).max(80)).optional(),
    // Total que el cliente vio: si el precio cambió, se pide confirmar de nuevo.
    expectedTotal: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.fulfillmentType === 'DELIVERY' && !d.addressId) ctx.addIssue({ code: 'custom', path: ['addressId'], message: 'El delivery requiere una dirección' });
    if (d.paymentMethod === 'CASH' && d.simulatePayment === 'REJECT') ctx.addIssue({ code: 'custom', path: ['simulatePayment'], message: 'El efectivo se paga al recibir' });
  });

const orderCancel = z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mínimo 5 caracteres)').max(400) }).strict();

const myOrdersQuery = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED', 'REJECTED']).optional(),
  ...pagination,
});

module.exports = {
  register, profileUpdate, addressCreate, addressUpdate, catalogQuery, cartBranch, cartItem, productParam, checkout,
  orderCancel, myOrdersQuery,
};
