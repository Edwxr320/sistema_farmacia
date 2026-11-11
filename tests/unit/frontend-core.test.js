'use strict';

/** Funciones puras del frontend React (frontend/src/core y admin/nav.js): formato de importes, fechas y permisos de menú. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', rel)).href);

test('money: formatea texto decimal sin aritmética flotante', async () => {
  const { money } = await load('core/format.js');
  assert.equal(money('1234.5'), 'S/ 1,234.50');
  assert.equal(money('0.1'), 'S/ 0.10');
  assert.equal(money('1000000.00'), 'S/ 1,000,000.00');
  assert.equal(money('-3.75'), '-S/ 3.75');
  assert.equal(money(null), '—');
  assert.equal(money(''), '—');
  assert.equal(money('12.5', '$'), '$ 12.50');
});

test('cents/fromCents: conversión exacta (vuelto estimado, totales de interfaz)', async () => {
  const { cents, fromCents } = await load('core/format.js');
  assert.equal(cents('0.10') + cents('0.20'), 30); // 0.1 + 0.2 sin error de coma flotante
  assert.equal(cents('5'), 500);
  assert.equal(cents('5.5'), 550);
  assert.equal(cents('abc'), null);
  assert.equal(cents('1.234'), null);
  assert.equal(fromCents(30), '0.30');
  assert.equal(fromCents(-1250), '-12.50');
  assert.equal(fromCents(cents('19.99') * 3), '59.97');
});

test('fechas: DATE sin desfase de zona y "hoy" en Lima', async () => {
  const { date, todayLima, addDays } = await load('core/format.js');
  assert.equal(date('2026-03-01'), '01/03/2026');
  assert.equal(date(null), '—');
  // 2026-01-01 03:00 UTC sigue siendo 31/12/2025 en Lima (UTC-5).
  assert.equal(todayLima(Date.parse('2026-01-01T03:00:00Z')), '2025-12-31');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('buildQuery omite vacíos y codifica valores', async () => {
  const { buildQuery } = await load('core/format.js');
  assert.equal(buildQuery({ a: 1, b: '', c: null, d: undefined, q: 'á b' }), '?a=1&q=%C3%A1%20b');
  assert.equal(buildQuery({}), '');
});

test('idempotencyKey cumple el patrón del servidor y es única', async () => {
  const { idempotencyKey } = await load('core/format.js');
  const a = idempotencyKey('pos');
  const b = idempotencyKey('pos');
  assert.match(a, /^[A-Za-z0-9._-]{8,64}$/);
  assert.notEqual(a, b);
});

test('statusLabel: etiquetas conocidas y valor desconocido neutro', async () => {
  const { statusLabel } = await load('core/format.js');
  assert.deepEqual(statusLabel('order', 'COMPLETED').tone, 'success');
  assert.equal(statusLabel('order', 'PENDING').text.length > 0, true);
  assert.deepEqual(statusLabel('order', 'XYZ'), { text: 'XYZ', tone: 'neutral' });
});

test('permisos: el menú muestra solo lo autorizado (any/all)', async () => {
  const { filterNav, firstRoute, hasAny, hasAll } = await load('core/permissions.js');
  const { NAV } = await load('admin/nav.js');
  assert.equal(hasAny(['a'], []), true);
  assert.equal(hasAll(['a', 'b'], ['a', 'b']), true);
  assert.equal(hasAll(['a'], ['a', 'b']), false);

  const cashier = new Set(['sales.create', 'payments.register', 'cash.open', 'cash.close', 'sales.view', 'products.view', 'inventory.view']);
  const routes = filterNav(NAV, cashier).flatMap((g) => g.items.map((i) => i.route));
  assert.ok(routes.includes('pos'));
  assert.ok(routes.includes('cash'));
  assert.ok(routes.includes('stock'));
  for (const hidden of ['users', 'roles', 'settings', 'branches', 'dashboard', 'reports']) assert.ok(!routes.includes(hidden), `${hidden} no debe verse`);

  // Sin payments.register no hay POS (requiere ambos permisos).
  const noPay = filterNav(NAV, new Set(['sales.create'])).flatMap((g) => g.items.map((i) => i.route));
  assert.ok(!noPay.includes('pos'));

  assert.equal(firstRoute(NAV, new Set(['reports.view'])), 'dashboard');
  assert.equal(firstRoute(NAV, new Set()), null);
});

test('acceso único: rutas de retorno solo internas y según el tipo de cuenta', async () => {
  const { safeNext, destinationFor, internalPath, accessUrl } = await load('core/redirect.js');
  // Redirecciones externas o peligrosas → rechazadas.
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', '\\\\evil.com', 'javascript:alert(1)', 'data:text/html,x', '/x\n/y', '', null, undefined, 42]) {
    assert.equal(internalPath(bad), null, String(bad));
  }
  assert.equal(internalPath('carrito'), '/carrito'); // formato antiguo
  assert.equal(internalPath('/admin/sales?id=3'), '/admin/sales?id=3');
  // Personal → solo /admin; cliente → nunca /admin.
  assert.equal(safeNext('/admin/sales?id=3', 'STAFF'), '/admin/sales?id=3');
  assert.equal(safeNext('/carrito', 'STAFF'), null);
  assert.equal(safeNext('/admin/pos', 'CUSTOMER'), null);
  assert.equal(safeNext('/pedidos/5', 'CUSTOMER'), '/pedidos/5');
  assert.equal(safeNext('/acceso', 'CUSTOMER'), null);
  assert.equal(destinationFor('STAFF', '//evil.com'), '/admin');
  assert.equal(destinationFor('CUSTOMER', '/admin'), '/');
  assert.equal(destinationFor('CUSTOMER', 'checkout'), '/checkout');
  assert.equal(accessUrl('/admin/pos'), '/acceso?next=%2Fadmin%2Fpos');
  assert.equal(accessUrl('https://evil.com'), '/acceso');
});
