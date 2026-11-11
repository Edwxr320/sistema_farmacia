import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAdmin, useRealtime } from '../context.jsx';
import {
  Card, PageHead, Table, Badge, Button, toast, KV, Pagination, Tabs, AlertBox, SearchInput, confirmDialog, useAsync, Async,
} from '../../components/ui.jsx';
import { openModal, ModalBody } from '../../components/modal.jsx';
import { money, dateTime, PAYMENT_METHODS, FULFILLMENT, errorMessage } from '../../core/format.js';
import { Cell } from './_shared.jsx';

const TABS = [
  { id: 'PENDING', label: 'Pendientes' }, { id: 'CONFIRMED', label: 'Confirmados' }, { id: 'PREPARING', label: 'En preparación' },
  { id: 'READY_FOR_PICKUP', label: 'Listos para recojo' }, { id: 'OUT_FOR_DELIVERY', label: 'En reparto' }, { id: 'COMPLETED', label: 'Entregados' },
  { id: 'CANCELLED', label: 'Cancelados' }, { id: 'REJECTED', label: 'Rechazados' },
];

export function Orders() {
  const ctx = useAdmin();
  const [params] = useSearchParams();
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const state = useAsync(() => ctx.api.get('/orders', { branchId: ctx.branchId, status, q, page, pageSize: 20 }), [status, q, page]);
  const reloadRef = useRef(state.reload);
  reloadRef.current = state.reload;

  const detail = (id) => openModal({ title: 'Pedido', size: 'xl', content: (p) => <OrderDetail id={id} onChanged={() => reloadRef.current()} {...p} /> });

  useRealtime('order:created', state.reload);
  useRealtime('order:status', state.reload);
  useEffect(() => {
    if (params.get('id')) detail(Number(params.get('id')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHead title="Pedidos online" sub="Pedidos de la tienda virtual: aceptar, preparar y entregar." />
      <div className="card card-body toolbar"><SearchInput placeholder="N.º de pedido o cliente…" onSearch={(v) => { setQ(v); setPage(1); }} /></div>
      <div><Tabs items={TABS} active={status} onChange={(s) => { setStatus(s); setPage(1); }} /></div>
      <div>
        <Async state={state}>
          {(r) => (
            <Card tight>
              <div>
                <Table
                  columns={[
                    { label: 'Pedido', render: (o) => <Cell title={o.orderNumber} sub={dateTime(o.createdAt)} /> },
                    { label: 'Cliente', render: (o) => <div>{o.customer.name}<div className="cell-sub">{o.customer.phone || ''}</div></div> },
                    { label: 'Modalidad', render: (o) => FULFILLMENT[o.fulfillmentType] },
                    { label: 'Estado', render: (o) => <Badge kind="order" code={o.status} /> },
                    { label: 'Pago', render: (o) => (o.balanceDue === '0.00' ? <Badge kind="payment" code="APPROVED" /> : `Saldo ${money(o.balanceDue)}`) },
                    { label: 'Asignado', render: (o) => o.assignedUser?.fullName || '—' },
                    { label: 'Total', num: true, render: (o) => money(o.total) },
                  ]}
                  rows={r.data} empty="No hay pedidos en este estado" onRowClick={(o) => detail(o.id)}
                />
                <Pagination p={r.pagination} onChange={setPage} />
              </div>
            </Card>
          )}
        </Async>
      </div>
    </>
  );
}

function OrderDetail({ id, onChanged, setTitle }) {
  const ctx = useAdmin();
  const state = useAsync(async () => {
    const { data } = await ctx.api.get(`/orders/${id}`);
    setTitle(`Pedido ${data.orderNumber}`);
    return data;
  }, [id]);
  const [rx, setRx] = useState({});
  const [tendered, setTendered] = useState('');

  async function act(fn) {
    try {
      await fn();
      toast('Pedido actualizado', 'success');
      await state.reload();
      onChanged();
      ctx.refreshBadges();
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  return (
    <ModalBody>
      <div className="stack">
        <Async state={state}>
          {(o) => {
            const manage = ctx.can('orders.manage');
            const rxItems = o.items.filter((i) => i.requiresPrescription);
            return (
              <>
                <div className="row between">
                  <div className="row"><Badge kind="order" code={o.status} />{FULFILLMENT[o.fulfillmentType]}</div>
                  <div className="row">
                    {manage && o.status === 'PENDING' ? (
                      <>
                        <Button variant="danger" onClick={async () => {
                          const ok = await confirmDialog({ title: 'Rechazar pedido', message: 'Se reembolsará el pago DEMO aprobado, si existe.', danger: true, reason: true, confirmText: 'Rechazar' });
                          if (ok) await act(() => ctx.api.post(`/orders/${id}/reject`, { reason: ok.reason }));
                        }}>Rechazar</Button>
                        <Button variant="primary" icon="check" onClick={() => act(() => {
                          const prescriptions = {};
                          for (const i of rxItems) { const v = (rx[String(i.productId)] || '').trim(); if (v) prescriptions[String(i.productId)] = v; }
                          return ctx.api.post(`/orders/${id}/accept`, rxItems.length ? { prescriptions } : {});
                        })}>Aceptar pedido</Button>
                      </>
                    ) : null}
                    {manage && o.status === 'CONFIRMED' ? <Button variant="primary" onClick={() => act(() => ctx.api.post(`/orders/${id}/prepare`, {}))}>Preparar</Button> : null}
                    {manage && o.status === 'PREPARING' ? <Button variant="primary" onClick={() => act(() => ctx.api.post(`/orders/${id}/ready`, {}))}>{o.fulfillmentType === 'PICKUP' ? 'Listo para recojo' : 'Enviar a reparto'}</Button> : null}
                    {manage && ['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'].includes(o.status) ? (
                      <>
                        {o.balanceDue !== '0.00' ? <input className="input" inputMode="decimal" placeholder={`Recibido (saldo ${money(o.balanceDue)})`} style={{ width: '210px' }} value={tendered} onChange={(e) => setTendered(e.target.value)} /> : null}
                        <Button variant="success" onClick={() => act(() => ctx.api.post(`/orders/${id}/complete`, tendered.trim() ? { tenderedAmount: tendered.trim() } : {}))}>{o.fulfillmentType === 'PICKUP' ? 'Registrar recojo' : 'Registrar entrega'}</Button>
                      </>
                    ) : null}
                    {manage && !['PENDING', 'COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) ? (
                      <Button variant="danger" onClick={async () => {
                        const ok = await confirmDialog({ title: 'Cancelar pedido', message: 'Se anulará la venta asociada, se repondrá el stock y se reembolsarán los pagos aprobados.', danger: true, reason: true, confirmText: 'Cancelar pedido' });
                        if (ok) await act(() => ctx.api.post(`/orders/${id}/cancel`, { reason: ok.reason }));
                      }}>Cancelar</Button>
                    ) : null}
                  </div>
                </div>
                {o.cancelReason ? <AlertBox tone="warning">{`Motivo: ${o.cancelReason}`}</AlertBox> : null}
                {o.status === 'PENDING' && o.balanceDue !== '0.00' ? <AlertBox tone="info">{`Pago contra ${o.fulfillmentType === 'PICKUP' ? 'recojo' : 'entrega'} en efectivo: ${money(o.balanceDue)}. Se cobra en caja al completar.`}</AlertBox> : null}
                {manage && o.status === 'PENDING' && rxItems.length ? (
                  <Card title="Validación de recetas">
                    <div className="stack">
                      <p className="small muted">{`Recetas declaradas por el cliente: ${o.customerNote || '—'}`}</p>
                      {rxItems.map((i) => (
                        <div className="field" key={i.productId}>
                          <label>{i.name}</label>
                          <input className="input" placeholder="N.º de receta verificado" value={rx[String(i.productId)] || ''} onChange={(e) => setRx((r) => ({ ...r, [String(i.productId)]: e.target.value }))} />
                        </div>
                      ))}
                    </div>
                  </Card>
                ) : null}
                <div className="grid grid-2">
                  <Card title="Cliente y entrega">
                    <KV pairs={[
                      ['Cliente', o.customer.name], ['Teléfono', o.customer.phone], ['Modalidad', FULFILLMENT[o.fulfillmentType]],
                      o.delivery ? ['Dirección', `${o.delivery.addressLine}${o.delivery.district ? `, ${o.delivery.district}` : ''}`] : null,
                      o.delivery ? ['Recibe', `${o.delivery.recipientName || ''} · ${o.delivery.phone}`] : null,
                      o.delivery?.reference ? ['Referencia', o.delivery.reference] : null,
                      ['Nota del cliente', o.customerNote], ['Venta', o.sale ? `${o.sale.saleNumber} (${o.sale.status === 'COMPLETED' ? 'vigente' : 'anulada'})` : '—'],
                    ]} />
                  </Card>
                  <Card title="Importes">
                    <KV pairs={[['Subtotal', money(o.subtotal)], ['Delivery', money(o.deliveryFee)], ['Total', <strong>{money(o.total)}</strong>], ['Pagado', money(o.paidAmount)], ['Saldo', money(o.balanceDue)]]} />
                  </Card>
                </div>
                <Card title="Productos" tight>
                  <Table
                    columns={[
                      { label: 'Producto', render: (i) => <Cell title={i.name} sub={`${i.sku}${i.requiresPrescription ? ' · requiere receta' : ''}`} /> },
                      { label: 'Cant.', num: true, render: (i) => i.quantity },
                      { label: 'P. unit.', num: true, render: (i) => money(i.unitPrice) },
                      { label: 'Total', num: true, render: (i) => money(i.lineTotal) },
                    ]}
                    rows={o.items}
                  />
                </Card>
                <div className="grid grid-2">
                  <Card title="Pagos" tight>
                    <Table
                      columns={[
                        { label: 'Método', render: (p) => `${PAYMENT_METHODS[p.method]}${p.mode === 'DEMO' ? ' (DEMO)' : ''}` },
                        { label: 'Estado', render: (p) => <Badge kind="payment" code={p.status} /> },
                        { label: 'Referencia', render: (p) => p.reference || p.failureReason },
                        { label: 'Importe', num: true, render: (p) => money(p.amount) },
                      ]}
                      rows={o.payments} empty="Sin pagos registrados"
                    />
                  </Card>
                  <Card title="Historial" tight>
                    <Table
                      columns={[
                        { label: 'Fecha', render: (x) => dateTime(x.at) },
                        { label: 'Estado', render: (x) => <Badge kind="order" code={x.to} /> },
                        { label: 'Por', render: (x) => (x.by ? x.by.fullName || x.by.role : 'Cliente') },
                        { label: 'Nota', render: (x) => x.note },
                      ]}
                      rows={o.history}
                    />
                  </Card>
                </div>
              </>
            );
          }}
        </Async>
      </div>
    </ModalBody>
  );
}
