import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * Contexto del panel (equivalente al ctx del frontend anterior):
 * { api, user, perms, can, canAll, branchId, branches, myBranches, branchName, navigate, on, refreshBadges }
 */
export const AdminContext = createContext(null);

export function useAdmin() {
  return useContext(AdminContext);
}

/** Suscripción a un evento en tiempo real mientras la vista esté montada. */
export function useRealtime(event, handler) {
  const ctx = useAdmin();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => ctx.on(event, (p) => ref.current(p)), [ctx, event]);
}
