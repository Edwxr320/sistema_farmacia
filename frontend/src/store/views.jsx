import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore, useStoreEvent } from './context.jsx';
import {
  Button, Icon, toast, Spinner, EmptyState, ErrorState, Card, KV, AlertBox, Badge, ToneBadge, Pagination, Select, confirmDialog, useAsync, Async, useDebouncedCallback,
} from '../components/ui.jsx';
import { Form, formModal } from '../components/form.jsx';
import { money, dateTime, date, idempotencyKey, PAYMENT_METHODS, FULFILLMENT, errorMessage, cents, fromCents } from '../core/format.js';
import { HeroArt } from './StoreArt.jsx';
import { ProductImage, hasProductImage } from '../components/ProductImage.jsx';
import { ShieldCheckIcon } from '../access/AccessArt.jsx';

export const TITLES = {
  Home: '', Catalog: 'Catálogo', Product: 'Producto', Cart: 'Carrito', Checkout: 'Finalizar compra', Orders: 'Mis pedidos',
  Order: 'Pedido', Account: 'Mi cuenta',
};
const STORE_METHODS = ['CASH', 'YAPE', 'PLIN', 'CARD', 'TRANSFER'];

// ------------------------------------------------------------ componentes
function ProductCard({ p }) {
  const ctx = useStore();
  const sub = [p.presentation, p.laboratory].filter(Boolean).join(' · ');
  return (
    <article className="product-card st-pcard">
      <Link to={`/producto/${p.id}`} className={`img${hasProductImage(p) ? ' has-photo' : ''}`} aria-label={p.name}><ProductImage key={p.id} product={p} /></Link>
      <div className="body">
        <div className="st-pcat">{p.category.name}</div>
        <Link to={`/producto/${p.id}`} className="name">{p.name}</Link>
        {sub ? <div className="st-psub">{sub}</div> : null}
        <div className="st-ptags">
          {p.requiresPrescription ? <ToneBadge tone="info">Requiere receta</ToneBadge> : null}
          {p.inStock ? <ToneBadge tone="success">Disponible</ToneBadge> : <ToneBadge tone="neutral">Sin stock</ToneBadge>}
        </div>
        <div className="st-pfoot">
          <span className="price">{money(p.price)}</span>
          <Button variant={p.inStock ? 'primary' : ''} size="sm" icon={p.inStock ? 'cart' : undefined} disabled={!p.inStock} onClick={() => ctx.addToCart(p, 1)}>{p.inStock ? 'Agregar' : 'Agotado'}</Button>
        </div>
      </div>
    </article>
  );
}

function ProductsGrid({ list, empty = 'No encontramos productos' }) {
  return list.length
    ? <div className="products">{list.map((p) => <ProductCard key={p.id} p={p} />)}</div>
    : <EmptyState title={empty} text="Pruebe con otra búsqueda o categoría." />;
}

function SectionHead({ title, link, icon }) {
  return <div className="section-head">{icon ? <h2 className="st-sec-title"><Icon name={icon} />{title}</h2> : <h2>{title}</h2>}{link || null}</div>;
}

function SeeAll({ to }) {
  return <Link to={to} className="st-seeall">Ver todos<Icon name="arrowRight" /></Link>;
}

// ------------------------------------------------------------------ inicio
export function Home() {
  const ctx = useStore();
  const s = ctx.settings;
  const branch = ctx.branch();
  const state = useAsync(async () => {
    const [cats, featured] = await Promise.all([
      ctx.api.get('/store/categories', { branchId: ctx.branchId }),
      ctx.api.get('/store/products', { branchId: ctx.branchId, inStock: 'true', pageSize: 10 }),
    ]);
    return { cats: cats.data, featured: featured.data };
  }, []);
  const deliverySub = s.deliveryFee === undefined || s.deliveryFee === null ? 'En distritos con cobertura'
    : `${Number(s.deliveryFee) === 0 ? 'Envío sin costo' : `Envío ${money(s.deliveryFee)}`} · distritos con cobertura`;
  return (
    <>
      <section className="st-hero-row hero" aria-label="Pharma Plus">
        <div className="st-banner">
          <div className="st-banner-text">
            <h1>Cuida tu salud<br />con <span className="st-green">Pharma Plus</span></h1>
            <p>Medicamentos de calidad, siempre contigo</p>
            <Link to="/catalogo" className="st-btn-green">Ver productos<Icon name="arrowRight" /></Link>
          </div>
          <HeroArt theme={ctx.theme} className="st-banner-art" />
        </div>
        <ul className="st-benefits" aria-label="Beneficios">
          <li><span className="st-bic st-bic-green"><ShieldCheckIcon /></span><div><strong>Compra segura</strong><span>Tus datos protegidos</span></div></li>
          <li><span className="st-bic st-bic-blue"><Icon name="truck" /></span><div><strong>Recojo en tienda y delivery</strong><span title={branch ? `Recojo en ${branch.name}` : undefined}>{deliverySub}</span></div></li>
          <li><span className="st-bic st-bic-blue"><Icon name="headset" /></span><div><strong>Atención personalizada</strong><span>Siempre contigo</span></div></li>
        </ul>
      </section>
      <Async state={state}>
        {({ cats, featured }) => (
          <>
            <section>
              <SectionHead icon="star" title="Productos destacados" link={<SeeAll to="/catalogo" />} />
              <ProductsGrid list={featured} empty={`Aún no hay productos con stock en ${branch?.name || 'esta sucursal'}`} />
            </section>
            {cats.length ? (
              <section>
                <SectionHead icon="tag" title="Categorías" link={<SeeAll to="/catalogo" />} />
                <div className="chips">
                  {cats.map((c) => <button key={c.id} className="chip" type="button" onClick={() => ctx.navigate('catalogo', { cat: c.id })}>{`${c.name} (${c.products})`}</button>)}
                </div>
              </section>
            ) : null}
          </>
        )}
      </Async>
    </>
  );
}

