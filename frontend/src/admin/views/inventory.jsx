import React, { useState } from 'react';
import { useAdmin, useRealtime } from '../context.jsx';
import {
  Card, PageHead, Table, Badge, Button, toast, Pagination, SearchInput, Select, DateInput, Tabs, ToneBadge, useAsync, Async,
} from '../../components/ui.jsx';
import { formModal } from '../../components/form.jsx';
import { money, number, date, dateTime, MOVEMENT_TYPES, todayLima, addDays, errorMessage } from '../../core/format.js';
import { ProductPicker, Cell } from './_shared.jsx';

function Listing({ state, columns, empty, onPage }) {
  return (
    <div>
      <Async state={state}>
        {(r) => (
          <Card tight>
            <div>
              <Table columns={columns} rows={r.data} empty={empty} />
              <Pagination p={r.pagination} onChange={onPage} />
            </div>
          </Card>
        )}
      </Async>
    </div>
  );
}

// ------------------------------------------------------------------- stock
export function Stock() {
  const ctx = useAdmin();
  const [f, setF] = useState({ q: '', stockStatus: '', onlyAvailable: '', page: 1 });
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const state = useAsync(() => ctx.api.get('/inventory', { branchId: ctx.branchId, ...f, pageSize: 25 }), [f]);
  useRealtime('inventory:changed', state.reload);
  return (
    <>
      <PageHead title="Stock" sub={`Existencias por producto en ${ctx.branchName(ctx.branchId)}. Disponible = lotes activos no vencidos.`} />
      <div className="card card-body toolbar">
        <SearchInput placeholder="Producto o SKU…" onSearch={(q) => set({ q })} />
        <Select options={[{ value: 'OK', label: 'Normal' }, { value: 'LOW_STOCK', label: 'Stock bajo' }, { value: 'OUT_OF_STOCK', label: 'Agotado' }]} value={f.stockStatus} onChange={(v) => set({ stockStatus: v })} label="Estado" placeholder="Todos" />
        <Select options={[{ value: 'true', label: 'Solo con stock disponible' }]} value={f.onlyAvailable} onChange={(v) => set({ onlyAvailable: v })} label="Disponibilidad" placeholder="Todos" />
      </div>
      <Listing
        state={state} empty="Sin productos con esos filtros" onPage={(page) => setF((x) => ({ ...x, page }))}
        columns={[
          { label: 'Producto', render: (s) => <Cell title={s.productName} sub={`${s.sku}${s.shelfLocation ? ` · ${s.shelfLocation}` : ''}`} /> },
          { label: 'Categoría', key: 'categoryName' },
          { label: 'Físico', num: true, render: (s) => number(s.physicalStock) },
          { label: 'Disponible', num: true, render: (s) => <strong>{number(s.availableStock)}</strong> },
          { label: 'Vencido', num: true, render: (s) => (s.expiredStock ? <span className="error">{number(s.expiredStock)}</span> : '0') },
          { label: 'Bloqueado', num: true, render: (s) => number(s.blockedStock) },
          { label: 'Mín. / máx.', num: true, render: (s) => `${number(s.minimumStock)} / ${s.maximumStock ?? '—'}` },
          { label: 'Próx. venc.', render: (s) => date(s.nextExpiryDate) },
          { label: 'Precio', num: true, render: (s) => money(s.effectiveSalePrice) },
          { label: 'Estado', render: (s) => <Badge kind="stock" code={s.stockStatus} /> },
        ]}
      />
    </>
  );
}

