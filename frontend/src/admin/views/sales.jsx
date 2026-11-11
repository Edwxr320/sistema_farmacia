import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAdmin, useRealtime } from '../context.jsx';
import {
  Card, PageHead, Table, Badge, Button, toast, KV, Pagination, SearchInput, Select, DateInput, confirmDialog, printUrl, ToneBadge, AlertBox, useAsync, Async,
} from '../../components/ui.jsx';
import { openModal, ModalBody } from '../../components/modal.jsx';
import { money, dateTime, date, PAYMENT_METHODS, todayLima, addDays, errorMessage } from '../../core/format.js';
import { Cell } from './_shared.jsx';

function SaleDetail({ id, onChange, close, setTitle }) {
  const ctx = useAdmin();
  const state = useAsync(async () => {
    const { data } = await ctx.api.get(`/sales/${id}`);
    setTitle(`Venta ${data.saleNumber}`);
    return data;
  }, [id]);

  return (
    <ModalBody>
      <div className="stack">
        <Async state={state}>
          {(s) => (
            <>
              <div className="row between">
                <div className="row">
                  <Badge kind="sale" code={s.status} />
                  <ToneBadge tone="info">{s.channel === 'ONLINE' ? 'Online' : 'POS'}</ToneBadge>
                  {s.paymentState ? <ToneBadge tone={s.paymentState === 'PAID' ? 'success' : 'warning'}>{s.paymentState === 'PAID' ? 'Pagada' : s.paymentState}</ToneBadge> : null}
                </div>
                <div className="row">
                  {s.ticket && (ctx.can('tickets.print') || ctx.can('sales.view'))
                    ? <Button icon="receipt" onClick={() => window.open(`/api/sales/${s.id}/ticket?format=html`, '_blank')}>Ver ticket</Button> : null}
                  {s.ticket && ctx.can('tickets.print') ? (
                    <Button icon="printer" onClick={async () => {
                      try { await ctx.api.post(`/sales/${s.id}/ticket/print`); printUrl(`/api/sales/${s.id}/ticket?format=html`); state.reload(); } catch (err) { toast(errorMessage(err), 'error'); }
                    }}>{s.ticket.printCount ? 'Reimprimir' : 'Imprimir'}</Button>
                  ) : null}
                  {s.status === 'COMPLETED' && ctx.can('sales.void') ? (
                    <Button variant="danger" icon="x" onClick={async () => {
                      const ok = await confirmDialog({
                        title: `Anular ${s.saleNumber}`, danger: true, confirmText: 'Anular', reason: true,
                        message: 'Se repondrá cada lote al inventario y se reembolsarán los pagos aprobados (el efectivo sale de su caja abierta). La venta se conserva como anulada.',
                      });
                      if (!ok) return;
                      try {
                        await ctx.api.post(`/sales/${s.id}/void`, { reason: ok.reason });
                        toast('Venta anulada', 'success');
                        state.reload();
                        if (onChange) onChange();
                      } catch (err) { toast(errorMessage(err), 'error'); }
                    }}>Anular venta</Button>
                  ) : null}
                  {s.status === 'COMPLETED' && ctx.can('returns.create')
                    ? <Button icon="undo" onClick={() => { close(); ctx.navigate('returns', { saleId: s.id }); }}>Devolución</Button> : null}
                </div>
              </div>
              {s.void ? <AlertBox tone="danger">{`Anulada el ${dateTime(s.void.voidedAt)} por ${s.void.voidedBy.fullName}: ${s.void.reason}`}</AlertBox> : null}
              <div className="grid grid-2">
                <Card title="Datos">
                  <KV pairs={[
                    ['Fecha', dateTime(s.soldAt)], ['Sucursal', s.branch.name], ['Vendedor', s.seller.fullName],
                    ['Caja', s.cashSession?.sessionNumber], ['Cliente', s.customer ? `${s.customer.name ?? ''} ${s.customer.document ? `(${s.customer.document})` : ''}` : 'Venta sin cliente'],
                    ['Ticket', s.ticket ? `${s.ticket.ticketNumber} · impreso ${s.ticket.printCount} vez/veces` : '—'],
                  ]} />
                </Card>
                <Card title="Importes">
                  <KV pairs={[['Subtotal', money(s.subtotal)], ['Descuento', money(s.discountTotal)], ['Total', <strong>{money(s.total)}</strong>],
                    ['Cobrado', money(s.approvedAmount)], ['Reembolsado', money(s.refundedAmount)]]} />
                </Card>
              </div>
              <Card title="Productos y lotes (FEFO)" tight>
                <Table
                  columns={[
                    { label: 'Producto', render: (i) => <Cell title={i.name} sub={i.sku} /> },
                    { label: 'Lotes', render: (i) => i.batches.map((b) => `${b.batchNumber} ×${b.quantity} (vence ${date(b.expiryDate)})${b.voidInMovementId ? ' · repuesto' : ''}`).join(' · ') },
                    { label: 'Cant.', num: true, render: (i) => i.quantity },
                    { label: 'P. unit.', num: true, render: (i) => money(i.unitPrice) },
                    { label: 'Desc.', num: true, render: (i) => money(i.discountAmount) },
                    { label: 'Total', num: true, render: (i) => money(i.lineTotal) },
                  ]}
                  rows={s.items}
                />
              </Card>
              <Card title="Pagos" tight>
                <Table
                  columns={[
                    { label: 'Operación', render: (p) => p.operationCode },
                    { label: 'Método', render: (p) => `${PAYMENT_METHODS[p.method]}${p.mode === 'DEMO' ? ' (DEMO)' : ''}` },
                    { label: 'Estado', render: (p) => <Badge kind="payment" code={p.status} /> },
                    { label: 'Referencia', render: (p) => p.externalReference || (p.tenderedAmount ? `Recibido ${money(p.tenderedAmount)} · vuelto ${money(p.changeAmount)}` : p.failureReason) },
                    { label: 'Importe', num: true, render: (p) => money(p.amount) },
                  ]}
                  rows={s.payments}
                />
              </Card>
            </>
          )}
        </Async>
      </div>
    </ModalBody>
  );
}

