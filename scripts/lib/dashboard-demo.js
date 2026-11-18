'use strict';

/**
 * Generador de datos de demostración para el Dashboard (lógica; la CLI está en scripts/seed-dashboard-demo.js).
 *
 * Todas las ESCRITURAS pasan por los servicios reales del backend (mismas validaciones, triggers, FEFO,
 * pagos DEMO, auditoría y movimientos); aquí solo hay consultas SELECT para inspeccionar y verificar.
 *   - Ventas POS ............ saleService.createForDemo (= create + sold_at histórico validado en el servidor)
 *   - Caja demo ............. adminService.createRegister, cashService.open / close (solo la sesión del RUN_ID)
 *   - Pedidos web ........... customerService.register, storeService.clear/setBranch/setItem, orderService.*
 *   - Devoluciones .......... returnService.create (process: aprobar + reingresar + reembolsar DEMO)
 *
 * Idempotencia: cada operación usa una clave derivada del RUN_ID (Idempotency-Key = request_id de la auditoría
 * y del kardex). Una ejecución interrumpida se reanuda con el mismo RUN_ID sin duplicar nada.
 */

const crypto = require('node:crypto');
const { withConnection } = require('../../src/config/database');
const saleService = require('../../src/services/sale.service');
const cashService = require('../../src/services/cash.service');
const orderService = require('../../src/services/order.service');
const storeService = require('../../src/services/store.service');
const customerService = require('../../src/services/customer.service');
const returnService = require('../../src/services/return.service');
const adminService = require('../../src/services/admin.service');
const permissionRepository = require('../../src/repositories/permission.repository');
const vp = require('../../src/validators/pos.validator');
const vs = require('../../src/validators/store.validator');
const vo = require('../../src/validators/operations.validator');

const POS_SALES = 25;
const WEB_ORDERS = 10;
const RETURNS = 3;
const DAYS = 30;
const REGISTER = { code: 'PPDEMO', name: 'Caja exclusiva de demostración Pharma Plus' };
const OPENING_AMOUNT = '200.00';
const DEMO_CUSTOMER_NAME = 'Cliente Demo Dashboard';
const POS_METHODS = ['CASH', 'YAPE', 'PLIN', 'CARD', 'TRANSFER'];
const WEB_METHODS = ['CARD', 'YAPE', 'PLIN', 'TRANSFER'];
const ORDER_TARGETS = ['PENDING', 'PENDING', 'CONFIRMED', 'CONFIRMED', 'PREPARING', 'PREPARING', 'READY_FOR_PICKUP', 'READY_FOR_PICKUP', 'COMPLETED', 'COMPLETED'];
const ORDER_FLOW = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'COMPLETED'];
// Topes sobre las existencias vendibles de cada producto: nunca se consumen las últimas unidades.
const POS_SHARE = 0.4;
const TOTAL_SHARE = 0.6;

const REQUIRED_PERMISSIONS = {
  pos: ['sales.create', 'payments.register', 'cash.open', 'cash.close'],
  orders: ['orders.view', 'orders.manage'],
  returns: ['returns.create', 'returns.approve', 'payments.refund'],
  register: ['branches.manage'], // solo si la caja demo aún no existe
};

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,39}$/;
const tagOf = (runId) => `DEMO-DASHBOARD:${runId}`;
const keyOf = (runId, kind, n, suffix = '') => `${runId}-${kind}-${String(n).padStart(2, '0')}${suffix ? `-${suffix}` : ''}`;
const demoEmail = (runId) => `demo.dashboard.${runId}@pharmaplus.test`;
const cents = (v) => Math.round(Number(v) * 100);
const money = (c) => (c / 100).toFixed(2);

class DemoError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.code = 'DEMO_PRECONDITION';
    this.problems = problems;
  }
}

function assertRunId(runId) {
  if (!RUN_ID_PATTERN.test(String(runId || ''))) {
    throw new DemoError('RUN_ID inválido: 6 a 40 caracteres (minúsculas, números y guiones), p. ej. dashboard-20261111-01');
  }
}

/** RUN_ID sugerido para el día (hora de Lima). */
function defaultRunId(now = new Date()) {
  const lima = new Date(now.getTime() - 5 * 3600000);
  return `dashboard-${lima.toISOString().slice(0, 10).replace(/-/g, '')}-01`;
}

