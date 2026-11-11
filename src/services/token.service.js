'use strict';

/**
 * Token de sesión: JWT HS256 firmado, entregado solo en una cookie HttpOnly.
 * Contiene únicamente identificadores: sub = usuario, bid = sucursal, jti = sesión.
 *
 * La validez real de la sesión vive en la tabla user_sessions (guardada como
 * SHA-256 del jti). Un logout o una revocación persisten aunque Node.js se
 * reinicie: la firma del JWT es necesaria, pero no suficiente.
 */

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { config } = require('../config/env');

const ISSUER = 'pharma-plus';
const AUDIENCE = 'pharma-plus-api';

/** SHA-256 hex del identificador de sesión: lo único que se guarda en la base. */
function hashSessionId(jti) {
  return crypto.createHash('sha256').update(String(jti), 'utf8').digest('hex');
}

function issueSessionToken({ userId, branchId }) {
  const jti = crypto.randomUUID();
  const ttlSeconds = config.auth.sessionTtlMinutes * 60;
  const token = jwt.sign({ bid: branchId ?? null }, config.auth.jwtSecret, {
    algorithm: 'HS256',
    subject: String(userId),
    jwtid: jti,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ttlSeconds,
  });
  return {
    token,
    jti,
    sessionHash: hashSessionId(jti),
    ttlMinutes: config.auth.sessionTtlMinutes,
    maxAgeMs: ttlSeconds * 1000,
  };
}

/**
 * Verifica firma, emisor, audiencia y expiración (no consulta la base).
 * @returns {{userId:number, branchId:number|null, jti:string, sessionHash:string, iat:number, exp:number} | null}
 */
function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null;
  let payload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch {
    return null;
  }
  const userId = Number(payload.sub);
  if (!Number.isSafeInteger(userId) || userId <= 0 || typeof payload.jti !== 'string') return null;
  const branchId = payload.bid === null || payload.bid === undefined ? null : Number(payload.bid);
  return {
    userId,
    branchId,
    jti: payload.jti,
    sessionHash: hashSessionId(payload.jti),
    iat: payload.iat,
    exp: payload.exp,
  };
}

module.exports = { issueSessionToken, verifySessionToken, hashSessionId };
