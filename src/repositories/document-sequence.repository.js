'use strict';

const TYPES = new Set(['SALE', 'TICKET', 'ORDER', 'STOCK_ENTRY', 'TRANSFER', 'RETURN', 'ADJUSTMENT', 'CASH_SESSION', 'PAYMENT']);

/**
 * Siguiente número de documento con sp_next_document_number (bloquea la secuencia con FOR UPDATE).
 * Debe ejecutarse DENTRO de la transacción del documento.
 */
async function nextNumber(conn, branchId, documentType) {
  if (!TYPES.has(documentType)) throw new Error(`Tipo de documento inválido: ${documentType}`);
  await conn.query('CALL sp_next_document_number(?, ?, @pp_doc_number)', [branchId, documentType]);
  const [[row]] = await conn.query('SELECT @pp_doc_number AS n');
  await conn.query('SET @pp_doc_number = NULL');
  return row.n;
}

module.exports = { nextNumber };
