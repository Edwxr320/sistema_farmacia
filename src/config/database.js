'use strict';

/**
 * Acceso a MariaDB con mysql2/promise.
 *
 * - Un único pool reutilizable por proceso.
 * - Cada conexión física nueva se inicializa con la collation, la zona horaria
 *   y el sql_mode que exige la base pharma_plus.
 * - Toda operación obtiene una conexión del pool, fija el contexto de la
 *   petición con sp_set_app_context EN ESA MISMA CONEXIÓN, ejecuta y, al
 *   terminar, limpia el contexto antes de devolverla. Las variables de sesión
 *   (@app_user_id, ...) viven en la conexión, no en la petición: una conexión
 *   reutilizada nunca debe arrastrar el usuario de la petición anterior.
 */

const mysql = require('mysql2/promise');
const { config } = require('./env');
const { logger } = require('./logger');

const SESSION_SQL_MODE =
  'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION';

// Sentencias que se ejecutan una vez por cada conexión física.
const SESSION_INIT_STATEMENTS = [
  'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci',
  "SET time_zone = '-05:00'",
  `SET SESSION sql_mode = '${SESSION_SQL_MODE}'`,
];

const DEADLOCK_ERRNOS = new Set([1213, 1205]);

let pool = null;
let provider = null;

function createPool() {
  const p = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: 'UTF8MB4_UNICODE_CI',
    timezone: '-05:00', // hora de Lima (sin horario de verano)
    dateStrings: ['DATE'], // fechas de vencimiento como 'YYYY-MM-DD', sin desfases
    decimalNumbers: false, // DECIMAL llega como texto: no se pierde precisión monetaria
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false, // una sentencia por llamada: reduce el impacto de una inyección
    connectionLimit: config.db.connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });

  // 'connection' se emite una vez por conexión física nueva (API de callbacks).
  // Las consultas se encolan en orden, así que se ejecutan antes que cualquier
  // consulta de la aplicación sobre esa conexión.
  p.pool.on('connection', (conn) => {
    for (const sql of SESSION_INIT_STATEMENTS) {
      conn.query(sql, (err) => {
        if (err) {
          logger.error({ errno: err.errno, code: err.code }, 'No se pudo inicializar la sesión MariaDB');
          conn.destroy();
        }
      });
    }
  });

  return p;
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

/** Proveedor de conexiones por defecto: el pool. Las pruebas pueden sustituirlo. */
function defaultProvider() {
  return {
    getConnection: () => getPool().getConnection(),
  };
}

function getProvider() {
  if (!provider) provider = defaultProvider();
  return provider;
}

function setConnectionProvider(p) {
  provider = p;
}

function resetConnectionProvider() {
  provider = null;
}

function truncate(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Fija el contexto de auditoría en la conexión indicada.
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {{userId?:number|null, branchId?:number|null, requestId?:string|null, ip?:string|null,
 *          userAgent?:string|null, sessionRef?:string|null}} ctx
 */
async function applyContext(conn, ctx = {}) {
  await conn.query('CALL sp_set_app_context(?, ?, ?, ?)', [
    ctx.userId ?? null,
    ctx.branchId ?? null,
    truncate(ctx.requestId, 64),
    truncate(ctx.ip, 45),
  ]);
  // sp_set_app_context no recibe estos dos valores; sp_audit sí los lee.
  await conn.query('SET @app_user_agent = ?, @app_session_ref = ?', [
    truncate(ctx.userAgent, 255),
    truncate(ctx.sessionRef, 64),
  ]);
}

async function clearContext(conn) {
  await conn.query('CALL sp_set_app_context(NULL, NULL, NULL, NULL)');
  await conn.query('SET @app_user_agent = NULL, @app_session_ref = NULL');
}

/**
 * Obtiene una conexión, aplica el contexto y la libera siempre.
 * @template T
 * @param {object} ctx contexto de la petición (ver applyContext)
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withConnection(ctx, fn) {
  const conn = await getProvider().getConnection();
  let healthy = true;
  try {
    await applyContext(conn, ctx);
    return await fn(conn);
  } finally {
    try {
      await clearContext(conn);
    } catch {
      healthy = false;
    }
    if (healthy) {
      conn.release();
    } else {
      // Si no se pudo limpiar el contexto, la conexión no vuelve al pool.
      conn.destroy();
    }
  }
}

/**
 * Ejecuta fn dentro de una transacción en una sola conexión con contexto.
 * Reintenta la transacción completa ante deadlock (1213) o espera de bloqueo (1205).
 * @template T
 * @param {object} ctx
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<T>} fn
 * @param {{ retries?: number, lock?: { name: string, timeoutSeconds?: number } }} [opts]
 *   lock: bloqueo con nombre (GET_LOCK) tomado ANTES del BEGIN y liberado DESPUÉS del
 *   COMMIT/ROLLBACK en la misma conexión: serializa operaciones que deben ver lo que la
 *   anterior confirmó (p. ej. idempotencia).
 * @returns {Promise<T>}
 */
async function withTransaction(ctx, fn, { retries = 2, lock = null } = {}) {
  if (lock) {
    return withConnection(ctx, async (conn) => {
      const [[row]] = await conn.query('SELECT GET_LOCK(?, ?) AS ok', [lock.name, lock.timeoutSeconds ?? 10]);
      if (Number(row.ok) !== 1) {
        const err = new Error('No se obtuvo el bloqueo de la operación');
        err.code = 'LOCK_TIMEOUT';
        throw err;
      }
      try {
        return await runTransaction(conn, fn, retries);
      } finally {
        await conn.query('SELECT RELEASE_LOCK(?)', [lock.name]).catch(() => {});
      }
    });
  }
  return withConnection(ctx, (conn) => runTransaction(conn, fn, retries));
}

/** BEGIN → fn → COMMIT; ROLLBACK ante error y reintento completo ante deadlock / espera de bloqueo. */
async function runTransaction(conn, fn, retries) {
  for (let attempt = 0; ; attempt += 1) {
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch (rbErr) {
        logger.error({ errno: rbErr.errno, code: rbErr.code }, 'Fallo al revertir la transacción');
      }
      if (DEADLOCK_ERRNOS.has(err.errno) && attempt < retries) {
        logger.warn({ errno: err.errno, attempt: attempt + 1 }, 'Transacción reintentada por bloqueo');
        continue;
      }
      throw err;
    }
  }
}

/** Cierra el pool de forma ordenada (espera a que terminen las consultas en curso). */
async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = {
  getPool,
  withConnection,
  withTransaction,
  applyContext,
  clearContext,
  closePool,
  setConnectionProvider,
  resetConnectionProvider,
  SESSION_SQL_MODE,
};
