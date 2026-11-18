import React from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/icons.jsx';
import { Waves, WavesMobile, Shelves, Bottle, Leaves, ShieldCheckIcon } from './AccessArt.jsx';
import './access.css';

const LOGOS = { light: '/img/pharma-plus-logo-claro.png', dark: '/img/pharma-plus-logo-oscuro.png' };

/**
 * Presentación compartida de /acceso y /registro: fondo, ilustración, logotipo, selector de tema,
 * mensaje de bienvenida y distribución PC/móvil. Cada pantalla solo aporta el contenido de la tarjeta.
 * `variant` permite a cada formulario ajustar su tarjeta sin tocar el resto (p. ej. "register").
 */
export default function AccessLayout({ theme, setTheme, variant = 'login', labelledBy, children }) {
  return (
    <div className={`access access-${variant}`} data-theme={theme}>
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
          <Link to="/" className="access-brand" aria-label="Pharma Plus, ir a la tienda"><img className="access-logo" src={LOGOS[theme]} alt="Pharma Plus — Tu salud, nuestra prioridad" /></Link>
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

        <section className="access-card" aria-labelledby={labelledBy}>
          {children}
        </section>
      </main>
    </div>
  );
}
