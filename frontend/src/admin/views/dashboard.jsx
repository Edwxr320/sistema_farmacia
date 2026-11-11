import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAdmin, useRealtime } from '../context.jsx';
import { Card, Table, Badge, Button, Icon, KV, EmptyState, ErrorState, Spinner, useAsync } from '../../components/ui.jsx';
import { LineChart, Sparkline, Donut } from '../../components/charts.jsx';
import { money, number, percent, date, dateTime, todayLima, addDays, PAYMENT_METHODS } from '../../core/format.js';
import { Cell } from './_shared.jsx';
import '../dashboard.css';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const shortDate = (iso) => { const [, m, d] = String(iso).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1] || ''}`; };
const METHOD_COLORS = { CASH: '#1f6fee', YAPE: '#8b5cf6', PLIN: '#f5b423', CARD: '#f97316', TRANSFER: '#22c55e', OTHER: '#94a3b8' };
const PRESETS = [
  { id: '1', label: 'Hoy', days: 1 }, { id: '7', label: 'Últimos 7 días', days: 7 }, { id: '14', label: 'Últimos 14 días', days: 14 },
  { id: '30', label: 'Últimos 30 días', days: 30 }, { id: '90', label: 'Últimos 90 días', days: 90 },
];
const CHART_DAYS = [7, 14, 30, 90];

/** Importe sin céntimos para el centro del donut (el detalle exacto queda en la leyenda y en el título). */
function moneyShort(v) {
  const n = Number(v || 0);
  return `S/ ${n.toLocaleString('es-PE', { maximumFractionDigits: 0 })}`;
}

function timeAgo(value) {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'Hace un momento';
  if (s < 3600) return `Hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `Hace ${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) return `Hace ${Math.round(s / 86400)} d`;
  return dateTime(value);
}

// Etiquetas de los códigos que registra la auditoría (audit_logs.action / module).
const ACTIONS = {
  LOGIN: ['Inicio de sesión', 'green'], LOGOUT: ['Cierre de sesión', 'blue'], LOGIN_FAILED: ['Intento de acceso fallido', 'orange'],
  LOGIN_REJECTED: ['Acceso rechazado', 'orange'], CREATE: ['Registro', 'green'], INSERT: ['Registro', 'green'], UPDATE: ['Actualización', 'blue'],
  DELETE: ['Eliminación', 'orange'], CANCEL: ['Anulación', 'orange'], PAYMENT_REJECTED: ['Pago rechazado', 'orange'], OPEN: ['Apertura', 'green'],
  POST: ['Contabilización', 'green'], APPROVE: ['Aprobación', 'green'], DISPATCH: ['Despacho', 'blue'], CONFIRM: ['Confirmación', 'green'],
  ISSUE: ['Emisión', 'blue'], REGISTER: ['Registro de cuenta', 'green'], PASSWORD_CHANGE: ['Cambio de contraseña', 'blue'],
  PASSWORD_CHANGE_FAILED: ['Cambio de contraseña fallido', 'orange'], PASSWORD_RESET: ['Restablecimiento de contraseña', 'blue'],
  UNLOCK: ['Desbloqueo', 'blue'], ASSIGN_BRANCHES: ['Asignación de sucursales', 'blue'], BOOTSTRAP_ADMIN: ['Alta del administrador inicial', 'green'],
};
const MODULES = {
  auth: 'Acceso', sales: 'Ventas', inventory: 'Inventario', orders: 'Pedidos', cash: 'Caja', returns: 'Devoluciones', products: 'Productos',
  users: 'Trabajadores', customers: 'Clientes', suppliers: 'Proveedores', branches: 'Sucursales', settings: 'Configuración', alerts: 'Alertas',
  store: 'Tienda', security: 'Seguridad',
};
const actionLabel = (a) => ACTIONS[a] || [String(a || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()), 'blue'];
const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('es-PE', { maximumFractionDigits: 1 })}%`);

