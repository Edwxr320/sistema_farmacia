import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { api } from '../core/api-client.js';
import { filterNav, firstRoute, hasAny } from '../core/permissions.js';
import { NAV } from './nav.js';
import { accessUrl } from '../core/redirect.js';
import { ROUTES } from './routes.js';
import { AdminContext } from './context.jsx';
import { Button, Icon, Spinner, ErrorState, AlertBox, toast } from '../components/ui.jsx';
import { Form } from '../components/form.jsx';
import { ModalHost, closeAllModals } from '../components/modal.jsx';

const LOGO = '/img/Logo-pharma-plus.jpeg';
const BRANCH_KEY = 'pp.branch';
const EVENTS = ['sale:created', 'sale:voided', 'inventory:changed', 'alerts:changed', 'cash:opened', 'cash:closed', 'cash:movement',
  'order:created', 'order:status', 'return:completed', 'transfer:dispatched', 'transfer:received'];

// Vistas con carga diferida (un archivo por módulo, como antes).
const modules = import.meta.glob('./views/*.jsx');
const viewCache = {};
function viewFor(route) {
  const [mod, name] = ROUTES[route];
  const key = `${mod}:${name}`;
  if (!viewCache[key]) viewCache[key] = lazy(() => modules[`./views/${mod}.jsx`]().then((m) => ({ default: m[name] })));
  return viewCache[key];
}

