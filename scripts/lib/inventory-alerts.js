'use strict';

/**
 * Generador de ALERTAS REALES de inventario para el Dashboard (la CLI está en scripts/seed-inventory-alerts.js).
 *
 * No inserta alertas: crea las condiciones de inventario que el sistema ya detecta por sí mismo.
 *   - Stock bajo / agotado: vw_branch_product_stock (available_stock ≤ minimum_stock / = 0) y el trigger de
 *     product_batches que abre LOW_STOCK / OUT_OF_STOCK en stock_alerts. Se consigue con adjustmentService.create
 *     (CORRECTION, salida ADJUSTMENT_OUT) sobre productos SIN reservas de pedidos pendientes.
 *   - Lotes próximos a vencer: inventory.expiry_alert_days (sp_refresh_expiry_alerts) y la tarjeta del Dashboard
 *     (lotes que vencen en 30 días). Se consigue con stockEntryService.create (entrada contabilizada con lotes
 *     DEMO-ALERT-*, proveedor demo existente), que registra PURCHASE_ENTRY y refresca las alertas.
 * Solo se tocan los 20 productos demo (códigos de barras 9990000000001–9990000000020) de la sucursal elegida.
 *
 * Idempotencia: el plan se calcula sobre el estado actual (cuántas alertas faltan). Si ya se cumplen, no se hace
 * nada; cada operación lleva la marca DEMO-ALERTS:<RUN_ID> (motivo del ajuste, notas de la entrada, request_id).
 */

const { withConnection } = require('../../src/config/database');
const adjustmentService = require('../../src/services/adjustment.service');
const stockEntryService = require('../../src/services/stock-entry.service');
const reportService = require('../../src/services/report.service');
const alertService = require('../../src/services/alert.service');
const vi = require('../../src/validators/inventory.validator');

const BARCODE_FROM = '9990000000001';
const BARCODE_TO = '9990000000020';
const TARGET = { low: 2, out: 1, expiring: 2 };
const NEW_BATCH_QTY = 12;
const DASHBOARD_DAYS = 30; // tarjeta «Lotes por vencer (30 días)» del Dashboard (report.service)
const REQUIRED_PERMISSIONS = ['inventory.view', 'inventory.adjust', 'inventory.entries', 'reports.view', 'alerts.view'];
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,39}$/;
const tagOf = (runId) => `DEMO-ALERTS:${runId}`;

class AlertsError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.code = 'ALERTS_PRECONDITION';
    this.problems = problems;
  }
}

function assertRunId(runId) {
  if (!RUN_ID_PATTERN.test(String(runId || ''))) {
    throw new AlertsError('RUN_ID inválido: 6 a 40 caracteres (minúsculas, números y guiones), p. ej. inventory-alerts-20261111-01');
  }
}
function defaultRunId(now = new Date()) {
  return `inventory-alerts-${new Date(now.getTime() - 5 * 3600000).toISOString().slice(0, 10).replace(/-/g, '')}-01`;
}
const shortOf = (runId) => runId.replace(/[^a-z0-9]/g, '').slice(-12).toUpperCase();
/** Fecha 'YYYY-MM-DD' (Lima) a n días de hoy. */
const limaDatePlus = (days, now = new Date()) => new Date(now.getTime() - 5 * 3600000 + days * 86400000).toISOString().slice(0, 10);

const rows = async (conn, sql, params = []) => (await conn.execute(sql, params))[0];
const one = async (conn, sql, params = []) => (await rows(conn, sql, params))[0] || null;
const isDemoBarcode = (b) => typeof b === 'string' && b.length === 13 && b >= BARCODE_FROM && b <= BARCODE_TO;

