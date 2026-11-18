'use strict';

/**
 * Capturas de la tienda virtual (Bocetos/recortes-tienda) en PC y móvil, tema claro y oscuro, y comprobaciones de
 * presentación: logo según el tema, contador real del carrito, menú de categorías reales, navegación inferior,
 * persistencia del tema (independiente del panel y del acceso), sin desborde en 360/390/430 px, tableta y PC,
 * y que no se prometa "Envíos a todo el Perú". Corre solo sobre la base TEMPORAL (npm run test:e2e);
 * los productos de prueba se crean por la API y desaparecen con la base. Guarda las imágenes en $E2E_SCREENSHOTS/tienda/ (carpeta temporal; las capturas del README salen de npm run capturas:reales).
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const enabled = process.env.PP_E2E === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(process.env.E2E_SCREENSHOTS || path.join(require('node:os').tmpdir(), 'pp-e2e-screens'), 'tienda');
const PASSWORD = 'Farmacia2026Segura';

test('capturas de la tienda: PC y móvil, claro y oscuro', { skip: !enabled && 'Requiere PP_E2E=1 y una base temporal (npm run test:e2e)', timeout: 300000 }, async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip(`No se encontró Chrome en ${CHROME}`); return; }
  const puppeteer = require('puppeteer-core');
  const { withTransaction, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const { initRealtime, closeRealtime } = require('../../src/services/realtime.service');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, storeCustomer, validRuc, limaDate, uid } = require('../helpers/http');
  fs.mkdirSync(path.join(OUT, 'vistas'), { recursive: true });

  // ----------------------------------------------- datos de prueba (base temporal)
  const app = createApp();
  const adminUser = await withTransaction({ requestId: 'e2e-store-shots' }, (conn) => createTestUser(conn, { roleCode: 'ADMIN', password: PASSWORD }));
  const api = await loginClient(app, adminUser);
  const cat1 = (await api.post('/api/categories', { name: `Analgésicos ${uid()}` })).body.data.id;
  const cat2 = (await api.post('/api/categories', { name: `Vitaminas ${uid()}` })).body.data.id;
  const supplierId = (await api.post('/api/suppliers', { businessName: `Distribuidora ${uid()}`, ruc: validRuc() })).body.data.id;
  const items = [];
  for (const [name, presentation, categoryId, salePrice, rx] of [
    ['Paracetamol 500 mg', 'Caja x 100 tabletas', cat1, '12.50', false], ['Ibuprofeno 400 mg', 'Caja x 50 tabletas', cat1, '18.90', false],
    ['Omeprazol 20 mg', 'Caja x 30 cápsulas', cat1, '24.00', true], ['Vitamina C 1 g', 'Frasco x 60 tabletas', cat2, '32.00', false],
    ['Alcohol medicinal 70°', 'Frasco x 250 ml', cat2, '6.50', false],
  ]) {
    const p = await api.post('/api/products', { sku: `ST-${uid()}`, name, presentation, categoryId, salePrice, requiresPrescription: rx });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    items.push({ productId: p.body.data.id, batchNumber: `ST-${uid()}`, expiryDate: limaDate(300), quantity: 40, unitCost: '3.00' });
  }
  assert.equal((await api.post('/api/inventory/entries', { branchId: 1, supplierId, confirm: true, items })).status, 201);
  const cust = await storeCustomer(app);
  assert.equal((await cust.put(`/api/store/cart/items/${items[0].productId}`, { quantity: 2 })).status, 200);

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

  async function storePage(width, height, theme, { login = false } = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    page.problems = [];
    page.on('pageerror', (e) => page.problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.problems.push(`console: ${m.text()}`); });
    page.on('response', (r) => { if (r.status() >= 500) page.problems.push(`HTTP ${r.status()} ${r.url()}`); });
    await page.evaluateOnNewDocument((th) => { try { if (!localStorage.getItem('pharma_plus_store_theme')) localStorage.setItem('pharma_plus_store_theme', th); } catch { /* */ } }, theme);
    if (login) {
      await page.goto(`${BASE}/acceso`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('input[name=email]:not([disabled])');
      await page.type('input[name=email]', cust.email);
      await page.type('input[name=password]', cust.password);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.pathname === '/' && document.querySelector('.pp-store'), { timeout: 15000 });
    } else {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    }
    await settle(page);
    return page;
  }
  const settle = async (page) => {
    await page.waitForFunction(() => { const m = document.querySelector('#main'); return m && !m.querySelector('.spinner'); }, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 300));
  };
  const go = async (page, url) => {
    await page.evaluate((u) => { window.history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate')); }, url);
    await page.waitForFunction((u) => location.pathname + location.search === u, { timeout: 10000 }, url);
    await settle(page);
  };
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const clean = async (page, label) => {
    const text = await page.$eval('.pp-store', (el) => el.innerText);
    assert.equal(text.match(/\[object \w+\]|\bundefined\b|\bNaN\b/), null, `${label}: texto inválido`);
    assert.doesNotMatch(text, /Envíos a todo el Perú/i, `${label}: no se promete cobertura nacional`);
  };

  for (const [device, w, h] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    for (const [theme, name] of [['light', 'claro'], ['dark', 'oscuro']]) {
      await t.test(`inicio ${device} ${name} (cliente con carrito)`, async () => {
        const page = await storePage(w, h, theme, { login: true });
        assert.equal(await page.$eval('.pp-store', (el) => el.dataset.theme), theme);
        assert.match(await page.$eval('.st-logo img', (el) => el.getAttribute('src')), theme === 'dark' ? /logo-oscuro/ : /logo-claro/);
        assert.equal(await page.$eval('.st-count', (el) => el.innerText.trim()), '2', 'contador real del carrito');
        await page.waitForFunction(() => document.querySelectorAll('.product-card').length >= 5, { timeout: 15000 });
        // Banner con la ilustración extraída de la referencia, según el tema.
        await page.waitForFunction(() => { const i = document.querySelector('.st-banner-art'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 15000 });
        assert.match(await page.$eval('.st-banner-art', (el) => el.getAttribute('src')), theme === 'dark' ? /hero-art-dark/ : /hero-art-light/);
        await clean(page, `inicio ${device} ${name}`);
        assert.ok(await overflow(page) <= 1, `desborde en ${device} ${name}`);
        await page.screenshot({ path: path.join(OUT, `store-${device}-${name}.png`) });
        // Resto de vistas con el mismo sistema visual.
        for (const [route, tag] of [['/catalogo', 'catalogo'], [`/producto/${items[0].productId}`, 'producto'], ['/carrito', 'carrito'], ['/checkout', 'checkout'], ['/pedidos', 'pedidos'], ['/cuenta', 'cuenta']]) {
          await go(page, route);
          await page.waitForFunction(() => document.querySelector('#main h1'), { timeout: 15000 });
          assert.equal(await page.$('#main .state.error'), null, `${route} mostró error`);
          await clean(page, `${route} ${device} ${name}`);
          assert.ok(await overflow(page) <= 1, `desborde en ${route} ${device} ${name}`);
          await page.screenshot({ path: path.join(OUT, 'vistas', `${tag}-${device}-${name}.png`), fullPage: device === 'mobile' });
        }
        assert.deepEqual(page.problems, [], page.problems.join('\n'));
        await page.browserContext().close();
      });
    }
  }

  await t.test('PC a todo el ancho: 1366, 1440 y 1920', async () => {
    for (const [w, h] of [[1366, 768], [1440, 900], [1920, 1080]]) {
      for (const [theme, name] of [['light', 'claro'], ['dark', 'oscuro']]) {
        const page = await storePage(w, h, theme, { login: true });
        await page.waitForFunction(() => { const i = document.querySelector('.st-banner-art'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 15000 });
        const m = await page.evaluate(() => {
          const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width }; };
          const art = document.querySelector('.st-banner-art').getBoundingClientRect(); const ban = document.querySelector('.st-banner').getBoundingClientRect(); return { vw: document.documentElement.clientWidth, header: r('.st-header-row'), banner: r('.st-banner'), benefits: r('.st-benefits'), grid: r('.products'), artH: art.height, artTop: art.top - ban.top, banH: ban.height, artW: art.width };
        });
        assert.ok(m.header.width >= m.vw - 1, `cabecera al 100 % en ${w}px: ${JSON.stringify(m)}`);
        // El contenido ocupa el ancho (márgenes laterales pequeños, sin contenedor estrecho centrado).
        assert.ok(m.banner.left < 70 && m.vw - m.benefits.right < 70, `banner y beneficios llegan a los bordes en ${w}px`);
        assert.ok(Math.abs(m.artH - m.banH) <= 2 && Math.abs(m.artTop) <= 1, `la ilustración cubre todo el alto del banner en ${w}px: ${JSON.stringify({ artH: m.artH, artTop: m.artTop, banH: m.banH, artW: m.artW })}`);
        assert.ok(m.grid.width > m.vw * 0.9, `cuadrícula de productos amplia en ${w}px`);
        assert.ok(m.benefits.left > m.banner.right, `beneficios a la derecha del banner en ${w}px`);
        assert.ok(await overflow(page) <= 1, `desborde en ${w}px`);
        await page.screenshot({ path: path.join(OUT, `store-desktop-${w}-${name}.png`) });
        await page.browserContext().close();
      }
    }
  });

  await t.test('visitante: inicio, registro y otras resoluciones sin desborde', async () => {
    for (const [w, h, tag] of [[360, 800, 'movil-360'], [430, 932, 'movil-430'], [820, 1180, 'tableta'], [1280, 720, 'pc-1280']]) {
      const page = await storePage(w, h, 'light');
      await clean(page, tag);
      assert.ok(await overflow(page) <= 1, `desborde en ${tag}`);
      await page.screenshot({ path: path.join(OUT, `store-visitante-${tag}.png`) });
      await page.browserContext().close();
    }
    const page = await storePage(1440, 900, 'dark');
    assert.match(await page.$eval('.st-header', (el) => el.innerText), /Iniciar sesión \/ Registrarse/);
    assert.equal(await page.$('.st-count'), null, 'sin carrito no hay contador');
    // /registro es ahora una pantalla completa propia (fuera del marco de la tienda): se prueba en 05-registro.
    await page.evaluate(() => { window.history.pushState({}, '', '/registro'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForSelector('.access-register .access-card', { timeout: 15000 });
    await page.browserContext().close();
  });

  await t.test('categorías reales, navegación inferior y tema independiente', async () => {
    const page = await storePage(1440, 900, 'light');
    await page.click('.st-cat-btn');
    await page.waitForSelector('.st-menu-cats');
    const cats = await page.$$eval('.st-menu-cats a', (els) => els.map((e) => e.innerText));
    assert.ok(cats.some((c) => /Analgésicos/.test(c)) && cats.some((c) => /Vitaminas/.test(c)), 'el menú lista las categorías reales');
    await page.screenshot({ path: path.join(OUT, 'store-desktop-categorias.png') });
    await page.evaluate(() => [...document.querySelectorAll('.st-menu-cats a')].find((a) => /Vitaminas/.test(a.innerText)).click());
    await page.waitForFunction(() => location.pathname === '/catalogo' && /cat=/.test(location.search), { timeout: 10000 });
    await settle(page);
    assert.match(await page.$eval('#main', (el) => el.innerText), /Vitamina C 1 g/);
    // Tema: persiste y no toca las claves del panel ni del acceso.
    await page.click('.st-theme button[aria-label="Tema oscuro"]');
    await page.waitForSelector('.pp-store[data-theme="dark"]');
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.pp-store[data-theme="dark"]');
    const keys = await page.evaluate(() => [localStorage.getItem('pharma_plus_store_theme'), localStorage.getItem('pharma_plus_admin_theme'), localStorage.getItem('pp.theme')]);
    assert.deepEqual(keys, ['dark', null, null]);
    await page.browserContext().close();

    const m = await storePage(390, 844, 'light');
    const tabs = await m.$$eval('.st-bottom a, .st-bottom button', (els) => els.map((e) => e.innerText.trim()));
    assert.deepEqual(tabs, ['Inicio', 'Categorías', 'Pedidos', 'Cuenta']);
    await m.click('.st-bottom button');
    await m.waitForSelector('.st-sheet');
    await m.screenshot({ path: path.join(OUT, 'store-mobile-categorias.png') });
    await m.keyboard.press('Escape');
    await m.click('.st-burger');
    await m.waitForSelector('.st-drawer');
    await m.screenshot({ path: path.join(OUT, 'store-mobile-menu.png') });
    // La barra inferior no tapa el último contenido (el pie queda por encima de ella).
    await m.keyboard.press('Escape');
    const gap = await m.evaluate(() => {
      const nav = document.querySelector('.st-bottom').getBoundingClientRect();
      window.scrollTo(0, document.documentElement.scrollHeight);
      return document.documentElement.scrollHeight - document.querySelector('.st-footer').getBoundingClientRect().bottom - window.scrollY + nav.height;
    });
    assert.ok(gap >= 0, 'el contenido no queda oculto bajo la barra inferior');
    await m.browserContext().close();
  });
});
