'use strict';

/**
 * Notificaciones en tiempo real con Socket.IO.
 *
 * - Autenticación con la MISMA cookie HttpOnly de sesión (JWT + user_sessions + estado del usuario).
 * - Cada socket entra solo a las salas de sus sucursales: `branch:<id>`. Quien tiene
 *   branches.manage entra además a `branches:all`.
 * - Los servicios llaman a emitToBranch() DESPUÉS del COMMIT: nunca se notifica un cambio revertido.
 * - Las cargas útiles solo llevan identificadores y totales (sin datos personales).
 * - Si Socket.IO no está inicializado (pruebas, scripts), las emisiones no hacen nada.
 */

const { Server } = require('socket.io');
const { config } = require('../config/env');
const { logger } = require('../config/logger');
const { SESSION_COOKIE } = require('../utils/cookies');
const tokenService = require('./token.service');

let io = null;
const listeners = new Set(); // para pruebas: (room, event, payload) => void

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function originAllowed(origin, host) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === host || config.allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

/** Inicializa Socket.IO sobre el servidor HTTP de Express. */
function initRealtime(httpServer) {
  const authService = require('./auth.service'); // evita dependencia circular al cargar
  io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    cors: { origin: false },
    allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin, req.headers.host)),
  });

  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
      const claims = token ? tokenService.verifySessionToken(token) : null;
      if (!claims) return next(new Error('AUTH_REQUIRED'));
      const session = await authService.loadSession(claims, {
        requestId: `ws-${socket.id}`.slice(0, 64),
        ip: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent'],
      });
      if (!session) return next(new Error('AUTH_REQUIRED'));
      socket.data.userId = claims.userId;
      socket.data.branchIds = session.branches.map((b) => b.id);
      socket.data.allBranches = session.permissions.includes('branches.manage');
      return next();
    } catch (err) {
      logger.warn({ code: err.code }, 'Rechazo de conexión Socket.IO');
      return next(new Error('AUTH_REQUIRED'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`); // avisos personales (p. ej. estado de los pedidos de un cliente)
    for (const id of socket.data.branchIds) socket.join(`branch:${id}`);
    if (socket.data.allBranches) socket.join('branches:all');
    socket.emit('ready', { branches: socket.data.branchIds });
  });

  logger.info('Socket.IO inicializado');
  return io;
}

/**
 * Notifica a los usuarios de una sucursal (y a la administración).
 * Llamar SOLO después de confirmar la transacción.
 */
function emitToBranch(branchId, event, payload = {}) {
  const message = { ...payload, branchId, at: new Date().toISOString() };
  for (const l of listeners) l(`branch:${branchId}`, event, message);
  if (!io) return;
  io.to(`branch:${branchId}`).to('branches:all').emit(event, message);
}

/**
 * Cambio de existencias: los triggers pueden haber creado o resuelto alertas en la misma
 * transacción, así que se notifica también alerts:changed.
 */
function emitInventoryChanged(branchId, payload) {
  emitToBranch(branchId, 'inventory:changed', payload);
  emitToBranch(branchId, 'alerts:changed', { source: payload.source });
}

/** Aviso a un usuario concreto (todas sus pestañas abiertas). */
function emitToUser(userId, event, payload = {}) {
  const message = { ...payload, at: new Date().toISOString() };
  for (const l of listeners) l(`user:${userId}`, event, message);
  if (io) io.to(`user:${userId}`).emit(event, message);
}

function onEmit(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function closeRealtime() {
  if (io) {
    const s = io;
    io = null;
    await new Promise((resolve) => s.close(() => resolve()));
  }
}

module.exports = { initRealtime, emitToBranch, emitToUser, emitInventoryChanged, onEmit, closeRealtime, parseCookies };
