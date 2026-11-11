'use strict';

/** Escapa comodines de LIKE para búsquedas literales. */
function likeContains(term) {
  return `%${String(term).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Construye WHERE dinámico solo con placeholders (los valores nunca se interpolan). */
class WhereBuilder {
  constructor() {
    this.clauses = [];
    this.params = [];
  }

  add(clause, ...params) {
    this.clauses.push(clause);
    this.params.push(...params);
    return this;
  }

  addIf(condition, clause, ...params) {
    if (condition) this.add(clause, ...params);
    return this;
  }

  toSql() {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

/** LIMIT/OFFSET como texto: mysql2.execute con MariaDB los acepta así sin ambigüedad de tipos. */
function pageParams({ page, pageSize }) {
  return [String(pageSize), String((page - 1) * pageSize)];
}

function paginated(rows, total, { page, pageSize }) {
  return { data: rows, pagination: { page, pageSize, total: Number(total), totalPages: Math.ceil(Number(total) / pageSize) } };
}

/** Convierte 0/1 de MariaDB a boolean en las claves indicadas. */
function toBooleans(row, keys) {
  if (!row) return row;
  const out = { ...row };
  for (const k of keys) if (k in out && out[k] !== null) out[k] = Boolean(Number(out[k]));
  return out;
}

module.exports = { likeContains, WhereBuilder, pageParams, paginated, toBooleans };
