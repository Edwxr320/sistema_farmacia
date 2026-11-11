-- ============================================================================
-- PHARMA PLUS - VALIDACIÓN DE LA BASE DE DATOS EN MARIADB 10.11 (solo lectura)
-- ----------------------------------------------------------------------------
-- Ejecutar después de importar pharma_plus_mariadb_10_11.sql.
-- No crea, modifica ni elimina datos de la base (solo tablas TEMPORARY de la
-- propia sesión, que desaparecen al cerrar la conexión).
--
-- En phpMyAdmin use la pestaña SQL (pegue el contenido de este archivo y pulse
-- Continuar/Go): se muestran todos los resultados y el ÚLTIMO es el RESUMEN, cuyas
-- filas deben decir PASS. La pestaña Importar también lo ejecuta, pero no
-- muestra resultados de SELECT.
-- Todos los objetos se escriben como pharma_plus.<objeto> porque la pestaña SQL
-- de phpMyAdmin cambia la base activa tras consultar information_schema.
-- ============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET SESSION group_concat_max_len = 1000000;

-- ---------------------------------------------------------------------------
-- 1. Servidor y base de datos
-- ---------------------------------------------------------------------------
SELECT VERSION() AS version_servidor,
       @@sql_mode AS sql_mode_sesion,
       (SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'pharma_plus') AS base_existe,
       (SELECT default_character_set_name FROM information_schema.schemata WHERE schema_name = 'pharma_plus') AS charset,
       (SELECT default_collation_name FROM information_schema.schemata WHERE schema_name = 'pharma_plus') AS collation_base;

USE pharma_plus;

-- ---------------------------------------------------------------------------
-- Listas esperadas
-- ---------------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS pharma_plus.tmp_expected_tables;
CREATE TEMPORARY TABLE pharma_plus.tmp_expected_tables (name VARCHAR(64) PRIMARY KEY)
  ENGINE=MEMORY DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO pharma_plus.tmp_expected_tables (name) VALUES
 ('roles'),('permissions'),('role_permissions'),('branches'),('users'),('user_permissions'),('user_branches'),
 ('settings'),('document_sequences'),('customers'),('customer_addresses'),('categories'),('laboratories'),
 ('products'),('branch_products'),('suppliers'),('stock_entries'),('product_batches'),('stock_entry_items'),
 ('inventory_adjustments'),('cash_registers'),('cash_sessions'),('carts'),('cart_items'),('orders'),
 ('order_items'),('order_status_history'),('sales'),('sale_items'),('sale_item_batches'),('payments'),
 ('sale_tickets'),('sale_voids'),('return_reasons'),('sale_returns'),('sale_return_items'),('cash_movements'),
 ('branch_transfers'),('branch_transfer_items'),('inventory_movements'),('stock_alerts'),('audit_logs');

DROP TEMPORARY TABLE IF EXISTS pharma_plus.tmp_expected_views;
CREATE TEMPORARY TABLE pharma_plus.tmp_expected_views (name VARCHAR(64) PRIMARY KEY)
  ENGINE=MEMORY DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO pharma_plus.tmp_expected_views (name) VALUES
 ('vw_branch_product_stock'),('vw_products_low_stock'),('vw_consolidated_stock'),('vw_batch_expiry_status'),
 ('vw_fefo_batches'),('vw_product_prices_by_branch'),('vw_daily_sales'),('vw_sales_by_product'),
 ('vw_sale_payment_summary'),('vw_payment_history'),('vw_sale_ticket_header'),('vw_sale_ticket_lines'),
 ('vw_cash_session_summary'),('vw_user_effective_permissions'),('vw_open_stock_alerts'),('vw_kardex'),
 ('vw_integrity_issues');

