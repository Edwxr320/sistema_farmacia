-- ============================================================================
-- PHARMA PLUS - VALIDACIÓN DE LA BASE DE DATOS (solo lectura)
-- ----------------------------------------------------------------------------
-- Ejecutar después de importar pharma_plus_mysql8.sql.
-- No crea, modifica ni elimina datos. Devuelve un resumen PASS/FAIL y detalles.
-- ============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET SESSION group_concat_max_len = 1000000;

-- ---------------------------------------------------------------------------
-- 0. Versión del servidor y existencia de la base de datos
-- ---------------------------------------------------------------------------
SELECT VERSION() AS mysql_version,
       (SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'pharma_plus') AS base_existe,
       (SELECT default_character_set_name FROM information_schema.schemata WHERE schema_name = 'pharma_plus') AS charset,
       (SELECT default_collation_name FROM information_schema.schemata WHERE schema_name = 'pharma_plus') AS collation;

USE pharma_plus;

-- ---------------------------------------------------------------------------
-- 1. Listas esperadas
-- ---------------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS tmp_expected_tables;
CREATE TEMPORARY TABLE tmp_expected_tables (name VARCHAR(64) PRIMARY KEY) ENGINE=MEMORY DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO tmp_expected_tables (name) VALUES
 ('roles'),('permissions'),('role_permissions'),('branches'),('users'),('user_permissions'),('user_branches'),
 ('settings'),('document_sequences'),('customers'),('customer_addresses'),('categories'),('laboratories'),
 ('products'),('branch_products'),('suppliers'),('stock_entries'),('product_batches'),('stock_entry_items'),
 ('inventory_adjustments'),('cash_registers'),('cash_sessions'),('carts'),('cart_items'),('orders'),
 ('order_items'),('order_status_history'),('sales'),('sale_items'),('sale_item_batches'),('payments'),
 ('sale_tickets'),('sale_voids'),('return_reasons'),('sale_returns'),('sale_return_items'),('cash_movements'),
 ('branch_transfers'),('branch_transfer_items'),('inventory_movements'),('stock_alerts'),('audit_logs');

DROP TEMPORARY TABLE IF EXISTS tmp_expected_views;
CREATE TEMPORARY TABLE tmp_expected_views (name VARCHAR(64) PRIMARY KEY) ENGINE=MEMORY DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO tmp_expected_views (name) VALUES
 ('vw_branch_product_stock'),('vw_products_low_stock'),('vw_consolidated_stock'),('vw_batch_expiry_status'),
 ('vw_fefo_batches'),('vw_product_prices_by_branch'),('vw_daily_sales'),('vw_sales_by_product'),
 ('vw_sale_payment_summary'),('vw_payment_history'),('vw_sale_ticket_header'),('vw_sale_ticket_lines'),
 ('vw_cash_session_summary'),('vw_user_effective_permissions'),('vw_open_stock_alerts'),('vw_kardex'),
 ('vw_integrity_issues');

-- ---------------------------------------------------------------------------
-- 2. Tablas faltantes / tablas que no son InnoDB (ambas deben devolver 0 filas)
-- ---------------------------------------------------------------------------
SELECT e.name AS tabla_faltante
  FROM tmp_expected_tables e
  LEFT JOIN information_schema.tables t
         ON t.table_schema = 'pharma_plus' AND t.table_name = e.name AND t.table_type = 'BASE TABLE'
 WHERE t.table_name IS NULL;

SELECT table_name AS tabla_no_innodb, engine
  FROM information_schema.tables
 WHERE table_schema = 'pharma_plus' AND table_type = 'BASE TABLE' AND engine <> 'InnoDB';

-- ---------------------------------------------------------------------------
-- 3. Relaciones (claves foráneas) por tabla
-- ---------------------------------------------------------------------------
SELECT rc.table_name AS tabla, rc.constraint_name AS fk, rc.referenced_table_name AS referencia,
       rc.update_rule, rc.delete_rule
  FROM information_schema.referential_constraints rc
 WHERE rc.constraint_schema = 'pharma_plus'
 ORDER BY rc.table_name, rc.constraint_name;

-- ---------------------------------------------------------------------------
-- 4. Vistas faltantes (debe devolver 0 filas) y prueba de ejecución de cada vista
-- ---------------------------------------------------------------------------
SELECT e.name AS vista_faltante
  FROM tmp_expected_views e
  LEFT JOIN information_schema.views v ON v.table_schema = 'pharma_plus' AND v.table_name = e.name
 WHERE v.table_name IS NULL;

