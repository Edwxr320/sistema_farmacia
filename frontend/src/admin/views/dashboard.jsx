import React, { useState } from 'react';
import { useAdmin, useRealtime } from '../context.jsx';
import { Card, Stat, PageHead, Table, Badge, BarChart, HBars, EmptyState, Button, DateInput, KV, ToneBadge, useAsync, Async } from '../../components/ui.jsx';
import { money, number, percent, date, dateTime, todayLima, addDays, PAYMENT_METHODS } from '../../core/format.js';
import { Cell } from './_shared.jsx';

export function Dashboard() {
  const ctx = useAdmin();
  const [from, setFrom] = useState(addDays(todayLima(), -13));
  const [to, setTo] = useState(todayLima());

  const state = useAsync(async () => {
    const q = { branchId: ctx.branchId };
    const range = { ...q, from, to };
    const [dash, summary, series, top, methods, expiring, low] = await Promise.all([
      ctx.api.get('/reports/dashboard', q),
      ctx.api.get('/reports/sales/summary', range),
      ctx.api.get('/reports/sales/series', { ...range, granularity: 'day' }),
      ctx.api.get('/reports/sales/top-products', { ...range, limit: 8 }),
      ctx.api.get('/reports/payments/methods', range),
      ctx.api.get('/reports/inventory/expiring', { ...q, days: 60, pageSize: 6 }),
      ctx.api.get('/reports/inventory/low-stock', { ...q, pageSize: 6 }),
    ]);
    const activity = ctx.can('audit.view') ? await ctx.api.get('/reports/activity', { ...q, pageSize: 8 }).catch(() => null) : null;
    return { d: dash.data, s: summary.data, series: series.data, top: top.data, methods: methods.data, expiring, low, activity };
  }, [from, to]);

  useRealtime('sale:created', state.reload);
  useRealtime('sale:voided', state.reload);
  useRealtime('order:created', state.reload);

  return (
    <>
      <PageHead
        title="Dashboard" sub={`Resumen de ${ctx.branchName(ctx.branchId)}`}
        actions={(
          <div className="toolbar">
            <DateInput value={from} onChange={setFrom} label="Desde" />
            <DateInput value={to} onChange={setTo} label="Hasta" />
            <Button icon="refresh" onClick={() => state.reload()}>Actualizar</Button>
          </div>
        )}
      />
      <div className="stack">
        <Async state={state}>{(x) => <DashboardBody {...x} />}</Async>
      </div>
    </>
  );
}