// ================================================================== lectura (SELECT)
async function readState(conn, { runId, branchId = null, executorId = null }) {
  const tag = tagOf(runId);
  const branch = branchId
    ? await one(conn, 'SELECT id, code, name, status FROM branches WHERE id = ?', [branchId])
    : (await one(conn, "SELECT id, code, name, status FROM branches WHERE code = 'SP01'"))
      || (await one(conn, "SELECT id, code, name, status FROM branches WHERE is_main = TRUE AND status = 'ACTIVE' LIMIT 1"));
  const setting = async (k) => (await one(conn, 'SELECT setting_value v FROM settings WHERE setting_key = ?', [k]))?.v ?? null;
  // Mismos valores por defecto que usan la vista y el procedimiento si falta la configuración.
  const settings = {
    defaultMinimum: Number(await setting('inventory.default_minimum_stock') ?? 20),
    alertDays: Number(await setting('inventory.expiry_alert_days') ?? 90),
    criticalDays: Number(await setting('inventory.expiry_critical_days') ?? 30),
    method: await setting('inventory.method'),
  };
  const state = { runId, tag, branch, settings, executorId, today: (await one(conn, 'SELECT CURDATE() d')).d };
  if (!branch || branch.status !== 'ACTIVE') return state;
  const b = branch.id;

  state.products = (await rows(conn, `
    SELECT p.id, p.sku, p.name, p.barcode, p.status, p.requires_prescription,
           v.branch_id IS NOT NULL AS in_branch, COALESCE(v.is_available, bp.is_available, TRUE) AS is_available,
           v.minimum_stock, COALESCE(v.available_stock, 0) available, COALESCE(v.expired_stock, 0) expired_stock,
           COALESCE(v.blocked_stock, 0) blocked_stock, COALESCE(v.stock_status, 'OUT_OF_STOCK') stock_status,
           (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE o.branch_id = ? AND o.status = 'PENDING' AND oi.product_id = p.id) reserved
      FROM products p
      LEFT JOIN vw_branch_product_stock v ON v.product_id = p.id AND v.branch_id = ?
      LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
     WHERE p.barcode BETWEEN ? AND ? AND CHAR_LENGTH(p.barcode) = 13
     ORDER BY p.barcode`, [b, b, b, BARCODE_FROM, BARCODE_TO])).map((p) => ({
    id: Number(p.id), sku: p.sku, name: p.name, barcode: p.barcode, status: p.status, rx: Number(p.requires_prescription) === 1,
    inBranch: Number(p.in_branch) === 1, isAvailable: Number(p.is_available) === 1,
    minimum: p.minimum_stock === null ? settings.defaultMinimum : Number(p.minimum_stock),
    available: Number(p.available), expiredStock: Number(p.expired_stock), blockedStock: Number(p.blocked_stock),
    stockStatus: p.stock_status, reserved: Number(p.reserved),
  }));
  const ids = state.products.map((p) => p.id);
  const batches = ids.length ? await rows(conn, `
    SELECT id, product_id, batch_number, expiry_date, current_quantity, status, unit_cost, DATEDIFF(expiry_date, CURDATE()) days
      FROM product_batches WHERE branch_id = ? AND product_id IN (${ids.map(() => '?').join(',')})
     ORDER BY expiry_date, id`, [b, ...ids]) : [];
  for (const p of state.products) {
    p.batches = batches.filter((x) => Number(x.product_id) === p.id).map((x) => ({
      id: Number(x.id), batchNumber: x.batch_number, expiryDate: x.expiry_date, quantity: Number(x.current_quantity),
      status: x.status, unitCost: x.unit_cost, days: Number(x.days),
      sellable: x.status === 'ACTIVE' && Number(x.days) > 0 && Number(x.current_quantity) > 0,
    }));
  }
  // Lotes de productos demo que YA cumplen la condición de alerta de vencimiento (período configurado).
  state.expiringBatches = batches.filter((x) => Number(x.current_quantity) > 0 && Number(x.days) > 0 && Number(x.days) <= settings.alertDays)
    .map((x) => ({ id: Number(x.id), productId: Number(x.product_id), batchNumber: x.batch_number, expiryDate: x.expiry_date, quantity: Number(x.current_quantity), days: Number(x.days) }));

  state.suppliers = await rows(conn, `
    SELECT id, business_name FROM suppliers
     WHERE status = 'ACTIVE' AND (notes LIKE '%FICTICIO%' OR notes LIKE '%DEMOSTRACI%' OR business_name LIKE '%Demo%')
     ORDER BY id`);
  state.otherProducts = Number((await one(conn, 'SELECT COUNT(*) c FROM products WHERE barcode IS NULL OR barcode NOT BETWEEN ? AND ? OR CHAR_LENGTH(barcode) <> 13', [BARCODE_FROM, BARCODE_TO])).c);
  state.executorSessions = executorId ? await rows(conn, "SELECT id, cash_register_id FROM cash_sessions WHERE opened_by = ? AND status = 'OPEN'", [executorId]) : [];
  state.runAdjustments = await rows(conn, 'SELECT id, adjustment_number, reason FROM inventory_adjustments WHERE reason LIKE ? ORDER BY id', [`${tag} %`]);
  state.runEntries = await rows(conn, 'SELECT id, entry_number, status, notes FROM stock_entries WHERE notes LIKE ? ORDER BY id', [`${tag} %`]);
  return state;
}

