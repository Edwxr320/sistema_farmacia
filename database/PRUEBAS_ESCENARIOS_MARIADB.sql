-- ============================================================================
-- PHARMA PLUS - PRUEBAS DE LOS 20 ESCENARIOS OBLIGATORIOS (MARIADB 10.11)
-- ----------------------------------------------------------------------------
-- Qué hace:
--   * Crea datos TEMPORALES de prueba dentro de UNA transacción.
--   * Verifica cada escenario (PASS/FAIL), incluidas operaciones que DEBEN fallar.
--   * Al final ejecuta ROLLBACK: no queda ningún registro de prueba.
--   * Crea 3 procedimientos auxiliares temporales (pp_test_check,
--     pp_test_expect_error y pp_run_scenarios) y los elimina al final.
--   * Todos los escenarios se ejecutan dentro de CALL pp_run_scenarios(): así el
--     archivo tiene menos de 50 sentencias y phpMyAdmin muestra la tabla de
--     resultados (con 50 o más sentencias, phpMyAdmin solo muestra "# Rows: N").
--
-- Cómo ejecutarlo en phpMyAdmin: pestaña SQL (pegue todo el contenido y pulse
-- Continuar/Go). Debajo de "CALL pp_run_scenarios()" aparece la tabla de
-- resultados: la primera fila es el RESUMEN (debe decir 0 FAIL) y la última,
-- CLEAN (no quedan datos de prueba). La pestaña Importar también lo ejecuta,
-- pero no muestra la tabla de resultados.
-- Recomendación: ejecútelo sobre la base recién importada o una copia.
-- Requiere MariaDB 10.11 (probado en MariaDB 10.11.14 y phpMyAdmin 5.2.1).
-- Nota: los AUTO_INCREMENT consumidos durante la prueba no se recuperan
-- (quedarán saltos en los id); es el comportamiento normal de InnoDB.
-- ============================================================================

USE pharma_plus;
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION';

SET time_zone = '-05:00';
SET SESSION group_concat_max_len = 1000000;

DROP PROCEDURE IF EXISTS pp_test_check;
DROP PROCEDURE IF EXISTS pp_test_expect_error;
DROP PROCEDURE IF EXISTS pp_run_scenarios;

DELIMITER $$
CREATE PROCEDURE pp_test_check(IN p_id VARCHAR(10), IN p_name VARCHAR(200), IN p_ok BOOLEAN, IN p_detail VARCHAR(500))
BEGIN
    INSERT INTO tmp_pp_results (test_id, test_name, result, detail)
    VALUES (p_id, p_name, IF(COALESCE(p_ok, FALSE), 'PASS', 'FAIL'), p_detail);
END$$

CREATE PROCEDURE pp_test_expect_error(IN p_id VARCHAR(10), IN p_name VARCHAR(200),
                                      IN p_sql VARCHAR(2000), IN p_fragment VARCHAR(200))
BEGIN
    DECLARE v_msg VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
    DECLARE v_tmp VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
    BEGIN
        -- MariaDB no admite GET STACKED DIAGNOSTICS: GET DIAGNOSTICS debe ser la
        -- PRIMERA sentencia del handler para leer el error que lo activó.
        GET DIAGNOSTICS CONDITION 1 v_tmp = MESSAGE_TEXT;
        IF v_msg IS NULL THEN SET v_msg = v_tmp; END IF;
    END;
    SET @pp_sql = p_sql;
    PREPARE pp_stmt FROM @pp_sql;
    EXECUTE pp_stmt;
    DEALLOCATE PREPARE pp_stmt;
    INSERT INTO tmp_pp_results (test_id, test_name, result, detail)
    VALUES (p_id, p_name,
            IF(v_msg IS NOT NULL AND v_msg LIKE CONCAT('%', p_fragment, '%'), 'PASS', 'FAIL'),
            CONCAT('Rechazado correctamente: ', COALESCE(v_msg, '(¡no se produjo ningún error!)')));
END$$

