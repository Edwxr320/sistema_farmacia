import React, { useState } from 'react';
import { useAdmin } from '../context.jsx';
import {
  Card, PageHead, Table, Stat, Pagination, Select, DateInput, Tabs, BarChart, HBars, KV, ToneBadge, Badge, AlertBox, Spinner, useAsync, Async,
} from '../../components/ui.jsx';
import { money, number, percent, date, dateTime, todayLima, addDays, PAYMENT_METHODS, MOVEMENT_TYPES, CONDITIONS } from '../../core/format.js';
import { Cell } from './_shared.jsx';

const TABS = [
  { id: 'sales', label: 'Ventas' }, { id: 'products', label: 'Productos y categorías' }, { id: 'payments', label: 'Pagos' },
  { id: 'inventory', label: 'Inventario' }, { id: 'returns', label: 'Devoluciones' }, { id: 'orders', label: 'Pedidos' },
  { id: 'cash', label: 'Caja' }, { id: 'activity', label: 'Actividad', perm: 'audit.view' },
];

export function Reports() {
  const ctx = useAdmin();
  const consolidated = ctx.can('reports.consolidated');
  const [f, setF] = useState({ from: addDays(todayLima(), -29), to: todayLima(), branchId: String(ctx.branchId), channel: '', granularity: 'day' });
  const [tab, setTab] = useState('sales');
  const [page, setPage] = useState(1);
  const set = (patch) => { setPage(1); setF((x) => ({ ...x, ...patch })); };
  const branchOpts = ctx.branches.map((b) => ({ value: String(b.id), label: b.name }));
  const visible = TABS.filter((t) => !t.perm || ctx.can(t.perm));
  const range = () => ({ from: f.from, to: f.to, branchId: f.branchId || undefined });

  const LOADERS = {
    async sales() {
      const ch = f.channel || undefined;
      const [s, cmp, series, branches, sellers] = await Promise.all([
        ctx.api.get('/reports/sales/summary', { ...range(), channel: ch }),
        ctx.api.get('/reports/sales/compare', { ...range(), channel: ch }),
        ctx.api.get('/reports/sales/series', { ...range(), channel: ch, granularity: f.granularity }),
        consolidated ? ctx.api.get('/reports/sales/by-branch', range()) : null,
        ctx.api.get('/reports/sales/by-seller', range()),
      ]);
      return { s, cmp, series, branches, sellers };
    },
    async products() {
      const [top, rev, cats] = await Promise.all([
        ctx.api.get('/reports/sales/top-products', { ...range(), limit: 15, orderBy: 'quantity' }),
        ctx.api.get('/reports/sales/top-products', { ...range(), limit: 10, orderBy: 'revenue' }),
        ctx.api.get('/reports/sales/by-category', range()),
      ]);
      return { top, rev, cats };
    },
    async payments() { return { r: await ctx.api.get('/reports/payments/methods', range()) }; },
    async inventory() {
      const q = { branchId: f.branchId || undefined };
      const [val, low, exp, mov] = await Promise.all([
        ctx.api.get('/reports/inventory/valuation', q),
        ctx.api.get('/reports/inventory/low-stock', { ...q, page, pageSize: 15 }),
        ctx.api.get('/reports/inventory/expiring', { ...q, days: 90, pageSize: 15 }),
        ctx.api.get('/reports/inventory/movements', range()),
      ]);
      return { val, low, exp, mov };
    },
    async returns() { return { r: (await ctx.api.get('/reports/returns', range())).data }; },
    async orders() { return { r: (await ctx.api.get('/reports/orders', range())).data }; },
    async cash() { return { r: await ctx.api.get('/reports/cash', { ...range(), page, pageSize: 15 }) }; },
    async activity() { return { r: await ctx.api.get('/reports/activity', { ...range(), page, pageSize: 25 }) }; },
  };
  const state = useAsync(async () => ({ tab, data: await LOADERS[tab]() }), [tab, f, page]);

  return (
    <>
      <PageHead title="Reportes" sub="Indicadores calculados por el servidor. El margen bruto es estimado (ventas netas − costo de lo vendido); no es ganancia neta." />
      <div className="card card-body toolbar">
        <DateInput value={f.from} onChange={(v) => set({ from: v })} label="Desde" />
        <DateInput value={f.to} onChange={(v) => set({ to: v })} label="Hasta" />
        <Select options={branchOpts} value={f.branchId} onChange={(v) => set({ branchId: v })} label="Sucursal" placeholder={consolidated ? 'Todas (consolidado)' : undefined} />
        <Select options={[{ value: 'POS', label: 'Mostrador (POS)' }, { value: 'ONLINE', label: 'Tienda online' }]} value={f.channel} onChange={(v) => set({ channel: v })} label="Canal" placeholder="Todos" />
      </div>
      <div><Tabs items={visible} active={tab} onChange={(t) => { setTab(t); setPage(1); }} /></div>
      <div className="stack">
        <Async state={state}>
          {({ tab: t, data }) => {
            if (t !== tab) return <Spinner />;
            const R = VIEWS[t];
            return <R {...data} f={f} set={set} onPage={setPage} consolidated={consolidated} />;
          }}
        </Async>
      </div>
    </>
  );
}

