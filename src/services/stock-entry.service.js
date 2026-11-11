'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const entryRepository = require('../repositories/stock-entry.repository');
const branchProductRepository = require('../repositories/branch-product.repository');
const auditRepository = require('../repositories/audit.repository');
const { resolveBranch, assertBranchAccess, assertBranchAccessInTx, visibleBranchIds } = require('./branch-access.service');
const { emitInventoryChanged } = require('./realtime.service');

function headerDto(r) {
  return {
    id: r.id,
    entryNumber: r.entry_number,
    branch: { id: r.branch_id, code: r.branch_code, name: r.branch_name },
    supplier: r.supplier_id ? { id: r.supplier_id, businessName: r.supplier_name, ruc: r.supplier_ruc } : null,
    entryType: r.entry_type,
    referenceDocumentType: r.reference_document_type,
    referenceDocumentNumber: r.reference_document_number,
    status: r.status,
    registeredBy: { id: r.registered_by, fullName: r.registered_by_name },
    receivedAt: r.received_at,
    postedAt: r.posted_at,
    // Mientras está en DRAFT el total se calcula de las líneas; al contabilizar lo fija el trigger.
    totalCost: r.status === 'POSTED' ? r.total_cost : r.items_total,
    itemsCount: Number(r.items_count),
    unitsCount: Number(r.units_count),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function itemDto(i) {
  return {
    id: i.id,
    productId: i.product_id,
    sku: i.sku,
    productName: i.product_name,
    batchId: i.batch_id,
    batchNumber: i.batch_number,
    manufacturingDate: i.manufacturing_date,
    expiryDate: i.expiry_date,
    quantity: Number(i.quantity),
    unitCost: i.unit_cost,
    lineTotal: i.line_total,
    isExpired: Boolean(Number(i.is_expired)),
    movementId: i.movement_id ?? null,
  };
}

async function loadEntry(conn, id) {
  const header = await entryRepository.findById(conn, id);
  if (!header) return null;
  const items = await entryRepository.findItems(conn, id);
  return { ...headerDto(header), items: items.map(itemDto) };
}

async function assertSupplier(conn, supplierId) {
  if (!supplierId) return;
  const [rows] = await conn.execute('SELECT status FROM suppliers WHERE id = ?', [supplierId]);
  if (rows.length === 0) throw AppError.badRequest('El proveedor no existe');
  if (rows[0].status !== 'ACTIVE') throw AppError.badRequest('El proveedor está inactivo');
}

async function assertNotDuplicateDocument(conn, supplierId, docType, docNumber, excludeId = null) {
  const dup = await entryRepository.findByDocument(conn, supplierId, docType, docNumber);
  if (dup && dup.id !== excludeId) {
    throw new AppError(409, 'DUPLICATE_DOCUMENT', `Ese comprobante ya fue registrado en la entrada ${dup.entry_number}`, {
      entryId: dup.id, entryNumber: dup.entry_number, status: dup.status,
    });
  }
}

/** Agrega líneas a un DRAFT: crea (o reutiliza) lotes vacíos y registra las líneas. */
async function addItems(conn, entryId, branchId, items) {
  for (const [index, it] of items.entries()) {
    const [prows] = await conn.execute('SELECT id, status FROM products WHERE id = ?', [it.productId]);
    if (prows.length === 0) throw AppError.badRequest(`Línea ${index + 1}: el producto no existe`);
    if (prows[0].status !== 'ACTIVE') throw AppError.badRequest(`Línea ${index + 1}: el producto no está activo`);
    await branchProductRepository.ensure(conn, it.productId, branchId);

    let batchId;
    const existing = await entryRepository.findBatch(conn, branchId, it.productId, it.batchNumber);
    if (existing) {
      // Mismo número de lote ya existente: solo se acepta si coincide el vencimiento.
      if (existing.expiry_date !== it.expiryDate) {
        throw new AppError(409, 'BATCH_EXPIRY_MISMATCH',
          `Línea ${index + 1}: el lote ${it.batchNumber} ya existe con vencimiento ${existing.expiry_date}`);
      }
      if (existing.status === 'RECALLED' || existing.status === 'QUARANTINE') {
        throw new AppError(409, 'BATCH_BLOCKED', `Línea ${index + 1}: el lote ${it.batchNumber} está bloqueado (${existing.status})`);
      }
      batchId = existing.id;
    } else {
      batchId = await entryRepository.insertBatch(conn, {
        productId: it.productId,
        branchId,
        batchNumber: it.batchNumber,
        manufacturingDate: it.manufacturingDate,
        expiryDate: it.expiryDate,
        unitCost: it.unitCost,
        stockEntryId: entryId,
      });
    }
    await entryRepository.insertItem(conn, { entryId, productId: it.productId, batchId, quantity: it.quantity, unitCost: it.unitCost });
  }
}

/**
 * Contabiliza un DRAFT dentro de la transacción en curso:
 * bloquea los lotes, inserta un PURCHASE_ENTRY por línea (los triggers suben el stock)
 * y marca la entrada POSTED (el trigger calcula total_cost y posted_at).
 */
async function postInTransaction(conn, entryId, auth, entryNumber) {
  const batches = await entryRepository.lockEntryBatches(conn, entryId);
  const expired = batches.filter((b) => Number(b.is_expired));
  if (expired.length > 0) {
    throw new AppError(422, 'BATCH_EXPIRED', 'La entrada contiene lotes vencidos; corríjalos antes de contabilizar');
  }
  const items = await entryRepository.findItems(conn, entryId);
  if (items.length === 0) throw new AppError(422, 'EMPTY_ENTRY', 'La entrada no tiene líneas');

  let created = 0;
  for (const it of items) {
    if (it.movement_id) continue; // nunca se duplica un movimiento (además lo impide uq_movements_entry_item)
    await entryRepository.insertPurchaseMovement(conn, {
      batchId: it.batch_id,
      quantity: it.quantity,
      itemId: it.id,
      performedBy: auth.userId,
      reason: `Entrada ${entryNumber}`,
    });
    created += 1;
  }
  if ((await entryRepository.markPosted(conn, entryId)) !== 1) {
    throw AppError.conflict('La entrada ya no está en borrador', 'ENTRY_NOT_DRAFT');
  }
  // Alertas de vencimiento: solo si algún lote recibido cae en la ventana de alerta.
  if (await entryRepository.hasBatchesInExpiryWindow(conn, entryId)) {
    await conn.query('CALL sp_refresh_expiry_alerts()');
  }
  const header = await entryRepository.findById(conn, entryId);
  await auditRepository.log(conn, {
    action: 'POST', module: 'inventory', table: 'stock_entries', entityId: entryId,
    oldValues: { status: 'DRAFT' },
    newValues: { status: 'POSTED', entry_number: entryNumber, total_cost: header.total_cost, movements: created, lines: items.length },
  });
  return created;
}

async function create(data, auth, ctx) {
  const entry = await withTransaction(ctx, async (conn) => {
    const branchId = await resolveBranch(auth, data.branchId, { conn });
    await assertSupplier(conn, data.supplierId);
    await assertNotDuplicateDocument(conn, data.supplierId, data.referenceDocumentType, data.referenceDocumentNumber);

    const entryNumber = await entryRepository.nextEntryNumber(conn, branchId);
    const entryId = await entryRepository.insertEntry(conn, {
      entryNumber,
      branchId,
      supplierId: data.supplierId,
      entryType: data.entryType,
      referenceDocumentType: data.referenceDocumentType,
      referenceDocumentNumber: data.referenceDocumentNumber,
      registeredBy: auth.userId,
      notes: data.notes,
    });
    await addItems(conn, entryId, branchId, data.items);
    await auditRepository.log(conn, {
      action: 'CREATE', module: 'inventory', table: 'stock_entries', entityId: entryId,
      newValues: {
        entry_number: entryNumber, branch_id: branchId, supplier_id: data.supplierId ?? null, entry_type: data.entryType,
        reference_document: data.referenceDocumentNumber ?? null, lines: data.items.length,
      },
    });
    if (data.confirm) await postInTransaction(conn, entryId, auth, entryNumber);
    return loadEntry(conn, entryId);
  });
  if (entry.status === 'POSTED') {
    emitInventoryChanged(entry.branch.id, { source: 'stock_entry', entryId: entry.id, productIds: [...new Set(entry.items.map((i) => i.productId))] });
  }
  return entry;
}

async function update(id, data, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const locked = await entryRepository.lockById(conn, id);
    if (!locked) throw AppError.notFound('Entrada no encontrada');
    await assertBranchAccessInTx(conn, auth, locked.branch_id);
    if (locked.status !== 'DRAFT') throw AppError.conflict('Solo se modifican entradas en borrador (DRAFT)', 'ENTRY_NOT_DRAFT');

    const current = await entryRepository.findById(conn, id);
    const supplierId = data.supplierId !== undefined ? data.supplierId : current.supplier_id;
    const entryType = data.entryType ?? current.entry_type;
    if (entryType === 'PURCHASE' && !supplierId) throw AppError.badRequest('Una compra requiere proveedor');
    if (data.supplierId !== undefined) await assertSupplier(conn, data.supplierId);
    await assertNotDuplicateDocument(
      conn, supplierId,
      data.referenceDocumentType !== undefined ? data.referenceDocumentType : current.reference_document_type,
      data.referenceDocumentNumber !== undefined ? data.referenceDocumentNumber : current.reference_document_number,
      id,
    );

    await entryRepository.updateHeader(conn, id, data);
    if (data.items) {
      await entryRepository.deleteDraftItems(conn, id);
      await addItems(conn, id, locked.branch_id, data.items);
    }
    await auditRepository.log(conn, {
      action: 'UPDATE', module: 'inventory', table: 'stock_entries', entityId: id,
      newValues: {
        ...Object.fromEntries(Object.entries(data).filter(([k, v]) => k !== 'items' && v !== undefined)),
        ...(data.items ? { lines: data.items.length } : {}),
      },
    });
    return loadEntry(conn, id);
  });
}

