'use strict';

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const { paginated } = require('../utils/query');
const auditRepository = require('../repositories/audit.repository');
const { categoryRepository, laboratoryRepository } = require('../repositories/named-catalog.repository');

/**
 * Servicio CRUD para catálogos con nombre (categorías y laboratorios).
 * Estas tablas no tienen triggers de auditoría: se audita explícitamente.
 */
function createNamedCatalogService({ repo, module, table, label, mapRow }) {
  const toDto = (r) => ({
    id: r.id,
    name: r.name,
    ...mapRow(r),
    isActive: Boolean(Number(r.is_active)),
    productsCount: Number(r.products_count ?? 0),
    ...(r.active_products_count !== undefined ? { activeProductsCount: Number(r.active_products_count) } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  async function list(filters, ctx) {
    return withConnection(ctx, async (conn) => {
      const { rows, total } = await repo.list(conn, filters);
      return paginated(rows.map(toDto), total, filters);
    });
  }

  async function get(id, ctx) {
    return withConnection(ctx, async (conn) => {
      const row = await repo.findById(conn, id);
      if (!row) throw AppError.notFound(`${label} no encontrado(a)`);
      return toDto(row);
    });
  }

  async function create(data, ctx) {
    return withTransaction(ctx, async (conn) => {
      if (await repo.nameTaken(conn, data.name)) throw AppError.conflict(`Ya existe ${label.toLowerCase()} con ese nombre`, 'NAME_TAKEN');
      const id = await repo.insert(conn, data);
      await auditRepository.log(conn, { action: 'CREATE', module, table, entityId: id, newValues: data });
      return toDto(await repo.findById(conn, id));
    });
  }

  async function update(id, data, ctx) {
    return withTransaction(ctx, async (conn) => {
      const before = await repo.findById(conn, id, { forUpdate: true });
      if (!before) throw AppError.notFound(`${label} no encontrado(a)`);
      if (data.name !== undefined && (await repo.nameTaken(conn, data.name, id))) {
        throw AppError.conflict(`Ya existe ${label.toLowerCase()} con ese nombre`, 'NAME_TAKEN');
      }
      await repo.update(conn, id, data);
      const old = Object.fromEntries(Object.keys(data).map((k) => [k, before[k]]));
      await auditRepository.log(conn, { action: 'UPDATE', module, table, entityId: id, oldValues: old, newValues: data });
      return toDto(await repo.findById(conn, id));
    });
  }

  async function setActive(id, isActive, ctx) {
    return withTransaction(ctx, async (conn) => {
      const before = await repo.findById(conn, id, { forUpdate: true });
      if (!before) throw AppError.notFound(`${label} no encontrado(a)`);
      await repo.update(conn, id, { is_active: isActive });
      await auditRepository.log(conn, {
        action: isActive ? 'ACTIVATE' : 'DEACTIVATE', module, table, entityId: id,
        oldValues: { is_active: Boolean(Number(before.is_active)) }, newValues: { is_active: isActive },
      });
      return toDto(await repo.findById(conn, id));
    });
  }

  /** Eliminación física solo si no tiene productos asociados; si los tiene, se desactiva. */
  async function remove(id, ctx) {
    return withTransaction(ctx, async (conn) => {
      const row = await repo.findById(conn, id, { forUpdate: true });
      if (!row) throw AppError.notFound(`${label} no encontrado(a)`);
      if (Number(row.products_count) > 0) {
        throw AppError.conflict(`${label} tiene productos asociados; desactívelo(a) en lugar de eliminarlo(a)`, 'IN_USE');
      }
      await repo.remove(conn, id);
      await auditRepository.log(conn, { action: 'DELETE', module, table, entityId: id, oldValues: { name: row.name } });
    });
  }

  return { list, get, create, update, setActive, remove };
}

const categoryService = createNamedCatalogService({
  repo: categoryRepository, module: 'products', table: 'categories', label: 'Categoría',
  mapRow: (r) => ({ description: r.description, imageUrl: r.image_url }),
});

const laboratoryService = createNamedCatalogService({
  repo: laboratoryRepository, module: 'products', table: 'laboratories', label: 'Laboratorio',
  mapRow: (r) => ({ country: r.country }),
});

module.exports = { categoryService, laboratoryService };