function DashboardBody({ d, s, series, top, methods, expiring, low, activity }) {
  const ctx = useAdmin();
  const alerts = d.openAlerts || {};
  const pendingOrders = (d.activeOrders || {}).PENDING || 0;
  return (
    <>
      <div className="grid grid-4">
        <Stat label="Ventas de hoy" value={money(d.sales.netSales)} sub={`${number(d.sales.transactions)} operaciones`} delta={d.sales.vsYesterdayPercent} />
        <Stat label="Ticket promedio hoy" value={money(d.sales.averageTicket)} sub="ventas netas / operaciones" />
        <Stat label="Ingreso neto hoy" value={money(d.sales.netRevenue)} sub={`Margen bruto estimado ${money(d.sales.grossMarginEstimated)}`} />
        <Stat label="Pendientes" value={number(pendingOrders)} sub={`pedidos online · ${d.openCashSessions} caja(s) abierta(s)`} />
      </div>
      <div className="grid grid-4">
        <Stat label="Stock bajo" value={number(d.lowStockProducts)} sub="productos bajo el mínimo" />
        <Stat label="Por vencer (30 días)" value={number(d.batchesExpiringIn30Days)} sub="lotes con existencias" />
        <Stat label="Alertas abiertas" value={number(Object.values(alerts).reduce((a, b) => a + b, 0))} sub={`${alerts.OUT_OF_STOCK || 0} agotados · ${alerts.EXPIRED || 0} vencidos`} />
        <Stat label={`Período ${date(s.period.from)} – ${date(s.period.to)}`} value={money(s.netSales)} sub={`${number(s.transactions)} ventas · ${percent(s.grossMarginPercent)} margen est.`} />
      </div>
      <div className="grid grid-2">
        <Card title="Ventas netas por día">
          {series.series.some((p) => Number(p.netSales) > 0)
            ? <BarChart data={series.series.map((p) => ({ label: p.period.slice(8, 10), value: Number(p.netSales), title: `${date(p.period)}: ${money(p.netSales)} (${p.transactions} ventas)` }))} formatValue={(v) => money(v.toFixed(2))} />
            : <EmptyState title="Sin ventas en el período" />}
        </Card>
        <Card title="Resumen financiero del período" actions={<span className="small muted" title={s.definitions.grossMarginEstimated}>El margen no es ganancia neta</span>}>
          <KV pairs={[
            ['Ventas brutas', money(s.grossSales)], ['Descuentos', money(s.discounts)], ['Ventas netas', money(s.netSales)],
            ['Reembolsos (devoluciones)', money(s.returns.refunds)], ['Ingreso neto', <strong>{money(s.netRevenue)}</strong>],
            ['Costo de lo vendido', money(s.costOfGoodsSold)], ['Margen bruto estimado', money(s.grossMarginEstimated)],
            ['Anulaciones', `${s.voids.count} (${money(s.voids.amount)})`], ['Canal POS / Online', `${money(s.byChannel.POS.netSales)} / ${money(s.byChannel.ONLINE.netSales)}`],
          ]} />
        </Card>
      </div>
      <div className="grid grid-2">
        <Card title="Productos más vendidos">
          {top.data.length
            ? <HBars items={top.data.map((p) => ({ label: p.name, value: p.quantity, display: `${number(p.quantity)} u · ${money(p.revenue)}` }))} />
            : <EmptyState title="Sin ventas en el período" />}
        </Card>
        <Card title="Métodos de pago">
          {methods.byMethod.length
            ? <HBars items={methods.byMethod.map((m) => ({ label: `${PAYMENT_METHODS[m.method] || m.method}${m.demo ? ' (DEMO)' : ''}`, value: Number(m.collected), display: `${money(m.collected)} · ${percent(m.share)}` }))} />
            : <EmptyState title="Sin cobros en el período" />}
        </Card>
      </div>
      <div className="grid grid-2">
        <Card title="Próximos a vencer (60 días)" tight actions={ctx.can('inventory.view') ? <Button size="sm" onClick={() => ctx.navigate('batches')}>Ver lotes</Button> : null}>
          <Table
            columns={[
              { label: 'Producto', render: (r) => <Cell title={r.product_name} sub={`Lote ${r.batch_number}`} /> },
              { label: 'Vence', render: (r) => <div>{date(r.expiry_date)}<div className="cell-sub">{r.is_expired ? 'Vencido' : `${r.days_to_expiry} días`}</div></div> },
              { label: 'Stock', num: true, render: (r) => number(r.current_quantity) },
            ]}
            rows={expiring.data} empty="Sin lotes por vencer"
          />
        </Card>
        <Card title="Stock bajo" tight actions={ctx.can('alerts.view') ? <Button size="sm" onClick={() => ctx.navigate('alerts')}>Ver alertas</Button> : null}>
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
      {activity ? (
        <Card title="Actividad reciente" tight>
          <Table
            columns={[
              { label: 'Fecha', render: (a) => dateTime(a.created_at) },
              { label: 'Usuario', render: (a) => a.user_name || 'Sistema' },
              { label: 'Acción', render: (a) => <ToneBadge tone="info">{a.action}</ToneBadge> },
              { label: 'Módulo', render: (a) => `${a.module}${a.entity_table ? ` · ${a.entity_table}` : ''}` },
            ]}
            rows={activity.data} empty="Sin actividad"
          />
        </Card>
      ) : null}
    </>
  );
}
