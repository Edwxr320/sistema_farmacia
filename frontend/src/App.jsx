import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { Spinner } from './components/ui.jsx';
import { ToastHost } from './components/toast.jsx';
import { accessUrl } from './core/redirect.js';

// Cada portal se descarga por separado (el cliente de la tienda no recibe el código del panel).
// Los modales se montan dentro de cada portal (<ModalHost/>) para que usen su contexto.
const AdminApp = lazy(() => import('./admin/AdminApp.jsx'));
const StoreApp = lazy(() => import('./store/StoreApp.jsx'));
const AccessPage = lazy(() => import('./access/AccessPage.jsx'));
const RegisterPage = lazy(() => import('./access/RegisterPage.jsx'));

/** Login antiguo de la tienda (/ingresar?next=...) → acceso único conservando la ruta de retorno. */
function LegacyLogin() {
  const [params] = useSearchParams();
  return <Navigate to={accessUrl(params.get('next') || '')} replace />;
}

export default function App() {
  return (
    <>
      <Suspense fallback={<Spinner label="Cargando Pharma Plus…" />}>
        <Routes>
          <Route path="/acceso" element={<AccessPage />} />
          <Route path="/registro" element={<RegisterPage />} />
          <Route path="/ingresar" element={<LegacyLogin />} />
          <Route path="/admin/*" element={<AdminApp />} />
          <Route path="/*" element={<StoreApp />} />
        </Routes>
      </Suspense>
      <ToastHost />
    </>
  );
}
