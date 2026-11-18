import React, { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../core/api-client.js';
import { errorMessage } from '../core/format.js';
import { accessUrl, destinationFor } from '../core/redirect.js';
import { Icon } from '../components/icons.jsx';
import { toast } from '../components/toast.jsx';
import AccessLayout from './AccessLayout.jsx';
import { useAccessTheme } from './theme.js';

// Requisitos reales del servidor (src/validators/auth.validator.js · store.validator.js); el servidor decide.
const PASSWORD_HINT = 'Mínimo 10 caracteres, con mayúscula, minúscula y número; sin espacios y sin incluir tu correo.';
// Mismos tipos de documento que ofrecía el registro (el backend admite además RUC/OTHER, que el registro público no muestra).
const DOC_TYPES = [['DNI', 'DNI'], ['CE', 'Carné de extranjería'], ['PASSPORT', 'Pasaporte']];
const REQUIRED = ['fullName', 'email', 'password', 'confirm'];

/**
 * Registro de clientes (/registro). Misma lógica que el registro anterior:
 * POST /api/store/auth/register (el servidor asigna el rol de cliente) → acceso único con esas credenciales
 * → tienda o ruta pedida. La presentación es la del acceso (AccessLayout): solo cambia la tarjeta.
 */
export default function RegisterPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '';
  const uid = useId().replace(/:/g, '');
  const [theme, setTheme] = useAccessTheme();
  const [values, setValues] = useState({ fullName: '', email: '', phone: '', documentType: '', documentNumber: '', password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState({ password: false, confirm: false });
  const refs = useRef({});
  const done = useRef(false);

  useEffect(() => {
    document.title = 'Crear cuenta · Pharma Plus';
    document.body.classList.remove('store');
  }, []);

  // Un cliente con sesión abierta no necesita registrarse: va a la tienda o a la ruta pedida (como antes).
  useEffect(() => {
    let alive = true;
    api.me().then((me) => {
      if (alive && me.user?.role?.code === 'CUSTOMER' && !done.current) { done.current = true; navigate(destinationFor('CUSTOMER', next), { replace: true }); }
    }).catch(() => { /* sin sesión */ });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (name) => (e) => setValues((v) => ({ ...v, [name]: e.target.value }));
  const pickDoc = (code) => setValues((v) => ({ ...v, documentType: v.documentType === code ? '' : code }));

  function showError(err) {
    const next2 = {};
    let placed = false;
    if (Array.isArray(err?.details)) {
      for (const d of err.details) {
        const key = d.field && d.field.split('.')[0];
        if (key && key in values) { next2[key] = d.message; placed = true; }
      }
    }
    setErrors(next2);
    setGeneral(placed ? null : errorMessage(err));
    const first = Object.keys(next2)[0];
    if (first) refs.current[first]?.focus();
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    // Igual que antes: obligatorios marcados en el navegador; todo lo demás lo valida el servidor.
    const missing = {};
    for (const k of REQUIRED) if (!String(values[k]).trim()) missing[k] = 'Campo obligatorio';
    setGeneral(null);
    setErrors(missing);
    if (Object.keys(missing).length) { refs.current[Object.keys(missing)[0]]?.focus(); return; }
    // Mismos valores que enviaba el formulario anterior: texto recortado y vacíos omitidos.
    const v = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, String(x).trim() === '' ? undefined : String(x).trim()]));
    if (v.password !== v.confirm) { showError({ details: [{ field: 'confirm', message: 'Las contraseñas no coinciden' }] }); return; }
    const { confirm, ...body } = v;
    void confirm;
    setBusy(true);
    try {
      await api.post('/store/auth/register', body);
      await api.access(v.email, v.password); // acceso único: cierra cualquier otra sesión del navegador
      toast('¡Bienvenido a Pharma Plus!', 'success');
      done.current = true;
      navigate(destinationFor('CUSTOMER', next), { replace: true });
    } catch (err) {
      showError(err);
      setBusy(false);
    }
  }

  const field = (name, { icon, placeholder, type = 'text', required = false, autoComplete, inputMode, eye = false, hint }) => {
    const id = `${uid}-${name}`;
    const err = errors[name];
    return (
      <div className={`access-group ${err ? 'has-error' : ''}`.trim()}>
        <label className="access-field" htmlFor={id}>
          <span className="sr-only">{`${placeholder}${required ? ' (obligatorio)' : ''}`}</span>
          <Icon name={icon} />
          <input
            ref={(el) => { refs.current[name] = el; }} id={id} name={name} type={eye && show[name] ? 'text' : type} autoComplete={autoComplete} inputMode={inputMode}
            placeholder={`${placeholder}${required ? ' *' : ''}`} value={values[name]} onChange={set(name)}
            aria-invalid={err ? 'true' : undefined} aria-describedby={`${id}-msg`}
          />
          {eye ? (
            <button type="button" className="access-eye" aria-label={show[name] ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={String(show[name])}
              onClick={() => setShow((s) => ({ ...s, [name]: !s[name] }))}><Icon name={show[name] ? 'eye' : 'eyeOff'} /></button>
          ) : null}
        </label>
        <div className="access-msg" id={`${id}-msg`}>{err || hint || ''}</div>
      </div>
    );
  };

  return (
    <AccessLayout theme={theme} setTheme={setTheme} variant="register" labelledBy={`${uid}-title`}>
      <div className="access-avatar" aria-hidden="true"><Icon name="userPlus" className="ico access-avatar-ic" /></div>
      <h2 id={`${uid}-title`}>Crear cuenta</h2>
      <p className="access-sub">Registra tus datos para comenzar a comprar en Pharma Plus.</p>

      {general ? <div className="access-alert danger" role="alert">{general}</div> : null}

      <form className="access-form" noValidate onSubmit={submit}>
        {field('fullName', { icon: 'user', placeholder: 'Nombre completo', required: true, autoComplete: 'name' })}
        {field('email', { icon: 'mail', placeholder: 'Correo electrónico', type: 'email', required: true, autoComplete: 'email' })}
        {field('phone', { icon: 'phone', placeholder: 'Teléfono (opcional)', type: 'tel', autoComplete: 'tel', inputMode: 'tel' })}

        <fieldset className="access-doc">
          <legend>Documento (opcional)</legend>
          <div className="access-radios" role="radiogroup" aria-label="Tipo de documento">
            {DOC_TYPES.map(([code, label]) => (
              <label key={code} className="access-radio">
                <input type="radio" name="documentType" value={code} checked={values.documentType === code}
                  onChange={() => pickDoc(code)} onClick={() => { if (values.documentType === code) pickDoc(code); }} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {field('documentNumber', { icon: 'idCard', placeholder: 'Número de documento', inputMode: values.documentType === 'DNI' ? 'numeric' : undefined })}
        {field('password', { icon: 'lock', placeholder: 'Contraseña', type: 'password', required: true, autoComplete: 'new-password', eye: true, hint: PASSWORD_HINT })}
        {field('confirm', { icon: 'lock', placeholder: 'Repetir contraseña', type: 'password', required: true, autoComplete: 'new-password', eye: true })}

        <button type="submit" className="access-submit" disabled={busy} aria-busy={busy ? 'true' : undefined}>
          {busy ? <span className="access-spin" aria-hidden="true" /> : <Icon name="userPlus" />}{busy ? 'Creando cuenta…' : 'Crear cuenta'}
        </button>
      </form>

      <p className="access-foot">¿Ya tienes una cuenta? <Link to={accessUrl(next)}>Iniciar sesión</Link></p>
    </AccessLayout>
  );
}
