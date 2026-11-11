'use strict';

/**
 * npm run settings:security
 * Agrega security.max_failed_logins y security.lockout_minutes a settings
 * SOLO si no existen, tomando como referencia los valores actuales de .env.
 * Nunca sobrescribe una configuración existente. Solo usa INSERT (pharma_app).
 */

const { config, validateConfig } = require('../src/config/env');
const { withTransaction, closePool } = require('../src/config/database');
const auditRepository = require('../src/repositories/audit.repository');

const SETTINGS = [
  {
    key: 'security.max_failed_logins',
    value: String(config.auth.maxFailedAttempts),
    description: 'Intentos de inicio de sesión fallidos antes del bloqueo temporal',
  },
  {
    key: 'security.lockout_minutes',
    value: String(config.auth.lockoutMinutes),
    description: 'Minutos de bloqueo temporal tras superar los intentos fallidos',
  },
];

async function seedSecuritySettings() {
  const ctx = { requestId: 'cli-settings-security', ip: '127.0.0.1', userAgent: 'pharma-plus-cli/settings:security' };
  return withTransaction(ctx, async (conn) => {
    const results = [];
    for (const s of SETTINGS) {
      const [ins] = await conn.execute(
        `INSERT INTO settings (setting_key, setting_value, value_type, description, is_editable)
         SELECT ?, ?, 'INTEGER', ?, TRUE FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = ?)`,
        [s.key, s.value, s.description, s.key],
      );
      if (ins.affectedRows === 1) {
        await auditRepository.log(conn, {
          action: 'CREATE', module: 'settings', table: 'settings', entityId: s.key,
          newValues: { setting_key: s.key, setting_value: s.value, value_type: 'INTEGER', source: 'cli' },
        });
      }
      const [[row]] = await conn.execute('SELECT setting_value FROM settings WHERE setting_key = ?', [s.key]);
      results.push({ key: s.key, value: row.setting_value, inserted: ins.affectedRows === 1 });
    }
    return results;
  });
}

if (require.main === module) {
  const problems = validateConfig({ requireAuthSecrets: false });
  if (problems.length > 0) {
    for (const p of problems) console.error(`- ${p}`);
    process.exitCode = 1;
  } else {
    seedSecuritySettings()
      .then((rows) => {
        for (const r of rows) {
          console.log(`${r.inserted ? '✔ creado   ' : '• existente'}  ${r.key} = ${r.value}`);
        }
      })
      .catch((err) => {
        console.error(`✖ No se pudo registrar la configuración: ${err.code || err.message}`);
        process.exitCode = 1;
      })
      .finally(() => closePool());
  }
}

module.exports = { seedSecuritySettings };
