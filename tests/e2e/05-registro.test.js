'use strict';

/**
 * Registro de clientes (/registro) — Bocetos/recortes-registro — en PC y móvil, tema claro y oscuro.
 * Capturas en evidencias/registro/ y comprobación del comportamiento real (sin cambios respecto al registro anterior):
 * obligatorios, contraseñas distintas, validaciones del servidor (DNI, tipo sin número), correo duplicado, CSRF,
 * creación exclusiva de clientes, redirección, enlace al acceso único y tema compartido con /acceso (pp.theme).
 * Solo corre sobre la base TEMPORAL (npm run test:e2e).
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const enabled = process.env.PP_E2E === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(__dirname, '..', '..', 'evidencias', 'registro');
const PASSWORD = 'Cliente2026Seguro';

test('registro de clientes: diseño y comportamiento', { skip: !enabled && 'Requiere PP_E2E=1 y una base temporal (npm run test:e2e)', timeout: 300000 }, async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip(`No se encontró Chrome en ${CHROME}`); return; }
  const puppeteer = require('puppeteer-core');
  const { withTransaction, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const { initRealtime, closeRealtime } = require('../../src/services/realtime.service');
  const { uid } = require('../helpers/http');
  fs.mkdirSync(OUT, { recursive: true });

  const app = createApp();
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

  async function regPage(width, height, theme, route = '/registro') {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    page.problems = [];
    page.on('pageerror', (e) => page.problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 500) page.problems.push(`HTTP ${r.status()} ${r.url()}`); });
    if (theme) await page.evaluateOnNewDocument((th) => { try { if (!localStorage.getItem('pp.theme')) localStorage.setItem('pp.theme', th); } catch { /* */ } }, theme);
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.access-card .access-form');
    await new Promise((r) => setTimeout(r, 250));
    return page;
  }
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const msg = (page, name) => page.$eval(`input[name=${name}]`, (el) => document.getElementById(el.getAttribute('aria-describedby')).innerText.trim());
  const fill = async (page, data) => {
    for (const [k, v] of Object.entries(data)) {
      // Borrado como un usuario (eventos reales): Ctrl+A y Retroceso.
      await page.click(`input[name=${k}]`);
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      if (v) await page.type(`input[name=${k}]`, v);
    }
  };
  /** Espera un texto dentro de la tarjeta; si no aparece, el error incluye lo que se ve (diagnóstico). */
  const waitText = async (page, re) => {
    try {
      await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.access-card').innerText), { timeout: 10000 }, re.source);
    } catch (err) {
      throw new Error(`No apareció ${re}: ${(await page.$eval('.access-card', (el) => el.innerText)).replace(/\s+/g, ' ')}`);
    }
  };
  const roleOf = (email) => withTransaction({ requestId: 'e2e-reg-check' }, async (conn) => {
    const [[row]] = await conn.execute('SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?', [email]);
    return row ? row.code : null;
  });

  // ------------------------------------------------------------- capturas
  // /acceso y /registro comparten AccessLayout: fondo, ilustración, logo, tema y bienvenida idénticos; solo cambia la tarjeta.
  const ACCESS_OUT = path.join(__dirname, '..', '..', 'evidencias', 'access');
  fs.mkdirSync(ACCESS_OUT, { recursive: true });
  const shell = (page) => page.evaluate(() => ({
    art: document.querySelector('.access-art').outerHTML,
    hero: document.querySelector('.access-hero').outerHTML,
    bg: getComputedStyle(document.querySelector('.access')).backgroundImage,
    card: (() => { const s = getComputedStyle(document.querySelector('.access-card')); return [s.backgroundColor, s.borderRadius, s.boxShadow, s.borderTopColor].join('|'); })(),
    field: (() => { const s = getComputedStyle(document.querySelector('.access-field')); return [s.backgroundColor, s.borderRadius, s.borderTopColor].join('|'); })(),
    submit: (() => { const s = getComputedStyle(document.querySelector('.access-submit')); return [s.backgroundImage, s.borderRadius, s.color].join('|'); })(),
  }));
  for (const [device, w, h] of [['pc', 1440, 900], ['movil', 390, 844]]) {
    for (const [theme, name] of [['light', 'claro'], ['dark', 'oscuro']]) {
      await t.test(`acceso y registro ${device} ${name}: misma pantalla, distinto formulario`, async () => {
        const login = await regPage(w, h, theme, '/acceso');
        await login.screenshot({ path: path.join(ACCESS_OUT, `login-${device}-${name}.png`), fullPage: device === 'movil' });
        const loginShell = await shell(login);
        await login.browserContext().close();

        const page = await regPage(w, h, theme);
        assert.equal(await page.$eval('.access', (el) => el.dataset.theme), theme);
        assert.match(await page.$eval('.access-logo', (el) => el.getAttribute('src')), theme === 'dark' ? /logo-oscuro/ : /logo-claro/);
        assert.deepEqual(await shell(page), loginShell, 'fondo, panel izquierdo, tarjeta, campos y botón iguales al login');
        assert.equal(await page.$$eval('img[src*="register-art"], img[src*="register-corner"]', (els) => els.length), 0);
        const text = await page.$eval('.access-card', (el) => el.innerText);
        assert.match(text, /Crear cuenta/);
        assert.match(text, /Registra tus datos para comenzar a comprar en Pharma Plus\./);
        assert.match(text, /Mínimo 10 caracteres, con mayúscula, minúscula y número; sin espacios y sin incluir tu correo\./);
        assert.match(text, /¿Ya tienes una cuenta\? Iniciar sesión/);
        assert.deepEqual(await page.$$eval('.access-radio span', (els) => els.map((e) => e.innerText)), ['DNI', 'Carné de extranjería', 'Pasaporte']);
        assert.deepEqual(await page.$$eval('.access-form input:not([type=radio])', (els) => els.map((e) => e.name)), ['fullName', 'email', 'phone', 'documentNumber', 'password', 'confirm']);
        assert.equal(await page.$$eval('select[name*=role], input[name*=role]', (els) => els.length), 0, 'sin selección de rol');
        if (device === 'movil') {
          // Orden móvil: logo → tema → título → subtítulo → formulario.
          const ys = await page.evaluate(() => ['.access-logo', '.access-theme', '.access-card h2', '.access-sub', '.access-form'].map((s) => document.querySelector(s).getBoundingClientRect().top));
          assert.deepEqual([...ys].sort((x, y) => x - y), ys, `orden móvil: ${ys}`);
        }
        assert.ok(await overflow(page) <= 1, `desborde en ${device} ${name}`);
        await page.screenshot({ path: path.join(ACCESS_OUT, `registro-${device}-${name}.png`), fullPage: device === 'movil' });
        await page.screenshot({ path: path.join(OUT, `registro-${device}-${name}.png`), fullPage: device === 'movil' });
        assert.deepEqual(page.problems, [], page.problems.join('\n'));
        await page.browserContext().close();
      });
    }
  }

  await t.test('otras resoluciones sin desborde (360, 430, tableta, 1366, 1920)', async () => {
    for (const [w, h, tag] of [[360, 800, 'movil-360'], [430, 932, 'movil-430'], [820, 1180, 'tableta'], [1366, 768, 'pc-1366'], [1920, 1080, 'pc-1920']]) {
      const page = await regPage(w, h, 'light');
      assert.ok(await overflow(page) <= 1, `desborde en ${tag}`);
      const btn = await page.$eval('.access-submit', (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      assert.ok(btn.w > 200 && btn.h >= 40, `botón utilizable en ${tag}`);
      await page.screenshot({ path: path.join(OUT, `registro-${tag}.png`), fullPage: true });
      await page.browserContext().close();
    }
  });

  // --------------------------------------------------------- comportamiento
  await t.test('validaciones: obligatorios, contraseñas distintas, DNI, tipo sin número y CSRF', async () => {
    const page = await regPage(1440, 900, 'light');
    let posts = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/store/auth/register')) posts += 1; });
    await page.click('.access-submit');
    assert.equal(await msg(page, 'fullName'), 'Campo obligatorio');
    assert.equal(await msg(page, 'email'), 'Campo obligatorio');
    assert.equal(await msg(page, 'password'), 'Campo obligatorio');
    assert.equal(posts, 0, 'sin obligatorios no se envía nada');

    const email = `e2e.reg.${uid().toLowerCase()}@pharmaplus.test`;
    await fill(page, { fullName: 'Cliente Registro Prueba', email, password: PASSWORD, confirm: 'Otra2026Clave' });
    await page.click('.access-submit');
    assert.equal(await msg(page, 'confirm'), 'Las contraseñas no coinciden');
    assert.equal(posts, 0, 'contraseñas distintas no se envían');

    // Validaciones del servidor (las reglas reales no cambiaron).
    await fill(page, { confirm: PASSWORD, documentNumber: '123' });
    await page.click('.access-radio input[value="DNI"]');
    await page.click('.access-submit');
    await waitText(page, /El DNI debe tener 8 dígitos/);
    assert.equal(await msg(page, 'documentNumber'), 'El DNI debe tener 8 dígitos');
    await page.click('.access-radio input[value="DNI"]'); // segundo clic: sin tipo de documento
    assert.equal(await page.$eval('.access-radio input[value="DNI"]', (el) => el.checked), false);
    await page.click('.access-radio input[value="PASSPORT"]');
    await fill(page, { documentNumber: '' });
    await page.click('.access-submit');
    await waitText(page, /Indique tipo y número de documento, o ninguno/);
    await page.screenshot({ path: path.join(OUT, 'registro-pc-validacion.png') });

    // Contraseña que no cumple la política y teléfono inválido: los rechaza el servidor y se muestran en su campo.
    await page.click('.access-radio input[value="PASSPORT"]'); // deseleccionar: sin documento
    await fill(page, { phone: 'abc', password: 'sinmayuscula1', confirm: 'sinmayuscula1' });
    await page.click('.access-submit');
    await waitText(page, /Debe incluir al menos una letra mayúscula/);
    assert.equal(await msg(page, 'password'), 'Debe incluir al menos una letra mayúscula');
    assert.equal(await msg(page, 'phone'), 'Teléfono inválido');
    assert.ok(await page.$eval('.access-radio input[value="PASSPORT"]', (el) => !el.checked));
    assert.equal(await roleOf(email), null, 'con errores no se crea la cuenta');

    // Sin token CSRF el servidor rechaza el registro.
    const csrf = await page.evaluate(async (em) => {
      const r = await fetch('/api/store/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Sin Csrf', email: `x${em}`, password: 'Cliente2026Seguro' }) });
      return { status: r.status, body: await r.json() };
    }, email);
    assert.equal(csrf.status, 403);
    assert.equal(csrf.body.error.code, 'CSRF_INVALID');
    await page.browserContext().close();
  });

  await t.test('registro correcto (con teléfono y DNI): crea un cliente, inicia sesión y vuelve a la ruta pedida', async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`${BASE}/registro?next=%2Fcarrito`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.access-card');
    const email = `e2e.reg.ok.${uid().toLowerCase()}@pharmaplus.test`;
    const dni = String(Date.now()).slice(-8);
    await fill(page, { fullName: 'Cliente Movil Prueba', email, phone: '987654321', documentNumber: dni, password: PASSWORD, confirm: PASSWORD });
    await page.click('.access-radio input[value="DNI"]');
    await page.click('input[name=password] ~ .access-eye');
    assert.equal(await page.$eval('input[name=password]', (el) => el.type), 'text');
    await page.click('.access-submit');
    await page.waitForFunction(() => location.pathname === '/carrito', { timeout: 15000 });
    await page.waitForFunction(() => /Carrito/.test(document.querySelector('#main h1')?.innerText || ''), { timeout: 15000 });
    assert.equal(await roleOf(email), 'CUSTOMER', 'el servidor asigna el rol de cliente');
    const me = await page.evaluate(() => fetch('/api/auth/me').then((r) => r.json()));
    assert.equal(me.user.email, email);
    const profile = await page.evaluate(() => fetch('/api/store/me').then((r) => r.json()));
    assert.equal(profile.data.phone, '987654321');
    assert.equal(profile.data.documentType, 'DNI');
    assert.equal(profile.data.documentNumber, dni);
    // Con sesión de cliente, /registro lleva a la tienda.
    await page.goto(`${BASE}/registro`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => location.pathname === '/', { timeout: 15000 });
    await ctx.close();

    // Correo duplicado: el error del servidor se muestra y no se crea otra cuenta.
    const p2 = await regPage(1440, 900, 'dark');
    await fill(p2, { fullName: 'Otro Cliente', email, password: PASSWORD, confirm: PASSWORD });
    await p2.click('.access-submit');
    await p2.waitForFunction(() => document.querySelector('.access-alert, .access-group.has-error'), { timeout: 10000 });
    assert.equal(new URL(p2.url()).pathname, '/registro');
    await p2.browserContext().close();
  });

  await t.test('enlace al acceso único y tema compartido con /acceso', async () => {
    const page = await regPage(1440, 900, 'light');
    await page.click('.access-theme button[aria-label="Tema oscuro"]');
    await page.waitForSelector('.access-register[data-theme="dark"]');
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.access-register[data-theme="dark"]');
    await page.click('.access-foot a');
    await page.waitForFunction(() => location.pathname === '/acceso', { timeout: 10000 });
    await page.waitForSelector('.access[data-theme="dark"]');
    const keys = await page.evaluate(() => [localStorage.getItem('pp.theme'), localStorage.getItem('pharma_plus_admin_theme'), localStorage.getItem('pharma_plus_store_theme')]);
    assert.deepEqual(keys, ['dark', null, null]);
    await page.browserContext().close();
  });
});