/** PRNG determinista (mulberry32) sembrado con el RUN_ID: el mismo RUN_ID produce el mismo plan. */
function rngFor(runId) {
  let a = crypto.createHash('sha256').update(runId).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
function shuffle(rng, list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// =============================================================== lectura (SELECT)
const rows = async (conn, sql, params = []) => (await conn.execute(sql, params))[0];
const one = async (conn, sql, params = []) => (await rows(conn, sql, params))[0] || null;
const byKey = (list, key = 'k') => new Map(list.map((r) => [r[key], r]));

/** Estado actual relevante para el plan, solo con SELECT. */
async function readState(conn, { runId, branchId = null, executorId = null }) {
  const tag = tagOf(runId);
  const branch = branchId
    ? await one(conn, "SELECT id, code, name, is_main, status FROM branches WHERE id = ?", [branchId])
    : await one(conn, "SELECT id, code, name, is_main, status FROM branches WHERE is_main = TRUE AND status = 'ACTIVE' LIMIT 1");
  const state = { runId, tag, branch, executorId };
  if (!branch || branch.status !== 'ACTIVE') return state;
  const b = branch.id;

  state.activeProducts = Number((await one(conn, "SELECT COUNT(*) c FROM products WHERE status = 'ACTIVE'")).c);
  state.products = (await rows(conn, `
    SELECT p.id, p.sku, p.name, p.requires_prescription, COALESCE(bp.minimum_stock, 0) AS minimum_stock, COALESCE(bp.sale_price, p.sale_price) AS price,
           (SELECT COALESCE(SUM(pb.current_quantity), 0) FROM product_batches pb
             WHERE pb.branch_id = ? AND pb.product_id = p.id AND pb.status = 'ACTIVE'
               AND pb.current_quantity > 0 AND pb.expiry_date > CURDATE()) AS sellable,
           (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE o.branch_id = ? AND o.status = 'PENDING' AND oi.product_id = p.id) AS reserved
      FROM products p LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
     WHERE p.status = 'ACTIVE' AND COALESCE(bp.is_available, TRUE) = TRUE
     ORDER BY p.id`, [b, b, b])).map((p) => ({
    id: Number(p.id), sku: p.sku, name: p.name, rx: Number(p.requires_prescription) === 1, minimumStock: Number(p.minimum_stock || 0),
    priceCents: cents(p.price), sellable: Number(p.sellable), reserved: Number(p.reserved),
  }));

  // Lo que esta misma ejecución ya consumió o reingresó (para reconstruir el plan original al reanudar).
  const used = new Map();
  const add = (pid, q) => used.set(Number(pid), (used.get(Number(pid)) || 0) + Number(q));
  for (const r of await rows(conn, `
    SELECT si.product_id, SUM(si.quantity) q FROM sale_items si
      JOIN audit_logs a ON a.entity_table = 'sales' AND a.action = 'CREATE' AND a.entity_id = si.sale_id
     WHERE a.request_id LIKE ? GROUP BY si.product_id`, [`${runId}-pos-%`])) add(r.product_id, r.q);
  for (const r of await rows(conn, `
    SELECT oi.product_id, SUM(oi.quantity) q FROM order_items oi
      JOIN audit_logs a ON a.entity_table = 'orders' AND a.action = 'CREATE' AND a.entity_id = oi.order_id
      JOIN orders o ON o.id = oi.order_id AND o.status NOT IN ('CANCELLED', 'REJECTED')
     WHERE a.request_id LIKE ? GROUP BY oi.product_id`, [`${runId}-ord-%`])) add(r.product_id, r.q);
  for (const r of await rows(conn, `
    SELECT si.product_id, SUM(ri.quantity) q FROM sale_return_items ri
      JOIN sale_returns sr ON sr.id = ri.sale_return_id JOIN sale_item_batches sib ON sib.id = ri.sale_item_batch_id
      JOIN sale_items si ON si.id = sib.sale_item_id
     WHERE sr.notes LIKE ? AND sr.status = 'COMPLETED' AND ri.restock = TRUE GROUP BY si.product_id`, [`${tag}%`])) add(r.product_id, -Number(r.q));
  for (const p of state.products) {
    p.available = Math.max(p.sellable - p.reserved, 0);
    p.baseline = p.available + (used.get(p.id) || 0);
  }

  state.customersActive = Number((await one(conn, 'SELECT COUNT(*) c FROM customers WHERE is_active = TRUE')).c);
  state.customerAccounts = Number((await one(conn, `
    SELECT COUNT(*) c FROM customers c JOIN users u ON u.id = c.user_id JOIN roles r ON r.id = u.role_id
     WHERE c.is_active = TRUE AND u.status = 'ACTIVE' AND r.code = 'CUSTOMER'`)).c);
  // Clientes existentes para asociar a algunas ventas POS (sin las cuentas demo; nunca se modifican).
  state.posCustomers = (await rows(conn, `
    SELECT id FROM customers WHERE is_active = TRUE AND (email IS NULL OR email NOT LIKE 'demo.dashboard.%')
     ORDER BY id LIMIT 30`)).map((r) => Number(r.id));
  state.demoCustomer = await one(conn, `
    SELECT u.id user_id, u.status, r.code role_code, c.id customer_id, c.is_active
      FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN customers c ON c.user_id = u.id
     WHERE u.email = ?`, [demoEmail(runId)]);

  state.register = await one(conn, 'SELECT id, branch_id, code, name, is_active FROM cash_registers WHERE branch_id = ? AND code = ?', [b, REGISTER.code]);
  state.registerSession = state.register
    ? await one(conn, "SELECT id, opened_by, opening_notes FROM cash_sessions WHERE cash_register_id = ? AND status = 'OPEN'", [state.register.id])
    : null;
  state.executorSession = executorId
    ? await one(conn, "SELECT id, cash_register_id, opening_notes FROM cash_sessions WHERE opened_by = ? AND status = 'OPEN'", [executorId])
    : null;
  state.runSessions = await rows(conn, 'SELECT id, status, opened_by FROM cash_sessions WHERE opening_notes = ? ORDER BY id', [tag]);

  state.reasons = await rows(conn, 'SELECT id, code FROM return_reasons WHERE is_active = TRUE ORDER BY id');
  state.rxRequired = ((await one(conn, "SELECT setting_value v FROM settings WHERE setting_key = 'sales.require_prescription_reference'"))?.v ?? 'true') === 'true';

  // Operaciones ya registradas por este RUN_ID.
  state.doneSales = byKey(await rows(conn, `
    SELECT a.request_id k, a.entity_id id FROM audit_logs a
     WHERE a.entity_table = 'sales' AND a.action = 'CREATE' AND a.request_id LIKE ?`, [`${runId}-pos-%`]));
  state.doneOrders = byKey(await rows(conn, `
    SELECT a.request_id k, o.id, o.status FROM audit_logs a JOIN orders o ON o.id = a.entity_id
     WHERE a.entity_table = 'orders' AND a.action = 'CREATE' AND a.request_id LIKE ?`, [`${runId}-ord-%`]));
  state.doneReturns = byKey(await rows(conn, 'SELECT notes k, id, status FROM sale_returns WHERE notes LIKE ?', [`${tag}%`]));
  return state;
}

// ========================================================================= plan
/** Fecha y hora (Lima) de la venta i: repartidas en los últimos 30 días, en horario comercial, nunca futuras. */
function soldAtFor(i, rng, now) {
  const offset = Math.round((DAYS - 1) - (i * (DAYS - 1)) / (POS_SALES - 1)); // 29 … 0
  const hour = pickInt(rng, 8, 20);
  const minute = pickInt(rng, 0, 59);
  const lima = new Date(now.getTime() - 5 * 3600000);
  let at = new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate() - offset, hour + 5, minute));
  // Hoy, aún sin llegar a esa hora: se usa una hora ya pasada (o el día anterior antes de abrir).
  if (at.getTime() > now.getTime() - 10 * 60000) {
    at = new Date(now.getTime() - pickInt(rng, 15, 90) * 60000);
    if ((at.getUTCHours() + 19) % 24 < 8) at = new Date(at.getTime() - 14 * 3600000);
  }
  return at;
}

/**
 * Plan determinista para el RUN_ID. Usa el stock «original» de la ejecución (disponible actual + lo que esta misma
 * ejecución ya consumió) para que al reanudar se obtenga exactamente el mismo plan.
 */
