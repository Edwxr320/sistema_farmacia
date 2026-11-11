/**
 * Rutas de retorno del acceso único (?next=...). Funciones puras (se prueban con Node).
 * Solo se aceptan rutas internas de esta misma aplicación: nunca URLs absolutas, "//dominio", "\" ni esquemas.
 * El personal solo vuelve a /admin/*; un cliente solo vuelve a rutas de la tienda.
 */

const BASE = 'http://pharma.invalid';

/** Normaliza una ruta interna o devuelve null si no es segura. Acepta el formato antiguo sin "/" (p. ej. "carrito"). */
export function internalPath(raw) {
  if (typeof raw !== 'string') return null;
  let n = raw.trim();
  if (!n || n.length > 512) return null;
  if (/[\u0000-\u001f\\]/.test(n)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(n)) return null; // http:, javascript:, data:…
  if (!n.startsWith('/')) n = `/${n}`;
  if (n.startsWith('//')) return null;
  let u;
  try { u = new URL(n, BASE); } catch { return null; }
  if (u.origin !== BASE) return null;
  return `${u.pathname}${u.search}`;
}

export const isAdminPath = (p) => /^\/admin(\/|$|\?)/.test(p);
const isAccessPath = (p) => /^\/(acceso|ingresar|registro)(\/|$|\?)/.test(p);

/** Ruta de retorno válida para el tipo de cuenta, o null. */
export function safeNext(raw, accountType) {
  const p = internalPath(raw);
  if (!p || isAccessPath(p)) return null;
  if (accountType === 'STAFF') return isAdminPath(p) ? p : null;
  if (accountType === 'CUSTOMER') return isAdminPath(p) ? null : p;
  return p;
}

/** Destino tras identificarse: la ruta solicitada si corresponde a su tipo de cuenta, o su inicio. */
export function destinationFor(accountType, raw) {
  return safeNext(raw, accountType) || (accountType === 'STAFF' ? '/admin' : '/');
}

/** /acceso con la ruta de retorno (si es interna). */
export function accessUrl(next) {
  const p = internalPath(next);
  return p && !isAccessPath(p) && p !== '/' ? `/acceso?next=${encodeURIComponent(p)}` : '/acceso';
}