CREATE PROCEDURE pp_run_scenarios()
BEGIN
    DROP TEMPORARY TABLE IF EXISTS tmp_pp_results;
    CREATE TEMPORARY TABLE tmp_pp_results (
        seq        INT AUTO_INCREMENT PRIMARY KEY,
        test_id    VARCHAR(10),
        test_name  VARCHAR(200),
        result     VARCHAR(4),
        detail     VARCHAR(500)
    ) ENGINE=MEMORY DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;   -- no transaccional: conserva resultados tras el ROLLBACK

    START TRANSACTION;

    -- ---------------------------------------------------------------------------
    -- Contexto de prueba (usuarios ficticios, se descartan con ROLLBACK)
    -- ---------------------------------------------------------------------------
    SET @branch1   = (SELECT id FROM branches WHERE code = 'SP01');
    SET @register1 = (SELECT id FROM cash_registers WHERE branch_id = @branch1 AND code = 'CAJA01');
    SET @role_admin    = (SELECT id FROM roles WHERE code = 'ADMIN');
    SET @role_staff    = (SELECT id FROM roles WHERE code = 'STAFF');
    SET @role_customer = (SELECT id FROM roles WHERE code = 'CUSTOMER');
    SET @hash = CONCAT('$2b$12$', REPEAT('x', 53));   -- hash con formato bcrypt (no es una contraseña)

    INSERT INTO users (role_id, full_name, email, password_hash) VALUES (@role_admin, 'Admin de Prueba', 'admin.prueba@test.local', @hash);
    SET @u_admin = LAST_INSERT_ID();
    INSERT INTO users (role_id, full_name, email, password_hash) VALUES (@role_staff, 'Trabajador de Prueba', 'staff.prueba@test.local', @hash);
    SET @u_staff = LAST_INSERT_ID();
    INSERT INTO users (role_id, full_name, email, password_hash) VALUES (@role_customer, 'Cliente de Prueba', 'cliente.prueba@test.local', @hash);
    SET @u_cust = LAST_INSERT_ID();
    INSERT INTO user_branches (user_id, branch_id, is_default) VALUES (@u_admin, @branch1, TRUE), (@u_staff, @branch1, TRUE);
    SET @app_user_id = @u_admin;
    SET @app_request_id = 'test-run';

    -- ===========================================================================
    -- T01. Registrar un producto
    -- ===========================================================================
    SET @cat = (SELECT id FROM categories WHERE name = 'Alivio del dolor');
    INSERT INTO laboratories (name, country) VALUES ('Laboratorio de Prueba', 'Perú');
    SET @lab = LAST_INSERT_ID();
    INSERT INTO products (category_id, laboratory_id, sku, barcode, name, active_ingredient, concentration,
                          dosage_form, presentation, unit, purchase_price, sale_price)
    VALUES (@cat, @lab, 'TEST-PARA-500', '7750000000001', 'PRUEBA Paracetamol 500 mg', 'Paracetamol', '500 mg',
            'Tableta', 'Caja x 100 tabletas', 'tableta', 0.50, 1.50);
    SET @p1 = LAST_INSERT_ID();
    INSERT INTO products (category_id, laboratory_id, sku, name, active_ingredient, concentration, dosage_form,
                          presentation, unit, purchase_price, sale_price, requires_prescription)
    VALUES (@cat, @lab, 'TEST-AMOX-500', 'PRUEBA Amoxicilina 500 mg', 'Amoxicilina', '500 mg', 'Cápsula',
            'Caja x 100 cápsulas', 'cápsula', 0.80, 2.00, TRUE);
    SET @p2 = LAST_INSERT_ID();
    CALL pp_test_check('T01', 'Registrar un producto',
         (SELECT COUNT(*) FROM products WHERE id IN (@p1, @p2) AND status = 'ACTIVE') = 2,
         'Se registraron 2 productos (uno con receta) con principio activo, concentración y laboratorio');

    -- ===========================================================================
    -- T02. Registrar el mismo producto en distintas sucursales
    -- ===========================================================================
    INSERT INTO branches (code, name, status) VALUES ('SPTEST', 'Sucursal de Prueba', 'ACTIVE');
    SET @branch2 = LAST_INSERT_ID();
    INSERT INTO user_branches (user_id, branch_id) VALUES (@u_admin, @branch2), (@u_staff, @branch2);
    INSERT INTO branch_products (branch_id, product_id, minimum_stock) VALUES (@branch1, @p1, 20), (@branch1, @p2, 20);
    INSERT INTO branch_products (branch_id, product_id, minimum_stock, sale_price) VALUES (@branch2, @p1, 10, 1.80);
    CALL pp_test_check('T02', 'Mismo producto en distintas sucursales',
         (SELECT COUNT(*) FROM products WHERE sku = 'TEST-PARA-500') = 1
         AND (SELECT effective_price FROM vw_product_prices_by_branch WHERE branch_id = @branch1 AND product_id = @p1) = 1.50
         AND (SELECT effective_price FROM vw_product_prices_by_branch WHERE branch_id = @branch2 AND product_id = @p1) = 1.80
         AND (SELECT COUNT(*) FROM document_sequences WHERE branch_id = @branch2) = 9,
         'Catálogo único; precio general 1.50 y precio propio 1.80 en la sucursal 2; secuencias creadas');

    -- ===========================================================================
    -- T07 (+T03). Registrar una entrada de mercadería con varios lotes
    -- ===========================================================================
    INSERT INTO suppliers (business_name, ruc, contact_name) VALUES ('PROVEEDOR DE PRUEBA S.A.C.', '20999999991', 'Contacto Prueba');
    SET @sup = LAST_INSERT_ID();
    CALL sp_next_document_number(@branch1, 'STOCK_ENTRY', @num);
    INSERT INTO stock_entries (entry_number, branch_id, supplier_id, entry_type, reference_document_type,
                               reference_document_number, registered_by)
    VALUES (@num, @branch1, @sup, 'PURCHASE', 'FACTURA', 'F001-000123', @u_admin);
    SET @e1 = LAST_INSERT_ID();

    INSERT INTO product_batches (product_id, branch_id, batch_number, manufacturing_date, expiry_date, unit_cost, stock_entry_id)
    VALUES (@p1, @branch1, 'TL-A', CURDATE() - INTERVAL 30 DAY, CURDATE() + INTERVAL 400 DAY, 0.50, @e1);
    SET @bA = LAST_INSERT_ID();
    INSERT INTO product_batches (product_id, branch_id, batch_number, manufacturing_date, expiry_date, unit_cost, stock_entry_id)
    VALUES (@p1, @branch1, 'TL-B', CURDATE() - INTERVAL 300 DAY, CURDATE() + INTERVAL 45 DAY, 0.50, @e1);
    SET @bB = LAST_INSERT_ID();
    INSERT INTO product_batches (product_id, branch_id, batch_number, manufacturing_date, expiry_date, unit_cost, stock_entry_id)
    VALUES (@p1, @branch1, 'TL-C', CURDATE() - INTERVAL 100 DAY, CURDATE() + INTERVAL 200 DAY, 0.50, @e1);
    SET @bC = LAST_INSERT_ID();
    INSERT INTO product_batches (product_id, branch_id, batch_number, expiry_date, unit_cost, stock_entry_id)
    VALUES (@p2, @branch1, 'TX-1', CURDATE() + INTERVAL 300 DAY, 0.80, @e1);
    SET @bX = LAST_INSERT_ID();

    INSERT INTO stock_entry_items (stock_entry_id, product_id, batch_id, quantity, unit_cost) VALUES (@e1, @p1, @bA, 50, 0.50);
    SET @eiA = LAST_INSERT_ID();
    INSERT INTO stock_entry_items (stock_entry_id, product_id, batch_id, quantity, unit_cost) VALUES (@e1, @p1, @bB, 30, 0.50);
    SET @eiB = LAST_INSERT_ID();
    INSERT INTO stock_entry_items (stock_entry_id, product_id, batch_id, quantity, unit_cost) VALUES (@e1, @p1, @bC, 40, 0.50);
    SET @eiC = LAST_INSERT_ID();
    INSERT INTO stock_entry_items (stock_entry_id, product_id, batch_id, quantity, unit_cost) VALUES (@e1, @p2, @bX, 25, 0.80);
    SET @eiX = LAST_INSERT_ID();

    INSERT INTO inventory_movements (batch_id, movement_type, quantity, stock_entry_item_id, performed_by, reason) VALUES
      (@bA, 'PURCHASE_ENTRY', 50, @eiA, @u_admin, 'Compra F001-000123'),
      (@bB, 'PURCHASE_ENTRY', 30, @eiB, @u_admin, 'Compra F001-000123'),
      (@bC, 'PURCHASE_ENTRY', 40, @eiC, @u_admin, 'Compra F001-000123'),
      (@bX, 'PURCHASE_ENTRY', 25, @eiX, @u_admin, 'Compra F001-000123');
    UPDATE stock_entries SET status = 'POSTED' WHERE id = @e1;

    CALL pp_test_check('T07', 'Registrar una entrada de mercadería',
         (SELECT status = 'POSTED' AND total_cost = 80.00 AND posted_at IS NOT NULL FROM stock_entries WHERE id = @e1)
         AND (SELECT SUM(received_quantity) FROM product_batches WHERE stock_entry_id = @e1) = 145
         AND (SELECT COUNT(*) FROM inventory_movements im JOIN stock_entry_items sei ON sei.id = im.stock_entry_item_id
               WHERE sei.stock_entry_id = @e1) = 4,
         'Entrada contabilizada: 4 lotes, 145 unidades, costo total S/ 80.00 calculado por la BD');
    CALL pp_test_expect_error('T07b', 'Una línea de entrada no puede ingresar stock dos veces',
         "INSERT INTO inventory_movements (batch_id, movement_type, quantity, stock_entry_item_id, performed_by) VALUES (@bA,'PURCHASE_ENTRY',50,@eiA,@u_admin)",
         'PP:');

    -- ===========================================================================
    -- T03. Ingresar varios lotes del mismo medicamento
    -- ===========================================================================
    CALL pp_test_check('T03', 'Varios lotes del mismo medicamento',
         (SELECT COUNT(*) FROM product_batches WHERE product_id = @p1 AND branch_id = @branch1) = 3,
         'Paracetamol con lotes TL-A, TL-B y TL-C en la Sucursal Principal');

    -- ===========================================================================
    -- T04. Consultar existencias por sucursal
    -- ===========================================================================
    CALL pp_test_check('T04', 'Existencias por sucursal',
         (SELECT available_stock FROM vw_branch_product_stock WHERE branch_id = @branch1 AND product_id = @p1) = 120
         AND (SELECT available_stock FROM vw_branch_product_stock WHERE branch_id = @branch2 AND product_id = @p1) = 0
         AND (SELECT stock_status FROM vw_branch_product_stock WHERE branch_id = @branch2 AND product_id = @p1) = 'OUT_OF_STOCK',
         'Sucursal Principal: 120 disponibles; Sucursal de Prueba: 0 (OUT_OF_STOCK)');

    -- ===========================================================================
    -- T05. Lotes vencidos y próximos a vencer (+ baja de vencidos)
    -- ===========================================================================
    -- Se simula una recepción ocurrida hace 400 días de un lote que ya venció.
    SET TIMESTAMP = UNIX_TIMESTAMP(NOW() - INTERVAL 400 DAY);
    CALL sp_next_document_number(@branch1, 'STOCK_ENTRY', @num2);
    INSERT INTO stock_entries (entry_number, branch_id, entry_type, registered_by, notes)
    VALUES (@num2, @branch1, 'INITIAL_STOCK', @u_admin, 'Inventario inicial (prueba)');
    SET @e2 = LAST_INSERT_ID();
    INSERT INTO product_batches (product_id, branch_id, batch_number, expiry_date, unit_cost, stock_entry_id)
    VALUES (@p1, @branch1, 'TL-OLD', CURDATE() + INTERVAL 100 DAY, 0.45, @e2);
    SET @bOld = LAST_INSERT_ID();
    INSERT INTO stock_entry_items (stock_entry_id, product_id, batch_id, quantity, unit_cost) VALUES (@e2, @p1, @bOld, 5, 0.45);
    SET @eiOld = LAST_INSERT_ID();
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, stock_entry_item_id, performed_by)
    VALUES (@bOld, 'PURCHASE_ENTRY', 5, @eiOld, @u_admin);
    UPDATE stock_entries SET status = 'POSTED' WHERE id = @e2;
    SET TIMESTAMP = DEFAULT;

    CALL sp_refresh_expiry_alerts();
    CALL sp_refresh_expiry_alerts();   -- segunda ejecución: no debe duplicar alertas abiertas

    CALL pp_test_check('T05', 'Identificar lotes vencidos y próximos a vencer',
         (SELECT expiry_status FROM vw_batch_expiry_status WHERE batch_id = @bOld) = 'EXPIRED'
         AND (SELECT expiry_status FROM vw_batch_expiry_status WHERE batch_id = @bB) = 'WARNING'
         AND (SELECT expiry_status FROM vw_batch_expiry_status WHERE batch_id = @bA) = 'OK'
         AND (SELECT COUNT(*) FROM stock_alerts WHERE batch_id = @bOld AND alert_type = 'EXPIRED' AND status = 'OPEN') = 1
         AND (SELECT COUNT(*) FROM stock_alerts WHERE batch_id = @bB AND alert_type = 'EXPIRING_SOON' AND status = 'OPEN') = 1
         AND (SELECT expired_stock FROM vw_branch_product_stock WHERE branch_id = @branch1 AND product_id = @p1) = 5
         AND (SELECT available_stock FROM vw_branch_product_stock WHERE branch_id = @branch1 AND product_id = @p1) = 120,
         'TL-OLD vencido (5 u. fuera del disponible), TL-B vence en 45 días; 1 alerta abierta por lote pese a 2 ejecuciones');

    -- Recepción de un lote ya vencido: debe rechazarse.
    CALL sp_next_document_number(@branch1, 'STOCK_ENTRY', @num3);
    INSERT INTO stock_entries (entry_number, branch_id, supplier_id, entry_type, registered_by)
    VALUES (@num3, @branch1, @sup, 'PURCHASE', @u_admin);
    SET @e3 = LAST_INSERT_ID();
    INSERT INTO product_batches (product_id, branch_id, batch_number, expiry_date, stock_entry_id)
    VALUES (@p1, @branch1, 'TL-EXP', CURDATE() - INTERVAL 1 DAY, @e3);
    SET @bExp = LAST_INSERT_ID();
    INSERT INTO stock_entry_items (stock_entry_id, product_id, batch_id, quantity, unit_cost) VALUES (@e3, @p1, @bExp, 10, 0.50);
    SET @eiExp = LAST_INSERT_ID();
    CALL pp_test_expect_error('T05b', 'No se recibe un lote vencido',
         "INSERT INTO inventory_movements (batch_id, movement_type, quantity, stock_entry_item_id, performed_by) VALUES (@bExp,'PURCHASE_ENTRY',10,@eiExp,@u_admin)",
         'vencido');
    UPDATE stock_entries SET status = 'CANCELLED' WHERE id = @e3;

    -- Baja de vencidos con ajuste EXPIRED_WRITE_OFF
    CALL sp_next_document_number(@branch1, 'ADJUSTMENT', @adj);
    INSERT INTO inventory_adjustments (adjustment_number, branch_id, adjustment_type, reason, performed_by)
    VALUES (@adj, @branch1, 'EXPIRED_WRITE_OFF', 'Baja de lote TL-OLD vencido', @u_admin);
    SET @adj1 = LAST_INSERT_ID();
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, adjustment_id, performed_by, reason)
    VALUES (@bOld, 'EXPIRED_WRITE_OFF', 5, @adj1, @u_admin, 'Producto vencido');
    CALL sp_refresh_expiry_alerts();
    CALL pp_test_check('T05c', 'Baja de vencidos y cierre automático de su alerta',
         (SELECT current_quantity = 0 AND status = 'DEPLETED' FROM product_batches WHERE id = @bOld)
         AND (SELECT COUNT(*) FROM stock_alerts WHERE batch_id = @bOld AND status = 'OPEN') = 0,
         'TL-OLD queda en 0 (DEPLETED) y su alerta EXPIRED se resolvió');

    -- ===========================================================================
    -- T06. Identificar el lote FEFO
    -- ===========================================================================
    CALL pp_test_check('T06', 'Identificar el lote FEFO',
         (SELECT batch_id FROM vw_fefo_batches WHERE branch_id = @branch1 AND product_id = @p1 AND fefo_rank = 1) = @bB
         AND (SELECT batch_id FROM vw_fefo_batches WHERE branch_id = @branch1 AND product_id = @p1 AND fefo_rank = 2) = @bC
         AND (SELECT COUNT(*) FROM vw_fefo_batches WHERE batch_id IN (@bOld, @bExp)) = 0,
         'Orden FEFO: TL-B (45 días) → TL-C (200) → TL-A (400); vencidos excluidos');

    -- ===========================================================================
    -- T17 (parte 1). Apertura de caja
    -- ===========================================================================
    SET @app_user_id = @u_staff;
    CALL sp_next_document_number(@branch1, 'CASH_SESSION', @csn);
    INSERT INTO cash_sessions (session_number, cash_register_id, opened_by, opening_amount)
    VALUES (@csn, @register1, @u_staff, 100.00);
    SET @sess = LAST_INSERT_ID();

    -- ===========================================================================
    -- T08 + T09 + T12 + T13. Venta presencial con lotes FEFO y pagos divididos
    -- ===========================================================================
    CALL sp_next_document_number(@branch1, 'SALE', @sn1);
    INSERT INTO sales (sale_number, branch_id, seller_user_id, cash_session_id, sale_channel, subtotal, discount_total, total)
    VALUES (@sn1, @branch1, @u_staff, @sess, 'POS', 52.50, 2.50, 50.00);
    SET @s1 = LAST_INSERT_ID();
    INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, discount_amount) VALUES (@s1, @p1, 35, 1.50, 2.50);
    SET @si1 = LAST_INSERT_ID();
    INSERT INTO sale_item_batches (sale_item_id, batch_id, quantity) VALUES (@si1, @bB, 30);
    SET @a1 = LAST_INSERT_ID();
    INSERT INTO sale_item_batches (sale_item_id, batch_id, quantity) VALUES (@si1, @bC, 5);
    SET @a2 = LAST_INSERT_ID();
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_item_batch_id, performed_by) VALUES
      (@bB, 'SALE_OUT', 30, @a1, @u_staff),
      (@bC, 'SALE_OUT', 5,  @a2, @u_staff);

    -- Pago simulado rechazado (T13)
    CALL sp_next_document_number(@branch1, 'PAYMENT', @pg1);
    INSERT INTO payments (operation_code, sale_id, method, status, amount, failure_reason, processed_by, external_reference)
    VALUES (CONCAT('DEMO-', @pg1), @s1, 'CARD', 'REJECTED', 50.00, 'Rechazo simulado por el emisor', @u_staff, 'AUTH-DEMO-0001');
    SET @pay_rej = LAST_INSERT_ID();
    -- Pago dividido: efectivo + Yape simulado (T12)
    CALL sp_next_document_number(@branch1, 'PAYMENT', @pg2);
    INSERT INTO payments (operation_code, sale_id, cash_session_id, method, status, amount, tendered_amount, change_amount, processed_by)
    VALUES (CONCAT('PAY-', @pg2), @s1, @sess, 'CASH', 'APPROVED', 30.00, 50.00, 20.00, @u_staff);
    SET @pay_cash = LAST_INSERT_ID();
    CALL sp_next_document_number(@branch1, 'PAYMENT', @pg3);
    INSERT INTO payments (operation_code, sale_id, method, status, amount, external_reference, processed_by)
    VALUES (CONCAT('DEMO-', @pg3), @s1, 'YAPE', 'APPROVED', 20.00, 'YAPE-DEMO-0001', @u_staff);
    SET @pay_yape = LAST_INSERT_ID();

    CALL sp_next_document_number(@branch1, 'TICKET', @tk1);
    INSERT INTO sale_tickets (ticket_number, sale_id, issued_by) VALUES (@tk1, @s1, @u_staff);

    CALL pp_test_check('T08', 'Registrar una venta presencial',
         (SELECT current_quantity = 0 AND status = 'DEPLETED' FROM product_batches WHERE id = @bB)
         AND (SELECT current_quantity FROM product_batches WHERE id = @bC) = 35
         AND (SELECT available_stock FROM vw_branch_product_stock WHERE branch_id = @branch1 AND product_id = @p1) = 85
         AND (SELECT payment_state FROM vw_sale_payment_summary WHERE sale_id = @s1) = 'PAID'
         AND (SELECT COUNT(*) FROM cash_movements WHERE payment_id = @pay_cash AND movement_type = 'SALE_INCOME' AND amount = 30.00) = 1
         AND (SELECT business_name = 'Pharma Plus' AND seller_name = 'Trabajador de Prueba' AND total = 50.00
                AND payment_methods = 'CASH 30.00 | YAPE 20.00' AND change_given = 20.00
              FROM vw_sale_ticket_header WHERE sale_id = @s1),
         'Venta 35 u. con descuento S/ 2.50; total S/ 50.00 pagado en efectivo + Yape; ticket interno generado');

    CALL pp_test_check('T09', 'Identificar qué lote se usó en la venta',
         (SELECT GROUP_CONCAT(CONCAT(batch_number_snapshot, ':', quantity) ORDER BY expiry_date_snapshot)
            FROM sale_item_batches WHERE sale_item_id = @si1) = 'TL-B:30,TL-C:5'
         AND (SELECT batches FROM vw_sale_ticket_lines WHERE sale_item_id = @si1) = 'TL-B (30), TL-C (5)',
         'La venta tomó 30 u. de TL-B y 5 u. de TL-C (FEFO)');

    CALL pp_test_check('T12', 'Pago simulado aprobado',
         (SELECT status = 'APPROVED' AND is_simulated = TRUE AND payment_mode = 'DEMO' AND paid_at IS NOT NULL
            FROM vw_payment_history WHERE id = @pay_yape)
         AND (SELECT is_simulated FROM payments WHERE id = @pay_cash) = FALSE,
         'Yape APPROVED marcado como DEMO; el efectivo cobrado en caja queda como pago real');

    CALL pp_test_check('T13', 'Pago simulado rechazado',
         (SELECT status = 'REJECTED' AND is_simulated = TRUE AND failure_reason IS NOT NULL FROM payments WHERE id = @pay_rej)
         AND (SELECT approved_amount FROM vw_sale_payment_summary WHERE sale_id = @s1) = 50.00,
         'El rechazo queda en el historial y no suma al importe cobrado');

    -- ===========================================================================
    -- T10. Devolución parcial (una parte vuelve al stock, otra está dañada)
    -- ===========================================================================
    CALL sp_next_document_number(@branch1, 'RETURN', @rn1);
    INSERT INTO sale_returns (return_number, sale_id, return_type, reason_id, requested_by)
    VALUES (@rn1, @s1, 'PARTIAL', (SELECT id FROM return_reasons WHERE code = 'CUSTOMER_CHANGE'), @u_staff);
    SET @r1 = LAST_INSERT_ID();
    INSERT INTO sale_return_items (sale_return_id, sale_item_batch_id, quantity, unit_refund_amount, item_condition)
    VALUES (@r1, @a2, 2, 1.40, 'RESELLABLE');
    SET @ri1 = LAST_INSERT_ID();
    INSERT INTO sale_return_items (sale_return_id, sale_item_batch_id, quantity, unit_refund_amount, item_condition, notes)
    VALUES (@r1, @a1, 1, 1.40, 'DAMAGED', 'Blíster roto');
    SET @ri2 = LAST_INSERT_ID();
    UPDATE sale_returns SET status = 'APPROVED', reviewed_by = @u_admin WHERE id = @r1;
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_return_item_id, performed_by)
    VALUES (@bC, 'RETURN_IN', 2, @ri1, @u_staff);
    CALL pp_test_expect_error('T10b', 'Un producto dañado no reingresa al stock',
         "INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_return_item_id, performed_by) VALUES (@bB,'RETURN_IN',1,@ri2,@u_staff)",
         'RESELLABLE');
    UPDATE sale_returns SET status = 'COMPLETED', refund_method = 'CASH', refund_status = 'REFUNDED',
                            refund_cash_session_id = @sess
     WHERE id = @r1;
    CALL pp_test_check('T10', 'Devolución parcial',
         (SELECT status = 'COMPLETED' AND refund_amount = 4.20 FROM sale_returns WHERE id = @r1)
         AND (SELECT current_quantity FROM product_batches WHERE id = @bC) = 37
         AND (SELECT current_quantity FROM product_batches WHERE id = @bB) = 0
         AND (SELECT COUNT(*) FROM cash_movements WHERE sale_return_id = @r1 AND amount = 4.20) = 1,
         '2 u. aptas regresan a TL-C; 1 u. dañada NO suma stock; reembolso S/ 4.20 en efectivo');

    -- ===========================================================================
    -- T11. Devolución completa
    -- ===========================================================================
    CALL sp_next_document_number(@branch1, 'SALE', @sn2);
    INSERT INTO sales (sale_number, branch_id, seller_user_id, cash_session_id, subtotal, total)
    VALUES (@sn2, @branch1, @u_staff, @sess, 4.50, 4.50);
    SET @s2 = LAST_INSERT_ID();
    INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (@s2, @p1, 3, 1.50);
    SET @si2 = LAST_INSERT_ID();
    INSERT INTO sale_item_batches (sale_item_id, batch_id, quantity) VALUES (@si2, @bC, 3);
    SET @a3 = LAST_INSERT_ID();
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_item_batch_id, performed_by)
    VALUES (@bC, 'SALE_OUT', 3, @a3, @u_staff);
    CALL sp_next_document_number(@branch1, 'PAYMENT', @pg4);
    INSERT INTO payments (operation_code, sale_id, cash_session_id, method, status, amount, tendered_amount, change_amount, processed_by)
    VALUES (CONCAT('PAY-', @pg4), @s2, @sess, 'CASH', 'APPROVED', 4.50, 5.00, 0.50, @u_staff);

    CALL sp_next_document_number(@branch1, 'RETURN', @rn2);
    INSERT INTO sale_returns (return_number, sale_id, return_type, reason_id, requested_by)
    VALUES (@rn2, @s2, 'TOTAL', (SELECT id FROM return_reasons WHERE code = 'SALE_ERROR'), @u_staff);
    SET @r2 = LAST_INSERT_ID();
    INSERT INTO sale_return_items (sale_return_id, sale_item_batch_id, quantity, unit_refund_amount, item_condition)
    VALUES (@r2, @a3, 3, 1.50, 'RESELLABLE');
    SET @ri3 = LAST_INSERT_ID();
    UPDATE sale_returns SET status = 'APPROVED', reviewed_by = @u_admin WHERE id = @r2;
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_return_item_id, performed_by)
    VALUES (@bC, 'RETURN_IN', 3, @ri3, @u_staff);
    UPDATE sale_returns SET status = 'COMPLETED', refund_method = 'CASH', refund_status = 'REFUNDED',
                            refund_cash_session_id = @sess
     WHERE id = @r2;

    -- Intentar devolver otra vez la misma unidad debe fallar
    CALL sp_next_document_number(@branch1, 'RETURN', @rn3);
    INSERT INTO sale_returns (return_number, sale_id, return_type, reason_id, requested_by)
    VALUES (@rn3, @s2, 'PARTIAL', (SELECT id FROM return_reasons WHERE code = 'OTHER'), @u_staff);
    SET @r3 = LAST_INSERT_ID();
    CALL pp_test_expect_error('T11b', 'No se devuelve más de lo vendido',
         "INSERT INTO sale_return_items (sale_return_id, sale_item_batch_id, quantity, unit_refund_amount, item_condition) VALUES (@r3,@a3,1,1.50,'RESELLABLE')",
         'supera la vendida');
    UPDATE sale_returns SET status = 'REJECTED', reviewed_by = @u_admin, rejection_reason = 'Sin unidades por devolver' WHERE id = @r3;

    CALL pp_test_check('T11', 'Devolución completa',
         (SELECT status = 'COMPLETED' AND return_type = 'TOTAL' AND refund_amount = 4.50 FROM sale_returns WHERE id = @r2)
         AND (SELECT SUM(quantity) FROM sale_return_items WHERE sale_return_id = @r2) = (SELECT quantity FROM sale_items WHERE id = @si2)
         AND (SELECT current_quantity FROM product_batches WHERE id = @bC) = 37
         AND (SELECT status FROM sale_returns WHERE id = @r3) = 'REJECTED',
         'Las 3 u. vendidas regresan a TL-C (37 u.); reembolso S/ 4.50; un segundo intento es rechazado');

    -- ===========================================================================
    -- T14. Pedido pendiente que NO descuenta existencias (+ carrito)
    -- ===========================================================================
    INSERT INTO customers (user_id, full_name, document_type, document_number, phone, email)
    VALUES (@u_cust, 'Cliente de Prueba', 'DNI', '00000000', '999000000', 'cliente.prueba@test.local');
    SET @cust = LAST_INSERT_ID();
    INSERT INTO customer_addresses (customer_id, recipient_name, phone, address_line, district, province, department, is_default)
    VALUES (@cust, 'Cliente de Prueba', '999000000', 'Av. Prueba 123', 'Lima', 'Lima', 'Lima', TRUE);
    SET @addr = LAST_INSERT_ID();
    INSERT INTO carts (customer_id, branch_id) VALUES (@cust, @branch1);
    SET @cart = LAST_INSERT_ID();
    INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (@cart, @p1, 10);

    SET @phys_before = (SELECT physical_stock FROM vw_branch_product_stock WHERE branch_id = @branch1 AND product_id = @p1);
    SET @moves_before = (SELECT COUNT(*) FROM inventory_movements);
    CALL sp_next_document_number(@branch1, 'ORDER', @on1);
    INSERT INTO orders (order_number, customer_id, branch_id, fulfillment_type, address_id, subtotal, delivery_fee, total)
    VALUES (@on1, @cust, @branch1, 'DELIVERY', @addr, 15.00, 5.00, 20.00);
    SET @o1 = LAST_INSERT_ID();
    INSERT INTO order_items (order_id, product_id, quantity, unit_price, line_total) VALUES (@o1, @p1, 10, 1.50, 15.00);
    UPDATE carts SET status = 'CONVERTED' WHERE id = @cart;

    CALL pp_test_check('T14', 'Pedido pendiente sin descontar existencias',
         (SELECT status FROM orders WHERE id = @o1) = 'PENDING'
         AND (SELECT physical_stock FROM vw_branch_product_stock WHERE branch_id = @branch1 AND product_id = @p1) = @phys_before
         AND (SELECT COUNT(*) FROM inventory_movements) = @moves_before
         AND (SELECT delivery_address_line FROM orders WHERE id = @o1) = 'Av. Prueba 123'
         AND (SELECT COUNT(*) FROM order_status_history WHERE order_id = @o1) = 1,
         'Pedido delivery PENDING: stock y kardex sin cambios; dirección copiada al pedido');

    -- ===========================================================================
    -- T15. Confirmar el pedido y descontar inventario UNA sola vez
    -- ===========================================================================
    CALL sp_next_document_number(@branch1, 'SALE', @sn3);
    INSERT INTO sales (sale_number, branch_id, order_id, seller_user_id, sale_channel, subtotal, delivery_fee, total)
    VALUES (@sn3, @branch1, @o1, @u_staff, 'ONLINE', 15.00, 5.00, 20.00);
    SET @s3 = LAST_INSERT_ID();
    INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (@s3, @p1, 10, 1.50);
    SET @si3 = LAST_INSERT_ID();
    INSERT INTO sale_item_batches (sale_item_id, batch_id, quantity) VALUES (@si3, @bC, 10);
    SET @a4 = LAST_INSERT_ID();
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_item_batch_id, performed_by)
    VALUES (@bC, 'SALE_OUT', 10, @a4, @u_staff);
    UPDATE orders SET status = 'CONFIRMED' WHERE id = @o1;
    CALL sp_next_document_number(@branch1, 'PAYMENT', @pg5);
    INSERT INTO payments (operation_code, sale_id, order_id, method, status, amount, processed_by)
    VALUES (CONCAT('DEMO-', @pg5), @s3, @o1, 'PLIN', 'APPROVED', 20.00, @u_staff);

    CALL pp_test_expect_error('T15b', 'La misma asignación no descuenta dos veces',
         "INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_item_batch_id, performed_by) VALUES (@bC,'SALE_OUT',10,@a4,@u_staff)",
         'Duplicate entry');
    CALL pp_test_expect_error('T15c', 'Un pedido no genera una segunda venta',
         "INSERT INTO sales (sale_number, branch_id, order_id, seller_user_id, sale_channel, subtotal, delivery_fee, total) VALUES ('X-DUP',@branch1,@o1,@u_staff,'ONLINE',15.00,5.00,20.00)",
         'PENDING');

    UPDATE orders SET status = 'PREPARING', assigned_user_id = @u_staff WHERE id = @o1;
    UPDATE orders SET status = 'OUT_FOR_DELIVERY' WHERE id = @o1;
    UPDATE orders SET status = 'COMPLETED' WHERE id = @o1;

    CALL pp_test_check('T15', 'Confirmar pedido con salida de inventario única',
         (SELECT physical_stock FROM vw_branch_product_stock WHERE branch_id = @branch1 AND product_id = @p1) = @phys_before - 10
         AND (SELECT COUNT(*) FROM inventory_movements WHERE sale_item_batch_id = @a4) = 1
         AND (SELECT status FROM orders WHERE id = @o1) = 'COMPLETED'
         AND (SELECT COUNT(*) FROM order_status_history WHERE order_id = @o1) = 5
         AND (SELECT payment_state FROM vw_sale_payment_summary WHERE sale_id = @s3) = 'PAID',
         'Stock -10 una sola vez; historial PENDING→CONFIRMED→PREPARING→OUT_FOR_DELIVERY→COMPLETED; pagado (PLIN demo)');

    -- Un pedido no se confirma sin su venta, y puede cancelarse con motivo
    CALL sp_next_document_number(@branch1, 'ORDER', @on2);
    INSERT INTO orders (order_number, customer_id, branch_id, fulfillment_type, subtotal, total)
    VALUES (@on2, @cust, @branch1, 'PICKUP', 3.00, 3.00);
    SET @o2 = LAST_INSERT_ID();
    INSERT INTO order_items (order_id, product_id, quantity, unit_price, line_total) VALUES (@o2, @p1, 2, 1.50, 3.00);
    CALL pp_test_expect_error('T15d', 'No se confirma un pedido sin registrar su venta',
         "UPDATE orders SET status = 'CONFIRMED' WHERE id = @o2", 'registre primero la venta');
    UPDATE orders SET status = 'CANCELLED', cancel_reason = 'Cliente no recogió el pedido' WHERE id = @o2;

    -- ===========================================================================
    -- Anulación de venta (usada también en T17/T18)
    -- ===========================================================================
    CALL sp_next_document_number(@branch1, 'SALE', @sn4);
    INSERT INTO sales (sale_number, branch_id, seller_user_id, cash_session_id, subtotal, total)
    VALUES (@sn4, @branch1, @u_staff, @sess, 3.00, 3.00);
    SET @s4 = LAST_INSERT_ID();
    INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (@s4, @p1, 2, 1.50);
    SET @si4 = LAST_INSERT_ID();
    INSERT INTO sale_item_batches (sale_item_id, batch_id, quantity) VALUES (@si4, @bC, 2);
    SET @a5 = LAST_INSERT_ID();
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_item_batch_id, performed_by)
    VALUES (@bC, 'SALE_OUT', 2, @a5, @u_staff);
    CALL sp_next_document_number(@branch1, 'PAYMENT', @pg6);
    INSERT INTO payments (operation_code, sale_id, cash_session_id, method, status, amount, processed_by)
    VALUES (CONCAT('PAY-', @pg6), @s4, @sess, 'CASH', 'APPROVED', 3.00, @u_staff);
    SET @pay_void = LAST_INSERT_ID();

    INSERT INTO sale_voids (sale_id, reason, voided_by, authorized_by) VALUES (@s4, 'Venta duplicada por error', @u_staff, @u_admin);
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, sale_item_batch_id, performed_by)
    VALUES (@bC, 'SALE_VOID_IN', 2, @a5, @u_staff);
    UPDATE payments SET status = 'REFUNDED', refund_cash_session_id = @sess WHERE id = @pay_void;

    CALL pp_test_check('T08b', 'Anulación conserva la venta original y repone stock',
         (SELECT status = 'VOIDED' AND total = 3.00 FROM sales WHERE id = @s4)
         AND (SELECT COUNT(*) FROM sale_items WHERE sale_id = @s4) = 1
         AND (SELECT current_quantity FROM product_batches WHERE id = @bC) = 27
         AND (SELECT COUNT(*) FROM cash_movements WHERE payment_id = @pay_void AND movement_type = 'PAYMENT_REFUND') = 1,
         'Venta VOIDED con su detalle intacto; 2 u. regresan; efectivo devuelto desde caja');

    -- ===========================================================================
    -- T16. Transferencia entre sucursales
    -- ===========================================================================
    SET @app_user_id = @u_admin;
    SET @total_before = (SELECT physical_stock FROM vw_consolidated_stock WHERE product_id = @p1);
    CALL sp_next_document_number(@branch1, 'TRANSFER', @tn1);
    INSERT INTO branch_transfers (transfer_number, origin_branch_id, destination_branch_id, requested_by)
    VALUES (@tn1, @branch1, @branch2, @u_admin);
    SET @t1 = LAST_INSERT_ID();
    INSERT INTO branch_transfer_items (transfer_id, product_id, origin_batch_id, quantity) VALUES (@t1, @p1, @bA, 10);
    SET @ti1 = LAST_INSERT_ID();
    CALL pp_test_expect_error('T16b', 'No se transfiere más que el stock disponible',
         "INSERT INTO branch_transfer_items (transfer_id, product_id, origin_batch_id, quantity) VALUES (@t1,@p1,@bC,999)",
         'supera el stock');
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, transfer_item_id, performed_by)
    VALUES (@bA, 'TRANSFER_OUT', 10, @ti1, @u_admin);
    UPDATE branch_transfers SET status = 'IN_TRANSIT', dispatched_by = @u_admin WHERE id = @t1;
    -- Recepción: el lote se crea en destino con el mismo número y vencimiento
    INSERT INTO product_batches (product_id, branch_id, batch_number, manufacturing_date, expiry_date, unit_cost)
    SELECT product_id, @branch2, batch_number, manufacturing_date, expiry_date, unit_cost FROM product_batches WHERE id = @bA;
    SET @bA2 = LAST_INSERT_ID();
    UPDATE branch_transfer_items SET destination_batch_id = @bA2, received_quantity = 10 WHERE id = @ti1;
    INSERT INTO inventory_movements (batch_id, movement_type, quantity, transfer_item_id, performed_by)
    VALUES (@bA2, 'TRANSFER_IN', 10, @ti1, @u_admin);
    UPDATE branch_transfers SET status = 'RECEIVED', received_by = @u_admin WHERE id = @t1;

    CALL pp_test_check('T16', 'Transferencia entre sucursales',
         (SELECT current_quantity FROM product_batches WHERE id = @bA) = 40
         AND (SELECT current_quantity FROM product_batches WHERE id = @bA2) = 10
         AND (SELECT physical_stock FROM vw_consolidated_stock WHERE product_id = @p1) = @total_before
         AND (SELECT status FROM branch_transfers WHERE id = @t1) = 'RECEIVED'
         AND (SELECT COUNT(*) FROM stock_alerts WHERE branch_id = @branch2 AND product_id = @p1
                AND alert_type = 'LOW_STOCK' AND status = 'OPEN') = 1
         AND (SELECT COUNT(*) FROM stock_alerts WHERE branch_id = @branch2 AND product_id = @p1
                AND alert_type = 'OUT_OF_STOCK' AND status = 'OPEN') = 0,
         '10 u. de TL-A pasan de SP01 a SPTEST sin duplicar stock; en destino 10 ≤ mínimo 10 ⇒ alerta LOW_STOCK');

    -- ===========================================================================
    -- T17. Apertura y cierre de caja
    -- ===========================================================================
    SET @app_user_id = @u_staff;
    INSERT INTO cash_movements (cash_session_id, movement_type, amount, description, performed_by)
    VALUES (@sess, 'CASH_IN', 20.00, 'Sencillo adicional', @u_staff);
    INSERT INTO cash_movements (cash_session_id, movement_type, amount, description, performed_by)
    VALUES (@sess, 'CASH_OUT', 10.00, 'Compra de bolsas', @u_staff);
    CALL pp_test_expect_error('T17b', 'No sale más efectivo del que hay en caja',
         "INSERT INTO cash_movements (cash_session_id, movement_type, amount, description, performed_by) VALUES (@sess,'CASH_OUT',9999,'Retiro',@u_staff)",
         'insuficiente');
    -- Esperado: 100 + 30 + 4.50 + 3.00 + 20 - 4.20 - 4.50 - 3.00 - 10 = 135.80
    UPDATE cash_sessions SET status = 'CLOSED', closed_by = @u_staff, counted_amount = 135.80,
                             closing_notes = 'Cierre de prueba'
     WHERE id = @sess;
    CALL pp_test_check('T17', 'Apertura y cierre de caja',
         (SELECT status = 'CLOSED' AND expected_amount = 135.80 AND difference_amount = 0.00 FROM cash_sessions WHERE id = @sess),
         'Saldo esperado S/ 135.80 calculado por la BD (ventas, reembolsos, ingresos y egresos); diferencia 0.00');
    CALL pp_test_expect_error('T17c', 'No se vende con una caja cerrada',
         "INSERT INTO sales (sale_number, branch_id, seller_user_id, cash_session_id, subtotal, total) VALUES ('X-CLOSED',@branch1,@u_staff,@sess,1.50,1.50)",
         'caja cerrada');
    CALL pp_test_expect_error('T17d', 'No se registra efectivo en una caja cerrada',
         "INSERT INTO cash_movements (cash_session_id, movement_type, amount, description, performed_by) VALUES (@sess,'CASH_IN',5,'x',@u_staff)",
         'caja cerrada');
    CALL pp_test_expect_error('T17e', 'Una caja cerrada no se reabre',
         "UPDATE cash_sessions SET status = 'OPEN' WHERE id = @sess", 'no se reabre');
    CALL sp_next_document_number(@branch1, 'CASH_SESSION', @csn2);
    INSERT INTO cash_sessions (session_number, cash_register_id, opened_by, opening_amount) VALUES (@csn2, @register1, @u_staff, 50.00);
    SET @sess2 = LAST_INSERT_ID();
    CALL pp_test_expect_error('T17f', 'Solo una sesión abierta por caja',
         "INSERT INTO cash_sessions (session_number, cash_register_id, opened_by, opening_amount) VALUES ('X-CS',@register1,@u_admin,10)",
         'Duplicate entry');

    -- ===========================================================================
    -- T18. Auditoría (+ permisos configurables)
    -- ===========================================================================
    SET @app_user_id = @u_admin;
    INSERT INTO user_permissions (user_id, permission_id, effect, granted_by, reason)
    VALUES (@u_staff, (SELECT id FROM permissions WHERE code = 'sales.discount'), 'DENY', @u_admin, 'Sin autorización de descuentos');
    INSERT INTO user_permissions (user_id, permission_id, effect, granted_by)
    VALUES (@u_staff, (SELECT id FROM permissions WHERE code = 'reports.consolidated'), 'GRANT', @u_admin);
    UPDATE products SET sale_price = 1.60 WHERE id = @p1;

    CALL pp_test_check('T18', 'Consultar operaciones de auditoría',
         (SELECT COUNT(*) FROM audit_logs WHERE action = 'VOID' AND entity_table = 'sales' AND entity_id = CAST(@s4 AS CHAR)) = 1
         AND (SELECT COUNT(*) FROM audit_logs WHERE action = 'CLOSE' AND entity_id = CAST(@sess AS CHAR)) = 1
         AND (SELECT COUNT(*) FROM audit_logs WHERE action = 'DENY' AND user_id = @u_admin) = 1
         AND (SELECT COUNT(*) FROM audit_logs WHERE entity_table = 'products' AND entity_id = CAST(@p1 AS CHAR)
                AND JSON_EXTRACT(new_values, '$.sale_price') = 1.60) = 1
         AND (SELECT COUNT(*) FROM audit_logs WHERE request_id = 'test-run') > 0
         AND (SELECT COUNT(*) FROM audit_logs WHERE CAST(new_values AS CHAR) LIKE '%$2b$%'
                OR CAST(old_values AS CHAR) LIKE '%$2b$%') = 0,
         'Se auditan anulación, cierre de caja, permisos y cambio de precio; nunca el hash de contraseña');
    CALL pp_test_check('T18b', 'Permisos configurables por usuario',
         (SELECT COUNT(*) FROM vw_user_effective_permissions WHERE user_id = @u_staff AND permission_code = 'sales.discount') = 0
         AND (SELECT COUNT(*) FROM vw_user_effective_permissions WHERE user_id = @u_staff AND permission_code = 'reports.consolidated') = 1
         AND (SELECT COUNT(*) FROM vw_user_effective_permissions WHERE user_id = @u_staff AND permission_code = 'sales.create') = 1,
         'STAFF hereda sales.create, se le denegó sales.discount y se le concedió reports.consolidated');

    -- ===========================================================================
    -- T19. Restricciones de integridad (todas deben ser rechazadas)
    -- ===========================================================================
    CALL pp_test_expect_error('T19a', 'Stock del lote no se modifica directamente',
         "UPDATE product_batches SET current_quantity = 999 WHERE id = @bA", 'solo cambia');
    CALL pp_test_expect_error('T19b', 'Un lote no nace con stock',
         "INSERT INTO product_batches (product_id, branch_id, batch_number, expiry_date, current_quantity) VALUES (@p1,@branch1,'TL-Z',CURDATE()+INTERVAL 99 DAY,5)",
         'existencia 0');
    CALL pp_test_expect_error('T19c', 'No se vende un lote vencido',
         "INSERT INTO sale_item_batches (sale_item_id, batch_id, quantity) VALUES (@si1,@bOld,1)", 'vencido');
    CALL pp_test_expect_error('T19d', 'No se genera inventario negativo',
         "INSERT INTO inventory_movements (batch_id, movement_type, quantity, adjustment_id, performed_by) VALUES (@bA,'ADJUSTMENT_OUT',9999,@adj1,@u_admin)",
         'stock insuficiente');
    CALL pp_test_expect_error('T19e', 'Cantidades en cero o negativas',
         "INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (@cart,@p2,0)", 'chk_cart_items_quantity');
    CALL pp_test_expect_error('T19f', 'Contraseña en texto plano',
         "INSERT INTO users (role_id, full_name, email, password_hash) VALUES (@role_staff,'X','x@test.local','MiClave123')",
         'chk_users_password_hash');
    CALL pp_test_expect_error('T19g', 'Las ventas no se eliminan',
         "DELETE FROM sales WHERE id = @s1", 'no se eliminan');
    CALL pp_test_expect_error('T19h', 'El kardex es inmutable',
         "UPDATE inventory_movements SET quantity = 1 WHERE batch_id = @bA", 'inmutable');
    CALL pp_test_expect_error('T19i', 'Producto con receta exige N.º de receta',
         "INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (@s1,@p2,1,2.00)", 'receta');
    CALL pp_test_expect_error('T19j', 'No se cobra más que el total',
         "INSERT INTO payments (operation_code, sale_id, method, status, amount, processed_by) VALUES ('DEMO-OVER',@s1,'YAPE','APPROVED',1.00,@u_staff)",
         'excede');
    CALL pp_test_expect_error('T19k', 'No se guardan números de tarjeta',
         "INSERT INTO payments (operation_code, sale_id, method, status, amount, external_reference) VALUES ('DEMO-CARD',@s2,'CARD','PENDING',1.00,'4111111111111111')",
         'chk_payments_no_card_data');
    CALL pp_test_expect_error('T19l', 'Sin alertas abiertas duplicadas',
         "INSERT INTO stock_alerts (branch_id, product_id, alert_type, stock_at_alert) VALUES (@branch2,@p1,'LOW_STOCK',10)",
         'Duplicate entry');
    CALL pp_test_expect_error('T19m', 'Transferencia a la misma sucursal',
         "INSERT INTO branch_transfers (transfer_number, origin_branch_id, destination_branch_id, requested_by) VALUES ('X-TR',@branch1,@branch1,@u_admin)",
         'chk_branch_transfers_branches');
    CALL pp_test_expect_error('T19n', 'La auditoría no se borra',
         "DELETE FROM audit_logs WHERE request_id = 'test-run'", 'solo inserción');
    CALL pp_test_expect_error('T19o', 'Venta POS sin caja',
         "INSERT INTO sales (sale_number, branch_id, seller_user_id, sale_channel, subtotal, total) VALUES ('X-NOCASH',@branch1,@u_staff,'POS',1.00,1.00)",
         'chk_sales_channel');
    CALL pp_test_expect_error('T19p', 'Total de venta inconsistente',
         "INSERT INTO sales (sale_number, branch_id, seller_user_id, cash_session_id, subtotal, discount_total, total) VALUES ('X-TOT',@branch1,@u_staff,@sess2,10.00,1.00,10.00)",
         'chk_sales_total');
    CALL pp_test_check('T19q', 'Importes monetarios en DECIMAL (sin FLOAT/DOUBLE)',
         (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND data_type IN ('float','double','real')) = 0,
         'Ninguna columna usa FLOAT, DOUBLE o REAL');

    -- ===========================================================================
    -- T19r-w. Validaciones con expresiones regulares (adaptación de REGEXP_LIKE)
    -- ===========================================================================
    CALL pp_test_expect_error('T19r', 'Código de rol en minúsculas rechazado (sensible a mayúsculas)',
         "INSERT INTO roles (code, name) VALUES ('cajero', 'Cajero')", 'chk_roles_code');
    INSERT INTO roles (code, name) VALUES ('CAJERO_TEST', 'Cajero de prueba');
    CALL pp_test_check('T19s', 'Código de rol válido aceptado',
         (SELECT COUNT(*) FROM roles WHERE code = 'CAJERO_TEST') = 1, 'CAJERO_TEST cumple ^[A-Z][A-Z0-9_]*$');
    CALL pp_test_expect_error('T19t', 'Clave de configuración con mayúsculas rechazada',
         "INSERT INTO settings (setting_key, setting_value) VALUES ('App.Moneda', 'PEN')", 'chk_settings_key');
    CALL pp_test_expect_error('T19u', 'Prefijo bcrypt en mayúsculas rechazado',
         "INSERT INTO users (role_id, full_name, email, password_hash) VALUES (@role_staff,'X','x2@test.local',CONCAT('$2B$12$', REPEAT('x', 53)))",
         'chk_users_password_hash');
    INSERT INTO users (role_id, full_name, email, password_hash)
    VALUES (@role_staff, 'Argon de Prueba', 'argon.prueba@test.local', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo');
    CALL pp_test_check('T19v', 'Hash Argon2id aceptado',
         (SELECT COUNT(*) FROM users WHERE email = 'argon.prueba@test.local') = 1, 'Formato $argon2id$v=19$... aceptado');
    CALL pp_test_expect_error('T19w', 'Correo con espacios rechazado',
         "INSERT INTO users (role_id, full_name, email, password_hash) VALUES (@role_staff,'X','mal correo@test.local',@hash)",
         'chk_users_email');
    CALL pp_test_expect_error('T19x', 'DNI con 7 dígitos rechazado',
         "INSERT INTO customers (full_name, document_type, document_number) VALUES ('X','DNI','1234567')",
         'chk_customers_dni');
    CALL pp_test_expect_error('T19y', 'Valor INTEGER no numérico rechazado',
         "INSERT INTO settings (setting_key, setting_value, value_type) VALUES ('test.numero','12a','INTEGER')",
         'chk_settings_value_type');

    -- ===========================================================================
    -- T20. Sin relaciones huérfanas y kardex cuadrado
    -- ===========================================================================
    SET @orphan_sql = (
      SELECT CONCAT('SELECT COALESCE(SUM(c),0) INTO @orphans FROM (',
             GROUP_CONCAT(CONCAT(
               'SELECT COUNT(*) AS c FROM `', k.table_name, '` ch WHERE ch.`', k.column_name, '` IS NOT NULL ',
               'AND NOT EXISTS (SELECT 1 FROM `', k.referenced_table_name, '` p WHERE p.`',
               k.referenced_column_name, '` = ch.`', k.column_name, '`)')
               SEPARATOR ' UNION ALL '), ') t')
        FROM information_schema.key_column_usage k
       WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL);
    PREPARE orphan_stmt FROM @orphan_sql;
    EXECUTE orphan_stmt;
    DEALLOCATE PREPARE orphan_stmt;
    CALL pp_test_check('T20', 'Sin relaciones huérfanas',
         @orphans = 0 AND (SELECT COUNT(*) FROM vw_integrity_issues) = 0,
         CONCAT('Huérfanos en las ', (SELECT COUNT(*) FROM information_schema.key_column_usage
                 WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL),
                ' columnas FK: ', @orphans, '; problemas en vw_integrity_issues: ',
                (SELECT COUNT(*) FROM vw_integrity_issues)));

    -- ===========================================================================
    -- LIMPIEZA: se deshacen TODOS los datos de prueba
    -- ===========================================================================
    ROLLBACK;

    INSERT INTO tmp_pp_results (test_id, test_name, result, detail)
    SELECT 'CLEAN', 'Limpieza: no quedan datos de prueba',
           IF(x.n = 0, 'PASS', 'FAIL'), CONCAT('Registros de prueba restantes tras ROLLBACK: ', x.n)
      FROM (SELECT (SELECT COUNT(*) FROM products WHERE sku LIKE 'TEST-%')
                 + (SELECT COUNT(*) FROM users WHERE email LIKE '%@test.local')
                 + (SELECT COUNT(*) FROM branches WHERE code = 'SPTEST')
                 + (SELECT COUNT(*) FROM roles WHERE code = 'CAJERO_TEST') AS n) x;

    -- Fila de resumen (se calcula sobre todas las verificaciones anteriores)
    INSERT INTO tmp_pp_results (test_id, test_name, result, detail)
    SELECT 'RESUMEN',
           CONCAT(SUM(result = 'PASS'), ' PASS / ', SUM(result = 'FAIL'), ' FAIL de ', COUNT(*), ' verificaciones'),
           IF(SUM(result = 'FAIL') = 0, 'PASS', 'FAIL'),
           CONCAT('Servidor: ', VERSION())
      FROM tmp_pp_results;

    -- RESULTADO: la primera fila es el RESUMEN.
    SELECT test_id, result, test_name, detail
      FROM tmp_pp_results
     ORDER BY (test_id = 'RESUMEN') DESC, seq
     LIMIT 1000;

    DROP TEMPORARY TABLE IF EXISTS tmp_pp_results;
END$$
DELIMITER ;

-- Ejecuta los escenarios: el resultado de esta llamada es la tabla de resultados
-- (primera fila RESUMEN, debe decir 0 FAIL; fila CLEAN: no quedan datos de prueba).
CALL pp_run_scenarios();

DROP PROCEDURE IF EXISTS pp_run_scenarios;
DROP PROCEDURE IF EXISTS pp_test_check;
DROP PROCEDURE IF EXISTS pp_test_expect_error;
