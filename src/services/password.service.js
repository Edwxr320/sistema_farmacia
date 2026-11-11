'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { config } = require('../config/env');

let dummyHashPromise = null;

/** Hash bcrypt ($2b$, costo configurable >= 12 recomendado). */
async function hashPassword(plain) {
  return bcrypt.hash(plain, config.auth.bcryptCost);
}

async function verifyPassword(plain, hash) {
  if (typeof hash !== 'string' || !hash.startsWith('$2')) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Compara contra un hash aleatorio para que la respuesta a un correo
 * inexistente tarde lo mismo que la de un correo existente.
 */
async function consumeDummyVerification(plain) {
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash(crypto.randomBytes(24).toString('base64'), config.auth.bcryptCost);
  }
  await bcrypt.compare(plain, await dummyHashPromise);
  return false;
}

module.exports = { hashPassword, verifyPassword, consumeDummyVerification };
