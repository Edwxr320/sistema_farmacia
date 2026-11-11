'use strict';

/**
 * Capturas del panel administrativo (diseño de Bocetos/recortes/admin-*.png) en PC y móvil, tema claro y oscuro.
 * Solo corre sobre la base TEMPORAL de npm run test:e2e: los datos de prueba (ventas, pedidos, lotes) se crean por la API
 * y desaparecen con la base. Guarda las imágenes en evidencias/admin/.
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const enabled = process.env.PP_E2E === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(__dirname, '..', '..', 'evidencias', 'admin');
const PASSWORD = 'Farmacia2026Segura';
const ADMIN_ROUTES = ['dashboard', 'pos', 'cash', 'sales', 'returns', 'orders', 'stock', 'batches', 'kardex', 'alerts', 'entries', 'adjustments',
  'transfers', 'products', 'categories', 'laboratories', 'suppliers', 'customers', 'users', 'roles', 'branches', 'settings', 'reports'];

test('capturas del panel: PC y móvil, claro y oscuro', { skip: !enabled && 'Requiere PP_E2E=1 y una base temporal (npm run test:e2e)', timeout: 300000 }, async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip(`No se encontró Chrome en ${CHROME}`); return; }
  const puppeteer = require('puppeteer-core');
  const { withTransaction, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const { initRealtime, closeRealtime } = require('../../src/services/realtime.service');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, stockedProduct, storeCustomer, uid } = require('../helpers/http');
  fs.mkdirSync(path.join(OUT, 'modulos'), { recursive: true });

  // ------------------------------------------------ datos de prueba (base temporal)
  const app = createApp();
  const adminUser = await withTransaction({ requestId: 'e2e-shots' }, (conn) => createTestUser(conn, { roleCode: 'ADMIN', password: PASSWORD }));
  const api = await loginClient(app, adminUser);
  const a = await stockedProduct(api, { salePrice: '12.50', minimumStock: 5, batches: [{ batchNumber: `CAP-${uid()}`, days: 300, quantity: 80 }] });
  const b = await stockedProduct(api, { salePrice: '8.90', minimumStock: 5, categoryId: a.categoryId, supplierId: a.supplierId, batches: [{ batchNumber: `CAP-${uid()}`, days: 20, quantity: 40 }] });
  const c = await stockedProduct(api, { salePrice: '23.00', minimumStock: 50, categoryId: a.categoryId, supplierId: a.supplierId, batches: [{ batchNumber: `CAP-${uid()}`, days: 200, quantity: 12 }] });
  const reg = (await api.get('/api/cash/registers')).body.data[0];
  assert.equal((await api.post('/api/cash/sessions', { cashRegisterId: reg.id, openingAmount: '100.00' })).status, 201);
  for (const [items, method] of [
    [[{ productId: a.productId, quantity: 3 }], 'CASH'], [[{ productId: b.productId, quantity: 2 }], 'YAPE'],
    [[{ productId: c.productId, quantity: 1 }, { productId: a.productId, quantity: 1 }], 'CARD'], [[{ productId: a.productId, quantity: 4 }], 'PLIN'],
    [[{ productId: b.productId, quantity: 5 }], 'CASH'],
  ]) {
    const r = await api.post('/api/sales', { branchId: 1, items, payments: [{ method }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const cust = await storeCustomer(app);
  for (const [pid, q] of [[a.productId, 2], [b.productId, 1]]) {
    await cust.del('/api/store/cart');
    assert.equal((await cust.put(`/api/store/cart/items/${pid}`, { quantity: q })).status, 200);
    const o = await cust.post('/api/store/orders', { fulfillmentType: 'PICKUP', paymentMethod: 'CASH' });
    assert.equal(o.status, 201, JSON.stringify(o.body));
  }
  await api.post('/api/inventory/alerts/refresh-expiry', {});

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  initRealtime(server);
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check', '--font-render-hinting=none'] });
  t.after(async () => {
    await browser.close().catch(() => {});
    await closeRealtime().catch(() => {});
    await new Promise((r) => server.close(r));
    await closePool();
  });

  async function adminPage(width, height, theme) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    page.problems = [];
    page.on('pageerror', (e) => page.problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.problems.push(`console: ${m.text()}`); });
    page.on('response', (r) => { if (r.status() >= 500) page.problems.push(`HTTP ${r.status()} ${r.url()}`); });
    // Tema inicial solo si aún no hay preferencia guardada (así se puede comprobar la persistencia al recargar).
    await page.evaluateOnNewDocument((th) => { try { if (!localStorage.getItem('pharma_plus_admin_theme')) localStorage.setItem('pharma_plus_admin_theme', th); } catch { /* */ } }, theme);
    await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => location.pathname === '/acceso' && document.querySelector('input[name=email]:not([disabled])'), { timeout: 15000 });
    await page.type('input[name=email]', adminUser.email);
    await page.type('input[name=password]', PASSWORD);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.pp-admin .content', { timeout: 15000 });
    return page;
  }
  const settle = async (page) => {
    await page.waitForFunction(() => { const el = document.querySelector('.content'); return el && el.querySelector('h1') && !el.querySelector('.spinner'); }, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 350));
  };
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const go = (page, url) => page.evaluate((u) => { window.history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate')); }, url);

  for (const [device, w, h] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    for (const [theme, name] of [['light', 'claro'], ['dark', 'oscuro']]) {
      await t.test(`dashboard ${device} ${name}`, async () => {
        const page = await adminPage(w, h, theme);
        await settle(page);
        await page.waitForSelector('.lc svg', { timeout: 15000 });
        assert.equal(await page.$eval('.pp-admin', (el) => el.dataset.theme), theme);
        const logo = await page.$eval(device === 'desktop' ? '.sidebar .brand img' : '.m-header img', (el) => el.getAttribute('src'));
        assert.match(logo, theme === 'dark' ? /logo-oscuro/ : /logo-claro/);
        assert.ok(await overflow(page) <= 1, `desborde horizontal en ${device} ${name}`);
        // Sin textos de datos mal formados.
        const text = await page.$eval('.content', (el) => el.innerText);
        assert.equal(text.match(/\[object \w+\]|\bundefined\b|\bNaN\b/), null);
        await page.screenshot({ path: path.join(OUT, `admin-${device}-${name}.png`) });
        if (device === 'mobile') await page.screenshot({ path: path.join(OUT, `admin-${device}-${name}-completo.png`), fullPage: true });
        assert.deepEqual(page.problems, [], page.problems.join('\n'));
        await page.browserContext().close();
      });
    }
  }

  await t.test('todos los módulos con el mismo sistema visual (claro y oscuro)', async () => {
    for (const [theme, name] of [['light', 'claro'], ['dark', 'oscuro']]) {
      const page = await adminPage(1440, 900, theme);
      for (const r of ADMIN_ROUTES) {
        await go(page, `/admin/${r}`);
        await page.waitForFunction(() => document.querySelector('.content h1, .content .pos'), { timeout: 15000 });
        await page.waitForFunction(() => !document.querySelector('.content .spinner'), { timeout: 20000 });
        await new Promise((res) => setTimeout(res, 200));
        assert.equal(await page.$('.content .state.error'), null, `/admin/${r} mostró error`);
        await page.screenshot({ path: path.join(OUT, 'modulos', `${r}-${name}.png`) });
      }
      assert.deepEqual(page.problems, [], page.problems.join('\n'));
      await page.browserContext().close();
    }
  });

  await t.test('móvil: navegación inferior, hoja "Más" y tema persistente', async () => {
    const page = await adminPage(390, 844, 'light');
    await settle(page);
    const tabs = await page.$$eval('.bottom-nav a, .bottom-nav button', (els) => els.map((e) => e.innerText.trim()));
    assert.deepEqual(tabs.map((x) => x.replace(/\d+$/, '').trim()), ['Inicio', 'Ventas', 'Inventario', 'Reportes', 'Más']);
    await page.click('.bottom-nav button');
    await page.waitForSelector('.sheet');
    await page.screenshot({ path: path.join(OUT, 'admin-mobile-mas.png') });
    await page.evaluate(() => [...document.querySelectorAll('.theme-cards button')].find((b) => /Oscuro/.test(b.innerText)).click());
    await page.waitForSelector('.pp-admin[data-theme="dark"]');
    assert.equal(await page.evaluate(() => localStorage.getItem('pharma_plus_admin_theme')), 'dark');
    await page.evaluate(() => [...document.querySelectorAll('.sheet-grid a')].find((a) => /Productos/.test(a.innerText)).click());
    await page.waitForFunction(() => location.pathname === '/admin/products' && !document.querySelector('.sheet'), { timeout: 15000 });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.pp-admin[data-theme="dark"]', { timeout: 15000 });
    await settle(page);
    assert.ok(await overflow(page) <= 1);
    await page.screenshot({ path: path.join(OUT, 'admin-mobile-productos-oscuro.png') });
    // El tema del panel no afecta a la tienda.
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-admin-theme')), null);
    assert.deepEqual(page.problems, [], page.problems.join('\n'));
    await page.browserContext().close();
  });
});
