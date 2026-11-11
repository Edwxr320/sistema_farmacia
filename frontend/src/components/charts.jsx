import React, { useEffect, useId, useRef, useState } from 'react';

/** Ancho real del contenedor (los gráficos se dibujan en píxeles: texto y puntos sin deformar). */
function useWidth(initial = 600) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!ref.current) return undefined;
    const el = ref.current;
    const update = () => setW(Math.max(200, Math.floor(el.getBoundingClientRect().width)));
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Máximo "redondo" para el eje Y (1, 2, 2.5, 5 × 10ⁿ) con 4 divisiones. */
function niceMax(v) {
  if (!(v > 0)) return 4;
  const step = v / 4;
  const p = 10 ** Math.floor(Math.log10(step));
  const n = [1, 2, 2.5, 5, 10].find((m) => m * p >= step) * p;
  return n * 4;
}

export function compactNumber(v) {
  if (v >= 1000000) return `${+(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `${+(v / 1000).toFixed(1)}k`;
  return String(+v.toFixed(0));
}

/**
 * Gráfico de línea con área. points: [{ label, value, title }].
 * Muestra el valor máximo (o el punto bajo el cursor) en una etiqueta, como en el diseño aprobado.
 */
export function LineChart({ points, height: fixedHeight, formatValue = String, ariaLabel }) {
  const [ref, width] = useWidth();
  const height = fixedHeight || (width < 480 ? 170 : 240);
  const gid = useId().replace(/:/g, '');
  const [hover, setHover] = useState(null);
  const pad = { t: 34, r: 14, b: 28, l: 38 };
  const n = points.length;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v) => pad.t + ih - (ih * v) / max;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = n ? `${line} L${x(n - 1).toFixed(1)},${pad.t + ih} L${x(0).toFixed(1)},${pad.t + ih} Z` : '';
  const peak = points.reduce((best, p, i) => (p.value > (points[best]?.value ?? -1) ? i : best), 0);
  const focus = hover ?? (n && points[peak].value > 0 ? peak : null);
  const ticks = [0, 1, 2, 3, 4].map((k) => (max * k) / 4);
  const labelEvery = Math.max(1, Math.ceil(n / (width < 420 ? 4 : 6)));
  const dots = n <= 45;

  function onMove(e) {
    if (!n) return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = Math.round(((px - pad.l) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  const tip = focus !== null && points[focus] ? formatValue(points[focus].value) : null;
  const tipW = tip ? Math.max(64, tip.length * 7.4 + 18) : 0;
  const tipX = focus !== null ? Math.min(Math.max(x(focus) - tipW / 2, pad.l), width - pad.r - tipW) : 0;
  const tipY = focus !== null ? Math.max(4, y(points[focus].value) - 34) : 0;

  return (
    <div ref={ref} className="lc">
      <svg width={width} height={height} role="img" aria-label={ariaLabel || points.map((p) => `${p.title || p.label}: ${formatValue(p.value)}`).join('; ')}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--chart-line)', stopOpacity: 0.26 }} />
            <stop offset="100%" style={{ stopColor: 'var(--chart-line)', stopOpacity: 0.02 }} />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="lc-grid" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="lc-axis">{compactNumber(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (i % labelEvery === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= labelEvery * 0.85) ? (
          <text key={`l${i}`} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="lc-axis">{p.label}</text>
        ) : null)}
        {n ? <path d={area} fill={`url(#g${gid})`} /> : null}
        {n ? <path d={line} className="lc-line" /> : null}
        {focus !== null ? <line x1={x(focus)} x2={x(focus)} y1={y(points[focus].value)} y2={pad.t + ih} className="lc-guide" /> : null}
        {dots ? points.map((p, i) => <circle key={`d${i}`} cx={x(i)} cy={y(p.value)} r={i === focus ? 5 : 3.6} className="lc-dot" />) : null}
        {tip ? (
          <g className="lc-tip" pointerEvents="none">
            <rect x={tipX} y={tipY} width={tipW} height={24} rx={7} />
            <path d={`M${x(focus) - 5},${tipY + 24} L${x(focus)},${tipY + 30} L${x(focus) + 5},${tipY + 24} Z`} />
            <text x={tipX + tipW / 2} y={tipY + 16} textAnchor="middle">{tip}</text>
          </g>
        ) : null}
      </svg>
      {focus !== null && points[focus]?.title ? <div className="sr-only" aria-live="polite">{points[focus].title}</div> : null}
    </div>
  );
}

/** Mini tendencia para las tarjetas de indicadores (datos reales). */
export function Sparkline({ values, color = 'currentColor', width = 78, height = 34 }) {
  const gid = useId().replace(/:/g, '');
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(width * i) / (values.length - 1), height - 3 - ((height - 6) * (v - min)) / span]);
  const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={`s${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#s${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Donut. segments: [{ label, value, color }]; center: contenido central. */
export function Donut({ segments, center, sub = 'Total', size = 168, thickness = 22 }) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((a, s) => a + s.value, 0);
  let offset = 0;
  return (
    <div className="donut">
      <svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={segments.map((s) => `${s.label}: ${s.value}`).join('; ')}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="donut-track" strokeWidth={thickness} />
        {total > 0 ? segments.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * c;
          const gap = segments.filter((x) => x.value > 0).length > 1 ? Math.min(3, len / 3) : 0;
          const el = (
            <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
              strokeDasharray={`${Math.max(len - gap, 0)} ${c}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="butt">
              <title>{s.label}</title>
            </circle>
          );
          offset += len;
          return el;
        }) : null}
      </svg>
      <div className="donut-center"><strong>{center}</strong><span>{sub}</span></div>
    </div>
  );
}