DROP TEMPORARY TABLE IF EXISTS pharma_plus.tmp_expected_triggers;
CREATE TEMPORARY TABLE pharma_plus.tmp_expected_triggers (name VARCHAR(64) PRIMARY KEY)
  ENGINE=MEMORY DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO pharma_plus.tmp_expected_triggers (name) VALUES
 ('trg_audit_logs_bd'), ('trg_audit_logs_bu'), ('trg_branches_ai'), ('trg_branches_bd'),
 ('trg_branch_products_au'), ('trg_branch_transfers_bd'), ('trg_branch_transfers_bi'), ('trg_branch_transfers_bu'),
 ('trg_branch_transfer_items_bd'), ('trg_branch_transfer_items_bi'), ('trg_branch_transfer_items_bu'), ('trg_cash_movements_bd'),
 ('trg_cash_movements_bi'), ('trg_cash_movements_bu'), ('trg_cash_sessions_bd'), ('trg_cash_sessions_bi'),
 ('trg_cash_sessions_bu'), ('trg_inventory_movements_ai'), ('trg_inventory_movements_bd'), ('trg_inventory_movements_bi'),
 ('trg_inventory_movements_bu'), ('trg_orders_ai'), ('trg_orders_au'), ('trg_orders_bd'),
 ('trg_orders_bi'), ('trg_orders_bu'), ('trg_order_items_bd'), ('trg_order_items_bi'),
 ('trg_order_items_bu'), ('trg_order_status_history_bd'), ('trg_order_status_history_bu'), ('trg_payments_ai'),
 ('trg_payments_au'), ('trg_payments_bd'), ('trg_payments_bi'), ('trg_payments_bu'),
 ('trg_products_au'), ('trg_products_bd'), ('trg_product_batches_bi'), ('trg_product_batches_bu'),
 ('trg_role_permissions_ad'), ('trg_role_permissions_ai'), ('trg_sales_bd'), ('trg_sales_bi'),
 ('trg_sales_bu'), ('trg_sale_items_bd'), ('trg_sale_items_bi'), ('trg_sale_items_bu'),
 ('trg_sale_item_batches_bd'), ('trg_sale_item_batches_bi'), ('trg_sale_item_batches_bu'), ('trg_sale_returns_au'),
 ('trg_sale_returns_bd'), ('trg_sale_returns_bi'), ('trg_sale_returns_bu'), ('trg_sale_return_items_bd'),
 ('trg_sale_return_items_bi'), ('trg_sale_return_items_bu'), ('trg_sale_tickets_bd'), ('trg_sale_tickets_bi'),
 ('trg_sale_voids_ai'), ('trg_sale_voids_bd'), ('trg_sale_voids_bi'), ('trg_sale_voids_bu'),
 ('trg_settings_au'), ('trg_stock_alerts_bd'), ('trg_stock_entries_bd'), ('trg_stock_entries_bu'),
 ('trg_stock_entry_items_bd'), ('trg_stock_entry_items_bi'), ('trg_stock_entry_items_bu'), ('trg_users_ai'),
 ('trg_users_au'), ('trg_users_bd'), ('trg_user_permissions_ad'), ('trg_user_permissions_ai'),
 ('trg_user_permissions_au');

DROP TEMPORARY TABLE IF EXISTS pharma_plus.tmp_expected_routines;
CREATE TEMPORARY TABLE pharma_plus.tmp_expected_routines (name VARCHAR(64) PRIMARY KEY)
  ENGINE=MEMORY DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO pharma_plus.tmp_expected_routines (name) VALUES
 ('sp_audit'), ('sp_next_document_number'), ('sp_refresh_expiry_alerts'), ('sp_set_app_context');

-- ---------------------------------------------------------------------------
-- 2. Tablas faltantes y tablas que no son InnoDB / utf8mb4_unicode_ci (0 filas)
-- ---------------------------------------------------------------------------
SELECT e.name AS tabla_faltante
  FROM pharma_plus.tmp_expected_tables e
  LEFT JOIN information_schema.tables t
         ON t.table_schema = 'pharma_plus' AND t.table_name = e.name AND t.table_type = 'BASE TABLE'
 WHERE t.table_name IS NULL;