SELECT 'vw_branch_product_stock' AS vista, COUNT(*) AS filas FROM vw_branch_product_stock
UNION ALL SELECT 'vw_products_low_stock', COUNT(*) FROM vw_products_low_stock
UNION ALL SELECT 'vw_consolidated_stock', COUNT(*) FROM vw_consolidated_stock
UNION ALL SELECT 'vw_batch_expiry_status', COUNT(*) FROM vw_batch_expiry_status
UNION ALL SELECT 'vw_fefo_batches', COUNT(*) FROM vw_fefo_batches
UNION ALL SELECT 'vw_product_prices_by_branch', COUNT(*) FROM vw_product_prices_by_branch
UNION ALL SELECT 'vw_daily_sales', COUNT(*) FROM vw_daily_sales
UNION ALL SELECT 'vw_sales_by_product', COUNT(*) FROM vw_sales_by_product
UNION ALL SELECT 'vw_sale_payment_summary', COUNT(*) FROM vw_sale_payment_summary
UNION ALL SELECT 'vw_payment_history', COUNT(*) FROM vw_payment_history
UNION ALL SELECT 'vw_sale_ticket_header', COUNT(*) FROM vw_sale_ticket_header
UNION ALL SELECT 'vw_sale_ticket_lines', COUNT(*) FROM vw_sale_ticket_lines
UNION ALL SELECT 'vw_cash_session_summary', COUNT(*) FROM vw_cash_session_summary
UNION ALL SELECT 'vw_user_effective_permissions', COUNT(*) FROM vw_user_effective_permissions
UNION ALL SELECT 'vw_open_stock_alerts', COUNT(*) FROM vw_open_stock_alerts
UNION ALL SELECT 'vw_kardex', COUNT(*) FROM vw_kardex
UNION ALL SELECT 'vw_integrity_issues', COUNT(*) FROM vw_integrity_issues;

-- ---------------------------------------------------------------------------
-- 5. Datos iniciales
-- ---------------------------------------------------------------------------
SELECT id, code, name, is_main, status FROM branches WHERE is_main = TRUE;
SELECT document_type, prefix, next_number FROM document_sequences
 WHERE branch_id = (SELECT id FROM branches WHERE code = 'SP01') ORDER BY document_type;
SELECT id, name, is_active FROM categories ORDER BY id;
SELECT r.code AS rol, COUNT(rp.permission_id) AS permisos
  FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.code ORDER BY r.code;
SELECT setting_key, setting_value, value_type FROM settings ORDER BY setting_key;

