/**
 * Pharma Plus — cliente de la API (ES module).
 *
 * - La sesión viaja en la cookie HttpOnly `pp_session`: este código nunca la ve ni la guarda
 *   (no se usa localStorage para credenciales).
 * - POST/PUT/PATCH/DELETE envían `X-CSRF-Token` con el valor de la cookie `pp_csrf`.
 * - GET idénticos simultáneos comparten la misma petición (evita duplicados).
 * - 401 → avisa a los suscriptores (sesión expirada). 403 CSRF → renueva el token y reintenta una vez.
 */

import { buildQuery } from './format.js';

const BASE = '/api';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const inflight = new Map();
const unauthorizedListeners = new Set();

export class ApiError extends Error {
  constructor(status, payload) {
    const e = payload && payload.error;
    super((e && e.message) || (status === 0 ? 'No hay conexión con el servidor' : 'Error de comunicación'));
    this.status = status;
    this.code = e && e.code;
    this.details = e && e.details;
    this.requestId = e && e.requestId;
  }
}

function readCookie(name) {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function freshCsrf() {
  const res = await fetch(`${BASE}/auth/csrf-token`, { credentials: 'same-origin', cache: 'no-store' });
  const body = await res.json();
  return body.csrfToken;
}

async function csrfToken() {
  return readCookie('pp_csrf') || freshCsrf();
}

async function send(method, path, { body, query, headers = {}, form } = {}, retried = false) {
  const url = `${BASE}${path}${buildQuery(query)}`;
  const opts = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...headers } };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (UNSAFE.has(method)) opts.headers['X-CSRF-Token'] = await csrfToken();

  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, null);
  }
  const payload = res.status === 204 ? null : await res.json().catch(() => null);

  if (res.status === 403 && payload?.error?.code === 'CSRF_INVALID' && !retried) {
    await freshCsrf();
    return send(method, path, { body, query, headers, form }, true);
  }
  if (res.status === 401 && !path.startsWith('/auth/') && !path.startsWith('/store/auth/')) {
    for (const fn of unauthorizedListeners) fn();
  }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

function get(path, query) {
  const key = `${path}${buildQuery(query)}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = send('GET', path, { query }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const api = {
  ApiError,
  get,
  post: (path, body, opts = {}) => send('POST', path, { body, ...opts }),
  put: (path, body, opts = {}) => send('PUT', path, { body, ...opts }),
  patch: (path, body, opts = {}) => send('PATCH', path, { body, ...opts }),
  del: (path, opts = {}) => send('DELETE', path, opts),
  /** Subida multipart (p. ej. imagen de producto en el campo "image"). */
  upload: (path, file, field = 'image', method = 'PUT') => {
    const form = new FormData();
    form.append(field, file);
    return send(method, path, { form });
  },
  onUnauthorized(fn) {
    unauthorizedListeners.add(fn);
    return () => unauthorizedListeners.delete(fn);
  },
  // Atajos de autenticación
  me: () => send('GET', '/auth/me'),
  /** Acceso único: el servidor reconoce si la cuenta es de personal o de cliente (accountType). */
  access: (email, password) => send('POST', '/auth/access', { body: { email, password } }),
  login: (email, password) => send('POST', '/auth/login', { body: { email, password } }),
  storeLogin: (email, password) => send('POST', '/store/auth/login', { body: { email, password } }),
  logout: () => send('POST', '/auth/logout'),
  changePassword: (currentPassword, newPassword, confirmPassword) =>
    send('POST', '/auth/change-password', { body: { currentPassword, newPassword, confirmPassword } }),
};

export default api;