SELECT table_name AS tabla_con_configuracion_distinta, engine, table_collation
  FROM information_schema.tables
 WHERE table_schema = 'pharma_plus' AND table_type = 'BASE TABLE'
   AND (engine <> 'InnoDB' OR table_collation <> 'utf8mb4_unicode_ci');

-- ---------------------------------------------------------------------------
-- 3. Relaciones (claves foráneas)
-- ---------------------------------------------------------------------------
SELECT rc.table_name AS tabla, rc.constraint_name AS fk, rc.referenced_table_name AS referencia,
       rc.update_rule, rc.delete_rule
  FROM information_schema.referential_constraints rc
 WHERE rc.constraint_schema = 'pharma_plus'
 ORDER BY rc.table_name, rc.constraint_name
 LIMIT 500;

-- ---------------------------------------------------------------------------
-- 4. Vistas faltantes (0 filas) y ejecución de cada vista
-- ---------------------------------------------------------------------------
SELECT e.name AS vista_faltante
  FROM pharma_plus.tmp_expected_views e
  LEFT JOIN information_schema.views v ON v.table_schema = 'pharma_plus' AND v.table_name = e.name
 WHERE v.table_name IS NULL;

SELECT 'vw_branch_product_stock' AS vista, COUNT(*) AS filas FROM pharma_plus.vw_branch_product_stock
UNION ALL SELECT 'vw_products_low_stock', COUNT(*) FROM pharma_plus.vw_products_low_stock
UNION ALL SELECT 'vw_consolidated_stock', COUNT(*) FROM pharma_plus.vw_consolidated_stock
UNION ALL SELECT 'vw_batch_expiry_status', COUNT(*) FROM pharma_plus.vw_batch_expiry_status
UNION ALL SELECT 'vw_fefo_batches', COUNT(*) FROM pharma_plus.vw_fefo_batches
UNION ALL SELECT 'vw_product_prices_by_branch', COUNT(*) FROM pharma_plus.vw_product_prices_by_branch
UNION ALL SELECT 'vw_daily_sales', COUNT(*) FROM pharma_plus.vw_daily_sales
UNION ALL SELECT 'vw_sales_by_product', COUNT(*) FROM pharma_plus.vw_sales_by_product
UNION ALL SELECT 'vw_sale_payment_summary', COUNT(*) FROM pharma_plus.vw_sale_payment_summary
UNION ALL SELECT 'vw_payment_history', COUNT(*) FROM pharma_plus.vw_payment_history
UNION ALL SELECT 'vw_sale_ticket_header', COUNT(*) FROM pharma_plus.vw_sale_ticket_header
UNION ALL SELECT 'vw_sale_ticket_lines', COUNT(*) FROM pharma_plus.vw_sale_ticket_lines
UNION ALL SELECT 'vw_cash_session_summary', COUNT(*) FROM pharma_plus.vw_cash_session_summary
UNION ALL SELECT 'vw_user_effective_permissions', COUNT(*) FROM pharma_plus.vw_user_effective_permissions
UNION ALL SELECT 'vw_open_stock_alerts', COUNT(*) FROM pharma_plus.vw_open_stock_alerts
UNION ALL SELECT 'vw_kardex', COUNT(*) FROM pharma_plus.vw_kardex
UNION ALL SELECT 'vw_integrity_issues', COUNT(*) FROM pharma_plus.vw_integrity_issues
LIMIT 100;

-- ---------------------------------------------------------------------------
-- 5. Triggers y procedimientos: faltantes (0 filas) y modo SQL con el que se crearon
-- ---------------------------------------------------------------------------
SELECT e.name AS trigger_faltante
  FROM pharma_plus.tmp_expected_triggers e
  LEFT JOIN information_schema.triggers t ON t.trigger_schema = 'pharma_plus' AND t.trigger_name = e.name
 WHERE t.trigger_name IS NULL;

