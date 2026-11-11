'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const cashRepository = require('../repositories/cash.repository');
const documentSequence = require('../repositories/document-sequence.repository');
const auditRepository = require('../repositories/audit.repository');
const { assertBranchAccess, assertBranchAccessInTx, visibleBranchIds, resolveBranch, bindOperationBranch } = require('./branch-access.service');
const { emitToBranch } = require('./realtime.service');

const canSeeAll = (auth) => auth.permissions.has('cash.view_all');

function sessionDto(s) {
  return {
    id: s.cash_session_id,
    sessionNumber: s.session_number,
    status: s.status,
    branch: { id: s.branch_id, name: s.branch_name },
    register: { id: s.cash_register_id, code: s.register_code, name: s.register_name },
    openedBy: { id: s.opened_by, fullName: s.opened_by_name },
    openedAt: s.opened_at,
    openingAmount: s.opening_amount,
    totalIn: s.total_in,
    totalOut: s.total_out,
    // En vivo mientras está abierta; al cerrar, el valor fijado por el trigger.
    expectedAmount: s.status === 'CLOSED' ? s.closing_expected_amount : s.current_expected_amount,
    countedAmount: s.counted_amount,
    differenceAmount: s.difference_amount,
    closedBy: s.closed_by ? { id: s.closed_by, fullName: s.closed_by_name } : null,
    closedAt: s.closed_at,
    openingNotes: s.opening_notes,
    closingNotes: s.closing_notes,
  };
}

function movementDto(m) {
  return {
    id: m.id,
    cashSessionId: m.cash_session_id,
    sessionNumber: m.session_number,
    movementType: m.movement_type,
    direction: m.direction,
    amount: m.amount,
    paymentId: m.payment_id,
    operationCode: m.operation_code,
    saleNumber: m.sale_number,
    description: m.description,
    performedBy: { id: m.performed_by, fullName: m.performed_by_name },
    createdAt: m.created_at,
  };
}

/** El dueño de la sesión, o quien tenga cash.view_all, dentro de sus sucursales. */
function assertSessionAccess(auth, session) {
  assertBranchAccess(auth, session.branch_id);
  if (session.opened_by !== auth.userId && !canSeeAll(auth)) {
    throw AppError.forbidden('Solo el trabajador que abrió la caja puede operar esta sesión', 'CASH_SESSION_FORBIDDEN');
  }
}

async function loadDetail(conn, id) {
  const s = await cashRepository.findSession(conn, id);
  if (!s) return null;
  const summary = await cashRepository.sessionSalesSummary(conn, id);
  const { rows: movements } = await cashRepository.listMovements(conn, { cashSessionId: id, page: 1, pageSize: 100 });
  return {
    ...sessionDto(s),
    sales: {
      count: Number(summary.sales.sales_count),
      completed: Number(summary.sales.completed_count),
      voided: Number(summary.sales.voided_count),
      completedTotal: summary.sales.completed_total,
      discountTotal: summary.sales.discount_total,
    },
    paymentsByMethod: summary.byMethod.map((p) => ({ method: p.method, status: p.status, count: Number(p.count), amount: p.amount })),
    movements: movements.map(movementDto),
  };
}

async function registers(auth, ctx) {
  return withConnection(ctx, async (conn) => (await cashRepository.listRegisters(conn, visibleBranchIds(auth))).map((r) => ({
    id: r.id,
    branch: { id: r.branch_id, name: r.branch_name },
    code: r.code,
    name: r.name,
    isActive: Boolean(Number(r.is_active)),
    openSession: r.open_session_id ? {
      id: r.open_session_id, sessionNumber: r.open_session_number, openedAt: r.open_session_opened_at,
      openedBy: { id: r.open_session_user_id, fullName: r.open_session_user_name },
    } : null,
  })));
}

async function open({ cashRegisterId, openingAmount, notes }, auth, ctx) {
  const detail = await withTransaction(ctx, async (conn) => {
    const register = await cashRepository.findRegister(conn, cashRegisterId);
    if (!register) throw AppError.notFound('Caja no encontrada');
    await assertBranchAccessInTx(conn, auth, register.branch_id);
    if (!auth.branches.some((b) => b.id === register.branch_id)) {
      // El trigger exige que quien abre esté asignado a la sucursal (también ADMIN).
      throw AppError.forbidden('Debe estar asignado a la sucursal de la caja para abrirla', 'BRANCH_NOT_ASSIGNED');
    }
    if (!Number(register.is_active)) throw AppError.conflict('La caja está inactiva', 'REGISTER_INACTIVE');
    if (await cashRepository.findOpenSessionByUser(conn, auth.userId)) {
      throw AppError.conflict('Ya tiene una sesión de caja abierta', 'CASH_SESSION_ALREADY_OPEN');
    }
    if (await cashRepository.findOpenSessionByRegister(conn, register.id)) {
      throw AppError.conflict('La caja ya tiene una sesión abierta por otro trabajador', 'REGISTER_BUSY');
    }
    const number = await documentSequence.nextNumber(conn, register.branch_id, 'CASH_SESSION');
    const id = await cashRepository.insertSession(conn, {
      number, registerId: register.id, openedBy: auth.userId, openingAmount, notes,
    });
    // La apertura no tiene trigger de auditoría (el cierre sí).
    await auditRepository.log(conn, {
      action: 'OPEN', module: 'cash', table: 'cash_sessions', entityId: id,
      newValues: { session_number: number, cash_register_id: register.id, opening_amount: openingAmount },
    });
    return loadDetail(conn, id);
  });
  emitToBranch(detail.branch.id, 'cash:opened', { cashSessionId: detail.id, sessionNumber: detail.sessionNumber, registerId: detail.register.id });
  return detail;
}