function buildPlan(state, { now = new Date() } = {}) {
  const rng = rngFor(state.runId);
  const short = state.runId.replace(/[^a-z0-9]/g, '').slice(-10).toUpperCase();
  const candidates = (state.products || []).filter((p) => p.priceCents > 0 && p.baseline >= 3);
  const posBudget = new Map(candidates.map((p) => [p.id, Math.floor(p.baseline * POS_SHARE)]));
  const totalBudget = new Map(candidates.map((p) => [p.id, Math.floor(p.baseline * TOTAL_SHARE)]));
  const methods = shuffle(rng, Array.from({ length: POS_SALES }, (_, i) => POS_METHODS[i % POS_METHODS.length]));

  const sales = [];
  for (let i = 0; i < POS_SALES; i += 1) {
    const soldAt = soldAtFor(i, rng, now);
    const want = pickInt(rng, 1, 4);
    const withCustomer = rng() < 0.45;
    const customerPick = rng();
    const pool = shuffle(rng, candidates).filter((p) => posBudget.get(p.id) > 0);
    const lines = [];
    for (const p of pool.slice(0, want)) {
      const q = Math.min(pickInt(rng, 1, 3), posBudget.get(p.id));
      posBudget.set(p.id, posBudget.get(p.id) - q);
      totalBudget.set(p.id, totalBudget.get(p.id) - q);
      lines.push({ productId: p.id, sku: p.sku, name: p.name, quantity: q, rx: p.rx, priceCents: p.priceCents,
        prescriptionReference: p.rx ? `DEMO-RX-${short}-${i + 1}-${p.id}` : undefined });
    }
    const customerId = withCustomer && state.posCustomers?.length ? state.posCustomers[Math.floor(customerPick * state.posCustomers.length)] : null;
    sales.push({ n: i + 1, key: keyOf(state.runId, 'pos', i + 1), soldAt, method: methods[i], customerId, lines });
  }
  const posFeasible = sales.every((s) => s.lines.length > 0);

  const orders = [];
  let ordersFeasible = true;
  for (let i = 0; i < WEB_ORDERS; i += 1) {
    const want = pickInt(rng, 1, 2);
    const pool = shuffle(rng, candidates).filter((p) => totalBudget.get(p.id) > 0);
    const lines = [];
    for (const p of pool.slice(0, want)) {
      const q = Math.min(pickInt(rng, 1, 2), totalBudget.get(p.id));
      totalBudget.set(p.id, totalBudget.get(p.id) - q);
      lines.push({ productId: p.id, sku: p.sku, name: p.name, quantity: q, rx: p.rx, priceCents: p.priceCents,
        prescription: p.rx ? `DEMO-RX-${short}-W${i + 1}-${p.id}` : undefined });
    }
    if (lines.length === 0) ordersFeasible = false;
    orders.push({ n: i + 1, key: keyOf(state.runId, 'ord', i + 1), method: WEB_METHODS[i % WEB_METHODS.length], target: ORDER_TARGETS[i], lines });
  }

  // Devoluciones: ventas POS de este plan pagadas con medios electrónicos DEMO (sin reembolso en efectivo).
  const electronic = sales.filter((s) => s.method !== 'CASH' && s.lines.length > 0);
  const chosen = [];
  for (const m of ['YAPE', 'CARD', 'PLIN', 'TRANSFER']) {
    const s = electronic.find((x) => x.method === m && !chosen.includes(x));
    if (s && chosen.length < RETURNS) chosen.push(s);
  }
  for (const s of electronic) if (chosen.length < RETURNS && !chosen.includes(s)) chosen.push(s);
  const returns = chosen.map((s, i) => ({ n: i + 1, sale: s, notes: `${state.tag}:RET-${String(i + 1).padStart(2, '0')}`, refundMethod: s.method }));

  const demand = new Map();
  const addDemand = (l) => demand.set(l.productId, (demand.get(l.productId) || 0) + l.quantity);
  sales.forEach((s) => s.lines.forEach(addDemand));
  const posUnits = [...demand.values()].reduce((a, q) => a + q, 0);
  if (ordersFeasible) orders.forEach((o) => o.lines.forEach(addDemand));
  return { sales, orders, returns, posFeasible, ordersFeasible, demand, posUnits, short };
}

// ================================================================= precondiciones
function preflight(state, plan, auth = null) {
  const problems = []; // bloquean la ejecución
  const warnings = [];
  const skip = { orders: null, returns: null };
  if (!state.branch) problems.push('No existe una sucursal principal activa (o la sucursal indicada no existe).');
  else if (state.branch.status !== 'ACTIVE') problems.push(`La sucursal ${state.branch.name} no está activa.`);
  if (!state.branch || state.branch.status !== 'ACTIVE') return { problems, warnings, skip };

  if (state.activeProducts === 0) problems.push('No hay productos activos.');
  const sellable = state.products.filter((p) => p.sellable > 0);
  if (state.activeProducts > 0 && sellable.length === 0) problems.push('No hay productos con lotes vendibles (activos, con stock y sin vencer) en la sucursal.');
  if (sellable.length > 0 && !plan.posFeasible) {
    problems.push(`Stock insuficiente para planificar ${POS_SALES} ventas sin consumir más del ${POS_SHARE * 100}% de las existencias de cada producto.`);
  }
  // El stock actual debe cubrir lo que falta por ejecutar.
  const pendingDemand = new Map();
  for (const s of plan.sales) if (!state.doneSales.has(s.key)) s.lines.forEach((l) => pendingDemand.set(l.productId, (pendingDemand.get(l.productId) || 0) + l.quantity));
  const byId = new Map(state.products.map((p) => [p.id, p]));
  for (const [pid, q] of pendingDemand) {
    const p = byId.get(pid);
    if (!p || p.available < q) problems.push(`Stock insuficiente de ${p ? p.name : `producto ${pid}`}: se necesitan ${q} y hay ${p ? p.available : 0} disponibles.`);
  }

  // Caja de demostración exclusiva.
  if (state.register) {
    if (state.register.name !== REGISTER.name) {
      problems.push(`Existe una caja con código ${REGISTER.code} que no es la caja de demostración («${state.register.name}»): no se usará.`);
    } else if (!Number(state.register.is_active)) problems.push(`La caja ${REGISTER.code} está inactiva.`);
    if (state.registerSession && state.registerSession.opening_notes !== state.tag) {
      problems.push(`La caja ${REGISTER.code} tiene una sesión abierta que no pertenece a esta ejecución (sesión ${state.registerSession.id}).`);
    }
  }
  if (state.executorSession && state.executorSession.opening_notes !== state.tag) {
    problems.push(`El usuario ejecutor tiene una sesión de caja REAL abierta (sesión ${state.executorSession.id}). Ciérrela antes: el generador no la usará ni la modificará.`);
  }

  if (auth) {
    if (auth.user?.role?.code !== 'ADMIN') problems.push('El usuario ejecutor debe ser un administrador.');
    if (auth.user?.status && auth.user.status !== 'ACTIVE') problems.push('La cuenta del usuario ejecutor no está activa.');
    if (!auth.branches?.some((x) => x.id === state.branch.id)) problems.push(`El usuario ejecutor no está asignado a la sucursal ${state.branch.name}.`);
    const need = [...REQUIRED_PERMISSIONS.pos, ...(state.register ? [] : REQUIRED_PERMISSIONS.register)];
    const missing = need.filter((p) => !auth.permissions.has(p));
    if (missing.length) problems.push(`Faltan permisos: ${missing.join(', ')}.`);
    const missingOrders = REQUIRED_PERMISSIONS.orders.filter((p) => !auth.permissions.has(p));
    if (missingOrders.length) skip.orders = `faltan permisos ${missingOrders.join(', ')}`;
    const missingReturns = REQUIRED_PERMISSIONS.returns.filter((p) => !auth.permissions.has(p));
    if (missingReturns.length) skip.returns = `faltan permisos ${missingReturns.join(', ')}`;
  }

  if (!skip.orders && !plan.ordersFeasible) skip.orders = `no queda stock suficiente después de reservar lo necesario para las ${POS_SALES} ventas POS`;
  if (!skip.returns) {
    if (state.reasons.length === 0) skip.returns = 'no hay motivos de devolución activos';
    else if (plan.returns.length < RETURNS) skip.returns = `solo ${plan.returns.length} ventas del plan tienen pago electrónico DEMO`;
  }
  if (state.demoCustomer && (state.demoCustomer.role_code !== 'CUSTOMER' || !state.demoCustomer.customer_id)) {
    skip.orders = skip.orders || `la cuenta ${demoEmail(state.runId)} existe pero no es un cliente con ficha`;
  }

  // Aviso: productos que quedarían por debajo de su stock mínimo.
  for (const [pid, q] of plan.demand) {
    const p = byId.get(pid);
    if (p && p.minimumStock > 0 && p.baseline - q < p.minimumStock) warnings.push(`${p.name} quedará por debajo de su stock mínimo (${p.baseline - q} < ${p.minimumStock}).`);
  }
  return { problems, warnings, skip };
}