// ========================================================================== plan
/**
 * Calcula cuántas alertas faltan y con qué operaciones conseguirlas. Determinista para un mismo estado:
 * los productos se eligen por stock disponible (menor primero, menos unidades a ajustar) y código de barras.
 */
function buildPlan(state, { now = new Date() } = {}) {
  const P = state.products || [];
  const demoInBranch = P.filter((p) => p.status === 'ACTIVE' && p.inBranch);
  const have = {
    low: demoInBranch.filter((p) => p.stockStatus === 'LOW_STOCK'),
    out: demoInBranch.filter((p) => p.stockStatus === 'OUT_OF_STOCK'),
    expiring: state.expiringBatches || [],
  };
  const need = {
    low: Math.max(0, TARGET.low - have.low.length),
    out: Math.max(0, TARGET.out - have.out.length),
    expiring: Math.max(0, TARGET.expiring - have.expiring.length),
  };
  const used = new Set([...have.expiring.map((x) => x.productId)]);
  // Elegibles para reducir: activos, habilitados, con stock sobre el mínimo, SIN reservas de pedidos pendientes
  // y con todo su stock vendible en lotes ACTIVE no vencidos.
  const reducible = demoInBranch
    .filter((p) => p.isAvailable && p.stockStatus === 'OK' && p.reserved === 0 && p.available > p.minimum)
    .sort((a, b) => a.available - b.available || a.barcode.localeCompare(b.barcode));
  const fefoTake = (p, units) => {
    const out = [];
    let left = units;
    for (const bt of p.batches.filter((x) => x.sellable)) { // ya vienen ordenados por vencimiento (FEFO)
      if (left <= 0) break;
      const q = Math.min(bt.quantity, left);
      out.push({ batchId: bt.id, batchNumber: bt.batchNumber, expiryDate: bt.expiryDate, quantity: q });
      left -= q;
    }
    return left === 0 ? out : null;
  };

  const adjustments = [];
  const pick = (role, count, target) => {
    for (const p of reducible) {
      if (adjustments.filter((a) => a.role === role).length >= count) break;
      if (used.has(p.id)) continue;
      const finalStock = target(p);
      const items = fefoTake(p, p.available - finalStock);
      if (!items || items.length === 0) continue;
      used.add(p.id);
      adjustments.push({ role, product: p, finalStock, units: p.available - finalStock, items });
    }
  };
  pick('OUT_OF_STOCK', need.out, () => 0);
  pick('LOW_STOCK', need.low, (p) => Math.max(1, Math.floor(p.minimum / 2)));

  // Lotes nuevos DEMO-ALERT: dentro del período configurado y también dentro de la tarjeta de 30 días del Dashboard.
  const window = Math.min(state.settings.alertDays, DASHBOARD_DAYS);
  const offsets = [Math.max(2, Math.round(window * 0.6)), Math.max(3, window - 3)];
  const expiringCandidates = demoInBranch
    .filter((p) => p.isAvailable && p.stockStatus === 'OK' && !used.has(p.id))
    .sort((a, b) => a.barcode.localeCompare(b.barcode));
  const short = shortOf(state.runId);
  const entryItems = [];
  for (const p of expiringCandidates) {
    if (entryItems.length >= need.expiring) break;
    const cost = p.batches.find((x) => x.unitCost !== null)?.unitCost ?? '1.00';
    const days = offsets[entryItems.length % offsets.length];
    entryItems.push({ product: p, batchNumber: `DEMO-ALERT-${short}-${entryItems.length + 1}`, expiryDate: limaDatePlus(days, now), days, quantity: NEW_BATCH_QTY, unitCost: Number(cost).toFixed(2) });
    used.add(p.id);
  }
  const supplier = (state.suppliers || [])[0] || null;
  return {
    have, need, adjustments, supplier, short,
    entry: entryItems.length ? {
      supplier, items: entryItems,
      referenceDocumentNumber: `DEMO-ALERT-${short}`,
      notes: `${state.tag} · Lotes de demostración próximos a vencer`,
    } : null,
  };
}

