import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../core/api-client.js';
import { money, date } from '../../core/format.js';
import { useDebouncedCallback } from '../../components/ui.jsx';

/**
 * Buscador de productos con lista desplegable accesible. onPick(product) recibe el producto de /api/products.
 */
export function ProductPicker({ onPick, placeholder = 'Buscar producto por nombre, SKU o código…', status = 'ACTIVE' }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const input = useRef(null);
  const list = useRef(null);
  const seq = useRef(0);

  const search = useDebouncedCallback(async (term) => {
    const t = term.trim();
    if (t.length < 2) { setOpen(false); return; }
    const my = ++seq.current;
    const r = await api.get('/products', { q: t, status, pageSize: 10 }).catch(() => ({ data: [] }));
    if (my !== seq.current) return;
    setResults(r.data);
    setOpen(true);
  }, 250);

  useEffect(() => {
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  function choose(p) {
    setOpen(false);
    setQ('');
    onPick(p);
  }

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <input
        ref={input} className="input" type="search" placeholder={placeholder} aria-label={placeholder} autoComplete="off" role="combobox" aria-expanded={String(open)}
        value={q}
        onChange={(e) => { setQ(e.target.value); search(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0] && open) { e.preventDefault(); choose(results[0]); }
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'ArrowDown') { const b = list.current?.querySelector('button'); if (b) { e.preventDefault(); b.focus(); } }
        }}
      />
      <div
        ref={list} className="card" role="listbox"
        style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 20, maxHeight: '280px', overflowY: 'auto', display: open ? 'block' : 'none' }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && e.target.nextElementSibling) { e.preventDefault(); e.target.nextElementSibling.focus(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); (e.target.previousElementSibling || input.current).focus(); }
        }}
      >
        {results.length ? results.map((p) => (
          <button key={p.id} type="button" role="option" aria-selected="false" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'space-between', borderRadius: 0 }} onClick={() => choose(p)}>
            <span style={{ textAlign: 'left' }}>{p.name}<span className="muted small">{` · ${p.sku}`}</span></span>
            <span className="small">{money(p.salePrice)}</span>
          </button>
        )) : <div className="small muted" style={{ padding: '10px' }}>Sin coincidencias</div>}
      </div>
    </div>
  );
}

/** Lotes de un producto en una sucursal (con stock). */
export async function batchesOf(productId, branchId, { withStock = true } = {}) {
  const r = await api.get('/inventory/batches', { productId, branchId, withStock: withStock ? 'true' : undefined, pageSize: 100 });
  return r.data;
}

export function batchLabel(b) {
  return `${b.batch_number} · vence ${date(b.expiry_date)} · ${b.current_quantity} u.${b.status !== 'ACTIVE' ? ` (${b.status})` : ''}`;
}

/** Celda de dos líneas (título + subtítulo). */
export function Cell({ title, sub, mono = false }) {
  return <div><div className={mono ? 'mono' : 'cell-title'}>{title}</div><div className="cell-sub">{sub}</div></div>;
}