// ---------------------------------------------------------------- catálogo
export function Catalog({ query }) {
  const ctx = useStore();
  const f = { q: query.q || '', categoryId: query.cat || '', sort: query.sort || 'name', inStock: query.stock === '1', page: Number(query.page) || 1 };
  const [text, setText] = useState(f.q);
  const sync = (patch) => {
    const n = { ...f, ...patch };
    ctx.navigate('catalogo', { q: n.q || undefined, cat: n.categoryId || undefined, sort: n.sort !== 'name' ? n.sort : undefined, stock: n.inStock ? '1' : undefined, page: n.page > 1 ? n.page : undefined });
  };
  const syncSearch = useDebouncedCallback((v) => sync({ q: v.trim(), page: 1 }), 450);
  useEffect(() => { setText(query.q || ''); }, [query.q]);

  const cats = useAsync(async () => (await ctx.api.get('/store/categories', { branchId: ctx.branchId })).data, []);
  const key = JSON.stringify(f);
  const results = useAsync(
    () => ctx.api.get('/store/products', { branchId: ctx.branchId, q: f.q || undefined, categoryId: f.categoryId || undefined, sort: f.sort, inStock: f.inStock ? 'true' : undefined, page: f.page, pageSize: 20 }),
    [key],
  );
  const cat = (cats.data || []).find((c) => String(c.id) === String(f.categoryId));

  if (cats.error) return <ErrorState error={cats.error} onRetry={cats.reload} />;
  if (!cats.data) return <Spinner />;
  return (
    <>
      <div><h1>{cat ? cat.name : 'Catálogo'}</h1><p className="muted">{`Precios y disponibilidad de ${ctx.branch()?.name || 'la sucursal seleccionada'}.`}</p></div>
      <div className="card card-body stack">
        <div className="toolbar">
          <div className="search grow">
            <Icon name="search" />
            <input className="input" type="search" placeholder="Buscar en el catálogo…" aria-label="Buscar en el catálogo" value={text} onChange={(e) => { setText(e.target.value); syncSearch(e.target.value); }} />
          </div>
          <Select options={[{ value: 'name', label: 'Nombre (A-Z)' }, { value: 'price_asc', label: 'Precio: menor a mayor' }, { value: 'price_desc', label: 'Precio: mayor a menor' }]} value={f.sort} onChange={(v) => sync({ sort: v, page: 1 })} label="Ordenar por" />
          <label className="check"><input type="checkbox" checked={f.inStock} onChange={(e) => sync({ inStock: e.target.checked, page: 1 })} />Solo con stock</label>
        </div>
        <div className="chips" role="group" aria-label="Categorías">
          <button className="chip" type="button" aria-pressed={String(!f.categoryId)} onClick={() => sync({ categoryId: '', page: 1 })}>Todas</button>
          {cats.data.map((c) => <button key={c.id} className="chip" type="button" aria-pressed={String(String(c.id) === String(f.categoryId))} onClick={() => sync({ categoryId: c.id, page: 1 })}>{c.name}</button>)}
        </div>
      </div>
      <div className="stack">
        <Async state={results}>
          {(r) => <><ProductsGrid list={r.data} /><Pagination p={r.pagination} onChange={(p) => sync({ page: p })} /></>}
        </Async>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- producto
export function Product({ params }) {
  const ctx = useStore();
  const state = useAsync(async () => (await ctx.api.get(`/store/products/${params.id}`, { branchId: ctx.branchId })).data, [params.id]);
  const [qty, setQtyState] = useState(1);
  return (
    <Async state={state}>
      {(p) => {
        const setQty = (n) => setQtyState(Math.max(1, Math.min(n, p.maxPurchasable || 1)));
        const add = <Button variant="primary" size="lg" icon="cart" disabled={!p.inStock} onClick={() => ctx.addToCart(p, qty)}>{p.inStock ? 'Agregar al carrito' : 'Sin stock en esta sucursal'}</Button>;
        return (
          <>
            <nav className="small" aria-label="Ruta"><Link to="/catalogo">Catálogo</Link>{' / '}<Link to={`/catalogo?cat=${p.category.id}`}>{p.category.name}</Link></nav>
            <section className="product-detail">
              <div className={`img${hasProductImage(p) ? ' has-photo' : ''}`}><ProductImage key={p.id} product={p} alt={p.name} loading="eager" /></div>
              <div className="stack">
                <div className="small muted">{`${p.category.name}${p.laboratory ? ` · ${p.laboratory}` : ''}`}</div>
                <h1>{p.name}</h1>
                <div className="row">
                  {p.requiresPrescription ? <ToneBadge tone="info">Requiere receta médica</ToneBadge> : <ToneBadge tone="success">Venta libre</ToneBadge>}
                  {p.inStock ? <ToneBadge tone="success">Disponible</ToneBadge> : <ToneBadge tone="neutral">Sin stock</ToneBadge>}
                </div>
                <div className="price" style={{ fontSize: '30px', fontWeight: 750, color: 'var(--navy)' }}>{money(p.price)}</div>
                <p className="small muted">{`Precio en ${p.branch.name}.`}</p>
                {p.inStock ? (
                  <div className="row">
                    <div className="qty" role="group" aria-label="Cantidad">
                      <Button size="sm" icon="minus" title="Menos" onClick={() => setQty(qty - 1)} />
                      <span className="strong" aria-live="polite" style={{ minWidth: '28px', textAlign: 'center' }}>{String(qty)}</span>
                      <Button size="sm" icon="plus" title="Más" onClick={() => setQty(qty + 1)} />
                    </div>
                    {add}
                  </div>
                ) : add}
                {p.inStock && p.maxPurchasable < 100 ? <p className="small muted">{`Máximo ${p.maxPurchasable} unidades por pedido.`}</p> : null}
                {p.requiresPrescription ? <AlertBox tone="info">Para comprar este producto deberá indicar el número de su receta médica. La botica la verificará antes de aceptar el pedido.</AlertBox> : null}
                <Card title="Información"><KV pairs={[['Principio activo', p.activeIngredient], ['Concentración', p.concentration], ['Forma farmacéutica', p.dosageForm], ['Presentación', p.presentation], ['Laboratorio', p.laboratory], ['Código', p.sku]]} /></Card>
                {p.description ? <Card title="Descripción"><p>{p.description}</p></Card> : null}
              </div>
            </section>
          </>
        );
      }}
    </Async>
  );
}

// ----------------------------------------------------------------- carrito
const ISSUES = { NOT_AVAILABLE: 'Ya no está disponible en esta sucursal', OUT_OF_STOCK: 'Agotado', INSUFFICIENT_STOCK: 'Stock insuficiente para esa cantidad' };

export function Cart() {
  const ctx = useStore();
  const [cart, setCart] = useState(null);
  const [error, setError] = useState(null);
  const load = async () => {
    try { setCart((await ctx.api.get('/store/cart')).data); setError(null); } catch (err) { setError(err); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function change(i, q) {
    try {
      const r = q <= 0 ? await ctx.api.del(`/store/cart/items/${i.productId}`) : await ctx.api.put(`/store/cart/items/${i.productId}`, { quantity: q });
      await ctx.refreshCart();
      setCart(r.data);
    } catch (err) { toast(err.code === 'INSUFFICIENT_STOCK' && err.details ? `Puede comprar hasta ${err.details.available} unidades` : errorMessage(err), 'error'); }
  }

  let body;
  if (error) body = <ErrorState error={error} onRetry={load} />;
  else if (!cart) body = <Spinner />;
  else if (!cart.items.length) body = <EmptyState title="Su carrito está vacío" text="Explore el catálogo y agregue productos." action={<Link to="/catalogo" className="btn btn-primary">Ir al catálogo</Link>} />;
  else {
    const c = cart;
    body = (
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(260px,1fr)', alignItems: 'start' }}>
        <Card title={`Productos (${c.itemsCount})`} actions={(
          <Button variant="ghost" size="sm" onClick={async () => {
            if (!(await confirmDialog({ title: 'Vaciar carrito', message: '¿Quitar todos los productos?', danger: true, confirmText: 'Vaciar' }))) return;
            try { const r = await ctx.api.del('/store/cart'); await ctx.refreshCart(); setCart(r.data); } catch (err) { toast(errorMessage(err), 'error'); }
          }}>Vaciar carrito</Button>
        )}>
          <div className="stack">
            {c.items.map((i) => (
              <div className="cart-line" key={i.productId}>
                <div className="grow">
                  <Link to={`/producto/${i.productId}`} className="strong">{i.name}</Link>
                  <div className="small muted">{`${money(i.unitPrice)} c/u${i.requiresPrescription ? ' · requiere receta' : ''}`}</div>
                  {i.issues.map((code) => <div key={code} className="small error">{ISSUES[code] || code}</div>)}
                </div>
                <div className="qty" role="group" aria-label={`Cantidad de ${i.name}`}>
                  <Button size="sm" icon="minus" title="Quitar una unidad" onClick={() => change(i, i.quantity - 1)} />
                  <span className="strong">{String(i.quantity)}</span>
                  <Button size="sm" icon="plus" title="Agregar una unidad" disabled={i.quantity >= i.maxPurchasable} onClick={() => change(i, i.quantity + 1)} />
                </div>
                <div className="strong num" style={{ minWidth: '90px', textAlign: 'right' }}>{money(i.lineTotal)}</div>
                <Button variant="ghost" size="sm" icon="trash" title={`Quitar ${i.name}`} onClick={() => change(i, 0)} />
              </div>
            ))}
          </div>
        </Card>
        <Card title="Resumen">
          <div className="stack">
            <KV pairs={[['Sucursal', c.branch.name], ['Subtotal', <strong>{money(c.subtotal)}</strong>]]} />
            <p className="small muted">El costo de envío (si elige delivery) y el total final se confirman en el siguiente paso.</p>
            {!c.canCheckout ? <AlertBox tone="warning">Hay productos sin stock suficiente o no disponibles.</AlertBox> : null}
            <Link to="/checkout" className={`btn btn-primary btn-lg ${c.canCheckout ? '' : 'disabled'}`} aria-disabled={String(!c.canCheckout)}
              onClick={(e) => { if (!c.canCheckout) { e.preventDefault(); toast('Corrija los productos marcados antes de continuar', 'warning'); } }}>Continuar con la compra</Link>
          </div>
        </Card>
      </div>
    );
  }
  return <><h1>Carrito</h1><div className="stack">{body}</div></>;
}

// ---------------------------------------------------------------- checkout
function Choice({ name, value, current, title, sub, onPick }) {
  return (
    <label className="choice">
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => onPick(value)} />
      <div><div className="strong">{title}</div>{sub ? <div className="small muted">{sub}</div> : null}</div>
    </label>
  );
}

export function Checkout() {
  const ctx = useStore();
  const state = useAsync(async () => {
    const [cartR, addrR] = await Promise.all([ctx.api.get('/store/cart'), ctx.api.get('/store/me/addresses')]);
    return { c: cartR.data, addresses: addrR.data };
  }, []);
  useEffect(() => {
    if (!state.data) return;
    const { c } = state.data;
    if (!c.items.length) ctx.navigate('carrito');
    else if (!c.canCheckout) { toast('Revise su carrito: hay productos sin stock', 'warning'); ctx.navigate('carrito'); }
  }, [state.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Async state={state}>
      {({ c, addresses }) => (c.items.length && c.canCheckout ? <CheckoutForm c={c} initialAddresses={addresses} /> : <Spinner />)}
    </Async>
  );
}

function CheckoutForm({ c, initialAddresses }) {
  const ctx = useStore();
  const s = ctx.settings;
  const [addresses, setAddresses] = useState(initialAddresses);
  const [fulfillment, setFulfillment] = useState('PICKUP');
  const [addressId, setAddressId] = useState(initialAddresses.find((a) => a.isDefault)?.id ?? initialAddresses[0]?.id ?? null);
  const [method, setMethod] = useState('CASH');
  const [simulateReject, setSimulateReject] = useState(false);
  const [expectedTotal, setExpectedTotal] = useState(null);
  const [note, setNote] = useState('');
  const [rx, setRx] = useState({});
  const [error, setError] = useState(null);
  const attempt = useRef({ key: idempotencyKey('web'), sig: '' });
  const rxRefs = useRef({});
  const rxItems = c.items.filter((i) => i.requiresPrescription);
  // El servidor decide si hay pagos electrónicos (PAYMENT_PROVIDER); sin proveedor, solo efectivo.
  const electronicEnabled = s.payments?.electronicEnabled !== false;
  const methods = electronicEnabled ? STORE_METHODS : ['CASH'];

  const fee = () => (fulfillment === 'DELIVERY' ? (s.deliveryFee ?? '0.00') : '0.00');
  const total = () => expectedTotal ?? fromCents(cents(c.subtotal) + cents(fee()));
  const pickFulfillment = (v) => { setFulfillment(v); setExpectedTotal(null); };

  async function submit() {
    setError(null);
    const prescriptions = {};
    for (const i of rxItems) {
      const v = (rx[String(i.productId)] || '').trim();
      if (v.length < 3) { setError({ tone: 'warning', text: 'Indique el número de receta de los productos que la requieren.' }); rxRefs.current[String(i.productId)]?.focus(); return; }
      prescriptions[String(i.productId)] = v;
    }
    if (fulfillment === 'DELIVERY' && !addressId) { setError({ tone: 'warning', text: 'Seleccione o agregue una dirección de entrega.' }); return; }
    const body = {
      fulfillmentType: fulfillment, paymentMethod: method, expectedTotal: total(),
      ...(fulfillment === 'DELIVERY' ? { addressId: Number(addressId) } : {}),
      ...(method !== 'CASH' ? { simulatePayment: simulateReject ? 'REJECT' : 'APPROVE' } : {}),
      ...(note.trim() ? { customerNote: note.trim() } : {}),
      ...(rxItems.length ? { prescriptions } : {}),
    };
    // Misma intención = misma clave (reintentos seguros); si cambian los datos, clave nueva.
    const sig = JSON.stringify(body);
    if (sig !== attempt.current.sig) attempt.current = { sig, key: idempotencyKey('web') };
    try {
      const r = await ctx.api.post('/store/orders', body, { headers: { 'Idempotency-Key': attempt.current.key } });
      await ctx.refreshCart();
      toast(`Pedido ${r.data.orderNumber} registrado`, 'success');
      ctx.navigate(`pedidos/${r.data.id}`, { nuevo: '1' });
    } catch (err) {
      if (err.code === 'PRICE_CHANGED' && err.details?.total) {
        setExpectedTotal(err.details.total);
        setError({ tone: 'warning', text: `Los precios o el costo de envío cambiaron. Nuevo total: ${money(err.details.total)}. Presione "Confirmar pedido" para aceptarlo.` });
        return;
      }
      if (err.code === 'PAYMENT_REJECTED') {
        attempt.current = { key: idempotencyKey('web'), sig: '' };
        setError({ tone: 'danger', text: `${err.message}${err.details?.orderNumber ? ` (pedido ${err.details.orderNumber})` : ''} Puede intentar con otro método.` });
        return;
      }
      const d = Array.isArray(err.details) ? err.details.map((x) => x.message).join(' · ') : '';
      setError({ tone: 'danger', text: `${errorMessage(err)}${d ? ` — ${d}` : ''}` });
    }
  }

  return (
    <>
      <h1>Finalizar compra</h1>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(260px,1fr)', alignItems: 'start' }}>
        <div className="stack">
          <Card title="1. Entrega">
            <div className="stack">
              <div className="grid grid-2" role="radiogroup" aria-label="Modalidad de entrega">
                <Choice name="fulfillment" value="PICKUP" current={fulfillment} title="Recojo en tienda" sub={`${c.branch.name} · sin costo`} onPick={pickFulfillment} />
                <Choice name="fulfillment" value="DELIVERY" current={fulfillment} title="Delivery a domicilio"
                  sub={s.deliveryFee !== undefined && s.deliveryFee !== null ? (Number(s.deliveryFee) === 0 ? 'Envío sin costo' : `Envío ${money(s.deliveryFee)}`) : 'Costo según configuración de la botica'} onPick={pickFulfillment} />
              </div>
              {fulfillment === 'DELIVERY' ? (
                <div className="stack">
                  {Array.isArray(s.deliveryDistricts) ? <AlertBox tone="info">{s.deliveryDistricts.length ? `Distritos con cobertura: ${s.deliveryDistricts.join(', ')}.` : 'Por ahora no hay distritos con cobertura de delivery.'}</AlertBox> : null}
                  {addresses.length ? (
                    <div className="stack" role="radiogroup" aria-label="Dirección de entrega">
                      {addresses.map((a) => (
                        <Choice key={a.id} name="address" value={a.id} current={addressId} title={`${a.label ? `${a.label}: ` : ''}${a.addressLine}`}
                          sub={`${[a.district, a.province].filter(Boolean).join(', ')} · Recibe ${a.recipientName} (${a.phone})`} onPick={(v) => { setAddressId(v); setExpectedTotal(null); }} />
                      ))}
                    </div>
                  ) : <AlertBox tone="warning">Agregue una dirección para el delivery.</AlertBox>}
                  <div>
                    <Button icon="plus" onClick={async () => {
                      const created = await addressModal(ctx);
                      if (created) { setAddresses((await ctx.api.get('/store/me/addresses')).data); setAddressId(created.id); }
                    }}>Agregar dirección</Button>
                  </div>
                </div>
              ) : null}
            </div>
          </Card>
          {rxItems.length ? (
            <Card title="2. Recetas médicas">
              <div className="stack">
                <p className="small muted">Indique el número de receta de cada producto. Deberá presentar la receta física al recoger o recibir el pedido.</p>
                {rxItems.map((i) => (
                  <div className="field" key={i.productId}>
                    <label>{i.name}</label>
                    <input ref={(el) => { rxRefs.current[String(i.productId)] = el; }} className="input" maxLength={80} placeholder="N.º de receta" aria-label={`Número de receta para ${i.name}`}
                      value={rx[String(i.productId)] || ''} onChange={(e) => setRx((r) => ({ ...r, [String(i.productId)]: e.target.value }))} />
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
          <Card title={`${rxItems.length ? 3 : 2}. Pago`}>
            <div className="stack">
              <AlertBox tone="info">{electronicEnabled
                ? 'Pagos de demostración: no se realiza ningún cobro real ni se solicitan datos de tarjeta.'
                : 'Por ahora solo se acepta pago en efectivo al recoger o recibir su pedido.'}</AlertBox>
              <div className="stack">
                <div className="stack" role="radiogroup" aria-label="Método de pago">
                  {methods.map((m) => (
                    <Choice key={m} name="method" value={m} current={method} title={PAYMENT_METHODS[m]}
                      sub={m === 'CASH' ? `Paga al ${fulfillment === 'PICKUP' ? 'recoger' : 'recibir'} su pedido` : 'Simulación de pago electrónico (DEMO, sin cobro real)'} onPick={setMethod} />
                  ))}
                </div>
                {method !== 'CASH' ? (
                  <label className="check small"><input type="checkbox" checked={simulateReject} onChange={(e) => setSimulateReject(e.target.checked)} />Simular pago rechazado (para probar el flujo DEMO)</label>
                ) : null}
              </div>
            </div>
          </Card>
          <Card title="Nota (opcional)">
            <textarea className="input" maxLength={300} placeholder="Indicaciones para la botica o el repartidor (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
          </Card>
        </div>
        <div className="stack" style={{ position: 'sticky', top: '90px' }}>
          <Card title={`Resumen · ${c.branch.name}`}>
            <div className="stack">
              <div className="stack">
                {c.items.map((i) => <div key={i.productId} className="row between small"><span>{`${i.quantity} × ${i.name}`}</span><span>{money(i.lineTotal)}</span></div>)}
                <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '6px 0' }} />
                <KV pairs={[['Subtotal', money(c.subtotal)], ['Envío', fulfillment === 'DELIVERY' ? money(fee()) : 'Gratis (recojo)'], ['Total', <strong style={{ fontSize: '18px' }}>{money(total())}</strong>]]} />
                {expectedTotal ? <AlertBox tone="warning">El total se actualizó con los precios vigentes. Confirme para continuar.</AlertBox> : null}
              </div>
              <div>{error ? <AlertBox tone={error.tone}>{error.text}</AlertBox> : null}</div>
              <Button variant="primary" size="lg" onClick={submit}>Confirmar pedido</Button>
              <Link to="/carrito" className="small">Volver al carrito</Link>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

// ----------------------------------------------------------------- pedidos
const STEPS = {
  PICKUP: [['PENDING', 'Recibido'], ['CONFIRMED', 'Aceptado'], ['PREPARING', 'En preparación'], ['READY_FOR_PICKUP', 'Listo para recoger'], ['COMPLETED', 'Entregado']],
  DELIVERY: [['PENDING', 'Recibido'], ['CONFIRMED', 'Aceptado'], ['PREPARING', 'En preparación'], ['OUT_FOR_DELIVERY', 'En camino'], ['COMPLETED', 'Entregado']],
};

export function Orders({ query }) {
  const ctx = useStore();
  const [page, setPage] = useState(Number(query.page) || 1);
  const state = useAsync(() => ctx.api.get('/store/orders', { page, pageSize: 10 }), [page]);
  useStoreEvent('order:status', state.reload);
  return (
    <>
      <h1>Mis pedidos</h1>
      <div className="stack">
        <Async state={state}>
          {(r) => (!r.data.length
            ? <EmptyState title="Aún no tiene pedidos" text="Cuando compre, podrá seguir aquí el estado de sus pedidos." action={<Link to="/catalogo" className="btn btn-primary">Ir al catálogo</Link>} />
            : (
              <>
                {r.data.map((o) => (
                  <Link key={o.id} to={`/pedidos/${o.id}`} className="card card-body row between" style={{ color: 'inherit' }}>
                    <div><div className="strong">{`Pedido ${o.orderNumber}`}</div><div className="small muted">{`${dateTime(o.createdAt)} · ${FULFILLMENT[o.fulfillmentType]} · ${o.branch.name} · ${o.itemsCount} producto(s)`}</div></div>
                    <div className="row"><Badge kind="order" code={o.status} /><strong>{money(o.total)}</strong></div>
                  </Link>
                ))}
                <Pagination p={r.pagination} onChange={setPage} />
              </>
            ))}
        </Async>
      </div>
    </>
  );
}

export function Order({ params, query }) {
  const ctx = useStore();
  const id = params.id;
  const state = useAsync(async () => (await ctx.api.get(`/store/orders/${id}`)).data, [id]);
  useStoreEvent('order:status', (p) => { if (String(p.orderId) === String(id)) state.reload(); });
  return (
    <div className="stack">
      <Async state={state}>
        {(o) => {
          const steps = STEPS[o.fulfillmentType];
          const idx = steps.findIndex(([st]) => st === o.status);
          const closed = ['CANCELLED', 'REJECTED'].includes(o.status);
          return (
            <>
              {query.nuevo ? <AlertBox tone="success">{`¡Gracias! Recibimos su pedido ${o.orderNumber}. La botica lo revisará y le avisaremos aquí cada cambio de estado.`}</AlertBox> : null}
              <div className="row between">
                <div><h1>{`Pedido ${o.orderNumber}`}</h1><p className="muted small">{`Realizado el ${dateTime(o.createdAt)} · ${o.branch.name}`}</p></div>
                <div className="row">
                  <Badge kind="order" code={o.status} />
                  {o.status === 'PENDING' ? (
                    <Button variant="danger" onClick={async () => {
                      const ok = await confirmDialog({ title: 'Cancelar pedido', message: 'Si pagó electrónicamente (DEMO), el pago se reembolsará.', danger: true, reason: true, confirmText: 'Cancelar pedido' });
                      if (!ok) return;
                      try { await ctx.api.post(`/store/orders/${o.id}/cancel`, { reason: ok.reason }); toast('Pedido cancelado', 'success'); state.reload(); } catch (err) { toast(errorMessage(err), 'error'); }
                    }}>Cancelar pedido</Button>
                  ) : null}
                </div>
              </div>
              {closed ? <AlertBox tone="danger">{`${o.status === 'CANCELLED' ? 'Pedido cancelado' : 'Pedido rechazado por la botica'}${o.cancelReason ? `: ${o.cancelReason}` : ''}`}</AlertBox> : (
                <Card title="Seguimiento">
                  <div className="steps" role="list">
                    {steps.map(([st, label], i) => (
                      <div key={st} role="listitem" className={`step ${i < idx ? 'done' : ''} ${i === idx ? (st === 'COMPLETED' ? 'done' : 'current') : ''}`} aria-current={i === idx ? 'step' : undefined}>{label}</div>
                    ))}
                  </div>
                </Card>
              )}
              <div className="grid grid-2">
                <Card title="Entrega">
                  <KV pairs={[['Modalidad', FULFILLMENT[o.fulfillmentType]], ['Sucursal', o.branch.name],
                    o.delivery ? ['Dirección', `${o.delivery.addressLine}${o.delivery.district ? `, ${o.delivery.district}` : ''}`] : null,
                    o.delivery ? ['Recibe', `${o.delivery.recipientName || ''} · ${o.delivery.phone}`] : null, ['Nota', o.customerNote]]} />
                </Card>
                <Card title="Importes">
                  <KV pairs={[['Subtotal', money(o.subtotal)], ['Envío', money(o.deliveryFee)], ['Total', <strong>{money(o.total)}</strong>], ['Pagado', money(o.paidAmount)],
                    ['Por pagar al recibir', o.balanceDue !== '0.00' && !closed ? <strong>{money(o.balanceDue)}</strong> : money('0.00')]]} />
                </Card>
              </div>
              <Card title="Productos">
                <div className="stack">
                  {o.items.map((i, k) => (
                    <div key={k} className="row between">
                      <div><div className="strong">{i.name}</div><div className="small muted">{`${i.quantity} × ${money(i.unitPrice)}${i.requiresPrescription ? ' · requiere receta' : ''}`}</div></div>
                      <strong>{money(i.lineTotal)}</strong>
                    </div>
                  ))}
                </div>
              </Card>
              {o.payments?.length ? (
                <Card title="Pagos">
                  <div className="stack">
                    {o.payments.map((p, k) => (
                      <div key={k} className="row between small">
                        <span>{`${PAYMENT_METHODS[p.method]}${p.mode === 'DEMO' ? ' (DEMO)' : ''} · ${p.reference || p.failureReason || ''}`}</span>
                        <span className="row"><Badge kind="payment" code={p.status} />{money(p.amount)}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}
              {o.history?.length ? (
                <Card title="Historial">
                  <div className="stack">
                    {o.history.map((x, k) => (
                      <div key={k} className="row between small">
                        <span><Badge kind="order" code={x.to} />{x.note ? <span className="muted">{` — ${x.note}`}</span> : null}</span>
                        <span className="muted">{dateTime(x.at)}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}
              <Link to="/pedidos">← Volver a mis pedidos</Link>
            </>
          );
        }}
      </Async>
    </div>
  );
}

// ------------------------------------------------------------------ cuenta
async function addressModal(ctx, a) {
  const r = await formModal({
    title: a ? 'Editar dirección' : 'Nueva dirección', size: 'lg',
    fields: [
      { name: 'label', label: 'Nombre (Casa, Trabajo…)', value: a?.label, emptyAs: null },
      { name: 'recipientName', label: 'Quién recibe', required: true, value: a?.recipientName ?? ctx.user?.fullName },
      { name: 'phone', label: 'Teléfono', required: true, value: a?.phone ?? ctx.user?.phone },
      { name: 'addressLine', label: 'Dirección', required: true, full: true, value: a?.addressLine },
      { name: 'referenceNote', label: 'Referencia', full: true, value: a?.referenceNote, emptyAs: null },
      { name: 'district', label: 'Distrito', value: a?.district, emptyAs: null },
      { name: 'province', label: 'Provincia', value: a?.province, emptyAs: null },
      { name: 'department', label: 'Departamento', value: a?.department, emptyAs: null },
      { name: 'isDefault', label: 'Usar como dirección principal', type: 'checkbox', value: a?.isDefault },
    ],
    onSubmit: (v) => (a ? ctx.api.put(`/store/me/addresses/${a.id}`, v) : ctx.api.post('/store/me/addresses', v)),
  });
  return r && r.data ? r.data : null;
}

export function Account() {
  const ctx = useStore();
  const state = useAsync(async () => {
    const [meR, addrR] = await Promise.all([ctx.api.get('/store/me'), ctx.api.get('/store/me/addresses')]);
    return { me: meR.data, addresses: addrR.data };
  }, []);
  const [addresses, setAddresses] = useState(null);
  const reloadAddresses = async () => { try { setAddresses((await ctx.api.get('/store/me/addresses')).data); } catch (err) { toast(errorMessage(err), 'error'); } };

  return (
    <Async state={state}>
      {({ me, addresses: initial }) => {
        const list = addresses ?? initial;
        return (
          <>
            <div className="row between">
              <div><h1>Mi cuenta</h1><p className="muted small">{`${me.email} · cliente desde ${date(me.memberSince)}`}</p></div>
              <Button icon="logout" onClick={() => ctx.logout()}>Cerrar sesión</Button>
            </div>
            {ctx.user.mustChangePassword ? <AlertBox tone="warning">Debe cambiar su contraseña para continuar.</AlertBox> : null}
            <div className="grid grid-2" style={{ alignItems: 'start' }}>
              <Card title="Datos personales">
                <Form
                  fields={[
                    { name: 'fullName', label: 'Nombre completo', required: true, full: true, value: me.fullName },
                    { name: 'phone', label: 'Teléfono', value: me.phone, emptyAs: null },
                    { name: 'birthDate', label: 'Fecha de nacimiento', type: 'date', value: me.birthDate ? String(me.birthDate).slice(0, 10) : '', emptyAs: null },
                    { name: 'documentType', label: 'Documento', type: 'select', value: me.documentType, placeholder: 'Sin documento', emptyAs: null,
                      options: [{ value: 'DNI', label: 'DNI' }, { value: 'CE', label: 'Carné de extranjería' }, { value: 'PASSPORT', label: 'Pasaporte' }, { value: 'RUC', label: 'RUC' }, { value: 'OTHER', label: 'Otro' }] },
                    { name: 'documentNumber', label: 'Número de documento', value: me.documentNumber, emptyAs: null },
                  ]}
                  submitLabel="Guardar datos"
                  onSubmit={async (v) => { await ctx.api.put('/store/me', v); toast('Datos actualizados', 'success'); await ctx.onLoggedIn(); }}
                />
              </Card>
              <Card title="Direcciones de entrega" actions={<Button size="sm" icon="plus" onClick={async () => { if (await addressModal(ctx)) reloadAddresses(); }}>Agregar</Button>}>
                <div className="stack">
                  {list.length ? list.map((a) => (
                    <div key={a.id} className="row between card card-body">
                      <div>
                        <div className="strong">{`${a.label || 'Dirección'}${a.isDefault ? ' · principal' : ''}`}</div>
                        <div className="small">{`${a.addressLine}${a.district ? `, ${a.district}` : ''}`}</div>
                        <div className="small muted">{`Recibe ${a.recipientName} · ${a.phone}`}</div>
                      </div>
                      <div className="row">
                        <Button size="sm" onClick={async () => { if (await addressModal(ctx, a)) reloadAddresses(); }}>Editar</Button>
                        <Button size="sm" variant="danger" onClick={async () => {
                          if (!(await confirmDialog({ title: 'Eliminar dirección', message: a.addressLine, danger: true, confirmText: 'Eliminar' }))) return;
                          try { await ctx.api.del(`/store/me/addresses/${a.id}`); reloadAddresses(); } catch (err) { toast(errorMessage(err), 'error'); }
                        }}>Eliminar</Button>
                      </div>
                    </div>
                  )) : <EmptyState title="Sin direcciones" text="Agregue una dirección para pedir delivery." />}
                </div>
              </Card>
            </div>
            <Card title="Seguridad">
              <Form
                fields={[
                  { name: 'currentPassword', label: 'Contraseña actual', type: 'password', required: true, full: true, autocomplete: 'current-password' },
                  { name: 'newPassword', label: 'Nueva contraseña', type: 'password', required: true, autocomplete: 'new-password', hint: 'Mínimo 10 caracteres, con mayúscula, minúscula y número.' },
                  { name: 'confirmPassword', label: 'Confirmar', type: 'password', required: true, autocomplete: 'new-password' },
                ]}
                submitLabel="Cambiar contraseña"
                onSubmit={async (v) => { await ctx.api.changePassword(v.currentPassword, v.newPassword, v.confirmPassword); toast('Contraseña actualizada', 'success'); await ctx.onLoggedIn(); }}
              />
            </Card>
          </>
        );
      }}
    </Async>
  );
}
