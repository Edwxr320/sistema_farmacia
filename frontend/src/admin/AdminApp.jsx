import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import { api } from '../core/api-client.js';
import { hasAny } from '../core/permissions.js';
import { accessUrl } from '../core/redirect.js';
import { AdminContext } from './context.jsx';
import { Button, Spinner, ErrorState, AlertBox, toast } from '../components/ui.jsx';
import { Shell, LOGOS } from './layout.jsx';
import './admin.css';
import { Form } from '../components/form.jsx';
import { ModalHost, closeAllModals } from '../components/modal.jsx';

const THEME_KEY = 'pharma_plus_admin_theme';
const BRANCH_KEY = 'pp.branch';
const EVENTS = ['sale:created', 'sale:voided', 'inventory:changed', 'alerts:changed', 'cash:opened', 'cash:closed', 'cash:movement',
  'order:created', 'order:status', 'return:completed', 'transfer:dispatched', 'transfer:received'];

const sessionStore = {
  get(k) { try { return window.sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.sessionStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  del(k) { try { window.sessionStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
};

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
  const [theme, setThemeState] = useState(() => {
    try { const t = window.localStorage.getItem(THEME_KEY); if (t === 'light' || t === 'dark') return t; } catch { /* sin almacenamiento */ }
    return 'light';
  });
  const setTheme = useCallback((t) => {
    setThemeState(t);
    try { window.localStorage.setItem(THEME_KEY, t); } catch { /* sin almacenamiento */ }
  }, []);
  // El fondo de la página acompaña al tema solo mientras el panel está abierto (la tienda no se ve afectada).
  useEffect(() => {
    document.documentElement.setAttribute('data-admin-theme', theme);
    return () => document.documentElement.removeAttribute('data-admin-theme');
  }, [theme]);
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
  } else if (phase.name === 'customer') content = <CustomerBlocked user={phase.user} theme={theme} />;
  else if (phase.name === 'password') content = <ChangePassword onDone={startSession} onLogout={logout} theme={theme} />;
  else {
    content = (
      <Shell
        ctx={ctx} badges={badges} conn={conn} navOpen={navOpen} setNavOpen={setNavOpen} theme={theme} setTheme={setTheme}
        onBranch={(id) => { setBranchId(id); live.current.branchId = id; sessionStore.set(BRANCH_KEY, String(id)); refreshBadges(); }}
      />
    );
  }
  return (
    <AdminContext.Provider value={ctx}>
      <div className="pp-admin" data-theme={theme}>
        {content}
        <ModalHost />
      </div>
    </AdminContext.Provider>
  );
}

// ------------------------------------------------------------------ acceso
/** Una sesión de cliente abierta no puede usar el panel. */
function CustomerBlocked({ user, theme }) {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => { document.title = 'Pharma Plus · Panel'; }, []);
  return (
    <main className="auth-form" style={{ minHeight: '100vh' }}>
      <div className="box">
        <img src={LOGOS[theme]} alt="Pharma Plus" className="logo" />
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

function ChangePassword({ onDone, onLogout, theme }) {
  return (
    <main className="auth-form" style={{ minHeight: '100vh' }}>
      <div className="box">
        <img src={LOGOS[theme]} alt="Pharma Plus" className="logo" />
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
