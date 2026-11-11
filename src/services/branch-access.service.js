'use strict';

const { AppError } = require('../utils/app-error');

/**
 * Acceso por sucursal:
 * - Con permiso branches.manage (administración) se accede a cualquier sucursal activa.
 * - El resto, solo a las sucursales asignadas en user_branches (cargadas en req.auth).
 */
function canAccessAllBranches(auth) {
  return auth.permissions.has('branches.manage');
}

/**
 * Devuelve la sucursal a usar: la pedida (validando acceso) o la activa de la sesión.
 * @param {object} auth req.auth
 * @param {number|undefined|null} requested
 * @param {{ conn?: object }} [opts] si se pasa conn, verifica que la sucursal exista y esté activa
 */
async function resolveBranch(auth, requested, { conn } = {}) {
  const branchId = requested ?? auth.branchId;
  if (!branchId) throw AppError.badRequest('Debe indicar la sucursal (branchId)');

  if (!canAccessAllBranches(auth) && !auth.branches.some((b) => b.id === Number(branchId))) {
    throw AppError.forbidden('No tiene acceso a esa sucursal', 'BRANCH_FORBIDDEN');
  }
  if (conn) {
    const [rows] = await conn.execute("SELECT id FROM branches WHERE id = ? AND status = 'ACTIVE'", [branchId]);
    if (rows.length === 0) throw AppError.notFound('Sucursal no encontrada o inactiva');
    await bindOperationBranch(conn, branchId);
  }
  return Number(branchId);
}

/**
 * La auditoría (sp_audit, triggers) toma la sucursal de @app_branch_id. Cuando un usuario opera en
 * una sucursal distinta de la de su sesión (p. ej. ADMIN), se fija la sucursal de la OPERACIÓN en
 * esta misma conexión para que los registros queden con la sucursal correcta.
 */
async function bindOperationBranch(conn, branchId) {
  await conn.query('SET @app_branch_id = ?', [Number(branchId)]);
}

/** Verifica el acceso y, si se pasa la conexión, fija la sucursal de la operación para la auditoría. */
async function assertBranchAccessInTx(conn, auth, branchId) {
  assertBranchAccess(auth, branchId);
  await bindOperationBranch(conn, branchId);
}

/** Lista de sucursales visibles para filtros (null = todas). */
function visibleBranchIds(auth) {
  return canAccessAllBranches(auth) ? null : auth.branches.map((b) => b.id);
}

/** Verifica el acceso a la sucursal de un registro ya leído. */
function assertBranchAccess(auth, branchId) {
  if (!canAccessAllBranches(auth) && !auth.branches.some((b) => b.id === Number(branchId))) {
    throw AppError.forbidden('No tiene acceso a esa sucursal', 'BRANCH_FORBIDDEN');
  }
}

module.exports = {
  resolveBranch, visibleBranchIds, assertBranchAccess, assertBranchAccessInTx, bindOperationBranch, canAccessAllBranches,
};
