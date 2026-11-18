'use strict';

// Este archivo corre en su propio proceso (node --test): se fija el proveedor antes de cargar src/.
process.env.PAYMENT_PROVIDER = 'disabled';
require('../helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert/strict');
const { config, validateConfig } = require('../../src/config/env');
const gateway = require('../../src/services/payment-gateway.service');

test('PAYMENT_PROVIDER=disabled: solo efectivo, sin simular pagos electrónicos', () => {
  assert.equal(config.payments.provider, 'disabled');
  assert.deepEqual(gateway.publicInfo(), { provider: 'disabled', mode: 'DISABLED', electronicEnabled: false, simulated: false });
  assert.doesNotThrow(() => gateway.assertMethodsAvailable(['CASH']));
  assert.throws(() => gateway.assertMethodsAvailable(['CASH', 'YAPE', 'YAPE']), (err) => {
    assert.equal(err.status ?? err.statusCode, 503);
    assert.equal(err.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
    assert.deepEqual(err.details, { methods: ['YAPE'] });
    return true;
  });
  assert.ok(!validateConfig({ requireAuthSecrets: false }).some((p) => p.startsWith('PAYMENT_PROVIDER')));
});

test('proveedor demo: pagos electrónicos simulados y marcados como tales', () => {
  const demo = gateway.PROVIDERS.demo;
  assert.equal(demo.mode, 'DEMO');
  assert.equal(demo.electronic, true);
  assert.equal(demo.simulated, true);
});
