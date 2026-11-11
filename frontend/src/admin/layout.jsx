import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, Navigate, NavLink, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { filterNav, firstRoute } from '../core/permissions.js';
import { NAV } from './nav.js';
import { ROUTES } from './routes.js';
import { Icon, Spinner, ErrorState } from '../components/ui.jsx';

export const LOGOS = { light: '/img/pharma-plus-logo-claro.png', dark: '/img/pharma-plus-logo-oscuro.png' };
const COLLAPSE_KEY = 'pp.admin.sidebar';

// Vistas con carga diferida (un archivo por módulo).
const modules = import.meta.glob('./views/*.jsx');
const viewCache = {};
function viewFor(route) {
  const [mod, name] = ROUTES[route];
  const key = `${mod}:${name}`;
  if (!viewCache[key]) viewCache[key] = lazy(() => modules[`./views/${mod}.jsx`]().then((m) => ({ default: m[name] })));
  return viewCache[key];
}

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const allowedItems = (perms) => filterNav(NAV, perms).flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));
const currentRoute = (pathname) => pathname.replace(/^\/admin\/?/, '').split('/')[0];

/** Cierra un desplegable al hacer clic fuera o pulsar Escape. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return { open, setOpen, ref };
}

// ===================================================================== shell
export function Shell({ ctx, badges, conn, navOpen, setNavOpen, onBranch, theme, setTheme }) {
  const first = firstRoute(NAV, ctx.perms) || 'dashboard';
  const [collapsed, setCollapsed] = useState(() => { try { return window.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } });
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  useEffect(() => { setNavOpen(false); setMoreOpen(false); }, [location.pathname, setNavOpen]);

  const toggleMenu = () => {
    if (window.matchMedia('(min-width: 1101px)').matches) {
      setCollapsed((c) => { const n = !c; try { window.localStorage.setItem(COLLAPSE_KEY, n ? '1' : '0'); } catch { /* sin almacenamiento */ } return n; });
    } else setNavOpen(!navOpen);
  };
  const common = { ctx, badges, conn, theme, setTheme, onBranch };

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''} ${collapsed ? 'side-collapsed' : ''}`.trim()}>
      <Sidebar ctx={ctx} badges={badges} theme={theme} onNavigate={() => setNavOpen(false)} />
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />
      <div className="main">
        <Topbar {...common} onMenu={toggleMenu} />
        <MobileHeader {...common} onMenu={() => setNavOpen(!navOpen)} />
        <Routes>
          <Route index element={<Navigate to={`/admin/${first}`} replace />} />
          <Route path=":route" element={<RouteView ctx={ctx} />} />
          <Route path="*" element={<RouteView ctx={ctx} missing />} />
        </Routes>
      </div>
      <BottomNav ctx={ctx} badges={badges} onMore={() => setMoreOpen(true)} moreOpen={moreOpen} />
      {moreOpen ? <MoreSheet {...common} onClose={() => setMoreOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- sidebar
function Sidebar({ ctx, badges, theme, onNavigate }) {
  const u = ctx.user;
  return (
    <aside className="sidebar">
      <NavLink className="brand" to="/admin" end aria-label="Pharma Plus — inicio del panel">
        <img src={LOGOS[theme]} alt="Pharma Plus — Tu salud, nuestra prioridad" />
      </NavLink>
      <nav className="nav" aria-label="Menú principal">
        {filterNav(NAV, ctx.perms).map((g) => (
          <React.Fragment key={g.group}>
            <div className="nav-group">{g.group}</div>
            {g.items.map((i) => {
              const count = i.badge ? badges[i.badge] : 0;
              return (
                <NavLink key={i.route} to={`/admin/${i.route}`} onClick={onNavigate} className={() => undefined}>
                  <Icon name={i.icon} />{i.label}
                  {count ? <span className="count" aria-label={`${count} pendientes`}>{count > 99 ? '99+' : String(count)}</span> : null}
                </NavLink>
              );
            })}
          </React.Fragment>
        ))}
      </nav>
      <div className="side-foot">
        <div className="side-user">
          <span className="avatar" aria-hidden="true">{initials(u.fullName)}</span>
          <div className="who"><div className="name" title={u.fullName}>{u.fullName}</div><div className="role">{u.role.name}</div></div>
        </div>
        <button type="button" className="side-logout" title="Cerrar sesión" onClick={ctx.logout}><Icon name="logout" />Cerrar sesión</button>
      </div>
    </aside>
  );
}

// ----------------------------------------------------------------- topbar
function Topbar({ ctx, badges, conn, theme, setTheme, onBranch, onMenu }) {
  return (
    <header className="topbar">
      <button type="button" className="btn btn-ghost icon-btn menu-btn" aria-label="Mostrar u ocultar el menú" onClick={onMenu}><Icon name="menu" /></button>
      <GlobalSearch ctx={ctx} />
      <span className="spacer" />
      <BranchSelect ctx={ctx} onBranch={onBranch} />
      <Notifications ctx={ctx} badges={badges} />
      <ThemeToggle theme={theme} setTheme={setTheme} />
      <UserMenu ctx={ctx} conn={conn} />
    </header>
  );
}

function BranchSelect({ ctx, onBranch }) {
  if (ctx.branches.length > 1) {
    return (
      <label className="tb-pill branch-pill">
        <span className="sr-only">Sucursal activa</span>
        <select aria-label="Sucursal activa" value={String(ctx.branchId ?? '')} onChange={(e) => onBranch(Number(e.target.value))}>
          {ctx.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <Icon name="chevronDown" />
      </label>
    );
  }
  return <span className="tb-pill branch-pill static" title="Sucursal activa">{ctx.branches[0]?.name ?? 'Sin sucursal'}</span>;
}

/** Buscador del sistema: encuentra los módulos a los que el usuario tiene acceso. */
function GlobalSearch({ ctx }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const dd = useDropdown();
  const items = useMemo(() => allowedItems(ctx.perms), [ctx.perms]);
  const results = q.trim() ? items.filter((i) => norm(`${i.label} ${i.group}`).includes(norm(q.trim()))).slice(0, 8) : [];
  const go = (i) => { navigate(`/admin/${i.route}`); setQ(''); dd.setOpen(false); };
  return (
    <div className="gsearch dd" ref={dd.ref}>
      <Icon name="search" />
      <input
        type="search" placeholder="Buscar en el sistema..." aria-label="Buscar en el sistema" role="combobox" aria-expanded={String(dd.open && Boolean(q.trim()))}
        value={q}
        onChange={(e) => { setQ(e.target.value); setActive(0); dd.setOpen(true); }}
        onFocus={() => dd.setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter' && results[active]) { e.preventDefault(); go(results[active]); }
        }}
      />
      {dd.open && q.trim() ? (
        <div className="dd-menu left" role="listbox" style={{ width: '100%' }}>
          {results.length ? results.map((i, k) => (
            <button key={i.route} type="button" role="option" aria-selected={k === active} data-active={String(k === active)} className="dd-item" onMouseDown={(e) => e.preventDefault()} onClick={() => go(i)}>
              <Icon name={i.icon} /><span className="grow">{i.label}</span><span className="small muted">{i.group}</span>
            </button>
          )) : <div className="dd-empty">Sin módulos que coincidan con «{q.trim()}».</div>}
        </div>
      ) : null}
    </div>
  );
}

/** Notificaciones reales: pedidos online pendientes y alertas de inventario abiertas de la sucursal. */
function Notifications({ ctx, badges, className = 'tb-pill icon-pill' }) {
  const dd = useDropdown();
  const navigate = useNavigate();
  const items = [];
  if (ctx.can('orders.view')) items.push({ key: 'orders', icon: 'cart', label: 'Pedidos online pendientes', count: badges.orders || 0, route: 'orders' });
  if (ctx.can('alerts.view')) items.push({ key: 'alerts', icon: 'bell', label: 'Alertas de inventario abiertas', count: badges.alerts || 0, route: 'alerts' });
  const total = items.reduce((a, i) => a + i.count, 0);
  return (
    <div className="dd" ref={dd.ref}>
      <button type="button" className={className} aria-label={`Notificaciones: ${total} pendientes`} aria-expanded={String(dd.open)} onClick={() => dd.setOpen(!dd.open)}>
        <Icon name="bell" />
        {total ? <span className="dot-badge">{total > 99 ? '99+' : total}</span> : null}
      </button>
      {dd.open ? (
        <div className="dd-menu" role="menu">
          <div className="dd-title">Notificaciones · {ctx.branchName(ctx.branchId)}</div>
          {items.filter((i) => i.count > 0).map((i) => (
            <button key={i.key} type="button" role="menuitem" className="dd-item" onClick={() => { dd.setOpen(false); navigate(`/admin/${i.route}`); }}>
              <Icon name={i.icon} /><span className="grow">{i.label}</span><span className="count">{i.count}</span>
            </button>
          ))}
          {!total ? <div className="dd-empty">No hay notificaciones pendientes.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ThemeToggle({ theme, setTheme }) {
  return (
    <div className="theme-toggle" role="group" aria-label="Tema de color">
      <button type="button" aria-pressed={String(theme === 'light')} aria-label="Tema claro" title="Tema claro" onClick={() => setTheme('light')}><Icon name="sun" /></button>
      <button type="button" aria-pressed={String(theme === 'dark')} aria-label="Tema oscuro" title="Tema oscuro" onClick={() => setTheme('dark')}><Icon name="moon" /></button>
    </div>
  );
}

function UserMenu({ ctx, conn }) {
  const dd = useDropdown();
  const u = ctx.user;
  return (
    <div className="dd" ref={dd.ref}>
      <button type="button" className="tb-pill user-pill" aria-label={`Cuenta de ${u.fullName}`} aria-expanded={String(dd.open)} onClick={() => dd.setOpen(!dd.open)}>
        <span className="avatar sm" aria-hidden="true">{initials(u.fullName)}</span>
        <span className="uname">{u.fullName}</span>
        <Icon name="chevronDown" />
      </button>
      {dd.open ? (
        <div className="dd-menu" role="menu">
          <div className="dd-item" style={{ cursor: 'default' }}>
            <span className="avatar" aria-hidden="true">{initials(u.fullName)}</span>
            <span className="grow"><span className="strong" style={{ display: 'block' }}>{u.fullName}</span><span className="small muted">{u.email}</span></span>
          </div>
          <div className="dd-sep" />
          <div className="dd-item" style={{ cursor: 'default' }}><Icon name="shield" /><span className="grow">{u.role.name}</span></div>
          <div className="dd-item" style={{ cursor: 'default' }}><Icon name="store" /><span className="grow">{ctx.branchName(ctx.branchId)}</span></div>
          <div className="dd-item" style={{ cursor: 'default' }}>
            <span className={`conn-dot ${conn ? 'on' : ''}`.trim()} style={{ margin: '0 5px' }} />
            <span className="grow">{conn ? 'Tiempo real conectado' : 'Tiempo real desconectado'}</span>
          </div>
          <div className="dd-sep" />
          <button type="button" role="menuitem" className="dd-item" title="Cerrar sesión" onClick={ctx.logout}><Icon name="logout" />Cerrar sesión</button>
        </div>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------- móvil
function MobileHeader({ ctx, badges, theme, onMenu }) {
  return (
    <header className="m-header">
      <button type="button" className="m-btn" aria-label="Abrir menú" onClick={onMenu}><Icon name="menu" /></button>
      <Link to="/admin" className="m-logo" aria-label="Pharma Plus — inicio del panel"><img src={LOGOS[theme]} alt="Pharma Plus" /></Link>
      <Notifications ctx={ctx} badges={badges} className="m-btn" />
    </header>
  );
}

/** Navegación inferior: Inicio, Ventas, Inventario, Reportes y Más (solo lo autorizado). */
function BottomNav({ ctx, badges, onMore, moreOpen }) {
  const location = useLocation();
  const route = currentRoute(location.pathname);
  const allowed = new Set(allowedItems(ctx.perms).map((i) => i.route));
  const pick = (...routes) => routes.find((r) => allowed.has(r));
  const home = pick('dashboard') || firstRoute(NAV, ctx.perms);
  const tabs = [
    home ? { route: home, label: 'Inicio', icon: 'home' } : null,
    pick('sales', 'pos') ? { route: pick('sales', 'pos'), label: 'Ventas', icon: 'cart', also: ['pos', 'sales', 'cash', 'returns'] } : null,
    pick('stock', 'batches', 'kardex') ? { route: pick('stock', 'batches', 'kardex'), label: 'Inventario', icon: 'box', also: ['stock', 'batches', 'kardex', 'alerts', 'entries', 'adjustments', 'transfers'] } : null,
    pick('reports') ? { route: 'reports', label: 'Reportes', icon: 'chart' } : null,
  ].filter(Boolean);
  const inTabs = tabs.some((t) => t.route === route || (t.also || []).includes(route));
  return (
    <nav className="bottom-nav" aria-label="Navegación inferior">
      {tabs.map((t) => (
        <Link key={t.label} to={`/admin/${t.route}`} aria-current={!moreOpen && (t.route === route || (t.also || []).includes(route)) ? 'page' : undefined}>
          <Icon name={t.icon} />{t.label}
        </Link>
      ))}
      <button type="button" onClick={onMore} aria-current={moreOpen || !inTabs ? 'page' : undefined} aria-haspopup="dialog">
        <Icon name="dots" className="ico ico-dots" />Más
        {(badges.orders || 0) + (badges.alerts || 0) ? <span className="count">{(badges.orders || 0) + (badges.alerts || 0)}</span> : null}
      </button>
    </nav>
  );
}

/** Hoja "Más" (móvil): todos los módulos autorizados, sucursal, tema y sesión. */
function MoreSheet({ ctx, badges, theme, setTheme, onBranch, onClose }) {
  const location = useLocation();
  const route = currentRoute(location.pathname);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Más opciones">
        <div className="sheet-grip" />
        <div className="row between">
          <div className="side-user" style={{ padding: 0 }}>
            <span className="avatar" aria-hidden="true">{initials(ctx.user.fullName)}</span>
            <div className="who"><div className="name">{ctx.user.fullName}</div><div className="role">{ctx.user.role.name}</div></div>
          </div>
          <button type="button" className="btn btn-ghost icon-btn" aria-label="Cerrar" onClick={onClose}><Icon name="x" /></button>
        </div>
        <h3>Modo de tema</h3>
        <div className="theme-cards">
          <button type="button" aria-pressed={String(theme === 'light')} onClick={() => setTheme('light')}><Icon name="sun" />Claro</button>
          <button type="button" aria-pressed={String(theme === 'dark')} onClick={() => setTheme('dark')}><Icon name="moon" />Oscuro</button>
        </div>
        {ctx.branches.length > 1 ? (
          <>
            <h3>Sucursal</h3>
            <select className="input" aria-label="Sucursal activa" value={String(ctx.branchId ?? '')} onChange={(e) => onBranch(Number(e.target.value))}>
              {ctx.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </>
        ) : null}
        {filterNav(NAV, ctx.perms).map((g) => (
          <React.Fragment key={g.group}>
            <h3>{g.group}</h3>
            <div className="sheet-grid">
              {g.items.map((i) => {
                const count = i.badge ? badges[i.badge] : 0;
                return (
                  <Link key={i.route} to={`/admin/${i.route}`} aria-current={i.route === route ? 'page' : undefined} onClick={onClose}>
                    <Icon name={i.icon} />{i.label}
                    {count ? <span className="count">{count > 99 ? '99+' : count}</span> : null}
                  </Link>
                );
              })}
            </div>
          </React.Fragment>
        ))}
        <h3>Sesión</h3>
        <button type="button" className="btn btn-block" title="Cerrar sesión" onClick={ctx.logout}><Icon name="logout" />Cerrar sesión</button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- contenido
function RouteView({ ctx, missing }) {
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
    // La vista se vuelve a montar al cambiar de sucursal o de parámetros.
    body = (
      <ViewBoundary key={`${route}|${location.search}|${ctx.branchId}`}>
        <Suspense fallback={<Spinner />}><View /></Suspense>
      </ViewBoundary>
    );
  }
  return <main className="content" id="content" tabIndex={-1} ref={contentRef}>{body}</main>;
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
