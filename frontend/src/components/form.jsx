import React, { useId, useRef, useState } from 'react';
import { errorMessage } from '../core/format.js';
import { Button, AlertBox } from './ui.jsx';
import { openModal, ModalBody, ModalFoot } from './modal.jsx';

/**
 * Formulario declarativo (misma especificación de campos que form() del frontend anterior).
 * fields: [{ name, label, type: text|email|password|number|money|date|select|textarea|checkbox|file, options:[{value,label}],
 *            required, hint, full, value, min, max, step, placeholder, disabled, emptyAs, autocomplete, accept }]
 * Los controles son no controlados: los valores se leen al enviar (como antes) y los envía onSubmit(values).
 * El servidor valida todo; aquí solo se marcan los obligatorios y se muestran sus errores por campo.
 */
export function Form({ fields, onSubmit, submitLabel, cancel, id, onBusyChange, submitClassName = '', submitBlock = false, submitSize = '' }) {
  const uid = useId();
  const formId = id || `form-${uid}`;
  const controls = useRef({});
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState(null);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (b) => { busyRef.current = b; setBusyState(b); if (onBusyChange) onBusyChange(b); };

  function values() {
    const out = {};
    for (const f of fields) {
      const c = controls.current[f.name];
      if (!c) continue;
      if (f.type === 'checkbox') out[f.name] = c.checked;
      else if (f.type === 'file') out[f.name] = c.files && c.files[0];
      else {
        const v = c.value.trim();
        out[f.name] = v === '' ? (f.emptyAs !== undefined ? f.emptyAs : undefined) : (f.type === 'number' ? Number(v) : v);
      }
    }
    return out;
  }

  function showError(err) {
    const next = {};
    let placed = false;
    if (Array.isArray(err?.details)) {
      for (const d of err.details) {
        const key = d.field && d.field.split('.')[0];
        if (key && fields.some((f) => f.name === key)) { next[key] = d.message; placed = true; }
      }
    }
    setErrors(next);
    setGeneral(placed ? null : errorMessage(err));
  }

  function checkRequired() {
    const next = {};
    for (const f of fields) {
      const c = controls.current[f.name];
      if (f.required && f.type !== 'checkbox' && c && !String(c.value).trim()) next[f.name] = 'Campo obligatorio';
    }
    setErrors(next);
    setGeneral(null);
    return Object.keys(next).length === 0;
  }

  async function submit(e) {
    e.preventDefault();
    if (!onSubmit || busyRef.current || !checkRequired()) return;
    setBusy(true);
    try {
      await onSubmit(values());
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id={formId} className="stack" noValidate onSubmit={submit}>
      <div>{general ? <AlertBox tone="danger">{general}</AlertBox> : null}</div>
      <div className="form-grid">
        {fields.map((f) => <Field key={f.name} f={f} uid={uid} error={errors[f.name]} register={(el) => { if (el) controls.current[f.name] = el; else delete controls.current[f.name]; }} />)}
      </div>
      {submitLabel ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {cancel || null}
          <Button variant="primary" type="submit" disabled={busy} aria-busy={busy ? 'true' : undefined} block={submitBlock} size={submitSize} className={submitClassName}>{submitLabel}</Button>
        </div>
      ) : null}
    </form>
  );
}

function initialSelectValue(f) {
  const v = String(f.value ?? '');
  if (f.placeholder !== undefined) return (f.options || []).some((o) => String(o.value) === v) ? v : '';
  // Sin opción vacía: si el valor no existe, el navegador elige la primera opción.
  return (f.options || []).some((o) => String(o.value) === v) ? v : String(f.options?.[0]?.value ?? '');
}

function Field({ f, uid, error, register }) {
  const id = `f-${f.name}-${uid}`.replace(/:/g, '');
  const errId = `${id}-err`;
  const common = { id, name: f.name, ref: register, 'aria-describedby': errId, 'aria-invalid': error ? 'true' : undefined, disabled: f.disabled };
  let control;
  if (f.type === 'select') {
    control = (
      <select className="input" required={f.required} defaultValue={initialSelectValue(f)} {...common}>
        {f.placeholder !== undefined ? <option value="">{f.placeholder}</option> : null}
        {(f.options || []).map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    );
  } else if (f.type === 'textarea') {
    control = <textarea className="input" required={f.required} maxLength={f.max} placeholder={f.placeholder} defaultValue={f.value ?? ''} {...common} />;
  } else if (f.type === 'checkbox') {
    control = <input type="checkbox" defaultChecked={Boolean(f.value)} {...common} />;
  } else {
    const type = f.type === 'money' ? 'text' : (f.type || 'text');
    control = (
      <input
        className="input" type={type} required={f.required} min={f.min} max={f.max} step={f.step}
        placeholder={f.placeholder ?? (f.type === 'money' ? '0.00' : undefined)}
        inputMode={f.type === 'money' ? 'decimal' : (f.type === 'number' ? 'numeric' : undefined)}
        autoComplete={f.autocomplete} accept={f.accept}
        defaultValue={f.type !== 'file' && f.value !== undefined && f.value !== null ? String(f.value) : undefined}
        {...common}
      />
    );
  }
  if (f.type === 'checkbox') {
    return (
      <div className={`field ${f.full ? 'full' : ''}`}>
        <label className="check" htmlFor={id}>{control}{f.label}</label>
        <div className="error" id={errId}>{error || ''}</div>
      </div>
    );
  }
  return (
    <div className={`field ${f.full ? 'full' : ''}`}>
      <label htmlFor={id}>{f.label}{f.required ? ' *' : ''}</label>
      {control}
      {f.hint ? <div className="hint">{f.hint}</div> : null}
      <div className="error" id={errId}>{error || ''}</div>
    </div>
  );
}

/** Modal con formulario; resuelve con el resultado de onSubmit (o true) o null si se cierra. */
export function formModal({ title, fields, submitLabel = 'Guardar', onSubmit, size, intro }) {
  return new Promise((resolve) => {
    let done = false;
    function FormModalContent({ close }) {
      const formId = `fm-${useId().replace(/:/g, '')}`;
      const [busy, setBusy] = useState(false);
      return (
        <>
          <ModalBody>
            <div className="stack">
              {intro || null}
              <Form
                id={formId}
                fields={fields}
                onBusyChange={setBusy}
                onSubmit={async (vals) => {
                  const result = await onSubmit(vals);
                  done = true;
                  close();
                  resolve(result ?? true);
                }}
              />
            </div>
          </ModalBody>
          <ModalFoot>
            <Button onClick={() => close()}>Cancelar</Button>
            <Button variant="primary" type="submit" form={formId} disabled={busy} aria-busy={busy ? 'true' : undefined}>{submitLabel}</Button>
          </ModalFoot>
        </>
      );
    }
    openModal({ title, size, content: FormModalContent, onClose: () => { if (!done) resolve(null); } });
  });
}
