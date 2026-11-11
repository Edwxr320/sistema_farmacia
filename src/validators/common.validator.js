'use strict';

const { z } = require('zod');
const { todayLima } = require('../utils/dates');

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const idParam = z.object({ id });

/** Texto opcional: '' o null se guardan como NULL. */
function optionalText(max) {
  return z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null ? null : v.trim() === '' ? null : v.trim()))
    .refine((v) => v === undefined || v === null || v.length <= max, `Máximo ${max} caracteres`);
}

function requiredText(max, label) {
  return z.string({ error: `${label} es obligatorio` }).trim().min(1, `${label} es obligatorio`).max(max, `${label}: máximo ${max} caracteres`);
}

/**
 * Importe DECIMAL como TEXTO normalizado ('12.50'): nunca se opera con float en JS.
 * @param {number} intDigits dígitos enteros permitidos (DECIMAL(10,2) → 8)
 */
function money(intDigits = 8) {
  const re = new RegExp(`^\\d{1,${intDigits}}(\\.\\d{1,2})?$`);
  return z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => re.test(v), 'Importe inválido: use un número positivo con hasta 2 decimales')
    .transform((v) => {
      const [i, d = ''] = v.split('.');
      return `${i.replace(/^0+(?=\d)/, '')}.${d.padEnd(2, '0')}`;
    });
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Fecha inexistente');

const futureDate = isoDate.refine((v) => v > todayLima(), 'La fecha de vencimiento debe ser posterior a hoy');

const boolish = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform((v) => v === true || v === 'true' || v === '1');

const pagination = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

const searchTerm = z.string().trim().min(1).max(100).optional();

/** RUC peruano: 11 dígitos, prefijo válido y dígito verificador SUNAT. */
function isValidRuc(ruc) {
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(ruc[i]), 0);
  const r = 11 - (sum % 11);
  const check = r === 10 ? 0 : r === 11 ? 1 : r;
  return check === Number(ruc[10]);
}

module.exports = {
  z, id, idParam, optionalText, requiredText, money, isoDate, futureDate, boolish, pagination, searchTerm, isValidRuc,
};