async function current(auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const s = await cashRepository.findOpenSessionByUser(conn, auth.userId);
    return s ? loadDetail(conn, s.id) : null;
  });
}

async function get(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const locked = await cashRepository.findSession(conn, id);
    if (!locked) throw AppError.notFound('Sesión de caja no encontrada');
    assertSessionAccess(auth, locked);
    return loadDetail(conn, id);
  });
}

async function list(filters, auth, ctx) {
  const branchId = filters.branchId ? await resolveBranch(auth, filters.branchId) : undefined;
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await cashRepository.listSessions(conn, {
      ...filters,
      branchId,
      branchIds: branchId ? null : visibleBranchIds(auth),
      userId: canSeeAll(auth) ? filters.userId : auth.userId, // sin cash.view_all: solo las propias
    });
    return paginated(rows.map(sessionDto), total, filters);
  });
}

async function close(id, { countedAmount, notes }, auth, ctx) {
  const detail = await withTransaction(ctx, async (conn) => {
    const s = await cashRepository.lockSession(conn, id);
    if (!s) throw AppError.notFound('Sesión de caja no encontrada');
    assertSessionAccess(auth, s);
    await bindOperationBranch(conn, s.branch_id);
    if (s.status !== 'OPEN') throw AppError.conflict('La sesión de caja ya está cerrada', 'CASH_SESSION_CLOSED');
    await cashRepository.closeSession(conn, id, { countedAmount, notes, closedBy: auth.userId });
    return loadDetail(conn, id);
  });
  emitToBranch(detail.branch.id, 'cash:closed', {
    cashSessionId: detail.id, sessionNumber: detail.sessionNumber, registerId: detail.register.id,
  });
  return detail;
}

/** Ingreso o retiro manual de efectivo (CASH_IN / CASH_OUT). El trigger valida fondos y caja abierta. */
async function addMovement({ cashSessionId, movementType, amount, description }, auth, ctx) {
  const result = await withTransaction(ctx, async (conn) => {
    let sessionId = cashSessionId;
    if (!sessionId) {
      const mine = await cashRepository.findOpenSessionByUser(conn, auth.userId);
      if (!mine) throw AppError.conflict('No tiene una sesión de caja abierta', 'CASH_SESSION_REQUIRED');
      sessionId = mine.id;
    }
    const s = await cashRepository.lockSession(conn, sessionId);
    if (!s) throw AppError.notFound('Sesión de caja no encontrada');
    assertSessionAccess(auth, s);
    await bindOperationBranch(conn, s.branch_id);
    if (s.status !== 'OPEN') throw AppError.conflict('La sesión de caja está cerrada', 'CASH_SESSION_CLOSED');
    const id = await cashRepository.insertMovement(conn, { sessionId, movementType, amount, description, performedBy: auth.userId });
    await auditRepository.log(conn, {
      action: movementType, module: 'cash', table: 'cash_movements', entityId: id,
      newValues: { cash_session_id: sessionId, amount, description },
    });
    const { rows } = await cashRepository.listMovements(conn, { cashSessionId: sessionId, page: 1, pageSize: 1 });
    return { movement: movementDto(rows[0]), branchId: s.branch_id, sessionId };
  });
  emitToBranch(result.branchId, 'cash:movement', { cashSessionId: result.sessionId, movementType });
  return result.movement;
}

async function movements(filters, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    if (filters.cashSessionId) {
      const s = await cashRepository.findSession(conn, filters.cashSessionId);
      if (!s) throw AppError.notFound('Sesión de caja no encontrada');
      assertSessionAccess(auth, s);
    await bindOperationBranch(conn, s.branch_id);
    }
    const { rows, total } = await cashRepository.listMovements(conn, {
      ...filters,
      branchIds: visibleBranchIds(auth),
      userId: canSeeAll(auth) ? undefined : auth.userId,
    });
    return paginated(rows.map(movementDto), total, filters);
  });
}

module.exports = { registers, open, current, get, list, close, addMovement, movements };
