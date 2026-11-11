'use strict';

const inventoryService = require('../services/inventory.service');
const entryService = require('../services/stock-entry.service');
const alertService = require('../services/alert.service');
const adjustmentService = require('../services/adjustment.service');

const v = (req) => req.validated;

module.exports = {
  stock: async (req, res) => res.json(await inventoryService.stock(v(req).query, req.auth, req.dbContext)),
  lowStock: async (req, res) => res.json(await inventoryService.lowStock(v(req).query, req.auth, req.dbContext)),
  batches: async (req, res) => res.json(await inventoryService.batches(v(req).query, req.auth, req.dbContext)),
  batch: async (req, res) => res.json({ data: await inventoryService.batch(v(req).params.id, req.auth, req.dbContext) }),
  movements: async (req, res) => res.json(await inventoryService.movements(v(req).query, req.auth, req.dbContext)),
  fefo: async (req, res) => res.json({ data: await inventoryService.fefo(v(req).query, req.auth, req.dbContext) }),

  listEntries: async (req, res) => res.json(await entryService.list(v(req).query, req.auth, req.dbContext)),
  getEntry: async (req, res) => res.json({ data: await entryService.get(v(req).params.id, req.auth, req.dbContext) }),
  createEntry: async (req, res) => res.status(201).json({ data: await entryService.create(v(req).body, req.auth, req.dbContext) }),
  updateEntry: async (req, res) => res.json({ data: await entryService.update(v(req).params.id, v(req).body, req.auth, req.dbContext) }),
  postEntry: async (req, res) => {
    const data = await entryService.post(v(req).params.id, req.auth, req.dbContext);
    res.status(200).json({ data });
  },
  cancelEntry: async (req, res) => res.json({
    data: await entryService.cancel(v(req).params.id, v(req).body.reason, req.auth, req.dbContext),
  }),

  listAdjustments: async (req, res) => res.json(await adjustmentService.list(v(req).query, req.auth, req.dbContext)),
  getAdjustment: async (req, res) => res.json({ data: await adjustmentService.get(v(req).params.id, req.auth, req.dbContext) }),
  createAdjustment: async (req, res) => res.status(201).json({ data: await adjustmentService.create(v(req).body, req.auth, req.dbContext) }),

  listAlerts: async (req, res) => res.json(await alertService.list(v(req).query, req.auth, req.dbContext)),
  getAlert: async (req, res) => res.json({ data: await alertService.get(v(req).params.id, req.auth, req.dbContext) }),
  closeAlert: async (req, res) => res.json({ data: await alertService.close(v(req).params.id, v(req).body, req.auth, req.dbContext) }),
  refreshExpiryAlerts: async (req, res) => res.json({ data: await alertService.refreshExpiryAlerts(req.dbContext) }),
};