export function Dashboard() {
  const ctx = useAdmin();
  const [from, setFrom] = useState(addDays(todayLima(), -29));
  const [to, setTo] = useState(todayLima());
  const [chartDays, setChartDays] = useState(30);
  const preset = PRESETS.find((p) => to === todayLima() && from === addDays(todayLima(), -(p.days - 1)))?.id || 'custom';
  const [customOpen, setCustomOpen] = useState(false);

  const main = useAsync(async () => {
    const q = { branchId: ctx.branchId };
    const range = { ...q, from, to };
    const [dash, summary, top, methods, expiring, low, valuation] = await Promise.all([
      ctx.api.get('/reports/dashboard', q),
      ctx.api.get('/reports/sales/summary', range),
      ctx.api.get('/reports/sales/top-products', { ...range, limit: 3 }),
      ctx.api.get('/reports/payments/methods', range),
      ctx.api.get('/reports/inventory/expiring', { ...q, days: 60, pageSize: 5 }),
      ctx.api.get('/reports/inventory/low-stock', { ...q, pageSize: 5 }),
      ctx.api.get('/reports/inventory/valuation', q),
    ]);
    const [activity, orders, alerts] = await Promise.all([
      ctx.can('audit.view') ? ctx.api.get('/reports/activity', { ...q, pageSize: 3 }).catch(() => null) : null,
      ctx.can('orders.view') ? ctx.api.get('/orders', { ...q, pageSize: 3 }).catch(() => null) : null,
      ctx.can('alerts.view') ? ctx.api.get('/inventory/alerts', { ...q, status: 'OPEN', pageSize: 3 }).catch(() => null) : null,
    ]);
    return {
      d: dash.data, s: summary.data, top: top.data, methods: methods.data, expiring, low, valuation: valuation.data, activity, orders, alerts,
    };
  }, [from, to]);

  const chart = useAsync(() => ctx.api.get('/reports/sales/series', {
    branchId: ctx.branchId, from: addDays(todayLima(), -(chartDays - 1)), to: todayLima(), granularity: 'day',
  }), [chartDays]);

  const reload = () => { main.reload(); chart.reload(); };
  useRealtime('sale:created', reload);
  useRealtime('sale:voided', reload);
  useRealtime('order:created', main.reload);

  function applyPreset(id) {
    if (id === 'custom') { setCustomOpen(true); return; }
    const p = PRESETS.find((x) => x.id === id);
    setCustomOpen(false);
    setTo(todayLima());
    setFrom(addDays(todayLima(), -(p.days - 1)));
  }

  return (
    <div className="dash">
      <div className="dash-head">
        <div className="dash-title">
          <h1>Dashboard</h1>
          <p className="sub"><span className="only-desktop">Resumen general de tu farmacia</span><span className="only-mobile">Resumen general</span></p>
        </div>
        <label className="dash-preset only-mobile">
          <span className="sr-only">Período</span>
          <select className="input" value={customOpen ? 'custom' : preset} onChange={(e) => applyPreset(e.target.value)} aria-label="Período">
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            <option value="custom">Personalizado</option>
          </select>
          <Icon name="chevronDown" />
        </label>
        <div className={`dash-filters ${customOpen || preset === 'custom' ? 'open' : ''}`}>
          <DateField label="Desde" value={from} onChange={setFrom} max={to} />
          <DateField label="Hasta" value={to} onChange={setTo} min={from} />
          <Button variant="primary" icon="refresh" onClick={() => reload()}>Actualizar</Button>
        </div>
      </div>

      {main.error ? <ErrorState error={main.error} onRetry={main.reload} /> : main.data === undefined ? <Spinner /> : (
        <DashboardBody data={main.data} chart={chart} chartDays={chartDays} setChartDays={setChartDays} from={from} to={to} />
      )}
    </div>
  );
}

function DateField({ label, value, onChange, min, max }) {
  const id = `df-${label}`;
  return (
    <div className="field date-field">
      <label htmlFor={id}>{label}</label>
      <div className="date-box">
        <input id={id} className="input" type="date" value={value} min={min} max={max} onChange={(e) => e.target.value && onChange(e.target.value)} />
        <Icon name="calendar" />
      </div>
    </div>
  );
}

