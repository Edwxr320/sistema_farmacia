'use strict';

/**
 * npm run test:tempdb
 *
 * Ejecuta TODA la suite contra una base TEMPORAL (copia del esquema + migraciones), de modo
 * que los escenarios que confirman datos (concurrencia real) nunca tocan pharma_plus:
 *   1. Crea pp_test_<marca> importando database/pharma_plus_mariadb_10_11.sql y database/migrations/*.sql.
 *   2. Concede a pharma_app (DB_USER) los mismos privilegios que tiene sobre pharma_plus.
 *   3. Ejecuta las pruebas con DB_NAME=<temporal> y PP_CONCURRENCY_DB=1.
 *   4. Revoca los privilegios y elimina la base temporal (siempre, aunque fallen las pruebas).
 *
 * Argumentos opcionales: patrones de pruebas (por defecto, toda la suite). Ejemplo E2E:
 *   node scripts/test-tempdb.js "tests/e2e/*.test.js"   (npm run test:e2e; activa PP_E2E=1)
 *
 * Requiere el cliente de MariaDB y una cuenta administrativa LOCAL:
 *   MARIADB_CLI (por defecto C:\xampp\mysql\bin\mariadb.exe)
 *   TEST_DB_ADMIN_USER (por defecto root) / TEST_DB_ADMIN_PASSWORD (por defecto vacío, como en XAMPP)
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { config } = require('../src/config/env');

const ROOT = path.resolve(__dirname, '..');
const CLI = process.env.MARIADB_CLI || 'C:\\xampp\\mysql\\bin\\mariadb.exe';
const ADMIN_USER = process.env.TEST_DB_ADMIN_USER || 'root';
const ADMIN_PASSWORD = process.env.TEST_DB_ADMIN_PASSWORD || '';
const TEMP_DB = `pp_test_${Date.now().toString(36)}`;
const APP_USER = config.db.user;
const PATTERNS = process.argv.slice(2).length ? process.argv.slice(2) : ['tests/**/*.test.js'];
const E2E = PATTERNS.some((p) => p.includes('e2e'));

if (!/^pp_test_[a-z0-9]+$/.test(TEMP_DB) || TEMP_DB === 'pharma_plus') throw new Error('Nombre de base temporal inválido');

function mariadb(sql, { allowFail = false } = {}) {
  const args = ['-u', ADMIN_USER, '-h', config.db.host, '-P', String(config.db.port), '--batch'];
  const env = { ...process.env, ...(ADMIN_PASSWORD ? { MYSQL_PWD: ADMIN_PASSWORD } : {}) }; // nunca en la línea de comandos
  const r = spawnSync(CLI, args, { input: sql, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`MariaDB: ${(r.stderr || r.error?.message || '').trim()}`);
  return r;
}

const retarget = (sql) => sql
  .replace(/CREATE DATABASE IF NOT EXISTS pharma_plus\b/, `CREATE DATABASE IF NOT EXISTS ${TEMP_DB}`)
  .replace(/^USE pharma_plus;/gm, `USE ${TEMP_DB};`)
  .replace(/TABLE_SCHEMA = 'pharma_plus'/g, `TABLE_SCHEMA = '${TEMP_DB}'`);

function hosts() {
  const r = mariadb(`SELECT host FROM mysql.user WHERE user = '${APP_USER.replace(/'/g, '')}';`);
  return r.stdout.split(/\r?\n/).slice(1).filter(Boolean);
}

let exitCode = 1;
let created = false;
try {
  console.log(`[tempdb] Creando ${TEMP_DB} desde el esquema y las migraciones...`);
  created = true;
  mariadb(retarget(fs.readFileSync(path.join(ROOT, 'database', 'pharma_plus_mariadb_10_11.sql'), 'utf8')));
  const migDir = path.join(ROOT, 'database', 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    mariadb(retarget(fs.readFileSync(path.join(migDir, f), 'utf8')));
    console.log(`[tempdb]   migración aplicada: ${f}`);
  }
  const appHosts = hosts();
  if (appHosts.length === 0) throw new Error(`No existe el usuario ${APP_USER}`);
  mariadb(appHosts.map((h) => `GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON ${TEMP_DB}.* TO '${APP_USER}'@'${h}';`).join('\n'));

  console.log(`[tempdb] Ejecutando ${PATTERNS.join(' ')} contra la base temporal...`);
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...PATTERNS], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, DB_NAME: TEMP_DB, PP_CONCURRENCY_DB: '1', ...(E2E ? { PP_E2E: '1' } : {}) },
  });
  exitCode = run.status ?? 1;
} catch (err) {
  console.error(`[tempdb] Error: ${err.message}`);
} finally {
  if (created) {
    try {
      const appHosts = hosts();
      mariadb(appHosts.map((h) => `REVOKE ALL PRIVILEGES ON ${TEMP_DB}.* FROM '${APP_USER}'@'${h}';`).join('\n'), { allowFail: true });
    } catch { /* el usuario puede no existir */ }
    mariadb(`DROP DATABASE IF EXISTS ${TEMP_DB};`, { allowFail: true });
    console.log(`[tempdb] Base temporal ${TEMP_DB} eliminada.`);
  }
  process.exitCode = exitCode;
}
