'use strict';

require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const { msUntilNextLimaTime, todayLima } = require('../../src/utils/dates');
const { allocateFefo } = require('../../src/services/inventory.service');
const { isValidRuc, money } = require('../../src/validators/common.validator');
const { detectImageType } = require('../../src/utils/image-storage');
const { likeContains } = require('../../src/utils/query');

test('tarea diaria: próxima ejecución a las 06:00 hora de Lima (UTC-5)', () => {
  // 2026-11-08 10:00 UTC = 05:00 Lima → faltan 60 min
  assert.equal(msUntilNextLimaTime(6, 0, Date.UTC(2026, 10, 8, 10, 0)), 60 * 60 * 1000);
  // 11:00 UTC = 06:00 Lima exacto → siguiente día
  assert.equal(msUntilNextLimaTime(6, 0, Date.UTC(2026, 10, 8, 11, 0)), 24 * 60 * 60 * 1000);
  // 04:30 UTC = 23:30 Lima del día anterior → faltan 6.5 h
  assert.equal(msUntilNextLimaTime(6, 0, Date.UTC(2026, 10, 9, 4, 30)), 6.5 * 60 * 60 * 1000);
  assert.equal(todayLima(Date.UTC(2026, 10, 9, 4, 30)), '2026-11-08');
});

test('reparto FEFO', () => {
  const batches = [
    { batch_id: 1, current_quantity: 5 },
    { batch_id: 2, current_quantity: 10 },
    { batch_id: 3, current_quantity: 4 },
  ];
  assert.deepEqual(allocateFefo(batches, 12).allocations.map((a) => [a.batchId, a.quantity]), [[1, 5], [2, 7]]);
  assert.equal(allocateFefo(batches, 30).shortfall, 11);
  assert.deepEqual(allocateFefo([], 1).allocations, []);
});

test('RUC con dígito verificador SUNAT', () => {
  assert.equal(isValidRuc('20100070970'), true);
  assert.equal(isValidRuc('20100070971'), false);
  assert.equal(isValidRuc('30100070970'), false);
  assert.equal(isValidRuc('2010007097'), false);
});

test('importes DECIMAL normalizados como texto (sin float)', () => {
  const m = money(8);
  assert.equal(m.parse(0.5), '0.50');
  assert.equal(m.parse('007.1'), '7.10');
  assert.equal(m.parse('12'), '12.00');
  assert.equal(m.safeParse('1.234').success, false);
  assert.equal(m.safeParse('-1').success, false);
  assert.equal(m.safeParse('1e3').success, false);
  assert.equal(m.safeParse('123456789').success, false, 'excede DECIMAL(10,2)');
});

test('detección de imagen por firma binaria y escape de LIKE', () => {
  assert.equal(detectImageType(Buffer.from('ffd8ffe000104a46494600010101', 'hex')).ext, 'jpg');
  assert.equal(detectImageType(Buffer.from('89504e470d0a1a0a0000000d', 'hex')).ext, 'png');
  assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary')).ext, 'webp');
  assert.equal(detectImageType(Buffer.from('<?php echo 1; ?>xxxx')), null);
  assert.equal(likeContains('50%_a\\'), '%50\\%\\_a\\\\%');
});
