'use strict';

/**
 * Regresión: imágenes de producto en el PANEL (Administrador → Productos) y en la tienda.
 *
 * Antes el panel solo pintaba `imageUrl` de la API, así que los productos con fotografía local (mapa por ID en
 * frontend/src/components/ProductImage.jsx) salían sin imagen hasta que alguien subía una a mano. Se comprueba:
 *   - listado recién abierto y tras recargar: imagen local (ID 196), imagen subida por API con prioridad (ID 212)
 *     y marcador para un producto sin fotografía (ID 197);
 *   - búsqueda, filtro por estado, edición (CRUD) y paginación conservan las imágenes;
 *   - detalle del panel, tarjetas y detalle de la tienda;
 *   - ninguna solicitud de imagen falla y no hay desplazamiento horizontal (PC y móvil).
 * Base TEMPORAL de npm run test:e2e: para reproducir los IDs reales se adelanta el AUTO_INCREMENT de products
 * (solo en esa base). Capturas en evidencias/product-images/e2e/.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// setup-env dirige las subidas a un directorio temporal del sistema, fuera del proyecto.
require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.PP_E2E === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(__dirname, '..', '..', 'evidencias', 'product-images', 'e2e');
const ASSETS = path.join(__dirname, '..', '..', 'frontend', 'src', 'assets', 'store', 'products');
const PASSWORD = 'Farmacia2026Segura';

test('imágenes de producto visibles en el panel sin editar y en la tienda', { skip: !enabled && 'Requiere PP_E2E=1 y una base temporal (npm run test:e2e)', timeout: 300000 }, async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip(`No se encontró Chrome en ${CHROME}`); return; }
  const puppeteer = require('puppeteer-core');
  const { config } = require('../../src/config/env');
  const { withTransaction, withConnection, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const { initRealtime, closeRealtime } = require('../../src/services/realtime.service');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, validRuc, limaDate, uid } = require('../helpers/http');
  fs.mkdirSync(OUT, { recursive: true });
  assert.notEqual(config.db.database, 'pharma_plus');

  const res = { browser: null, server: null };
  t.after(async () => {
    if (res.browser) await res.browser.close().catch(() => {});
    if (res.server) { await closeRealtime().catch(() => {}); await new Promise((r) => res.server.close(r)); }
    await closePool();
  });

  const app = createApp();
  const adminUser = await withTransaction({ requestId: 'e2e-img' }, (conn) => createTestUser(conn, { roleCode: 'ADMIN', password: PASSWORD }));
  const api = await loginClient(app, adminUser);
  const tag = uid();
  const categoryId = (await api.post('/api/categories', { name: `E2E Img ${tag}` })).body.data.id;
  const supplierId = (await api.post('/api/suppliers', { businessName: `Proveedor Img ${tag}`, ruc: validRuc() })).body.data.id;

  // Sin DDL (el usuario de la app no tiene ALTER): un producto INACTIVO de relleno con ID id-1 hace que la API
  // asigne exactamente `id` al siguiente producto. Solo en la base temporal.
  const setNextId = (id) => withConnection({}, async (c) => {
    const [[{ maxId }]] = await c.query('SELECT COALESCE(MAX(id), 0) AS maxId FROM products');
    assert.ok(maxId < id, `la base temporal ya tiene productos con ID ≥ ${id}`);
    if (maxId < id - 1) {
      await c.execute("INSERT INTO products (id, category_id, sku, name, sale_price, status) VALUES (?, ?, ?, ?, '1.00', 'INACTIVE')",
        [id - 1, categoryId, `IMG-RELLENO-${id - 1}-${tag}`, `Relleno ${tag}`]);
    }
  });
  const create = async (id, name) => {
    await setNextId(id);
    const p = await api.post('/api/products', { sku: `IMG-${id}-${tag}`, name: `${name} ${tag}`, categoryId, salePrice: '5.00', minimumStock: 2 });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.data.id, id);
    const e = await api.post('/api/inventory/entries', { branchId: 1, supplierId, confirm: true, items: [{ productId: id, batchNumber: `IMG-${id}-${tag}`, expiryDate: limaDate(300), quantity: 20, unitCost: '2.00' }] });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    return p.body.data;
  };
  await create(196, 'Ácido acetilsalicílico'); // fotografía local
  await create(197, 'Loratadina'); // sin fotografía → marcador
  await create(212, 'Amoxicilina'); // local + subida por API (la API tiene prioridad)
  const up = await api.agent.put('/api/products/212/image').set('X-CSRF-Token', api.csrf)
    .attach('image', fs.readFileSync(path.join(ASSETS, 'agua_oxigenada_10_vol_120ml.png')), { filename: 'subida.png', contentType: 'image/png' });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const uploaded = up.body.data.imageUrl;
  assert.ok(config.uploads.dir.startsWith(os.tmpdir()), 'la subida no debe escribir dentro del proyecto');

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  initRealtime(server);
  const BASE = `http://127.0.0.1:${server.address().port}`;
  res.server = server;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  res.browser = browser;

  const imgFailures = [];
  const watch = (page) => {
    page.on('requestfailed', (r) => { if (r.resourceType() === 'image') imgFailures.push(`falló ${r.url()}`); });
    page.on('response', (r) => { if (r.request().resourceType() === 'image' && r.status() >= 400) imgFailures.push(`${r.status()} ${r.url()}`); });
  };
  const settle = (page) => page.evaluate(async () => {
    for (const i of document.images) { i.loading = 'eager'; if (!i.complete) await new Promise((r) => { i.onload = r; i.onerror = r; }); }
  });
  // Estado de la miniatura de cada producto visible en el listado del panel.
  const adminThumbs = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.pp-pthumb')].map((el) => {
    const img = el.querySelector('img');
    const row = el.closest('tr, [role=row], .m-card, li, article') || el.parentElement;
    const id = img?.dataset.productId || (row?.innerText.match(/IMG-(\d+)-/) || [])[1];
    return [id, img ? { src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0, fit: getComputedStyle(img).objectFit, w: img.clientWidth, h: img.clientHeight } : { placeholder: Boolean(el.querySelector('.ico')) }];
  })));
  const expectAdmin = async (page, where) => {
    await page.waitForFunction(() => !document.querySelector('.spinner') && ['IMG-196-', 'IMG-197-', 'IMG-212-']
      .every((s) => [...document.querySelectorAll('tbody tr')].some((tr) => tr.innerText.includes(s))), { timeout: 15000 });
    await settle(page);
    const th = await adminThumbs(page);
    assert.ok(th['196']?.ok && /acido_acetilsalicilico/.test(th['196'].src) && th['196'].fit === 'contain', `${where} 196: ${JSON.stringify(th)}`);
    assert.ok(th['212']?.ok && th['212'].src === uploaded, `${where} 212 debe usar la imagen de la API: ${JSON.stringify(th)}`);
    assert.ok(th['197']?.placeholder, `${where} 197 debe mostrar el marcador: ${JSON.stringify(th)}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, `${where}: desplazamiento horizontal`);
  };
  const search = async (page, q) => {
    await page.waitForSelector('.toolbar input[type=search]', { timeout: 15000 });
    await page.$eval('.toolbar input[type=search]', (el) => { el.focus(); el.select(); });
    await page.keyboard.press('Backspace');
    if (q) await page.type('.toolbar input[type=search]', q);
    await page.waitForFunction((term) => !document.querySelector('.spinner') && document.querySelectorAll('.pp-pthumb').length > 0
      && [...document.querySelectorAll('tbody tr')].every((tr) => !term || tr.innerText.includes(term)), { timeout: 15000 }, q);
  };

  for (const [label, viewport] of [['pc', { width: 1440, height: 900 }], ['movil', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
    const page = await (await browser.createBrowserContext()).newPage();
    watch(page);
    await page.setViewport(viewport);
    await page.goto(`${BASE}/admin/products`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => location.pathname === '/acceso' && document.querySelector('input[name=email]:not([disabled])'), { timeout: 15000 });
    await page.type('input[name=email]', adminUser.email);
    await page.type('input[name=password]', PASSWORD);
    await page.click('form button[type=submit]');
    await page.waitForFunction(() => /\/admin/.test(location.pathname) && document.querySelector('.pp-admin'), { timeout: 15000 });
    if (!/\/admin\/products/.test(page.url())) await page.goto(`${BASE}/admin/products`, { waitUntil: 'networkidle0' });

    // 1) Listado recién abierto, sin editar nada.
    await search(page, tag);
    await expectAdmin(page, `${label} inicial`);
    await page.screenshot({ path: path.join(OUT, `admin-listado-inicial-${label}.png`) });

    // 2) Tras recargar la página.
    await page.reload({ waitUntil: 'networkidle0' });
    await search(page, tag);
    await expectAdmin(page, `${label} recarga`);
    await page.screenshot({ path: path.join(OUT, `admin-listado-recarga-${label}.png`) });

    if (label === 'pc') {
      // 3) Filtro de estado: inactivos (solo los de relleno, con marcador) → activos (vuelven con imagen).
      const statusSel = 'select[aria-label="Estado"]';
      await page.select(statusSel, 'INACTIVE');
      await page.waitForFunction(() => !document.querySelector('.spinner') && document.querySelector('tbody tr')
        && [...document.querySelectorAll('tbody tr')].every((tr) => /IMG-RELLENO-/.test(tr.innerText) && tr.querySelector('.pp-pthumb > .ico')), { timeout: 15000 });
      await page.select(statusSel, 'ACTIVE');
      await expectAdmin(page, 'filtro');

      // 4) CRUD: se edita el nombre de 196 por la API y se recarga el listado; la imagen se mantiene.
      const ed = await api.put('/api/products/196', { description: `Editado ${tag}` });
      assert.equal(ed.status, 200, JSON.stringify(ed.body));
      await page.reload({ waitUntil: 'networkidle0' });
      await search(page, tag);
      await expectAdmin(page, 'tras editar');

      // 5) Detalle del panel: imagen local y marcador.
      await page.evaluate(() => [...document.querySelectorAll('tr')].find((tr) => /Ácido/.test(tr.innerText))?.click());
      await page.waitForSelector('.modal .pp-pthumb.lg img', { timeout: 15000 });
      await settle(page);
      assert.ok(await page.$eval('.modal .pp-pthumb.lg img', (i) => i.naturalWidth > 0 && /acido_acetilsalicilico/.test(i.src)));
      await page.screenshot({ path: path.join(OUT, 'admin-detalle-con-imagen-pc.png') });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 10000 });
      await page.evaluate(() => [...document.querySelectorAll('tr')].find((tr) => /Loratadina/.test(tr.innerText))?.click());
      await page.waitForSelector('.modal .pp-pthumb.lg > .ico', { timeout: 15000 });
      await page.screenshot({ path: path.join(OUT, 'admin-detalle-sin-imagen-pc.png') });
      await page.keyboard.press('Escape');

      // 6) Paginación: sin búsqueda hay más de 20 productos en la base temporal; las páginas se pintan sin errores.
      await search(page, '');
      await page.waitForFunction(() => document.querySelectorAll('.pp-pthumb').length > 0, { timeout: 15000 });
      const next = (await page.$$('.pagination button')).at(-1);
      if (next && !(await page.evaluate((b) => b.disabled, next))) {
        const firstRow = await page.$eval('tbody tr', (tr) => tr.innerText);
        await next.click();
        await page.waitForFunction((f) => document.querySelector('tbody tr')?.innerText !== f, { timeout: 15000 }, firstRow);
        await page.waitForFunction(() => !document.querySelector('.spinner') && document.querySelectorAll('.pp-pthumb').length > 0, { timeout: 15000 });
        await settle(page);
        const bad = await page.evaluate(() => [...document.querySelectorAll('.pp-pthumb img')].filter((i) => !(i.naturalWidth > 0)).map((i) => i.src));
        assert.deepEqual(bad, [], 'página 2 sin imágenes rotas');
      }
    }

    // 7) Tienda: tarjetas y detalle con la misma prioridad.
    await page.goto(`${BASE}/catalogo?q=${encodeURIComponent(tag)}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.product-card', { timeout: 15000 });
    await settle(page);
    const cards = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.product-card')].map((c) => {
      const id = c.querySelector('a').getAttribute('href').split('/').pop();
      const img = c.querySelector('img');
      return [id, img ? { src: img.getAttribute('src'), ok: img.naturalWidth > 0 } : { placeholder: Boolean(c.querySelector('.img > .ico')) }];
    })));
    assert.ok(cards['196']?.ok && /acido_acetilsalicilico/.test(cards['196'].src), JSON.stringify(cards));
    assert.ok(cards['212']?.ok && cards['212'].src === uploaded, JSON.stringify(cards));
    assert.ok(cards['197']?.placeholder, JSON.stringify(cards));
    await page.screenshot({ path: path.join(OUT, `tienda-catalogo-${label}.png`) });
    for (const id of [196, 197]) {
      await page.goto(`${BASE}/producto/${id}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.product-detail', { timeout: 15000 });
      await settle(page);
      const d = await page.evaluate(() => ({ img: document.querySelector('.product-detail img')?.naturalWidth > 0, ph: Boolean(document.querySelector('.product-detail .img > .ico')) }));
      assert.ok(id === 196 ? d.img : d.ph && !d.img, `detalle ${id}: ${JSON.stringify(d)}`);
    }
    await page.close();
  }
  assert.deepEqual(imgFailures, [], 'solicitudes de imagen fallidas');
});
