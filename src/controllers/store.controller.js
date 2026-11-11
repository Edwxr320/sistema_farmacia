'use strict';

const customerService = require('../services/customer.service');
const storeService = require('../services/store.service');
const orderService = require('../services/order.service');
const authController = require('./auth.controller');
const { AppError } = require('../utils/app-error');

const v = (req) => req.validated;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

const store = {
  register: async (req, res) => res.status(201).json({ data: await customerService.register(v(req).body, req.dbContext) }),
  /** Login de clientes: mismo mecanismo de sesión, pero solo admite cuentas CUSTOMER. */
  login: (req, res) => {
    req.loginPortal = 'store';
    return authController.login(req, res);
  },
  me: async (req, res) => res.json({ data: await customerService.me(req.auth, req.dbContext) }),
  updateMe: async (req, res) => res.json({ data: await customerService.updateProfile(req.auth, v(req).body, req.dbContext) }),
  addresses: async (req, res) => res.json({ data: await customerService.listAddresses(req.auth, req.dbContext) }),
  addAddress: async (req, res) => res.status(201).json({ data: await customerService.createAddress(req.auth, v(req).body, req.dbContext) }),
  updateAddress: async (req, res) => res.json({ data: await customerService.updateAddress(req.auth, v(req).params.id, v(req).body, req.dbContext) }),
  deleteAddress: async (req, res) => {
    await customerService.deleteAddress(req.auth, v(req).params.id, req.dbContext);
    res.status(204).end();
  },

  catalog: async (req, res) => res.json(await storeService.catalog(v(req).query, req.dbContext)),
  product: async (req, res) => res.json({ data: await storeService.product(v(req).params.id, v(req).query.branchId, req.dbContext) }),
  categories: async (req, res) => res.json({ data: await storeService.categories(v(req).query.branchId, req.dbContext) }),
  branches: async (req, res) => res.json({ data: await storeService.branches(req.dbContext) }),

  cart: async (req, res) => res.json({ data: await storeService.getCart(req.auth, req.dbContext) }),
  cartBranch: async (req, res) => res.json({ data: await storeService.setBranch(req.auth, v(req).body.branchId, req.dbContext) }),
  setItem: async (req, res) => res.json({ data: await storeService.setItem(req.auth, v(req).params.productId, v(req).body.quantity, req.dbContext) }),
  removeItem: async (req, res) => res.json({ data: await storeService.removeItem(req.auth, v(req).params.productId, req.dbContext) }),
  clearCart: async (req, res) => res.json({ data: await storeService.clear(req.auth, req.dbContext) }),

  checkout: async (req, res) => {
    const key = req.get('idempotency-key');
    if (key !== undefined && !IDEMPOTENCY_PATTERN.test(key)) throw AppError.badRequest('Idempotency-Key inválida');
    const ctx = key ? { ...req.dbContext, requestId: key } : req.dbContext;
    const order = await orderService.checkout(v(req).body, req.auth, ctx, { idempotencyKey: key });
    res.status(order.idempotentReplay ? 200 : 201).json({ data: order });
  },
  myOrders: async (req, res) => res.json(await orderService.myOrders(req.auth, v(req).query, req.dbContext)),
  myOrder: async (req, res) => res.json({ data: await orderService.myOrder(req.auth, v(req).params.id, req.dbContext) }),
  cancelMine: async (req, res) => res.json({ data: await orderService.cancelMine(req.auth, v(req).params.id, v(req).body.reason, req.dbContext) }),
};

const orders = {
  list: async (req, res) => res.json(await orderService.list(v(req).query, req.auth, req.dbContext)),
  get: async (req, res) => res.json({ data: await orderService.get(v(req).params.id, req.auth, req.dbContext) }),
  accept: async (req, res) => res.json({ data: await orderService.accept(v(req).params.id, v(req).body, req.auth, req.dbContext) }),
  reject: async (req, res) => res.json({ data: await orderService.reject(v(req).params.id, v(req).body.reason, req.auth, req.dbContext) }),
  prepare: async (req, res) => res.json({ data: await orderService.prepare(v(req).params.id, req.auth, req.dbContext) }),
  ready: async (req, res) => res.json({ data: await orderService.ready(v(req).params.id, req.auth, req.dbContext) }),
  complete: async (req, res) => res.json({ data: await orderService.complete(v(req).params.id, v(req).body, req.auth, req.dbContext) }),
  cancel: async (req, res) => res.json({ data: await orderService.cancelByStaff(v(req).params.id, v(req).body.reason, req.auth, req.dbContext) }),
  assign: async (req, res) => res.json({ data: await orderService.assign(v(req).params.id, v(req).body.userId, req.auth, req.dbContext) }),
};

module.exports = { store, orders };
