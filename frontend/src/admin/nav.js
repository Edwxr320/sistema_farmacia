/**
 * Navegación del panel. any = basta uno de los permisos; all = se requieren todos.
 * Solo controla la visibilidad: el backend valida cada operación.
 */
export const NAV = [
  { group: 'General', items: [
    { route: 'dashboard', label: 'Dashboard', icon: 'dashboard', any: ['reports.view'] },
  ] },
  { group: 'Ventas', items: [
    { route: 'pos', label: 'Punto de venta', icon: 'pos', all: ['sales.create', 'payments.register'] },
    { route: 'cash', label: 'Caja', icon: 'cash', any: ['cash.open', 'cash.close', 'cash.movements', 'cash.view_all'] },
    { route: 'sales', label: 'Ventas', icon: 'receipt', any: ['sales.view'] },
    { route: 'returns', label: 'Devoluciones', icon: 'undo', any: ['returns.create', 'returns.approve'] },
    { route: 'orders', label: 'Pedidos online', icon: 'cart', any: ['orders.view'], badge: 'orders' },
  ] },
  { group: 'Inventario', items: [
    { route: 'stock', label: 'Stock', icon: 'box', any: ['inventory.view'] },
    { route: 'batches', label: 'Lotes y vencimientos', icon: 'layers', any: ['inventory.view'] },
    { route: 'entries', label: 'Entradas', icon: 'inbox', any: ['inventory.view', 'inventory.entries'] },
    { route: 'adjustments', label: 'Ajustes y bajas', icon: 'sliders', any: ['inventory.adjust', 'inventory.write_off', 'inventory.view'] },
    { route: 'transfers', label: 'Transferencias', icon: 'swap', any: ['inventory.transfers', 'inventory.receive_transfers'] },
    { route: 'kardex', label: 'Kardex', icon: 'history', any: ['inventory.view'] },
    { route: 'alerts', label: 'Alertas', icon: 'bell', any: ['alerts.view'], badge: 'alerts' },
  ] },
  { group: 'Catálogo', items: [
    { route: 'products', label: 'Productos', icon: 'pill', any: ['products.view'] },
    { route: 'categories', label: 'Categorías', icon: 'tag', any: ['products.view'] },
    { route: 'laboratories', label: 'Laboratorios', icon: 'layers', any: ['products.view'] },
    { route: 'suppliers', label: 'Proveedores', icon: 'truck', any: ['suppliers.view'] },
  ] },
  { group: 'Administración', items: [
    { route: 'customers', label: 'Clientes', icon: 'users', any: ['customers.view'] },
    { route: 'users', label: 'Trabajadores', icon: 'user', any: ['users.view'] },
    { route: 'roles', label: 'Roles y permisos', icon: 'shield', any: ['roles.manage'] },
    { route: 'branches', label: 'Sucursales', icon: 'store', any: ['branches.manage'] },
    { route: 'reports', label: 'Reportes', icon: 'chart', any: ['reports.view'] },
    { route: 'settings', label: 'Configuración', icon: 'settings', any: ['settings.manage'] },
  ] },
];
