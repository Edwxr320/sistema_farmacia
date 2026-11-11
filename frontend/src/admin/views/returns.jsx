import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAdmin } from '../context.jsx';
import {
  Card, PageHead, Table, Badge, Button, toast, KV, Pagination, Tabs, AlertBox, Spinner, confirmDialog, useAsync, Async,
} from '../../components/ui.jsx';
import { openModal, ModalBody } from '../../components/modal.jsx';
import { money, dateTime, date, PAYMENT_METHODS, CONDITIONS, errorMessage } from '../../core/format.js';
import { Cell } from './_shared.jsx';

const TABS = [{ id: 'REQUESTED', label: 'Solicitadas' }, { id: 'APPROVED', label: 'Aprobadas' }, { id: 'COMPLETED', label: 'Completadas' }, { id: 'REJECTED', label: 'Rechazadas' }, { id: '', label: 'Todas' }];

export function Returns() {
  const ctx = useAdmin();
  const [params] = useSearchParams();
  const [status, setStatus] = useState('REQUESTED');
  const [page, setPage] = useState(1);
  const state = useAsync(() => ctx.api.get('/returns', { branchId: ctx.branchId, status, page, pageSize: 20 }), [status, page]);
  const reloadRef = useRef(state.reload);
  reloadRef.current = state.reload;
  const onChanged = () => reloadRef.current();

  const detail = (id) => openModal({ title: 'Devolución', size: 'lg', content: (p) => <ReturnDetail id={id} onChanged={onChanged} {...p} /> });
  const startReturn = (saleId) => openModal({ title: 'Nueva devolución', size: 'xl', content: (p) => <NewReturn saleId={saleId} onCreated={(id) => { onChanged(); detail(id); }} {...p} /> });

  useEffect(() => {
    if (params.get('saleId') && ctx.can('returns.create')) startReturn(Number(params.get('saleId')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHead
        title="Devoluciones" sub="Devoluciones parciales y totales, reingreso de unidades aptas y reembolsos."
        actions={ctx.can('returns.create') ? <Button variant="primary" icon="plus" onClick={() => startReturn()}>Nueva devolución</Button> : null}
      />
      <div><Tabs items={TABS} active={status} onChange={(s) => { setStatus(s); setPage(1); }} /></div>
      <div>
        <Async state={state}>
          {(r) => (
            <Card tight>
              <div>
                <Table
                  columns={[
                    { label: 'Devolución', render: (x) => <Cell title={x.returnNumber} sub={`Venta ${x.sale.saleNumber}`} /> },
                    { label: 'Fecha', render: (x) => dateTime(x.requestedAt) },
                    { label: 'Tipo', render: (x) => (x.returnType === 'TOTAL' ? 'Total' : 'Parcial') },
                    { label: 'Motivo', render: (x) => x.reason.name },
                    { label: 'Estado', render: (x) => <Badge kind="return" code={x.status} /> },
                    { label: 'Reembolso', num: true, render: (x) => money(x.refundAmount) },
                  ]}
                  rows={r.data} empty="Sin devoluciones" onRowClick={(x) => detail(x.id)}
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

// ---------------------------------------------------------------- nueva
function NewReturn({ saleId, onCreated, close }) {
  const ctx = useAdmin();
  const [term, setTerm] = useState('');
  const [area, setArea] = useState(null); // { loading } | { error } | { d, reasons }
  const inputRef = useRef(null);

  async function lookup(id) {
    setArea({ loading: true });
    try {
      const t = term.trim();
      const r = id ? await ctx.api.get(`/returns/sales/${id}`)
        : await ctx.api.get('/returns/lookup', t.toUpperCase().startsWith('T') ? { ticketNumber: t } : { saleNumber: t });
      const reasons = (await ctx.api.get('/returns/reasons')).data;
      setArea({ d: r.data, reasons });
    } catch (err) { setArea({ error: err }); }
  }

  useEffect(() => {
    if (saleId) lookup(saleId);
    else inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ModalBody>
      <div className="stack">
        <div className="row">
          <div className="grow">
            <input ref={inputRef} className="input" placeholder="N.º de ticket (T-…) o de venta (V-…)" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }} />
          </div>
          <Button icon="search" onClick={() => lookup()}>Buscar</Button>
        </div>
        <div>
          {area?.loading ? <Spinner /> : null}
          {area?.error ? <AlertBox tone="danger">{errorMessage(area.error)}</AlertBox> : null}
          {area?.d ? <Returnable key={area.d.sale.id} d={area.d} reasons={area.reasons} onCreated={onCreated} close={close} /> : null}
        </div>
      </div>
    </ModalBody>
  );
}

function Returnable({ d, reasons, onCreated, close }) {
  const ctx = useAdmin();
  const [lines, setLines] = useState(() => Object.fromEntries(d.items.map((i) => [i.saleItemBatchId, { qty: '0', cond: i.isExpired ? 'EXPIRED' : 'RESELLABLE' }])));
  const [reasonId, setReasonId] = useState(String(reasons[0]?.id ?? ''));
  const [notes, setNotes] = useState('');
  const canProcess = ctx.can('returns.approve') && ctx.can('payments.refund');
  const [process, setProcess] = useState(canProcess);
  const [method, setMethod] = useState(d.paymentMethods[0] || '');

  if (!d.canReturn) return <AlertBox tone="warning">{d.sale.status === 'VOIDED' ? 'La venta está anulada.' : 'No quedan unidades por devolver en esta venta.'}</AlertBox>;
  const setLine = (id, patch) => setLines((l) => ({ ...l, [id]: { ...l[id], ...patch } }));

  async function save() {
    const items = d.items.filter((i) => Number(lines[i.saleItemBatchId]?.qty) > 0)
      .map((i) => ({ saleItemBatchId: i.saleItemBatchId, quantity: Number(lines[i.saleItemBatchId].qty), condition: lines[i.saleItemBatchId].cond }));
    if (!items.length) { toast('Indique al menos una cantidad a devolver', 'warning'); return; }
    try {
      const r = await ctx.api.post('/returns', {
        saleId: d.sale.id, reasonId: Number(reasonId), notes: notes.trim() || undefined, items,
        ...(canProcess && process ? { process: true, refundMethod: method } : {}),
      });
      toast(`Devolución ${r.data.returnNumber} ${r.data.status === 'COMPLETED' ? 'completada' : 'registrada'}`, 'success');
      close();
      onCreated(r.data.id);
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  return (
    <div className="stack">
      <AlertBox tone="info">{`Venta ${d.sale.saleNumber} · ${dateTime(d.sale.soldAt)} · total ${money(d.sale.total)}. Solo las unidades aptas reingresan al stock.`}</AlertBox>
      <Card tight>
        <Table
          columns={[
            { label: 'Producto / lote', render: (i) => <Cell title={i.productName} sub={`Lote ${i.batchNumber} · vence ${date(i.expiryDate)}${i.isExpired ? ' (vencido)' : ''}`} /> },
            { label: 'Vendido / devuelto', num: true, render: (i) => `${i.soldQuantity} / ${i.returnedQuantity}` },
            { label: 'Reembolso u.', num: true, render: (i) => money(i.unitRefundAmount) },
            { label: 'Devolver', render: (i) => (i.returnableQuantity > 0 ? (
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input className="input" type="number" min={0} max={i.returnableQuantity} style={{ width: '84px' }} aria-label={`Cantidad a devolver de ${i.productName}`}
                  value={lines[i.saleItemBatchId].qty} onChange={(e) => setLine(i.saleItemBatchId, { qty: e.target.value })} />
                <select className="input" aria-label="Condición" value={lines[i.saleItemBatchId].cond} onChange={(e) => setLine(i.saleItemBatchId, { cond: e.target.value })}>
                  {Object.entries(CONDITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            ) : <span className="muted small">Sin unidades</span>) },
          ]}
          rows={d.items}
        />
      </Card>
      <div className="form-grid">
        <div className="field"><label>Motivo *</label>
          <select className="input" value={reasonId} onChange={(e) => setReasonId(e.target.value)}>{reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        </div>
        <div className="field"><label>Reembolso por</label>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>{d.paymentMethods.map((m) => <option key={m} value={m}>{PAYMENT_METHODS[m]}</option>)}</select>
        </div>
        <div className="field full"><label>Observaciones</label>
          <textarea className="input" placeholder="Observaciones" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {canProcess
          ? <label className="check full"><input type="checkbox" checked={process} onChange={(e) => setProcess(e.target.checked)} />Aprobar, reingresar y reembolsar ahora</label>
          : <p className="small muted full">Quedará solicitada para que un supervisor la apruebe.</p>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="primary" icon="check" onClick={save}>Registrar devolución</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- detalle
function ReturnDetail({ id, onChanged, setTitle }) {
  const ctx = useAdmin();
  const state = useAsync(async () => {
    const { data: x } = await ctx.api.get(`/returns/${id}`);
    setTitle(`Devolución ${x.returnNumber}`);
    let methods = [];
    if (ctx.can('returns.approve') && x.status === 'APPROVED') {
      const sale = await ctx.api.get(`/returns/sales/${x.sale.id}`).catch(() => null);
      methods = sale?.data.paymentMethods || [];
    }
    return { x, methods };
  }, [id]);
  const [method, setMethod] = useState('');

  async function act(fn) {
    try { await fn(); toast('Devolución actualizada', 'success'); state.reload(); onChanged(); } catch (err) { toast(errorMessage(err), 'error'); }
  }

  return (
    <ModalBody>
      <div className="stack">
        <Async state={state}>
          {({ x, methods }) => (
            <>
              <div className="row between">
                <div className="row"><Badge kind="return" code={x.status} />{x.returnType === 'TOTAL' ? 'Total' : 'Parcial'}</div>
                <div className="row">
                  {ctx.can('returns.approve') && x.status === 'REQUESTED' ? (
                    <>
                      <Button variant="danger" onClick={async () => {
                        const ok = await confirmDialog({ title: 'Rechazar devolución', message: 'La solicitud quedará como historial.', danger: true, reason: true, confirmText: 'Rechazar' });
                        if (ok) await act(() => ctx.api.post(`/returns/${id}/reject`, { reason: ok.reason }));
                      }}>Rechazar</Button>
                      <Button variant="primary" onClick={() => act(() => ctx.api.post(`/returns/${id}/approve`, {}))}>Aprobar</Button>
                    </>
                  ) : null}
                  {ctx.can('returns.approve') && x.status === 'APPROVED' ? (
                    <>
                      <select className="input" style={{ width: 'auto' }} value={method || methods[0] || ''} onChange={(e) => setMethod(e.target.value)}>
                        {methods.map((m) => <option key={m} value={m}>{PAYMENT_METHODS[m]}</option>)}
                      </select>
                      <Button variant="success" onClick={() => act(() => ctx.api.post(`/returns/${id}/complete`, { refundMethod: (method || methods[0]) || undefined }))}>Completar y reembolsar</Button>
                    </>
                  ) : null}
                </div>
              </div>
              {x.rejectionReason ? <AlertBox tone="danger">{`Rechazada: ${x.rejectionReason}`}</AlertBox> : null}
              <KV pairs={[['Venta', x.sale.saleNumber], ['Motivo', x.reason.name], ['Solicitada por', `${x.requestedBy.fullName} · ${dateTime(x.requestedAt)}`],
                ['Revisada por', x.reviewedBy ? `${x.reviewedBy.fullName} · ${dateTime(x.reviewedAt)}` : '—'], ['Reembolso', `${money(x.refundAmount)} ${x.refundMethod ? `· ${PAYMENT_METHODS[x.refundMethod]}` : ''}`],
                ['Referencia', x.refundOperationCode], ['Observaciones', x.notes]]} />
              <Table
                columns={[
                  { label: 'Producto', render: (i) => <Cell title={i.productName} sub={`Lote ${i.batchNumber}`} /> },
                  { label: 'Condición', render: (i) => CONDITIONS[i.condition] },
                  { label: 'Reingreso', render: (i) => (i.restock ? (i.returnInMovementId ? 'Reingresado' : 'Pendiente') : 'No reingresa') },
                  { label: 'Cant.', num: true, render: (i) => i.quantity },
                  { label: 'Reembolso', num: true, render: (i) => money(i.lineRefundAmount) },
                ]}
                rows={x.items}
              />
            </>
          )}
        </Async>
      </div>
    </ModalBody>
  );
}