/** Resumen legible del plan (simulación y confirmación). */
function summarize(state, plan, pf) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  push(`RUN_ID ............... ${state.runId}`);
  if (!state.branch) { push('Sucursal ............. (no disponible)'); return lines.join('\n'); }
  push(`Sucursal ............. ${state.branch.name} (id ${state.branch.id})`);
  push(`Productos activos .... ${state.activeProducts ?? 0}`);
  const sellable = (state.products || []).filter((p) => p.sellable > 0);
  push(`Con lotes vendibles .. ${sellable.length} productos · ${sellable.reduce((a, p) => a + p.sellable, 0)} unidades (${sellable.reduce((a, p) => a + p.reserved, 0)} reservadas por pedidos pendientes)`);
  push(`Clientes activos ..... ${state.customersActive} · cuentas de cliente para pedidos: ${state.customerAccounts}`);
  push(`Cliente demo ......... ${state.demoCustomer ? `existente (${demoEmail(state.runId)})` : `se creará: ${DEMO_CUSTOMER_NAME} <${demoEmail(state.runId)}>`}`);
  push(`Caja demo ............ ${state.register ? `${state.register.code} · ${state.register.name} (id ${state.register.id})` : `se creará: ${REGISTER.code} · ${REGISTER.name}`}`);
  push(`Permisos necesarios .. ${[...REQUIRED_PERMISSIONS.pos, ...REQUIRED_PERMISSIONS.orders, ...REQUIRED_PERMISSIONS.returns].join(', ')}${state.register ? '' : `, ${REQUIRED_PERMISSIONS.register.join(', ')}`}`);
  push();
  const done = plan.sales.filter((s) => state.doneSales.has(s.key)).length;
  push(`Ventas POS ........... ${plan.sales.length} planificadas${done ? ` (${done} ya registradas por este RUN_ID)` : ''} · ${plan.posUnits} unidades`);
  const days = new Set(plan.sales.map((s) => new Date(s.soldAt.getTime() - 5 * 3600000).toISOString().slice(0, 10)));
  push(`  fechas ............. ${days.size} días distintos, del ${[...days].sort()[0]} al ${[...days].sort().slice(-1)[0]} (hora de Lima)`);
  const byMethod = {};
  plan.sales.forEach((s) => { byMethod[s.method] = (byMethod[s.method] || 0) + 1; });
  push(`  pagos .............. ${POS_METHODS.map((m) => `${m} ${byMethod[m] || 0}`).join(' · ')} (electrónicos simulados DEMO)`);
  push(`  con cliente ........ ${plan.sales.filter((s) => s.customerId).length} · ventas rápidas: ${plan.sales.filter((s) => !s.customerId).length}`);
  const estimate = plan.sales.reduce((a, s) => a + s.lines.reduce((b, l) => b + l.priceCents * l.quantity, 0), 0);
  push(`  importe estimado ... S/ ${money(estimate)} (el total real lo calcula el servidor)`);
  if (pf.skip.orders) push(`Pedidos web .......... se omiten: ${pf.skip.orders}`);
  else {
    const st = {};
    plan.orders.forEach((o) => { st[o.target] = (st[o.target] || 0) + 1; });
    push(`Pedidos web .......... ${plan.orders.length} (recojo en tienda) · ${plan.orders.reduce((a, o) => a + o.lines.reduce((b, l) => b + l.quantity, 0), 0)} unidades · ${Object.entries(st).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  if (pf.skip.returns) push(`Devoluciones ......... se omiten: ${pf.skip.returns}`);
  else push(`Devoluciones ......... ${plan.returns.length} (1 unidad cada una, reembolso ${plan.returns.map((r) => r.refundMethod).join('/')} DEMO, motivo ${(state.reasons.find((r) => r.code === 'CUSTOMER_CHANGE') || state.reasons[0]).code})`);
  push();
  push('Stock proyectado (productos usados):');
  const byId = new Map(state.products.map((p) => [p.id, p]));
  for (const [pid, q] of [...plan.demand].sort((a, b) => a[0] - b[0])) {
    const p = byId.get(pid);
    const ordQ = pf.skip.orders ? plan.orders.reduce((a, o) => a + o.lines.filter((l) => l.productId === pid).reduce((b, l) => b + l.quantity, 0), 0) : 0;
    push(`  ${p.sku.padEnd(14)} ${p.name.slice(0, 34).padEnd(34)} ${String(p.baseline).padStart(6)} → ${String(p.baseline - q + ordQ).padStart(6)}`);
  }
  if (pf.warnings.length) { push(); push('Advertencias:'); pf.warnings.forEach((w) => push(`  - ${w}`)); }
  push();
  if (pf.problems.length) { push('Problemas que impiden ejecutar:'); pf.problems.forEach((p) => push(`  ✖ ${p}`)); } else push('Sin problemas bloqueantes.');
  return lines.join('\n');
}

/** Simulación de solo lectura. */
async function dryRun({ runId, branchId = null, executorId = null, now = new Date() }, ctx = {}) {
  assertRunId(runId);
  return withConnection({ ...ctx, requestId: `${runId}-dryrun` }, async (conn) => {
    const state = await readState(conn, { runId, branchId, executorId });
    const plan = state.branch && state.branch.status === 'ACTIVE' ? buildPlan(state, { now }) : { sales: [], orders: [], returns: [], demand: new Map(), posUnits: 0 };
    const pf = preflight(state, plan);
    return { state, plan, preflight: pf, text: summarize(state, plan, pf) };
  });
}

// ================================================================== instantáneas
async function snapshot(conn, runId) {
  const tag = tagOf(runId);
  const s = await one(conn, `SELECT COUNT(*) c, COALESCE(MAX(id), 0) max_id,
      COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, total, sold_at, cash_session_id, customer_id))), 0) h FROM sales`);
  const cs = await one(conn, `SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, opened_by, opened_at, opening_amount,
      closed_at, counted_amount, expected_amount))), 0) h FROM cash_sessions WHERE opening_notes IS NULL OR opening_notes <> ?`, [tag]);
  const p = await one(conn, `SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, amount, refunded_at))), 0) h
      FROM payments WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM payments)`);
  const r = await one(conn, "SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, refund_amount))), 0) h FROM sale_returns");
  const o = await one(conn, "SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, total))), 0) h FROM orders");
  const mv = await one(conn, 'SELECT COALESCE(MAX(id), 0) max_id FROM inventory_movements');
  const batches = await rows(conn, 'SELECT id, current_quantity q FROM product_batches');
  return {
    salesCount: Number(s.c), salesMaxId: Number(s.max_id), salesHash: String(s.h),
    realCashCount: Number(cs.c), realCashHash: String(cs.h), paymentsCount: Number(p.c),
    returnsCount: Number(r.c), returnsHash: String(r.h), ordersCount: Number(o.c), ordersHash: String(o.h),
    movementMaxId: Number(mv.max_id), batches: new Map(batches.map((b) => [Number(b.id), Number(b.q)])),
  };
}

// ==================================================================== ejecución
/**
 * Ejecuta el plan con los servicios reales. `auth` es el contexto del administrador que inició sesión con
 * auth.service.login. `hooks.failAfterSale` (solo pruebas) simula una caída tras esa venta.
 */
async function execute({ runId, auth, branchId = null, ctx = {}, now = new Date(), log = () => {}, hooks = {} }) {
  assertRunId(runId);
  const tag = tagOf(runId);
  const base = { ip: ctx.ip ?? '127.0.0.1', userAgent: ctx.userAgent ?? 'seed-dashboard-demo', userId: auth.userId, sessionRef: auth.jti ?? null };
  const read = (fn) => withConnection({ ...base, requestId: `${runId}-read` }, fn);

  const { state, plan, pf } = await read(async (conn) => {
    const st = await readState(conn, { runId, branchId, executorId: auth.userId });
    const pl = buildPlan(st, { now });
    return { state: st, plan: pl, pf: preflight(st, pl, auth) };
  });
  if (pf.problems.length) throw new DemoError('No se cumplen las precondiciones; no se escribió nada.', pf.problems);
  const b = state.branch.id;
  const staffCtx = (requestId) => ({ ...base, branchId: b, requestId });
  const before = await read((conn) => snapshot(conn, runId));
  const result = { runId, created: { sales: 0, orders: 0, returns: 0, customer: false, register: false, session: false }, skipped: { ...pf.skip }, notes: [] };

  // ---------------------------------------------------------------- caja demo
  let registerId = state.register?.id;
  if (!registerId) {
    const reg = await adminService.createRegister(b, { code: REGISTER.code, name: REGISTER.name }, staffCtx(`${runId}-register`));
    registerId = reg.id;
    result.created.register = true;
    log(`Caja ${REGISTER.code} creada (id ${registerId}).`);
  }
  const pendingSales = plan.sales.filter((s) => !state.doneSales.has(s.key));
  const pendingReturns = pf.skip.returns ? [] : plan.returns.filter((r) => !state.doneReturns.has(r.notes));
  let sessionId = state.executorSession && state.executorSession.opening_notes === tag ? state.executorSession.id : null;
  if (!sessionId && pendingSales.length > 0) {
    const s = await cashService.open(vp.sessionOpen.parse({ cashRegisterId: registerId, openingAmount: OPENING_AMOUNT, notes: tag }), auth, staffCtx(`${runId}-cash-open`));
    sessionId = s.id;
    result.created.session = true;
    log(`Sesión de caja demo ${s.sessionNumber} abierta con S/ ${OPENING_AMOUNT}.`);
  } else if (sessionId) log(`Se reanuda la sesión de caja demo ${sessionId} de este RUN_ID.`);

  // ---------------------------------------------------------------- ventas POS
  for (const s of plan.sales) {
    if (state.doneSales.has(s.key)) continue;
    const body = vp.saleCreate.parse({
      branchId: b,
      items: s.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, ...(l.prescriptionReference ? { prescriptionReference: l.prescriptionReference } : {}) })),
      ...(s.customerId ? { customer: { customerId: s.customerId } } : {}),
      notes: `${tag} · Venta POS ${s.n}/${POS_SALES}`,
      payments: [{ method: s.method, simulate: 'APPROVE' }],
    });
    const sale = await saleService.createForDemo(body, auth, staffCtx(s.key), { idempotencyKey: s.key, soldAt: s.soldAt });
    if (!sale.idempotentReplay) result.created.sales += 1;
    state.doneSales.set(s.key, { k: s.key, id: sale.id });
    log(`Venta ${s.n}/${POS_SALES} ${sale.saleNumber} · ${s.method} · S/ ${sale.total}`);
    if (hooks.failAfterSale === s.n) throw new Error(`Falla simulada después de la venta ${s.n}`);
  }

  // -------------------------------------------------------------- devoluciones
  if (!pf.skip.returns) {
    const reason = state.reasons.find((r) => r.code === 'CUSTOMER_CHANGE') || state.reasons[0];
    for (const r of plan.returns) {
      if (state.doneReturns.has(r.notes)) continue;
      const saleId = Number(state.doneSales.get(r.sale.key).id);
      const info = await returnService.returnable(saleId, auth, staffCtx(`${runId}-read`));
      const item = info.items.find((i) => i.returnableQuantity > 0);
      if (!item) { result.notes.push(`Devolución ${r.n}: la venta ya no tiene unidades por devolver.`); continue; }
      const body = vo.returnCreate.parse({
        saleId, reasonCode: reason.code, notes: r.notes, process: true, refundMethod: r.refundMethod,
        items: [{ saleItemBatchId: item.saleItemBatchId, quantity: 1, condition: item.isExpired ? 'EXPIRED' : 'RESELLABLE' }],
      });
      const ret = await returnService.create(body, auth, staffCtx(keyOf(runId, 'ret', r.n)));
      result.created.returns += 1;
      log(`Devolución ${ret.returnNumber} · ${ret.refundMethod} · S/ ${ret.refundAmount}`);
    }
  }
  if (pendingReturns.length === 0 && !pf.skip.returns) log('Devoluciones: ya estaban registradas.');

  // --------------------------------------------------- cierre de la caja demo
  if (sessionId) {
    const detail = await cashService.get(sessionId, auth, staffCtx(`${runId}-read`));
    const closed = await cashService.close(sessionId, vp.sessionClose.parse({ countedAmount: detail.expectedAmount, notes: tag }), auth, staffCtx(`${runId}-cash-close`));
    result.sessionClosed = { id: closed.id, expected: closed.expectedAmount, counted: closed.countedAmount, difference: closed.differenceAmount };
    log(`Caja demo cerrada: esperado S/ ${closed.expectedAmount}, contado S/ ${closed.countedAmount}.`);
  }

  // ---------------------------------------------------------------- pedidos web
  if (!pf.skip.orders) {
    const customerAuth = await ensureDemoCustomer(runId, state, base, result, log);
    const cctx = (requestId) => ({ ...base, userId: customerAuth.userId, branchId: null, sessionRef: null, requestId });
    for (const o of plan.orders) {
      let order = state.doneOrders.get(o.key);
      if (!order) {
        await storeService.clear(customerAuth, cctx(`${o.key}-cart`));
        await storeService.setBranch(customerAuth, b, cctx(`${o.key}-cart`));
        for (const l of o.lines) await storeService.setItem(customerAuth, l.productId, vs.cartItem.parse({ quantity: l.quantity }).quantity, cctx(`${o.key}-cart`));
        const prescriptions = Object.fromEntries(o.lines.filter((l) => l.prescription).map((l) => [String(l.productId), l.prescription]));
        const body = vs.checkout.parse({
          branchId: b, fulfillmentType: 'PICKUP', paymentMethod: o.method, simulatePayment: 'APPROVE',
          customerNote: `${tag} · Pedido ${o.n}/${WEB_ORDERS}`, ...(Object.keys(prescriptions).length ? { prescriptions } : {}),
        });
        const created = await orderService.checkout(body, customerAuth, cctx(o.key), { idempotencyKey: o.key });
        if (!created.idempotentReplay) result.created.orders += 1;
        order = { id: created.id, status: created.status };
        log(`Pedido ${o.n}/${WEB_ORDERS} ${created.orderNumber} · ${o.method} · S/ ${created.total}`);
      }
      const prescriptions = Object.fromEntries(o.lines.filter((l) => l.prescription).map((l) => [String(l.productId), l.prescription]));
      let status = order.status;
      const target = ORDER_FLOW.indexOf(o.target);
      while (ORDER_FLOW.indexOf(status) >= 0 && ORDER_FLOW.indexOf(status) < target) {
        const sctx = staffCtx(`${o.key}-${ORDER_FLOW[ORDER_FLOW.indexOf(status) + 1].toLowerCase()}`);
        let next;
        if (status === 'PENDING') next = await orderService.accept(order.id, { prescriptions, note: tag }, auth, sctx);
        else if (status === 'CONFIRMED') next = await orderService.prepare(order.id, auth, sctx);
        else if (status === 'PREPARING') next = await orderService.ready(order.id, auth, sctx);
        else next = await orderService.complete(order.id, {}, auth, sctx);
        status = next.status;
      }
      if (status !== o.target) result.notes.push(`Pedido ${o.n}: quedó en ${status} (objetivo ${o.target}).`);
    }
  }

  const after = await read((conn) => snapshot(conn, runId));
  result.verification = await verify(runId, { before, after, branchId: b, ctx: base });
  return result;
}

/** Cliente demo del RUN_ID: se reutiliza si existe; si no, se registra con customer.service.register. */
async function ensureDemoCustomer(runId, state, base, result, log) {
  let userId = state.demoCustomer?.user_id;
  if (!userId) {
    // Contraseña aleatoria y fuerte: solo se guarda su hash (customer.service). No se muestra ni se almacena.
    const password = `Pp${crypto.randomBytes(18).toString('base64url')}7a`;
    const body = vs.register.parse({ fullName: DEMO_CUSTOMER_NAME, email: demoEmail(runId), password });
    const profile = await customerService.register(body, { ...base, requestId: `${runId}-customer` });
    userId = profile.userId;
    result.created.customer = true;
    log(`Cliente demo creado: ${demoEmail(runId)}.`);
  }
  return withConnection({ ...base, requestId: `${runId}-read` }, async (conn) => {
    const u = await one(conn, `SELECT u.id, u.full_name, u.email, u.status, r.code role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [userId]);
    if (!u || u.role_code !== 'CUSTOMER' || u.status !== 'ACTIVE' || u.email !== demoEmail(runId)) {
      throw new DemoError(`La cuenta ${demoEmail(runId)} no es un cliente demo activo; no se usará.`);
    }
    const permissions = new Set((await permissionRepository.findEffectiveByUserId(conn, userId)).map((p) => p.permission_code));
    for (const p of ['store.cart', 'store.orders']) if (!permissions.has(p)) throw new DemoError(`El rol de clientes no tiene el permiso ${p}.`);
    // Contexto de cliente para los servicios de la tienda (los mismos que usa la API con su sesión).
    return { userId: Number(u.id), branchId: null, user: { id: Number(u.id), fullName: u.full_name, email: u.email, role: { code: 'CUSTOMER' } }, branches: [], permissions };
  });
}

