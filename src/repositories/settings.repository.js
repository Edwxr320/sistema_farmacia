'use strict';

/** Lee varias claves de settings. Devuelve un objeto { clave: valor_texto }. */
async function getValues(conn, keys) {
  if (keys.length === 0) return {};
  const placeholders = keys.map(() => '?').join(', ');
  const [rows] = await conn.execute(
    `SELECT setting_key, setting_value, value_type FROM settings WHERE setting_key IN (${placeholders})`,
    keys,
  );
  return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
}

module.exports = { getValues };