const sessionStore = {
  get(k) { try { return window.sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.sessionStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  del(k) { try { window.sessionStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
};

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

export default function AdminApp() {
  const navigateRaw = useNavigate();
  const navRef = useRef(navigateRaw);
  navRef.current = navigateRaw;
  const navigateTo = useCallback((...args) => navRef.current(...args), []);
  const location = useLocation();
  const [phase, setPhase] = useState({ name: 'boot' }); // boot | error | login | customer | password | ready
  const [session, setSession] = useState(null);
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(null);
  const [badges, setBadges] = useState({ orders: 0, alerts: 0 });
  const [conn, setConn] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const listeners = useRef(new Map());
  const socketRef = useRef(null);
  const live = useRef({ session: null, branchId: null, perms: new Set() });

  const perms = useMemo(() => new Set(session?.permissions || []), [session]);
  live.current = { session, branchId, perms };

  useEffect(() => { document.body.classList.remove('store'); }, []);

  // Enlaces antiguos (#/ruta?x=1) → /admin/ruta?x=1
  useEffect(() => {
    if (location.hash.startsWith('#/')) navigateTo(`/admin/${location.hash.slice(2)}`, { replace: true });
  }, [location.hash, navigateTo]);

  // ------------------------------------------------------------- badges
  const refreshBadges = useCallback(async () => {
    const { session: s, branchId: b, perms: p } = live.current;
    if (!s || !b) return;
    const next = {};
    const tasks = [];
    if (p.has('orders.view')) tasks.push(api.get('/orders', { branchId: b, status: 'PENDING', pageSize: 1 }).then((r) => { next.orders = r.pagination.total; }).catch(() => {}));
    if (p.has('alerts.view')) tasks.push(api.get('/inventory/alerts', { branchId: b, status: 'OPEN', pageSize: 1 }).then((r) => { next.alerts = r.pagination.total; }).catch(() => {}));
    await Promise.all(tasks);
    setBadges((old) => ({ ...old, ...next }));
  }, []);
  const badgeTimer = useRef(null);
  const refreshBadgesSoon = useCallback(() => {
    clearTimeout(badgeTimer.current);
    badgeTimer.current = setTimeout(refreshBadges, 600);
  }, [refreshBadges]);

  // ------------------------------------------------------------- socket
  const disconnectSocket = useCallback(() => {
    if (socketRef.current) { socketRef.current.close(); socketRef.current = null; }
    setConn(false);
  }, []);

  const connectSocket = useCallback(() => {
    disconnectSocket();
    const s = io({ path: '/socket.io', transports: ['websocket', 'polling'], withCredentials: true });
    socketRef.current = s;
    s.on('connect', () => setConn(true));
    s.on('disconnect', () => setConn(false));
    s.on('connect_error', () => setConn(false));
    for (const ev of EVENTS) {
      s.on(ev, (payload = {}) => {
        const b = live.current.branchId;
        if (!(payload.branchId && b && payload.branchId !== b && !ev.startsWith('order'))) {
          for (const fn of listeners.current.get(ev) || []) { try { fn(payload); } catch { /* vista */ } }
        }
        if (ev === 'order:created' && live.current.perms.has('orders.view')) {
          toast(`Nuevo pedido online ${payload.orderNumber ?? ''} — ${branchNameOf(payload.branchId)}`, 'info');
        }
        if (ev.startsWith('order') || ev === 'alerts:changed' || ev === 'inventory:changed') refreshBadgesSoon();
      });
    }
  }, [disconnectSocket, refreshBadgesSoon]);

  const branchesRef = useRef([]);
  branchesRef.current = branches;
  function branchNameOf(id) {
    return branchesRef.current.find((b) => b.id === Number(id))?.name ?? `Sucursal ${id}`;
  }

  useEffect(() => () => { disconnectSocket(); clearTimeout(badgeTimer.current); }, [disconnectSocket]);

  // ------------------------------------------------------------ sesión
  const startSession = useCallback(async (me) => {
    if (me.user.role.code === 'CUSTOMER') {
      // Una cuenta de cliente nunca entra al panel (el backend también lo impide por permisos).
      setPhase({ name: 'customer', user: me.user });
      return;
    }
    setSession(me);
    if (me.user.mustChangePassword) { setPhase({ name: 'password' }); return; }
    let list;
    try {
      const res = await api.get('/branches');
      list = res.data.filter((b) => b.status === 'ACTIVE');
    } catch { list = me.branches.map((b) => ({ id: b.id, name: b.name, code: b.code })); }
    const saved = Number(sessionStore.get(BRANCH_KEY));
    const bid = list.some((b) => b.id === saved) ? saved : (me.activeBranchId ?? list[0]?.id ?? null);
    setBranches(list);
    setBranchId(bid);
    live.current = { session: me, branchId: bid, perms: new Set(me.permissions) };
    setPhase({ name: 'ready' });
    connectSocket();
    refreshBadges();
  }, [connectSocket, refreshBadges]);

  const boot = useCallback(async () => {
    setPhase({ name: 'boot' });
    try {
      await startSession(await api.me());
    } catch (err) {
      if (err.status === 401) setPhase({ name: 'login' });
      else setPhase({ name: 'error', error: err });
    }
  }, [startSession]);

  useEffect(() => { boot(); }, [boot]);

  useEffect(() => api.onUnauthorized(() => {
    if (live.current.session) {
      live.current.session = null;
      setSession(null);
      disconnectSocket();
      closeAllModals();
      setPhase({ name: 'login', message: 'Su sesión expiró o fue cerrada. Inicie sesión nuevamente.' });
    }
  }), [disconnectSocket]);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* la sesión ya no existe */ }
    live.current.session = null;
    setSession(null);
    disconnectSocket();
    closeAllModals();
    sessionStore.del(BRANCH_KEY);
    navigateTo('/acceso', { replace: true });
  }, [disconnectSocket, navigateTo]);

  // ------------------------------------------------------------ contexto
  const ctx = useMemo(() => ({
    api,
    user: session?.user,
    perms,
    can: (...codes) => hasAny(perms, codes),
    canAll: (...codes) => codes.every((c) => perms.has(c)),
    branchId,
    branches,
    myBranches: session?.branches || [],
    branchName: (id) => branches.find((b) => b.id === Number(id))?.name ?? `Sucursal ${id}`,
    navigate: (route, query) => navigateTo(`/admin/${route}${query ? `?${new URLSearchParams(query)}` : ''}`),
    on(event, fn) {
      if (!listeners.current.has(event)) listeners.current.set(event, new Set());
      listeners.current.get(event).add(fn);
      return () => listeners.current.get(event)?.delete(fn);
    },
    refreshBadges,
    logout,
  }), [session, perms, branchId, branches, navigateTo, refreshBadges, logout]);

  // ------------------------------------------------------------ pantallas
  let content;
  if (phase.name === 'boot') content = <Spinner label="Cargando Pharma Plus…" />;
  else if (phase.name === 'error') content = <ErrorState error={phase.error} onRetry={boot} />;
  else if (phase.name === 'login') {
    // Sin sesión: acceso único, volviendo después a la ruta pedida.
    content = <Navigate to={accessUrl(`${location.pathname}${location.search}`)} replace state={phase.message ? { message: phase.message } : undefined} />;
  } else if (phase.name === 'customer') content = <CustomerBlocked user={phase.user} />;
  else if (phase.name === 'password') content = <ChangePassword onDone={startSession} onLogout={logout} />;
  else {
    content = (
      <Shell
        ctx={ctx} badges={badges} conn={conn} navOpen={navOpen} setNavOpen={setNavOpen}
        onBranch={(id) => { setBranchId(id); live.current.branchId = id; sessionStore.set(BRANCH_KEY, String(id)); refreshBadges(); }}
      />
    );
  }
  return (
    <AdminContext.Provider value={ctx}>
      {content}
      <ModalHost />
    </AdminContext.Provider>
  );
}

// ------------------------------------------------------------------ acceso
/** Una sesión de cliente abierta no puede usar el panel. */
function CustomerBlocked({ user }) {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => { document.title = 'Pharma Plus · Panel'; }, []);
  return (
    <main className="auth-form" style={{ minHeight: '100vh' }}>
      <div className="box">
        <img src={LOGO} alt="Pharma Plus" className="logo" />
        <h1>Panel solo para el personal</h1>
        <AlertBox tone="warning">{`Tiene abierta una sesión de cliente (${user.fullName}). El panel administrativo es solo para el personal de la botica.`}</AlertBox>
        <a href="/" className="btn btn-primary btn-lg btn-block">Ir a la tienda</a>
        <Button variant="ghost" onClick={async () => {
          try { await api.logout(); } catch { /* la sesión ya no existe */ }
          navigate(accessUrl(`${location.pathname}${location.search}`), { replace: true });
        }}>Cerrar sesión e ingresar como personal</Button>
      </div>
    </main>
  );
}