// ================================================================ precondiciones
function preflight(state, plan, auth = null) {
  const problems = [];
  const warnings = [];
  if (!state.branch) { problems.push('No existe la sucursal SP01 ni una sucursal principal activa (o la indicada no existe).'); return { problems, warnings }; }
  if (state.branch.status !== 'ACTIVE') { problems.push(`La sucursal ${state.branch.name} no está activa.`); return { problems, warnings }; }
  if (!state.products.length) problems.push(`No hay productos demo (códigos de barras ${BARCODE_FROM}–${BARCODE_TO}).`);
  const notInBranch = state.products.filter((p) => !p.inBranch);
  if (notInBranch.length) warnings.push(`${notInBranch.length} productos demo no tienen registro en ${state.branch.code}: no se usarán.`);
  if (plan.adjustments.filter((a) => a.role === 'OUT_OF_STOCK').length < plan.need.out) {
    problems.push('No hay un producto demo que pueda agotarse sin tocar existencias reservadas por pedidos pendientes (stock insuficiente o comprometido).');
  }
  if (plan.adjustments.filter((a) => a.role === 'LOW_STOCK').length < plan.need.low) {
    problems.push(`No hay ${plan.need.low} productos demo con stock sobre el mínimo y sin reservas para llevarlos a stock bajo.`);
  }
  if (plan.need.expiring > 0) {
    if (!plan.supplier) problems.push('No existe un proveedor de demostración activo para registrar la entrada.');
    if (!plan.entry || plan.entry.items.length < plan.need.expiring) problems.push('No hay productos demo activos disponibles para los lotes próximos a vencer.');
  }
  if (auth) {
    if (auth.user?.status && auth.user.status !== 'ACTIVE') problems.push('La cuenta del usuario ejecutor no está activa.');
    const missing = REQUIRED_PERMISSIONS.filter((p) => !auth.permissions.has(p));
    if (missing.length) problems.push(`Faltan permisos: ${missing.join(', ')}.`);
    if (!auth.branches?.some((x) => x.id === state.branch.id)) problems.push(`El usuario ejecutor no está asignado a la sucursal ${state.branch.name}.`);
  }
  if (state.executorSessions?.length) {
    warnings.push(`El ejecutor tiene ${state.executorSessions.length} sesión(es) de caja abierta(s): no se usan ni se modifican (los ajustes y entradas no afectan la caja).`);
  }
  return { problems, warnings };
}

function summarize(state, plan, pf) {
  const L = [];
  const p = (s = '') => L.push(s);
  p(`RUN_ID ............... ${state.runId}`);
  if (!state.branch) { p('Sucursal ............. (no disponible)'); return L.join('\n'); }
  p(`Sucursal ............. ${state.branch.code} · ${state.branch.name} (id ${state.branch.id})`);
  p(`Configuración ........ stock mínimo por defecto ${state.settings.defaultMinimum} · alerta de vencimiento ${state.settings.alertDays} días · Dashboard: lotes que vencen en ${DASHBOARD_DAYS} días · método ${state.settings.method || '—'}`);
  p(`Regla stock bajo ..... stock vendible (lotes ACTIVE no vencidos) > 0 y ≤ stock mínimo · agotado: stock vendible = 0`);
  p(`Proveedor demo ....... ${plan.supplier ? `${plan.supplier.business_name} (id ${plan.supplier.id})` : 'no encontrado'}`);
  p(`Permisos necesarios .. ${REQUIRED_PERMISSIONS.join(', ')}`);
  p(`Servicios ............ adjustmentService.create (CORRECTION · ADJUSTMENT_OUT) · stockEntryService.create (PURCHASE contabilizada · PURCHASE_ENTRY)`);
  p(`Otros productos ...... ${state.otherProducts} fuera del catálogo demo: no se tocan`);
  p();
  p('Productos demo analizados:');
  p(`  ${'SKU'.padEnd(13)} ${'Producto'.padEnd(30)} ${'Stock'.padStart(5)} ${'Mín'.padStart(4)} ${'Res.'.padStart(4)} Lotes  Estado`);
  for (const x of state.products || []) {
    p(`  ${x.sku.padEnd(13)} ${x.name.slice(0, 30).padEnd(30)} ${String(x.available).padStart(5)} ${String(x.minimum).padStart(4)} ${String(x.reserved).padStart(4)} ${String(x.batches.filter((b) => b.quantity > 0).length).padStart(5)}  ${x.inBranch ? x.stockStatus : 'sin registro en la sucursal'}`);
  }
  p();
  p(`Situación actual ..... stock bajo ${plan.have.low.length} · agotados ${plan.have.out.length} · lotes por vencer (≤ ${state.settings.alertDays} días) ${plan.have.expiring.length}`);
  p(`Faltan ............... stock bajo ${plan.need.low} · agotados ${plan.need.out} · lotes por vencer ${plan.need.expiring}`);
  if (!plan.adjustments.length && !plan.entry) p('Plan ................. nada que hacer: las condiciones ya se cumplen.');
  for (const a of plan.adjustments) {
    p(`Plan · ${a.role.padEnd(12)} ${a.product.sku} ${a.product.name}: ${a.product.available} → ${a.finalStock} (mín. ${a.product.minimum}) · ajuste CORRECTION, ${a.items.length} movimiento(s) ADJUSTMENT_OUT por ${a.units} u.: ${a.items.map((i) => `${i.batchNumber} −${i.quantity}`).join(', ')}`);
  }
  if (plan.entry) {
    for (const it of plan.entry.items) {
      p(`Plan · EXPIRING_SOON lote ${it.batchNumber} de ${it.product.sku} ${it.product.name}: +${it.quantity} u., vence ${it.expiryDate} (${it.days} días), costo S/ ${it.unitCost} · 1 movimiento PURCHASE_ENTRY`);
    }
    p(`       entrada PURCHASE de ${plan.supplier ? plan.supplier.business_name : '—'} · comprobante NOTA ${plan.entry.referenceDocumentNumber} · contabilizada`);
  }
  if (state.runAdjustments?.length || state.runEntries?.length) {
    p(`Ya registrado por este RUN_ID: ${state.runAdjustments.map((a) => a.adjustment_number).join(', ') || '—'} · entradas ${state.runEntries.map((e) => `${e.entry_number} (${e.status})`).join(', ') || '—'}`);
  }
  if (pf.warnings.length) { p(); p('Advertencias:'); pf.warnings.forEach((w) => p(`  - ${w}`)); }
  p();
  if (pf.problems.length) { p('Problemas que impiden ejecutar:'); pf.problems.forEach((x) => p(`  ✖ ${x}`)); } else p('Sin problemas bloqueantes.');
  return L.join('\n');
}

