'use strict';

const { z, id, optionalText, money, isoDate, futureDate, boolish, pagination, searchTerm } = require('./common.validator');
const { todayLima } = require('../utils/dates');

const DOC_TYPES = ['FACTURA', 'BOLETA', 'GUIA_REMISION', 'NOTA', 'OTHER'];
const ENTRY_TYPES = ['PURCHASE', 'INITIAL_STOCK', 'DONATION', 'OTHER'];

const entryItem = z
  .object({
    productId: id,
    batchNumber: z.string().trim().min(1, 'Número de lote obligatorio').max(60)
      .regex(/^[A-Za-z0-9._/-]+$/, 'El número de lote solo admite letras, números, punto, guion y barra'),
    manufacturingDate: z.union([isoDate, z.null()]).optional(),
    expiryDate: futureDate,
    quantity: z.coerce.number().int('La cantidad debe ser entera').min(1, 'La cantidad debe ser mayor que 0').max(1000000),
    unitCost: money(8),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.manufacturingDate) {
      if (d.manufacturingDate > todayLima()) ctx.addIssue({ code: 'custom', path: ['manufacturingDate'], message: 'La fecha de fabricación no puede ser futura' });
      if (d.manufacturingDate >= d.expiryDate) ctx.addIssue({ code: 'custom', path: ['manufacturingDate'], message: 'La fabricación debe ser anterior al vencimiento' });
    }
  });

