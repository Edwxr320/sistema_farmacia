/**
 * Rutas del panel: ruta → [módulo de vista, componente exportado]. Cada ruta debe existir en NAV (nav.js).
 * Se usan con /admin/<ruta>; las vistas se cargan bajo demanda.
 */
export const ROUTES = {
  dashboard: ['dashboard', 'Dashboard'], pos: ['pos', 'Pos'], cash: ['cash', 'Cash'], sales: ['sales', 'Sales'],
  returns: ['returns', 'Returns'], orders: ['orders', 'Orders'], stock: ['inventory', 'Stock'], batches: ['inventory', 'Batches'],
  kardex: ['inventory', 'Kardex'], alerts: ['inventory', 'Alerts'], entries: ['entries', 'Entries'], adjustments: ['adjustments', 'Adjustments'],
  transfers: ['transfers', 'Transfers'], products: ['products', 'Products'], categories: ['catalogs', 'Categories'],
  laboratories: ['catalogs', 'Laboratories'], suppliers: ['catalogs', 'Suppliers'], customers: ['catalogs', 'Customers'],
  users: ['admin', 'Users'], roles: ['admin', 'Roles'], branches: ['admin', 'Branches'], settings: ['admin', 'Settings'],
  reports: ['reports', 'Reports'],
};