async function dryRun({ runId, branchId = null, executorId = null, now = new Date() }, ctx = {}) {
  assertRunId(runId);
  return withConnection({ ...ctx, requestId: `${runId}-dryrun` }, async (conn) => {
    const state = await readState(conn, { runId, branchId, executorId });
    const plan = state.branch && state.branch.status === 'ACTIVE' ? buildPlan(state, { now })
      : { have: { low: [], out: [], expiring: [] }, need: { ...TARGET }, adjustments: [], entry: null, supplier: null };
    const pf = preflight(state, plan);
    return { state, plan, preflight: pf, text: summarize(state, plan, pf) };
  });
}

// ================================================================= instantáneas
async function snapshot(conn) {
  const h = async (sql, params = []) => {
    const r = await one(conn, sql, params);
    return `${r.c}:${r.h}`;
  };
  return {
    sales: await h("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, total, sold_at))), 0) h FROM sales"),
    orders: await h("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, total, updated_at))), 0) h FROM orders"),
    returns: await h("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, refund_amount))), 0) h FROM sale_returns"),
    payments: await h("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, amount, refunded_at))), 0) h FROM payments"),
    cash: await h("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, closed_at, counted_amount))), 0) h FROM cash_sessions"),
    users: await h("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, email, password_hash))), 0) h FROM users"),
    suppliers: await h("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, business_name, updated_at))), 0) h FROM suppliers"),
    minimums: await h("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, minimum_stock))), 0) h FROM branch_products"),
    expiryDates: await h("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', id, expiry_date))), 0) h FROM product_batches"),
    nonDemoBatches: await h(`SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT_WS('|', pb.id, pb.current_quantity, pb.received_quantity))), 0) h
        FROM product_batches pb JOIN products p ON p.id = pb.product_id
       WHERE p.barcode IS NULL OR p.barcode NOT BETWEEN ? AND ? OR CHAR_LENGTH(p.barcode) <> 13`, [BARCODE_FROM, BARCODE_TO]),
    movementMaxId: Number((await one(conn, 'SELECT COALESCE(MAX(id), 0) m FROM inventory_movements')).m),
  };
}

