'use strict';

const { z, id, optionalText, money, isoDate, pagination, searchTerm } = require('./common.validator');

const positiveMoney = (digits) => money(digits).refine((v) => v !== '0.00', 'El importe debe ser mayor que 0');

// --------------------------------------------------------------------- caja
const sessionOpen = z.object({
  cashRegisterId: id,
  openingAmount: money(10),
  notes: optionalText(500),
}).strict();

const sessionClose = z.object({ countedAmount: money(10), notes: optionalText(500) }).strict();

const cashMovementCreate = z.object({
  cashSessionId: id.optional(),
  movementType: z.enum(['CASH_IN', 'CASH_OUT']),
  amount: positiveMoney(10),
  description: z.string().trim().min(3, 'Indique el motivo').max(255),
}).strict();

const sessionListQuery = z.object({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  cashRegisterId: id.optional(),
  branchId: id.optional(),
  userId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pagination,
});

const cashMovementQuery = z.object({
  cashSessionId: id.optional(),
  movementType: z.enum(['SALE_INCOME', 'PAYMENT_REFUND', 'RETURN_REFUND', 'CASH_IN', 'CASH_OUT']).optional(),
  ...pagination,
});

// --------------------------------------------------------------------- POS
const saleLine = z.object({
  productId: id,
  quantity: z.coerce.number().int('La cantidad debe ser entera').min(1, 'La cantidad debe ser mayor que 0').max(100000),
  prescriptionReference: optionalText(80),
}).strict();

const lines = z
  .array(saleLine)
  .min(1, 'Agregue al menos un producto')
  .max(200)
  .superRefine((list, ctx) => {
    const seen = new Set();
    list.forEach((l, i) => {
      if (seen.has(l.productId)) ctx.addIssue({ code: 'custom', path: [i, 'productId'], message: 'Producto repetido: modifique la cantidad' });
      seen.add(l.productId);
    });
  });

const discount = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PERCENT'), value: money(3).refine((v) => Number(v) <= 100, 'Máximo 100%') }).strict(),
  z.object({ type: z.literal('AMOUNT'), value: money(10) }).strict(),
]).optional();

const customer = z.object({
  customerId: id.optional(),
  fullName: optionalText(150),
  documentType: z.enum(['DNI', 'CE', 'PASSPORT', 'RUC', 'OTHER']).optional(),
  documentNumber: optionalText(30),
}).strict().optional();

const quote = z.object({ branchId: id.optional(), items: lines, discount, customer }).strict();

const payment = z.object({
  method: z.enum(['CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN', 'OTHER']),
  amount: positiveMoney(10).optional(), // si se omite (pago único) = total calculado por el servidor
  tenderedAmount: money(10).optional(), // solo efectivo
  // Simulación DEMO: permite probar operaciones aprobadas o rechazadas. Nunca datos de tarjeta.
  simulate: z.enum(['APPROVE', 'REJECT']).default('APPROVE'),
}).strict().superRefine((p, ctx) => {
  if (p.method !== 'CASH' && p.tenderedAmount !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['tenderedAmount'], message: 'El importe entregado solo aplica a efectivo' });
  }
  if (p.method === 'CASH' && p.simulate === 'REJECT') {
    ctx.addIssue({ code: 'custom', path: ['simulate'], message: 'El efectivo no se simula: se confirma en caja' });
  }
});

const saleCreate = z.object({
  branchId: id.optional(),
  items: lines,
  discount,
  customer,
  notes: optionalText(500),
  payments: z.array(payment).min(1, 'Registre al menos un pago').max(6),
}).strict().superRefine((d, ctx) => {
  if (d.payments.length > 1 && d.payments.some((p) => p.amount === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['payments'], message: 'En pagos divididos indique el importe de cada pago' });
  }
});

const saleVoid = z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mínimo 5 caracteres)').max(500) }).strict();

const saleListQuery = z.object({
  branchId: id.optional(),
  status: z.enum(['COMPLETED', 'VOIDED']).optional(),
  cashSessionId: id.optional(),
  sellerId: id.optional(),
  customerId: id.optional(),
  q: searchTerm,
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pagination,
});

const catalogQuery = z.object({
  branchId: id.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  barcode: z.string().trim().min(1).max(80).optional(),
  sku: z.string().trim().min(1).max(60).optional(),
  onlyAvailable: z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true').optional(),
  ...pagination,
});

const paymentListQuery = z.object({
  branchId: id.optional(),
  saleId: id.optional(),
  cashSessionId: id.optional(),
  method: z.enum(['CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN', 'OTHER']).optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pagination,
});

const ticketQuery = z.object({ format: z.enum(['json', 'html']).default('json') });

module.exports = {
  sessionOpen, sessionClose, cashMovementCreate, sessionListQuery, cashMovementQuery,
  quote, saleCreate, saleVoid, saleListQuery, catalogQuery, paymentListQuery, ticketQuery,
};
