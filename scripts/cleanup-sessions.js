'use strict';

/**
 * npm run sessions:cleanup
 * Elimina de user_sessions las sesiones expiradas. El servidor ya lo hace al
 * iniciar y cada hora; este script sirve para tareas programadas externas.
 */

const { validateConfig } = require('../src/config/env');
const { closePool } = require('../src/config/database');
const { cleanupExpiredSessions } = require('../src/services/session.service');

const problems = validateConfig({ requireAuthSecrets: false });
if (problems.length > 0) {
  for (const p of problems) console.error(`- ${p}`);
  process.exitCode = 1;
} else {
  cleanupExpiredSessions()
    .then((n) => console.log(`Sesiones expiradas eliminadas: ${n}`))
    .catch((err) => {
      console.error(`✖ ${err.errno === 1146 ? 'Falta la migración 001_user_sessions.sql' : err.code || err.message}`);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
