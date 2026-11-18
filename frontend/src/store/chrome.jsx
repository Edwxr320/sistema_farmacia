import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/ui.jsx';
import { money } from '../core/format.js';
import { accessUrl } from '../core/redirect.js';
import { useStore } from './context.jsx';

export const STORE_LOGOS = { light: '/img/pharma-plus-logo-claro.png', dark: '/img/pharma-plus-logo-oscuro.png' };

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

const here = (location) => `${location.pathname}${location.search}`;

export function ThemeToggle({ className = '' }) {
  const ctx = useStore();
  return (
    <div className={`st-theme ${className}`.trim()} role="group" aria-label="Tema de color">
      <button type="button" aria-pressed={String(ctx.theme === 'light')} aria-label="Tema claro" title="Tema claro" onClick={() => ctx.setTheme('light')}><Icon name="sun" /></button>
      <button type="button" aria-pressed={String(ctx.theme === 'dark')} aria-label="Tema oscuro" title="Tema oscuro" onClick={() => ctx.setTheme('dark')}><Icon name="moon" /></button>
    </div>
  );
}

function BranchSelect({ className = '' }) {
  const ctx = useStore();
  if (ctx.branches.length < 2) return null;
  return (
    <label className={`st-branch ${className}`.trim()}>
      <Icon name="store" />
      <span className="sr-only">Sucursal</span>
      <select aria-label="Sucursal" value={String(ctx.branchId ?? '')} onChange={(e) => ctx.setBranch(e.target.value)}>
        {ctx.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </label>
  );
}

// ================================================================ barra superior
export function TopBar() {
  const ctx = useStore();
  const location = useLocation();
  const dd = useDropdown();
  return (
    <div className="st-topbar store-topline">
      <div className="st-inner">
        {ctx.staff ? (
          <span className="st-topmsg">
            {`Sesión del personal activa (${ctx.staff.fullName}). La tienda requiere una cuenta de cliente. `}
            <a href="/admin/">Ir al panel</a>{' · '}
            <button type="button" className="st-linkbtn" onClick={() => ctx.logout()}>Cerrar sesión</button>
          </span>
        ) : (
          <span className="st-topmsg"><Icon name="truck" />Recojo en tienda y delivery | Compra segura y confiable</span>
        )}
        <span className="st-spacer" />
        <BranchSelect className="st-branch-top" />
        <div className="st-dd" ref={dd.ref}>
          <button type="button" className="st-toplink" aria-expanded={String(dd.open)} onClick={() => dd.setOpen(!dd.open)}>
            Mi cuenta <Icon name="chevronDown" />
          </button>
          {dd.open ? (
            <div className="st-menu" role="menu">
              {ctx.user ? (
                <>
                  <div className="st-menu-title">{ctx.user.fullName}</div>
                  <Link role="menuitem" to="/cuenta" onClick={() => dd.setOpen(false)}><Icon name="user" />Datos y direcciones</Link>
                  <Link role="menuitem" to="/pedidos" onClick={() => dd.setOpen(false)}><Icon name="receipt" />Mis pedidos</Link>
                  <Link role="menuitem" to="/carrito" onClick={() => dd.setOpen(false)}><Icon name="cart" />Carrito</Link>
                  <button type="button" role="menuitem" onClick={() => { dd.setOpen(false); ctx.logout(); }}><Icon name="logout" />Cerrar sesión</button>
                </>
              ) : ctx.staff ? (
                <a role="menuitem" href="/admin/"><Icon name="dashboard" />Ir al panel</a>
              ) : (
                <>
                  <Link role="menuitem" to={accessUrl(here(location))} onClick={() => dd.setOpen(false)}><Icon name="user" />Iniciar sesión</Link>
                  <Link role="menuitem" to="/registro" onClick={() => dd.setOpen(false)}><Icon name="plus" />Crear cuenta</Link>
                </>
              )}
            </div>
          ) : null}
        </div>
        <span className="st-sep" aria-hidden="true">|</span>
        <Link className="st-toplink" to="/pedidos">Pedidos</Link>
        <span className="st-sep" aria-hidden="true">|</span>
        <a className="st-toplink" href="#ayuda">Ayuda</a>
        <ThemeToggle />
      </div>
    </div>
  );
}

// ================================================================== cabecera
function CartLink() {
  const ctx = useStore();
  return (
    <Link to="/carrito" className="st-cart" aria-label={`Carrito, ${ctx.cartCount} unidades`}>
      <Icon name="cart" />
      <span className="sr-only">Carrito</span>
      {ctx.cartCount ? <span className="badge st-count">{String(ctx.cartCount)}</span> : null}
    </Link>
  );
}

function SearchBox({ placeholder, className }) {
  const ctx = useStore();
  const [params] = useSearchParams();
  const location = useLocation();
  const q = location.pathname === '/catalogo' ? (params.get('q') || '') : '';
  return (
    <form className={className} role="search" onSubmit={(e) => { e.preventDefault(); const v = e.currentTarget.elements.q.value.trim(); ctx.navigate('catalogo', { q: v || undefined }); }}>
      <Icon name="search" />
      <input key={q} name="q" type="search" placeholder={placeholder} aria-label="Buscar productos" defaultValue={q} />
      <button type="submit" className="st-search-btn" aria-label="Buscar"><Icon name="search" /></button>
    </form>
  );
}

export function Header({ onMenu }) {
  const ctx = useStore();
  const location = useLocation();
  return (
    <header className="store-header st-header">
      <div className="st-inner st-header-row">
        <button type="button" className="st-burger" aria-label="Abrir menú" onClick={onMenu}><Icon name="menu" /></button>
        <Link to="/" className="st-logo" aria-label="Pharma Plus, inicio"><img src={STORE_LOGOS[ctx.theme]} alt="Pharma Plus — Tu salud, nuestra prioridad" /></Link>
        <SearchBox className="st-search" placeholder="Buscar medicamentos, marcas o principios activos..." />
        <div className="st-account">
          {ctx.user ? (
            <Link to="/cuenta" className="st-account-link" title={ctx.user.fullName}><Icon name="user" /><span>{`Hola, ${ctx.user.fullName.split(' ')[0]}`}</span></Link>
          ) : ctx.staff ? null : (
            <span className="st-account-link">
              <Icon name="user" />
              <span><Link to={accessUrl(here(location))}>Iniciar sesión</Link>{' / '}<Link to="/registro">Registrarse</Link></span>
            </span>
          )}
        </div>
        <CartLink />
      </div>
      <div className="st-inner st-msearch-row">
        <SearchBox className="st-search st-search-m" placeholder="Buscar productos..." />
      </div>
    </header>
  );
}

// ============================================================= navegación
function CategoriesMenu() {
  const ctx = useStore();
  const dd = useDropdown();
  return (
    <div className="st-dd" ref={dd.ref}>
      <button type="button" className="st-cat-btn" aria-expanded={String(dd.open)} aria-haspopup="menu" onClick={() => dd.setOpen(!dd.open)}>
        <Icon name="menu" />Categorías<Icon name="chevronDown" />
      </button>
      {dd.open ? (
        <div className="st-menu st-menu-cats" role="menu">
          <Link role="menuitem" to="/catalogo" onClick={() => dd.setOpen(false)}><Icon name="pill" />Todas las categorías</Link>
          {ctx.categories.map((c) => (
            <Link key={c.id} role="menuitem" to={`/catalogo?cat=${c.id}`} onClick={() => dd.setOpen(false)}>
              <Icon name="tag" /><span className="grow">{c.name}</span><span className="st-menu-count">{c.products}</span>
            </Link>
          ))}
          {!ctx.categories.length ? <div className="st-menu-empty">Aún no hay categorías con productos.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function NavRow() {
  const cls = ({ isActive }) => (isActive ? 'active' : undefined);
  return (
    <nav className="st-nav" aria-label="Principal">
      <div className="st-inner">
        <CategoriesMenu />
        <NavLink to="/" end className={cls}>Inicio</NavLink>
        <NavLink to="/catalogo" className={cls}>Productos</NavLink>
        <a href="#nosotros">Nosotros</a>
        <a href="#contacto">Contacto</a>
      </div>
    </nav>
  );
}

// ================================================================= móvil
export function Drawer({ onClose }) {
  const ctx = useStore();
  const location = useLocation();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const go = () => onClose();
  return (
    <div className="st-drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="st-drawer" role="dialog" aria-modal="true" aria-label="Menú">
        <div className="st-drawer-head">
          <img src={STORE_LOGOS[ctx.theme]} alt="Pharma Plus" />
          <button type="button" className="st-iconbtn" aria-label="Cerrar menú" onClick={onClose}><Icon name="x" /></button>
        </div>
        {ctx.user ? (
          <div className="st-drawer-user"><Icon name="user" /><div><strong>{ctx.user.fullName}</strong><Link to="/cuenta" onClick={go}>Mi cuenta</Link></div></div>
        ) : ctx.staff ? (
          <div className="st-drawer-user"><Icon name="user" /><div><strong>{`Personal: ${ctx.staff.fullName}`}</strong><a href="/admin/">Ir al panel</a></div></div>
        ) : (
          <div className="st-drawer-user"><Icon name="user" /><div><Link to={accessUrl(here(location))} onClick={go}>Iniciar sesión</Link>{' / '}<Link to="/registro" onClick={go}>Registrarse</Link></div></div>
        )}
        <nav className="st-drawer-nav" aria-label="Menú de la tienda">
          <Link to="/" onClick={go}><Icon name="home" />Inicio</Link>
          <Link to="/catalogo" onClick={go}><Icon name="pill" />Productos</Link>
          <Link to="/pedidos" onClick={go}><Icon name="receipt" />Mis pedidos</Link>
          <Link to="/carrito" onClick={go}><Icon name="cart" />Carrito</Link>
          <a href="#nosotros" onClick={go}><Icon name="info" />Nosotros</a>
          <a href="#contacto" onClick={go}><Icon name="pin" />Contacto</a>
          <a href="#ayuda" onClick={go}><Icon name="headset" />Ayuda</a>
        </nav>
        <h3>Categorías</h3>
        <nav className="st-drawer-nav" aria-label="Categorías">
          {ctx.categories.map((c) => <Link key={c.id} to={`/catalogo?cat=${c.id}`} onClick={go}><Icon name="tag" />{c.name}</Link>)}
        </nav>
        {ctx.branches.length > 1 ? (<><h3>Sucursal</h3><BranchSelect className="st-branch-block" /></>) : null}
        <h3>Tema</h3>
        <ThemeToggle className="st-theme-block" />
        {ctx.user || ctx.staff ? <button type="button" className="btn btn-block st-drawer-logout" onClick={() => { onClose(); ctx.logout(); }}><Icon name="logout" />Cerrar sesión</button> : null}
      </aside>
    </div>
  );
}

/** Hoja de categorías (botón "Categorías" de la barra inferior). */
export function CategoriesSheet({ onClose }) {
  const ctx = useStore();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="st-sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="st-sheet" role="dialog" aria-modal="true" aria-label="Categorías">
        <div className="st-sheet-grip" />
        <div className="st-sheet-head"><h2>Categorías</h2><button type="button" className="st-iconbtn" aria-label="Cerrar" onClick={onClose}><Icon name="x" /></button></div>
        <div className="st-sheet-list">
          <Link to="/catalogo" onClick={onClose}><Icon name="pill" /><span className="grow">Todas las categorías</span><Icon name="arrowRight" /></Link>
          {ctx.categories.map((c) => (
            <Link key={c.id} to={`/catalogo?cat=${c.id}`} onClick={onClose}><Icon name="tag" /><span className="grow">{c.name}</span><span className="st-menu-count">{c.products}</span></Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BottomNav({ onCategories, catsOpen }) {
  const ctx = useStore();
  const location = useLocation();
  const p = location.pathname;
  const cur = (cond) => (cond && !catsOpen ? 'page' : undefined);
  return (
    <nav className="st-bottom" aria-label="Navegación inferior">
      <Link to="/" aria-current={cur(p === '/')}><Icon name="home" />Inicio</Link>
      <button type="button" onClick={onCategories} aria-current={catsOpen || p === '/catalogo' ? 'page' : undefined} aria-haspopup="dialog"><Icon name="menu" />Categorías</button>
      <Link to="/pedidos" aria-current={cur(p.startsWith('/pedidos'))}><Icon name="receipt" />Pedidos</Link>
      <Link to={ctx.user ? '/cuenta' : accessUrl('/cuenta')} aria-current={cur(p === '/cuenta')}><Icon name="user" />Cuenta</Link>
    </nav>
  );
}

// =================================================================== pie
export function Footer() {
  const ctx = useStore();
  const s = ctx.settings;
  const branch = ctx.branch();
  const districts = Array.isArray(s.deliveryDistricts) ? s.deliveryDistricts : null;
  return (
    <footer className="store-footer st-footer">
      <div className="st-inner st-footer-grid">
        <section id="nosotros" aria-labelledby="ft-nos">
          <img className="st-footer-logo" src={STORE_LOGOS.dark} alt="Pharma Plus" />
          <h4 id="ft-nos">Nosotros</h4>
          <p>{`${s.businessName || 'Pharma Plus'}: tu salud, nuestra prioridad. Medicamentos y productos de cuidado personal con la atención de nuestros químicos farmacéuticos.`}</p>
        </section>
        <section id="contacto" aria-labelledby="ft-con">
          <h4 id="ft-con">Contacto y sucursales</h4>
          {ctx.branches.map((b) => (
            <p key={b.id}>
              <strong>{b.name}</strong>
              {b.address ? <span className="st-ft-line">{`${b.address}${b.district ? `, ${b.district}` : ''}`}</span> : null}
              {b.phone ? <span className="st-ft-line">{`Tel. ${b.phone}`}</span> : null}
            </p>
          ))}
        </section>
        <section id="ayuda" aria-labelledby="ft-ayu">
          <h4 id="ft-ayu">Ayuda</h4>
          <p>{`Recojo en tienda sin costo${branch ? ` en ${branch.name}` : ''}.`}</p>
          <p>
            {s.deliveryFee === undefined || s.deliveryFee === null ? 'Consulte la disponibilidad de delivery en su zona.'
              : `Delivery: ${Number(s.deliveryFee) === 0 ? 'sin costo de envío' : money(s.deliveryFee)}${districts ? (districts.length ? ` · cobertura: ${districts.join(', ')}` : ' · por ahora sin distritos con cobertura') : ''}.`}
          </p>
          <p>Los medicamentos con receta requieren indicar el número de receta y presentarla al recoger o recibir el pedido.</p>
          <p>Pagos de demostración: no se realizan cobros reales ni se guardan datos de tarjetas.</p>
          <p className="st-ft-links"><Link to="/pedidos">Mis pedidos</Link> · <Link to="/cuenta">Mi cuenta</Link> · <Link to="/carrito">Carrito</Link></p>
        </section>
      </div>
      <div className="st-footer-bottom"><div className="st-inner">{`© ${new Date().getFullYear()} Pharma Plus · Tu salud, nuestra prioridad`}</div></div>
    </footer>
  );
}
