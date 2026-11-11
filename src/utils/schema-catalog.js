'use strict';

/**
 * Objetos que el backend espera encontrar en pharma_plus
 * (database/pharma_plus_mariadb_10_11.sql). Solo se usan para verificar
 * la instalación; el backend no crea ni modifica el esquema.
 */

const EXPECTED_TABLES = Object.freeze([
  'roles', 'permissions', 'role_permissions', 'branches', 'users', 'user_permissions',
  'user_branches', 'settings', 'document_sequences', 'customers', 'customer_addresses',
  'categories', 'laboratories', 'products', 'branch_products', 'suppliers', 'stock_entries',
  'product_batches', 'stock_entry_items', 'inventory_adjustments', 'cash_registers',
  'cash_sessions', 'carts', 'cart_items', 'orders', 'order_items', 'order_status_history',
  'sales', 'sale_items', 'sale_item_batches', 'payments', 'sale_tickets', 'sale_voids',
  'return_reasons', 'sale_returns', 'sale_return_items', 'cash_movements', 'branch_transfers',
  'branch_transfer_items', 'inventory_movements', 'stock_alerts', 'audit_logs',
]);

const EXPECTED_VIEWS = Object.freeze([
  'vw_branch_product_stock', 'vw_products_low_stock', 'vw_consolidated_stock',
  'vw_batch_expiry_status', 'vw_fefo_batches', 'vw_product_prices_by_branch', 'vw_daily_sales',
  'vw_sales_by_product', 'vw_sale_payment_summary', 'vw_payment_history', 'vw_sale_ticket_header',
  'vw_sale_ticket_lines', 'vw_cash_session_summary', 'vw_user_effective_permissions',
  'vw_open_stock_alerts', 'vw_kardex', 'vw_integrity_issues',
]);

const EXPECTED_PROCEDURES = Object.freeze([
  'sp_audit', 'sp_set_app_context', 'sp_next_document_number', 'sp_refresh_expiry_alerts',
]);

/** Tablas añadidas por migraciones posteriores (database/migrations). */
const EXPECTED_MIGRATIONS = Object.freeze([
  { id: '001', table: 'user_sessions', file: 'database/migrations/001_user_sessions.sql' },
]);

module.exports = { EXPECTED_TABLES, EXPECTED_VIEWS, EXPECTED_PROCEDURES, EXPECTED_MIGRATIONS };
