'use strict';

/**
 * Importes en CÉNTIMOS enteros. Nunca se usa aritmética float para dinero.
 * MariaDB devuelve DECIMAL como texto ('12.50'); aquí se convierte a 1250 y de vuelta.
 */

function toCents(value) {
  if (value === null || value === undefined) return 0;
  const s = String(value).trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Importe inválido: ${s}`);
  const cents = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('Importe fuera de rango');
  return m[1] ? -cents : cents;
}

function fromCents(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Porcentaje (hasta 2 decimales) de un importe, redondeado al céntimo (half up). */
function percentOf(cents, percent) {
  const basisPoints = toCents(percent); // 12.5 % → 1250 puntos básicos
  return Math.floor((cents * basisPoints + 5000) / 10000);
}

/**
 * Reparte un importe entre partes proporcionalmente a sus pesos (método del mayor resto).
 * La suma del reparto es exactamente el total.
 */
function allocateProportionally(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || totalCents === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sum);
  const floors = raw.map(Math.floor);
  let rest = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors;
}

module.exports = { toCents, fromCents, percentOf, allocateProportionally };
