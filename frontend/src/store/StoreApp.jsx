import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { api } from '../core/api-client.js';
import { buildQuery, money } from '../core/format.js';
import { accessUrl } from '../core/redirect.js';
import { Button, Icon, Spinner, ErrorState, toast } from '../components/ui.jsx';
import { ModalHost, closeAllModals } from '../components/modal.jsx';
import * as views from './views.jsx';
import { StoreContext, useStore } from './context.jsx';

const LOGO = '/img/Logo-pharma-plus.jpeg';
const BRANCH_KEY = 'pp.store.branch';

const storage = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};


// Rutas: [path, vista, requiere cuenta]
const ROUTES = [
  ['/', 'Home', false],
  ['/catalogo', 'Catalog', false],
  ['/producto/:id', 'Product', false],
  ['/carrito', 'Cart', true],
  ['/checkout', 'Checkout', true],
  ['/pedidos', 'Orders', true],
  ['/pedidos/:id', 'Order', true],
  ['/cuenta', 'Account', true],
  ['/registro', 'Register', false],
];

export default function StoreApp() {
  const navigateRaw = useNavigate();
  const navRef = useRef(navigateRaw);
  navRef.current = navigateRaw;
  const location = useLocation();
  const [boot, setBoot] = useState({ state: 'loading' });
  const [user, setUser] = useState(null);
  const [staff, setStaff] = useState(null);
  const [settings, setSettings] = useState({});
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchIdState] = useState(null);
  const [cartCount, setCartCount] = useState(0);
  const listeners = useRef(new Map());
  const socketRef = useRef(null);
  const live = useRef({ user: null, staff: null, branchId: null });
  live.current = { user, staff, branchId };

  useEffect(() => {
    document.body.classList.add('store');
    return () => document.body.classList.remove('store');
  }, []);

  // Enlaces antiguos (/#/ruta?x=1) → /ruta?x=1
  useEffect(() => {
    if (location.hash.startsWith('#/')) navRef.current(`/${location.hash.slice(2)}`, { replace: true });
  }, [location.hash]);

  const navigate = useCallback((path, query) => {
    navRef.current(`/${String(path || '').replace(/^\//, '')}${query ? buildQuery(query) : ''}`);
  }, []);

  // ------------------------------------------------------------ socket
  const disconnectSocket = useCallback(() => {
    if (socketRef.current) { socketRef.current.close(); socketRef.current = null; }
  }, []);
  const connectSocket = useCallback(() => {
    if (socketRef.current) return;
    const s = io({ path: '/socket.io', transports: ['websocket', 'polling'], withCredentials: true });
    s.on('order:status', (payload = {}) => {
      toast(`Su pedido ${payload.orderNumber || ''} cambió de estado`, 'info');
      for (const fn of listeners.current.get('order:status') || []) { try { fn(payload); } catch { /* vista */ } }
    });
    socketRef.current = s;
  }, []);
  useEffect(() => () => disconnectSocket(), [disconnectSocket]);

  // ------------------------------------------------------------ sesión
  const setBranchLocal = (id) => { live.current.branchId = id; setBranchIdState(id); storage.set(BRANCH_KEY, String(id)); };

  const refreshCart = useCallback(async () => {
    if (!live.current.user) { setCartCount(0); return null; }
    try {
      const { data } = await api.get('/store/cart');
      setCartCount(data.items.reduce((a, i) => a + i.quantity, 0));
      if (data.branch?.id && data.branch.id !== live.current.branchId) setBranchLocal(data.branch.id);
      return data;
    } catch { return null; }
  }, []);

  const loadSession = useCallback(async () => {
    let u = null;
    let st = null;
    try {
      const me = await api.me();
      if (me.user.role.code === 'CUSTOMER') u = me.user;
      else st = me.user;
    } catch (err) {
      if (err.status !== 401) throw err;
    }
    live.current.user = u;
    live.current.staff = st;
    setUser(u);
    setStaff(st);
    if (u) {
      await refreshCart();
      connectSocket();
    } else setCartCount(0);
  }, [refreshCart, connectSocket]);

  const start = useCallback(async () => {
    setBoot({ state: 'loading' });
    try {
      const [s, list] = await Promise.all([
        api.get('/settings/public').then((r) => r.data).catch(() => ({})),
        api.get('/store/branches').then((r) => r.data),
      ]);
      setSettings(s);
      setBranches(list);
      const saved = Number(storage.get(BRANCH_KEY));
      const bid = list.some((b) => b.id === saved) ? saved : (list.find((b) => b.isMain) || list[0])?.id ?? null;
      live.current.branchId = bid;
      setBranchIdState(bid);
      await loadSession();
      setBoot({ state: 'ready' });
    } catch (err) {
      setBoot({ state: 'error', error: err });
    }
  }, [loadSession]);

  useEffect(() => { start(); }, [start]);

  useEffect(() => api.onUnauthorized(() => {
    if (!live.current.user) return;
    live.current.user = null;
    setUser(null);
    setCartCount(0);
    disconnectSocket();
    toast('Su sesión terminó. Ingrese nuevamente.', 'warning');
    const path = window.location.pathname;
    const r = ROUTES.find(([p]) => matchPath(p, path));
    if (r && r[2]) navRef.current(accessUrl(`${path}${window.location.search}`));
  }), [disconnectSocket]);

  const requireLogin = useCallback((reason) => {
    if (live.current.user) return true;
    if (live.current.staff) { toast('Hay una sesión del personal abierta. Cierre sesión para comprar como cliente.', 'warning'); return false; }
    if (reason) toast(reason, 'info');
    navRef.current(accessUrl(`${window.location.pathname}${window.location.search}`));
    return false;
  }, []);

  const ctx = useMemo(() => ({
    api,
    navigate,
    user,
    staff,
    settings,
    branches,
    branchId,
    cartCount,
    branch: () => branches.find((b) => b.id === branchId) || null,
    on(event, fn) {
      if (!listeners.current.has(event)) listeners.current.set(event, new Set());
      listeners.current.get(event).add(fn);
      return () => listeners.current.get(event)?.delete(fn);
    },
    requireLogin,
    async setBranch(id) {
      if (live.current.user) {
        try { await api.put('/store/cart', { branchId: Number(id) }); } catch (err) { toast(err.message, 'error'); }
      }
      setBranchLocal(Number(id));
      if (live.current.user) refreshCart();
    },
    refreshCart,
    /** Agrega (o fija) la cantidad de un producto en el carrito del servidor. */
    async addToCart(product, quantity = 1, { replace = false } = {}) {
      if (!requireLogin('Ingrese o cree su cuenta para comprar')) return false;
      try {
        let qty = quantity;
        if (!replace) {
          const cart = await api.get('/store/cart');
          const line = cart.data.items.find((i) => i.productId === product.id);
          if (line) qty += line.quantity;
        }
        await api.put(`/store/cart/items/${product.id}`, { quantity: qty });
        await refreshCart();
        toast(`${product.name} agregado al carrito`, 'success');
        return true;
      } catch (err) {
        toast(err.code === 'INSUFFICIENT_STOCK' && err.details?.available !== undefined ? `Stock insuficiente: puede comprar hasta ${err.details.available} unidades` : err.message, 'error');
        return false;
      }
    },
    async onLoggedIn() { await loadSession(); },
    async logout() {
      try { await api.logout(); } catch { /* la sesión ya no existe */ }
      live.current.user = null;
      live.current.staff = null;
      setUser(null); setStaff(null); setCartCount(0);
      disconnectSocket();
      closeAllModals();
      navigate('');
    },
  }), [navigate, user, staff, settings, branches, branchId, cartCount, requireLogin, refreshCart, loadSession, disconnectSocket]);

  let body;
  if (boot.state === 'loading') body = <Spinner label="Cargando Pharma Plus…" />;
  else if (boot.state === 'error') body = <main className="store-main"><ErrorState error={boot.error} onRetry={start} /></main>;
  else {
    body = (
      <>
        <a href="#main" className="sr-only">Saltar al contenido</a>
        <TopLine />
        <Header />
        <main className="store-main" id="main" tabIndex={-1}>
          <Routes key={branchId}>
            {ROUTES.map(([path, view, auth]) => <Route key={path} path={path} element={<RouteView view={view} auth={auth} />} />)}
            <Route path="*" element={<div className="state"><h2>Página no encontrada</h2><Link to="/" className="btn btn-primary">Volver al inicio</Link></div>} />
          </Routes>
        </main>
        <Footer />
      </>
    );
  }
  return (
    <StoreContext.Provider value={ctx}>
      {body}
      <ModalHost />
    </StoreContext.Provider>
  );
}