// -------------------------------------------------------------- lotes
export function Batches() {
  const ctx = useAdmin();
  const [f, setF] = useState({ view: 'expiring', status: '', page: 1, productId: '' });
  const [productLabel, setProductLabel] = useState('');
  const state = useAsync(() => {
    const q = { branchId: ctx.branchId, page: f.page, pageSize: 25, withStock: 'true', status: f.status, productId: f.productId || undefined };
    if (f.view === 'expiring') { q.expiringWithinDays = 90; q.expired = 'false'; }
    if (f.view === 'expired') q.expired = 'true';
    return ctx.api.get('/inventory/batches', q);
  }, [f]);
  return (
    <>
      <PageHead title="Lotes y vencimientos" sub="Control de lotes por fecha de vencimiento (FEFO)." />
      <div className="card card-body toolbar">
        <div className="grow" style={{ minWidth: '240px' }}>
          <ProductPicker status="" onPick={(p) => { setProductLabel(`Producto: ${p.name}`); setF((x) => ({ ...x, productId: p.id, page: 1 })); }} />
        </div>
        <span className="small">{productLabel}</span>
        <Button size="sm" variant="ghost" onClick={() => { setProductLabel(''); setF((x) => ({ ...x, productId: '' })); }}>Quitar filtro</Button>
        <Select options={[{ value: 'ACTIVE', label: 'Activo' }, { value: 'QUARANTINE', label: 'Cuarentena' }, { value: 'RECALLED', label: 'Retirado' }, { value: 'DEPLETED', label: 'Agotado' }]} value={f.status} onChange={(v) => setF((x) => ({ ...x, status: v }))} label="Estado del lote" placeholder="Todos" />
      </div>
      <div><Tabs items={[{ id: 'expiring', label: 'Por vencer (90 días)' }, { id: 'expired', label: 'Vencidos con stock' }, { id: 'all', label: 'Todos con stock' }]} active={f.view} onChange={(v) => setF((x) => ({ ...x, view: v, page: 1 }))} /></div>
      <Listing
        state={state} empty="Sin lotes para este filtro" onPage={(page) => setF((x) => ({ ...x, page }))}
        columns={[
          { label: 'Producto', render: (b) => <Cell title={b.product_name} sub={b.sku} /> },
          { label: 'Lote', render: (b) => <Cell mono title={b.batch_number} sub={b.entry_number || ''} /> },
          { label: 'Vencimiento', render: (b) => <div>{date(b.expiry_date)}<div className="cell-sub">{b.days_to_expiry <= 0 ? 'Vencido' : `${b.days_to_expiry} días`}</div></div> },
          { label: 'Vigencia', render: (b) => <Badge kind="expiry" code={b.expiry_status} /> },
          { label: 'Estado', render: (b) => <Badge kind="batch" code={b.status} /> },
          { label: 'Stock', num: true, render: (b) => number(b.current_quantity) },
          { label: 'Costo u.', num: true, render: (b) => money(b.unit_cost) },
        ]}
      />
    </>
  );
}

// -------------------------------------------------------------- kardex
export function Kardex() {
  const ctx = useAdmin();
  const [f, setF] = useState({ movementType: '', from: addDays(todayLima(), -30), to: todayLima(), productId: '', page: 1 });
  const [productLabel, setProductLabel] = useState('');
  const state = useAsync(() => ctx.api.get('/inventory/movements', { branchId: ctx.branchId, ...f, productId: f.productId || undefined, pageSize: 30 }), [f]);
  return (
    <>
      <PageHead title="Kardex" sub="Historial inmutable de movimientos de inventario por lote." />
      <div className="card card-body toolbar">
        <div className="grow" style={{ minWidth: '240px' }}>
          <ProductPicker status="" onPick={(p) => { setProductLabel(`Producto: ${p.name}`); setF((x) => ({ ...x, productId: p.id, page: 1 })); }} />
        </div>
        <span className="small">{productLabel}</span>
        <Select options={Object.entries(MOVEMENT_TYPES).map(([value, label]) => ({ value, label }))} value={f.movementType} onChange={(v) => setF((x) => ({ ...x, movementType: v, page: 1 }))} label="Tipo" placeholder="Todos" />
        <DateInput value={f.from} onChange={(v) => setF((x) => ({ ...x, from: v }))} label="Desde" />
        <DateInput value={f.to} onChange={(v) => setF((x) => ({ ...x, to: v }))} label="Hasta" />
      </div>
      <Listing
        state={state} empty="Sin movimientos en el período" onPage={(page) => setF((x) => ({ ...x, page }))}
        columns={[
          { label: 'Fecha', render: (m) => dateTime(m.created_at) },
          { label: 'Producto / lote', render: (m) => <Cell title={m.product_name} sub={`Lote ${m.batch_number}`} /> },
          { label: 'Movimiento', render: (m) => <ToneBadge tone={m.direction === 'IN' ? 'success' : 'warning'}>{MOVEMENT_TYPES[m.movement_type] || m.movement_type}</ToneBadge> },
          { label: 'Documento', render: (m) => m.source_document },
          { label: 'Cant.', num: true, render: (m) => `${m.direction === 'IN' ? '+' : '−'}${number(m.quantity)}` },
          { label: 'Lote antes → después', num: true, render: (m) => `${m.batch_stock_before} → ${m.batch_stock_after}` },
          { label: 'Producto antes → después', num: true, render: (m) => `${m.stock_before} → ${m.stock_after}` },
          { label: 'Usuario', render: (m) => m.performed_by_name },
        ]}
      />
    </>
  );
}

