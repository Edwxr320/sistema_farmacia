import React, { useEffect, useRef, useState, useSyncExternalStore, useId } from 'react';
import { Icon } from './icons.jsx';

/**
 * Pila global de modales. openModal() devuelve { close, setTitle } igual que el modal() anterior.
 *  - body / actions: contenido estático.
 *  - content: componente ({ close, setTitle }) que dibuja <ModalBody> y opcionalmente <ModalFoot>.
 * <ModalHost/> se monta dentro del proveedor de cada portal para que los modales usen su contexto.
 */
let stack = [];
let seq = 0;
const subs = new Set();
const emit = () => { for (const fn of subs) fn(); };
const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const snapshot = () => stack;

export function openModal({ title, size = '', body, actions = [], content, onClose, dismissible = true }) {
  const id = ++seq;
  const previous = typeof document !== 'undefined' ? document.activeElement : null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stack = stack.filter((m) => m.id !== id);
    emit();
    if (previous && previous.focus && document.contains(previous)) setTimeout(() => previous.focus(), 0);
    if (onClose) onClose();
  };
  const setTitle = (t) => {
    stack = stack.map((m) => (m.id === id ? { ...m, title: t } : m));
    emit();
  };
  stack = [...stack, { id, title, size, body, actions, content, dismissible, close, setTitle }];
  emit();
  return { close, setTitle };
}

export function closeAllModals() {
  for (const m of [...stack]) m.close();
}

export function ModalBody({ children }) {
  return <div className="modal-body">{children}</div>;
}

export function ModalFoot({ children }) {
  return <div className="modal-foot">{children}</div>;
}

const FOCUSABLE = 'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

function Modal({ entry, top }) {
  const ref = useRef(null);
  const titleId = useId();
  const [Content] = useState(() => entry.content || null);

  useEffect(() => {
    const t = setTimeout(() => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return;
      const first = el.querySelector('.modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea, button.btn-primary, button');
      if (first) first.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!top) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && entry.dismissible) entry.close();
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll(FOCUSABLE)].filter((x) => !x.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [top, entry]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && entry.dismissible) entry.close(); }}>
      <div ref={ref} className={`modal ${entry.size || ''}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <h2 id={titleId}>{entry.title}</h2>
          {entry.dismissible ? (
            <button type="button" className="btn btn-ghost icon-btn" aria-label="Cerrar" onClick={entry.close}><Icon name="x" /></button>
          ) : null}
        </div>
        {Content ? <Content close={entry.close} setTitle={entry.setTitle} /> : (
          <>
            <ModalBody>{entry.body}</ModalBody>
            {entry.actions && entry.actions.filter(Boolean).length ? <ModalFoot>{entry.actions.filter(Boolean).map((a, i) => <React.Fragment key={i}>{a}</React.Fragment>)}</ModalFoot> : null}
          </>
        )}
      </div>
    </div>
  );
}

export function ModalHost() {
  const list = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => () => closeAllModals(), []);
  return list.map((m, i) => <Modal key={m.id} entry={m} top={i === list.length - 1} />);
}