// ===================================================================== ejecución
/** `hooks.failAfterAdjustments` (solo pruebas) simula una caída después de ese número de ajustes. */
async function execute({ runId, auth, branchId = null, ctx = {}, now = new Date(), log = () => {}, hooks = {} }) {
  assertRunId(runId);
  const tag = tagOf(runId);
  const base = { ip: ctx.ip ?? '127.0.0.1', userAgent: ctx.userAgent ?? 'seed-inventory-alerts', userId: auth.userId, sessionRef: auth.jti ?? null };
  const read = (fn) => withConnection({ ...base, requestId: `${runId}-read` }, fn);
  const { state, plan, pf } = await read(async (conn) => {
    const st = await readState(conn, { runId, branchId, executorId: auth.userId });
    const pl = buildPlan(st, { now });
    return { state: st, plan: pl, pf: preflight(st, pl, auth) };
  });
  if (pf.problems.length) throw new AlertsError('No se cumplen las precondiciones; no se escribió nada.', pf.problems);
  const b = state.branch.id;
  const sctx = (requestId) => ({ ...base, branchId: b, requestId });
  const before = await read((conn) => snapshot(conn));
  const created = { adjustments: [], entries: [] };

  let n = 0;
  for (const a of plan.adjustments) {
    n += 1;
    const body = vi.adjustmentCreate.parse({
      adjustmentType: 'CORRECTION', branchId: b, productId: a.product.id,
      reason: `${tag} · Ajuste de demostración para alerta ${a.role} de ${a.product.sku} (${a.product.available} → ${a.finalStock})`,
      items: a.items.map((i) => ({ batchId: i.batchId, quantity: i.quantity, direction: 'OUT' })),
    });
    const adj = await adjustmentService.create(body, auth, sctx(`${runId}-${a.role === 'LOW_STOCK' ? 'low' : 'out'}-${String(n).padStart(2, '0')}`));
    created.adjustments.push(adj.adjustmentNumber);
    log(`${adj.adjustmentNumber}: ${a.product.sku} ${a.product.available} → ${a.finalStock} (${a.role})`);
    if (hooks.failAfterAdjustments === n) throw new Error(`Falla simulada después del ajuste ${n}`);
  }
  if (plan.entry) {
    const body = vi.entryCreate.parse({
      branchId: b, supplierId: plan.supplier.id, entryType: 'PURCHASE', referenceDocumentType: 'NOTA',
      referenceDocumentNumber: plan.entry.referenceDocumentNumber, notes: plan.entry.notes, confirm: true,
      items: plan.entry.items.map((i) => ({ productId: i.product.id, batchNumber: i.batchNumber, expiryDate: i.expiryDate, quantity: i.quantity, unitCost: i.unitCost })),
    });
    const entry = await stockEntryService.create(body, auth, sctx(`${runId}-entry`));
    created.entries.push(entry.entryNumber);
    log(`Entrada ${entry.entryNumber} contabilizada: ${plan.entry.items.map((i) => `${i.batchNumber} vence ${i.expiryDate}`).join(', ')}`);
  }
  const after = await read((conn) => snapshot(conn));
  const verification = await verify({ runId, auth, branchId: b, before, after, ctx: base });
  return { runId, created, plan, verification };
}