// -------------------------------------------------------------- alertas
export function Alerts() {
  const ctx = useAdmin();
  const [f, setF] = useState({ status: 'OPEN', alertType: '', page: 1 });
  const state = useAsync(() => ctx.api.get('/inventory/alerts', { branchId: ctx.branchId, ...f, pageSize: 25 }), [f]);
  useRealtime('alerts:changed', state.reload);

  async function close(a) {
    const ok = await formModal({
      title: 'Cerrar alerta',
      fields: [
        { name: 'status', label: 'Acción', type: 'select', required: true, value: 'RESOLVED', options: [{ value: 'RESOLVED', label: 'Resolver' }, { value: 'DISMISSED', label: 'Descartar' }] },
        { name: 'note', label: 'Nota', type: 'textarea', required: true, full: true },
      ],
      submitLabel: 'Cerrar alerta',
      onSubmit: (v) => ctx.api.post(`/inventory/alerts/${a.id}/close`, v),
    });
    if (ok) { toast('Alerta cerrada', 'success'); state.reload(); ctx.refreshBadges(); }
  }

  return (
    <>
      <PageHead
        title="Alertas de inventario" sub="Stock bajo, agotados y vencimientos."
        actions={ctx.can('alerts.resolve') ? (
          <Button icon="refresh" onClick={async () => {
            try {
              const r = await ctx.api.post('/inventory/alerts/refresh-expiry', {});
              toast(r.data.executed ? 'Alertas de vencimiento actualizadas' : 'Otra actualización está en curso', r.data.executed ? 'success' : 'warning');
              state.reload();
            } catch (err) { toast(errorMessage(err), 'error'); }
          }}>Actualizar vencimientos</Button>
        ) : null}
      />
      <div className="card card-body toolbar">
        <Select options={[{ value: 'LOW_STOCK', label: 'Stock bajo' }, { value: 'OUT_OF_STOCK', label: 'Agotado' }, { value: 'EXPIRING_SOON', label: 'Por vencer' }, { value: 'EXPIRED', label: 'Vencido' }]}
          value={f.alertType} onChange={(v) => setF((x) => ({ ...x, alertType: v, page: 1 }))} label="Tipo" placeholder="Todos" />
      </div>
      <div><Tabs items={[{ id: 'OPEN', label: 'Abiertas' }, { id: 'RESOLVED', label: 'Resueltas' }, { id: 'DISMISSED', label: 'Descartadas' }]} active={f.status} onChange={(s) => setF((x) => ({ ...x, status: s, page: 1 }))} /></div>
      <Listing
        state={state} empty={f.status === 'OPEN' ? 'No hay alertas abiertas' : 'Sin alertas'} onPage={(page) => setF((x) => ({ ...x, page }))}
        columns={[
          { label: 'Alerta', render: (a) => <Badge kind="alert" code={a.alertType} /> },
          { label: 'Producto', render: (a) => <Cell title={a.product.name} sub={a.batch ? `Lote ${a.batch.batchNumber}` : a.product.sku} /> },
          { label: 'Detalle', render: (a) => a.message },
          { label: 'Cant.', num: true, render: (a) => number(a.stockAtAlert) },
          { label: 'Vence', render: (a) => date(a.expiryDateAtAlert) },
          { label: 'Creada', render: (a) => dateTime(a.createdAt) },
          { label: f.status === 'OPEN' ? '' : 'Cierre', render: (a) => (a.status === 'OPEN'
            ? (ctx.can('alerts.resolve') ? <Button size="sm" onClick={() => close(a)}>Cerrar</Button> : null)
            : `${a.resolvedBy?.fullName || 'Automática'} · ${a.resolutionNote || ''}`) },
        ]}
      />
    </>
  );
}
