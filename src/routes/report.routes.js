'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/authenticate');
const { requirePermission } = require('../middlewares/authorize');
const { validate } = require('../middlewares/validate');
const { z, id, isoDate, pagination } = require('../validators/common.validator');
const r = require('../services/report.service');

const base = { from: isoDate.optional(), to: isoDate.optional(), branchId: id.optional() };
const q = (extra = {}) => validate(z.object({ ...base, ...extra }), 'query');
const handler = (fn) => async (req, res) => res.json({ data: await fn(req.auth, req.validated.query, req.dbContext) });
const paged = (fn) => async (req, res) => res.json(await fn(req.auth, req.validated.query, req.dbContext));

/** Reportes de solo lectura: GET, permiso reports.view y alcance por sucursal (reports.consolidated para varias). */
const router = Router();
router.use(authenticate, requirePermission('reports.view'));

router.get('/dashboard', q(), handler(r.dashboard));
router.get('/sales/summary', q({ channel: z.enum(['POS', 'ONLINE']).optional(), sellerId: id.optional() }), handler(r.salesSummary));
router.get('/sales/compare', q({ channel: z.enum(['POS', 'ONLINE']).optional() }), handler(r.salesCompare));
router.get('/sales/series', q({ granularity: z.enum(['day', 'week', 'month']).default('day'), channel: z.enum(['POS', 'ONLINE']).optional() }), handler(r.salesSeries));
router.get('/sales/top-products', q({ limit: z.coerce.number().int().min(1).max(100).default(10), orderBy: z.enum(['quantity', 'revenue']).default('quantity'), categoryId: id.optional() }), handler(r.topProducts));
router.get('/sales/by-category', q(), handler(r.byCategory));
router.get('/sales/by-branch', q(), handler(r.byBranch));
router.get('/sales/by-seller', q(), handler(r.bySeller));
router.get('/payments/methods', q(), handler(r.paymentMethods));
router.get('/inventory/valuation', q({ categoryId: id.optional() }), handler(r.inventory));
router.get('/inventory/low-stock', q(pagination), paged(r.lowStock));
router.get('/inventory/expiring', q({ days: z.coerce.number().int().min(0).max(730).default(90), ...pagination }), paged(r.expiring));
router.get('/inventory/movements', q({ productId: id.optional() }), handler(r.movements));
router.get('/returns', q(), handler(r.returnsReport));
router.get('/orders', q(), handler(r.ordersReport));
router.get('/cash', q(pagination), paged(r.cashReport));
router.get('/activity', requirePermission('audit.view'), q({
  module: z.string().trim().max(60).optional(), action: z.string().trim().max(40).optional(), userId: id.optional(),
  entityTable: z.string().trim().regex(/^[a-z_]+$/).max(64).optional(), ...pagination,
}), paged(r.activityReport));

module.exports = router;
