'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const { config } = require('./config/env');
const { logger } = require('./config/logger');
const { requestContext } = require('./middlewares/request-context');
const { notFound, errorHandler } = require('./middlewares/error-handler');
const apiRoutes = require('./routes');

const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url === '/api/health' && !config.isProduction },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { 'script-src': ["'self'"], 'object-src': ["'none'"], 'frame-ancestors': ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api', apiRoutes);
  app.use('/api', notFound);

  // Imágenes subidas (solo archivos; sin listado de directorios ni ejecución).
  app.use(
    '/uploads',
    express.static(config.uploads.dir, {
      index: false,
      dotfiles: 'deny',
      fallthrough: true,
      maxAge: config.isProduction ? '7d' : 0,
      setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
    }),
  );

  // Frontend React compilado por Vite (npm run build → frontend/dist).
  app.use(express.static(FRONTEND_DIST, {
    index: false,
    dotfiles: 'ignore',
    setHeaders: (res, file) => {
      // Los archivos de assets/ llevan hash en el nombre: se pueden guardar en caché sin límite.
      const hashed = file.includes(`${path.sep}assets${path.sep}`);
      res.set('Cache-Control', hashed && config.isProduction ? 'public, max-age=31536000, immutable' : (config.isProduction ? 'public, max-age=3600' : 'no-cache'));
    },
  }));

  // Rutas del frontend (/, /catalogo, /admin/pos…): devuelven index.html y React Router resuelve la vista.
  // No intercepta la API, las imágenes subidas, Socket.IO ni archivos inexistentes (con extensión).
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (/^\/(api|uploads|socket\.io)(\/|$)/.test(req.path) || path.extname(req.path)) return next();
    const index = path.join(FRONTEND_DIST, 'index.html');
    if (!fs.existsSync(index)) {
      return res.status(503).type('text/plain; charset=utf-8').send('El frontend no está compilado. Ejecute "npm run build" (o use "npm run dev:web" en desarrollo).');
    }
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(index);
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