function matchPath(pattern, path) {
  const re = new RegExp(`^${pattern.replace(/:\w+/g, '[^/]+')}/?$`);
  return re.test(path);
}

function RouteView({ view, auth }) {
  const ctx = useStore();
  const params = useParams();
  const [query] = useSearchParams();
  const location = useLocation();
  const path = location.pathname.replace(/^\//, '');
  const redirect = auth && !ctx.user && !ctx.staff;
  const mustChange = ctx.user?.mustChangePassword && view !== 'Account';

  const navigateTo = useNavigate();
  useEffect(() => {
    // Ruta de cliente sin sesión → acceso único y regreso a esta ruta tras identificarse.
    if (redirect) navigateTo(accessUrl(`/${path}${location.search}`), { replace: true });
    else if (mustChange) ctx.navigate('cuenta');
  }, [redirect, mustChange, path, ctx, navigateTo, location.search]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    document.title = `${views.TITLES[view] ? `${views.TITLES[view]} · ` : ''}Pharma Plus`;
  }, [view, location.pathname]);

  if (auth && !ctx.user) {
    if (ctx.staff) {
      return (
        <div className="state">
          <h2>Sesión del personal activa</h2>
          <p>Para comprar, cierre la sesión del personal e ingrese con una cuenta de cliente.</p>
          <div className="row"><a href="/admin/" className="btn">Ir al panel</a><Button variant="primary" onClick={() => ctx.logout()}>Cerrar sesión</Button></div>
        </div>
      );
    }
    return <Spinner />;
  }
  if (mustChange) return <Spinner />;
  const View = views[view];
  return (
    <div className="stack" style={{ gap: '28px' }}>
      <ViewBoundary key={location.pathname}>
        <View params={params} query={Object.fromEntries(query)} />
      </ViewBoundary>
    </div>
  );
}

class ViewBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return <ErrorState error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

function TopLine() {
  const ctx = useStore();
  const s = ctx.settings;
  return (
    <div className="store-topline">
      {ctx.staff ? (
        <span>
          {`Sesión del personal activa (${ctx.staff.fullName}). La tienda requiere una cuenta de cliente. `}
          <a href="/admin/" style={{ color: '#fff', textDecoration: 'underline' }}>Ir al panel</a>{' · '}
          <button type="button" className="btn btn-sm btn-ghost" style={{ color: '#fff' }} onClick={() => ctx.logout()}>Cerrar sesión</button>
        </span>
      ) : `Recojo en tienda gratis${s.deliveryFee !== undefined && s.deliveryFee !== null ? ` · ${Number(s.deliveryFee) === 0 ? 'Delivery sin costo de envío' : `Delivery ${money(s.deliveryFee)}`}` : ''} · Pagos de demostración: no se realizan cobros reales`}
    </div>
  );
}

function Header() {
  const ctx = useStore();
  const [params] = useSearchParams();
  const location = useLocation();
  const q = location.pathname === '/catalogo' ? (params.get('q') || '') : '';
  return (
    <header className="store-header">
      <div className="inner">
        <Link to="/" className="logo" aria-label="Pharma Plus, inicio"><img src={LOGO} alt="Pharma Plus" /></Link>
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); const v = e.currentTarget.elements.q.value.trim(); ctx.navigate('catalogo', { q: v || undefined }); }}>
          <Icon name="search" />
          <input key={q} name="q" className="input" type="search" placeholder="Buscar medicamentos, marcas o principios activos…" aria-label="Buscar productos" defaultValue={q} />
        </form>
        <nav aria-label="Principal">
          {ctx.branches.length > 1 ? (
            <select className="input" aria-label="Sucursal" style={{ width: 'auto', maxWidth: '190px' }} value={String(ctx.branchId ?? '')} onChange={(e) => ctx.setBranch(e.target.value)}>
              {ctx.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : null}
          <Link to="/catalogo" className="btn btn-ghost"><Icon name="pill" /><span className="hide-sm">Catálogo</span></Link>
          {ctx.user ? <Link to="/pedidos" className="btn btn-ghost"><Icon name="receipt" /><span className="hide-sm">Mis pedidos</span></Link> : null}
          {ctx.user
            ? <Link to="/cuenta" className="btn btn-ghost" title={ctx.user.fullName}><Icon name="user" /><span className="hide-sm">{ctx.user.fullName.split(' ')[0]}</span></Link>
            : (ctx.staff ? null : <Link to={accessUrl(`${location.pathname}${location.search}`)} className="btn"><Icon name="user" />Ingresar</Link>)}
          <Link to="/carrito" className="btn btn-primary" aria-label={`Carrito, ${ctx.cartCount} unidades`}>
            <Icon name="cart" /><span className="hide-sm">Carrito</span>
            {ctx.cartCount ? <span className="badge neutral" style={{ marginLeft: '4px' }}>{String(ctx.cartCount)}</span> : null}
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  const ctx = useStore();
  const s = ctx.settings;
  return (
    <footer className="store-footer">
      <div className="inner">
        <div>
          <h4>{s.businessName || 'Pharma Plus'}</h4>
          <p>Tu salud, nuestra prioridad. Medicamentos y productos de cuidado personal con la atención de nuestros químicos farmacéuticos.</p>
          <p className="small" style={{ marginTop: '8px' }}>Los medicamentos con receta requieren presentar la receta médica al recoger o recibir el pedido.</p>
        </div>
        <div>
          <h4>Sucursales</h4>
          {ctx.branches.map((b) => <p key={b.id}>{b.name}{b.address ? <span className="small">{` — ${b.address}${b.district ? `, ${b.district}` : ''}`}</span> : null}</p>)}
        </div>
        <div>
          <h4>Mi cuenta</h4>
          <p><Link to="/pedidos">Mis pedidos</Link></p>
          <p><Link to="/cuenta">Datos y direcciones</Link></p>
          <p><Link to="/carrito">Carrito</Link></p>
          <p className="small" style={{ marginTop: '8px' }}>{`© ${new Date().getFullYear()} Pharma Plus`}</p>
        </div>
      </div>
    </footer>
  );
}
