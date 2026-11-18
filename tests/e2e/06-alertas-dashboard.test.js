'use strict';

/**
 * Alertas reales de inventario en la INTERFAZ del panel: se crean con el generador (scripts/lib/inventory-alerts.js,
 * servicios de ajustes y entradas) sobre la base TEMPORAL de npm run test:e2e y se comprueba que el Dashboard las
 * muestra (KPI «Stock bajo» y lista de alertas). Captura en evidencias/alertas/.
 */

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const enabled = process.env.PP_E2E === '1' && process.env.DB_NAME && process.env.DB_NAME !== 'pharma_plus';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(__dirname, '..', '..', 'evidencias', 'alertas');
const PASSWORD = 'Farmacia2026Segura';

test('alertas reales de inventario visibles en el Dashboard', { skip: !enabled && 'Requiere PP_E2E=1 y una base temporal (npm run test:e2e)', timeout: 300000 }, async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip(`No se encontró Chrome en ${CHROME}`); return; }
  const puppeteer = require('puppeteer-core');
  const { withTransaction, closePool } = require('../../src/config/database');
  const { createApp } = require('../../src/app');
  const authService = require('../../src/services/auth.service');
  const { initRealtime, closeRealtime } = require('../../src/services/realtime.service');
  const { createTestUser } = require('../helpers/fixtures');
  const { loginClient, validRuc, limaDate, uid } = require('../helpers/http');
  const alerts = require('../../scripts/lib/inventory-alerts');
  fs.mkdirSync(OUT, { recursive: true });

  const app = createApp();
  const adminUser = await withTransaction({ requestId: 'e2e-alerts' }, (conn) => createTestUser(conn, { roleCode: 'ADMIN', password: PASSWORD }));
  const api = await loginClient(app, adminUser);
  const categoryId = (await api.post('/api/categories', { name: `E2E Cat ${uid()}` })).body.data.id;
  const supplierId = (await api.post('/api/suppliers', { businessName: `Proveedor Demo E2E ${uid()}`, ruc: validRuc() })).body.data.id;
  for (let i = 1; i <= 6; i += 1) {
    const p = await api.post('/api/products', { sku: `E2E-AL-${uid()}`, name: `Producto demo ${i}`, barcode: `99900000000${String(i).padStart(2, '0')}`, categoryId, salePrice: '5.00', minimumStock: 10 });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const e = await api.post('/api/inventory/entries', { branchId: 1, supplierId, confirm: true, items: [{ productId: p.body.data.id, batchNumber: `E2E-${uid()}`, expiryDate: limaDate(300), quantity: 40 + i, unitCost: '2.00' }] });
    assert.equal(e.status, 201, JSON.stringify(e.body));
  }

  const login = await authService.login({ email: adminUser.email, password: PASSWORD }, { ip: '127.0.0.1', requestId: 'e2e-alerts-login' }, { portal: 'staff' });
  const auth = { userId: login.user.id, branchId: login.activeBranchId, jti: login.session.jti, user: login.user, branches: login.branches, permissions: new Set(login.permissions) };
  const result = await alerts.execute({ runId: `e2e-alerts-${uid().toLowerCase()}`, auth, branchId: 1 });
  assert.deepEqual(result.verification.issues, [], result.verification.issues.join('\n'));

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

  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => location.pathname === '/acceso' && document.querySelector('input[name=email]:not([disabled])'), { timeout: 15000 });
  await page.type('input[name=email]', adminUser.email);
  await page.type('input[name=password]', PASSWORD);
  await page.click('form button[type=submit]');
  await page.waitForSelector('.pp-admin .content', { timeout: 15000 });
  await page.waitForFunction(() => /Stock bajo/.test(document.querySelector('.kpis')?.innerText || ''), { timeout: 15000 });
  const dashText = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  try {
    await page.waitForFunction(() => /DEMO-ALERT-/.test(document.body.innerText) && /Alertas abiertas/.test(document.body.innerText), { timeout: 15000 });
  } catch (err) {
    throw new Error(`Alertas no visibles: ${(await dashText()).slice(0, 1500)}`);
  }
  const kpi = await page.evaluate(() => [...document.querySelectorAll('.kpis > *')].find((el) => /Stock bajo/.test(el.innerText))?.innerText.replace(/\s+/g, ' ') || '');
  assert.ok(Number((kpi.match(/Stock bajo (\d+)/) || [])[1]) >= 3, `KPI Stock bajo: ${kpi}`);
  const text = await dashText();
  assert.match(text, /Lote DEMO-ALERT-[A-Z0-9-]+ vence el/);
  assert.match(text, /Stock disponible \(5\) igual o menor al mínimo \(10\)/);
  assert.ok(Number((text.match(/Lotes por vencer \(30 días\) (\d+)/) || [])[1]) >= 2, text);
  const open = text.match(/Alertas abiertas (\d+) \((\d+) agotados/);
  assert.ok(open && Number(open[1]) >= 5 && Number(open[2]) >= 1, text);
  await page.screenshot({ path: path.join(OUT, 'dashboard-alertas-pc.png') });

  // Módulo de alertas: el producto agotado también aparece en la lista completa.
  await page.goto(`${BASE}/admin/alerts`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /Producto agotado en la sucursal/.test(document.body.innerText), { timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, 'alertas-modulo-pc.png') });
});
