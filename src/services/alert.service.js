'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { logger } = require('../config/logger');
const { config } = require('../config/env');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const { msUntilNextLimaTime } = require('../utils/dates');
const alertRepository = require('../repositories/alert.repository');
const auditRepository = require('../repositories/audit.repository');
const { resolveBranch, visibleBranchIds, assertBranchAccess, assertBranchAccessInTx } = require('./branch-access.service');

function toDto(a) {
  return {
    id: a.id,
    alertType: a.alert_type,
    status: a.status,
    branch: { id: a.branch_id, name: a.branch_name },
    product: { id: a.product_id, sku: a.sku, name: a.product_name },
    batch: a.batch_id
      ? { id: a.batch_id, batchNumber: a.batch_number, expiryDate: a.batch_expiry_date, currentQuantity: Number(a.batch_current_quantity) }
      : null,
    stockAtAlert: Number(a.stock_at_alert),
    thresholdAtAlert: a.threshold_at_alert === null ? null : Number(a.threshold_at_alert),
    expiryDateAtAlert: a.expiry_date_at_alert,
    message: a.message,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    resolvedAt: a.resolved_at,
    resolvedBy: a.resolved_by ? { id: a.resolved_by, fullName: a.resolved_by_name } : null,
    resolutionNote: a.resolution_note,
  };
}

async function list(filters, auth, ctx) {
  const branchId = filters.branchId ? await resolveBranch(auth, filters.branchId) : undefined;
  const branchIds = branchId ? null : visibleBranchIds(auth);
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await alertRepository.list(conn, { ...filters, branchId, branchIds });
    const counts = await alertRepository.summary(conn, branchId ? [branchId] : branchIds);
    return {
      ...paginated(rows.map(toDto), total, filters),
      openSummary: Object.fromEntries(counts.map((c) => [c.alert_type, Number(c.total)])),
    };
  });
}

async function get(id, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const row = await alertRepository.findById(conn, id);
    if (!row) throw AppError.notFound('Alerta no encontrada');
    assertBranchAccess(auth, row.branch_id);
    return toDto(row);
  });
}

/** Resolver o descartar (stock_alerts no tiene trigger de auditoría: se registra aquí). */
async function close(id, { status, note }, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const row = await alertRepository.findById(conn, id, { forUpdate: true });
    if (!row) throw AppError.notFound('Alerta no encontrada');
    await assertBranchAccessInTx(conn, auth, row.branch_id);
    if (row.status !== 'OPEN') throw AppError.conflict('La alerta ya está cerrada', 'ALERT_CLOSED');
    await alertRepository.close(conn, id, { status, userId: auth.userId, note });
    await auditRepository.log(conn, {
      action: status === 'RESOLVED' ? 'RESOLVE' : 'DISMISS', module: 'alerts', table: 'stock_alerts', entityId: id,
      oldValues: { status: 'OPEN' }, newValues: { status, note, alert_type: row.alert_type },
    });
    return toDto(await alertRepository.findById(conn, id));
  });
}

// ------------------------------------------------- alertas de vencimiento
const EXPIRY_LOCK = 'pharma_plus.refresh_expiry_alerts';
let running = false;

/**
 * Ejecuta CALL sp_refresh_expiry_alerts().
 * Evita ejecuciones simultáneas en este proceso (bandera) y entre procesos (GET_LOCK de MariaDB).
 * @returns {{ executed: boolean, reason?: string, durationMs?: number }}
 */
async function refreshExpiryAlerts(ctx = { requestId: 'job-expiry-alerts' }) {
  if (running) return { executed: false, reason: 'ALREADY_RUNNING' };
  running = true;
  const started = Date.now();
  try {
    return await withConnection(ctx, async (conn) => {
      const [[lock]] = await conn.query('SELECT GET_LOCK(?, 0) AS acquired', [EXPIRY_LOCK]);
      if (Number(lock.acquired) !== 1) return { executed: false, reason: 'LOCKED_BY_OTHER_PROCESS' };
      try {
        await conn.query('CALL sp_refresh_expiry_alerts()');
        return { executed: true, durationMs: Date.now() - started };
      } finally {
        await conn.query('SELECT RELEASE_LOCK(?)', [EXPIRY_LOCK]).catch(() => {});
      }
    });
  } finally {
    running = false;
  }
}

/** Programa la actualización diaria a la hora configurada (06:00 America/Lima por defecto). */
function scheduleDailyExpiryAlerts(hour = config.jobs.expiryAlertsHour) {
  let timer = null;
  const scheduleNext = () => {
    const delay = msUntilNextLimaTime(hour, 0);
    timer = setTimeout(async () => {
      try {
        const r = await refreshExpiryAlerts();
        if (r.executed) logger.info({ durationMs: r.durationMs }, 'Alertas de vencimiento actualizadas');
        else logger.warn({ reason: r.reason }, 'Actualización de alertas de vencimiento omitida');
      } catch (err) {
        logger.error({ errno: err.errno, code: err.code }, 'Error al actualizar alertas de vencimiento');
      } finally {
        scheduleNext();
      }
    }, delay);
    timer.unref();
    logger.info({ nextRunInMinutes: Math.round(delay / 60000), hourLima: hour }, 'Tarea de alertas de vencimiento programada');
  };
  scheduleNext();
  return { stop: () => clearTimeout(timer) };
}

module.exports = { list, get, close, refreshExpiryAlerts, scheduleDailyExpiryAlerts };
