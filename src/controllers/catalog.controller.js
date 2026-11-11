'use strict';

const { categoryService, laboratoryService } = require('../services/named-catalog.service');
const productService = require('../services/product.service');
const supplierService = require('../services/supplier.service');

/** Controlador CRUD para catálogos con nombre (categorías y laboratorios). */
function namedCatalogController(service) {
  return {
    list: async (req, res) => res.json(await service.list(req.validated.query, req.dbContext)),
    get: async (req, res) => res.json({ data: await service.get(req.validated.params.id, req.dbContext) }),
    create: async (req, res) => res.status(201).json({ data: await service.create(req.validated.body, req.dbContext) }),
    update: async (req, res) => res.json({ data: await service.update(req.validated.params.id, req.validated.body, req.dbContext) }),
    setActive: async (req, res) => res.json({
      data: await service.setActive(req.validated.params.id, req.validated.body.isActive, req.dbContext),
    }),
    remove: async (req, res) => {
      await service.remove(req.validated.params.id, req.dbContext);
      res.status(204).end();
    },
  };
}

const categories = namedCatalogController(categoryService);
const laboratories = namedCatalogController(laboratoryService);

const products = {
  list: async (req, res) => res.json(await productService.list(req.validated.query, req.dbContext)),
  get: async (req, res) => res.json({ data: await productService.get(req.validated.params.id, req.auth, req.dbContext) }),
  create: async (req, res) => res.status(201).json({ data: await productService.create(req.validated.body, req.dbContext) }),
  update: async (req, res) => res.json({
    data: await productService.update(req.validated.params.id, req.validated.body, req.auth, req.dbContext),
  }),
  setStatus: async (req, res) => res.json({
    data: await productService.setStatus(req.validated.params.id, req.validated.body.status, req.dbContext),
  }),
  setImage: async (req, res) => res.json({ data: await productService.setImage(req.validated.params.id, req.file, req.dbContext) }),
  listBranches: async (req, res) => res.json({
    data: await productService.listBranchConfigs(req.validated.params.id, req.auth, req.dbContext),
  }),
  updateBranch: async (req, res) => res.json({
    data: await productService.updateBranchConfig(
      req.validated.params.id, req.validated.params.branchId, req.validated.body, req.auth, req.dbContext,
    ),
  }),
};

const suppliers = {
  list: async (req, res) => res.json(await supplierService.list(req.validated.query, req.dbContext)),
  get: async (req, res) => res.json({ data: await supplierService.get(req.validated.params.id, req.dbContext) }),
  create: async (req, res) => res.status(201).json({ data: await supplierService.create(req.validated.body, req.dbContext) }),
  update: async (req, res) => res.json({ data: await supplierService.update(req.validated.params.id, req.validated.body, req.dbContext) }),
  setStatus: async (req, res) => res.json({
    data: await supplierService.setStatus(req.validated.params.id, req.validated.body.status, req.dbContext),
  }),
  entries: async (req, res) => res.json(await supplierService.entries(req.validated.params.id, req.validated.query, req.auth, req.dbContext)),
};

module.exports = { categories, laboratories, products, suppliers };
