'use strict';

const { rateLimit } = require('express-rate-limit');
const { config } = require('../config/env');

function limiter(message) {
  return rateLimit({
    windowMs: config.auth.loginRateLimitWindowMinutes * 60 * 1000,
    limit: config.auth.loginRateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => config.isTest,
    handler: (req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message, requestId: req.id } });
    },
  });
}

/** Límite de intentos de login por IP (complementa el bloqueo por usuario de la base). */
const loginRateLimiter = limiter('Demasiados intentos de inicio de sesión. Intente más tarde.');

/** Límite para operaciones sensibles como el cambio de contraseña. */
const sensitiveRateLimiter = limiter('Demasiados intentos. Intente más tarde.');

module.exports = { loginRateLimiter, sensitiveRateLimiter };
