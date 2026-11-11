'use strict';

/**
 * Proveedor de conexiones para pruebas de integración contra la base REAL.
 *
 * Todas las operaciones de la aplicación usan UNA conexión real dentro de una
 * transacción externa que se revierte al terminar: los usuarios y registros de
 * auditoría creados por las pruebas nunca quedan en pharma_plus.
 * Las transacciones internas de la aplicación se convierten en SAVEPOINTs.
 *
 * Nota: AUTO_INCREMENT no se revierte en InnoDB (quedan huecos en los ids).
 */

const { getPool, setConnectionProvider, resetConnectionProvider } = require('../../src/config/database');

async function startTransactionalDb() {
  const conn = await getPool().getConnection();
  await conn.beginTransaction();
  let depth = 0;

  const proxy = new Proxy(conn, {
    get(target, prop) {
      switch (prop) {
        case 'release':
        case 'destroy':
          return () => {};
        case 'beginTransaction':
          return async () => {
            depth += 1;
            await target.query(`SAVEPOINT pp_test_${depth}`);
          };
        case 'commit':
          return async () => {
            await target.query(`RELEASE SAVEPOINT pp_test_${depth}`);
            depth -= 1;
          };
        case 'rollback':
          return async () => {
            await target.query(`ROLLBACK TO SAVEPOINT pp_test_${depth}`);
            await target.query(`RELEASE SAVEPOINT pp_test_${depth}`);
            depth -= 1;
          };
        default: {
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      }
    },
  });

  setConnectionProvider({ getConnection: async () => proxy });

  return {
    conn: proxy,
    async rollbackAll() {
      resetConnectionProvider();
      try {
        await conn.rollback();
      } finally {
        conn.release();
      }
    },
  };
}

module.exports = { startTransactionalDb };
