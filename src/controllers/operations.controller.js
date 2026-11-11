'use strict';

const returnService = require('../services/return.service');
const transferService = require('../services/transfer.service');

const v = (req) => req.validated;

const returns = {
  reasons: async (req, res) => res.json({ data: await returnService.reasons(req.dbContext) }),
  lookup: async (req, res) => res.json({ data: await returnService.lookupSale(v(req).query, req.auth, req.dbContext) }),
  returnable: async (req, res) => res.json({ data: await returnService.returnable(v(req).params.id, req.auth, req.dbContext) }),
  list: async (req, res) => res.json(await returnService.list(v(req).query, req.auth, req.dbContext)),
  get: async (req, res) => res.json({ data: await returnService.get(v(req).params.id, req.auth, req.dbContext) }),
  create: async (req, res) => res.status(201).json({ data: await returnService.create(v(req).body, req.auth, req.dbContext) }),
  approve: async (req, res) => res.json({ data: await returnService.approve(v(req).params.id, req.auth, req.dbContext) }),
  reject: async (req, res) => res.json({ data: await returnService.reject(v(req).params.id, v(req).body.reason, req.auth, req.dbContext) }),
  complete: async (req, res) => res.json({ data: await returnService.complete(v(req).params.id, v(req).body, req.auth, req.dbContext) }),
};

const transfers = {
  list: async (req, res) => res.json(await transferService.list(v(req).query, req.auth, req.dbContext)),
  get: async (req, res) => res.json({ data: await transferService.get(v(req).params.id, req.auth, req.dbContext) }),
  create: async (req, res) => res.status(201).json({ data: await transferService.create(v(req).body, req.auth, req.dbContext) }),
  update: async (req, res) => res.json({ data: await transferService.update(v(req).params.id, v(req).body, req.auth, req.dbContext) }),
  approve: async (req, res) => res.json({ data: await transferService.approve(v(req).params.id, v(req).body, req.auth, req.dbContext) }),
  dispatch: async (req, res) => res.json({ data: await transferService.dispatch(v(req).params.id, req.auth, req.dbContext) }),
  receive: async (req, res) => res.json({ data: await transferService.receive(v(req).params.id, v(req).body, req.auth, req.dbContext) }),
  cancel: async (req, res) => res.json({ data: await transferService.cancel(v(req).params.id, v(req).body.reason, req.auth, req.dbContext) }),
};

module.exports = { returns, transfers };
