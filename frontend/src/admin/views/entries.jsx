import React, { useRef, useState } from 'react';
import { useAdmin } from '../context.jsx';
import {
  Card, PageHead, Table, Badge, Button, toast, KV, Pagination, Tabs, AlertBox, EmptyState, confirmDialog, useAsync, Async,
} from '../../components/ui.jsx';
import { openModal, ModalBody, ModalFoot } from '../../components/modal.jsx';
import { money, number, date, dateTime, todayLima, addDays, errorMessage } from '../../core/format.js';
import { ProductPicker, Cell } from './_shared.jsx';

const DOC_TYPES = { FACTURA: 'Factura', BOLETA: 'Boleta', GUIA_REMISION: 'Guía de remisión', NOTA: 'Nota', OTHER: 'Otro' };
const ENTRY_TYPES = { PURCHASE: 'Compra', INITIAL_STOCK: 'Stock inicial', DONATION: 'Donación', OTHER: 'Otro' };
const TABS = [{ id: 'DRAFT', label: 'Borradores' }, { id: 'POSTED', label: 'Contabilizadas' }, { id: 'CANCELLED', label: 'Anuladas' }, { id: '', label: 'Todas' }];

export function Entries() {
  const ctx = useAdmin();
  const [status, setStatus] = useState('DRAFT');
  const [page, setPage] = useState(1);
  const state = useAsync(() => ctx.api.get('/inventory/entries', { branchId: ctx.branchId, status, page, pageSize: 20 }), [status, page]);
  const reloadRef = useRef(state.reload);
  reloadRef.current = state.reload;
  const reload = () => reloadRef.current();

  function review(id) {
    openModal({ title: 'Entrada', size: 'xl', content: (p) => <EntryReview id={id} onChanged={reload} onEdit={(e) => editor(e)} {...p} /> });
  }
  async function editor(existing) {
    try {
      const suppliers = (await ctx.api.get('/suppliers', { status: 'ACTIVE', pageSize: 100 })).data;
      openModal({
        title: existing ? `Editar ${existing.entryNumber}` : 'Nueva entrada de mercadería', size: 'xl',
        content: (p) => <EntryEditor existing={existing} suppliers={suppliers} onSaved={(id) => { reload(); review(id); }} {...p} />,
      });
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  return (
    <>
      <PageHead
        title="Entradas de mercadería" sub="Recepción por lotes: borrador → revisión → contabilización (el stock ingresa con PURCHASE_ENTRY)."
        actions={ctx.can('inventory.entries') ? <Button variant="primary" icon="plus" onClick={() => editor()}>Nueva entrada</Button> : null}
      />
      <div><Tabs items={TABS} active={status} onChange={(s) => { setStatus(s); setPage(1); }} /></div>
      <div>
        <Async state={state}>
          {(r) => (
            <Card tight>
              <div>
                <Table
                  columns={[
                    { label: 'Entrada', render: (e) => <Cell title={e.entryNumber} sub={ENTRY_TYPES[e.entryType]} /> },
                    { label: 'Proveedor', render: (e) => e.supplier?.businessName || '—' },
                    { label: 'Comprobante', render: (e) => (e.referenceDocumentNumber ? `${DOC_TYPES[e.referenceDocumentType]} ${e.referenceDocumentNumber}` : '—') },
                    { label: 'Recibida', render: (e) => dateTime(e.receivedAt) },
                    { label: 'Líneas', num: true, render: (e) => `${e.itemsCount} · ${number(e.unitsCount)} u.` },
                    { label: 'Estado', render: (e) => <Badge kind="entry" code={e.status} /> },
                    { label: 'Total', num: true, render: (e) => money(e.totalCost) },
                  ]}
                  rows={r.data} empty="Sin entradas" onRowClick={(e) => review(e.id)}
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

// ------------------------------------------------------------- editor
function EntryEditor({ existing, suppliers, onSaved, close }) {
  const ctx = useAdmin();
  const [head, setHead] = useState({
    supplierId: existing?.supplier?.id ?? '', entryType: existing?.entryType ?? 'PURCHASE',
    referenceDocumentType: existing?.referenceDocumentType ?? 'FACTURA', referenceDocumentNumber: existing?.referenceDocumentNumber ?? '', notes: existing?.notes ?? '',
  });
  const [lines, setLines] = useState(() => (existing ? existing.items.map((i, k) => ({
    k, productId: i.productId, name: i.productName, batchNumber: i.batchNumber, manufacturingDate: i.manufacturingDate || '', expiryDate: i.expiryDate, quantity: i.quantity, unitCost: i.unitCost,
  })) : []));
  const [error, setError] = useState(null);
  const lineSeq = useRef(1000);
  const tableRef = useRef(null);
  const setH = (key, v) => setHead((h) => ({ ...h, [key]: v }));
  const setLine = (k, patch) => setLines((ls) => ls.map((l) => (l.k === k ? { ...l, ...patch } : l)));

  async function save(confirm) {
    setError(null);
    const body = {
      ...(existing ? {} : { branchId: ctx.branchId }),
      supplierId: head.supplierId ? Number(head.supplierId) : null,
      entryType: head.entryType,
      referenceDocumentType: head.referenceDocumentNumber.trim() ? head.referenceDocumentType : null,
      referenceDocumentNumber: head.referenceDocumentNumber.trim() || null,
      notes: head.notes.trim() || null,
      items: lines.map((l) => ({
        productId: l.productId, batchNumber: String(l.batchNumber).trim(), ...(l.manufacturingDate ? { manufacturingDate: l.manufacturingDate } : {}),
        expiryDate: l.expiryDate, quantity: Number(l.quantity), unitCost: String(l.unitCost).trim(),
      })),
      ...(existing ? {} : { confirm }),
    };
    try {
      const r = existing ? await ctx.api.put(`/inventory/entries/${existing.id}`, body) : await ctx.api.post('/inventory/entries', body);
      close();
      toast(confirm ? `Entrada ${r.data.entryNumber} contabilizada` : `Borrador ${r.data.entryNumber} guardado`, 'success');
      onSaved(r.data.id);
    } catch (err) {
      const d = Array.isArray(err.details) ? err.details.map((x) => `${x.field ? `${x.field}: ` : ''}${x.message}`).join(' · ') : '';
      setError(`${errorMessage(err)}${d ? ` — ${d}` : ''}`);
    }
  }

  return (
    <>
      <ModalBody>
        <div className="stack">
          <div>{error ? <AlertBox tone="danger">{error}</AlertBox> : null}</div>
          <div className="form-grid">
            <div className="field"><label>Tipo de entrada</label>
              <select className="input" value={head.entryType} onChange={(e) => setH('entryType', e.target.value)}>
                {Object.entries(ENTRY_TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="field"><label>Proveedor (obligatorio en compras)</label>
              <select className="input" value={String(head.supplierId)} onChange={(e) => setH('supplierId', e.target.value)}>
                <option value="">Seleccione…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{`${s.businessName}${s.ruc ? ` · ${s.ruc}` : ''}`}</option>)}
              </select>
            </div>
            <div className="field"><label>Comprobante</label>
              <select className="input" value={head.referenceDocumentType} onChange={(e) => setH('referenceDocumentType', e.target.value)}>
                {Object.entries(DOC_TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="field"><label>N.º de comprobante</label>
              <input className="input" placeholder="F001-000123" value={head.referenceDocumentNumber} onChange={(e) => setH('referenceDocumentNumber', e.target.value)} />
            </div>
            <div className="field full"><label>Observaciones</label>
              <input className="input" value={head.notes} onChange={(e) => setH('notes', e.target.value)} />
            </div>
          </div>
          <div className="label">Productos recibidos</div>
          <ProductPicker onPick={(p) => {
            setLines((ls) => [...ls, { k: lineSeq.current++, productId: p.id, name: p.name, batchNumber: '', manufacturingDate: '', expiryDate: '', quantity: 1, unitCost: p.purchasePrice || '0.00' }]);
            setTimeout(() => tableRef.current?.querySelector('tbody tr:last-child input')?.focus(), 0);
          }} />
          <div ref={tableRef}>
            {!lines.length ? <EmptyState title="Sin productos" text="Busque y agregue los productos recibidos." /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr>{['Producto', 'Lote *', 'Fabricación', 'Vencimiento *', 'Cantidad *', 'Costo unit. *', ''].map((t) => <th key={t}>{t}</th>)}</tr></thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.k}>
                        <td><span className="cell-title">{l.name}</span></td>
                        <td><input className="input" aria-label="Número de lote" style={{ minWidth: '110px' }} value={l.batchNumber} onChange={(e) => setLine(l.k, { batchNumber: e.target.value })} /></td>
                        <td><input className="input" type="date" max={todayLima()} aria-label="Fecha de fabricación" value={l.manufacturingDate} onChange={(e) => setLine(l.k, { manufacturingDate: e.target.value })} /></td>
                        <td><input className="input" type="date" min={addDays(todayLima(), 1)} aria-label="Fecha de vencimiento" value={l.expiryDate} onChange={(e) => setLine(l.k, { expiryDate: e.target.value })} /></td>
                        <td><input className="input" type="number" min={1} style={{ width: '90px' }} aria-label="Cantidad" value={l.quantity} onChange={(e) => setLine(l.k, { quantity: e.target.value })} /></td>
                        <td><input className="input" inputMode="decimal" style={{ width: '100px' }} aria-label="Costo unitario" value={l.unitCost} onChange={(e) => setLine(l.k, { unitCost: e.target.value })} /></td>
                        <td><Button variant="ghost" size="sm" icon="trash" title="Quitar línea" onClick={() => setLines((ls) => ls.filter((x) => x.k !== l.k))} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="small muted">Totales y existencias los calcula el servidor. Un lote vencido o con vencimiento distinto al ya registrado se rechaza.</p>
        </div>
      </ModalBody>
      <ModalFoot>
        <Button onClick={() => close()}>Cancelar</Button>
        <Button onClick={() => save(false)}>{existing ? 'Guardar cambios' : 'Guardar borrador'}</Button>
        {existing ? null : <Button variant="primary" onClick={() => save(true)}>Registrar y contabilizar</Button>}
      </ModalFoot>
    </>
  );
}

// ------------------------------------------------------------- revisión
function EntryReview({ id, onChanged, onEdit, close, setTitle }) {
  const ctx = useAdmin();
  const state = useAsync(async () => {
    const { data } = await ctx.api.get(`/inventory/entries/${id}`);
    setTitle(`Entrada ${data.entryNumber}`);
    return data;
  }, [id]);
  async function act(fn) {
    try { await fn(); toast('Entrada actualizada', 'success'); state.reload(); onChanged(); } catch (err) { toast(errorMessage(err), 'error'); }
  }
  return (
    <ModalBody>
      <div className="stack">
        <Async state={state}>
          {(e) => (
            <>
              <div className="row between">
                <Badge kind="entry" code={e.status} />
                <div className="row">
                  {e.status === 'DRAFT' && ctx.can('inventory.entries') ? (
                    <>
                      <Button variant="danger" onClick={async () => {
                        const ok = await confirmDialog({ title: 'Anular borrador', message: 'El borrador no movió stock; quedará como anulado.', danger: true, reason: true, confirmText: 'Anular' });
                        if (ok) await act(() => ctx.api.post(`/inventory/entries/${id}/cancel`, { reason: ok.reason }));
                      }}>Anular</Button>
                      <Button icon="edit" onClick={() => { close(); onEdit(e); }}>Editar</Button>
                      <Button variant="primary" icon="check" onClick={async () => {
                        const ok = await confirmDialog({ title: 'Contabilizar entrada', message: `Ingresarán ${number(e.unitsCount)} unidades por ${money(e.totalCost)}. Esta operación no se puede deshacer (se revierte con un ajuste).`, confirmText: 'Contabilizar' });
                        if (ok) await act(() => ctx.api.post(`/inventory/entries/${id}/post`, {}));
                      }}>Contabilizar</Button>
                    </>
                  ) : null}
                </div>
              </div>
              {e.status === 'DRAFT' ? <AlertBox tone="info">Revise los datos antes de contabilizar. El stock aún no ingresó.</AlertBox> : null}
              <KV pairs={[['Sucursal', e.branch.name], ['Tipo', ENTRY_TYPES[e.entryType]], ['Proveedor', e.supplier ? `${e.supplier.businessName} ${e.supplier.ruc ? `(${e.supplier.ruc})` : ''}` : '—'],
                ['Comprobante', e.referenceDocumentNumber ? `${DOC_TYPES[e.referenceDocumentType]} ${e.referenceDocumentNumber}` : '—'],
                ['Registrada por', `${e.registeredBy.fullName} · ${dateTime(e.receivedAt)}`], ['Contabilizada', e.postedAt ? dateTime(e.postedAt) : '—'],
                ['Total', <strong>{money(e.totalCost)}</strong>], ['Observaciones', e.notes]]} />
              <Table
                columns={[
                  { label: 'Producto', render: (i) => <Cell title={i.productName} sub={i.sku} /> },
                  { label: 'Lote', render: (i) => <span className="mono">{i.batchNumber}</span> },
                  { label: 'Vence', render: (i) => (i.isExpired ? <span className="error">{`${date(i.expiryDate)} (vencido)`}</span> : date(i.expiryDate)) },
                  { label: 'Cant.', num: true, render: (i) => number(i.quantity) },
                  { label: 'Costo u.', num: true, render: (i) => money(i.unitCost) },
                  { label: 'Subtotal', num: true, render: (i) => money(i.lineTotal) },
                  { label: 'Ingreso', render: (i) => (i.movementId ? <Badge kind="entry" code="POSTED" /> : '—') },
                ]}
                rows={e.items}
              />
            </>
          )}
        </Async>
      </div>
    </ModalBody>
  );
}
