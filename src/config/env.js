'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Variable de entorno ${name} inválida (entero entre ${min} y ${max})`);
  }
  return n;
}

const nodeEnv = str('NODE_ENV', 'development');

const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: int('PORT', 3000, { min: 1, max: 65535 }),
  logLevel: str('LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
  trustProxy: int('TRUST_PROXY', 0, { min: 0, max: 10 }),
  allowedOrigins: str('ALLOWED_ORIGINS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  uploads: Object.freeze({
    dir: path.resolve(str('UPLOADS_DIR', path.resolve(__dirname, '..', '..', 'uploads'))),
    maxImageBytes: int('UPLOAD_MAX_IMAGE_KB', 2048, { min: 50, max: 10240 }) * 1024,
  }),

  jobs: Object.freeze({
    enabled: str('JOBS_ENABLED', nodeEnv === 'test' ? 'false' : 'true') === 'true',
    expiryAlertsHour: int('EXPIRY_ALERTS_HOUR', 6, { min: 0, max: 23 }),
  }),

  db: Object.freeze({
    host: str('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306, { min: 1, max: 65535 }),
    user: str('DB_USER', ''),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME', 'pharma_plus'),
    connectionLimit: int('DB_CONNECTION_LIMIT', 10, { min: 1, max: 100 }),
  }),

  auth: Object.freeze({
    jwtSecret: str('JWT_SECRET', ''),
    csrfSecret: str('CSRF_SECRET', ''),
    sessionTtlMinutes: int('SESSION_TTL_MINUTES', 480, { min: 5, max: 7 * 24 * 60 }),
    bcryptCost: int('BCRYPT_COST', 12, { min: 10, max: 15 }),
    maxFailedAttempts: int('AUTH_MAX_FAILED_ATTEMPTS', 5, { min: 1, max: 100 }),
    lockoutMinutes: int('AUTH_LOCKOUT_MINUTES', 15, { min: 1, max: 24 * 60 }),
    loginRateLimitMax: int('LOGIN_RATE_LIMIT_MAX', 20, { min: 1, max: 10000 }),
    loginRateLimitWindowMinutes: int('LOGIN_RATE_LIMIT_WINDOW_MINUTES', 15, { min: 1, max: 24 * 60 }),
  }),
});

/**
 * Comprueba la configuración mínima. Devuelve la lista de problemas (sin valores secretos).
 * @param {{ requireAuthSecrets?: boolean }} opts
 */
function validateConfig({ requireAuthSecrets = true } = {}) {
  const problems = [];
  if (!config.db.user) problems.push('DB_USER no está definido');
  if (config.db.user === 'root') {
    problems.push('DB_USER=root no está permitido: use el usuario restringido pharma_app');
  }
  if (!config.db.password) problems.push('DB_PASSWORD no está definido');
  if (requireAuthSecrets) {
    if (config.auth.jwtSecret.length < 32) problems.push('JWT_SECRET debe tener al menos 32 caracteres');
    if (config.auth.csrfSecret.length < 32) problems.push('CSRF_SECRET debe tener al menos 32 caracteres');
    if (config.auth.jwtSecret && config.auth.jwtSecret === config.auth.csrfSecret) {
      problems.push('JWT_SECRET y CSRF_SECRET deben ser distintos');
    }
  }
  return problems;
}

module.exports = { config, validateConfig };
