'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/authenticate');
const { requirePermission, requireAnyPermission } = require('../middlewares/authorize');
const { validate } = require('../middlewares/validate');
const { idParam } = require('../validators/common.validator');
const vp = require('../validators/pos.validator');
const { cash, sales } = require('../controllers/pos.controller');

const params = validate(idParam, 'params');
const anyCash = requireAnyPermission('cash.open', 'cash.close', 'cash.movements', 'cash.view_all');

// ------------------------------------------------------------------- caja
const cashRouter = Router();
cashRouter.use(authenticate);
cashRouter.get('/registers', anyCash, cash.registers);
cashRouter.get('/sessions', anyCash, validate(vp.sessionListQuery, 'query'), cash.listSessions);
cashRouter.get('/sessions/current', anyCash, cash.currentSession);
cashRouter.get('/sessions/:id', anyCash, params, cash.getSession);
cashRouter.post('/sessions', requirePermission('cash.open'), validate(vp.sessionOpen), cash.openSession);
cashRouter.post('/sessions/:id/close', requirePermission('cash.close'), params, validate(vp.sessionClose), cash.closeSession);
cashRouter.get('/movements', anyCash, validate(vp.cashMovementQuery, 'query'), cash.listMovements);
cashRouter.post('/movements', requirePermission('cash.movements'), validate(vp.cashMovementCreate), cash.addMovement);

// ----------------------------------------------------------------- ventas
const salesRouter = Router();
salesRouter.use(authenticate);
salesRouter.get('/catalog', requirePermission('sales.create'), validate(vp.catalogQuery, 'query'), sales.catalog);
salesRouter.post('/quote', requirePermission('sales.create'), validate(vp.quote), sales.quote);
salesRouter.post('/', requirePermission('sales.create', 'payments.register'), validate(vp.saleCreate), sales.create);
salesRouter.get('/', requirePermission('sales.view'), validate(vp.saleListQuery, 'query'), sales.list);
salesRouter.get('/:id', requirePermission('sales.view'), params, sales.get);
salesRouter.post('/:id/void', requirePermission('sales.void'), params, validate(vp.saleVoid), sales.void);
salesRouter.get('/:id/ticket', requireAnyPermission('sales.view', 'tickets.print'), params, validate(vp.ticketQuery, 'query'), sales.ticket);
salesRouter.post('/:id/ticket', requirePermission('tickets.print'), params, sales.issueTicket);
salesRouter.post('/:id/ticket/print', requirePermission('tickets.print'), params, sales.printTicket);

// ------------------------------------------------------------------ pagos
const paymentsRouter = Router();
paymentsRouter.use(authenticate);
paymentsRouter.get('/', requirePermission('payments.view'), validate(vp.paymentListQuery, 'query'), sales.payments);

module.exports = { cashRouter, salesRouter, paymentsRouter };
