'use strict';

const crypto = require('node:crypto');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Asigna un id a cada petición y prepara el contexto que se pasará a
 * sp_set_app_context. El usuario y la sucursal los completa authenticate.
 */
function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  req.dbContext = {
    requestId: req.id,
    ip: req.ip || null,
    userAgent: req.get('user-agent') || null,
    userId: null,
    branchId: null,
    sessionRef: null,
  };
  next();
}

module.exports = { requestContext };
