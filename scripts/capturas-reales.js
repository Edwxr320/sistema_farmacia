'use strict';

/**
 * Capturas REALES de Pharma Plus para el README (npm run capturas:reales).
 *
 * - Usa la base configurada en .env (pharma_plus de XAMPP) con sus productos, fotos, ventas y pedidos reales.
 * - Todo lo que hace la sesión de capturas (usuarios temporales para iniciar sesión, carrito, caja abierta para
 *   el POS, sesiones y auditoría) ocurre en UNA transacción sobre UNA conexión que se revierte al final
 *   (mismo mecanismo que tests/helpers/transactional-db.js). Si el proceso se interrumpe, MariaDB revierte
 *   la transacción al cerrarse la conexión. No se confirma ninguna venta ni pedido.
 * - Antes y después se calcula CHECKSUM TABLE de todas las tablas: el script falla si cambia algo.
 *   (Solo los contadores AUTO_INCREMENT pueden avanzar: InnoDB no los revierte).
 * - Los correos y teléfonos visibles en el panel se difuminan antes de capturar (el repositorio es público).
 *
 * Requiere: frontend compilado (npm run build), MariaDB en marcha y Chrome (CHROME_PATH).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Proceso aislado: secretos propios, sin tareas programadas ni logs. UPLOADS_DIR se respeta (imágenes reales).
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.CSRF_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.JOBS_ENABLED = 'false';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const express = require('express');
const puppeteer = require('puppeteer-core');
const { config } = require('../src/config/env');
const { getPool, closePool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { initRealtime, closeRealtime } = require('../src/services/realtime.service');
const { hashPassword } = require('../src/services/password.service');
const userRepository = require('../src/repositories/user.repository');
const roleRepository = require('../src/repositories/role.repository');
const branchRepository = require('../src/repositories/branch.repository');
const { startTransactionalDb } = require('../tests/helpers/transactional-db');
const { loginClient, storeCustomer } = require('../tests/helpers/http');

const ROOT = path.resolve(__dirname, '..');
const EV = path.join(ROOT, 'evidencias');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const THEMES = [['light', 'claro'], ['dark', 'oscuro']];
const DESKTOP = [1440, 900];
const MOBILE = [390, 844];
const PASSWORD = `Capturas${crypto.randomBytes(6).toString('hex')}A1`;
// Productos reales con fotografía (mapa local del frontend o imagen subida desde el panel).
const DETAIL_PRODUCT = 212; // Amoxicilina 500 mg (requiere receta)
const CART = [[203, 2], [204, 1], [212, 1]]; // Alcohol en gel, Algodón hidrófilo, Amoxicilina
const POS_PRODUCTS = ['Alcohol en gel', 'Agua oxigenada', 'Algodón hidrófilo'];

const shots = [];
let before = null;
const log = (...a) => console.log('[capturas]', ...a);

async function fingerprint() {
  const conn = await getPool().getConnection();
  try {
    const [tables] = await conn.query(
      "SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    );
    const [rows] = await conn.query(`CHECKSUM TABLE ${tables.map((r) => `\`${r.t}\``).join(', ')}`);
    return Object.fromEntries(rows.map((r) => [r.Table.split('.').pop(), String(r.Checksum)]));
  } finally {
    conn.release();
  }
}

async function createUser(conn, roleCode, fullName) {
  const role = await roleRepository.findActiveByCode(conn, roleCode);
  const email = `capturas.${roleCode.toLowerCase()}.${crypto.randomBytes(4).toString('hex')}@pharmaplus.test`;
  const id = await userRepository.insertUser(conn, { roleId: role.id, fullName, email, passwordHash: await hashPassword(PASSWORD) });
  const main = await branchRepository.findMainBranch(conn);
  await branchRepository.assignUserBranch(conn, { userId: id, branchId: main.id, isDefault: true });
  return { id, email, password: PASSWORD };
}

/** Atiende /api y /socket.io de una en una: todas comparten la única conexión de la transacción. */
function serialized(app) {
  const outer = express();
  let queue = Promise.resolve();
  outer.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const turn = queue.then(() => new Promise((done) => {
      res.once('finish', done);
      res.once('close', done);
      next();
    }));
    queue = turn.catch(() => {});
    return undefined;
  });
  outer.use(app);
  return outer;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'frontend', 'dist', 'index.html'))) throw new Error('Falta frontend/dist: ejecute npm run build');
  if (!fs.existsSync(CHROME)) throw new Error(`No se encontró Chrome en ${CHROME} (CHROME_PATH)`);
  if (/^pp_test_/.test(config.db.database)) throw new Error('Las capturas se toman sobre la base real, no sobre una temporal');
  log(`base: ${config.db.database}`);

  before = await fingerprint();
  const tx = await startTransactionalDb();
  let browser;
  let server;
  try {
    // ------------------------------------------------ cuentas temporales (dentro de la transacción)
    const admin = await createUser(tx.conn, 'ADMIN', 'Administrador Demo');
    const app = createApp();
    const api = await loginClient(app, admin);
    const cust = await storeCustomer(app, { body: { fullName: 'Cliente Demo' } });
    for (const [productId, quantity] of CART) {
      const r = await cust.put(`/api/store/cart/items/${productId}`, { quantity });
      if (r.status !== 200) throw new Error(`carrito: ${JSON.stringify(r.body)}`);
    }
    const addr = await cust.post('/api/store/me/addresses', {
      label: 'Casa', recipientName: 'Cliente Demo', phone: '900000000', addressLine: 'Av. Demostración 123', referenceNote: 'Dirección de ejemplo (no se guarda)',
      district: 'Miraflores', province: 'Lima', department: 'Lima', isDefault: true,
    });
    if (addr.status !== 201) throw new Error(`dirección: ${JSON.stringify(addr.body)}`);
    const [[stats]] = await tx.conn.query(
      `SELECT COUNT(*) total, SUM(image_url IS NOT NULL) uploaded FROM products WHERE status = 'ACTIVE'`,
    );
    log(`productos activos: ${stats.total} (con imagen subida: ${stats.uploaded})`);

    server = serialized(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    initRealtime(server);
    const BASE = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check', '--font-render-hinting=none'] });

    // ------------------------------------------------------------------ utilidades
    async function newPage([w, h], themeKey, theme) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      page.problems = [];
      page.on('pageerror', (e) => page.problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.problems.push(`console: ${m.text()}`); });
      page.on('requestfailed', (r) => { if (!/socket\.io/.test(r.url())) page.problems.push(`requestfailed: ${r.url()}`); });
      page.on('response', (r) => {
        const expected401 = r.status() === 401 && /\/api\/auth\/me|\/api\/store\/me|\/api\/store\/cart/.test(r.url());
        if (r.status() >= 400 && !expected401) page.problems.push(`HTTP ${r.status()} ${r.url()}`);
      });
      // Mecanismo real de preferencias: la clave de localStorage que lee cada portal al iniciar.
      await page.evaluateOnNewDocument((k, th) => { try { localStorage.setItem(k, th); } catch { /* */ } }, themeKey, theme);
      return page;
    }
    async function visibleImagesLoaded(page, scope) {
      await page.waitForFunction((sel) => [...document.querySelectorAll(`${sel} img`)].filter((i) => {
        const r = i.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.width > 0;
      }).every((i) => i.complete), { timeout: 20000 }, scope);
      const broken = await page.$$eval(`${scope} img`, (ims) => ims.filter((i) => {
        const r = i.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.width > 0 && i.complete && i.naturalWidth === 0;
      }).map((i) => i.src));
      if (broken.length) throw new Error(`imágenes rotas: ${broken.join(', ')}`);
      return page.$$eval(`${scope} img[data-product-id]`, (ims) => ims.filter((i) => {
        const r = i.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && i.naturalWidth > 0;
      }).length);
    }
    async function redact(page) {
      return page.evaluate(() => {
        const re = /[\w.+-]+@[\w-]+(\.[\w-]+)+|(?<![\d-])(\+?51[\s-]?)?9\d{2}[\s-]?\d{3}[\s-]?\d{3}(?![\d-])/;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const els = new Set();
        while (walker.nextNode()) if (re.test(walker.currentNode.nodeValue)) els.add(walker.currentNode.parentElement);
        els.forEach((e) => { e.style.filter = 'blur(5px)'; });
        return els.size;
      });
    }
    async function shoot(page, rel, { theme, root, scope, minPhotos = 0, blur = false }) {
      const actual = await page.$eval(root, (el) => el.dataset.theme);
      if (actual !== theme) throw new Error(`${rel}: tema ${actual} en lugar de ${theme}`);
      const text = await page.$eval(root, (el) => el.innerText);
      if (/\[object \w+\]|\bundefined\b|\bNaN\b/.test(text)) throw new Error(`${rel}: texto inválido`);
      if (await page.$(`${scope} .state.error, ${scope} .spinner`)) throw new Error(`${rel}: error o carga visible`);
      const photos = await visibleImagesLoaded(page, scope);
      if (photos < minPhotos) throw new Error(`${rel}: solo ${photos} fotos de producto visibles (mínimo ${minPhotos})`);
      const redacted = blur ? await redact(page) : 0;
      await new Promise((r) => setTimeout(r, 250));
      const file = path.join(EV, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file });
      if (page.problems.length) throw new Error(`${rel}:\n${page.problems.join('\n')}`);
      shots.push({ rel, theme, photos, redacted });
      log(`${rel}  fotos=${photos}${redacted ? `  difuminados=${redacted}` : ''}`);
    }
    const go = async (page, url, ready, scope) => {
      await page.evaluate((u) => { window.history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate')); }, url);
      await page.waitForFunction((u) => location.pathname + location.search === u, { timeout: 10000 }, url);
      await page.waitForSelector(ready, { timeout: 20000 });
      await page.waitForFunction((s) => !document.querySelector(`${s} .spinner`), { timeout: 20000 }, scope);
      await new Promise((r) => setTimeout(r, 400));
    };
    async function login(page, user, landing) {
      await page.goto(`${BASE}/acceso`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('input[name=email]:not([disabled])');
      await page.type('input[name=email]', user.email);
      await page.type('input[name=password]', user.password);
      await page.keyboard.press('Enter');
      await page.waitForFunction(landing, { timeout: 20000 });
    }

    // ------------------------------------------------------- acceso y registro
    for (const [theme, name] of THEMES) {
      for (const [dev, size] of [['pc', DESKTOP], ['movil', MOBILE]]) {
        const page = await newPage(size, 'pp.theme', theme);
        await page.goto(`${BASE}/acceso`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('.access input[name=email]');
        await shoot(page, `login/login-${dev}-${name}.png`, { theme, root: '.access', scope: '.access' });
        await page.goto(`${BASE}/registro`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('.access-register .access-card');
        await shoot(page, `registro/registro-${dev}-${name}.png`, { theme, root: '.access', scope: '.access' });
        await page.browserContext().close();
      }
    }

    // ------------------------------------------------------------- tienda virtual
    const storeReady = () => location.pathname === '/' && document.querySelector('.pp-store');
    for (const [theme, name] of THEMES) {
      // PC
      let page = await newPage(DESKTOP, 'pharma_plus_store_theme', theme);
      await login(page, cust, storeReady);
      await page.waitForFunction(() => document.querySelectorAll('.product-card').length >= 5, { timeout: 20000 });
      const sopt = { theme, root: '.pp-store', scope: '#main' };
      await shoot(page, `tienda/store-desktop-1440-${name}.png`, { ...sopt, minPhotos: 3 });
      await go(page, '/catalogo', '#main .product-card', '#main');
      await shoot(page, `tienda/vistas/catalogo-desktop-${name}.png`, { ...sopt, minPhotos: 5 });
      await go(page, `/producto/${DETAIL_PRODUCT}`, '#main .product-detail', '#main');
      await shoot(page, `tienda/vistas/producto-desktop-${name}.png`, { ...sopt, minPhotos: 1 });
      await go(page, '/carrito', '#main h1', '#main');
      await shoot(page, `tienda/vistas/carrito-desktop-${name}.png`, sopt); // el carrito no muestra miniaturas por diseño
      await go(page, '/checkout', '#main h1', '#main');
      await shoot(page, `tienda/vistas/checkout-desktop-${name}.png`, sopt);
      await go(page, '/cuenta', '#main h1', '#main');
      await shoot(page, `tienda/vistas/cuenta-desktop-${name}.png`, sopt);
      // Menú de categorías abierto sobre el catálogo (al final: queda desplegado).
      await go(page, '/catalogo', '#main .product-card', '#main');
      await page.click('.st-cat-btn');
      await page.waitForSelector('.st-menu-cats a');
      await shoot(page, `tienda/store-desktop-categorias-${name}.png`, { ...sopt, scope: '.pp-store', minPhotos: 3 });
      await page.browserContext().close();
      // Móvil
      page = await newPage(MOBILE, 'pharma_plus_store_theme', theme);
      await login(page, cust, storeReady);
      await page.waitForFunction(() => document.querySelectorAll('.product-card').length >= 2, { timeout: 20000 });
      await shoot(page, `tienda/store-mobile-${name}.png`, sopt);
      await go(page, '/catalogo', '#main .product-card', '#main');
      await shoot(page, `tienda/vistas/catalogo-mobile-${name}.png`, { ...sopt, minPhotos: 2 });
      await go(page, `/producto/${DETAIL_PRODUCT}`, '#main .product-detail', '#main');
      await shoot(page, `tienda/vistas/producto-mobile-${name}.png`, { ...sopt, minPhotos: 1 });
      await page.browserContext().close();
    }

    // -------------------------------------------------------- panel administrativo
    const adminReady = () => document.querySelector('.pp-admin .content');
    const MODULES = [
      ['dashboard', '.content .lc svg'], ['products', '.content table tbody tr'], ['stock', '.content table tbody tr'],
      ['batches', '.content table tbody tr'], ['sales', '.content table tbody tr'], ['orders', '.content table tbody tr'],
      ['suppliers', '.content table tbody tr'], ['users', '.content table tbody tr'], ['roles', '.content h1'],
      ['reports', '.content h1'], ['cash', '.content h1'],
    ];
    const aopt = (theme) => ({ theme, root: '.pp-admin', scope: '.content', blur: true });
    for (const [theme, name] of THEMES) {
      const page = await newPage(DESKTOP, 'pharma_plus_admin_theme', theme);
      await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('input[name=email]:not([disabled])');
      await page.type('input[name=email]', admin.email);
      await page.type('input[name=password]', admin.password);
      await page.keyboard.press('Enter');
      await page.waitForFunction(adminReady, { timeout: 20000 });
      for (const [route, ready] of MODULES) {
        await go(page, `/admin/${route}`, ready, '.content');
        if (route === 'orders') {
          // Pestaña con más pedidos reales (por defecto se abre "Pendientes").
          await page.evaluate(() => [...document.querySelectorAll('.content [role=tab], .content .tabs button')].find((b) => /Listos para recojo/.test(b.innerText)).click());
          await page.waitForFunction(() => document.querySelectorAll('.content table tbody tr').length >= 3, { timeout: 20000 });
          await new Promise((r) => setTimeout(r, 400));
        }
        if (route === 'sales') {
          // Filtro "Desde" a 30 días con el propio campo de fecha (por defecto la vista abre los últimos 7 días).
          const from = new Date(Date.now() - 5 * 3600 * 1000 - 29 * 86400000).toISOString().slice(0, 10);
          await page.evaluate((v) => {
            const input = document.querySelector('.content input[type=date]');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }, from);
          await page.waitForFunction(() => document.querySelectorAll('.content table tbody tr').length >= 10, { timeout: 20000 });
          await new Promise((r) => setTimeout(r, 400));
        }
        await shoot(page, `admin/modulos/${route}-${name}.png`, { ...aopt(theme), minPhotos: route === 'products' ? 6 : 0 });
      }
      await page.browserContext().close();
      const m = await newPage(MOBILE, 'pharma_plus_admin_theme', theme);
      await m.goto(`${BASE}/admin/dashboard`, { waitUntil: 'networkidle0' });
      await m.waitForSelector('input[name=email]:not([disabled])');
      await m.type('input[name=email]', admin.email);
      await m.type('input[name=password]', admin.password);
      await m.keyboard.press('Enter');
      await m.waitForFunction(adminReady, { timeout: 20000 });
      await go(m, '/admin/dashboard', '.content .lc svg', '.content');
      await shoot(m, `admin/admin-mobile-${name}.png`, aopt(theme));
      await go(m, '/admin/products', '.content h1', '.content');
      await shoot(m, `admin/admin-mobile-productos-${name}.png`, { ...aopt(theme), minPhotos: 2 });
      await m.browserContext().close();
    }

    // POS: caja abierta (dentro de la transacción) y productos seleccionados SIN confirmar la venta.
    const reg = (await api.get('/api/cash/registers')).body.data.find((r) => r.isActive !== false);
    const open = await api.post('/api/cash/sessions', { cashRegisterId: reg.id, openingAmount: '150.00' });
    if (open.status !== 201) throw new Error(`apertura de caja: ${JSON.stringify(open.body)}`);
    for (const [theme, name] of THEMES) {
      const page = await newPage(DESKTOP, 'pharma_plus_admin_theme', theme);
      await page.goto(`${BASE}/admin/pos`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('input[name=email]:not([disabled])');
      await page.type('input[name=email]', admin.email);
      await page.type('input[name=password]', admin.password);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.content .pos .pos-product', { timeout: 20000 });
      for (const label of POS_PRODUCTS) {
        await page.evaluate((l) => [...document.querySelectorAll('.pos-product')].find((b) => b.getAttribute('aria-label').startsWith(l)).click(), label);
        await new Promise((r) => setTimeout(r, 500));
      }
      await page.waitForFunction(() => !document.querySelector('.content .spinner'), { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 600));
      await shoot(page, `admin/modulos/pos-${name}.png`, aopt(theme));
      await page.browserContext().close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) { await closeRealtime().catch(() => {}); await new Promise((r) => server.close(r)); }
    await tx.rollbackAll();
  }

  const after = await fingerprint();
  const changed = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
  await closePool();
  if (changed.length) throw new Error(`¡La base cambió! Tablas: ${changed.join(', ')}`);
  const claro = shots.filter((s) => s.theme === 'light').length;
  log(`OK: ${shots.length} capturas (${claro} claro, ${shots.length - claro} oscuro). Base sin cambios (${Object.keys(after).length} tablas, CHECKSUM idéntico).`);
}

main().catch(async (err) => {
  console.error('[capturas] ERROR:', err.message);
  if (before) {
    const after = await fingerprint().catch(() => null);
    const same = after && Object.keys({ ...before, ...after }).every((t) => before[t] === after[t]);
    console.error(`[capturas] base tras el error: ${same ? 'sin cambios (CHECKSUM idéntico)' : 'NO VERIFICADA O CAMBIADA'}`);
  }
  await closePool().catch(() => {});
  process.exit(1);
});