// ================================================================== verificación
async function verify({ runId, auth, branchId, before = null, after = null, ctx = {} }) {
  const tag = tagOf(runId);
  const vctx = { ...ctx, branchId, requestId: `${runId}-verify` };
  const db = await withConnection(vctx, async (conn) => {
    const low = await rows(conn, `
      SELECT v.id product_id, v.sku, v.name, v.branch_name, v.current_stock, v.minimum_stock, v.stock_status,
             (SELECT COUNT(*) FROM product_batches pb WHERE pb.product_id = v.id AND pb.branch_id = v.branch_id AND pb.status = 'ACTIVE'
                AND pb.current_quantity > 0 AND pb.expiry_date > CURDATE()) sellable_batches,
             (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE o.status = 'PENDING' AND o.branch_id = v.branch_id AND oi.product_id = v.id) reserved,
             (SELECT COUNT(*) FROM stock_alerts sa WHERE sa.product_id = v.id AND sa.branch_id = v.branch_id AND sa.status = 'OPEN'
                AND sa.alert_type = v.stock_status) open_alert
        FROM vw_products_low_stock v JOIN products p ON p.id = v.id
       WHERE v.branch_id = ? AND p.barcode BETWEEN ? AND ? AND CHAR_LENGTH(p.barcode) = 13 ORDER BY v.stock_status, v.sku`, [branchId, BARCODE_FROM, BARCODE_TO]);
    const expiring = await rows(conn, `
      SELECT pb.id, p.sku, pb.batch_number, pb.expiry_date, pb.current_quantity, pb.status, DATEDIFF(pb.expiry_date, CURDATE()) days,
             (SELECT COUNT(*) FROM stock_alerts sa WHERE sa.batch_id = pb.id AND sa.status = 'OPEN' AND sa.alert_type = 'EXPIRING_SOON') open_alert
        FROM product_batches pb JOIN products p ON p.id = pb.product_id
       WHERE pb.branch_id = ? AND p.barcode BETWEEN ? AND ? AND CHAR_LENGTH(p.barcode) = 13 AND pb.current_quantity > 0
         AND pb.expiry_date > CURDATE()
         AND pb.expiry_date <= CURDATE() + INTERVAL (SELECT COALESCE(CAST(setting_value AS SIGNED), 90) FROM settings WHERE setting_key = 'inventory.expiry_alert_days') DAY
       ORDER BY pb.expiry_date`, [branchId, BARCODE_FROM, BARCODE_TO]);
    const movements = await rows(conn, `
      SELECT m.movement_type, COUNT(*) c, SUM(m.quantity) q,
             SUM(m.adjustment_id IS NULL AND m.stock_entry_item_id IS NULL) unlinked
        FROM inventory_movements m WHERE m.request_id LIKE ? GROUP BY m.movement_type`, [`${runId}-%`]);
    const inconsistent = await rows(conn, `
      SELECT pb.id, pb.current_quantity, (SELECT m.batch_stock_after FROM inventory_movements m WHERE m.batch_id = pb.id ORDER BY m.id DESC LIMIT 1) last_after
        FROM product_batches pb JOIN products p ON p.id = pb.product_id
       WHERE p.barcode BETWEEN ? AND ? AND CHAR_LENGTH(p.barcode) = 13
      HAVING last_after IS NULL OR last_after <> current_quantity`, [BARCODE_FROM, BARCODE_TO]);
    const foreignProducts = Number((await one(conn, `
      SELECT COUNT(*) c FROM inventory_movements m JOIN products p ON p.id = m.product_id
       WHERE m.request_id LIKE ? AND (p.barcode IS NULL OR p.barcode NOT BETWEEN ? AND ? OR CHAR_LENGTH(p.barcode) <> 13)`, [`${runId}-%`, BARCODE_FROM, BARCODE_TO])).c);
    const adjustments = await rows(conn, 'SELECT adjustment_number, adjustment_type, reason FROM inventory_adjustments WHERE reason LIKE ? ORDER BY id', [`${tag} %`]);
    const entries = await rows(conn, 'SELECT entry_number, status, entry_type, total_cost FROM stock_entries WHERE notes LIKE ? ORDER BY id', [`${tag} %`]);
    return { low, expiring, movements, inconsistent, foreignProducts, adjustments, entries };
  });

  // Endpoint real del Dashboard (GET /api/reports/dashboard) y de alertas (GET /api/inventory/alerts).
  const dashboard = await reportService.dashboard(auth, { branchId }, vctx);
  const alerts = await alertService.list({ branchId, status: 'OPEN', page: 1, pageSize: 100 }, auth, vctx);

  const issues = [];
  const lowRows = db.low.filter((r) => r.stock_status === 'LOW_STOCK');
  const outRows = db.low.filter((r) => r.stock_status === 'OUT_OF_STOCK');
  if (lowRows.length < TARGET.low) issues.push(`stock bajo: ${lowRows.length} de ${TARGET.low}`);
  if (outRows.length < TARGET.out) issues.push(`agotados: ${outRows.length} de ${TARGET.out}`);
  if (db.expiring.length < TARGET.expiring) issues.push(`lotes por vencer: ${db.expiring.length} de ${TARGET.expiring}`);
  for (const r of lowRows) if (!(Number(r.current_stock) > 0 && Number(r.current_stock) <= Number(r.minimum_stock))) issues.push(`${r.sku}: no cumple stock bajo`);
  for (const r of outRows) {
    if (Number(r.current_stock) !== 0 || Number(r.sellable_batches) !== 0) issues.push(`${r.sku}: aún tiene lotes vendibles`);
    if (Number(r.reserved) > 0) issues.push(`${r.sku}: agotado con reservas pendientes`);
  }
  for (const r of db.low) if (!Number(r.open_alert)) issues.push(`${r.sku}: sin alerta ${r.stock_status} abierta`);
  for (const r of db.expiring) if (!Number(r.open_alert)) issues.push(`lote ${r.batch_number}: sin alerta EXPIRING_SOON abierta`);
  if (db.inconsistent.length) issues.push(`${db.inconsistent.length} lotes demo con stock distinto del kardex`);
  if (db.foreignProducts) issues.push(`${db.foreignProducts} movimientos sobre productos fuera del catálogo demo`);
  for (const m of db.movements) if (Number(m.unlinked)) issues.push(`${m.unlinked} movimientos ${m.movement_type} sin ajuste o entrada asociada`);
  if (dashboard.lowStockProducts < TARGET.low + TARGET.out) issues.push(`Dashboard: lowStockProducts = ${dashboard.lowStockProducts}`);
  if ((dashboard.openAlerts.OUT_OF_STOCK || 0) < TARGET.out) issues.push('Dashboard: sin alertas OUT_OF_STOCK abiertas');
  if ((dashboard.openAlerts.LOW_STOCK || 0) < TARGET.low) issues.push('Dashboard: sin alertas LOW_STOCK abiertas');
  if (dashboard.batchesExpiringIn30Days < TARGET.expiring) issues.push(`Dashboard: batchesExpiringIn30Days = ${dashboard.batchesExpiringIn30Days}`);
  const integrity = {};
  if (before && after) {
    for (const k of ['sales', 'orders', 'returns', 'payments', 'cash', 'users', 'suppliers', 'minimums', 'nonDemoBatches']) {
      integrity[k] = before[k] === after[k];
      if (!integrity[k]) issues.push(`cambió ${k} (debía quedar intacto)`);
    }
    // Las fechas de vencimiento existentes no cambian (solo se agregan lotes nuevos).
    integrity.expiryDates = Number(after.expiryDates.split(':')[0]) >= Number(before.expiryDates.split(':')[0]);
  }
  return { ...db, dashboard: { lowStockProducts: dashboard.lowStockProducts, batchesExpiringIn30Days: dashboard.batchesExpiringIn30Days, openAlerts: dashboard.openAlerts },
    alertsOpenSummary: alerts.openSummary, integrity, issues };
}