SELECT e.name AS procedimiento_faltante
  FROM pharma_plus.tmp_expected_routines e
  LEFT JOIN information_schema.routines r
         ON r.routine_schema = 'pharma_plus' AND r.routine_name = e.name AND r.routine_type = 'PROCEDURE'
 WHERE r.routine_name IS NULL;

SELECT event_object_table AS tabla, trigger_name, action_timing, event_manipulation, sql_mode
  FROM information_schema.triggers WHERE trigger_schema = 'pharma_plus'
 ORDER BY event_object_table, trigger_name
 LIMIT 500;

-- ---------------------------------------------------------------------------
-- 6. Restricciones CHECK (82 de tabla + 2 json_valid automáticos de MariaDB)
-- ---------------------------------------------------------------------------
SELECT table_name, constraint_name, level, check_clause
  FROM information_schema.check_constraints
 WHERE constraint_schema = 'pharma_plus'
 ORDER BY table_name, constraint_name
 LIMIT 500;

-- ---------------------------------------------------------------------------
-- 7. Datos iniciales
-- ---------------------------------------------------------------------------
SELECT id, code, name, is_main, status FROM pharma_plus.branches WHERE is_main = TRUE;
SELECT document_type, prefix, next_number FROM pharma_plus.document_sequences
 WHERE branch_id = (SELECT id FROM pharma_plus.branches WHERE code = 'SP01') ORDER BY document_type;
SELECT id, name, is_active FROM pharma_plus.categories ORDER BY id;
SELECT r.code AS rol, COUNT(rp.permission_id) AS permisos
  FROM pharma_plus.roles r LEFT JOIN pharma_plus.role_permissions rp ON rp.role_id = r.id GROUP BY r.code ORDER BY r.code;
SELECT setting_key, setting_value, value_type FROM pharma_plus.settings ORDER BY setting_key LIMIT 500;

