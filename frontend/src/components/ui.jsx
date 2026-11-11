import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { statusLabel, errorMessage } from '../core/format.js';
import { Icon } from './icons.jsx';
import { openModal, ModalBody, ModalFoot } from './modal.jsx';
import { toast } from './toast.jsx';

export { Icon, toast, errorMessage };

/**
 * Botón. Si onClick devuelve una promesa, el botón queda deshabilitado (aria-busy) hasta que termine:
 * evita dobles envíos igual que busy() en el frontend anterior.
 */
export const Button = React.forwardRef(function Button({ children, variant = '', size = '', icon, onClick, type = 'button', title, disabled, className = '', block = false, ...rest }, ref) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const handle = async (e) => {
    if (!onClick || busy) return;
    const r = onClick(e);
    if (r && typeof r.then === 'function') {
      setBusy(true);
      try { await r; } finally { if (mounted.current) setBusy(false); }
    }
  };
  const cls = ['btn', variant ? `btn-${variant}` : '', size ? `btn-${size}` : '', block ? 'btn-block' : '', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} onClick={onClick ? handle : undefined} title={title} disabled={disabled || busy} aria-busy={busy ? 'true' : undefined} {...rest}>
      {icon ? <Icon name={icon} /> : null}{children}
    </button>
  );
});

export function Badge({ kind, code }) {
  const { text, tone } = statusLabel(kind, code);
  return <span className={`badge ${tone}`}>{text}</span>;
}