-- ---------------------------------------------------------------------------
-- 6. Relaciones huérfanas (consulta generada sobre TODAS las FK)
-- ---------------------------------------------------------------------------
SET @orphan_sql = (
  SELECT CONCAT('SELECT tabla, columna, huerfanos FROM (',
         GROUP_CONCAT(CONCAT(
           'SELECT ''', k.table_name, ''' AS tabla, ''', k.column_name, ''' AS columna, COUNT(*) AS huerfanos ',
           'FROM `', k.table_name, '` ch WHERE ch.`', k.column_name, '` IS NOT NULL ',
           'AND NOT EXISTS (SELECT 1 FROM `', k.referenced_table_name, '` p WHERE p.`',
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

-- Inconsistencias de negocio detectadas por la vista de control (debe devolver 0 filas)
SELECT * FROM vw_integrity_issues;

-- ---------------------------------------------------------------------------
-- 7. RESUMEN
-- ---------------------------------------------------------------------------
SELECT verificacion, esperado, obtenido, IF(esperado = obtenido, 'PASS', 'FAIL') AS resultado FROM (
  SELECT 'Base de datos pharma_plus existe' AS verificacion, '1' AS esperado,
         CAST((SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'pharma_plus') AS CHAR) AS obtenido
  UNION ALL SELECT 'Charset utf8mb4', 'utf8mb4',
         (SELECT default_character_set_name FROM information_schema.schemata WHERE schema_name = 'pharma_plus')
  UNION ALL SELECT 'Tablas esperadas presentes', '42',
         CAST((SELECT COUNT(*) FROM tmp_expected_tables e JOIN information_schema.tables t
                ON t.table_schema = 'pharma_plus' AND t.table_name = e.name AND t.table_type = 'BASE TABLE') AS CHAR)
  UNION ALL SELECT 'Total de tablas', '42',
         CAST((SELECT COUNT(*) FROM information_schema.tables
                WHERE table_schema = 'pharma_plus' AND table_type = 'BASE TABLE') AS CHAR)
  UNION ALL SELECT 'Todas las tablas son InnoDB', '0',
         CAST((SELECT COUNT(*) FROM information_schema.tables
                WHERE table_schema = 'pharma_plus' AND table_type = 'BASE TABLE' AND engine <> 'InnoDB') AS CHAR)
  UNION ALL SELECT 'Claves foráneas (relaciones)', '103',
         CAST((SELECT COUNT(*) FROM information_schema.referential_constraints
                WHERE constraint_schema = 'pharma_plus') AS CHAR)
  UNION ALL SELECT 'Restricciones CHECK', '82',
         CAST((SELECT COUNT(*) FROM information_schema.check_constraints
                WHERE constraint_schema = 'pharma_plus') AS CHAR)
  UNION ALL SELECT 'Vistas esperadas presentes', '17',
         CAST((SELECT COUNT(*) FROM tmp_expected_views e JOIN information_schema.views v
                ON v.table_schema = 'pharma_plus' AND v.table_name = e.name) AS CHAR)
  UNION ALL SELECT 'Triggers', '77',
         CAST((SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = 'pharma_plus') AS CHAR)
  UNION ALL SELECT 'Procedimientos almacenados', '4',
         CAST((SELECT COUNT(*) FROM information_schema.routines
                WHERE routine_schema = 'pharma_plus' AND routine_type = 'PROCEDURE'
                  AND routine_name LIKE 'sp\\_%') AS CHAR)
  UNION ALL SELECT 'Sucursal Principal registrada (única principal)', '1',
         CAST((SELECT COUNT(*) FROM branches WHERE is_main = TRUE AND name = 'Sucursal Principal') AS CHAR)
  UNION ALL SELECT 'Secuencias de documentos de la principal', '9',
         CAST((SELECT COUNT(*) FROM document_sequences ds JOIN branches b ON b.id = ds.branch_id
                WHERE b.is_main = TRUE) AS CHAR)
  UNION ALL SELECT 'Categorías del SQL original', '8',
         CAST((SELECT COUNT(*) FROM categories WHERE name IN ('Cuidado de la piel','Alivio del dolor',
                'Gripe y resfrío','Vitaminas y suplementos','Cuidado personal','Higiene y protección',
                'Salud digestiva','Primeros auxilios')) AS CHAR)
  UNION ALL SELECT 'Roles ADMIN/STAFF/CUSTOMER', '3',
         CAST((SELECT COUNT(*) FROM roles WHERE code IN ('ADMIN','STAFF','CUSTOMER')) AS CHAR)
  UNION ALL SELECT 'Catálogo de permisos (mínimo)', '48',
         CAST(LEAST((SELECT COUNT(*) FROM permissions), 48) AS CHAR)
  UNION ALL SELECT 'ADMIN tiene todos los permisos de gestión', '0',
         CAST((SELECT COUNT(*) FROM permissions p WHERE p.module <> 'store' AND NOT EXISTS (
                SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
                 WHERE r.code = 'ADMIN' AND rp.permission_id = p.id)) AS CHAR)
  UNION ALL SELECT 'Roles con permisos asignados', '3',
         CAST((SELECT COUNT(DISTINCT role_id) FROM role_permissions) AS CHAR)
  UNION ALL SELECT 'Moneda PEN', 'PEN',
         (SELECT setting_value FROM settings WHERE setting_key = 'app.currency')
  UNION ALL SELECT 'Zona horaria America/Lima', 'America/Lima',
         (SELECT setting_value FROM settings WHERE setting_key = 'app.timezone')
  UNION ALL SELECT 'Stock mínimo predeterminado', '20',
         (SELECT setting_value FROM settings WHERE setting_key = 'inventory.default_minimum_stock')
  UNION ALL SELECT 'Columnas FLOAT/DOUBLE (dinero)', '0',
         CAST((SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = 'pharma_plus' AND data_type IN ('float','double','real')) AS CHAR)
  UNION ALL SELECT 'Registros huérfanos', '0', CAST(@orphans AS CHAR)
  UNION ALL SELECT 'Problemas en vw_integrity_issues', '0',
         CAST((SELECT COUNT(*) FROM vw_integrity_issues) AS CHAR)
) checks;

-- Informativo: en una base recién importada no existe ninguna cuenta (0 usuarios).
SELECT COUNT(*) AS usuarios_registrados,
       SUM(r.code = 'ADMIN') AS administradores
  FROM users u JOIN roles r ON r.id = u.role_id;

DROP TEMPORARY TABLE IF EXISTS tmp_expected_tables;
DROP TEMPORARY TABLE IF EXISTS tmp_expected_views;
