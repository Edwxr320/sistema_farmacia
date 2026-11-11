import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAdmin, useRealtime } from '../context.jsx';
import {
  Button, Icon, toast, EmptyState, ErrorState, Spinner, AlertBox, ToneBadge, printUrl, useDebouncedCallback,
} from '../../components/ui.jsx';
import { openModal, ModalBody, ModalFoot } from '../../components/modal.jsx';
import { formModal } from '../../components/form.jsx';
import { money, cents, fromCents, date, PAYMENT_METHODS, idempotencyKey, errorMessage } from '../../core/format.js';

const NEW_PAYMENT = () => ({ method: 'CASH', amount: '', tenderedAmount: '' });
const itemsOf = (cart) => cart.map((l) => ({ productId: l.productId, quantity: l.quantity, ...(l.prescriptionReference ? { prescriptionReference: l.prescriptionReference } : {}) }));

/**
 * Punto de venta. El navegador solo envía productos, cantidades, descuento solicitado y pagos;
 * precios, totales, lotes FEFO y validaciones los calcula el servidor (/api/sales/quote y /api/sales).
 */
export function Pos() {
  const ctx = useAdmin();
  const [cashSession, setCashSession] = useState(null);
  const [banner, setBanner] = useState(null);
  const [products, setProducts] = useState({ list: [], loading: true, error: null });
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState([]);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [discount, setDiscount] = useState(null);
  const [split, setSplit] = useState(false);
  const [payments, setPayments] = useState([NEW_PAYMENT()]);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const attempt = useRef({ key: null, signature: null });
  const searchRef = useRef(null);
  const qRef = useRef('');
  const productsSeq = useRef(0);
  const quoteSeq = useRef(0);

  // ------------------------------------------------------------- caja
  const checkSession = useCallback(async () => {
    try {
      const r = await ctx.api.get('/cash/sessions/current');
      setCashSession(r.data && r.data.branch.id === ctx.branchId ? r.data : null);
      if (!r.data) setBanner({ kind: 'none' });
      else if (r.data.branch.id !== ctx.branchId) setBanner({ kind: 'other', s: r.data });
      else setBanner(null);
    } catch (err) { setBanner({ kind: 'error', err }); }
  }, [ctx]);

  // ---------------------------------------------------------- catálogo
  const loadProducts = useCallback(async () => {
    const my = ++productsSeq.current;
    setProducts((p) => ({ ...p, loading: true, error: null }));
    try {
      const r = await ctx.api.get('/sales/catalog', { branchId: ctx.branchId, q: qRef.current || undefined, pageSize: 40 });
      if (my === productsSeq.current) setProducts({ list: r.data, loading: false, error: null });
    } catch (err) {
      if (my === productsSeq.current) setProducts({ list: [], loading: false, error: err });
    }
  }, [ctx]);

  useEffect(() => {
    Promise.all([checkSession(), loadProducts()]).then(() => searchRef.current?.focus());
  }, [checkSession, loadProducts]);

  const onSearchInput = useDebouncedCallback((v) => { qRef.current = v.trim(); loadProducts(); }, 250);

  async function onSearchKey(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const term = search.trim();
    if (!term) return;
    // Lector de códigos: coincidencia exacta por código de barras o SKU.
    const r = await ctx.api.get('/sales/catalog', { branchId: ctx.branchId, barcode: term, pageSize: 1 }).catch(() => null);
    const bySku = r && r.data.length ? r : await ctx.api.get('/sales/catalog', { branchId: ctx.branchId, sku: term, pageSize: 1 }).catch(() => null);
    const p = (bySku && bySku.data[0]) || products.list.find((x) => x.canSell);
    if (p && p.canSell) { addToCart(p); setSearch(''); qRef.current = ''; loadProducts(); } else toast('Producto no encontrado o sin stock', 'warning');
  }

  // ------------------------------------------------------------- carrito
  function addToCart(p) {
    setCart((c) => {
      const line = c.find((l) => l.productId === p.productId);
      if (line) return c.map((l) => (l === line ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { productId: p.productId, name: p.name, sku: p.sku, quantity: 1, requiresPrescription: p.requiresPrescription, prescriptionReference: '' }];
    });
  }
  const updateLine = (productId, patch) => setCart((c) => c.map((l) => (l.productId === productId ? { ...l, ...patch } : l)));
  const setQty = (line, q) => updateLine(line.productId, { quantity: Math.max(1, Math.min(100000, Math.floor(Number(q) || 1))) });

  // Cotización del servidor tras cada cambio del carrito o del descuento.
  const cartSig = JSON.stringify([itemsOf(cart), discount]);
  useEffect(() => {
    attempt.current.key = null;
    if (!cart.length) { setQuote(null); setQuoteError(null); return undefined; }
    const my = ++quoteSeq.current;
    const t = setTimeout(async () => {
      try {
        const r = await ctx.api.post('/sales/quote', { branchId: ctx.branchId, items: itemsOf(cart), ...(discount ? { discount } : {}) });
        if (my !== quoteSeq.current) return;
        setQuote(r.data);
        setQuoteError(null);
      } catch (err) {
        // Sin cotización válida no se puede cobrar (p. ej. falta la receta o no hay stock).
        if (my !== quoteSeq.current) return;
        setQuote(null);
        setQuoteError(err);
      }
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartSig, quoteNonce, ctx]);
  const requote = () => setQuoteNonce((n) => n + 1);

  const quoteLine = (productId) => quote && quote.items.find((i) => i.productId === productId);
  const total = quote ? quote.total : '0.00';

  // ---------------------------------------------------------------- pagos
  const setPayment = (idx, patch) => { attempt.current.key = null; setPayments((ps) => ps.map((p, i) => (i === idx ? { ...p, ...patch } : p))); };

  function resetSale() {
    setCart([]); setDiscount(null); setCustomer(null); setQuote(null); attempt.current.key = null;
    setPayments([NEW_PAYMENT()]); setSplit(false);
  }

  // ------------------------------------------------------------ confirmar
  async function confirmSale() {
    if (!quote) return;
    const body = {
      branchId: ctx.branchId,
      items: itemsOf(cart),
      ...(discount ? { discount } : {}),
      ...(customer ? { customer: customer.payload } : {}),
      payments: payments.map((p) => ({
        method: p.method,
        ...(split ? { amount: p.amount } : {}),
        ...(p.method === 'CASH' && p.tenderedAmount ? { tenderedAmount: p.tenderedAmount } : {}),
        ...(p.method !== 'CASH' && p.simulate ? { simulate: p.simulate } : {}),
      })),
    };
    // Misma clave para reintentos del MISMO intento (p. ej. corte de red): el servidor no duplica la venta.
    const signature = JSON.stringify(body);
    if (!attempt.current.key || attempt.current.signature !== signature) attempt.current = { key: idempotencyKey('pos'), signature };
    try {
      const r = await ctx.api.post('/sales', body, { headers: { 'Idempotency-Key': attempt.current.key } });
      showResult(r.data);
      resetSale();
      loadProducts();
    } catch (err) {
      if (err.code === 'PAYMENT_REJECTED') {
        attempt.current.key = null;
        openModal({
          title: 'Pago rechazado',
          body: (
            <div className="stack">
              <AlertBox tone="danger">{err.message}</AlertBox>
              <p className="small">{`El intento quedó registrado (venta ${err.details?.saleNumber ?? ''} anulada) y el stock fue repuesto. Elija otro medio de pago.`}</p>
            </div>
          ),
        });
      } else if (err.status === 0) {
        toast('Sin conexión. Puede reintentar: la venta no se duplicará.', 'warning');
      } else {
        attempt.current.key = null;
        toast(errorMessage(err), 'error');
        if (['INSUFFICIENT_STOCK', 'PRESCRIPTION_REQUIRED', 'PRODUCT_INACTIVE', 'PRODUCT_NOT_AVAILABLE'].includes(err.code)) requote();
        if (err.code === 'CASH_SESSION_REQUIRED') checkSession();
      }
    }
  }

  function showResult(sale) {
    const cash = sale.payments.find((p) => p.method === 'CASH' && p.changeAmount);
    const m = openModal({
      title: `Venta ${sale.saleNumber} registrada`,
      body: (
        <div className="stack">
          <AlertBox tone="success">{`Total cobrado: ${money(sale.total)}`}</AlertBox>
          {cash ? <div className="stat card"><div className="label">Vuelto</div><div className="value">{money(cash.changeAmount)}</div></div> : null}
          <div className="small">{sale.payments.map((p) => `${PAYMENT_METHODS[p.method]} ${money(p.amount)}${p.externalReference ? ` · ${p.externalReference}` : ''}`).join(' · ')}</div>
          {sale.ticket ? <div className="small muted">{`Ticket interno ${sale.ticket.ticketNumber}`}</div> : null}
        </div>
      ),
      actions: [
        ctx.can('tickets.print') && sale.ticket ? (
          <Button icon="printer" onClick={async () => {
            await ctx.api.post(`/sales/${sale.id}/ticket/print`).catch(() => {});
            printUrl(`/api/sales/${sale.id}/ticket?format=html`);
          }}>Imprimir ticket</Button>
        ) : null,
        <Button variant="primary" onClick={() => { m.close(); setTimeout(() => searchRef.current?.focus(), 0); }}>Nueva venta</Button>,
      ],
    });
  }

  // ------------------------------------------------------- cliente/descuento
  function pickCustomer() {
    const canSearch = ctx.can('customers.view');
    function CustomerContent({ close }) {
      const [results, setResults] = useState(null);
      const [name, setName] = useState('');
      const [doc, setDoc] = useState('');
      const doSearch = useDebouncedCallback(async (q) => {
        if (!canSearch || q.length < 2) { setResults(null); return; }
        const r = await ctx.api.get('/customers', { q, isActive: 'true', pageSize: 8 }).catch(() => ({ data: [] }));
        setResults(r.data);
      }, 250);
      return (
        <>
          <ModalBody>
            <div className="stack">
              {canSearch ? (
                <div className="field">
                  <label>Buscar cliente registrado</label>
                  <input className="input" type="search" placeholder="Nombre, documento o teléfono" onChange={(e) => doSearch(e.target.value.trim())} />
                  <div className="stack">
                    {results === null ? null : results.length ? results.map((c) => (
                      <button key={c.id} type="button" className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => {
                        setCustomer({ label: `${c.fullName}${c.documentNumber ? ` (${c.documentType} ${c.documentNumber})` : ''}`, payload: { customerId: c.id } });
                        close();
                      }}>{`${c.fullName} · ${c.documentNumber || c.phone || 'sin documento'}`}</button>
                    )) : <p className="small muted">Sin coincidencias.</p>}
                  </div>
                </div>
              ) : null}
              <div className="label">O registrar solo los datos en la venta</div>
              <input className="input" placeholder="Nombre del cliente" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="input" placeholder="DNI (8 dígitos) — opcional" inputMode="numeric" value={doc} onChange={(e) => setDoc(e.target.value)} />
            </div>
          </ModalBody>
          <ModalFoot>
            <Button variant="primary" onClick={() => {
              if (name.trim().length < 3) { toast('Indique el nombre del cliente', 'warning'); return; }
              const d = doc.trim();
              setCustomer({ label: `${name.trim()}${d ? ` (DNI ${d})` : ''}`, payload: { fullName: name.trim(), ...(d ? { documentType: 'DNI', documentNumber: d } : {}) } });
              close();
            }}>Usar estos datos</Button>
          </ModalFoot>
        </>
      );
    }
    openModal({ title: 'Cliente de la venta', content: CustomerContent });
  }

  async function pickDiscount() {
    let chosen = null;
    const res = await formModal({
      title: 'Aplicar descuento',
      intro: <p className="small muted">El servidor valida el máximo permitido por la configuración del negocio.</p>,
      fields: [
        { name: 'type', label: 'Tipo', type: 'select', required: true, options: [{ value: 'PERCENT', label: 'Porcentaje (%)' }, { value: 'AMOUNT', label: 'Importe (S/)' }], value: 'PERCENT' },
        { name: 'value', label: 'Valor', type: 'money', required: true },
      ],
      submitLabel: 'Aplicar',
      onSubmit: async (v) => {
        const d = { type: v.type, value: v.value };
        await ctx.api.post('/sales/quote', { branchId: ctx.branchId, items: itemsOf(cart), discount: d });
        chosen = d;
        return true;
      },
    });
    if (res && chosen) setDiscount(chosen);
  }

  // ------------------------------------------------------------- atajos
  const canConfirm = Boolean(cashSession && quote && !quoteError);
  const confirmBtn = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.key === 'Enter' && confirmBtn.current && !confirmBtn.current.disabled) confirmBtn.current.click();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const reloadSoon = useDebouncedCallback(() => loadProducts(), 500);
  useRealtime('inventory:changed', reloadSoon);
  useRealtime('cash:closed', checkSession);
  useRealtime('cash:opened', checkSession);

  // ------------------------------------------------------------- pintado
  return (
    <>
      <div>
        {banner?.kind === 'none' ? (
          <AlertBox tone="warning">
            <div className="row between">
              <span>No tiene una caja abierta. Abra una sesión de caja para poder vender.</span>
              {ctx.can('cash.open') ? <Button variant="primary" size="sm" onClick={() => ctx.navigate('cash')}>Abrir caja</Button> : null}
            </div>
          </AlertBox>
        ) : null}
        {banner?.kind === 'other' ? <AlertBox tone="warning">{`Su caja abierta (${banner.s.register.name}) es de ${banner.s.branch.name}. Cambie la sucursal activa para vender.`}</AlertBox> : null}
        {banner?.kind === 'error' ? <AlertBox tone="danger">{errorMessage(banner.err)}</AlertBox> : null}
      </div>
      <div className="pos">
        <div className="stack">
          <div className="card card-body stack">
            <div className="search">
              <Icon name="search" />
              <input
                ref={searchRef} className="input" type="search" placeholder="Buscar por nombre, SKU o código de barras… (Enter agrega)" aria-label="Buscar producto" autoComplete="off"
                value={search} onChange={(e) => { setSearch(e.target.value); onSearchInput(e.target.value); }} onKeyDown={onSearchKey}
              />
            </div>
          </div>
          <div className="pos-products" aria-live="polite">
            {products.loading && !products.list.length ? <Spinner label="Buscando productos…" />
              : products.error ? <ErrorState error={products.error} onRetry={loadProducts} />
                : !products.list.length ? <EmptyState title="Sin coincidencias" text="Pruebe con otro nombre, SKU o código de barras." />
                  : products.list.map((p) => (
                    <button key={p.productId} type="button" className="pos-product" disabled={!p.canSell} onClick={() => addToCart(p)} aria-label={`${p.name}, ${money(p.price)}, ${p.availableStock} disponibles`}>
                      <span className="name">{p.name}</span>
                      <span className="small muted">{[p.presentation, p.concentration].filter(Boolean).join(' · ') || p.sku}</span>
                      <span className="row" style={{ gap: '6px' }}>
                        {p.canSell ? <ToneBadge tone={p.availableStock > 10 ? 'success' : 'warning'}>{`${p.availableStock} disp.`}</ToneBadge> : <ToneBadge tone="danger">{p.isAvailable ? 'Sin stock' : 'No habilitado'}</ToneBadge>}
                        {p.requiresPrescription ? <ToneBadge tone="info">Receta</ToneBadge> : null}
                        {p.expiringSoon ? <ToneBadge tone="warning">{`Vence ${date(p.nextExpiryDate)}`}</ToneBadge> : null}
                      </span>
                      <span className="price">{money(p.price)}</span>
                    </button>
                  ))}
          </div>
        </div>
        <div className="card pos-cart">
          <div className="card-head">
            <h2>Venta actual</h2>
            {cart.length ? <Button variant="ghost" size="sm" onClick={() => { setCart([]); setDiscount(null); setCustomer(null); }}>Vaciar</Button> : null}
          </div>
          <div className="card-body stack">
            {!cart.length ? <EmptyState title="Carrito vacío" text="Busque y seleccione productos para empezar." /> : (
              <>
                <div>
                  {cart.map((l) => {
                    const q = quoteLine(l.productId);
                    return (
                      <div className="cart-line" key={l.productId}>
                        <div>
                          <div className="strong">{l.name}</div>
                          <div className="small muted">{q ? `${money(q.unitPrice)} c/u` : l.sku}</div>
                          {q && !q.stockSufficient ? <div className="error small">{`Stock disponible: ${q.availableStock}`}</div> : null}
                        </div>
                        <div className="right">
                          <div className="strong">{q ? money(q.lineTotal) : '…'}</div>
                          {q && q.discountAmount !== '0.00' ? <div className="small muted">{`desc. −${money(q.discountAmount)}`}</div> : null}
                        </div>
                        <div className="row" style={{ gridColumn: '1 / -1', justifyContent: 'space-between' }}>
                          <div className="qty">
                            <button type="button" aria-label="Restar" onClick={() => setQty(l, l.quantity - 1)}>−</button>
                            <input
                              key={`${l.productId}-${l.quantity}`} type="number" min={1} defaultValue={l.quantity} aria-label={`Cantidad de ${l.name}`}
                              onBlur={(e) => { if (Number(e.target.value) !== l.quantity) setQty(l, e.target.value); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setQty(l, e.currentTarget.value); } }}
                            />
                            <button type="button" aria-label="Sumar" onClick={() => setQty(l, l.quantity + 1)}>+</button>
                          </div>
                          <Button variant="ghost" size="sm" icon="trash" title="Quitar" onClick={() => setCart((c) => c.filter((x) => x.productId !== l.productId))} />
                        </div>
                        {l.requiresPrescription ? (
                          <div className="field" style={{ gridColumn: '1 / -1' }}>
                            <label>N.º de receta *</label>
                            <input className="input" value={l.prescriptionReference} placeholder="Referencia de la receta médica" onChange={(e) => updateLine(l.productId, { prescriptionReference: e.target.value.trim() })} />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {quoteError ? <AlertBox tone="danger">{errorMessage(quoteError)}</AlertBox> : null}

                <div className="row between">
                  <span className="small">{customer ? <span>Cliente: <strong>{customer.label}</strong></span> : 'Venta sin cliente'}</span>
                  <div className="row">
                    {customer ? <Button size="sm" variant="ghost" onClick={() => setCustomer(null)}>Quitar</Button> : null}
                    <Button size="sm" icon="user" onClick={pickCustomer}>{customer ? 'Cambiar' : 'Agregar cliente'}</Button>
                  </div>
                </div>

                {ctx.can('sales.discount') ? (
                  <div className="row between">
                    <span className="small">{discount ? `Descuento: ${discount.type === 'PERCENT' ? `${discount.value} %` : money(discount.value)}` : 'Sin descuento'}</span>
                    <div className="row">
                      {discount ? <Button size="sm" variant="ghost" onClick={() => setDiscount(null)}>Quitar</Button> : null}
                      <Button size="sm" icon="tag" onClick={pickDiscount}>Descuento</Button>
                    </div>
                  </div>
                ) : null}

                {quote ? (
                  <div className="totals">
                    <span>Subtotal</span><span className="right">{money(quote.subtotal)}</span>
                    {quote.discountTotal !== '0.00' ? <><span>Descuento</span><span className="right">{`− ${money(quote.discountTotal)}`}</span></> : null}
                    <span className="grand">Total</span><span className="grand right">{money(total)}</span>
                  </div>
                ) : null}

                <PaymentSection
                  split={split} payments={payments} total={total} quote={quote} setPayment={setPayment}
                  onSplit={(on) => { attempt.current.key = null; setSplit(on); setPayments(on ? [NEW_PAYMENT(), { method: 'CARD', amount: '' }] : [NEW_PAYMENT()]); }}
                />
                <Button ref={confirmBtn} variant="success" size="lg" icon="check" block disabled={!canConfirm} onClick={confirmSale}>Cobrar y confirmar venta</Button>
                <p className="small muted">Atajo: Ctrl + Enter. Los importes los calcula el servidor.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Solo informativo: vuelto y saldo estimados; el servidor valida montos exactos. */
function PaymentSection({ split, payments, quote, setPayment, onSplit }) {
  const totalC = quote ? cents(quote.total) : 0;
  let assigned = 0;
  const rows = payments.map((p, idx) => {
    const amount = split ? (cents(p.amount) ?? 0) : totalC;
    assigned += amount;
    let change = null;
    if (p.method === 'CASH') {
      const tendered = p.tenderedAmount ? cents(p.tenderedAmount) : amount;
      const bad = tendered === null || tendered < amount;
      change = {
        bad,
        text: tendered === null ? 'Importe inválido' : tendered < amount ? `Faltan ${money(fromCents(amount - tendered))}` : `Vuelto: ${money(fromCents(tendered - amount))}`,
      };
    }
    return (
      <div key={idx} className="stack" style={{ padding: '10px', border: '1px solid var(--border)', borderRadius: '8px' }}>
        <div className="pay-methods" role="group" aria-label={`Método del pago ${idx + 1}`}>
          {Object.entries(PAYMENT_METHODS).filter(([k]) => k !== 'OTHER').map(([k, label]) => (
            <button key={k} type="button" aria-pressed={String(p.method === k)} onClick={() => setPayment(idx, { method: k })}>{label}</button>
          ))}
        </div>
        {split ? (
          <div className="field">
            <label>{`Importe del pago ${idx + 1}`}</label>
            <input className="input" inputMode="decimal" value={p.amount} placeholder="0.00" onChange={(e) => setPayment(idx, { amount: e.target.value.trim() })} />
          </div>
        ) : null}
        {p.method === 'CASH' ? (
          <>
            <div className="field">
              <label>Efectivo recibido</label>
              <input className="input" inputMode="decimal" value={p.tenderedAmount || ''} placeholder="Igual al importe" onChange={(e) => setPayment(idx, { tenderedAmount: e.target.value.trim() })} />
            </div>
            <div className={`small strong ${change.bad ? 'error' : ''}`} data-change={idx}>{change.text}</div>
          </>
        ) : (
          <label className="check small">
            <input type="checkbox" checked={p.simulate === 'REJECT'} onChange={(e) => setPayment(idx, { simulate: e.target.checked ? 'REJECT' : undefined })} />
            Simular rechazo (DEMO)
          </label>
        )}
      </div>
    );
  });
  return (
    <div className="stack">
      <div className="row between">
        <span className="label">Pago</span>
        <label className="check small"><input type="checkbox" checked={split} onChange={(e) => onSplit(e.target.checked)} />Pago dividido</label>
      </div>
      {rows}
      <div className="small" data-remaining="1">{split ? (assigned === totalC ? 'Los pagos cubren el total.' : `Por asignar: ${money(fromCents(totalC - assigned))}`) : ''}</div>
    </div>
  );
}
