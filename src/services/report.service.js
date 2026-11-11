'use strict';

const { withConnection } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const { todayLima } = require('../utils/dates');
const { toCents, fromCents } = require('../utils/money');
const reportRepository = require('../repositories/report.repository');
const { resolveBranch, canAccessAllBranches } = require('./branch-access.service');

/** Definiciones devueltas junto a los totales para que el dashboard no las malinterprete. */
const DEFINITIONS = {
  grossSales: 'Suma de subtotales de ventas vigentes (antes de descuentos).',
  discounts: 'Descuentos otorgados en ventas vigentes.',
  netSales: 'Ventas vigentes cobradas: bruto − descuentos + delivery. Excluye ventas anuladas.',
  refunds: 'Reembolsos por devoluciones completadas en el período.',
  netRevenue: 'Ingreso neto por ventas: ventas netas − reembolsos.',
  costOfGoodsSold: 'Costo de las unidades vendidas (costo del lote) − costo de las unidades devueltas aptas que reingresaron.',
  grossMarginEstimated: 'Margen bruto ESTIMADO: ingreso neto − costo de lo vendido. No es ganancia neta: no descuenta gastos operativos, impuestos, mermas ni bajas.',
  averageTicket: 'Ventas netas / número de ventas vigentes.',
};

const MAX_RANGE_DAYS = 366;

function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
function addDays(d, n) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * Alcance: sucursal pedida (validada) o, sin ella, todas las visibles. Ver varias sucursales a la vez
 * requiere reports.consolidated; si no, se usa la sucursal activa del usuario.
 */
async function scope(auth, q) {
  const from = q.from ?? todayLima();
  const to = q.to ?? from;
  if (to < from) throw AppError.badRequest('La fecha final no puede ser anterior a la inicial');
  if (dayDiff(from, to) > MAX_RANGE_DAYS) throw AppError.badRequest(`El rango máximo es de ${MAX_RANGE_DAYS} días`);
  let branchId;
  let branchIds = null;
  if (q.branchId) branchId = await resolveBranch(auth, q.branchId);
  else if (auth.permissions.has('reports.consolidated')) branchIds = canAccessAllBranches(auth) ? null : auth.branches.map((b) => b.id);
  else branchId = await resolveBranch(auth, undefined);
  return { ...q, from, to, branchId, branchIds };
}

const c = toCents;
const ratio = (num, den) => (den === 0 ? null : Math.round((num / den) * 10000) / 100); // % con 2 decimales

/** Resumen financiero del período con métricas derivadas exactas (céntimos). */
async function salesSummaryInternal(conn, f) {
  const [t, cost, ret, voids] = [
    await reportRepository.salesTotals(conn, f),
    await reportRepository.costOfSales(conn, f),
    await reportRepository.returnsTotals(conn, f),
    await reportRepository.voidsTotals(conn, f),
  ];
  const transactions = Number(t.transactions);
  const netSales = c(t.net_sales);
  const refunds = c(ret.refunded);
  const netRevenue = netSales - refunds;
  const cogs = c(cost.cost) - c(ret.restocked_cost);
  const margin = netRevenue - cogs;
  return {
    period: { from: f.from, to: f.to },
    transactions,
    grossSales: t.gross,
    discounts: t.discounts,
    deliveryFees: t.delivery_fees,
    netSales: t.net_sales,
    averageTicket: transactions ? fromCents(Math.round(netSales / transactions)) : '0.00',
    unitsSold: Number(cost.units),
    byChannel: {
      POS: { transactions: Number(t.pos_count), netSales: t.pos_total },
      ONLINE: { transactions: Number(t.online_count), netSales: t.online_total },
    },
    returns: { count: Number(ret.returns_count), totalReturns: Number(ret.total_returns), units: Number(ret.units), restockedUnits: Number(ret.restocked_units), refunds: ret.refunded },
    voids: { count: Number(voids.voids_count), amount: voids.voided_amount, rejectedPaymentAttempts: Number(voids.rejected_payment_attempts) },
    netRevenue: fromCents(netRevenue),
    costOfGoodsSold: fromCents(cogs),
    grossMarginEstimated: fromCents(margin),
    grossMarginPercent: ratio(margin, netRevenue),
    definitions: DEFINITIONS,
  };
}

async function salesSummary(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, (conn) => salesSummaryInternal(conn, f));
}