function Kpi({ tone, icon, label, mobileLabel, value, sub, subTone, delta, spark }) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <div className="kpi-ic"><Icon name={icon} /></div>
      <div className="kpi-txt">
        <div className="kpi-label"><span className="only-desktop">{label}</span><span className="only-mobile">{mobileLabel || label}</span></div>
        <div className="kpi-value">{value}</div>
        {sub || delta !== undefined ? (
          <div className={`kpi-sub ${subTone || ''}`}>
            {delta !== undefined && delta !== null ? <span className={`kpi-delta ${delta >= 0 ? 'up' : 'down'}`}><Icon name={delta >= 0 ? 'arrowUp' : 'arrowDown'} />{`${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%`}</span> : null}
            {sub ? <span>{sub}</span> : null}
          </div>
        ) : null}
      </div>
      {spark ? <div className="kpi-spark"><Sparkline values={spark} color={`var(--k-${tone}-line)`} /></div> : null}
    </div>
  );
}

function SeeAll({ to, label = 'Ver todos' }) {
  return to ? <Link to={to} className="see-all">{label}<Icon name="arrowRight" /></Link> : null;
}

function DashboardBody({ data, chart, chartDays, setChartDays, from, to }) {
  const ctx = useAdmin();
  const { d, s, top, methods, expiring, low, valuation, activity, orders, alerts } = data;
  const activeOrders = Object.values(d.activeOrders || {}).reduce((a, b) => a + b, 0);
  const pendingOrders = (d.activeOrders || {}).PENDING || 0;
  const openAlerts = d.openAlerts || {};
  const series = chart.data?.data?.series || [];
  const salesSpark = series.slice(-14).map((p) => Number(p.netSales));
  const collected = methods.byMethod.reduce((a, m) => a + Number(m.collected), 0);
  const canReports = ctx.can('reports.view');

  // Alertas: las abiertas del sistema; si no hay permiso de alertas, los contadores del dashboard.
  const alertItems = [];
  if (alerts) {
    for (const a of alerts.data) {
      alertItems.push({ key: `a${a.id}`, tone: a.alertType === 'LOW_STOCK' ? 'orange' : 'red', text: a.message || `${a.product.name}` });
    }
  } else {
    if (d.batchesExpiringIn30Days) alertItems.push({ key: 'exp', tone: 'red', text: `${number(d.batchesExpiringIn30Days)} lote(s) por vencer en 30 días` });
    if (d.lowStockProducts) alertItems.push({ key: 'low', tone: 'orange', text: `${number(d.lowStockProducts)} producto(s) con stock bajo` });
  }
  if (pendingOrders && ctx.can('orders.view')) alertItems.push({ key: 'ord', tone: 'blue', text: `${number(pendingOrders)} pedido(s) online pendiente(s) de atención` });

  return (
    <>
      <div className="kpis">
        <Kpi tone="blue" icon="cart" label="Ventas del día" mobileLabel="Ventas hoy" value={money(d.sales.netSales)}
          sub={`${number(d.sales.transactions)} operaciones`} subTone="blue" delta={d.sales.vsYesterdayPercent ?? undefined} spark={salesSpark} />
        <Kpi tone="green" icon="users" label="Pedidos online" value={number(activeOrders)}
          sub={`${number(pendingOrders)} ${pendingOrders === 1 ? 'pendiente' : 'pendientes'} de atención`} />
        <Kpi tone="purple" icon="box" label="Inventario total" mobileLabel="Inventario" value={money(valuation.totals.costValue)}
          sub={`${number(valuation.totals.units)} unidades · al costo`} />
        <Kpi tone="orange" icon="alert" label="Stock bajo" value={number(d.lowStockProducts)}
          sub={d.lowStockProducts ? 'Requiere atención' : 'Todo sobre el mínimo'} subTone={d.lowStockProducts ? 'danger' : 'ok'} />
      </div>

      <div className="dash-row dash-row-a">
        <Card className="chart-card" title={`Ventas de los últimos ${chartDays} días`} actions={(
          <label className="mini-select">
            <span className="sr-only">Período del gráfico</span>
            <select value={chartDays} onChange={(e) => setChartDays(Number(e.target.value))} aria-label="Período del gráfico">
              {CHART_DAYS.map((n) => <option key={n} value={n}>{`${n} días`}</option>)}
            </select>
            <Icon name="chevronDown" />
          </label>
        )}>
          {chart.error ? <ErrorState error={chart.error} onRetry={chart.reload} /> : !chart.data ? <Spinner /> : (
            <>
              <LineChart
                points={series.map((p) => ({ label: shortDate(p.period), value: Number(p.netSales), title: `${date(p.period)}: ${money(p.netSales)} (${p.transactions} ventas)` }))}
                formatValue={(v) => money(v.toFixed(2))}
              />
              {!series.some((p) => Number(p.netSales) > 0) ? <p className="small muted chart-note">Sin ventas registradas en este período.</p> : null}
            </>
          )}
        </Card>

        <Card title="Métodos de pago">
          {methods.byMethod.length ? (
            <div className="pay-wrap">
              <Donut
                segments={methods.byMethod.map((m) => ({ label: `${PAYMENT_METHODS[m.method] || m.method}: ${money(m.collected)}`, value: Number(m.collected), color: METHOD_COLORS[m.method] || METHOD_COLORS.OTHER }))}
                center={moneyShort(collected)}
              />
              <ul className="pay-legend">
                {methods.byMethod.map((m) => (
                  <li key={m.method} title={money(m.collected)}>
                    <span className="dot" style={{ background: METHOD_COLORS[m.method] || METHOD_COLORS.OTHER }} />
                    <span className="grow">{PAYMENT_METHODS[m.method] || m.method}</span>
                    <strong>{pct(m.share)}</strong>
                  </li>
                ))}
              </ul>
              {methods.byMethod.some((m) => m.demo) ? <p className="pay-note small muted">Pagos electrónicos en modo DEMO (sin cobro real).</p> : null}
            </div>
          ) : (
            <div className="pay-wrap">
              <Donut segments={[]} center={moneyShort(0)} />
              <p className="small muted">Sin cobros en el período.</p>
            </div>
          )}
        </Card>

        <Card title="Alertas importantes" actions={ctx.can('alerts.view') ? <SeeAll to="/admin/alerts" label="Ver todas" /> : null}>
          {alertItems.length ? (
            <ul className="alert-list">
              {alertItems.slice(0, 4).map((a) => (
                <li key={a.key}>
                  <span className={`al-ic ${a.tone}`}><Icon name={a.tone === 'red' ? 'alert' : a.tone === 'blue' ? 'info' : 'alertCircle'} /></span>
                  <span>{a.text}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="Sin alertas abiertas" text="El inventario no tiene alertas pendientes." />}
        </Card>
      </div>

      <div className="dash-row dash-row-b">
        <Card title="Productos más vendidos" actions={canReports ? <SeeAll to="/admin/reports" /> : null}>
          {top.data.length ? (
            <ol className="top-list">
              {top.data.map((p, i) => (
                <li key={p.product_id ?? p.sku ?? i}>
                  <span className="rank">{i + 1}</span>
                  <span className="pic"><Icon name="pill" /></span>
                  <span className="grow"><span className="nm" title={p.name}>{p.name}</span><span className="small muted">{money(p.revenue)}</span></span>
                  <strong className="qty-l">{`${number(p.quantity)} uds.`}</strong>
                </li>
              ))}
            </ol>
          ) : <EmptyState title="Sin ventas en el período" />}
        </Card>

        <Card title="Pedidos recientes" tight actions={ctx.can('orders.view') ? <SeeAll to="/admin/orders" /> : null}>
          {orders ? (
            <Table
              columns={[
                { label: 'Nº Pedido', render: (o) => <span className="link-strong">{o.orderNumber}</span> },
                { label: 'Cliente', render: (o) => <span className="ellip" title={o.customer?.name}>{o.customer?.name}</span> },
                { label: 'Monto', num: true, render: (o) => money(o.total) },
                { label: 'Estado', render: (o) => <Badge kind="order" code={o.status} /> },
              ]}
              rows={orders.data} empty="Aún no hay pedidos online" onRowClick={(o) => ctx.navigate('orders', { id: o.id })}
            />
          ) : <EmptyState title="Sin acceso a pedidos online" />}
        </Card>

        <Card title="Actividad reciente" actions={activity && canReports ? <SeeAll to="/admin/reports" /> : null}>
          {activity ? (activity.data.length ? (
            <ul className="activity">
              {activity.data.map((a) => {
                const [label, tone] = actionLabel(a.action);
                return (
                  <li key={a.id ?? `${a.created_at}-${a.action}`}>
                    <span className={`dot ${tone}`} />
                    <span className="grow">
                      <span className="nm">{`${label} · ${MODULES[a.module] || a.module}${a.entity_id ? ` #${a.entity_id}` : ''}`}</span>
                      <span className="small muted">{a.user_name || 'Sistema'}</span>
                    </span>
                    <span className="small muted nowrap" title={dateTime(a.created_at)}>{timeAgo(a.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          ) : <EmptyState title="Sin actividad" />) : <EmptyState title="Sin acceso a la auditoría" />}
        </Card>
      </div>

      <div className="dash-row dash-row-c">
        <Card title="Indicadores de hoy">
          <KV pairs={[
            ['Ticket promedio', money(d.sales.averageTicket)], ['Ingreso neto', money(d.sales.netRevenue)],
            ['Margen bruto estimado', money(d.sales.grossMarginEstimated)], ['Cajas abiertas', number(d.openCashSessions)],
            ['Lotes por vencer (30 días)', number(d.batchesExpiringIn30Days)],
            ['Alertas abiertas', `${number(Object.values(openAlerts).reduce((a, b) => a + b, 0))} (${openAlerts.OUT_OF_STOCK || 0} agotados · ${openAlerts.EXPIRED || 0} vencidos)`],
          ]} />
        </Card>
        <Card title={`Resumen financiero · ${date(from)} – ${date(to)}`} actions={<span className="small muted" title={s.definitions.grossMarginEstimated}>El margen no es ganancia neta</span>}>
          <KV pairs={[
            ['Ventas brutas', money(s.grossSales)], ['Descuentos', money(s.discounts)], ['Ventas netas', money(s.netSales)],
            ['Transacciones', number(s.transactions)], ['Reembolsos (devoluciones)', money(s.returns.refunds)], ['Ingreso neto', <strong>{money(s.netRevenue)}</strong>],
            ['Costo de lo vendido', money(s.costOfGoodsSold)], ['Margen bruto estimado', `${money(s.grossMarginEstimated)} (${percent(s.grossMarginPercent)})`],
            ['Anulaciones', `${s.voids.count} (${money(s.voids.amount)})`], ['Canal POS / Online', `${money(s.byChannel.POS.netSales)} / ${money(s.byChannel.ONLINE.netSales)}`],
          ]} />
        </Card>
      </div>

      <div className="dash-row dash-row-c">
        <Card title="Próximos a vencer (60 días)" tight actions={ctx.can('inventory.view') ? <SeeAll to="/admin/batches" /> : null}>
          <Table
            columns={[
              { label: 'Producto', render: (r) => <Cell title={r.product_name} sub={`Lote ${r.batch_number}`} /> },
              { label: 'Vence', render: (r) => <div>{date(r.expiry_date)}<div className="cell-sub">{r.is_expired ? 'Vencido' : `${r.days_to_expiry} días`}</div></div> },
              { label: 'Stock', num: true, render: (r) => number(r.current_quantity) },
            ]}
            rows={expiring.data} empty="Sin lotes por vencer"
          />
        </Card>
        <Card title="Stock bajo" tight actions={ctx.can('alerts.view') ? <SeeAll to="/admin/alerts" label="Ver alertas" /> : null}>
          <Table
            columns={[
              { label: 'Producto', render: (r) => <Cell title={r.name} sub={r.sku} /> },
              { label: 'Estado', render: (r) => <Badge kind="stock" code={r.stock_status} /> },
              { label: 'Stock / mín.', num: true, render: (r) => `${number(r.current_stock)} / ${number(r.minimum_stock)}` },
            ]}
            rows={low.data} empty="Todo el stock está sobre el mínimo"
          />
        </Card>
      </div>
    </>
  );
}