// ================================================================= verificación
async function verify(runId, { before = null, after = null, branchId = null, ctx = {} } = {}) {
  const tag = tagOf(runId);
  return withConnection({ ...ctx, requestId: `${runId}-verify` }, async (conn) => {
    const issues = [];
    const sales = await rows(conn, `
      SELECT s.id, s.sale_number, s.status, s.total, s.sold_at, s.customer_id, DATE(s.sold_at) d
        FROM sales s JOIN audit_logs a ON a.entity_table = 'sales' AND a.action = 'CREATE' AND a.entity_id = s.id
       WHERE a.request_id LIKE ? ORDER BY s.sold_at`, [`${runId}-pos-%`]);
    const saleIds = sales.map((s) => s.id);
    const orders = await rows(conn, `
      SELECT o.id, o.status, o.total, (SELECT s.id FROM sales s WHERE s.order_id = o.id AND s.sale_channel = 'ONLINE' AND s.status = 'COMPLETED' LIMIT 1) sale_id
        FROM orders o JOIN audit_logs a ON a.entity_table = 'orders' AND a.action = 'CREATE' AND a.entity_id = o.id
       WHERE a.request_id LIKE ?`, [`${runId}-ord-%`]);
    const onlineSaleIds = orders.map((o) => o.sale_id).filter(Boolean);
    const allSaleIds = [...saleIds, ...onlineSaleIds];
    const inList = (ids) => (ids.length ? ids.map(() => '?').join(',') : 'NULL');

    // ------------------------------------------------------------ ventas POS
    const items = allSaleIds.length ? await rows(conn, `
      SELECT si.id, si.sale_id, si.product_id, si.quantity,
             (SELECT COALESCE(SUM(sib.quantity), 0) FROM sale_item_batches sib WHERE sib.sale_item_id = si.id) allocated,
             (SELECT COUNT(*) FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
                AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.sale_item_batch_id = sib.id AND m.movement_type = 'SALE_OUT' AND m.quantity = sib.quantity)) missing_out
        FROM sale_items si WHERE si.sale_id IN (${inList(allSaleIds)})`, allSaleIds) : [];
    const pays = saleIds.length ? await rows(conn, `
      SELECT sale_id, method, status, amount, is_simulated, external_reference FROM payments WHERE sale_id IN (${inList(saleIds)})`, saleIds) : [];
    const posItems = items.filter((i) => saleIds.includes(i.sale_id));
    for (const s of sales) {
      const its = posItems.filter((i) => i.sale_id === s.id);
      const ps = pays.filter((p) => p.sale_id === s.id);
      if (its.length === 0) issues.push(`${s.sale_number}: sin detalle`);
      if (ps.length !== 1) issues.push(`${s.sale_number}: ${ps.length} pagos (se esperaba 1)`);
      const approved = ps.filter((p) => p.status === 'APPROVED').reduce((a, p) => a + cents(p.amount), 0);
      if (s.status === 'COMPLETED' && approved !== cents(s.total)) issues.push(`${s.sale_number}: pagos S/ ${money(approved)} ≠ total S/ ${s.total}`);
      for (const p of ps) {
        if (p.method !== 'CASH' && (!Number(p.is_simulated) || !/^DEMO-/.test(p.external_reference || ''))) issues.push(`${s.sale_number}: pago ${p.method} no simulado`);
        if (p.method === 'CASH' && Number(p.is_simulated)) issues.push(`${s.sale_number}: pago en efectivo marcado como simulado`);
      }
    }
    for (const i of items) {
      if (Number(i.allocated) !== Number(i.quantity)) issues.push(`línea ${i.id}: lotes asignados ${i.allocated} ≠ cantidad ${i.quantity}`);
      if (Number(i.missing_out) > 0) issues.push(`línea ${i.id}: asignación de lote sin movimiento SALE_OUT`);
    }
    const byMethod = {};
    for (const p of pays.filter((x) => x.status === 'APPROVED' || x.status === 'REFUNDED')) {
      const m = (byMethod[p.method] ||= { count: 0, amount: 0, simulated: 0 });
      m.count += 1; m.amount += cents(p.amount); m.simulated += Number(p.is_simulated);
    }

    // -------------------------------------------------------------- pedidos
    const orderPays = orders.length ? await rows(conn, `SELECT order_id, method, status, is_simulated FROM payments WHERE order_id IN (${inList(orders.map((o) => o.id))})`, orders.map((o) => o.id)) : [];
    const statusCount = {};
    for (const o of orders) {
      statusCount[o.status] = (statusCount[o.status] || 0) + 1;
      if (!ORDER_FLOW.includes(o.status)) issues.push(`pedido ${o.id}: estado ${o.status}`);
      if (o.status !== 'PENDING' && !o.sale_id) issues.push(`pedido ${o.id}: ${o.status} sin venta ONLINE`);
      if (o.status === 'PENDING' && o.sale_id) issues.push(`pedido ${o.id}: PENDING con venta`);
      const op = orderPays.filter((p) => p.order_id === o.id);
      if (op.length !== 1 || !Number(op[0].is_simulated)) issues.push(`pedido ${o.id}: pago DEMO inválido`);
    }

    // --------------------------------------------------------- devoluciones
    const rets = await rows(conn, `
      SELECT sr.id, sr.status, sr.refund_amount, sr.refund_method, sr.refund_status, sr.refund_operation_code, sr.sale_id,
             (SELECT COALESCE(SUM(ri.quantity), 0) FROM sale_return_items ri WHERE ri.sale_return_id = sr.id AND ri.restock = TRUE) restocked,
             (SELECT COUNT(*) FROM sale_return_items ri WHERE ri.sale_return_id = sr.id AND ri.restock = TRUE
                AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.sale_return_item_id = ri.id AND m.movement_type = 'RETURN_IN')) missing_in
        FROM sale_returns sr WHERE sr.notes LIKE ?`, [`${tag}%`]);
    for (const r of rets) {
      if (!saleIds.includes(r.sale_id)) issues.push(`devolución ${r.id}: no corresponde a una venta de esta ejecución`);
      if (r.status !== 'COMPLETED' || r.refund_status !== 'REFUNDED') issues.push(`devolución ${r.id}: ${r.status}/${r.refund_status}`);
      if (r.refund_method === 'CASH' || !/^DEMO-REFUND-/.test(r.refund_operation_code || '')) issues.push(`devolución ${r.id}: reembolso no DEMO`);
      if (Number(r.missing_in) > 0) issues.push(`devolución ${r.id}: falta RETURN_IN`);
    }

    // ----------------------------------------------------------- inventario
    const mv = await one(conn, `
      SELECT SUM(movement_type = 'SALE_OUT') sale_out, SUM(movement_type = 'RETURN_IN') return_in,
             COALESCE(SUM(CASE WHEN movement_type = 'SALE_OUT' THEN quantity END), 0) out_units,
             COALESCE(SUM(CASE WHEN movement_type = 'RETURN_IN' THEN quantity END), 0) in_units
        FROM inventory_movements WHERE request_id LIKE ?`, [`${runId}-%`]);
    const touched = await rows(conn, `
      SELECT pb.id, pb.current_quantity, pb.product_id,
             (SELECT m.batch_stock_after FROM inventory_movements m WHERE m.batch_id = pb.id ORDER BY m.id DESC LIMIT 1) last_after
        FROM product_batches pb WHERE pb.id IN (SELECT batch_id FROM inventory_movements WHERE request_id LIKE ?)`, [`${runId}-%`]);
    for (const t of touched) if (Number(t.last_after) !== Number(t.current_quantity)) issues.push(`lote ${t.id}: stock ${t.current_quantity} ≠ último movimiento ${t.last_after}`);
    const finalStock = touched.length ? Number((await one(conn, `
      SELECT COALESCE(SUM(current_quantity), 0) q FROM product_batches
       WHERE status = 'ACTIVE' AND product_id IN (${inList([...new Set(touched.map((t) => t.product_id))])})`, [...new Set(touched.map((t) => t.product_id))])).q) : 0;

    // ------------------------------------------------------------------ caja
    const sessions = await rows(conn, `SELECT cs.id, cs.status, cs.opening_amount, cs.expected_amount, cs.counted_amount, cs.difference_amount, cr.code, cr.name
        FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id WHERE cs.opening_notes = ?`, [tag]);
    for (const s of sessions) if (s.code !== REGISTER.code || s.name !== REGISTER.name) issues.push(`sesión ${s.id}: no es la caja demo`);

    // ------------------------------------------- comparación antes / después
    const integrity = {};
    if (before && after) {
      const prior = await one(conn, `SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, total, sold_at, cash_session_id, customer_id))), 0) h
          FROM sales WHERE id <= ?`, [before.salesMaxId]);
      integrity.previousSalesIntact = Number(prior.c) === before.salesCount && String(prior.h) === before.salesHash;
      integrity.realCashIntact = after.realCashCount === before.realCashCount && after.realCashHash === before.realCashHash;
      if (!integrity.previousSalesIntact) issues.push('las ventas previas cambiaron');
      if (!integrity.realCashIntact) issues.push('las sesiones de caja reales cambiaron');
      // Cada cambio de stock debe explicarse con movimientos de esta ejecución.
      const runDelta = await rows(conn, `
        SELECT batch_id, SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) d
          FROM inventory_movements WHERE id > ? AND request_id LIKE ? GROUP BY batch_id`, [before.movementMaxId, `${runId}-%`]);
      const expected = new Map(runDelta.map((r) => [Number(r.batch_id), Number(r.d)]));
      const foreign = Number((await one(conn, 'SELECT COUNT(*) c FROM inventory_movements WHERE id > ? AND (request_id IS NULL OR request_id NOT LIKE ?)', [before.movementMaxId, `${runId}-%`])).c);
      let mismatched = 0;
      for (const [id, q] of after.batches) {
        const was = before.batches.get(id) ?? 0;
        if (q - was !== (expected.get(id) || 0)) mismatched += 1;
      }
      integrity.stockMatchesMovements = mismatched === 0;
      integrity.foreignMovementsDuringRun = foreign;
      if (mismatched && !foreign) issues.push(`${mismatched} lotes con cambios de stock no explicados por la ejecución`);
      if (foreign) issues.push(`${foreign} movimientos de inventario ajenos durante la ejecución (operación concurrente)`);
    }

    const days = new Set(sales.map((s) => String(s.d instanceof Date ? s.d.toISOString().slice(0, 10) : s.d).slice(0, 10)));
    return {
      pos: {
        count: sales.length, distinctDays: days.size,
        from: sales[0]?.sold_at ?? null, to: sales[sales.length - 1]?.sold_at ?? null,
        total: money(sales.filter((s) => s.status === 'COMPLETED').reduce((a, s) => a + cents(s.total), 0)),
        products: new Set(posItems.map((i) => i.product_id)).size, units: posItems.reduce((a, i) => a + Number(i.quantity), 0),
        withCustomer: sales.filter((s) => s.customer_id).length, quick: sales.filter((s) => !s.customer_id).length,
      },
      payments: Object.fromEntries(Object.entries(byMethod).map(([m, v]) => [m, { count: v.count, amount: money(v.amount), simulated: v.simulated }])),
      orders: { count: orders.length, byStatus: statusCount, onlineSales: onlineSaleIds.length, demoPayments: orderPays.filter((p) => Number(p.is_simulated)).length },
      returns: {
        count: rets.length, refunded: money(rets.reduce((a, r) => a + cents(r.refund_amount || 0), 0)),
        methods: [...new Set(rets.map((r) => r.refund_method))], restockedUnits: rets.reduce((a, r) => a + Number(r.restocked), 0),
      },
      inventory: {
        saleOut: Number(mv.sale_out || 0), returnIn: Number(mv.return_in || 0), unitsOut: Number(mv.out_units), unitsIn: Number(mv.in_units),
        finalStockOfUsedProducts: finalStock, branchId,
      },
      cashSessions: sessions.map((s) => ({ id: s.id, status: s.status, opening: s.opening_amount, expected: s.expected_amount, counted: s.counted_amount, difference: s.difference_amount })),
      integrity,
      issues,
    };
  });
}

