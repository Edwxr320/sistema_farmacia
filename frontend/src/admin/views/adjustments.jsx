import React, { useRef, useState } from 'react';
import { useAdmin } from '../context.jsx';
import {
  Card, PageHead, Table, Button, toast, KV, Pagination, AlertBox, Select, EmptyState, ToneBadge, SearchInput, useAsync, Async,
} from '../../components/ui.jsx';
import { openModal, ModalBody, ModalFoot } from '../../components/modal.jsx';
import { number, date, dateTime, ADJUSTMENT_TYPES, MOVEMENT_TYPES, errorMessage } from '../../core/format.js';
import { ProductPicker, batchesOf, Cell } from './_shared.jsx';

const PERMISSION = { PHYSICAL_COUNT: 'inventory.adjust', CORRECTION: 'inventory.adjust', OTHER: 'inventory.adjust', EXPIRED_WRITE_OFF: 'inventory.write_off', DAMAGE: 'inventory.write_off', LOSS: 'inventory.write_off' };

export function Adjustments() {
  const ctx = useAdmin();
  const [f, setF] = useState({ adjustmentType: '', q: '', page: 1 });
  const allowed = Object.keys(ADJUSTMENT_TYPES).filter((t) => ctx.can(PERMISSION[t]));
  const state = useAsync(() => ctx.api.get('/inventory/adjustments', { branchId: ctx.branchId, ...f, pageSize: 20 }), [f]);
  const reloadRef = useRef(state.reload);
  reloadRef.current = state.reload;

  async function detail(id) {
    try {
      const { data: a } = await ctx.api.get(`/inventory/adjustments/${id}`);
      openModal({
        title: `Ajuste ${a.adjustmentNumber}`, size: 'lg',
        body: (
          <div className="stack">
            <KV pairs={[['Tipo', ADJUSTMENT_TYPES[a.adjustmentType]], ['Motivo', a.reason], ['Responsable', a.performedBy.fullName], ['Aprobado por', a.approvedBy?.fullName], ['Fecha', dateTime(a.createdAt)]]} />
            {a.movementsCount === 0 ? <AlertBox tone="success">Conteo sin diferencias: no se registraron movimientos.</AlertBox> : (
              <Table
                columns={[
                  { label: 'Producto / lote', render: (m) => <Cell title={m.productName} sub={`Lote ${m.batchNumber} · vence ${date(m.expiryDate)}`} /> },
                  { label: 'Movimiento', render: (m) => MOVEMENT_TYPES[m.movementType] },
                  { label: 'Cant.', num: true, render: (m) => `${m.direction === 'IN' ? '+' : '−'}${m.quantity}` },
                  { label: 'Lote antes → después', num: true, render: (m) => `${m.batchStockBefore} → ${m.batchStockAfter}` },
                ]}
                rows={a.movements}
              />
            )}
          </div>
        ),
      });
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  const create = () => openModal({
    title: 'Nuevo ajuste de inventario', size: 'lg',
    content: (p) => <NewAdjustment allowed={allowed} onSaved={(id) => { reloadRef.current(); detail(id); }} {...p} />,
  });

  return (
    <>
      <PageHead
        title="Ajustes y bajas" sub="Conteos físicos, correcciones y bajas por vencimiento, deterioro o pérdida."
        actions={allowed.length ? <Button variant="primary" icon="plus" onClick={create}>Nuevo ajuste</Button> : null}
      />
      <div className="card card-body toolbar">
        <SearchInput placeholder="N.º de ajuste…" onSearch={(q) => setF((x) => ({ ...x, q, page: 1 }))} />
        <Select options={Object.entries(ADJUSTMENT_TYPES).map(([value, label]) => ({ value, label }))} value={f.adjustmentType} onChange={(v) => setF((x) => ({ ...x, adjustmentType: v, page: 1 }))} label="Tipo" placeholder="Todos" />
      </div>
      <div>
        <Async state={state}>
          {(r) => (
            <Card tight>
              <div>
                <Table
                  columns={[
                    { label: 'Ajuste', render: (a) => <Cell title={a.adjustmentNumber} sub={dateTime(a.createdAt)} /> },
                    { label: 'Tipo', render: (a) => <ToneBadge tone={a.adjustmentType.includes('WRITE') || ['DAMAGE', 'LOSS'].includes(a.adjustmentType) ? 'warning' : 'info'}>{ADJUSTMENT_TYPES[a.adjustmentType]}</ToneBadge> },
                    { label: 'Motivo', render: (a) => a.reason },
                    { label: 'Responsable', render: (a) => a.performedBy.fullName },
                    { label: 'Entradas', num: true, render: (a) => `+${number(a.unitsIn)}` },
                    { label: 'Salidas', num: true, render: (a) => `−${number(a.unitsOut)}` },
                  ]}
                  rows={r.data} empty="Sin ajustes" onRowClick={(a) => detail(a.id)}
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

function NewAdjustment({ allowed, onSaved, close }) {
  const ctx = useAdmin();
  const [type, setType] = useState(allowed[0]);
  const [product, setProduct] = useState(null);
  const [batches, setBatches] = useState([]);
  const [qty, setQty] = useState({});
  const [dir, setDir] = useState({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);

  const count = type === 'PHYSICAL_COUNT';
  const directed = type === 'CORRECTION' || type === 'OTHER';
  const bid = (b) => b.batch_id ?? b.id;

  async function pick(p) {
    setProduct(p);
    try {
      const list = (await batchesOf(p.id, ctx.branchId, { withStock: false })).filter((b) => b.current_quantity > 0 || b.status !== 'DEPLETED');
      setBatches(list);
      setQty({});
      setDir({});
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  async function save() {
    setError(null);
    const items = batches.filter((b) => (qty[bid(b)] ?? '') !== '').map((b) => (count
      ? { batchId: bid(b), countedQuantity: Number(qty[bid(b)]) }
      : { batchId: bid(b), quantity: Number(qty[bid(b)]), ...(directed ? { direction: dir[bid(b)] || 'OUT' } : {}) }))
      .filter((i) => count || i.quantity > 0);
    if (!product || !items.length) { setError({ tone: 'warning', text: 'Seleccione un producto e indique al menos una cantidad.' }); return; }
    try {
      const r = await ctx.api.post('/inventory/adjustments', { branchId: ctx.branchId, adjustmentType: type, productId: product.id, reason: reason.trim(), items });
      close();
      toast(r.data.noDifferences ? 'Conteo registrado sin diferencias' : `Ajuste ${r.data.adjustmentNumber} registrado`, 'success');
      onSaved(r.data.id);
    } catch (err) {
      const d = Array.isArray(err.details) ? err.details.map((x) => x.message).join(' · ') : '';
      setError({ tone: 'danger', text: `${errorMessage(err)}${d ? ` — ${d}` : ''}` });
    }
  }

  let lines;
  if (!product) lines = <EmptyState title="Seleccione un producto" text="Se listarán sus lotes en esta sucursal." />;
  else if (!batches.length) lines = <AlertBox tone="warning">El producto no tiene lotes en esta sucursal.</AlertBox>;
  else {
    lines = (
      <>
        {count ? <AlertBox tone="info">Ingrese la cantidad física encontrada. El sistema calcula la diferencia contra el stock real y solo registra movimientos si hay diferencia.</AlertBox> : null}
        {type === 'EXPIRED_WRITE_OFF' ? <AlertBox tone="warning">Solo se aceptan lotes ya vencidos.</AlertBox> : null}
        <div className="table-wrap">
          <table className="table">
            <thead><tr>{['Lote', 'Vencimiento', 'Stock sistema', count ? 'Cantidad física' : 'Cantidad', directed ? 'Dirección' : null].filter(Boolean).map((t) => <th key={t}>{t}</th>)}</tr></thead>
            <tbody>
              {batches.map((b) => (
                <tr key={bid(b)}>
                  <td className="mono">{b.batch_number}</td>
                  <td>{date(b.expiry_date)}{b.days_to_expiry <= 0 ? <span className="error small"> vencido</span> : null}</td>
                  <td className="num">{number(b.current_quantity)}</td>
                  <td>
                    <input className="input" type="number" min={0} style={{ width: '110px' }} placeholder={count ? String(b.current_quantity) : '0'} aria-label={`Cantidad lote ${b.batch_number}`}
                      value={qty[bid(b)] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [bid(b)]: e.target.value }))} />
                  </td>
                  {directed ? (
                    <td>
                      <select className="input" style={{ width: 'auto' }} value={dir[bid(b)] || 'OUT'} onChange={(e) => setDir((d) => ({ ...d, [bid(b)]: e.target.value }))}>
                        <option value="OUT">Salida (−)</option><option value="IN">Entrada (+)</option>
                      </select>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <>
      <ModalBody>
        <div className="stack">
          <div>{error ? <AlertBox tone={error.tone}>{error.text}</AlertBox> : null}</div>
          <div className="form-grid">
            <div className="field"><label>Tipo de ajuste</label>
              <select className="input" value={type} onChange={(e) => setType(e.target.value)}>{allowed.map((t) => <option key={t} value={t}>{ADJUSTMENT_TYPES[t]}</option>)}</select>
            </div>
            <div className="field"><label>Producto</label>
              <ProductPicker status="" onPick={pick} />
              <div className="strong">{product?.name || ''}</div>
            </div>
            <div className="field full"><label>Motivo *</label>
              <textarea className="input" placeholder="Describa el motivo (mínimo 5 caracteres)" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
          <div>{lines}</div>
        </div>
      </ModalBody>
      <ModalFoot>
        <Button onClick={() => close()}>Cancelar</Button>
        <Button variant="primary" onClick={save}>Registrar ajuste</Button>
      </ModalFoot>
    </>
  );
}