const items = z
  .array(entryItem)
  .min(1, 'Agregue al menos un producto')
  .max(300, 'Máximo 300 líneas por entrada')
  .superRefine((list, ctx) => {
    const seen = new Set();
    list.forEach((it, i) => {
      const key = `${it.productId}|${it.batchNumber.toUpperCase()}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i, 'batchNumber'], message: 'Lote repetido para el mismo producto' });
      seen.add(key);
    });
  });

const headerFields = {
  supplierId: z.union([id, z.null()]).optional(),
  entryType: z.enum(ENTRY_TYPES).optional(),
  referenceDocumentType: z.union([z.enum(DOC_TYPES), z.null()]).optional(),
  referenceDocumentNumber: optionalText(80),
  notes: optionalText(500),
};

function checkHeader(d, ctx) {
  const type = d.entryType ?? 'PURCHASE';
  if (type === 'PURCHASE' && d.supplierId === null) {
    ctx.addIssue({ code: 'custom', path: ['supplierId'], message: 'Una compra requiere proveedor' });
  }
  const hasType = d.referenceDocumentType != null;
  const hasNumber = d.referenceDocumentNumber != null;
  if (hasType !== hasNumber && (d.referenceDocumentType !== undefined || d.referenceDocumentNumber !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['referenceDocumentNumber'], message: 'Indique tipo y número del comprobante, o ninguno' });
  }
}

const entryCreate = z
  .object({
    branchId: id.optional(),
    ...headerFields,
    entryType: z.enum(ENTRY_TYPES).default('PURCHASE'),
    items,
    confirm: z.boolean().default(false), // true = registrar y contabilizar en la misma transacción
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.entryType === 'PURCHASE' && !d.supplierId) {
      ctx.addIssue({ code: 'custom', path: ['supplierId'], message: 'Una compra requiere proveedor' });
    }
    checkHeader(d, ctx);
  });

const entryUpdate = z
  .object({ ...headerFields, items: items.optional() })
  .strict()
  .superRefine(checkHeader)
  .refine((d) => Object.values(d).some((v) => v !== undefined), 'No hay cambios');

const entryCancel = z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mínimo 5 caracteres)').max(400) }).strict();

const entryListQuery = z.object({
  branchId: id.optional(),
  supplierId: id.optional(),
  status: z.enum(['DRAFT', 'POSTED', 'CANCELLED']).optional(),
  entryType: z.enum(ENTRY_TYPES).optional(),
  q: searchTerm,
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pagination,
});

const stockQuery = z.object({
  branchId: id.optional(),
  productId: id.optional(),
  categoryId: id.optional(),
  q: searchTerm,
  stockStatus: z.enum(['OK', 'LOW_STOCK', 'OUT_OF_STOCK']).optional(),
  productStatus: z.enum(['ACTIVE', 'INACTIVE', 'DISCONTINUED']).optional(),
  onlyAvailable: boolish.optional(),
  ...pagination,
});

const lowStockQuery = z.object({
  branchId: id.optional(),
  stockStatus: z.enum(['LOW_STOCK', 'OUT_OF_STOCK']).optional(),
  ...pagination,
});

const batchQuery = z.object({
  branchId: id.optional(),
  productId: id.optional(),
  status: z.enum(['ACTIVE', 'DEPLETED', 'QUARANTINE', 'RECALLED']).optional(),
  batchNumber: z.string().trim().min(1).max(60).optional(),
  withStock: boolish.optional(),
  expired: boolish.optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  ...pagination,
});

const fefoQuery = z.object({ branchId: id.optional(), productId: id, quantity: z.coerce.number().int().min(1).max(1000000).optional() });

const movementQuery = z.object({
  branchId: id.optional(),
  productId: id.optional(),
  batchId: id.optional(),
  movementType: z.enum(['PURCHASE_ENTRY', 'SALE_OUT', 'SALE_VOID_IN', 'RETURN_IN', 'TRANSFER_OUT', 'TRANSFER_IN',
    'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'EXPIRED_WRITE_OFF', 'DAMAGE_WRITE_OFF']).optional(),
  direction: z.enum(['IN', 'OUT']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pagination,
});

const alertQuery = z.object({
  branchId: id.optional(),
  productId: id.optional(),
  alertType: z.enum(['LOW_STOCK', 'OUT_OF_STOCK', 'EXPIRING_SOON', 'EXPIRED']).optional(),
  status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).default('OPEN'),
  ...pagination,
});

const alertResolve = z
  .object({
    status: z.enum(['RESOLVED', 'DISMISSED']).default('RESOLVED'),
    note: z.string().trim().min(3, 'Indique una nota (mínimo 3 caracteres)').max(255),
  })
  .strict();

// ------------------------------------------------------------------ ajustes
const qty = z.coerce.number().int('Debe ser un número entero').min(1, 'La cantidad debe ser mayor que 0').max(1000000);
const reason = z.string().trim().min(5, 'Indique el motivo (mínimo 5 caracteres)').max(500);

function uniqueBatches(list, ctx) {
  const seen = new Set();
  list.forEach((it, i) => {
    if (seen.has(it.batchId)) ctx.addIssue({ code: 'custom', path: [i, 'batchId'], message: 'Lote repetido' });
    seen.add(it.batchId);
  });
}

const countItems = z
  .array(z.object({
    batchId: id,
    countedQuantity: z.coerce.number().int('Debe ser un número entero').min(0, 'La cantidad física no puede ser negativa').max(1000000),
  }).strict())
  .min(1, 'Seleccione al menos un lote').max(200).superRefine(uniqueBatches);

const directedItems = z
  .array(z.object({ batchId: id, quantity: qty, direction: z.enum(['IN', 'OUT']) }).strict())
  .min(1, 'Seleccione al menos un lote').max(200).superRefine(uniqueBatches);

const writeOffItems = z
  .array(z.object({ batchId: id, quantity: qty }).strict())
  .min(1, 'Seleccione al menos un lote').max(200).superRefine(uniqueBatches);

const adjustmentBase = { branchId: id.optional(), reason };

const adjustmentCreate = z.discriminatedUnion('adjustmentType', [
  z.object({ ...adjustmentBase, adjustmentType: z.literal('PHYSICAL_COUNT'), productId: id, items: countItems }).strict(),
  z.object({ ...adjustmentBase, adjustmentType: z.literal('CORRECTION'), productId: id.optional(), items: directedItems }).strict(),
  z.object({ ...adjustmentBase, adjustmentType: z.literal('OTHER'), productId: id.optional(), items: directedItems }).strict(),
  z.object({ ...adjustmentBase, adjustmentType: z.literal('EXPIRED_WRITE_OFF'), productId: id.optional(), items: writeOffItems }).strict(),
  z.object({ ...adjustmentBase, adjustmentType: z.literal('DAMAGE'), productId: id.optional(), items: writeOffItems }).strict(),
  z.object({ ...adjustmentBase, adjustmentType: z.literal('LOSS'), productId: id.optional(), items: writeOffItems }).strict(),
], { error: 'Tipo de ajuste inválido' });

const adjustmentListQuery = z.object({
  branchId: id.optional(),
  adjustmentType: z.enum(['PHYSICAL_COUNT', 'EXPIRED_WRITE_OFF', 'DAMAGE', 'LOSS', 'CORRECTION', 'OTHER']).optional(),
  productId: id.optional(),
  q: searchTerm,
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pagination,
});

module.exports = {
  adjustmentCreate,
  adjustmentListQuery,
  entryCreate, entryUpdate, entryCancel, entryListQuery, stockQuery, lowStockQuery, batchQuery, fefoQuery,
  movementQuery, alertQuery, alertResolve,
};
