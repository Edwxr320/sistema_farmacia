import React, { useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../core/api-client.js';
import { errorMessage } from '../core/format.js';
import { filterNav } from '../core/permissions.js';
import { destinationFor, safeNext, isAdminPath, internalPath } from '../core/redirect.js';
import { NAV } from '../admin/nav.js';
import { Icon } from '../components/icons.jsx';
import { Waves, WavesMobile, Shelves, Bottle, Leaves, UserAvatarIcon, ShieldCheckIcon } from './AccessArt.jsx';
import './access.css';

const THEME_KEY = 'pp.theme';

function initialTheme() {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* sin almacenamiento */ }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const accountTypeOf = (user) => (user?.role?.code === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF');

/**
 * Destino tras identificarse. Personal: la ruta del panel solicitada solo si sus permisos la permiten
 * (si no, el inicio del panel). Cliente: la ruta de la tienda solicitada o la tienda.
 */
function destination(accountType, next, { permissions = [], mustChangePassword = false } = {}) {
  if (accountType === 'CUSTOMER') return mustChangePassword ? '/cuenta' : destinationFor('CUSTOMER', next);
  const target = safeNext(next, 'STAFF');
  if (!target || mustChangePassword) return '/admin';
  const route = target.replace(/^\/admin\/?/, '').split(/[/?]/)[0];
  if (!route) return target;
  const item = NAV.flatMap((g) => g.items).find((i) => i.route === route);
  const allowed = item && filterNav([{ group: '', items: [item] }], new Set(permissions)).length > 0;
  return allowed ? target : '/admin';
}

/**
 * Acceso único (/acceso) para administradores, trabajadores y clientes.
 * El servidor reconoce el tipo de cuenta (POST /api/auth/access) y emite solo esa sesión.
 */
export default function AccessPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const next = params.get('next') || '';
  const uid = useId().replace(/:/g, '');
  const [theme, setTheme] = useState(initialTheme);
  const [current, setCurrent] = useState(undefined); // undefined = comprobando; null = sin sesión
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const notice = location.state?.message || null;

  useEffect(() => {
    document.title = 'Ingresar · Pharma Plus';
    document.body.classList.remove('store');
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* sin almacenamiento */ }
  }, [theme]);

  // Con una sesión abierta: si la ruta pedida corresponde a esa cuenta, se continúa sin volver a pedir datos.
  useEffect(() => {
    let alive = true;
    api.me().then((me) => {
      if (!alive) return;
      const type = accountTypeOf(me.user);
      // Solo una ruta interna válida de la otra clase de cuenta ofrece cambiar de cuenta; una ruta externa se ignora.
      const target = internalPath(next);
      const wantsOther = Boolean(target) && !safeNext(target, type) && (type === 'STAFF' ? !isAdminPath(target) : isAdminPath(target)) && !/^\/(acceso|ingresar|registro)(\/|$|\?)/.test(target);
      if (!wantsOther) navigate(destination(type, next, { permissions: me.permissions, mustChangePassword: me.user.mustChangePassword }), { replace: true });
      else setCurrent(me);
    }).catch(() => { if (alive) setCurrent(null); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) { setError('Ingrese su correo y su contraseña.'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.access(email.trim(), password);
      navigate(destination(r.accountType, next, { permissions: r.permissions, mustChangePassword: r.user.mustChangePassword }), { replace: true });
    } catch (err) {
      setError(err.code === 'AUTH_LOCKED' ? 'Cuenta bloqueada temporalmente por intentos fallidos. Intente más tarde.' : errorMessage(err));
      setBusy(false);
    }
  }

  const registerHref = `/registro${next && safeNext(next, 'CUSTOMER') ? `?next=${encodeURIComponent(safeNext(next, 'CUSTOMER'))}` : ''}`;
  const logo = theme === 'dark' ? '/img/pharma-plus-logo-oscuro.png' : '/img/pharma-plus-logo-claro.png';

  return (
    <div className="access" data-theme={theme}>
      {/* Decoración ilustrada (SVG propio, solo visual). */}
      <div className="access-art" aria-hidden="true">
        <Waves className="art-waves" />
        <WavesMobile className="art-waves-m" />
        <Shelves className="art-shelves" />
        <Bottle className="art-bottle" />
        <Leaves className="art-leaves-br" variant="br" />
        <Leaves className="art-leaves-tr" variant="tr" />
        <Leaves className="art-leaves-bl" variant="bl" />
      </div>

      <main className="access-wrap">
        <section className="access-hero">
          <Link to="/" className="access-brand" aria-label="Pharma Plus, ir a la tienda"><img className="access-logo" src={logo} alt="Pharma Plus — Tu salud, nuestra prioridad" /></Link>
          <div className="access-theme" role="group" aria-label="Tema de color">
            <button type="button" aria-pressed={String(theme === 'light')} aria-label="Tema claro" title="Tema claro" onClick={() => setTheme('light')}><Icon name="sun" /></button>
            <button type="button" aria-pressed={String(theme === 'dark')} aria-label="Tema oscuro" title="Tema oscuro" onClick={() => setTheme('dark')}><Icon name="moon" /></button>
          </div>
          <div className="access-welcome">
            <h1>Bienvenido</h1>
            <p className="access-lead">Inicia sesión en tu cuenta</p>
            <ul className="access-features">
              <li><span className="access-fi fi-green"><ShieldCheckIcon /></span><span>Compra segura<br />y confiable</span></li>
              <li><span className="access-fi fi-blue"><Icon name="truck" /></span><span>Recojo en tienda y delivery</span></li>
              <li><span className="access-fi fi-teal"><Icon name="headset" /></span><span>Atención personalizada</span></li>
            </ul>
          </div>
        </section>

        <section className="access-card" aria-labelledby={`${uid}-t`}>
          <div className="access-avatar" aria-hidden="true"><UserAvatarIcon /></div>
          <h2 id={`${uid}-t`}>Iniciar Sesión</h2>
          <p className="access-sub">Accede a tu cuenta para continuar</p>

          {notice ? <div className="access-alert warning" role="status">{notice}</div> : null}
          {current ? (
            <div className="access-alert info" role="status">
              {`Hay una sesión ${accountTypeOf(current.user) === 'STAFF' ? 'del personal' : 'de cliente'} abierta (${current.user.fullName}). Si ingresa con otra cuenta, esa sesión se cerrará. `}
              <button type="button" className="access-link" onClick={() => navigate(destination(accountTypeOf(current.user), '', { permissions: current.permissions }), { replace: true })}>
                {`Continuar como ${current.user.fullName.split(' ')[0]}`}
              </button>
            </div>
          ) : null}
          {error ? <div className="access-alert danger" role="alert">{error}</div> : null}

          <form className="access-form" noValidate onSubmit={submit}>
            <label className="access-field" htmlFor={`${uid}-e`}>
              <span className="sr-only">Correo electrónico</span>
              <Icon name="mail" />
              <input id={`${uid}-e`} name="email" type="email" autoComplete="username" placeholder="Correo electrónico" required
                value={email} onChange={(e) => setEmail(e.target.value)} disabled={current === undefined} />
            </label>
            <label className="access-field" htmlFor={`${uid}-p`}>
              <span className="sr-only">Contraseña</span>
              <Icon name="lock" />
              <input id={`${uid}-p`} name="password" type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="Contraseña" required
                value={password} onChange={(e) => setPassword(e.target.value)} disabled={current === undefined} />
              <button type="button" className="access-eye" aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={String(show)} onClick={() => setShow((v) => !v)}>
                <Icon name={show ? 'eye' : 'eyeOff'} />
              </button>
            </label>
            <button type="submit" className="access-submit" disabled={busy || current === undefined} aria-busy={busy ? 'true' : undefined}>
              {busy ? <span className="access-spin" aria-hidden="true" /> : <Icon name="login" />}{busy ? 'Ingresando…' : 'Ingresar'}
            </button>
          </form>

          <p className="access-foot">¿No tienes una cuenta? <Link to={registerHref}>Regístrate</Link></p>
        </section>
      </main>
    </div>
  );
}
