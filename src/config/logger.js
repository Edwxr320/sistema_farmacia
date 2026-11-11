'use strict';

const pino = require('pino');
const { config } = require('./env');

// Rutas que jamás deben aparecer en los registros.
const REDACT_PATHS = [
  'password',
  'password_hash',
  'passwordHash',
  'token',
  '*.password',
  '*.password_hash',
  '*.passwordHash',
  '*.token',
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'err.sql',
  'err.sqlMessage',
];

const logger = pino({
  level: config.logLevel,
  base: { app: 'pharma-plus' },
  redact: { paths: REDACT_PATHS, censor: '[PROTEGIDO]' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = { logger };