/** Período actual vs. el inmediatamente anterior de igual duración. */
async function salesCompare(auth, q, ctx) {
  const f = await scope(auth, q);
  const len = dayDiff(f.from, f.to) + 1;
  const prev = { ...f, from: addDays(f.from, -len), to: addDays(f.from, -1) };
  return withConnection(ctx, async (conn) => {
    const current = await salesSummaryInternal(conn, f);
    const previous = await salesSummaryInternal(conn, prev);
    const change = (k) => ({ current: current[k], previous: previous[k], changePercent: ratio(c(current[k]) - c(previous[k]), c(previous[k])) });
    return {
      current: current.period,
      previous: previous.period,
      netSales: change('netSales'),
      netRevenue: change('netRevenue'),
      grossMarginEstimated: change('grossMarginEstimated'),
      averageTicket: change('averageTicket'),
      transactions: {
        current: current.transactions, previous: previous.transactions,
        changePercent: ratio(current.transactions - previous.transactions, previous.transactions),
      },
    };
  });
}

async function salesSeries(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => {
    const rows = await reportRepository.salesSeries(conn, f, q.granularity);
    const map = new Map(rows.map((r) => [r.period, r]));
    let points = rows.map((r) => r.period);
    if (q.granularity === 'day') { // días sin ventas = 0 (series continuas para el gráfico)
      points = [];
      for (let d = f.from; d <= f.to; d = addDays(d, 1)) points.push(d);
    }
    return {
      granularity: q.granularity,
      period: { from: f.from, to: f.to },
      series: points.map((p) => {
        const r = map.get(p);
        return { period: p, transactions: r ? Number(r.transactions) : 0, grossSales: r ? r.gross : '0.00', discounts: r ? r.discounts : '0.00', netSales: r ? r.net_sales : '0.00' };
      }),
    };
  });
}

const num = (rows, keys) => rows.map((r) => {
  const o = { ...r };
  for (const k of keys) o[k] = Number(o[k]);
  return o;
});

async function topProducts(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => ({
    period: { from: f.from, to: f.to },
    orderBy: q.orderBy,
    data: num(await reportRepository.topProducts(conn, f, { limit: q.limit, orderBy: q.orderBy }), ['quantity', 'transactions']),
  }));
}

async function byCategory(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => ({ period: { from: f.from, to: f.to }, data: num(await reportRepository.byCategory(conn, f), ['quantity', 'transactions']) }));
}

async function byBranch(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => ({ period: { from: f.from, to: f.to }, data: num(await reportRepository.byBranch(conn, f), ['transactions']) }));
}

async function bySeller(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => ({ period: { from: f.from, to: f.to }, data: num(await reportRepository.bySeller(conn, f), ['transactions']) }));
}

async function paymentMethods(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => {
    const { rows, refunds } = await reportRepository.paymentMethods(conn, f);
    const approved = rows.filter((r) => r.status === 'APPROVED' || r.status === 'REFUNDED');
    const totalCollected = approved.reduce((a, r) => a + c(r.amount), 0);
    return {
      period: { from: f.from, to: f.to },
      byMethod: [...new Set(rows.map((r) => r.method))].map((m) => {
        const of = (s) => rows.filter((r) => r.method === m && r.status === s);
        const sum = (list) => list.reduce((a, r) => a + c(r.amount), 0);
        const collected = sum(of('APPROVED')) + sum(of('REFUNDED'));
        return {
          method: m,
          collected: fromCents(collected),
          share: ratio(collected, totalCollected),
          paymentRefunds: fromCents(sum(of('REFUNDED'))),
          rejectedAttempts: of('REJECTED').reduce((a, r) => a + Number(r.count), 0),
          demo: rows.some((r) => r.method === m && Number(r.is_simulated) === 1),
          returnRefunds: refunds.find((r) => r.method === m)?.amount ?? '0.00',
        };
      }),
    };
  });
}

async function inventory(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => {
    const rows = await reportRepository.inventoryValuation(conn, f);
    const sum = (k) => fromCents(rows.reduce((a, r) => a + c(r[k]), 0));
    return {
      valuationBasis: 'Costo unitario del lote de ingreso (product_batches.unit_cost) × existencias actuales.',
      totals: {
        units: rows.reduce((a, r) => a + Number(r.units), 0),
        costValue: sum('cost_value'), sellableCost: sum('sellable_cost'), expiredCost: sum('expired_cost'),
        blockedCost: sum('blocked_cost'), sellableRetailValue: sum('sellable_retail'),
      },
      byCategory: num(rows, ['products', 'batches', 'units']),
    };
  });
}

async function lowStock(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await reportRepository.lowStock(conn, f);
    return paginated(num(rows, ['current_stock', 'minimum_stock', 'units_to_minimum']), total, f);
  });
}