-- ---------------------------------------------------------------------------
-- 8. Relaciones huérfanas (consulta generada sobre TODAS las FK) e integridad
-- ---------------------------------------------------------------------------
SET @orphan_sql = (
  SELECT CONCAT('SELECT tabla, columna, huerfanos FROM (',
         GROUP_CONCAT(CONCAT(
           'SELECT ''', k.table_name, ''' AS tabla, ''', k.column_name, ''' AS columna, COUNT(*) AS huerfanos ',
           'FROM `pharma_plus`.`', k.table_name, '` ch WHERE ch.`', k.column_name, '` IS NOT NULL ',
           'AND NOT EXISTS (SELECT 1 FROM `pharma_plus`.`', k.referenced_table_name, '` p WHERE p.`',
           k.referenced_column_name, '` = ch.`', k.column_name, '`)')
           SEPARATOR ' UNION ALL '), ') t WHERE huerfanos > 0')
    FROM information_schema.key_column_usage k
   WHERE k.table_schema = 'pharma_plus' AND k.referenced_table_name IS NOT NULL);
PREPARE orphan_stmt FROM @orphan_sql;
EXECUTE orphan_stmt;      -- debe devolver 0 filas
DEALLOCATE PREPARE orphan_stmt;

SET @orphan_total_sql = REPLACE(REPLACE(@orphan_sql, 'SELECT tabla, columna, huerfanos FROM (',
                                        'SELECT COALESCE(SUM(huerfanos),0) INTO @orphans FROM ('),
                                ') t WHERE huerfanos > 0', ') t');
PREPARE orphan_total FROM @orphan_total_sql;
EXECUTE orphan_total;
DEALLOCATE PREPARE orphan_total;

SELECT * FROM pharma_plus.vw_integrity_issues LIMIT 500;   -- debe devolver 0 filas

-- ---------------------------------------------------------------------------
-- 9. RESUMEN (última consulta)
-- ---------------------------------------------------------------------------
SELECT verificacion, esperado, obtenido, IF(esperado = obtenido, 'PASS', 'FAIL') AS resultado FROM (
  SELECT 01 AS n, 'Servidor MariaDB 10.11' AS verificacion, '1' AS esperado,
         CAST((VERSION() LIKE '10.11.%MariaDB%') AS CHAR) AS obtenido
  UNION ALL SELECT 02, 'Base de datos pharma_plus existe', '1',
         CAST((SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'pharma_plus') AS CHAR)
  UNION ALL SELECT 03, 'Charset / collation de la base', 'utf8mb4 / utf8mb4_unicode_ci',
         (SELECT CONCAT(default_character_set_name, ' / ', default_collation_name)
            FROM information_schema.schemata WHERE schema_name = 'pharma_plus')
  UNION ALL SELECT 04, 'Tablas esperadas presentes', '42',
         CAST((SELECT COUNT(*) FROM pharma_plus.tmp_expected_tables e JOIN information_schema.tables t
                ON t.table_schema = 'pharma_plus' AND t.table_name = e.name AND t.table_type = 'BASE TABLE') AS CHAR)
  UNION ALL SELECT 05, 'Total de tablas', '42',
         CAST((SELECT COUNT(*) FROM information_schema.tables
                WHERE table_schema = 'pharma_plus' AND table_type = 'BASE TABLE') AS CHAR)
  UNION ALL SELECT 06, 'Tablas InnoDB con utf8mb4_unicode_ci', '42',
         CAST((SELECT COUNT(*) FROM information_schema.tables
                WHERE table_schema = 'pharma_plus' AND table_type = 'BASE TABLE'
                  AND engine = 'InnoDB' AND table_collation = 'utf8mb4_unicode_ci') AS CHAR)
  UNION ALL SELECT 07, 'Claves foráneas (relaciones)', '103',
         CAST((SELECT COUNT(*) FROM information_schema.referential_constraints
                WHERE constraint_schema = 'pharma_plus') AS CHAR)
  UNION ALL SELECT 08, 'Restricciones CHECK de tabla (del modelo)', '82',
         CAST((SELECT COUNT(*) FROM information_schema.check_constraints
                WHERE constraint_schema = 'pharma_plus' AND level = 'Table') AS CHAR)
  UNION ALL SELECT 09, 'CHECK json_valid automáticos (columnas JSON)', '2',
         CAST((SELECT COUNT(*) FROM information_schema.check_constraints
                WHERE constraint_schema = 'pharma_plus' AND level = 'Column') AS CHAR)
  UNION ALL SELECT 10, 'Vistas esperadas presentes', '17',
         CAST((SELECT COUNT(*) FROM pharma_plus.tmp_expected_views e JOIN information_schema.views v
                ON v.table_schema = 'pharma_plus' AND v.table_name = e.name) AS CHAR)
  UNION ALL SELECT 11, 'Triggers esperados presentes', '77',
         CAST((SELECT COUNT(*) FROM pharma_plus.tmp_expected_triggers e JOIN information_schema.triggers t
                ON t.trigger_schema = 'pharma_plus' AND t.trigger_name = e.name) AS CHAR)
  UNION ALL SELECT 12, 'Total de triggers', '77',
         CAST((SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = 'pharma_plus') AS CHAR)
  UNION ALL SELECT 13, 'Triggers creados en modo estricto', '77',
         CAST((SELECT COUNT(*) FROM information_schema.triggers
                WHERE trigger_schema = 'pharma_plus' AND FIND_IN_SET('STRICT_TRANS_TABLES', sql_mode) > 0) AS CHAR)
  UNION ALL SELECT 14, 'Procedimientos esperados presentes', '4',
         CAST((SELECT COUNT(*) FROM pharma_plus.tmp_expected_routines e JOIN information_schema.routines r
                ON r.routine_schema = 'pharma_plus' AND r.routine_name = e.name AND r.routine_type = 'PROCEDURE') AS CHAR)
  UNION ALL SELECT 15, 'Procedimientos en modo estricto', '4',
         CAST((SELECT COUNT(*) FROM information_schema.routines
                WHERE routine_schema = 'pharma_plus' AND routine_type = 'PROCEDURE'
                  AND FIND_IN_SET('STRICT_TRANS_TABLES', sql_mode) > 0) AS CHAR)
  UNION ALL SELECT 16, 'REGEXP distingue mayúsculas con (?-i)', '0',
         CAST(('cajero' REGEXP '(?-i)^[A-Z][A-Z0-9_]*$') AS CHAR)
  UNION ALL SELECT 17, 'Sucursal Principal registrada (única principal)', '1',
         CAST((SELECT COUNT(*) FROM pharma_plus.branches WHERE is_main = TRUE AND name = 'Sucursal Principal') AS CHAR)
  UNION ALL SELECT 18, 'Secuencias de documentos de la principal', '9',
         CAST((SELECT COUNT(*) FROM pharma_plus.document_sequences ds JOIN pharma_plus.branches b ON b.id = ds.branch_id
                WHERE b.is_main = TRUE) AS CHAR)
  UNION ALL SELECT 19, 'Caja inicial CAJA01', '1',
         CAST((SELECT COUNT(*) FROM pharma_plus.cash_registers WHERE code = 'CAJA01') AS CHAR)
  UNION ALL SELECT 20, 'Categorías del SQL original', '8',
         CAST((SELECT COUNT(*) FROM pharma_plus.categories WHERE name IN ('Cuidado de la piel','Alivio del dolor',
                'Gripe y resfrío','Vitaminas y suplementos','Cuidado personal','Higiene y protección',
                'Salud digestiva','Primeros auxilios')) AS CHAR)
  UNION ALL SELECT 21, 'Roles ADMIN/STAFF/CUSTOMER', '3',
         CAST((SELECT COUNT(*) FROM pharma_plus.roles WHERE code IN ('ADMIN','STAFF','CUSTOMER')) AS CHAR)
  UNION ALL SELECT 22, 'Catálogo de permisos (mínimo)', '48',
         CAST(LEAST((SELECT COUNT(*) FROM pharma_plus.permissions), 48) AS CHAR)
  UNION ALL SELECT 23, 'ADMIN tiene todos los permisos de gestión', '0',
         CAST((SELECT COUNT(*) FROM pharma_plus.permissions p WHERE p.module <> 'store' AND NOT EXISTS (
                SELECT 1 FROM pharma_plus.role_permissions rp JOIN pharma_plus.roles r ON r.id = rp.role_id
                 WHERE r.code = 'ADMIN' AND rp.permission_id = p.id)) AS CHAR)
  UNION ALL SELECT 24, 'Roles con permisos asignados', '3',
         CAST((SELECT COUNT(DISTINCT role_id) FROM pharma_plus.role_permissions) AS CHAR)
  UNION ALL SELECT 25, 'Moneda PEN', 'PEN',
         (SELECT setting_value FROM pharma_plus.settings WHERE setting_key = 'app.currency')
  UNION ALL SELECT 26, 'Zona horaria America/Lima', 'America/Lima',
         (SELECT setting_value FROM pharma_plus.settings WHERE setting_key = 'app.timezone')
  UNION ALL SELECT 27, 'Stock mínimo predeterminado', '20',
         (SELECT setting_value FROM pharma_plus.settings WHERE setting_key = 'inventory.default_minimum_stock')
  UNION ALL SELECT 28, 'Columnas FLOAT/DOUBLE (dinero)', '0',
         CAST((SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = 'pharma_plus' AND data_type IN ('float','double','real')) AS CHAR)
  UNION ALL SELECT 29, 'Registros huérfanos', '0', CAST(@orphans AS CHAR)
  UNION ALL SELECT 30, 'Problemas en vw_integrity_issues', '0',
         CAST((SELECT COUNT(*) FROM pharma_plus.vw_integrity_issues) AS CHAR)
) checks
ORDER BY n
LIMIT 100;