function ChangePassword({ onDone, onLogout }) {
  return (
    <main className="auth-form" style={{ minHeight: '100vh' }}>
      <div className="box">
        <img src={LOGO} alt="Pharma Plus" className="logo" />
        <h1>Cambie su contraseña</h1>
        <AlertBox tone="info">Por seguridad, debe definir una nueva contraseña antes de continuar.</AlertBox>
        <Form
          fields={[
            { name: 'currentPassword', label: 'Contraseña actual', type: 'password', required: true, full: true, autocomplete: 'current-password' },
            { name: 'newPassword', label: 'Nueva contraseña', type: 'password', required: true, full: true, autocomplete: 'new-password', hint: 'Mínimo 10 caracteres, con mayúscula, minúscula y número.' },
            { name: 'confirmPassword', label: 'Confirmar nueva contraseña', type: 'password', required: true, full: true, autocomplete: 'new-password' },
          ]}
          submitLabel="Cambiar contraseña"
          onSubmit={async (v) => {
            await api.changePassword(v.currentPassword, v.newPassword, v.confirmPassword);
            toast('Contraseña actualizada', 'success');
            await onDone(await api.me());
          }}
        />
        <Button variant="ghost" onClick={onLogout}>Cerrar sesión</Button>
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ layout
function Shell({ ctx, badges, conn, navOpen, setNavOpen, onBranch }) {
  const first = firstRoute(NAV, ctx.perms) || 'dashboard';
  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`.trim()}>
      <aside className="sidebar">
        <NavLink className="brand" to="/admin" end><img src={LOGO} alt="Pharma Plus — inicio" /></NavLink>
        <nav className="nav" aria-label="Menú principal">
          {filterNav(NAV, ctx.perms).map((g) => (
            <React.Fragment key={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.items.map((i) => {
                const count = i.badge ? badges[i.badge] : 0;
                return (
                  <NavLink key={i.route} to={`/admin/${i.route}`} onClick={() => setNavOpen(false)} className={() => undefined}>
                    <Icon name={i.icon} />{i.label}
                    {count ? <span className="count" aria-label={`${count} pendientes`}>{count > 99 ? '99+' : String(count)}</span> : null}
                  </NavLink>
                );
              })}
            </React.Fragment>
          ))}
        </nav>
      </aside>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />
      <div className="main">
        <Routes>
          <Route index element={<><Topbar ctx={ctx} conn={conn} title="" onMenu={() => setNavOpen(!navOpen)} onBranch={onBranch} /><Navigate to={`/admin/${first}`} replace /></>} />
          <Route path=":route" element={<RouteView ctx={ctx} conn={conn} onMenu={() => setNavOpen(!navOpen)} onBranch={onBranch} />} />
          <Route path="*" element={<RouteView ctx={ctx} conn={conn} onMenu={() => setNavOpen(!navOpen)} onBranch={onBranch} missing />} />
        </Routes>
      </div>
    </div>
  );
}

function Topbar({ ctx, conn, title, onMenu, onBranch }) {
  const u = ctx.user;
  return (
    <header className="topbar">
      <button type="button" className="btn btn-ghost icon-btn menu-btn" aria-label="Abrir menú" onClick={onMenu}><Icon name="menu" /></button>
      <span className="title">{title}</span>
      <span className="spacer" />
      <span className={`conn-dot ${conn ? 'on' : ''}`.trim()} title={conn ? 'Tiempo real conectado' : 'Tiempo real desconectado'} />
      {ctx.branches.length > 1 ? (
        <select className="input" style={{ width: 'auto', minWidth: '170px' }} aria-label="Sucursal activa" value={String(ctx.branchId ?? '')} onChange={(e) => onBranch(Number(e.target.value))}>
          {ctx.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      ) : <span className="pill hide-sm">{ctx.branches[0]?.name ?? 'Sin sucursal'}</span>}
      <div className="user">
        <span className="avatar" aria-hidden="true">{initials(u.fullName)}</span>
        <div className="hide-sm"><div className="strong small">{u.fullName}</div><div className="small muted">{u.role.name}</div></div>
        <Button variant="ghost" icon="logout" onClick={ctx.logout} title="Cerrar sesión" />
      </div>
    </header>
  );
}

function RouteView({ ctx, conn, onMenu, onBranch, missing }) {
  const { route } = useParams();
  const location = useLocation();
  const contentRef = useRef(null);
  const navItem = !missing && ROUTES[route] ? NAV.flatMap((g) => g.items).find((i) => i.route === route) : null;
  const allowed = navItem ? filterNav([{ group: '', items: [navItem] }], ctx.perms).length > 0 : false;

  useEffect(() => {
    if (navItem && allowed) document.title = `${navItem.label} · Pharma Plus`;
  }, [navItem, allowed]);

  // Foco al contenido (lectores de pantalla) solo si el usuario no está escribiendo ni hay un modal abierto.
  useEffect(() => {
    const t = setTimeout(() => {
      const active = document.activeElement;
      const typing = active && active !== document.body && (active.closest('.modal-backdrop') || /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName));
      if (!typing && !document.querySelector('.modal-backdrop') && contentRef.current) contentRef.current.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [location.pathname]);

  let body;
  if (!navItem) body = <ErrorState error={{ message: 'La página no existe.' }} />;
  else if (!allowed) {
    body = <div className="state"><Icon name="shield" /><h3>Sin acceso</h3><p>Su rol no tiene permiso para este módulo.</p></div>;
  } else {
    const View = viewFor(route);
    // La vista se vuelve a montar al cambiar de sucursal o de parámetros (igual que el enrutador anterior).
    body = (
      <ViewBoundary key={`${route}|${location.search}|${ctx.branchId}`}>
        <Suspense fallback={<Spinner />}><View /></Suspense>
      </ViewBoundary>
    );
  }
  return (
    <>
      <Topbar ctx={ctx} conn={conn} title={navItem && allowed ? navItem.label : ''} onMenu={onMenu} onBranch={onBranch} />
      <main className="content" id="content" tabIndex={-1} ref={contentRef}>{body}</main>
    </>
  );
}

/** Si una vista falla al cargar o al dibujarse, muestra el error con opción de reintentar. */
class ViewBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return <ErrorState error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