async function expiring(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => {
    const { rows, summary } = await reportRepository.expiringBatches(conn, f, q.days);
    return {
      ...paginated(rows.map((r) => ({ ...r, days_to_expiry: Number(r.days_to_expiry), is_expired: Boolean(Number(r.is_expired)) })), summary.total, f),
      summary: { batches: Number(summary.total), expiredBatches: Number(summary.expired), expiredCost: summary.expired_cost, expiringCost: summary.expiring_cost, windowDays: q.days },
    };
  });
}

async function movements(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => {
    const rows = num(await reportRepository.inventoryMovements(conn, f), ['movements', 'units']);
    const total = (dir) => rows.filter((r) => r.direction === dir).reduce((a, r) => a + r.units, 0);
    return { period: { from: f.from, to: f.to }, unitsIn: total('IN'), unitsOut: total('OUT'), byType: rows };
  });
}

async function returnsReport(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => {
    const summary = await salesSummaryInternal(conn, f);
    const b = await reportRepository.returnsBreakdown(conn, f);
    return {
      period: { from: f.from, to: f.to }, returns: summary.returns, voids: summary.voids,
      byStatus: num(b.byStatus, ['count']), byReason: num(b.byReason, ['count']), byCondition: num(b.byCondition, ['units']),
    };
  });
}

async function ordersReport(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => {
    const { byStatus, totals } = await reportRepository.ordersBreakdown(conn, f);
    const orders = Number(totals.orders);
    return {
      period: { from: f.from, to: f.to },
      orders, completed: Number(totals.completed), cancelledOrRejected: Number(totals.cancelled_or_rejected),
      completionRate: ratio(Number(totals.completed), orders), completedTotal: totals.completed_total,
      averageCompletedOrder: fromCents(Math.round(Number(totals.average_completed) * 100)),
      byStatus: num(byStatus, ['count']),
    };
  });
}

async function cashReport(auth, q, ctx) {
  const f = await scope(auth, q);
  return withConnection(ctx, async (conn) => {
    const { sessions, totals, movements: mv } = await reportRepository.cashBreakdown(conn, f);
    return {
      period: { from: f.from, to: f.to },
      totals: { sessions: Number(totals.sessions), openSessions: Number(totals.open_sessions), expectedClosed: totals.expected_closed, counted: totals.counted, difference: totals.difference },
      movements: num(mv, ['count']),
      ...paginated(sessions, Number(totals.sessions), f),
    };
  });
}

async function activityReport(auth, q, ctx) {
  // Por defecto, los últimos 30 días hasta hoy.
  const f = await scope(auth, { ...q, from: q.from ?? addDays(todayLima(), -30), to: q.to ?? todayLima() });
  return withConnection(ctx, async (conn) => {
    const { rows, total } = await reportRepository.activity(conn, f);
    return paginated(rows, total, f);
  });
}

async function dashboard(auth, q, ctx) {
  const today = todayLima();
  const f = await scope(auth, { ...q, from: today, to: today });
  const y = { ...f, from: addDays(today, -1), to: addDays(today, -1) };
  return withConnection(ctx, async (conn) => {
    const todaySum = await salesSummaryInternal(conn, f);
    const yesterday = await salesSummaryInternal(conn, y);
    const counters = await reportRepository.dashboardCounters(conn, f);
    const low = await reportRepository.lowStock(conn, { ...f, page: 1, pageSize: 1 });
    const expiringSoon = await reportRepository.expiringBatches(conn, { ...f, page: 1, pageSize: 1 }, 30);
    return {
      date: today,
      sales: {
        netSales: todaySum.netSales, transactions: todaySum.transactions, averageTicket: todaySum.averageTicket,
        netRevenue: todaySum.netRevenue, grossMarginEstimated: todaySum.grossMarginEstimated,
        vsYesterdayPercent: ratio(c(todaySum.netSales) - c(yesterday.netSales), c(yesterday.netSales)),
      },
      openAlerts: Object.fromEntries(counters.alerts.map((a) => [a.alert_type, Number(a.count)])),
      activeOrders: Object.fromEntries(counters.orders.map((o) => [o.status, Number(o.count)])),
      openCashSessions: Number(counters.cash.open_sessions),
      lowStockProducts: low.total,
      batchesExpiringIn30Days: Number(expiringSoon.summary.total),
      definitions: DEFINITIONS,
    };
  });
}

module.exports = {
  salesSummary, salesCompare, salesSeries, topProducts, byCategory, byBranch, bySeller, paymentMethods, inventory, lowStock,
  expiring, movements, returnsReport, ordersReport, cashReport, activityReport, dashboard, DEFINITIONS,
};
