import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

/** Puerto de la API Express (PORT del .env raíz, 3000 por defecto) para el proxy de desarrollo. */
function apiPort() {
  try {
    const env = fs.readFileSync(path.resolve(import.meta.dirname, '..', '.env'), 'utf8');
    const m = /^PORT\s*=\s*(\d+)/m.exec(env);
    if (m) return Number(m[1]);
  } catch { /* sin .env */ }
  return Number(process.env.PORT) || 3000;
}
const target = `http://localhost:${apiPort()}`;

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    // En desarrollo Vite sirve React y reenvía la API, las imágenes subidas y Socket.IO a Express (mismas cookies).
    proxy: {
      '/api': { target, changeOrigin: false },
      '/uploads': { target, changeOrigin: false },
      '/socket.io': { target, ws: true, changeOrigin: false },
    },
  },
});
