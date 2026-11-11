'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/authenticate');
const { requirePermission, requireAnyPermission } = require('../middlewares/authorize');
const { validate } = require('../middlewares/validate');
const { singleImage } = require('../middlewares/upload');
const { idParam } = require('../validators/common.validator');
const vc = require('../validators/catalog.validator');
const { z, pagination } = require('../validators/common.validator');
const { categories, laboratories, products, suppliers } = require('../controllers/catalog.controller');

const params = validate(idParam, 'params');

/** Rutas para categorías y laboratorios (mismo contrato). */
function namedCatalogRouter(ctrl, createSchema, updateSchema) {
  const r = Router();
  r.use(authenticate);
  r.get('/', requirePermission('products.view'), validate(vc.catalogListQuery, 'query'), ctrl.list);
  r.get('/:id', requirePermission('products.view'), params, ctrl.get);
  r.post('/', requirePermission('categories.manage'), validate(createSchema), ctrl.create);
  r.put('/:id', requirePermission('categories.manage'), params, validate(updateSchema), ctrl.update);
  r.patch('/:id/status', requirePermission('categories.manage'), params, validate(vc.activeBody), ctrl.setActive);
  r.delete('/:id', requirePermission('categories.manage'), params, ctrl.remove);
  return r;
}

const categoriesRouter = namedCatalogRouter(categories, vc.categoryCreate, vc.categoryUpdate);
const laboratoriesRouter = namedCatalogRouter(laboratories, vc.laboratoryCreate, vc.laboratoryUpdate);

const productsRouter = Router();
productsRouter.use(authenticate);
productsRouter.get('/', requirePermission('products.view'), validate(vc.productListQuery, 'query'), products.list);
productsRouter.get('/:id', requirePermission('products.view'), params, products.get);
productsRouter.post('/', requirePermission('products.create'), validate(vc.productCreate), products.create);
productsRouter.put('/:id', requirePermission('products.update'), params, validate(vc.productUpdate), products.update);
productsRouter.patch('/:id/status', requirePermission('products.deactivate'), params, validate(vc.productStatusBody), products.setStatus);
productsRouter.put('/:id/image', requirePermission('products.update'), params, singleImage, products.setImage);
productsRouter.get('/:id/branches', requirePermission('products.view'), params, products.listBranches);
productsRouter.put(
  '/:id/branches/:branchId',
  requireAnyPermission('products.prices', 'products.update', 'inventory.minimum_stock'),
  validate(vc.productBranchParams, 'params'),
  validate(vc.branchProductUpdate),
  products.updateBranch,
);

const suppliersRouter = Router();
suppliersRouter.use(authenticate);
suppliersRouter.get('/', requirePermission('suppliers.view'), validate(vc.supplierListQuery, 'query'), suppliers.list);
suppliersRouter.get('/:id', requirePermission('suppliers.view'), params, suppliers.get);
suppliersRouter.get(
  '/:id/entries',
  requirePermission('suppliers.view', 'inventory.view'),
  params,
  validate(z.object({ status: z.enum(['DRAFT', 'POSTED', 'CANCELLED']).optional(), ...pagination }), 'query'),
  suppliers.entries,
);
suppliersRouter.post('/', requirePermission('suppliers.manage'), validate(vc.supplierCreate), suppliers.create);
suppliersRouter.put('/:id', requirePermission('suppliers.manage'), params, validate(vc.supplierUpdate), suppliers.update);
suppliersRouter.patch('/:id/status', requirePermission('suppliers.manage'), params, validate(vc.supplierStatusBody), suppliers.setStatus);

module.exports = { categoriesRouter, laboratoriesRouter, productsRouter, suppliersRouter };