/** Contabilizar. Idempotente: repetir la petición sobre una entrada ya POSTED no crea movimientos. */
async function post(id, auth, ctx) {
  const result = await withTransaction(ctx, async (conn) => {
    const locked = await entryRepository.lockById(conn, id); // FOR UPDATE: serializa peticiones repetidas
    if (!locked) throw AppError.notFound('Entrada no encontrada');
    await assertBranchAccessInTx(conn, auth, locked.branch_id);
    if (locked.status === 'POSTED') return { ...(await loadEntry(conn, id)), alreadyPosted: true };
    if (locked.status === 'CANCELLED') throw AppError.conflict('La entrada está anulada', 'ENTRY_CANCELLED');
    const header = await entryRepository.findById(conn, id);
    await postInTransaction(conn, id, auth, header.entry_number);
    return { ...(await loadEntry(conn, id)), alreadyPosted: false };
  });
  if (!result.alreadyPosted) {
    emitInventoryChanged(result.branch.id, { source: 'stock_entry', entryId: result.id, productIds: [...new Set(result.items.map((i) => i.productId))] });
  }
  return result;
}

async function cancel(id, reason, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const locked = await entryRepository.lockById(conn, id);
    if (!locked) throw AppError.notFound('Entrada no encontrada');
    await assertBranchAccessInTx(conn, auth, locked.branch_id);
    if (locked.status !== 'DRAFT') {
      throw AppError.conflict('Solo se anulan entradas en borrador; una entrada contabilizada se revierte con un ajuste', 'ENTRY_NOT_DRAFT');
    }
    await entryRepository.markCancelled(conn, id, `ANULADA: ${reason}`.slice(0, 500));
    await auditRepository.log(conn, {
      action: 'CANCEL', module: 'inventory', table: 'stock_entries', entityId: id,
      oldValues: { status: 'DRAFT' }, newValues: { status: 'CANCELLED', reason },
    });
    return loadEntry(conn, id);
  });
}

async function get(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const entry = await loadEntry(conn, id);
    if (!entry) throw AppError.notFound('Entrada no encontrada');
    assertBranchAccess(auth, entry.branch.id);
    return entry;
  });
}

async function list(filters, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    if (filters.branchId) await resolveBranch(auth, filters.branchId);
    const { rows, total } = await entryRepository.list(conn, { ...filters, branchIds: visibleBranchIds(auth) });
    return paginated(rows.map(headerDto), total, filters);
  });
}

module.exports = { create, update, post, cancel, get, list, postInTransaction };
