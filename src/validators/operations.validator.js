'use strict';

const { z, id, optionalText, isoDate, pagination, searchTerm } = require('./common.validator');

const PAY_METHODS = ['CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN', 'OTHER'];
const CONDITIONS = ['RESELLABLE', 'DAMAGED', 'EXPIRED', 'OPENED', 'NOT_SUITABLE'];
const qty = z.coerce.number().int('Debe ser un número entero').min(1, 'La cantidad debe ser mayor que 0').max(100000);

// ============================================================== devoluciones
const returnItem = z
  .object({
    saleItemBatchId: id.optional(), // lote exacto vendido
    saleItemId: id.optional(), // o la línea: el servidor reparte entre sus lotes
    quantity: qty,
    condition: z.enum(CONDITIONS),
    notes: optionalText(255),
  })
  .strict()
  .refine((d) => Boolean(d.saleItemBatchId) !== Boolean(d.saleItemId), 'Indique saleItemBatchId o saleItemId (uno de los dos)');

const returnCreate = z
  .object({
    saleId: id,
    reasonId: id.optional(),
    reasonCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/).max(40).optional(),
    notes: optionalText(500),
    items: z.array(returnItem).min(1, 'Seleccione al menos un producto').max(200),
    // true: si el usuario tiene returns.approve, aprueba, reingresa y reembolsa en la misma transacción.
    process: z.boolean().default(false),
    refundMethod: z.enum(PAY_METHODS).optional(),
  })
  .strict()
  .refine((d) => d.reasonId || d.reasonCode, { path: ['reasonId'], message: 'Indique el motivo de la devolución' });

const returnReject = z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mínimo 5 caracteres)').max(500) }).strict();
const returnComplete = z.object({ refundMethod: z.enum(PAY_METHODS).optional(), notes: optionalText(500) }).strict();

const returnListQuery = z.object({
  branchId: id.optional(),
  saleId: id.optional(),
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED']).optional(),
  q: searchTerm,
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pagination,
});

const saleLookupQuery = z
  .object({
    saleNumber: z.string().trim().min(3).max(40).optional(),
    ticketNumber: z.string().trim().min(3).max(40).optional(),
  })
  .refine((d) => d.saleNumber || d.ticketNumber, 'Indique saleNumber o ticketNumber');

// ============================================================ transferencias
const transferItem = z.object({ batchId: id, quantity: qty }).strict();

const transferItems = z
  .array(transferItem)
  .min(1, 'Agregue al menos un lote')
  .max(200)
  .superRefine((list, ctx) => {
    const seen = new Set();
    list.forEach((it, i) => {
      if (seen.has(it.batchId)) ctx.addIssue({ code: 'custom', path: [i, 'batchId'], message: 'Lote repetido' });
      seen.add(it.batchId);
    });
  });

const transferCreate = z
  .object({
    originBranchId: id,
    destinationBranchId: id,
    notes: optionalText(500),
    items: transferItems,
  })
  .strict()
  .refine((d) => d.originBranchId !== d.destinationBranchId, { path: ['destinationBranchId'], message: 'Origen y destino deben ser distintos' });

const transferUpdate = z.object({ notes: optionalText(500), items: transferItems.optional() }).strict();

/** Aprobación: cantidad aprobada por ítem (0 = se excluye); no puede superar lo solicitado. */
const transferApprove = z
  .object({
    items: z.array(z.object({ itemId: id, approvedQuantity: z.coerce.number().int().min(0).max(100000) }).strict()).max(200).optional(),
    notes: optionalText(500),
  })
  .strict();

const transferReceive = z
  .object({
    items: z
      .array(z.object({
        itemId: id,
        receivedQuantity: z.coerce.number().int().min(0, 'No puede ser negativa').max(100000), // unidades que llegaron físicamente
        damagedQuantity: z.coerce.number().int().min(0).max(100000).default(0), // de las recibidas, dañadas
        surplusQuantity: z.coerce.number().int().min(0).max(100000).default(0), // llegaron de más (solo se registra)
        note: optionalText(200),
      }).strict()
        .refine((d) => d.damagedQuantity <= d.receivedQuantity, { path: ['damagedQuantity'], message: 'Las dañadas no pueden superar las recibidas' }))
      .min(1, 'Indique al menos un ítem recibido')
      .max(200)
      .superRefine((list, ctx) => {
        const seen = new Set();
        list.forEach((it, i) => {
          if (seen.has(it.itemId)) ctx.addIssue({ code: 'custom', path: [i, 'itemId'], message: 'Ítem repetido' });
          seen.add(it.itemId);
        });
      }),
  })
  .strict();

const transferCancel = z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mínimo 5 caracteres)').max(400) }).strict();

const transferListQuery = z.object({
  branchId: id.optional(), // origen o destino
  direction: z.enum(['OUTGOING', 'INCOMING']).optional(),
  status: z.enum(['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional(),
  q: searchTerm,
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pagination,
});

module.exports = {
  returnCreate, returnReject, returnComplete, returnListQuery, saleLookupQuery,
  transferCreate, transferUpdate, transferApprove, transferReceive, transferCancel, transferListQuery,
};