export function openSaleDetail(id, onChange) {
  openModal({ title: 'Detalle de venta', size: 'xl', content: (p) => <SaleDetail id={id} onChange={onChange} {...p} /> });
}

export function Sales() {
  const ctx = useAdmin();
  const [params] = useSearchParams();
  const [f, setF] = useState({ page: 1, q: '', status: '', from: addDays(todayLima(), -6), to: todayLima() });
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));

  const state = useAsync(
    () => ctx.api.get('/sales', { branchId: ctx.branchId, page: f.page, pageSize: 20, q: f.q, status: f.status, from: f.from, to: f.to }),
    [f],
  );
  useRealtime('sale:created', state.reload);
  useRealtime('sale:voided', state.reload);

  useEffect(() => {
    if (params.get('id')) openSaleDetail(Number(params.get('id')), state.reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHead title="Ventas" sub="Historial de ventas POS y online de la sucursal." />
      <div className="card card-body toolbar">
        <SearchInput placeholder="N.º de venta o cliente…" onSearch={(q) => set({ q })} />
        <Select options={[{ value: 'COMPLETED', label: 'Completadas' }, { value: 'VOIDED', label: 'Anuladas' }]} value={f.status} onChange={(status) => set({ status })} label="Estado" placeholder="Todas" />
        <DateInput value={f.from} onChange={(from) => setF((x) => ({ ...x, from }))} label="Desde" />
        <DateInput value={f.to} onChange={(to) => setF((x) => ({ ...x, to }))} label="Hasta" />
      </div>
      <div>
        <Async state={state}>
          {(r) => (
            <Card tight>
              <div>
                <Table
                  columns={[
                    { label: 'Venta', render: (s) => <Cell title={s.saleNumber} sub={s.channel} /> },
                    { label: 'Fecha', render: (s) => dateTime(s.soldAt) },
                    { label: 'Cliente', render: (s) => s.customer?.name || '—' },
                    { label: 'Vendedor', render: (s) => s.seller.fullName },
                    { label: 'Estado', render: (s) => <Badge kind="sale" code={s.status} /> },
                    { label: 'Total', num: true, render: (s) => money(s.total) },
                  ]}
                  rows={r.data} empty="Sin ventas con esos filtros" onRowClick={(s) => openSaleDetail(s.id, state.reload)}
                />
                <Pagination p={r.pagination} onChange={(page) => setF((x) => ({ ...x, page }))} />
              </div>
            </Card>
          )}
        </Async>
      </div>
    </>
  );
}
