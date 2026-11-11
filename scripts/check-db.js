'use strict';

/**
 * npm run db:check
 * Verifica la conexión real con MariaDB usando las credenciales de .env y
 * muestra versión, base, configuración de sesión y objetos del esquema.
 */

const { validateConfig } = require('../src/config/env');
const { closePool } = require('../src/config/database');
const { checkHealth } = require('../src/services/health.service');

async function main() {
  const problems = validateConfig({ requireAuthSecrets: false });
  if (problems.length > 0) {
    console.error('Configuración incompleta en .env:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  const { httpStatus, body } = await checkHealth();
  console.log(JSON.stringify(body, null, 2));
  if (httpStatus !== 200) process.exitCode = 1;
}

main().finally(() => closePool());
