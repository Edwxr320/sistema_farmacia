'use strict';

/**
 * Debe requerirse ANTES que cualquier módulo de src/.
 * Las credenciales de MariaDB se leen del .env real (no se simulan).
 * Los secretos de sesión de prueba son aleatorios y solo viven en este proceso.
 */
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.BCRYPT_COST = '10'; // más rápido en pruebas (producción: 12+)
process.env.AUTH_MAX_FAILED_ATTEMPTS = '5';
process.env.AUTH_LOCKOUT_MINUTES = '15';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.CSRF_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'silent';
process.env.JOBS_ENABLED = 'false';
// Imágenes de prueba en una carpeta temporal propia (se borra al terminar cada archivo de pruebas).
process.env.UPLOADS_DIR = require('node:path').join(require('node:os').tmpdir(), `pp-test-uploads-${process.pid}`);
