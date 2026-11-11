/**
 * Visibilidad de menús y acciones según los permisos efectivos que devuelve el servidor
 * (/api/auth/me). Es solo una ayuda de interfaz: cada endpoint vuelve a validar en el backend.
 */

export function hasAll(perms, codes = []) {
  const set = perms instanceof Set ? perms : new Set(perms || []);
  return codes.every((c) => set.has(c));
}

export function hasAny(perms, codes = []) {
  if (!codes.length) return true;
  const set = perms instanceof Set ? perms : new Set(perms || []);
  return codes.some((c) => set.has(c));
}

/** Filtra una navegación [{ items: [{ any: [...] , all: [...] }] }] dejando solo lo permitido. */
export function filterNav(groups, perms) {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => hasAny(perms, i.any || []) && hasAll(perms, i.all || [])) }))
    .filter((g) => g.items.length > 0);
}

/** Primera ruta accesible (redirección tras el login según permisos). */
export function firstRoute(groups, perms) {
  const nav = filterNav(groups, perms);
  return nav.length ? nav[0].items[0].route : null;
}
