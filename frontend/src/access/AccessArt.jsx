import React from 'react';

/**
 * Decoración ilustrada del acceso único (Bocetos/recortes-login): estanterías de farmacia difuminadas,
 * frasco con cápsulas, hojas y curvas azules/verdes. Todo es SVG dibujado aquí (sin imágenes externas)
 * y los colores salen de variables CSS, así que cambia con el tema. Es decorativo: aria-hidden.
 */

function Leaf({ x, y, s = 1, r = 0, id = 'lf', flip = false }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${r}) scale(${flip ? -s : s} ${s})`}>
      <path d="M2 40 C 25 5, 75 -4, 118 8 C 100 40, 60 62, 2 40 Z" fill={`url(#${id})`} />
      <path d="M6 39 C 40 28, 80 16, 114 9" stroke="var(--art-leaf-vein)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M40 30 L52 18 M62 25 L74 12 M30 34 L36 45 M56 27 L64 38" stroke="var(--art-leaf-vein)" strokeWidth="1" fill="none" opacity=".6" />
    </g>
  );
}

function LeafDefs({ id }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stopColor="var(--art-leaf-1)" />
      <stop offset="100%" stopColor="var(--art-leaf-2)" />
    </linearGradient>
  );
}

/** Cápsula de dos colores. */
function Capsule({ x, y, w = 70, h = 26, r = 0 }) {
  const rr = h / 2;
  const half = w / 2;
  return (
    <g transform={`translate(${x} ${y}) rotate(${r})`}>
      <path d={`M${rr} 0 H${half} V${h} H${rr} A${rr} ${rr} 0 0 1 ${rr} 0 Z`} fill="url(#capBlue)" />
      <path d={`M${half} 0 H${w - rr} A${rr} ${rr} 0 0 1 ${w - rr} ${h} H${half} Z`} fill="url(#capWhite)" />
      <path d={`M${rr} ${h * 0.25} H${w - rr}`} stroke="#ffffff" strokeOpacity=".55" strokeWidth={h * 0.12} strokeLinecap="round" />
    </g>
  );
}

