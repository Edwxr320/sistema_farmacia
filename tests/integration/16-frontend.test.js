'use strict';

/**
 * Frontend React + Vite:
 *  - Express sirve frontend/dist: index.html para las rutas de React (tienda y /admin), assets con hash,
 *    sin interceptar /api ni archivos inexistentes; cabeceras de seguridad (CSP sin scripts inline).
 *  - Integridad: cada endpoint literal que usa el frontend existe en la API (no "Ruta no encontrada").
 *    Las llamadas se hacen como ADMIN dentro de la transacción de prueba (rollback) con ids inexistentes
 *    y cuerpos inválidos, de modo que no se modifica ningún dato.
 *  - La tienda solo usa /api/store, /api/settings/public y /api/auth (sesión); nunca APIs administrativas.
 *  - Cada ruta del panel apunta a una vista existente que exporta su componente y está en el menú.
 * Requiere el build (npm test ejecuta antes "npm run build").
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const request = require('supertest');
const { closePool } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const { startTransactionalDb } = require('../helpers/transactional-db');
const { createTestUser } = require('../helpers/fixtures');
const { loginClient } = require('../helpers/http');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const SRC = path.join(FRONTEND, 'src');
const DIST = path.join(FRONTEND, 'dist');
const PASSWORD = 'Farmacia2026Segura';
let tx;
let app;
let admin;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : (/\.(js|jsx)$/.test(e.name) ? [p] : []);
  });
}

/** [{ file, method, path }] de las llamadas api.get('/x') / ctx.api.post(`/x/${id}`) del frontend. */
function apiCalls(dir) {
  const re = /api\.(get|post|put|patch|del|upload)\(\s*(['`])([^'`]+)\2/g;
  const out = [];
  for (const file of jsFiles(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const method = { del: 'delete', upload: 'put' }[m[1]] || m[1];
      if (!m[3].startsWith('/')) continue; // rutas armadas dinámicamente (p. ej. cfg.endpoint)
      out.push({ file: path.relative(SRC, file).replace(/\\/g, '/'), method, path: m[3].replace(/\$\{[^}]+\}/g, '999999999') });
    }
  }
  return out;
}

test.before(async () => {
  tx = await startTransactionalDb();
  app = createApp();
  admin = await loginClient(app, await createTestUser(tx.conn, { roleCode: 'ADMIN', password: PASSWORD }));
});

test.after(async () => {
  await tx.rollbackAll();
  await closePool();
});

test('Express sirve el build de React con fallback de rutas', async () => {
  assert.ok(fs.existsSync(path.join(DIST, 'index.html')), 'falta frontend/dist (ejecute npm run build)');
  const store = await request(app).get('/');
  assert.equal(store.status, 200);
  assert.match(store.headers['content-type'], /html/);
  assert.match(store.text, /<div id="root"/);
  const assets = [...store.text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.some((a) => a.endsWith('.js')) && assets.some((a) => a.endsWith('.css')), 'index.html enlaza JS y CSS compilados');
  for (const a of assets) {
    const r = await request(app).get(a);
    assert.equal(r.status, 200, a);
  }

  // Rutas directas de React (recarga del navegador) → index.html
  for (const route of ['/admin', '/admin/', '/admin/pos', '/admin/sales?id=1', '/acceso', '/acceso?next=%2Fadmin', '/catalogo', '/producto/1', '/carrito', '/pedidos/5', '/ingresar']) {
    const r = await request(app).get(route);
    assert.equal(r.status, 200, route);
    assert.match(r.text, /<div id="root"/, route);
    assert.equal(r.headers['cache-control'], 'no-cache', route);
  }

  // El fallback no intercepta la API, las imágenes subidas ni archivos inexistentes.
  const api404 = await request(app).get('/api/no-existe');
  assert.equal(api404.status, 404);
  assert.match(api404.headers['content-type'], /json/);
  assert.equal((await request(app).get('/assets/no-existe.js')).status, 404);
  assert.equal((await request(app).get('/uploads/no-existe.png')).status, 404);
  assert.equal((await request(app).post('/catalogo')).status, 404);
  assert.equal((await request(app).get('/img/Logo-pharma-plus.jpeg')).status, 200);

  const csp = store.headers['content-security-policy'] || '';
  const scriptSrc = (csp.split(';').find((d) => d.trim().startsWith('script-src')) || '').trim();
  assert.match(scriptSrc, /'self'/);
  assert.doesNotMatch(scriptSrc, /unsafe-inline/, 'no se permiten scripts inline');
});

test('HTML sin scripts inline ni manejadores on*= (compatible con la CSP)', () => {
  for (const f of [path.join(FRONTEND, 'index.html'), path.join(DIST, 'index.html')]) {
    const html = fs.readFileSync(f, 'utf8');
    for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || []) {
      assert.match(tag, /\ssrc=/, `${f}: script inline no permitido`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f}: manejador inline no permitido`);
  }
});

