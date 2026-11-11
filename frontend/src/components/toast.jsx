import React, { useSyncExternalStore } from 'react';

/** Avisos globales (equivalente a toast() del frontend anterior). */
let items = [];
let seq = 0;
const subs = new Set();
const emit = () => { for (const fn of subs) fn(); };

export function toast(message, type = 'info', ms = 4500) {
  const id = ++seq;
  items = [...items, { id, message: String(message ?? ''), type }];
  emit();
  setTimeout(() => dismiss(id), ms);
}

function dismiss(id) {
  items = items.filter((t) => t.id !== id);
  emit();
}

const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const snapshot = () => items;

export function ToastHost() {
  const list = useSyncExternalStore(subscribe, snapshot);
  if (!list.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
          <span>{t.message}</span>
          <button type="button" aria-label="Cerrar aviso" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
