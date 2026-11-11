'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const { toCents, fromCents, percentOf, allocateProportionally } = require('../../src/utils/money');
const { planPayments } = require('../../src/services/sale.service');

test('céntimos enteros sin errores de float', () => {
  assert.equal(toCents('0.10') + toCents('0.20'), 30); // 0.1 + 0.2 en float sería 0.30000000000000004
  assert.equal(fromCents(toCents('0.10') + toCents('0.20')), '0.30');
  assert.equal(toCents('12.5'), 1250);
  assert.equal(fromCents(5), '0.05');
  assert.equal(fromCents(123456789), '1234567.89');
  assert.throws(() => toCents('1.234'));
  assert.throws(() => toCents('abc'));
});

test('porcentaje redondeado al céntimo y reparto proporcional exacto', () => {
  assert.equal(percentOf(1300, '10'), 130);
  assert.equal(percentOf(999, '12.5'), 125); // 124.875 → 125
  const parts = allocateProportionally(100, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(parts, [34, 33, 33]);
  assert.deepEqual(allocateProportionally(130, [1100, 200]), [110, 20]);
  assert.deepEqual(allocateProportionally(0, [5, 5]), [0, 0]);
});

test('plan de pagos: total exacto, vuelto y simulación', () => {
  const plan = planPayments([{ method: 'CASH', tenderedAmount: '20.00' }], 1100);
  assert.equal(plan[0].changeCents, 900);
  const split = planPayments([{ method: 'CASH', amount: '10.00' }, { method: 'CARD', amount: '12.00', simulate: 'REJECT' }], 2200);
  assert.deepEqual(split.map((p) => p.outcome), ['APPROVE', 'REJECT']);
  assert.throws(() => planPayments([{ method: 'CARD', amount: '10.00' }], 1100), (e) => e.code === 'PAYMENT_TOTAL_MISMATCH');
  assert.throws(() => planPayments([{ method: 'CASH', tenderedAmount: '5.00' }], 1100), (e) => e.code === 'INSUFFICIENT_TENDERED');
});
