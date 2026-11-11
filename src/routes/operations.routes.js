'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/authenticate');
const { requirePermission, requireAnyPermission } = require('../middlewares/authorize');
const { validate } = require('../middlewares/validate');
const { idParam, z } = require('../validators/common.validator');
const vo = require('../validators/operations.validator');
const { returns, transfers } = require('../controllers/operations.controller');

const params = validate(idParam, 'params');
const anyReturns = requireAnyPermission('returns.create', 'returns.approve');

// ------------------------------------------------------------ devoluciones
const returnsRouter = Router();
returnsRouter.use(authenticate);
returnsRouter.get('/reasons', anyReturns, returns.reasons);
returnsRouter.get('/lookup', anyReturns, validate(vo.saleLookupQuery, 'query'), returns.lookup);
returnsRouter.get('/sales/:id', anyReturns, params, returns.returnable);
returnsRouter.get('/', requireAnyPermission('returns.create', 'returns.approve', 'sales.view'), validate(vo.returnListQuery, 'query'), returns.list);
returnsRouter.get('/:id', requireAnyPermission('returns.create', 'returns.approve', 'sales.view'), params, returns.get);
returnsRouter.post('/', requirePermission('returns.create'), validate(vo.returnCreate), returns.create);
returnsRouter.post('/:id/approve', requirePermission('returns.approve'), params, validate(z.object({}).strict()), returns.approve);
returnsRouter.post('/:id/reject', requirePermission('returns.approve'), params, validate(vo.returnReject), returns.reject);
returnsRouter.post('/:id/complete', requirePermission('returns.approve'), params, validate(vo.returnComplete), returns.complete);

// ---------------------------------------------------------- transferencias
const transfersRouter = Router();
transfersRouter.use(authenticate);
const anyTransfer = requireAnyPermission('inventory.view', 'inventory.transfers', 'inventory.receive_transfers');
transfersRouter.get('/', anyTransfer, validate(vo.transferListQuery, 'query'), transfers.list);
transfersRouter.get('/:id', anyTransfer, params, transfers.get);
transfersRouter.post('/', requirePermission('inventory.transfers'), validate(vo.transferCreate), transfers.create);
transfersRouter.put('/:id', requirePermission('inventory.transfers'), params, validate(vo.transferUpdate), transfers.update);
transfersRouter.post('/:id/approve', requirePermission('inventory.transfers'), params, validate(vo.transferApprove), transfers.approve);
transfersRouter.post('/:id/dispatch', requirePermission('inventory.transfers'), params, validate(z.object({}).strict()), transfers.dispatch);
transfersRouter.post('/:id/receive', requirePermission('inventory.receive_transfers'), params, validate(vo.transferReceive), transfers.receive);
transfersRouter.post('/:id/cancel', requirePermission('inventory.transfers'), params, validate(vo.transferCancel), transfers.cancel);

module.exports = { returnsRouter, transfersRouter };
