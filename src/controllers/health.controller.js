'use strict';

const healthService = require('../services/health.service');

async function getHealth(req, res) {
  const { httpStatus, body } = await healthService.checkHealth();
  res.set('Cache-Control', 'no-store');
  res.status(httpStatus).json(body);
}

module.exports = { getHealth };