function Tablet({ x, y, rx = 20, ry = 11, r = 0 }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${r})`}>
      <ellipse cx="0" cy="3" rx={rx} ry={ry} fill="var(--art-tablet-shade)" />
      <ellipse cx="0" cy="0" rx={rx} ry={ry} fill="url(#tab)" />
      <path d={`M${-rx * 0.6} 0 H${rx * 0.6}`} stroke="var(--art-tablet-line)" strokeWidth="1.4" />
    </g>
  );
}

/** Estanterías de farmacia difuminadas (borde izquierdo). */
export function Shelves({ className }) {
  const rows = [70, 190, 310, 430, 550];
  const items = [[8, 34, 52], [46, 24, 38], [74, 30, 60], [108, 22, 44], [134, 34, 54], [172, 26, 40], [202, 30, 58]];
  return (
    <svg className={className} viewBox="0 0 250 640" preserveAspectRatio="xMinYMid slice" aria-hidden="true">
      {rows.map((y, k) => (
        <g key={y}>
          {items.map(([x, w, h], i) => (
            <rect key={i} x={x} y={y - h} width={w} height={h} rx="4" fill={`var(--art-shelf-${(i + k) % 4})`} />
          ))}
          <rect x="0" y={y} width="250" height="9" fill="var(--art-shelf-board)" />
        </g>
      ))}
    </svg>
  );
}

/** Frasco de medicamentos con cápsulas, tabletas y hojas (esquina inferior izquierda). */
export function Bottle({ className }) {
  return (
    <svg className={className} viewBox="0 0 430 300" aria-hidden="true">
      <defs>
        <LeafDefs id="lfB" />
        <linearGradient id="capBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3d8df5" /><stop offset="100%" stopColor="#0f4fc4" /></linearGradient>
        <linearGradient id="capWhite" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ffffff" /><stop offset="100%" stopColor="#d5dde8" /></linearGradient>
        <linearGradient id="tab" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ffffff" /><stop offset="100%" stopColor="#e3e9f1" /></linearGradient>
        <linearGradient id="bottleBody" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--art-bottle-2)" /><stop offset="35%" stopColor="var(--art-bottle-1)" /><stop offset="100%" stopColor="var(--art-bottle-3)" />
        </linearGradient>
        <linearGradient id="bottleCap" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--art-cap-2)" /><stop offset="45%" stopColor="var(--art-cap-1)" /><stop offset="100%" stopColor="var(--art-cap-2)" />
        </linearGradient>
      </defs>
      <Leaf x={-10} y={120} s={1.15} r={-35} id="lfB" />
      <Leaf x={150} y={150} s={1.1} r={-20} id="lfB" />
      <Leaf x={250} y={210} s={1.2} r={-8} id="lfB" />
      {/* frasco */}
      <rect x="42" y="78" width="150" height="196" rx="20" fill="url(#bottleBody)" />
      <rect x="52" y="62" width="130" height="22" rx="5" fill="var(--art-cap-2)" />
      <rect x="46" y="10" width="142" height="56" rx="9" fill="url(#bottleCap)" />
      {Array.from({ length: 13 }).map((_, i) => <line key={i} x1={56 + i * 10} x2={56 + i * 10} y1="16" y2="60" stroke="var(--art-cap-ridge)" strokeWidth="2" />)}
      <rect x="58" y="104" width="10" height="150" rx="5" fill="#ffffff" opacity="var(--art-bottle-shine)" />
      <path d="M103 150 h28 v-28 h26 v28 h28 v26 h-28 v28 h-26 v-28 h-28 z" fill="var(--art-cross-fill)" stroke="var(--art-cross-stroke)" strokeWidth="4" strokeLinejoin="round" transform="translate(-26 4)" />
      {/* cápsulas y tabletas */}
      <Capsule x={170} y={232} w={78} h={30} r={-28} />
      <Capsule x={232} y={246} w={74} h={28} r={12} />
      <Capsule x={120} y={258} w={70} h={27} r={-6} />
      <Capsule x={290} y={214} w={64} h={25} r={-42} />
      <Tablet x={222} y={286} r={-6} />
      <Tablet x={285} y={278} rx={18} ry={10} r={10} />
      <Tablet x={330} y={262} rx={16} ry={9} r={-14} />
      <Leaf x={320} y={250} s={0.95} r={-24} id="lfB" />
    </svg>
  );
}

/** Ramillete de hojas (bordes de la pantalla). */
export function Leaves({ className, variant = 'br' }) {
  const sets = {
    br: [[60, 150, 1.35, -60], [120, 190, 1.2, -30], [10, 230, 1.1, -75], [150, 120, 1, -95]],
    tr: [[40, 40, 1.15, 70], [90, 70, 0.9, 110]],
    bl: [[0, 180, 1.2, -30], [40, 220, 1, -10]],
  };
  return (
    <svg className={className} viewBox="0 0 260 280" aria-hidden="true">
      <defs><LeafDefs id={`lf-${variant}`} /></defs>
      {sets[variant].map(([x, y, s, r], i) => <Leaf key={i} x={x} y={y} s={s} r={r} id={`lf-${variant}`} />)}
    </svg>
  );
}

/** Curvas azules y verdes del fondo (toda la pantalla). */
export function Waves({ className }) {
  return (
    <svg className={className} viewBox="0 0 1440 900" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="wTop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--art-wave-1)" stopOpacity="var(--art-wave-o1)" />
          <stop offset="100%" stopColor="var(--art-wave-2)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="wBottom" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--art-wave-1)" stopOpacity="var(--art-wave-o1)" />
          <stop offset="70%" stopColor="var(--art-wave-2)" stopOpacity="var(--art-wave-o2)" />
          <stop offset="100%" stopColor="var(--art-wave-2)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="wGreen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--art-green-1)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--art-green-1)" stopOpacity="var(--art-green-o)" />
        </linearGradient>
      </defs>
      {/* esquina superior izquierda */}
      <path d="M0 0 H560 C420 40 250 120 140 270 C80 350 40 420 0 500 Z" fill="url(#wTop)" />
      <path d="M0 0 H360 C250 40 120 120 0 250 Z" fill="var(--art-wave-1)" opacity="var(--art-wave-o3)" />
      <path d="M560 0 C420 40 250 120 140 270 C80 350 40 420 0 500" fill="none" stroke="var(--art-line-1)" strokeWidth="3" opacity=".75" />
      <path d="M380 0 C 260 50 140 130 40 260" fill="none" stroke="var(--art-line-2)" strokeWidth="2" opacity=".6" />
      {/* banda inferior que sube hacia la tarjeta */}
      <path d="M0 900 V820 C300 880 640 860 860 720 C960 655 1020 590 1100 500 L1110 520 C1040 620 980 690 880 760 C660 900 300 900 0 900 Z" fill="url(#wBottom)" />
      <path d="M0 860 C320 900 640 870 870 735 C960 680 1030 610 1105 515" fill="none" stroke="var(--art-line-1)" strokeWidth="3" opacity=".7" />
      <path d="M0 900 V870 C340 905 690 880 900 760 C980 715 1050 650 1120 560 V900 Z" fill="var(--art-wave-1)" opacity="var(--art-wave-o3)" />
      {/* esquina inferior derecha y superior derecha (verde) */}
      <path d="M1440 900 H1080 C1220 860 1340 760 1440 600 Z" fill="url(#wGreen)" />
      <path d="M1440 620 C1350 760 1230 860 1080 900" fill="none" stroke="var(--art-green-line)" strokeWidth="3" opacity=".8" />
      <path d="M1290 0 C1360 50 1410 120 1440 200 V0 Z" fill="url(#wGreen)" />
      <path d="M1250 0 C1340 60 1405 140 1440 230" fill="none" stroke="var(--art-green-line)" strokeWidth="2.5" opacity=".7" />
    </svg>
  );
}

/** Avatar del formulario (persona rellena, como en el diseño). */
export function UserAvatarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="access-avatar-ic">
      <circle cx="12" cy="7.5" r="4.6" fill="currentColor" />
      <path d="M3.2 21.5c.6-4.6 4.2-7.6 8.8-7.6s8.2 3 8.8 7.6c.05.4-.25.8-.65.8H3.85c-.4 0-.7-.4-.65-.8z" fill="currentColor" />
    </svg>
  );
}

/** Escudo con check (característica "Compra segura"). */
export function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ico">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  );
}

/** Curvas para la composición móvil (proporción vertical, sin estirarse). */
export function WavesMobile({ className }) {
  return (
    <svg className={className} viewBox="0 0 390 844" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="wmTop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--art-wave-1)" stopOpacity="var(--art-wave-o1)" />
          <stop offset="100%" stopColor="var(--art-wave-2)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="wmBottom" x1="1" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="var(--art-wave-1)" stopOpacity="var(--art-wave-o1)" />
          <stop offset="100%" stopColor="var(--art-wave-2)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0 0 H230 C150 30 70 90 0 170 Z" fill="url(#wmTop)" />
      <path d="M230 0 C150 30 70 90 0 170" fill="none" stroke="var(--art-line-1)" strokeWidth="2" opacity=".7" />
      <path d="M390 844 H160 C260 820 340 760 390 680 Z" fill="url(#wmBottom)" />
      <path d="M390 690 C340 770 260 826 150 844" fill="none" stroke="var(--art-line-1)" strokeWidth="2.5" opacity=".7" />
      <path d="M390 740 C350 790 300 826 240 844" fill="none" stroke="var(--art-green-line)" strokeWidth="2" opacity=".6" />
    </svg>
  );
}
