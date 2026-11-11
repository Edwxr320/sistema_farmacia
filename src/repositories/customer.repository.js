'use strict';

/** Clientes de la tienda (customers enlazado a users con rol CUSTOMER) y sus direcciones. */

async function insertCustomer(conn, c) {
  const [res] = await conn.execute(
    `INSERT INTO customers (user_id, full_name, document_type, document_number, phone, email, birth_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [c.userId, c.fullName, c.documentType ?? null, c.documentNumber ?? null, c.phone ?? null, c.email, c.birthDate ?? null],
  );
  return res.insertId;
}

async function findByUserId(conn, userId, { forUpdate = false } = {}) {
  const [rows] = await conn.execute(
    `SELECT id, user_id, full_name, document_type, document_number, phone, email, birth_date, is_active, created_at
       FROM customers WHERE user_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  return rows[0] || null;
}

async function documentTaken(conn, documentType, documentNumber, excludeId = null) {
  if (!documentType || !documentNumber) return false;
  const [rows] = await conn.execute(
    'SELECT id FROM customers WHERE document_type = ? AND document_number = ? AND (? IS NULL OR id <> ?) LIMIT 1',
    [documentType, documentNumber, excludeId, excludeId],
  );
  return rows.length > 0;
}

const PROFILE_COLUMNS = ['full_name', 'document_type', 'document_number', 'phone', 'birth_date'];

async function updateProfile(conn, id, data) {
  const cols = PROFILE_COLUMNS.filter((c) => data[c] !== undefined);
  if (cols.length === 0) return 0;
  const [res] = await conn.execute(`UPDATE customers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...cols.map((c) => data[c]), id,
  ]);
  return res.affectedRows;
}

// ---------------------------------------------------------------- direcciones
const ADDRESS_COLUMNS = ['label', 'recipient_name', 'phone', 'address_line', 'reference_note', 'district', 'province', 'department', 'latitude', 'longitude'];

async function listAddresses(conn, customerId) {
  const [rows] = await conn.execute(
    'SELECT * FROM customer_addresses WHERE customer_id = ? AND is_active = TRUE ORDER BY is_default DESC, id',
    [customerId],
  );
  return rows;
}

async function findAddress(conn, customerId, id, { forUpdate = false } = {}) {
  const [rows] = await conn.execute(
    `SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ? AND is_active = TRUE ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id, customerId],
  );
  return rows[0] || null;
}

async function clearDefault(conn, customerId) {
  await conn.execute('UPDATE customer_addresses SET is_default = FALSE WHERE customer_id = ? AND is_default = TRUE', [customerId]);
}

async function insertAddress(conn, customerId, data) {
  const cols = ADDRESS_COLUMNS.filter((c) => data[c] !== undefined);
  const [res] = await conn.execute(
    `INSERT INTO customer_addresses (customer_id, ${cols.join(', ')}, is_default) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
    [customerId, ...cols.map((c) => data[c]), data.is_default ? 1 : 0],
  );
  return res.insertId;
}

async function updateAddress(conn, id, data) {
  const cols = [...ADDRESS_COLUMNS, 'is_default'].filter((c) => data[c] !== undefined);
  if (cols.length === 0) return 0;
  const [res] = await conn.execute(`UPDATE customer_addresses SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...cols.map((c) => (c === 'is_default' ? (data[c] ? 1 : 0) : data[c])), id,
  ]);
  return res.affectedRows;
}

/** Baja lógica: los pedidos conservan la referencia y su copia de la dirección. */
async function deactivateAddress(conn, id) {
  await conn.execute('UPDATE customer_addresses SET is_active = FALSE, is_default = FALSE WHERE id = ?', [id]);
}

module.exports = {
  insertCustomer, findByUserId, documentTaken, updateProfile, listAddresses, findAddress, clearDefault, insertAddress,
  updateAddress, deactivateAddress,
};
