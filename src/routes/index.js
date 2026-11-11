'use strict';

const { Router } = require('express');
const { csrfProtection } = require('../middlewares/csrf');

const router = Router();

// Toda petición que modifica datos bajo /api pasa por la protección CSRF.
router.use(csrfProtection);

router.use('/health', require('./health.routes'));
router.use('/auth', require('./auth.routes'));
const admin = require('./admin.routes');
router.use('/users', admin.usersRouter);
router.use('/roles', admin.rolesAdminRouter);
router.use('/customers', admin.customersRouter);
router.use('/branches', admin.branchesRouter);
router.use('/settings', admin.settingsRouter);

const { categoriesRouter, laboratoriesRouter, productsRouter, suppliersRouter } = require('./catalog.routes');
router.use('/categories', categoriesRouter);
router.use('/laboratories', laboratoriesRouter);
router.use('/products', productsRouter);
router.use('/suppliers', suppliersRouter);
const { returnsRouter, transfersRouter } = require('./operations.routes');
router.use('/inventory/transfers', transfersRouter);
router.use('/inventory', require('./inventory.routes'));
router.use('/returns', returnsRouter);

const { storeRouter, ordersRouter } = require('./store.routes');
router.use('/store', storeRouter);
router.use('/orders', ordersRouter);
router.use('/reports', require('./report.routes'));

const { cashRouter, salesRouter, paymentsRouter } = require('./pos.routes');
router.use('/cash', cashRouter);
router.use('/sales', salesRouter);
router.use('/payments', paymentsRouter);

module.exports = router;
