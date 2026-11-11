'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/authenticate');
const { requirePermission, requireAnyPermission } = require('../middlewares/authorize');
const { validate } = require('../middlewares/validate');
const { idParam } = require('../validators/common.validator');
const vi = require('../validators/inventory.validator');
const c = require('../controllers/inventory.controller');

const params = validate(idParam, 'params');
const router = Router();
router.use(authenticate);

// Consultas de inventario
router.get('/', requirePermission('inventory.view'), validate(vi.stockQuery, 'query'), c.stock);
router.get('/low-stock', requirePermission('inventory.view'), validate(vi.lowStockQuery, 'query'), c.lowStock);
router.get('/batches', requirePermission('inventory.view'), validate(vi.batchQuery, 'query'), c.batches);
router.get('/batches/:id', requirePermission('inventory.view'), params, c.batch);
router.get('/movements', requirePermission('inventory.view'), validate(vi.movementQuery, 'query'), c.movements);
router.get('/fefo', requirePermission('inventory.view'), validate(vi.fefoQuery, 'query'), c.fefo);

// Entradas de mercadería
router.get('/entries', requirePermission('inventory.view'), validate(vi.entryListQuery, 'query'), c.listEntries);
router.get('/entries/:id', requirePermission('inventory.view'), params, c.getEntry);
router.post('/entries', requirePermission('inventory.entries'), validate(vi.entryCreate), c.createEntry);
router.put('/entries/:id', requirePermission('inventory.entries'), params, validate(vi.entryUpdate), c.updateEntry);
router.post('/entries/:id/post', requirePermission('inventory.entries'), params, c.postEntry);
router.post('/entries/:id/cancel', requirePermission('inventory.entries'), params, validate(vi.entryCancel), c.cancelEntry);

// Ajustes y bajas (el permiso exacto según el tipo lo valida el servicio)
router.get('/adjustments', requirePermission('inventory.view'), validate(vi.adjustmentListQuery, 'query'), c.listAdjustments);
router.get('/adjustments/:id', requirePermission('inventory.view'), params, c.getAdjustment);
router.post('/adjustments', requireAnyPermission('inventory.adjust', 'inventory.write_off'), validate(vi.adjustmentCreate), c.createAdjustment);

// Alertas
router.get('/alerts', requirePermission('alerts.view'), validate(vi.alertQuery, 'query'), c.listAlerts);
router.post('/alerts/refresh-expiry', requirePermission('alerts.resolve'), c.refreshExpiryAlerts);
router.get('/alerts/:id', requirePermission('alerts.view'), params, c.getAlert);
router.post('/alerts/:id/close', requirePermission('alerts.resolve'), params, validate(vi.alertResolve), c.closeAlert);

module.exports = router;