function Definitions({ defs }) {
  if (!defs) return null;
  return <Card title="Definiciones"><KV pairs={Object.entries(defs).map(([k, v]) => [k, v])} /></Card>;
}

const VIEWS = {
  sales({ s, cmp, series, branches, sellers, f, set }) {
    const d = s.data;
    const c = cmp.data;
    return (
      <>
        <div className="stats">
          <Stat label="Ventas netas" value={money(d.netSales)} sub={`${number(d.transactions)} transacciones`} delta={c.netSales.changePercent} />
          <Stat label="Ingreso neto (− reembolsos)" value={money(d.netRevenue)} sub={`Reembolsos ${money(d.returns.refunds)}`} delta={c.netRevenue.changePercent} />
          <Stat label="Margen bruto estimado" value={money(d.grossMarginEstimated)} sub={d.grossMarginPercent !== null ? `${percent(d.grossMarginPercent)} · costo ${money(d.costOfGoodsSold)}` : `Costo ${money(d.costOfGoodsSold)}`} delta={c.grossMarginEstimated.changePercent} />
          <Stat label="Ticket promedio" value={money(d.averageTicket)} sub={`${number(d.unitsSold)} unidades`} delta={c.averageTicket.changePercent} />
        </div>
        <p className="small muted">{`Comparado con ${date(c.previous.from)} – ${date(c.previous.to)}.`}</p>
        <Card title="Evolución de ventas netas">
          <div className="stack">
            <Select options={[{ value: 'day', label: 'Por día' }, { value: 'week', label: 'Por semana' }, { value: 'month', label: 'Por mes' }]} value={f.granularity} onChange={(v) => set({ granularity: v })} label="Agrupar" />
            <BarChart data={series.data.series.map((p) => ({ label: p.period, value: Number(p.netSales) }))} formatValue={(v) => money(v)} />
          </div>
        </Card>
        <div className="grid grid-2">
          <Card title="Desglose">
            <KV pairs={[['Ventas brutas', money(d.grossSales)], ['Descuentos', money(d.discounts)], ['Costos de delivery cobrados', money(d.deliveryFees)],
              ['Mostrador (POS)', `${money(d.byChannel.POS.netSales)} · ${d.byChannel.POS.transactions} tx`], ['Tienda online', `${money(d.byChannel.ONLINE.netSales)} · ${d.byChannel.ONLINE.transactions} tx`],
              ['Anulaciones', `${d.voids.count} · ${money(d.voids.amount)}`], ['Pagos rechazados (intentos)', d.voids.rejectedPaymentAttempts]]} />
          </Card>
          <Card title="Por vendedor" tight>
            <Table
              columns={[
                { label: 'Vendedor', render: (r) => r.seller_name || 'Tienda online' },
                { label: 'Tx', num: true, render: (r) => r.transactions },
                { label: 'Descuentos', num: true, render: (r) => money(r.discounts) },
                { label: 'Ventas netas', num: true, render: (r) => money(r.net_sales) },
              ]}
              rows={sellers.data.data} empty="Sin ventas"
            />
          </Card>
        </div>
        {branches ? (
          <Card title="Por sucursal" tight>
            <Table
              columns={[
                { label: 'Sucursal', render: (r) => r.branch_name }, { label: 'Tx', num: true, render: (r) => r.transactions },
                { label: 'Brutas', num: true, render: (r) => money(r.gross) }, { label: 'Descuentos', num: true, render: (r) => money(r.discounts) },
                { label: 'Netas', num: true, render: (r) => money(r.net_sales) },
              ]}
              rows={branches.data.data}
            />
          </Card>
        ) : null}
        <Definitions defs={d.definitions} />
      </>
    );
  },

  products({ top, rev, cats }) {
    const cols = [
      { label: 'Producto', render: (r) => <Cell title={r.name} sub={`${r.sku} · ${r.category_name}`} /> },
      { label: 'Unidades', num: true, render: (r) => number(r.quantity) },
      { label: 'Tx', num: true, render: (r) => r.transactions },
      { label: 'Ingresos', num: true, render: (r) => money(r.revenue) },
    ];
    return (
      <>
        <div className="grid grid-2">
          <Card title="Más vendidos (unidades)" tight><Table columns={cols} rows={top.data.data} empty="Sin ventas en el período" /></Card>
          <Card title="Mayores ingresos"><HBars items={rev.data.data.map((r) => ({ label: r.name, value: Number(r.revenue), display: money(r.revenue) }))} /></Card>
        </div>
        <Card title="Ventas por categoría" tight>
          <Table
            columns={[
              { label: 'Categoría', render: (r) => r.category_name }, { label: 'Unidades', num: true, render: (r) => number(r.quantity) },
              { label: 'Brutas', num: true, render: (r) => money(r.gross) }, { label: 'Descuentos', num: true, render: (r) => money(r.discounts) },
              { label: 'Ingresos', num: true, render: (r) => money(r.revenue) },
            ]}
            rows={cats.data.data} empty="Sin ventas"
          />
        </Card>
      </>
    );
  },

  payments({ r }) {
    return (
      <>
        <AlertBox tone="info">Todos los pagos del sistema son de demostración (no hay pasarela real).</AlertBox>
        <Card title="Cobros por método">
          <div className="stack">
            <HBars items={r.data.byMethod.map((m) => ({ label: PAYMENT_METHODS[m.method] || m.method, value: Number(m.collected), display: money(m.collected) }))} />
            <Table
              columns={[
                { label: 'Método', render: (m) => `${PAYMENT_METHODS[m.method] || m.method}${m.demo ? ' (DEMO)' : ''}` },
                { label: 'Cobrado', num: true, render: (m) => money(m.collected) },
                { label: 'Participación', num: true, render: (m) => percent(m.share) },
                { label: 'Reemb. de pagos', num: true, render: (m) => money(m.paymentRefunds) },
                { label: 'Reemb. por devolución', num: true, render: (m) => money(m.returnRefunds) },
                { label: 'Rechazos', num: true, render: (m) => m.rejectedAttempts },
              ]}
              rows={r.data.byMethod} empty="Sin pagos en el período"
            />
          </div>
        </Card>
      </>
    );
  },

  inventory({ val, low, exp, mov, onPage }) {
    const t = val.data.totals;
    return (
      <>
        <div className="stats">
          <Stat label="Valor al costo" value={money(t.costValue)} sub={`${number(t.units)} unidades`} />
          <Stat label="Vendible (costo)" value={money(t.sellableCost)} sub={`Valor de venta ${money(t.sellableRetailValue)}`} />
          <Stat label="Vencido (costo)" value={money(t.expiredCost)} />
          <Stat label="Bloqueado (costo)" value={money(t.blockedCost)} />
        </div>
        <p className="small muted">{val.data.valuationBasis}</p>
        <Card title="Valorización por categoría" tight>
          <Table
            columns={[
              { label: 'Categoría', render: (r) => r.category_name }, { label: 'Productos', num: true, render: (r) => r.products },
              { label: 'Lotes', num: true, render: (r) => r.batches }, { label: 'Unidades', num: true, render: (r) => number(r.units) },
              { label: 'Costo', num: true, render: (r) => money(r.cost_value) }, { label: 'Venta (vendible)', num: true, render: (r) => money(r.sellable_retail) },
            ]}
            rows={val.data.byCategory}
          />
        </Card>
        <div className="grid grid-2">
          <Card title="Stock bajo y agotados" tight>
            <div>
              <Table
                columns={[
                  { label: 'Producto', render: (r) => <Cell title={r.name} sub={`${r.sku} · ${r.branch_name}`} /> },
                  { label: 'Actual / mín.', num: true, render: (r) => `${r.current_stock} / ${r.minimum_stock}` },
                  { label: 'Faltan', num: true, render: (r) => r.units_to_minimum },
                  { label: 'Estado', render: (r) => <Badge kind="stock" code={r.stock_status} /> },
                ]}
                rows={low.data} empty="Sin productos bajo el mínimo"
              />
              <Pagination p={low.pagination} onChange={onPage} />
            </div>
          </Card>
          <Card title={`Por vencer (90 días) · ${exp.summary.batches} lotes`} tight>
            <div className="stack">
              <KV pairs={[['Costo vencido', money(exp.summary.expiredCost)], ['Costo por vencer', money(exp.summary.expiringCost)]]} />
              <Table
                columns={[
                  { label: 'Producto / lote', render: (r) => <Cell title={r.product_name} sub={`${r.batch_number} · ${r.branch_name}`} /> },
                  { label: 'Vence', render: (r) => (r.is_expired ? <span className="error">{`${date(r.expiry_date)} (vencido)`}</span> : `${date(r.expiry_date)} · ${r.days_to_expiry} d`) },
                  { label: 'Cant.', num: true, render: (r) => r.current_quantity },
                  { label: 'Costo', num: true, render: (r) => money(r.cost_value) },
                ]}
                rows={exp.data} empty="Sin lotes por vencer"
              />
            </div>
          </Card>
        </div>
        <Card title={`Movimientos del período · +${number(mov.data.unitsIn)} / −${number(mov.data.unitsOut)} u.`} tight>
          <Table
            columns={[
              { label: 'Tipo', render: (r) => <ToneBadge tone={r.direction === 'IN' ? 'success' : 'warning'}>{MOVEMENT_TYPES[r.movement_type] || r.movement_type}</ToneBadge> },
              { label: 'Movimientos', num: true, render: (r) => r.movements }, { label: 'Unidades', num: true, render: (r) => number(r.units) },
              { label: 'Costo', num: true, render: (r) => money(r.cost_value) },
            ]}
            rows={mov.data.byType} empty="Sin movimientos"
          />
        </Card>
      </>
    );
  },

  returns({ r }) {
    return (
      <>
        <div className="stats">
          <Stat label="Devoluciones" value={number(r.returns.count)} sub={`${number(r.returns.units)} unidades`} />
          <Stat label="Reembolsado" value={money(r.returns.refunds)} />
          <Stat label="Reingresadas al stock" value={number(r.returns.restockedUnits)} />
          <Stat label="Ventas anuladas" value={number(r.voids.count)} sub={money(r.voids.amount)} />
        </div>
        <div className="grid grid-3">
          <Card title="Por estado" tight><Table columns={[{ label: 'Estado', render: (x) => <Badge kind="return" code={x.status} /> }, { label: 'Cant.', num: true, key: 'count' }, { label: 'Reembolso', num: true, render: (x) => money(x.refund_amount) }]} rows={r.byStatus} empty="Sin datos" /></Card>
          <Card title="Por motivo" tight><Table columns={[{ label: 'Motivo', key: 'name' }, { label: 'Cant.', num: true, key: 'count' }]} rows={r.byReason} empty="Sin datos" /></Card>
          <Card title="Por condición" tight><Table columns={[{ label: 'Condición', render: (x) => CONDITIONS[x.item_condition] || x.item_condition }, { label: 'Unidades', num: true, key: 'units' }]} rows={r.byCondition} empty="Sin datos" /></Card>
        </div>
      </>
    );
  },

  orders({ r }) {
    return (
      <>
        <div className="stats">
          <Stat label="Pedidos" value={number(r.orders)} />
          <Stat label="Entregados" value={number(r.completed)} sub={r.completionRate !== null ? `${percent(r.completionRate)} de cumplimiento` : ''} />
          <Stat label="Cancelados / rechazados" value={number(r.cancelledOrRejected)} />
          <Stat label="Pedido promedio entregado" value={money(r.averageCompletedOrder)} sub={`Total ${money(r.completedTotal)}`} />
        </div>
        <Card title="Por estado y modalidad" tight>
          <Table
            columns={[
              { label: 'Estado', render: (x) => <Badge kind="order" code={x.status} /> }, { label: 'Modalidad', render: (x) => (x.fulfillment_type === 'PICKUP' ? 'Recojo' : 'Delivery') },
              { label: 'Pedidos', num: true, key: 'count' }, { label: 'Total', num: true, render: (x) => money(x.total) },
            ]}
            rows={r.byStatus} empty="Sin pedidos en el período"
          />
        </Card>
      </>
    );
  },

  cash({ r, onPage }) {
    const t = r.totals;
    return (
      <>
        <div className="stats">
          <Stat label="Sesiones" value={number(t.sessions)} sub={`${t.openSessions} abiertas`} />
          <Stat label="Esperado (cerradas)" value={money(t.expectedClosed)} />
          <Stat label="Contado" value={money(t.counted)} />
          <Stat label="Diferencia" value={money(t.difference)} />
        </div>
        <Card title="Movimientos de caja" tight>
          <Table
            columns={[
              { label: 'Tipo', render: (x) => x.movement_type }, { label: 'Dirección', render: (x) => (x.direction === 'IN' ? 'Ingreso' : 'Egreso') },
              { label: 'Cant.', num: true, key: 'count' }, { label: 'Importe', num: true, render: (x) => money(x.amount) },
            ]}
            rows={r.movements} empty="Sin movimientos"
          />
        </Card>
        <Card title="Sesiones" tight>
          <div>
            <Table
              columns={[
                { label: 'Sesión', render: (x) => <Cell title={x.session_number} sub={`${x.register_code} · ${x.opened_by_name}`} /> },
                { label: 'Apertura', render: (x) => dateTime(x.opened_at) }, { label: 'Cierre', render: (x) => dateTime(x.closed_at) },
                { label: 'Estado', render: (x) => <Badge kind="cash" code={x.status} /> },
                { label: 'Esperado', num: true, render: (x) => money(x.closing_expected_amount ?? x.current_expected_amount) },
                { label: 'Contado', num: true, render: (x) => money(x.counted_amount) }, { label: 'Diferencia', num: true, render: (x) => money(x.difference_amount) },
              ]}
              rows={r.data} empty="Sin sesiones"
            />
            <Pagination p={r.pagination} onChange={onPage} />
          </div>
        </Card>
      </>
    );
  },

  activity({ r, onPage }) {
    return (
      <Card title="Auditoría" tight>
        <div>
          <Table
            columns={[
              { label: 'Fecha', render: (x) => dateTime(x.created_at) }, { label: 'Usuario', render: (x) => x.user_name || 'Sistema' },
              { label: 'Módulo', key: 'module' }, { label: 'Acción', render: (x) => <span className="mono">{x.action}</span> },
              { label: 'Entidad', render: (x) => `${x.entity_table || ''}${x.entity_id ? ` #${x.entity_id}` : ''}` },
            ]}
            rows={r.data} empty="Sin actividad"
          />
          <Pagination p={r.pagination} onChange={onPage} />
        </div>
      </Card>
    );
  },
};
