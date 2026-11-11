import { createContext, useContext, useEffect, useRef } from 'react';

/** Contexto de la tienda: sesión del cliente, sucursal, carrito y navegación. */
export const StoreContext = createContext(null);
export const useStore = () => useContext(StoreContext);

/** Suscripción a eventos en tiempo real del cliente mientras la vista esté montada. */
export function useStoreEvent(event, handler) {
  const ctx = useStore();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => ctx.on(event, (p) => ref.current(p)), [ctx, event]);
}