test('el frontend no inserta HTML de datos (sin innerHTML ni dangerouslySetInnerHTML)', () => {
  for (const file of jsFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|dangerouslySetInnerHTML/, path.relative(SRC, file));
  }
});

test('cada endpoint usado por el frontend existe en la API', async () => {
  const calls = apiCalls(SRC)
    // Llamadas de sesión con efectos (se prueban en 03-auth) y el refresco de alertas (usa un procedimiento con bloqueo propio).
    .filter((c) => !c.path.startsWith('/auth/') && !c.path.endsWith('/refresh-expiry'));
  // Endpoints que el mantenimiento genérico arma con cfg.endpoint.
  for (const p of ['/categories', '/laboratories', '/suppliers', '/customers']) calls.push({ file: 'admin/views/catalogs.jsx', method: 'get', path: p });
  assert.ok(calls.length > 80, `se esperaban muchas llamadas, hay ${calls.length}`);

  const missing = [];
  const seen = new Set();
  for (const c of calls) {
    const key = `${c.method} ${c.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const url = `/api${c.path}`;
    const r = c.method === 'get' ? await admin.get(url) : await admin[c.method === 'delete' ? 'del' : c.method](url, { __probe: true });
    const msg = r.body?.error?.message || '';
    if (r.status === 404 && /^Ruta no encontrada/.test(msg)) missing.push(`${key} (${c.file})`);
    assert.notEqual(r.status, 500, `${key} respondió 500: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(missing, [], `Endpoints inexistentes:\n${missing.join('\n')}`);
});

test('la tienda solo usa la API pública de la tienda', () => {
  const calls = apiCalls(path.join(SRC, 'store'));
  assert.ok(calls.length > 10);
  for (const c of calls) {
    assert.ok(/^\/(store\/|settings\/public$)/.test(c.path), `${c.file}: ${c.method.toUpperCase()} ${c.path} no es una API de la tienda`);
  }
});

test('el enrutador del panel apunta a vistas existentes', async () => {
  const { ROUTES } = await import(pathToFileURL(path.join(SRC, 'admin', 'routes.js')).href);
  const { NAV } = await import(pathToFileURL(path.join(SRC, 'admin', 'nav.js')).href);
  const entries = Object.entries(ROUTES);
  assert.ok(entries.length >= 20);
  const navRoutes = new Set(NAV.flatMap((g) => g.items.map((i) => i.route)));
  for (const [routeName, [mod, component]] of entries) {
    const file = path.join(SRC, 'admin', 'views', `${mod}.jsx`);
    assert.ok(fs.existsSync(file), `falta la vista ${mod}.jsx`);
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, new RegExp(`export (function|const) ${component}\\b`), `${mod}.jsx no exporta ${component}`);
    assert.ok(navRoutes.has(routeName), `la ruta ${routeName} no está en el menú`);
  }
  for (const r of navRoutes) assert.ok(ROUTES[r], `el menú enlaza ${r} pero no hay vista`);
});
