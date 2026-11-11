'use strict';

/**
 * Capturas del acceso único (/acceso) — Bocetos/recortes-login — en PC y móvil, tema claro y oscuro.
 * Comprueba también: logo según el tema, persistencia del tema, sin desborde horizontal (360 px, 390 px, tableta, PC),
 * sin opciones inexistentes (Google, Apple, Recordarme, ¿Olvidaste…?) y que el ingreso sigue funcionando.
 * Solo corre sobre la base TEMPORAL (npm run test:e2e). Guarda las imágenes en evidencias/login/.
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const enabled = process.env.PP_E2E === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(__dirname, '..', '..', 'evidencias', 'login');
const PASSWORD = 'Farmacia2026Segura';

test('capturas del acceso único: PC y móvil, claro y oscuro', { skip: !enabled && 'Requiere PP_E2E=1 y una base temporal (npm run test:e2e)', timeout: 240000 }, async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip(`No se encontró Chrome en ${CHROME}`); return; }
  const puppeteer = require('puppeteer-core');
  const { withTransaction, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const { initRealtime, closeRealtime } = require('../../src/services/realtime.service');
  const { createTestUser } = require('../helpers/fixtures');
  fs.mkdirSync(OUT, { recursive: true });

  const app = createApp();
  const adminUser = await withTransaction({ requestId: 'e2e-login-shots' }, (conn) => createTestUser(conn, { roleCode: 'ADMIN', password: PASSWORD }));
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

  async function accessPage(width, height, theme) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    page.problems = [];
    page.on('pageerror', (e) => page.problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.problems.push(`console: ${m.text()}`); });
    // Tema inicial solo si aún no hay preferencia guardada (permite comprobar la persistencia al recargar).
    await page.evaluateOnNewDocument((th) => { try { if (!localStorage.getItem('pp.theme')) localStorage.setItem('pp.theme', th); } catch { /* */ } }, theme);
    await page.goto(`${BASE}/acceso`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name=email]:not([disabled])', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 250));
    return page;
  }
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  for (const [device, w, h] of [['pc', 1440, 900], ['movil', 390, 844]]) {
    for (const [theme, name] of [['light', 'claro'], ['dark', 'oscuro']]) {
      await t.test(`login ${device} ${name}`, async () => {
        const page = await accessPage(w, h, theme);
        assert.equal(await page.$eval('.access', (el) => el.dataset.theme), theme);
        assert.match(await page.$eval('.access-logo', (el) => el.getAttribute('src')), theme === 'dark' ? /logo-oscuro/ : /logo-claro/);
        const text = await page.$eval('.access', (el) => el.innerText);
        assert.doesNotMatch(text, /Google|Apple|Recordarme|Olvidaste|Envíos a todo el Perú/i, 'no debe mostrar opciones inexistentes');
        if (device === 'pc') {
          assert.match(text, /Recojo en tienda y delivery/);
          assert.match(text, /Iniciar Sesión/);
        }
        assert.match(text, /Bienvenido/);
        assert.ok(await overflow(page) <= 1, `desborde horizontal en ${device} ${name}`);
        await page.screenshot({ path: path.join(OUT, `login-${device}-${name}.png`) });
        assert.deepEqual(page.problems, [], page.problems.join('\n'));
        await page.browserContext().close();
      });
    }
  }

  await t.test('otras resoluciones sin desborde (360, tableta, PC pequeña)', async () => {
    for (const [w, h, tag] of [[360, 740, 'movil-360'], [820, 1180, 'tableta'], [1280, 720, 'pc-1280']]) {
      const page = await accessPage(w, h, 'light');
      assert.ok(await overflow(page) <= 1, `desborde en ${tag}`);
      // Los campos y el botón quedan visibles y utilizables.
      const box = await page.$eval('.access-submit', (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      assert.ok(box.w > 200 && box.h >= 44, `botón Ingresar utilizable en ${tag}`);
      await page.screenshot({ path: path.join(OUT, `login-${tag}.png`), fullPage: true });
      await page.browserContext().close();
    }
  });

  await t.test('tema persistente, mostrar contraseña e ingreso del administrador', async () => {
    const page = await accessPage(1440, 900, 'light');
    await page.click('button[aria-label="Tema oscuro"]');
    await page.waitForSelector('.access[data-theme="dark"]');
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.access[data-theme="dark"]');
    assert.match(await page.$eval('.access-logo', (el) => el.getAttribute('src')), /logo-oscuro/);
    await page.type('input[name=password]', PASSWORD);
    await page.click('.access-eye');
    assert.equal(await page.$eval('input[name=password]', (el) => el.type), 'text');
    await page.click('.access-eye');
    assert.equal(await page.$eval('input[name=password]', (el) => el.type), 'password');
    await page.type('input[name=email]', adminUser.email);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.pp-admin .sidebar', { timeout: 15000 });
    assert.match(new URL(page.url()).pathname, /^\/admin/);
    // El tema del acceso es independiente del panel.
    assert.equal(await page.evaluate(() => localStorage.getItem('pharma_plus_admin_theme')), null);
    assert.deepEqual(page.problems, [], page.problems.join('\n'));
    await page.browserContext().close();
  });
});
