import React, { useRef, useState } from 'react';
import { useAdmin, useRealtime } from '../context.jsx';
import {
  Card, PageHead, Table, Badge, Button, toast, KV, Pagination, Tabs, AlertBox, EmptyState, confirmDialog, useAsync, Async,
} from '../../components/ui.jsx';
import { openModal, ModalBody, ModalFoot } from '../../components/modal.jsx';
import { number, date, dateTime, errorMessage } from '../../core/format.js';
import { ProductPicker, batchesOf, Cell } from './_shared.jsx';

export function Transfers() {
  const ctx = useAdmin();
  const [direction, setDirection] = useState('');
  const [page, setPage] = useState(1);
  const state = useAsync(() => ctx.api.get('/inventory/transfers', { branchId: ctx.branchId, direction, page, pageSize: 20 }), [direction, page]);
  const reloadRef = useRef(state.reload);
  reloadRef.current = state.reload;
  const reload = () => reloadRef.current();

  const detail = (id) => openModal({ title: 'Transferencia', size: 'xl', content: (p) => <TransferDetail id={id} onChanged={reload} {...p} /> });
  function create() {
    const destinations = ctx.branches.filter((b) => b.id !== ctx.branchId);
    if (!destinations.length) { toast('No hay otras sucursales activas', 'warning'); return; }
    openModal({
      title: `Nueva transferencia desde ${ctx.branchName(ctx.branchId)}`, size: 'xl',
      content: (p) => <NewTransfer destinations={destinations} onSaved={(id) => { reload(); detail(id); }} {...p} />,
    });
  }

  useRealtime('transfer:dispatched', state.reload);
  useRealtime('transfer:received', state.reload);

  return (
    <>
      <PageHead
        title="Transferencias entre sucursales" sub="Solicitud → aprobación → despacho (TRANSFER_OUT) → recepción (TRANSFER_IN)."
        actions={ctx.can('inventory.transfers') ? <Button variant="primary" icon="plus" onClick={create}>Nueva transferencia</Button> : null}
      />
      <div><Tabs items={[{ id: '', label: 'Todas' }, { id: 'OUTGOING', label: 'Enviadas' }, { id: 'INCOMING', label: 'Por recibir / recibidas' }]} active={direction} onChange={(d) => { setDirection(d); setPage(1); }} /></div>
      <div>
        <Async state={state}>
          {(r) => (
            <Card tight>
              <div>
                <Table
                  columns={[
                    { label: 'Transferencia', render: (t) => <Cell title={t.transferNumber} sub={dateTime(t.requestedAt)} /> },
                    { label: 'Origen → destino', render: (t) => `${t.origin.name} → ${t.destination.name}` },
                    { label: 'Ítems', num: true, render: (t) => `${t.itemsCount} · ${number(t.units)} u.` },
                    { label: 'Etapa', render: (t) => <Badge kind="transfer" code={t.stage} /> },
                    { label: 'Solicitó', render: (t) => t.requestedBy.fullName },
                  ]}
                  rows={r.data} empty="Sin transferencias" onRowClick={(t) => detail(t.id)}
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

function NewTransfer({ destinations, onSaved, close }) {
  const ctx = useAdmin();
  const [lines, setLines] = useState([]);
  const [dest, setDest] = useState(String(destinations[0].id));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(null);

  async function pick(p) {
    try {
      const bs = (await batchesOf(p.id, ctx.branchId)).filter((b) => b.is_sellable);
      if (!bs.length) { toast('El producto no tiene lotes disponibles en esta sucursal', 'warning'); return; }
      setLines((ls) => [...ls, ...bs.filter((b) => !ls.some((l) => l.batchId === b.id)).map((b) => ({ batchId: b.id, product: p.name, batch: b, quantity: 0 }))]);
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  async function save() {
    setError(null);
    const items = lines.filter((l) => l.quantity > 0).map((l) => ({ batchId: l.batchId, quantity: l.quantity }));
    if (!items.length) { setError({ tone: 'warning', text: 'Indique cantidades a transferir.' }); return; }
    try {
      const r = await ctx.api.post('/inventory/transfers', { originBranchId: ctx.branchId, destinationBranchId: Number(dest), notes: notes.trim() || null, items });
      close(); toast(`Transferencia ${r.data.transferNumber} solicitada`, 'success'); onSaved(r.data.id);
    } catch (err) { setError({ tone: 'danger', text: errorMessage(err) }); }
  }

  return (
    <>
      <ModalBody>
        <div className="stack">
          <div>{error ? <AlertBox tone={error.tone}>{error.text}</AlertBox> : null}</div>
          <div className="form-grid">
            <div className="field"><label>Sucursal destino</label>
              <select className="input" value={dest} onChange={(e) => setDest(e.target.value)}>{destinations.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            </div>
            <div className="field"><label>Observaciones</label>
              <input className="input" placeholder="Observaciones" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <ProductPicker onPick={pick} />
          <div>
            {!lines.length ? <EmptyState title="Sin lotes" text="Agregue productos: se listan sus lotes vendibles (no vencidos)." /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr>{['Producto', 'Lote', 'Vence', 'Disponible', 'A transferir', ''].map((t, i) => <th key={i}>{t}</th>)}</tr></thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.batchId}>
                        <td>{l.product}</td>
                        <td className="mono">{l.batch.batch_number}</td>
                        <td>{date(l.batch.expiry_date)}</td>
                        <td className="num">{number(l.batch.current_quantity)}</td>
                        <td>
                          <input className="input" type="number" min={0} max={l.batch.current_quantity} style={{ width: '100px' }} aria-label={`Cantidad lote ${l.batch.batch_number}`}
                            value={l.quantity || ''} onChange={(e) => { const q = Number(e.target.value) || 0; setLines((ls) => ls.map((x) => (x.batchId === l.batchId ? { ...x, quantity: q } : x))); }} />
                        </td>
                        <td><Button variant="ghost" size="sm" icon="trash" onClick={() => setLines((ls) => ls.filter((x) => x.batchId !== l.batchId))} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </ModalBody>
      <ModalFoot>
        <Button onClick={() => close()}>Cancelar</Button>
        <Button variant="primary" onClick={save}>Solicitar transferencia</Button>
      </ModalFoot>
    </>
  );
}

function TransferDetail({ id, onChanged, setTitle }) {
  const ctx = useAdmin();
  const state = useAsync(async () => {
    const { data } = await ctx.api.get(`/inventory/transfers/${id}`);
    setTitle(`Transferencia ${data.transferNumber}`);
    return data;
  }, [id]);
  const [approve, setApprove] = useState({});
  const [receive, setReceive] = useState({});

  async function act(fn) {
    try { await fn(); toast('Transferencia actualizada', 'success'); setApprove({}); setReceive({}); state.reload(); onChanged(); } catch (err) { toast(errorMessage(err), 'error'); }
  }
  const setRc = (itemId, patch) => setReceive((r) => ({ ...r, [itemId]: { received: '', damaged: '', surplus: '', note: '', ...r[itemId], ...patch } }));

  return (
    <ModalBody>
      <div className="stack">
        <Async state={state}>
          {(t) => {
            const atOrigin = ctx.can('inventory.transfers') && ctx.branches.some((b) => b.id === t.origin.id);
            const atDestination = ctx.can('inventory.receive_transfers') && ctx.branches.some((b) => b.id === t.destination.id);
            const approving = atOrigin && t.stage === 'REQUESTED';
            const receiving = atDestination && t.status === 'IN_TRANSIT';
            const cols = [
              { label: 'Producto / lote', render: (i) => <Cell title={i.productName} sub={`Lote ${i.batchNumber} · vence ${date(i.expiryDate)}`} /> },
              { label: approving ? 'Aprobar (máx. solicitado)' : 'Cantidad', num: true, render: (i) => (approving ? (
                <input className="input" type="number" min={0} max={i.quantity} style={{ width: '90px' }} value={approve[i.id] ?? String(i.quantity)} onChange={(e) => setApprove((a) => ({ ...a, [i.id]: e.target.value }))} />
              ) : number(i.quantity)) },
              { label: 'Recibido', num: true, render: (i) => (i.receivedQuantity === null ? '—' : number(i.receivedQuantity)) },
              { label: 'Diferencias', render: (i) => i.discrepancyNote },
            ];
            if (receiving) {
              cols.push({ label: 'Recepción', render: (i) => {
                if (i.receivedQuantity !== null) return <Badge kind="transfer" code="RECEIVED" />;
                const c = receive[i.id] || {};
                return (
                  <div className="row" style={{ gap: '6px' }}>
                    <input className="input" type="number" min={0} max={i.quantity} placeholder={`Llegó (de ${i.quantity})`} style={{ width: '120px' }} value={c.received ?? ''} onChange={(e) => setRc(i.id, { received: e.target.value })} />
                    <input className="input" type="number" min={0} placeholder="Dañadas" style={{ width: '90px' }} value={c.damaged ?? ''} onChange={(e) => setRc(i.id, { damaged: e.target.value })} />
                    <input className="input" type="number" min={0} placeholder="Sobrantes" style={{ width: '90px' }} value={c.surplus ?? ''} onChange={(e) => setRc(i.id, { surplus: e.target.value })} />
                    <input className="input" placeholder="Nota (obligatoria si hay diferencias)" value={c.note ?? ''} onChange={(e) => setRc(i.id, { note: e.target.value })} />
                  </div>
                );
              } });
            }
            return (
              <>
                <div className="row between">
                  <Badge kind="transfer" code={t.stage} />
                  <div className="row">
                    {approving ? (
                      <>
                        <Button variant="danger" onClick={async () => {
                          const ok = await confirmDialog({ title: 'Cancelar transferencia', message: 'Aún no movió stock.', danger: true, reason: true, confirmText: 'Cancelar' });
                          if (ok) await act(() => ctx.api.post(`/inventory/transfers/${id}/cancel`, { reason: ok.reason }));
                        }}>Cancelar solicitud</Button>
                        <Button variant="primary" onClick={() => act(() => ctx.api.post(`/inventory/transfers/${id}/approve`, {
                          items: t.items.map((i) => ({ itemId: i.id, approvedQuantity: Number(approve[i.id] ?? i.quantity) })),
                        }))}>Aprobar</Button>
                      </>
                    ) : null}
                    {atOrigin && t.stage === 'APPROVED' ? (
                      <Button variant="primary" icon="truck" onClick={async () => {
                        const ok = await confirmDialog({ title: 'Despachar', message: 'Se descontará el stock del origen (TRANSFER_OUT).', confirmText: 'Despachar' });
                        if (ok) await act(() => ctx.api.post(`/inventory/transfers/${id}/dispatch`, {}));
                      }}>Despachar</Button>
                    ) : null}
                    {receiving ? (
                      <Button variant="success" onClick={() => act(() => {
                        const items = [];
                        for (const i of t.items) {
                          const c = receive[i.id];
                          if (i.receivedQuantity !== null || !c || c.received === '' || c.received === undefined) continue;
                          items.push({ itemId: i.id, receivedQuantity: Number(c.received), damagedQuantity: Number(c.damaged || 0), surplusQuantity: Number(c.surplus || 0), note: (c.note || '').trim() || undefined });
                        }
                        if (!items.length) throw Object.assign(new Error('Indique lo recibido en al menos un ítem'), { status: 400 });
                        return ctx.api.post(`/inventory/transfers/${id}/receive`, { items });
                      })}>Registrar recepción</Button>
                    ) : null}
                  </div>
                </div>
                <KV pairs={[['Origen', t.origin.name], ['Destino', t.destination.name], ['Solicitó', `${t.requestedBy.fullName} · ${dateTime(t.requestedAt)}`],
                  ['Aprobada', t.approvedAt ? dateTime(t.approvedAt) : '—'], ['Despachó', t.dispatchedBy ? `${t.dispatchedBy.fullName} · ${dateTime(t.dispatchedAt)}` : '—'],
                  ['Recibió', t.receivedBy ? `${t.receivedBy.fullName} · ${dateTime(t.receivedAt)}` : '—'], ['Observaciones', t.notes]]} />
                {receiving ? <AlertBox tone="info">Puede recibir algunos ítems ahora y otros después. Cada ítem se recibe una sola vez; las unidades dañadas se dan de baja automáticamente.</AlertBox> : null}
                <Table columns={cols} rows={t.items} />
              </>
            );
          }}
        </Async>
      </div>
    </ModalBody>
  );
}