export function ToneBadge({ tone = 'neutral', children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Spinner({ label = 'Cargando…' }) {
  return <div className="state" role="status"><div className="spinner" /><span className="small">{label}</span></div>;
}

export function EmptyState({ title, text, action }) {
  return <div className="state"><Icon name="inbox" /><h3>{title}</h3>{text ? <p className="small">{text}</p> : null}{action || null}</div>;
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="state error" role="alert">
      <Icon name="alert" /><h3>No se pudo cargar</h3>
      <p className="small">{errorMessage(error)}</p>
      {onRetry ? <Button icon="refresh" onClick={() => onRetry()}>Reintentar</Button> : null}
    </div>
  );
}

export function Card({ title, actions, tight = false, children, className = '' }) {
  return (
    <section className={`card ${className}`.trim()}>
      {title ? (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      <div className={`card-body ${tight ? 'tight' : ''}`}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, delta }) {
  const showDelta = delta !== undefined && delta !== null;
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub || delta !== undefined ? (
        <div className="sub">
          {showDelta ? <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>{`${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} %`}</span> : null}
          {sub ? ` ${sub}` : ''}
        </div>
      ) : null}
    </div>
  );
}

export function PageHead({ title, sub, actions }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub ? <p className="sub">{sub}</p> : null}</div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

function cellValue(v) {
  return v === null || v === undefined || v === '' ? '—' : v;
}

/** Tabla. columns: [{ label, key, render(row), num, className }] */
export function Table({ columns, rows, onRowClick, empty = 'Sin resultados', rowKey }) {
  if (!rows || rows.length === 0) return <EmptyState title={empty} />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((c, i) => <th key={i} className={c.num ? 'num' : c.className} scope="col">{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr
              key={rowKey ? rowKey(r) : ri}
              className={onRowClick ? 'clickable' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? (e) => { if (!e.target.closest('button, a, input, select, label, textarea')) onRowClick(r); } : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(r); } : undefined}
            >
              {columns.map((c, ci) => <td key={ci} className={c.num ? 'num' : c.className}>{cellValue(c.render ? c.render(r) : r[c.key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ p, onChange }) {
  if (!p || p.total === 0) return null;
  return (
    <div className="pagination">
      <span className="small muted">{`${p.total} registro${p.total === 1 ? '' : 's'} · página ${p.page} de ${Math.max(p.totalPages, 1)}`}</span>
      <div className="pages">
        <Button size="sm" disabled={p.page <= 1} onClick={() => onChange(p.page - 1)}>Anterior</Button>
        <Button size="sm" disabled={p.page >= p.totalPages} onClick={() => onChange(p.page + 1)}>Siguiente</Button>
      </div>
    </div>
  );
}

export function Tabs({ items, active, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.id} type="button" className="tab" role="tab" aria-selected={String(i.id === active)} onClick={() => onChange(i.id)}>{i.label}</button>
      ))}
    </div>
  );
}

export function KV({ pairs }) {
  return (
    <dl className="kv">
      {pairs.filter(Boolean).map(([k, v], i) => (
        <React.Fragment key={i}><dt>{k}</dt><dd>{v ?? '—'}</dd></React.Fragment>
      ))}
    </dl>
  );
}

export function AlertBox({ tone = 'info', children }) {
  return <div className={`alert-box ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>{children}</div>;
}

export function useDebouncedCallback(fn, ms = 300) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  return useCallback((...args) => {
    clearTimeout(t.current);
    t.current = setTimeout(() => fnRef.current(...args), ms);
  }, [ms]);
}

export function SearchInput({ placeholder, onSearch, value = '', ms = 300, className = 'search' }) {
  const [v, setV] = useState(value);
  const fire = useDebouncedCallback((x) => onSearch(x.trim()), ms);
  return (
    <div className={className}>
      <Icon name="search" />
      <input className="input" type="search" placeholder={placeholder} aria-label={placeholder} value={v} onChange={(e) => { setV(e.target.value); fire(e.target.value); }} />
    </div>
  );
}

export function Select({ options, value, onChange, label, placeholder, style, name }) {
  const id = useId();
  const s = (
    <select id={id} className="input" aria-label={label || placeholder} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={style} name={name}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
  return label ? <div className="field"><label htmlFor={id}>{label}</label>{s}</div> : s;
}

export function DateInput({ value, onChange, label }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------- gráficos
/** Barras verticales SVG accesibles. data: [{ label, value, title }] */
export function BarChart({ data, height = 220, formatValue = (v) => String(v) }) {
  const w = Math.max(320, data.length * 36);
  const pad = { t: 10, r: 8, b: 28, l: 8 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = (w - pad.l - pad.r) / Math.max(data.length, 1);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="chart" role="img" preserveAspectRatio="none" aria-label={data.map((d) => `${d.label}: ${formatValue(d.value)}`).join('; ')}>
      <line x1={pad.l} x2={w - pad.r} y1={height - pad.b} y2={height - pad.b} className="axis" />
      {data.map((d, i) => {
        const bh = ((height - pad.t - pad.b) * d.value) / max;
        const showLabel = data.length <= 16 || i % Math.ceil(data.length / 12) === 0;
        return (
          <React.Fragment key={i}>
            <rect x={pad.l + i * bw + bw * 0.18} y={height - pad.b - bh} width={bw * 0.64} height={Math.max(bh, d.value > 0 ? 2 : 0)} rx={3} className="bar">
              <title>{d.title || `${d.label}: ${formatValue(d.value)}`}</title>
            </rect>
            {showLabel ? <text x={pad.l + i * bw + bw / 2} y={height - 9} textAnchor="middle">{d.label}</text> : null}
          </React.Fragment>
        );
      })}
    </svg>
  );
}

/** Barras horizontales (ranking). items: [{ label, value, display }] */
export function HBars({ items }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div>
      {items.map((i, idx) => (
        <div className="hbar" key={idx}>
          <span className="nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={i.label}>{i.label}</span>
          <div className="track"><div className="fill" style={{ width: `${(i.value / max) * 100}%` }} /></div>
          <span className="strong nowrap">{i.display ?? i.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Abre el ticket HTML del servidor e inicia la impresión (mismo origen). */
export function printUrl(url) {
  const w = window.open(url, '_blank', 'width=420,height=720');
  if (!w) { toast('Permita las ventanas emergentes para imprimir el ticket', 'warning'); return; }
  w.addEventListener('load', () => { w.focus(); w.print(); });
}

// ------------------------------------------------------------ confirmación
/** Confirmación. Opcionalmente pide un motivo (mínimo 5 caracteres). Resuelve false o { reason }. */
export function confirmDialog({ title, message, confirmText = 'Confirmar', danger = false, reason = false, reasonLabel = 'Motivo' }) {
  return new Promise((resolve) => {
    let done = false;
    function ConfirmContent({ close }) {
      const [text, setText] = useState('');
      const [err, setErr] = useState('');
      return (
        <>
          <ModalBody>
            <div className="stack">
              <p>{message}</p>
              {reason ? (
                <div className="field">
                  <label htmlFor="confirm-reason">{reasonLabel}</label>
                  <textarea className="input" id="confirm-reason" required minLength={5} maxLength={400} value={text} onChange={(e) => setText(e.target.value)} />
                  <div className="error">{err}</div>
                </div>
              ) : null}
            </div>
          </ModalBody>
          <ModalFoot>
            <Button onClick={() => close()}>Volver</Button>
            <Button
              variant={danger ? 'danger solid' : 'primary'}
              onClick={() => {
                if (reason && text.trim().length < 5) { setErr('Indique el motivo (mínimo 5 caracteres)'); document.getElementById('confirm-reason')?.focus(); return; }
                done = true;
                close();
                resolve({ reason: reason ? text.trim() : undefined });
              }}
            >{confirmText}</Button>
          </ModalFoot>
        </>
      );
    }
    openModal({ title, content: ConfirmContent, onClose: () => { if (!done) resolve(false); } });
  });
}

// ------------------------------------------------------------------ datos
/**
 * Carga asíncrona con descarte de respuestas obsoletas.
 * Devuelve { data, error, loading, reload }. Mientras recarga conserva los datos anteriores.
 */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fnRef.current();
      if (my === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (my === seq.current) setState({ data: undefined, error, loading: false });
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, deps);
  return { ...state, reload };
}

/** Pinta spinner / error / contenido según el estado de useAsync. */
export function Async({ state, children, label }) {
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (state.data === undefined) return <Spinner label={label} />;
  return children(state.data);
}
