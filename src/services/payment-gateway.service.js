'use strict';

/**
 * Pasarela de pagos electrónicos (tarjeta, transferencia, Yape, Plin).
 *
 * Pharma Plus NO tiene credenciales de una pasarela real. Proveedores admitidos (PAYMENT_PROVIDER):
 *   - demo     (por defecto): pagos SIMULADOS. Se registran con is_simulated = 1, referencia DEMO-… y la base
 *              (trigger trg_payments_bi + setting payments.mode = 'DEMO') impide guardar un pago electrónico real.
 *   - disabled: solo efectivo. Cualquier pago electrónico se rechaza con 503 PAYMENT_GATEWAY_UNAVAILABLE antes de
 *              crear el pedido o la venta (no se registra nada).
 *
 * Para integrar una pasarela real (Niubiz, Culqi, Mercado Pago, Izipay…) hace falta: sus credenciales, un
 * proveedor nuevo en este módulo que cree la intención de pago y verifique el webhook firmado, y cambiar
 * payments.mode en la base. Nunca se solicitan ni guardan datos de tarjeta en Pharma Plus.
 */

const { config } = require('../config/env');
const { AppError } = require('../utils/app-error');

const PROVIDERS = Object.freeze({
  demo: { mode: 'DEMO', electronic: true, simulated: true },
  disabled: { mode: 'DISABLED', electronic: false, simulated: false },
});

function provider() {
  return PROVIDERS[config.payments.provider] || PROVIDERS.disabled;
}

/** Estado público (sin secretos) para la tienda y el POS. */
function publicInfo() {
  const p = provider();
  return { provider: config.payments.provider, mode: p.mode, electronicEnabled: p.electronic, simulated: p.simulated };
}

/** Lanza 503 si se intenta un pago electrónico y no hay proveedor que lo procese. */
function assertMethodsAvailable(methods) {
  if (provider().electronic) return;
  const electronic = [...new Set(methods.filter((m) => m !== 'CASH'))];
  if (electronic.length > 0) {
    throw new AppError(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Los pagos electrónicos no están habilitados: pague en efectivo', { methods: electronic });
  }
}

module.exports = { PROVIDERS, publicInfo, assertMethodsAvailable };
