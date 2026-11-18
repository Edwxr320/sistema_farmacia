'use strict';

/**
 * E2E del frontend React (build de Vite) con Chrome real (puppeteer-core) contra un servidor HTTP + Socket.IO levantado aquí.
 * Confirma datos, por eso solo corre sobre una base TEMPORAL:  npm run test:e2e
 * (scripts/test-tempdb.js crea la base, fija DB_NAME y PP_E2E=1, y la elimina al terminar).
 *
 * Cubre: login del personal, carga de TODAS las pantallas del panel sin errores, venta en el POS,
 * registro/compra en la tienda (recojo con receta), aviso en tiempo real del pedido al panel,
 * aceptación del pedido y actualización en vivo del estado para el cliente, acceso único (/acceso) para personal y clientes
 * con retorno seguro, rutas antiguas y tema claro/oscuro, separación de sesiones y portales,
 * y capturas responsive (escritorio, tableta y móvil).
 *
 * Variables: CHROME_PATH (por defecto la instalación estándar de Chrome en Windows),
 *            E2E_SCREENSHOTS (carpeta para las capturas; por defecto, temporal del sistema).
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const enabled = process.env.PP_E2E === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = process.env.E2E_SCREENSHOTS || path.join(os.tmpdir(), 'pp-e2e-screens');
const PASSWORD = 'Farmacia2026Segura';

const ADMIN_ROUTES = ['dashboard', 'pos', 'cash', 'sales', 'returns', 'orders', 'stock', 'batches', 'kardex', 'alerts', 'entries', 'adjustments',
  'transfers', 'products', 'categories', 'laboratories', 'suppliers', 'customers', 'users', 'roles', 'branches', 'settings', 'reports'];

test('frontend E2E: panel administrativo y tienda virtual', { skip: !enabled && 'Requiere PP_E2E=1 y una base temporal (npm run test:e2e)', timeout: 300000 }, async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip(`No se encontró Chrome en ${CHROME} (defina CHROME_PATH)`); return; }
  const puppeteer = require('puppeteer-core');
  const { withTransaction, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const { initRealtime, closeRealtime } = require('../../src/services/realtime.service');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, stockedProduct, uid } = require('../helpers/http');
  fs.mkdirSync(SHOTS, { recursive: true });

  // ------------------------------------------------------------ datos y servidor
  const app = createApp();
  const adminUser = await withTransaction({ requestId: 'e2e-setup' }, (conn) => createTestUser(conn, { roleCode: 'ADMIN', password: PASSWORD }));
  const api = await loginClient(app, adminUser);
  const otc = await stockedProduct(api, { salePrice: '4.50', batches: [{ batchNumber: `E2E-${uid()}`, days: 300, quantity: 30 }] });
  const rx = await stockedProduct(api, { salePrice: '12.00', requiresPrescription: true, categoryId: otc.categoryId, supplierId: otc.supplierId, batches: [{ batchNumber: `E2E-${uid()}`, days: 300, quantity: 10 }] });
  const otcName = (await api.get(`/api/products/${otc.productId}`)).body.data.name;
  const rxName = (await api.get(`/api/products/${rx.productId}`)).body.data.name;
  const reg = (await api.get('/api/cash/registers')).body.data[0];
  const open = await api.post('/api/cash/sessions', { cashRegisterId: reg.id, openingAmount: '50.00' });
  assert.equal(open.status, 201, JSON.stringify(open.body));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  initRealtime(server);
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  t.after(async () => {
    await browser.close().catch(() => {});
    await closeRealtime().catch(() => {});
    await new Promise((r) => server.close(r));
    await closePool();
  });

  /** Página con registro de errores de JS, consola y respuestas 5xx. */
  async function newPage(width = 1366, height = 860) {
    const ctx = await browser.createBrowserContext(); // cookies aisladas (personal y cliente separados)
    const page = await ctx.newPage();
    await page.setViewport({ width, height });
    page.problems = [];
    page.on('pageerror', (e) => page.problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.problems.push(`console: ${m.text()}`); });
    page.on('response', (r) => { if (r.status() >= 500) page.problems.push(`HTTP ${r.status()} ${r.url()}`); });
    return page;
  }
  const settle = (page, root = 'body') => page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && !el.querySelector('.spinner');
  }, { timeout: 15000 }, root);
  const textOf = (page, sel) => page.$eval(sel, (el) => el.innerText);
  const clickText = async (page, text, sel = 'button') => {
    const handle = await page.waitForFunction((s, txt) => [...document.querySelectorAll(s)].find((b) => b.offsetParent !== null && !b.disabled && b.innerText.trim().includes(txt)),
      { timeout: 15000 }, sel, text);
    await handle.asElement().click();
  };
  /** Ejecuta un paso y, si falla, adjunta ruta, texto visible y errores del navegador. */
  async function step(page, label, fn) {
    try { return await fn(); } catch (err) {
      const info = await page.evaluate(() => {
        const errs = [...document.querySelectorAll('.modal .error, .modal .alert-box')].map((e) => e.innerText.trim()).filter(Boolean).join(' | ');
        return `${location.pathname}${location.search} :: ${errs ? `ERRORES DEL MODAL: ${errs} :: ` : ''}${document.body.innerText.slice(0, 600).replace(/\s+/g, ' ')}`;
      }).catch(() => '');
      await page.screenshot({ path: path.join(SHOTS, `FAIL-${label.replace(/[^a-z0-9]+/gi, '_')}.png`) }).catch(() => {});
      err.message = [`[${label}] ${err.message}`, info, ...page.problems].join('\n  ');
      throw err;
    }
  }
  /** Elementos que sobresalen del ancho visible (para diagnosticar desbordes en móvil). */
  const overflowing = (page) => page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && e.offsetParent !== null)
    .slice(0, 5).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} (${Math.round(e.getBoundingClientRect().right)}px)`).join(', '));
  /** Ningún texto visible debe delatar datos mal renderizados. */
  async function assertCleanText(page, sel, label) {
    const text = await page.$eval(sel, (el) => el.innerText);
    const bad = text.match(/\[object \w+\]|\bundefined\b|\bNaN\b|(?:^|\s)null(?:\s|$)/);
    assert.equal(bad, null, `${label}: texto inválido "${bad && bad[0].trim()}"`);
  }
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
  /** Navegación interna de React Router (History API) sin recargar la página. */
  const go = (page, url) => page.evaluate((u) => { window.history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate')); }, url);

  // ----------------------------------------------------------- panel: login
  const admin = await newPage();
  await admin.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
  await admin.type('input[name=email]', adminUser.email);
  await admin.type('input[name=password]', PASSWORD);
  await shot(admin, '01-admin-login');
  await Promise.all([admin.waitForSelector('.sidebar', { timeout: 15000 }), admin.keyboard.press('Enter')]);
  await settle(admin, '.content');
  assert.match(await textOf(admin, '.sidebar'), /Punto de venta/i);

  // ------------------------------------------- panel: todas las pantallas cargan
  await t.test('todas las pantallas del panel cargan sin errores', async () => {
    for (const r of ADMIN_ROUTES) await step(admin, `ruta ${r}`, async () => {
      await go(admin, `/admin/${r}`);
      await admin.waitForFunction(() => document.querySelector('.content h1, .content .pos'), { timeout: 15000 });
      await settle(admin, '.content');
      await new Promise((res) => setTimeout(res, 150));
      await settle(admin, '.content');
      const err = await admin.$('.content .state.error');
      const msg = err ? await admin.evaluate((e) => e.innerText, err) : '';
      assert.equal(err, null, `/admin/${r} mostró error: ${msg}`);
      await assertCleanText(admin, '.content', `/admin/${r}`);
      if (['dashboard', 'pos', 'stock', 'orders', 'reports', 'settings'].includes(r)) await shot(admin, `02-admin-${r}`);
    });
    assert.deepEqual(admin.problems, [], admin.problems.join('\n'));
  });

  // ------------------------------------------------------- panel: venta en POS
  await t.test('POS: venta en efectivo con vuelto', async () => {
    await go(admin, '/admin/pos');
    await admin.waitForSelector('input[aria-label="Buscar producto"]');
    await settle(admin, '.content');
    await admin.type('input[aria-label="Buscar producto"]', otcName);
    await new Promise((r) => setTimeout(r, 600));
    await admin.keyboard.press('Enter');
    await admin.waitForFunction((n) => document.querySelector('.content').innerText.includes(n) && document.querySelector('.cart-line'), { timeout: 15000 }, otcName);
    // Total del servidor (quote) antes de cobrar.
    await admin.waitForFunction(() => /S\/ 4\.50/.test(document.querySelector('.totals')?.innerText || ''), { timeout: 15000 });
    const tendered = await admin.$('input[placeholder="Igual al importe"]');
    if (tendered) await tendered.type('10');
    await clickText(admin, 'Cobrar y confirmar venta');
    await admin.waitForFunction(() => /Venta .+ registrada/.test(document.querySelector('.modal')?.innerText || ''), { timeout: 15000 });
    const modalText = await textOf(admin, '.modal');
    assert.match(modalText, /Total cobrado: S\/ 4\.50/);
    if (tendered) assert.match(modalText, /S\/ 5\.50/); // vuelto
    await shot(admin, '03-admin-pos-venta');
    await admin.keyboard.press('Escape');
    const sales = (await api.get('/api/sales?branchId=1')).body.data;
    assert.ok(sales.some((s) => s.total === '4.50'), 'la venta quedó registrada');
  });

  // ---------------------------------------------------------------- tienda
  const shopper = await newPage(1280, 860);
  const email = `e2e.${uid().toLowerCase()}@pharmaplus.test`;
  await t.test('tienda: registro, catálogo, carrito y pedido con receta', () => step(shopper, 'tienda', async () => {
    await shopper.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await settle(shopper, '#main');
    assert.match(await textOf(shopper, '.hero'), /Cuida tu salud/);
    await assertCleanText(shopper, '#main', '04-store-home');
    await shot(shopper, '04-store-home');

    await shopper.goto(`${BASE}/registro`);
    await shopper.waitForSelector('input[name=fullName]');
    await shopper.type('input[name=fullName]', 'Cliente Prueba Extremo');
    await shopper.type('input[name=email]', email);
    await shopper.type('input[name=password]', 'Cliente2026Seguro');
    await shopper.type('input[name=confirm]', 'Cliente2026Seguro');
    await clickText(shopper, 'Crear cuenta', 'form button');
    await shopper.waitForFunction(() => document.querySelector('.store-header')?.innerText.includes('Cliente'), { timeout: 15000 });

    // Producto con receta: detalle y agregar 2 unidades.
    await shopper.goto(`${BASE}/producto/${rx.productId}`);
    await shopper.waitForFunction((n) => document.querySelector('#main h1')?.innerText.includes(n), { timeout: 15000 }, rxName);
    await assertCleanText(shopper, '#main', '05-store-producto');
    await shot(shopper, '05-store-producto');
    await clickText(shopper, '', 'button[title="Más"]');
    await clickText(shopper, 'Agregar al carrito');
    await shopper.waitForFunction(() => /Carrito/.test(document.querySelector('.store-header').innerText) && document.querySelector('.store-header .badge')?.innerText === '2', { timeout: 15000 });

    await shopper.goto(`${BASE}/carrito`);
    await shopper.waitForSelector('.cart-line');
    assert.match(await textOf(shopper, '#main'), /S\/ 24\.00/);
    await assertCleanText(shopper, '#main', '06-store-carrito');
    await shot(shopper, '06-store-carrito');
    await clickText(shopper, 'Continuar con la compra', 'a');
    await shopper.waitForSelector('input[aria-label^="Número de receta"]', { timeout: 15000 });
    // Sin receta → aviso local; con receta → pedido.
    await clickText(shopper, 'Confirmar pedido');
    await shopper.waitForFunction(() => /número de receta/i.test(document.querySelector('#main').innerText), { timeout: 5000 });
    await shopper.type('input[aria-label^="Número de receta"]', 'RX-E2E-001');
    await assertCleanText(shopper, '#main', '07-store-checkout');
    await shot(shopper, '07-store-checkout');
    await clickText(shopper, 'Confirmar pedido');
    await shopper.waitForFunction(() => /Recibimos su pedido/.test(document.querySelector('#main')?.innerText || ''), { timeout: 15000 });
    assert.match(await textOf(shopper, '#main'), /Pendiente|Recibido/i);
    await assertCleanText(shopper, '#main', '08-store-pedido');
    await shot(shopper, '08-store-pedido');
    assert.deepEqual(shopper.problems, [], shopper.problems.join('\n'));
  }));

  await t.test('tiempo real: el panel ve el pedido y el cliente ve la aceptación', () => step(admin, 'tiempo real', async () => {
    await go(admin, '/admin/orders');
    await admin.waitForFunction(() => document.querySelector('.content table tbody tr'), { timeout: 15000 });
    await admin.click('.content table tbody tr');
    await admin.waitForSelector('.modal input[placeholder="N.º de receta verificado"]', { timeout: 15000 });
    await admin.type('.modal input[placeholder="N.º de receta verificado"]', 'RX-E2E-001');
    await clickText(admin, 'Aceptar pedido', '.modal button');
    await admin.waitForFunction(() => /Confirmado|Aceptado/i.test(document.querySelector('.modal')?.innerText || ''), { timeout: 15000 });
    await assertCleanText(admin, '.modal', 'detalle de pedido');
    await shot(admin, '09-admin-pedido-aceptado');
    // El cliente recibe 'order:status' por su sala de usuario y la vista se actualiza sola.
    await shopper.waitForFunction(() => document.querySelector('.step.current')?.innerText.includes('Aceptado'), { timeout: 15000 });
    await shot(shopper, '10-store-pedido-aceptado');
  }));

  await t.test('gestión desde el panel: trabajador, producto y cobertura de delivery', () => step(admin, 'gestión', async () => {
    // Cierra los modales abiertos con su botón (React los desmonta).
    const closeModals = async () => {
      await admin.evaluate(() => [...document.querySelectorAll('.modal-head button[aria-label="Cerrar"]')].reverse().forEach((b) => b.click()));
      await admin.waitForFunction(() => !document.querySelector('.modal-backdrop'), { timeout: 5000 });
    };
    await closeModals();
    // Trabajador: queda con contraseña temporal y la sucursal marcada.
    const workerEmail = `e2e.trabajador.${uid().toLowerCase()}@pharmaplus.test`;
    await go(admin, '/admin/users');
    await settle(admin, '.content');
    await clickText(admin, 'Nuevo trabajador');
    await admin.waitForSelector('.modal input[name=fullName]');
    assert.match(await textOf(admin, '.modal'), /Sucursales asignadas/);
    await admin.type('.modal input[name=fullName]', 'Trabajador Prueba Panel');
    await admin.type('.modal input[name=email]', workerEmail);
    await admin.evaluate(() => { const s = document.querySelector('.modal select[name=roleId]'); s.value = s.options[1].value; });
    await admin.type('.modal input[name=password]', 'Temporal2026Segura');
    await clickText(admin, 'Guardar', '.modal-foot button, .modal button');
    await admin.waitForFunction(() => !document.querySelector('.modal input[name=fullName]'), { timeout: 15000 });
    const users = (await api.get(`/api/users?q=${encodeURIComponent(workerEmail)}`)).body.data;
    assert.equal(users.length, 1);
    assert.equal(users[0].mustChangePassword, true);
    assert.equal(users[0].branches.length, 1);

    // Producto nuevo desde el formulario.
    const sku = `E2E-${uid()}`;
    await go(admin, '/admin/products');
    await settle(admin, '.content');
    await clickText(admin, 'Nuevo producto');
    await admin.waitForSelector('.modal input[name=sku]');
    await admin.type('.modal input[name=name]', 'Producto Creado En Panel');
    await admin.type('.modal input[name=sku]', sku);
    await admin.evaluate(() => { const s = document.querySelector('.modal select[name=categoryId]'); s.value = s.options[1].value; });
    await admin.type('.modal input[name=salePrice]', '7.90');
    await clickText(admin, 'Guardar', '.modal button');
    await admin.waitForFunction(() => /Producto Creado En Panel/.test(document.querySelector('.modal h2')?.innerText || ''), { timeout: 15000 });
    await assertCleanText(admin, '.modal', 'ficha de producto');
    const created = (await api.get(`/api/products?q=${sku}`)).body.data;
    assert.equal(created[0].salePrice, '7.90');
    await closeModals();

    // Cobertura de delivery: "No configurado" → lista de distritos.
    await go(admin, '/admin/settings');
    await settle(admin, '.content');
    assert.match(await textOf(admin, '.content'), /No configurado/);
    await clickText(admin, 'Configurar distritos');
    await admin.waitForSelector('.modal textarea[name=districts]');
    await admin.type('.modal textarea[name=districts]', 'Miraflores\nSurco');
    await clickText(admin, 'Guardar', '.modal button');
    await admin.waitForFunction(() => /Miraflores, Surco/.test(document.querySelector('.content')?.innerText || ''), { timeout: 15000 });
    const pub = (await api.get('/api/settings/public')).body.data;
    assert.deepEqual(pub.deliveryDistricts, ['Miraflores', 'Surco']);
    assert.deepEqual(admin.problems, [], admin.problems.join('\n'));
  }));

  /** Fija el valor de un control de React (input/select/textarea) y dispara su evento. */
  const setValue = (page, sel, value) => page.$eval(sel, (el, v) => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }, value);
  const modalText = (page) => page.evaluate(() => [...document.querySelectorAll('.modal')].map((m) => m.innerText).join('\n'));
  const waitModal = (page, re) => page.waitForFunction((src) => new RegExp(src).test([...document.querySelectorAll('.modal')].map((m) => m.innerText).join('\n')), { timeout: 15000 }, re.source);
  const closeAll = async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.modal-head button[aria-label="Cerrar"]')].reverse().forEach((b) => b.click()));
    await page.waitForFunction(() => !document.querySelector('.modal-backdrop'), { timeout: 5000 });
  };
  /** Elige un producto en el buscador (ProductPicker) del modal abierto. */
  async function pickProduct(page, name) {
    await page.type('.modal input[role=combobox]', name);
    await page.waitForFunction((n) => [...document.querySelectorAll('.modal [role=listbox] button')].some((b) => b.innerText.includes(n)), { timeout: 15000 }, name);
    await page.evaluate((n) => [...document.querySelectorAll('.modal [role=listbox] button')].find((b) => b.innerText.includes(n)).click(), name);
  }

  await t.test('operaciones: devolución, entrada, transferencia y cierre de caja', () => step(admin, 'operaciones', async () => {
    // Devolución desde el detalle de la venta del POS (muestra los lotes FEFO).
    await go(admin, '/admin/sales');
    await admin.waitForFunction(() => [...document.querySelectorAll('.content table tbody tr')].some((r) => /POS/.test(r.innerText) && /S\/ 4\.50/.test(r.innerText)), { timeout: 15000 });
    await admin.evaluate(() => [...document.querySelectorAll('.content table tbody tr')].find((r) => /POS/.test(r.innerText) && /S\/ 4\.50/.test(r.innerText)).click());
    await waitModal(admin, /Productos y lotes \(FEFO\)/);
    assert.match(await modalText(admin), /E2E-/, 'el detalle muestra el lote vendido');
    await clickText(admin, 'Devolución', '.modal button');
    await admin.waitForSelector('.modal input[aria-label^="Cantidad a devolver"]', { timeout: 15000 });
    await setValue(admin, '.modal input[aria-label^="Cantidad a devolver"]', '1');
    await clickText(admin, 'Registrar devolución', '.modal button');
    await waitModal(admin, /Devolución \S+[\s\S]*Completada/);
    await assertCleanText(admin, '.modal', 'detalle de devolución');
    const rets = (await api.get('/api/returns?branchId=1&status=COMPLETED')).body.data;
    assert.ok(rets.some((r) => r.refundAmount === '4.50'), 'devolución completada con reembolso');
    await closeAll(admin);

    // Entrada de mercadería contabilizada desde el editor.
    await go(admin, '/admin/entries');
    await settle(admin, '.content');
    await clickText(admin, 'Nueva entrada');
    await admin.waitForSelector('.modal input[role=combobox]');
    await setValue(admin, '.modal select:nth-of-type(1)', 'PURCHASE');
    await admin.evaluate((sid) => {
      const s = [...document.querySelectorAll('.modal select')].find((x) => [...x.options].some((o) => o.value === String(sid)));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, String(sid));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, otc.supplierId);
    await pickProduct(admin, otcName);
    await admin.waitForSelector('.modal input[aria-label="Número de lote"]');
    const lot = `E2E-ENT-${uid()}`;
    await setValue(admin, '.modal input[aria-label="Número de lote"]', lot);
    await setValue(admin, '.modal input[aria-label="Fecha de vencimiento"]', new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10));
    await setValue(admin, '.modal input[aria-label="Cantidad"]', '6');
    await setValue(admin, '.modal input[aria-label="Costo unitario"]', '2.10');
    await clickText(admin, 'Registrar y contabilizar', '.modal-foot button');
    await waitModal(admin, /Entrada \S+[\s\S]*Contabilizada/);
    assert.match(await modalText(admin), new RegExp(lot));
    await closeAll(admin);

    // Transferencia: solicitud → aprobación → despacho → recepción.
    const code = `E2E${uid().slice(0, 6).toUpperCase()}`;
    const nb = await api.post('/api/branches', { code, name: `Sucursal ${code}` });
    assert.equal(nb.status, 201, JSON.stringify(nb.body));
    await admin.goto(`${BASE}/admin/transfers`, { waitUntil: 'networkidle0' }); // recarga: la nueva sucursal entra en la lista
    await settle(admin, '.content');
    await clickText(admin, 'Nueva transferencia');
    await admin.waitForSelector('.modal input[role=combobox]');
    await pickProduct(admin, otcName);
    await admin.waitForSelector('.modal input[aria-label^="Cantidad lote"]', { timeout: 15000 });
    await setValue(admin, '.modal input[aria-label^="Cantidad lote"]', '2');
    await clickText(admin, 'Solicitar transferencia', '.modal-foot button');
    await waitModal(admin, /Transferencia \S+[\s\S]*Solicitada/);
    await clickText(admin, 'Aprobar', '.modal button');
    await waitModal(admin, /Aprobada/);
    await clickText(admin, 'Despachar', '.modal-body button');
    await clickText(admin, 'Despachar', '.modal-foot button');
    await admin.waitForSelector('.modal input[placeholder^="Llegó"]', { timeout: 15000 });
    await setValue(admin, '.modal input[placeholder^="Llegó"]', '2');
    await clickText(admin, 'Registrar recepción', '.modal button');
    await waitModal(admin, /Recibida/);
    await assertCleanText(admin, '.modal', 'detalle de transferencia');
    await closeAll(admin);

    // Cierre de caja con arqueo (50.00 inicial + 4.50 venta − 4.50 reembolso).
    await go(admin, '/admin/cash');
    await settle(admin, '.content');
    await clickText(admin, 'Cerrar caja');
    await admin.waitForSelector('.modal input[name=countedAmount]');
    await admin.type('.modal input[name=countedAmount]', '50.00');
    await clickText(admin, 'Cerrar caja', '.modal-foot button');
    await waitModal(admin, /Cierre de[\s\S]*Caja cuadrada/);
    await closeAll(admin);
    assert.deepEqual(admin.problems, [], admin.problems.join('\n'));
  }));

  /** Escribe credenciales en el acceso único y envía. */
  async function signIn(page, mail, pass) {
    await page.waitForFunction(() => location.pathname === '/acceso' && document.querySelector('input[name=email]:not([disabled])'), { timeout: 15000 });
    await page.type('input[name=email]', mail);
    await page.type('input[name=password]', pass);
    await page.keyboard.press('Enter');
  }
  const pathOf = (page) => page.evaluate(() => `${location.pathname}${location.search}`);

  await t.test('acceso único: personal, trabajador y cliente; retorno seguro, rutas antiguas y tema', async () => {
    // Trabajador (rol STAFF) que pide una ruta del panel sin sesión → acceso único → vuelve a ella si su rol lo permite.
    const worker = await withTransaction({ requestId: 'e2e-worker' }, (conn) => createTestUser(conn, { roleCode: 'STAFF', password: PASSWORD }));
    const w = await newPage();
    await step(w, 'trabajador', async () => {
      await w.goto(`${BASE}/admin/stock`, { waitUntil: 'networkidle0' });
      assert.equal(await pathOf(w), '/acceso?next=%2Fadmin%2Fstock');
      await shot(w, '13-acceso-claro');
      await signIn(w, worker.email, PASSWORD);
      await w.waitForSelector('.sidebar', { timeout: 15000 });
      const me = await w.evaluate(() => fetch('/api/auth/me').then((r) => r.json()));
      assert.equal(me.user.role.code, 'STAFF');
      const canStock = me.permissions.includes('inventory.view');
      await w.waitForFunction((ok) => (ok ? location.pathname === '/admin/stock' : location.pathname.startsWith('/admin')), { timeout: 15000 }, canStock);
      // Un trabajador no compra como cliente.
      await w.goto(`${BASE}/cuenta`);
      await w.waitForFunction(() => /Sesión del personal activa/.test(document.body.innerText), { timeout: 15000 });
      // Cerrar sesión desde el panel lleva al acceso único.
      await w.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
      await w.waitForSelector('.sidebar button[title="Cerrar sesión"]');
      await w.click('.sidebar button[title="Cerrar sesión"]');
      await w.waitForFunction(() => location.pathname === '/acceso', { timeout: 15000 });
      assert.deepEqual(w.problems, [], w.problems.join('\n'));
    });

    const p = await newPage(390, 844);
    await step(p, 'cliente y rutas', async () => {
      // Error genérico (no revela si el correo existe).
      await p.goto(`${BASE}/acceso`, { waitUntil: 'networkidle0' });
      await signIn(p, email, 'Incorrecta2026X');
      await p.waitForFunction(() => /incorrectos/i.test(document.querySelector('.access-alert.danger')?.innerText || ''), { timeout: 15000 });
      // Tema oscuro persistente.
      await p.click('button[aria-label="Tema oscuro"]');
      await p.waitForSelector('.access[data-theme="dark"]');
      await p.reload({ waitUntil: 'networkidle0' });
      await p.waitForSelector('.access[data-theme="dark"]');
      await shot(p, '14-acceso-oscuro-movil');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `acceso móvil: desborde de ${overflow}px`);
      await p.click('button[aria-label="Tema claro"]');
      // Ruta antigua /ingresar con retorno en formato antiguo → /acceso?next=/carrito; el cliente vuelve al carrito.
      await p.goto(`${BASE}/ingresar?next=carrito`, { waitUntil: 'networkidle0' });
      assert.equal(await pathOf(p), '/acceso?next=%2Fcarrito');
      await p.goto(`${BASE}/#/ingresar`, { waitUntil: 'networkidle0' });
      await p.waitForFunction(() => location.pathname === '/acceso', { timeout: 15000 });
      await p.goto(`${BASE}/carrito`, { waitUntil: 'networkidle0' });
      assert.equal(await pathOf(p), '/acceso?next=%2Fcarrito');
      await signIn(p, email, 'Cliente2026Seguro');
      await p.waitForFunction(() => location.pathname === '/carrito' && document.querySelector('#main h1')?.innerText === 'Carrito', { timeout: 15000 });
      // Un cliente no entra al panel.
      await p.goto(`${BASE}/admin/sales`, { waitUntil: 'networkidle0' });
      await p.waitForFunction(() => /Panel solo para el personal/.test(document.body.innerText), { timeout: 15000 });
      assert.equal(await p.$('.sidebar'), null);
      // Con sesión de cliente, el acceso a una ruta del panel ofrece cambiar de cuenta; al ingresar como personal la sesión de cliente se cierra.
      await p.goto(`${BASE}/acceso?next=%2Fadmin%2Fpos`, { waitUntil: 'networkidle0' });
      await p.waitForFunction(() => /sesión de cliente abierta/.test(document.body.innerText), { timeout: 15000 });
      await signIn(p, adminUser.email, PASSWORD);
      await p.waitForFunction(() => location.pathname === '/admin/pos' && document.querySelector('.sidebar'), { timeout: 15000 });
      const me = await p.evaluate(() => fetch('/api/auth/me').then((r) => r.json()));
      assert.equal(me.user.email, adminUser.email);
      assert.deepEqual(p.problems, [], p.problems.join('\n'));
    });

    // Redirección externa en ?next= se ignora.
    const x = await newPage();
    await step(x, 'redirección externa', async () => {
      await x.goto(`${BASE}/acceso?next=${encodeURIComponent('https://evil.example/robar')}`, { waitUntil: 'networkidle0' });
      await signIn(x, adminUser.email, PASSWORD);
      await x.waitForSelector('.sidebar', { timeout: 15000 });
      assert.match(x.url(), new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\/]/g, '\$&')}/admin`));
      await x.goto(`${BASE}/acceso?next=%2F%2Fevil.example`, { waitUntil: 'networkidle0' });
      await x.waitForFunction(() => location.pathname.startsWith('/admin'), { timeout: 15000 }); // ya autenticado: va a su panel
    });
  });

  await t.test('separación de portales', async () => {
    // El personal no puede comprar en la tienda con su sesión.
    await admin.goto(`${BASE}/carrito`);
    await admin.waitForFunction(() => /Sesión del personal activa/.test(document.body.innerText), { timeout: 15000 });
  });

  await t.test('diseño responsive (tableta y móvil)', async () => {
    for (const [w, hgt, tag] of [[820, 1180, 'tablet'], [390, 844, 'movil']]) {
      await shopper.setViewport({ width: w, height: hgt });
      await shopper.goto(`${BASE}/catalogo`);
      await shopper.waitForSelector('.product-card', { timeout: 15000 });
      const overflow = await shopper.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `tienda ${tag}: desborde horizontal de ${overflow}px: ${await overflowing(shopper)}`);
      await assertCleanText(shopper, '#main', `catálogo ${tag}`);
      await shot(shopper, `11-store-catalogo-${tag}`);

      const a = await newPage(w, hgt);
      await a.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
      await a.type('input[name=email]', adminUser.email);
      await a.type('input[name=password]', PASSWORD);
      await Promise.all([a.waitForSelector('.topbar', { timeout: 15000 }), a.keyboard.press('Enter')]);
      await go(a, '/admin/stock');
      await a.waitForSelector('.content table', { timeout: 15000 });
      const aOverflow = await a.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(aOverflow <= 1, `panel ${tag}: desborde horizontal de ${aOverflow}px: ${await overflowing(a)}`);
      await shot(a, `12-admin-stock-${tag}`);
      assert.deepEqual(a.problems, [], a.problems.join('\n'));
    }
  });
});
