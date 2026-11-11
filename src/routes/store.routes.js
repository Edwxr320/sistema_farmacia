'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/authenticate');
const { requirePermission } = require('../middlewares/authorize');
const { validate } = require('../middlewares/validate');
const { loginRateLimiter, sensitiveRateLimiter } = require('../middlewares/rate-limit');
const { idParam, z, id, optionalText, money, isoDate, pagination, searchTerm } = require('../validators/common.validator');
const { loginSchema } = require('../validators/auth.validator');
const vs = require('../validators/store.validator');
const { store, orders } = require('../controllers/store.controller');

const params = validate(idParam, 'params');
const branchQuery = validate(z.object({ branchId: id.optional() }), 'query');

// ---------------------------------------------------------- tienda virtual
// Público: catálogo. Clientes (rol CUSTOMER, permisos store.*): cuenta, carrito y pedidos.
const storeRouter = Router();
storeRouter.post('/auth/register', sensitiveRateLimiter, validate(vs.register), store.register);
storeRouter.post('/auth/login', loginRateLimiter, validate(loginSchema), store.login);
storeRouter.get('/branches', store.branches);
storeRouter.get('/categories', branchQuery, store.categories);
storeRouter.get('/products', validate(vs.catalogQuery, 'query'), store.catalog);
storeRouter.get('/products/:id', params, branchQuery, store.product);

storeRouter.get('/me', authenticate, requirePermission('store.profile'), store.me);
storeRouter.put('/me', authenticate, requirePermission('store.profile'), validate(vs.profileUpdate), store.updateMe);
storeRouter.get('/me/addresses', authenticate, requirePermission('store.profile'), store.addresses);
storeRouter.post('/me/addresses', authenticate, requirePermission('store.profile'), validate(vs.addressCreate), store.addAddress);
storeRouter.put('/me/addresses/:id', authenticate, requirePermission('store.profile'), params, validate(vs.addressUpdate), store.updateAddress);
storeRouter.delete('/me/addresses/:id', authenticate, requirePermission('store.profile'), params, store.deleteAddress);

storeRouter.get('/cart', authenticate, requirePermission('store.cart'), store.cart);
storeRouter.put('/cart', authenticate, requirePermission('store.cart'), validate(vs.cartBranch), store.cartBranch);
storeRouter.delete('/cart', authenticate, requirePermission('store.cart'), store.clearCart);
storeRouter.put('/cart/items/:productId', authenticate, requirePermission('store.cart'), validate(vs.productParam, 'params'), validate(vs.cartItem), store.setItem);
storeRouter.delete('/cart/items/:productId', authenticate, requirePermission('store.cart'), validate(vs.productParam, 'params'), store.removeItem);

storeRouter.post('/orders', authenticate, requirePermission('store.orders'), validate(vs.checkout), store.checkout);
storeRouter.get('/orders', authenticate, requirePermission('store.orders'), validate(vs.myOrdersQuery, 'query'), store.myOrders);
storeRouter.get('/orders/:id', authenticate, requirePermission('store.orders'), params, store.myOrder);
storeRouter.post('/orders/:id/cancel', authenticate, requirePermission('store.orders'), params, validate(vs.orderCancel), store.cancelMine);

// ---------------------------------------------------------- panel: pedidos
const ORDER_STATUS = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED', 'REJECTED'];
const ordersRouter = Router();
ordersRouter.use(authenticate);
ordersRouter.get('/', requirePermission('orders.view'), validate(z.object({
  branchId: id.optional(), status: z.enum(ORDER_STATUS).optional(), fulfillmentType: z.enum(['PICKUP', 'DELIVERY']).optional(),
  assignedUserId: id.optional(), q: searchTerm, from: isoDate.optional(), to: isoDate.optional(), ...pagination,
}), 'query'), orders.list);
ordersRouter.get('/:id', requirePermission('orders.view'), params, orders.get);
ordersRouter.post('/:id/accept', requirePermission('orders.manage'), params, validate(z.object({
  prescriptions: z.record(z.string().regex(/^\d+$/), z.string().trim().min(3).max(80)).optional(), note: optionalText(500),
}).strict()), orders.accept);
const reason = validate(z.object({ reason: z.string().trim().min(5, 'Indique el motivo').max(400) }).strict());
ordersRouter.post('/:id/reject', requirePermission('orders.manage'), params, reason, orders.reject);
ordersRouter.post('/:id/prepare', requirePermission('orders.manage'), params, validate(z.object({}).strict()), orders.prepare);
ordersRouter.post('/:id/ready', requirePermission('orders.manage'), params, validate(z.object({}).strict()), orders.ready);
ordersRouter.post('/:id/complete', requirePermission('orders.manage'), params, validate(z.object({ tenderedAmount: money(10).optional() }).strict()), orders.complete);
ordersRouter.post('/:id/cancel', requirePermission('orders.manage'), params, reason, orders.cancel);
ordersRouter.post('/:id/assign', requirePermission('orders.assign'), params, validate(z.object({ userId: id }).strict()), orders.assign);

module.exports = { storeRouter, ordersRouter };
