/**
 * Tema compartido por /acceso y /registro (clave pp.theme). Independiente del panel (pharma_plus_admin_theme)
 * y de la tienda (pharma_plus_store_theme). Se lee de forma síncrona en el primer render para evitar parpadeos.
 */
import { useEffect, useState } from 'react';

export const ACCESS_THEME_KEY = 'pp.theme';

export function initialAccessTheme() {
  try {
    const saved = window.localStorage.getItem(ACCESS_THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* sin almacenamiento */ }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useAccessTheme() {
  const [theme, setTheme] = useState(initialAccessTheme);
  useEffect(() => {
    try { window.localStorage.setItem(ACCESS_THEME_KEY, theme); } catch { /* sin almacenamiento */ }
  }, [theme]);
  return [theme, setTheme];
}