function formatVerification(v) {
  const L = [];
  L.push(`Ventas POS ..... ${v.pos.count} · ${v.pos.distinctDays} días · S/ ${v.pos.total} · ${v.pos.products} productos · ${v.pos.units} unidades · con cliente ${v.pos.withCustomer} / rápidas ${v.pos.quick}`);
  L.push(`Pagos .......... ${Object.entries(v.payments).map(([m, x]) => `${m} ${x.count} (S/ ${x.amount}${m === 'CASH' ? '' : `, simulados ${x.simulated}`})`).join(' · ') || '—'}`);
  L.push(`Pedidos ........ ${v.orders.count} · ${Object.entries(v.orders.byStatus).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'} · ventas ONLINE ${v.orders.onlineSales} · pagos DEMO ${v.orders.demoPayments}`);
  L.push(`Devoluciones ... ${v.returns.count} · reembolsado S/ ${v.returns.refunded} (${v.returns.methods.join('/') || '—'}) · unidades reingresadas ${v.returns.restockedUnits}`);
  L.push(`Inventario ..... SALE_OUT ${v.inventory.saleOut} (${v.inventory.unitsOut} u.) · RETURN_IN ${v.inventory.returnIn} (${v.inventory.unitsIn} u.) · stock final de los productos usados ${v.inventory.finalStockOfUsedProducts}`);
  L.push(`Caja demo ...... ${v.cashSessions.map((s) => `sesión ${s.id} ${s.status} (apertura ${s.opening}, esperado ${s.expected ?? '—'}, contado ${s.counted ?? '—'}, diferencia ${s.difference ?? '—'})`).join(' · ') || '—'}`);
  if (Object.keys(v.integrity).length) {
    L.push(`Integridad ..... ventas previas intactas: ${v.integrity.previousSalesIntact ? 'sí' : 'NO'} · cajas reales intactas: ${v.integrity.realCashIntact ? 'sí' : 'NO'} · stock = movimientos: ${v.integrity.stockMatchesMovements ? 'sí' : 'NO'}`);
  }
  L.push(v.issues.length ? `Observaciones:\n${v.issues.map((i) => `  ✖ ${i}`).join('\n')}` : 'Verificación sin observaciones.');
  return L.join('\n');
}

module.exports = {
  POS_SALES, WEB_ORDERS, RETURNS, REGISTER, OPENING_AMOUNT, DEMO_CUSTOMER_NAME, REQUIRED_PERMISSIONS, ORDER_TARGETS,
  DemoError, assertRunId, defaultRunId, tagOf, keyOf, demoEmail,
  readState, buildPlan, preflight, summarize, dryRun, execute, verify, formatVerification, snapshot,
};
