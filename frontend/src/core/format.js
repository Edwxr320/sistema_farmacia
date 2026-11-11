/**
 * Formato y etiquetas (funciones puras, sin DOM: se prueban con Node).
 * Los importes llegan del servidor como texto decimal ("12.50"); aquí solo se muestran,
 * nunca se recalculan precios ni totales en el navegador.
 */

export const LIMA_TZ = 'America/Lima';

/** "1234.5" → "S/ 1,234.50" sin aritmética float. */
export function money(value, symbol = 'S/') {
  if (value === null || value === undefined || value === '') return '—';
  const s = String(value).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return s;
  const int = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const dec = (m[3] || '').padEnd(2, '0').slice(0, 2);
  return `${m[1] ? '-' : ''}${symbol} ${int}.${dec}`;
}

/** Céntimos enteros desde texto (solo para validaciones de interfaz, p. ej. vuelto estimado). */
export function cents(value) {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const c = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  return m[1] ? -c : c;
}

export function fromCents(c) {
  const neg = c < 0;
  const a = Math.abs(c);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Fecha y hora en Lima. Acepta ISO (DATETIME convertido por el servidor) o Date. */
export function dateTime(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('es-PE', { timeZone: LIMA_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 'YYYY-MM-DD' (columnas DATE) → 'DD/MM/YYYY'. Si llega ISO, se convierte a Lima. */
export function date(value) {
  if (!value) return '—';
  const s = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('es-PE', { timeZone: LIMA_TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function todayLima(now = Date.now()) {
  return new Date(now - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function addDays(isoDate, n) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export function number(value) {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('es-PE');
}

export function percent(value) {
  if (value === null || value === undefined) return '—';
  return `${Number(value).toLocaleString('es-PE', { maximumFractionDigits: 2 })} %`;
}

/** Construye ?a=1&b=2 omitiendo vacíos. */
export function buildQuery(params = {}) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Clave de idempotencia aleatoria (cumple ^[A-Za-z0-9._-]{8,64}$). */
export function idempotencyKey(prefix = 'pp') {
  const rnd = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
}

// ----------------------------------------------------------------- etiquetas
const LABELS = {
  order: {
    PENDING: ['Pendiente', 'warning'], CONFIRMED: ['Confirmado', 'info'], PREPARING: ['En preparación', 'info'],
    READY_FOR_PICKUP: ['Listo para recojo', 'success'], OUT_FOR_DELIVERY: ['En reparto', 'info'], COMPLETED: ['Entregado', 'success'],
    CANCELLED: ['Cancelado', 'neutral'], REJECTED: ['Rechazado', 'danger'],
  },
  sale: { COMPLETED: ['Completada', 'success'], VOIDED: ['Anulada', 'danger'] },
  payment: {
    PENDING: ['Pendiente', 'warning'], APPROVED: ['Aprobado', 'success'], REJECTED: ['Rechazado', 'danger'],
    CANCELLED: ['Cancelado', 'neutral'], REFUNDED: ['Reembolsado', 'info'],
  },
  entry: { DRAFT: ['Borrador', 'warning'], POSTED: ['Contabilizada', 'success'], CANCELLED: ['Anulada', 'neutral'] },
  transfer: {
    REQUESTED: ['Solicitada', 'warning'], APPROVED: ['Aprobada', 'info'], IN_TRANSIT: ['En tránsito', 'info'],
    PARTIALLY_RECEIVED: ['Recepción parcial', 'warning'], RECEIVED: ['Recibida', 'success'],
    RECEIVED_WITH_DISCREPANCIES: ['Recibida con diferencias', 'warning'], CANCELLED: ['Cancelada', 'neutral'],
  },
  return: { REQUESTED: ['Solicitada', 'warning'], APPROVED: ['Aprobada', 'info'], REJECTED: ['Rechazada', 'danger'], COMPLETED: ['Completada', 'success'] },
  alert: { LOW_STOCK: ['Stock bajo', 'warning'], OUT_OF_STOCK: ['Agotado', 'danger'], EXPIRING_SOON: ['Por vencer', 'warning'], EXPIRED: ['Vencido', 'danger'] },
  stock: { OK: ['Normal', 'success'], LOW_STOCK: ['Stock bajo', 'warning'], OUT_OF_STOCK: ['Agotado', 'danger'] },
  expiry: { OK: ['Vigente', 'success'], WARNING: ['Por vencer', 'warning'], CRITICAL: ['Crítico', 'danger'], EXPIRED: ['Vencido', 'danger'] },
  product: { ACTIVE: ['Activo', 'success'], INACTIVE: ['Inactivo', 'neutral'], DISCONTINUED: ['Descontinuado', 'danger'] },
  user: { ACTIVE: ['Activo', 'success'], INACTIVE: ['Inactivo', 'neutral'], BLOCKED: ['Bloqueado', 'danger'] },
  cash: { OPEN: ['Abierta', 'success'], CLOSED: ['Cerrada', 'neutral'] },
  batch: { ACTIVE: ['Activo', 'success'], DEPLETED: ['Agotado', 'neutral'], QUARANTINE: ['Cuarentena', 'warning'], RECALLED: ['Retirado', 'danger'] },
};

export function statusLabel(kind, code) {
  const entry = LABELS[kind] && LABELS[kind][code];
  return entry ? { text: entry[0], tone: entry[1] } : { text: code ?? '—', tone: 'neutral' };
}

export const PAYMENT_METHODS = { CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia', YAPE: 'Yape', PLIN: 'Plin', OTHER: 'Otro' };
export const MOVEMENT_TYPES = {
  PURCHASE_ENTRY: 'Entrada por compra', SALE_OUT: 'Venta', SALE_VOID_IN: 'Anulación de venta', RETURN_IN: 'Devolución',
  TRANSFER_OUT: 'Transferencia (salida)', TRANSFER_IN: 'Transferencia (ingreso)', ADJUSTMENT_IN: 'Ajuste (+)', ADJUSTMENT_OUT: 'Ajuste (−)',
  EXPIRED_WRITE_OFF: 'Baja por vencimiento', DAMAGE_WRITE_OFF: 'Baja por deterioro',
};
export const ADJUSTMENT_TYPES = {
  PHYSICAL_COUNT: 'Conteo físico', CORRECTION: 'Corrección', OTHER: 'Otro', EXPIRED_WRITE_OFF: 'Baja por vencimiento', DAMAGE: 'Baja por deterioro', LOSS: 'Pérdida',
};
export const FULFILLMENT = { PICKUP: 'Recojo en tienda', DELIVERY: 'Delivery' };
export const CONDITIONS = { RESELLABLE: 'Apto para reventa', DAMAGED: 'Dañado', EXPIRED: 'Vencido', OPENED: 'Abierto', NOT_SUITABLE: 'No apto' };

/** Mensaje legible para un error de la API (sin detalles técnicos). */
export function errorMessage(err) {
  if (!err) return 'Ocurrió un error inesperado';
  if (err.status === 0) return 'No hay conexión con el servidor';
  return err.message || 'Ocurrió un error inesperado';
}
