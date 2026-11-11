'use strict';

const request = require('supertest');

/** Cliente con cookies + CSRF que inicia sesión contra la app. */
async function loginClient(app, user) {
  const agent = request.agent(app);
  const csrfRes = await agent.get('/api/auth/csrf-token');
  const res = await agent.post('/api/auth/login').set('X-CSRF-Token', csrfRes.body.csrfToken).send({ email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login falló (${res.status}): ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken;
  const send = (method) => (url, body) => {
    const r = agent[method](url).set('X-CSRF-Token', csrf);
    return body === undefined ? r : r.send(body);
  };
  return {
    agent,
    csrf,
    get: (url) => agent.get(url),
    post: send('post'),
    put: send('put'),
    patch: send('patch'),
    del: send('delete'),
  };
}

/** RUC peruano válido (prefijo 20 + dígito verificador SUNAT) para pruebas. */
function validRuc(seed = Math.floor(Math.random() * 1e8)) {
  const base = `20${String(seed).padStart(8, '0').slice(-8)}`;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base[i]), 0);
  const r = 11 - (sum % 11);
  return base + String(r === 10 ? 0 : r === 11 ? 1 : r);
}

/** Fecha 'YYYY-MM-DD' en Lima desplazada n días. */
function limaDate(offsetDays) {
  return new Date(Date.now() - 5 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/**
 * Crea categoría, proveedor y producto, y le da stock real con una entrada contabilizada
 * (PURCHASE_ENTRY por lote). batches: [{ batchNumber, days, quantity }]
 */
async function stockedProduct(admin, { salePrice = '2.00', minimumStock = 5, requiresPrescription = false, batches, supplierId, categoryId }) {
  if (!categoryId) categoryId = (await admin.post('/api/categories', { name: `QA Cat ${uid()}` })).body.data.id;
  if (!supplierId) supplierId = (await admin.post('/api/suppliers', { businessName: `QA Prov ${uid()}`, ruc: validRuc() })).body.data.id;
  const p = await admin.post('/api/products', {
    sku: `QA-${uid()}`, name: `QA Producto ${uid()}`, categoryId, salePrice, minimumStock, requiresPrescription,
  });
  if (p.status !== 201) throw new Error(`producto: ${JSON.stringify(p.body)}`);
  const productId = p.body.data.id;
  if (batches && batches.length) {
    const e = await admin.post('/api/inventory/entries', {
      branchId: 1, supplierId, confirm: true,
      items: batches.map((b) => ({ productId, batchNumber: b.batchNumber, expiryDate: limaDate(b.days), quantity: b.quantity, unitCost: b.unitCost || '1.00' })),
    });
    if (e.status !== 201) throw new Error(`entrada: ${JSON.stringify(e.body)}`);
  }
  return { productId, categoryId, supplierId };
}

/** Registra un cliente por la API de la tienda e inicia su sesión (portal store). */
async function storeCustomer(app, overrides = {}) {
  const agent = request.agent(app);
  let csrf = (await agent.get('/api/auth/csrf-token')).body.csrfToken;
  const email = overrides.email || `qa.cliente.${uid().toLowerCase()}${uid().toLowerCase()}@pharmaplus.test`;
  const password = 'Cliente2026Seguro';
  const reg = await agent.post('/api/store/auth/register').set('X-CSRF-Token', csrf).send({ fullName: 'Cliente De Prueba', email, password, ...overrides.body });
  if (reg.status !== 201) throw new Error(`registro: ${JSON.stringify(reg.body)}`);
  const login = await agent.post('/api/store/auth/login').set('X-CSRF-Token', csrf).send({ email, password });
  if (login.status !== 200) throw new Error(`login tienda: ${JSON.stringify(login.body)}`);
  csrf = login.body.csrfToken;
  const send = (method) => (url, body) => {
    const r = agent[method](url).set('X-CSRF-Token', csrf);
    return body === undefined ? r : r.send(body);
  };
  return {
    agent, csrf, email, password, customerId: reg.body.data.customerId, userId: reg.body.data.userId,
    get: (url) => agent.get(url), post: send('post'), put: send('put'), del: send('delete'),
  };
}

module.exports = { loginClient, validRuc, limaDate, uid, stockedProduct, storeCustomer };