function formatVerification(v) {
  const L = [];
  for (const r of v.low) L.push(`${r.stock_status === 'LOW_STOCK' ? 'Stock bajo' : 'Agotado'} · ${r.sku} ${r.name} · ${r.branch_name}: stock ${r.current_stock} / mínimo ${r.minimum_stock} · lotes vendibles ${r.sellable_batches} · reservas ${r.reserved} · alerta abierta ${Number(r.open_alert) ? 'sí' : 'NO'}`);
  for (const r of v.expiring) L.push(`Por vencer · ${r.sku} lote ${r.batch_number}: vence ${r.expiry_date} (${r.days} días) · ${r.current_quantity} u. · ${r.status} · alerta ${Number(r.open_alert) ? 'sí' : 'NO'}`);
  L.push(`Movimientos del RUN_ID: ${v.movements.map((m) => `${m.movement_type} ${m.c} (${m.q} u.)`).join(' · ') || '—'}`);
  L.push(`Ajustes: ${v.adjustments.map((a) => a.adjustment_number).join(', ') || '—'} · entradas: ${v.entries.map((e) => `${e.entry_number} ${e.status}`).join(', ') || '—'}`);
  L.push(`Dashboard (GET /api/reports/dashboard): stock bajo/agotados ${v.dashboard.lowStockProducts} · lotes por vencer en 30 días ${v.dashboard.batchesExpiringIn30Days} · alertas abiertas ${JSON.stringify(v.dashboard.openAlerts)}`);
  if (Object.keys(v.integrity).length) L.push(`Integridad: ${Object.entries(v.integrity).map(([k, ok]) => `${k} ${ok ? 'intacto' : 'CAMBIÓ'}`).join(' · ')} · kardex = stock: ${v.inconsistent.length ? 'NO' : 'sí'}`);
  L.push(v.issues.length ? `Observaciones:\n${v.issues.map((i) => `  ✖ ${i}`).join('\n')}` : 'Verificación sin observaciones.');
  return L.join('\n');
}

module.exports = {
  BARCODE_FROM, BARCODE_TO, TARGET, REQUIRED_PERMISSIONS, AlertsError, assertRunId, defaultRunId, tagOf, isDemoBarcode,
  readState, buildPlan, preflight, summarize, dryRun, execute, verify, formatVerification,
};
