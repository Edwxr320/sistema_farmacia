-- ============================================================================
-- PHARMA PLUS - BASE DE DATOS DEFINITIVA (v2.0)
-- ----------------------------------------------------------------------------
-- Base de datos : pharma_plus
-- Motor         : MySQL 8.0.16 o superior (probado en MySQL 8.0.46)
-- Charset       : utf8mb4 / utf8mb4_unicode_ci
-- Almacenamiento: InnoDB
-- Zona horaria  : America/Lima (UTC-05:00, sin horario de verano)
--
-- INSTRUCCIONES IMPORTANTES
--  1. Importar inicialmente en un servidor SIN una base pharma_plus previa,
--     o después de respaldarla (mysqldump). Este script NO contiene
--     DROP DATABASE ni DROP TABLE. Solo usa DROP TRIGGER/PROCEDURE IF EXISTS
--     para poder recrear la lógica programada sin tocar datos.
--  2. Importar con un usuario con privilegios de creación de triggers
--     (por ejemplo root). Si el binary log está activo y el usuario no tiene
--     SUPER/SYSTEM_VARIABLES_ADMIN, habilitar log_bin_trust_function_creators.
--  3. El backend debe ejecutar al abrir cada conexión:
--        SET time_zone = '-05:00';
--        SET @app_user_id = <id del usuario autenticado>;   -- auditoría
--        SET @app_request_id = '<uuid de la petición>';      -- opcional
--  4. No se crea ningún usuario. El primer administrador se crea desde el
--     backend con la contraseña cifrada (bcrypt o Argon2id). Ver README.
--  5. REGLA DE ORO DEL INVENTARIO: el stock vive en product_batches y SOLO
--     cambia insertando filas en inventory_movements. Los triggers bloquean
--     el lote, validan, calculan stock anterior/posterior y actualizan el
--     lote en la misma transacción. Un UPDATE directo del stock es rechazado.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS pharma_plus
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE pharma_plus;

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Guarda de instalación: si existe una base pharma_plus con la estructura
-- ANTIGUA (products.current_stock o users.role), se detiene la importación,
-- porque CREATE TABLE IF NOT EXISTS no transformaría esas tablas.
-- Respalde la base anterior, renómbrela o use un servidor limpio.
-- ----------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS pp_install_guard;
DELIMITER $$
CREATE PROCEDURE pp_install_guard()
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND ((table_name = 'products' AND column_name = 'current_stock')
                    OR (table_name = 'users'    AND column_name = 'role'))) THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'PP: la base pharma_plus tiene la estructura antigua. Respáldela y use una base limpia.';
    END IF;
END$$
DELIMITER ;
CALL pp_install_guard();
DROP PROCEDURE IF EXISTS pp_install_guard;

-- ============================================================================
-- 1. SEGURIDAD: ROLES, PERMISOS, SUCURSALES Y USUARIOS
-- ============================================================================

CREATE TABLE IF NOT EXISTS roles (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code            VARCHAR(40)  NOT NULL,
    name            VARCHAR(100) NOT NULL,
    description     VARCHAR(255) NULL,
    is_system       BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_roles_code UNIQUE (code),
    CONSTRAINT chk_roles_code CHECK (REGEXP_LIKE(code, '^[A-Z][A-Z0-9_]*$', 'c'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code            VARCHAR(80)  NOT NULL,
    module          VARCHAR(50)  NOT NULL,
    name            VARCHAR(120) NOT NULL,
    description     VARCHAR(255) NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_permissions_code UNIQUE (code),
    CONSTRAINT chk_permissions_code CHECK (REGEXP_LIKE(code, '^[a-z_]+(\\.[a-z_]+)+$', 'c')),
    INDEX idx_permissions_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id         BIGINT UNSIGNED NOT NULL,
    permission_id   BIGINT UNSIGNED NOT NULL,
    granted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (role_id, permission_id),
    CONSTRAINT fk_role_permissions_role
      FOREIGN KEY (role_id) REFERENCES roles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_role_permissions_permission
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    INDEX idx_role_permissions_permission (permission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS branches (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code            VARCHAR(20)  NOT NULL,
    name            VARCHAR(120) NOT NULL,
    address_line    VARCHAR(255) NULL,
    district        VARCHAR(100) NULL,
    province        VARCHAR(100) NULL,
    department      VARCHAR(100) NULL,
    phone           VARCHAR(30)  NULL,
    email           VARCHAR(190) NULL,
    is_main         BOOLEAN      NOT NULL DEFAULT FALSE,
    status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    opened_on       DATE NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    main_flag       TINYINT GENERATED ALWAYS AS (IF(is_main, 1, NULL)) STORED,
    CONSTRAINT uq_branches_code UNIQUE (code),
    CONSTRAINT uq_branches_name UNIQUE (name),
    CONSTRAINT uq_branches_single_main UNIQUE (main_flag),
    CONSTRAINT chk_branches_code CHECK (REGEXP_LIKE(code, '^[A-Z0-9]{2,20}$', 'c'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
    id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role_id               BIGINT UNSIGNED NOT NULL,
    full_name             VARCHAR(150) NOT NULL,
    email                 VARCHAR(190) NOT NULL,
    password_hash         VARCHAR(255) NOT NULL,
    phone                 VARCHAR(30)  NULL,
    status                ENUM('ACTIVE','INACTIVE','BLOCKED') NOT NULL DEFAULT 'ACTIVE',
    must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
    failed_login_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    locked_until          DATETIME NULL,
    password_changed_at   DATETIME NULL,
    last_login_at         DATETIME NULL,
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT fk_users_role
      FOREIGN KEY (role_id) REFERENCES roles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- Solo se aceptan hashes bcrypt ($2a/$2b/$2y$) o Argon2 ($argon2id$...).
    CONSTRAINT chk_users_password_hash CHECK (
      REGEXP_LIKE(password_hash,
        '^\\$(2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}|argon2(id|i|d)\\$v=[0-9]+\\$.+)$', 'c')),
    CONSTRAINT chk_users_email CHECK (REGEXP_LIKE(email, '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$')),
    INDEX idx_users_role_status (role_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_permissions (
    user_id         BIGINT UNSIGNED NOT NULL,
    permission_id   BIGINT UNSIGNED NOT NULL,
    effect          ENUM('GRANT','DENY') NOT NULL DEFAULT 'GRANT',
    reason          VARCHAR(255) NULL,
    granted_by      BIGINT UNSIGNED NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, permission_id),
    CONSTRAINT fk_user_permissions_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_user_permissions_permission
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_user_permissions_granted_by
      FOREIGN KEY (granted_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    INDEX idx_user_permissions_permission (permission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_branches (
    user_id         BIGINT UNSIGNED NOT NULL,
    branch_id       BIGINT UNSIGNED NOT NULL,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    assigned_by     BIGINT UNSIGNED NULL,
    assigned_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    default_flag    TINYINT GENERATED ALWAYS AS (IF(is_default, 1, NULL)) STORED,
    PRIMARY KEY (user_id, branch_id),
    CONSTRAINT uq_user_branches_default UNIQUE (user_id, default_flag),
    CONSTRAINT fk_user_branches_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_user_branches_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_user_branches_assigned_by
      FOREIGN KEY (assigned_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    INDEX idx_user_branches_branch (branch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 2. CONFIGURACIÓN Y NUMERACIÓN DE DOCUMENTOS
-- ============================================================================

CREATE TABLE IF NOT EXISTS settings (
    setting_key     VARCHAR(80)   NOT NULL PRIMARY KEY,
    setting_value   VARCHAR(1000) NOT NULL DEFAULT '',
    value_type      ENUM('STRING','INTEGER','DECIMAL','BOOLEAN','JSON') NOT NULL DEFAULT 'STRING',
    description     VARCHAR(255)  NULL,
    is_editable     BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by      BIGINT UNSIGNED NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_settings_updated_by
      FOREIGN KEY (updated_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_settings_key CHECK (REGEXP_LIKE(setting_key, '^[a-z_]+(\\.[a-z_]+)+$', 'c')),
    CONSTRAINT chk_settings_value_type CHECK (
         value_type = 'STRING'
      OR (value_type = 'INTEGER' AND REGEXP_LIKE(setting_value, '^-?[0-9]+$'))
      OR (value_type = 'DECIMAL' AND REGEXP_LIKE(setting_value, '^-?[0-9]+(\\.[0-9]+)?$'))
      OR (value_type = 'BOOLEAN' AND setting_value IN ('true','false'))
      OR (value_type = 'JSON'    AND JSON_VALID(setting_value)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS document_sequences (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    branch_id       BIGINT UNSIGNED NOT NULL,
    document_type   ENUM('SALE','TICKET','ORDER','STOCK_ENTRY','TRANSFER','RETURN',
                         'ADJUSTMENT','CASH_SESSION','PAYMENT') NOT NULL,
    prefix          VARCHAR(30) NOT NULL,
    next_number     BIGINT UNSIGNED NOT NULL DEFAULT 1,
    padding         TINYINT UNSIGNED NOT NULL DEFAULT 8,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_document_sequences UNIQUE (branch_id, document_type),
    CONSTRAINT fk_document_sequences_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_document_sequences_next CHECK (next_number >= 1),
    CONSTRAINT chk_document_sequences_padding CHECK (padding BETWEEN 4 AND 12)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 3. CLIENTES Y DIRECCIONES
-- ============================================================================

CREATE TABLE IF NOT EXISTS customers (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NULL,      -- NULL = cliente registrado en POS sin cuenta web
    full_name       VARCHAR(150) NOT NULL,
    document_type   ENUM('DNI','CE','PASSPORT','RUC','OTHER') NULL,
    document_number VARCHAR(30) NULL,
    phone           VARCHAR(30) NULL,
    email           VARCHAR(190) NULL,
    birth_date      DATE NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      BIGINT UNSIGNED NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_customers_user UNIQUE (user_id),
    CONSTRAINT uq_customers_document UNIQUE (document_type, document_number),
    CONSTRAINT fk_customers_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_customers_created_by
      FOREIGN KEY (created_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_customers_document_pair CHECK ((document_type IS NULL) = (document_number IS NULL)),
    CONSTRAINT chk_customers_dni CHECK (document_type IS NULL OR document_type <> 'DNI'
                                        OR REGEXP_LIKE(document_number, '^[0-9]{8}$')),
    CONSTRAINT chk_customers_ruc CHECK (document_type IS NULL OR document_type <> 'RUC'
                                        OR REGEXP_LIKE(document_number, '^[12][0-9]{10}$')),
    INDEX idx_customers_name (full_name),
    INDEX idx_customers_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_addresses (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id     BIGINT UNSIGNED NOT NULL,
    label           VARCHAR(60)  NULL,
    recipient_name  VARCHAR(150) NOT NULL,
    phone           VARCHAR(30)  NOT NULL,
    address_line    VARCHAR(255) NOT NULL,
    reference_note  VARCHAR(255) NULL,
    district        VARCHAR(100) NULL,
    province        VARCHAR(100) NULL,
    department      VARCHAR(100) NULL,
    latitude        DECIMAL(10,7) NULL,
    longitude       DECIMAL(10,7) NULL,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    default_flag    TINYINT GENERATED ALWAYS AS (IF(is_default AND is_active, 1, NULL)) STORED,
    CONSTRAINT uq_customer_addresses_default UNIQUE (customer_id, default_flag),
    CONSTRAINT fk_addresses_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_addresses_lat CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_addresses_lng CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 4. CATÁLOGO: CATEGORÍAS, LABORATORIOS, PRODUCTOS, CONFIGURACIÓN POR SUCURSAL
-- ============================================================================

CREATE TABLE IF NOT EXISTS categories (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    description     VARCHAR(255) NULL,
    image_url       VARCHAR(500) NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_categories_name UNIQUE (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS laboratories (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(150) NOT NULL,
    country         VARCHAR(80)  NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_laboratories_name UNIQUE (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
    id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    category_id            BIGINT UNSIGNED NOT NULL,
    laboratory_id          BIGINT UNSIGNED NULL,
    sku                    VARCHAR(60)  NOT NULL,
    barcode                VARCHAR(80)  NULL,
    name                   VARCHAR(180) NOT NULL,
    description            TEXT NULL,
    image_url              VARCHAR(500) NULL,
    active_ingredient      VARCHAR(255) NULL,
    concentration          VARCHAR(100) NULL,
    dosage_form            VARCHAR(80)  NULL,
    presentation           VARCHAR(150) NULL,
    sanitary_registration  VARCHAR(50)  NULL,
    unit                   VARCHAR(30)  NOT NULL DEFAULT 'unidad',
    purchase_price         DECIMAL(10,2) NOT NULL DEFAULT 0.00,   -- precio de compra de referencia
    sale_price             DECIMAL(10,2) NOT NULL,                -- precio de venta general
    requires_prescription  BOOLEAN NOT NULL DEFAULT FALSE,
    status                 ENUM('ACTIVE','INACTIVE','DISCONTINUED') NOT NULL DEFAULT 'ACTIVE',
    created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_products_sku UNIQUE (sku),
    CONSTRAINT uq_products_barcode UNIQUE (barcode),
    CONSTRAINT fk_products_category
      FOREIGN KEY (category_id) REFERENCES categories(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_products_laboratory
      FOREIGN KEY (laboratory_id) REFERENCES laboratories(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_products_purchase_price CHECK (purchase_price >= 0),
    CONSTRAINT chk_products_sale_price CHECK (sale_price >= 0),
    INDEX idx_products_category_status (category_id, status),
    INDEX idx_products_name (name),
    INDEX idx_products_ingredient (active_ingredient),
    FULLTEXT INDEX ftx_products_search (name, active_ingredient, description)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Configuración del producto en cada sucursal (precio opcional, stock mínimo).
-- El catálogo NO se duplica: una fila por (sucursal, producto).
CREATE TABLE IF NOT EXISTS branch_products (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    branch_id       BIGINT UNSIGNED NOT NULL,
    product_id      BIGINT UNSIGNED NOT NULL,
    sale_price      DECIMAL(10,2) NULL,             -- NULL = usa products.sale_price
    minimum_stock   INT UNSIGNED NOT NULL DEFAULT 20,
    maximum_stock   INT UNSIGNED NULL,
    shelf_location  VARCHAR(40) NULL,
    is_available    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_branch_products UNIQUE (branch_id, product_id),
    CONSTRAINT fk_branch_products_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_products_product
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_branch_products_price CHECK (sale_price IS NULL OR sale_price >= 0),
    CONSTRAINT chk_branch_products_max CHECK (maximum_stock IS NULL OR maximum_stock >= minimum_stock),
    INDEX idx_branch_products_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 5. PROVEEDORES, ENTRADAS DE MERCADERÍA Y LOTES
-- ============================================================================

CREATE TABLE IF NOT EXISTS suppliers (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    business_name   VARCHAR(180) NOT NULL,         -- razón social
    trade_name      VARCHAR(180) NULL,             -- nombre comercial
    ruc             CHAR(11) NULL,
    contact_name    VARCHAR(150) NULL,
    phone           VARCHAR(30)  NULL,
    email           VARCHAR(190) NULL,
    address_line    VARCHAR(255) NULL,
    district        VARCHAR(100) NULL,
    province        VARCHAR(100) NULL,
    department      VARCHAR(100) NULL,
    status          ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    notes           VARCHAR(500) NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_suppliers_ruc UNIQUE (ruc),
    CONSTRAINT chk_suppliers_ruc CHECK (ruc IS NULL OR REGEXP_LIKE(ruc, '^[12][0-9]{10}$')),
    INDEX idx_suppliers_name (business_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_entries (
    id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    entry_number              VARCHAR(40) NOT NULL,
    branch_id                 BIGINT UNSIGNED NOT NULL,
    supplier_id               BIGINT UNSIGNED NULL,
    entry_type                ENUM('PURCHASE','INITIAL_STOCK','DONATION','OTHER') NOT NULL DEFAULT 'PURCHASE',
    reference_document_type   ENUM('FACTURA','BOLETA','GUIA_REMISION','NOTA','OTHER') NULL,
    reference_document_number VARCHAR(80) NULL,
    status                    ENUM('DRAFT','POSTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
    registered_by             BIGINT UNSIGNED NOT NULL,
    received_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    posted_at                 DATETIME NULL,
    total_cost                DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    notes                     VARCHAR(500) NULL,
    created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_stock_entries_number UNIQUE (entry_number),
    CONSTRAINT uq_stock_entries_supplier_doc UNIQUE (supplier_id, reference_document_type, reference_document_number),
    CONSTRAINT fk_stock_entries_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_entries_supplier
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_entries_user
      FOREIGN KEY (registered_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_entries_supplier CHECK (entry_type <> 'PURCHASE' OR supplier_id IS NOT NULL),
    CONSTRAINT chk_stock_entries_total CHECK (total_cost >= 0),
    CONSTRAINT chk_stock_entries_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL)),
    INDEX idx_stock_entries_branch_date (branch_id, received_at),
    INDEX idx_stock_entries_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lote = producto + sucursal + número de lote. Es la ÚNICA fuente de stock.
-- current_quantity y received_quantity solo los modifica inventory_movements.
CREATE TABLE IF NOT EXISTS product_batches (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id          BIGINT UNSIGNED NOT NULL,
    branch_id           BIGINT UNSIGNED NOT NULL,
    batch_number        VARCHAR(60) NOT NULL,
    manufacturing_date  DATE NULL,
    expiry_date         DATE NOT NULL,
    received_quantity   INT UNSIGNED NOT NULL DEFAULT 0,
    current_quantity    INT UNSIGNED NOT NULL DEFAULT 0,
    unit_cost           DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    stock_entry_id      BIGINT UNSIGNED NULL,   -- entrada que originó el lote (NULL si llegó por transferencia)
    status              ENUM('ACTIVE','DEPLETED','QUARANTINE','RECALLED') NOT NULL DEFAULT 'ACTIVE',
    notes               VARCHAR(500) NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_product_batches UNIQUE (branch_id, product_id, batch_number),
    CONSTRAINT fk_product_batches_product
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_product_batches_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_product_batches_entry
      FOREIGN KEY (stock_entry_id) REFERENCES stock_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_product_batches_dates CHECK (manufacturing_date IS NULL OR manufacturing_date < expiry_date),
    CONSTRAINT chk_product_batches_cost CHECK (unit_cost >= 0),
    INDEX idx_product_batches_fefo (branch_id, product_id, status, expiry_date),
    INDEX idx_product_batches_expiry (expiry_date),
    INDEX idx_product_batches_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_entry_items (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    stock_entry_id  BIGINT UNSIGNED NOT NULL,
    product_id      BIGINT UNSIGNED NOT NULL,
    batch_id        BIGINT UNSIGNED NOT NULL,
    quantity        INT UNSIGNED NOT NULL,
    unit_cost       DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    line_total      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    CONSTRAINT uq_stock_entry_items_batch UNIQUE (stock_entry_id, batch_id),
    CONSTRAINT fk_stock_entry_items_entry
      FOREIGN KEY (stock_entry_id) REFERENCES stock_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_entry_items_product
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_entry_items_batch
      FOREIGN KEY (batch_id) REFERENCES product_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_entry_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_stock_entry_items_cost CHECK (unit_cost >= 0),
    CONSTRAINT chk_stock_entry_items_total CHECK (line_total = quantity * unit_cost),
    INDEX idx_stock_entry_items_product (product_id),
    INDEX idx_stock_entry_items_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_adjustments (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    adjustment_number   VARCHAR(40) NOT NULL,
    branch_id           BIGINT UNSIGNED NOT NULL,
    adjustment_type     ENUM('PHYSICAL_COUNT','EXPIRED_WRITE_OFF','DAMAGE','LOSS','CORRECTION','OTHER') NOT NULL,
    reason              VARCHAR(500) NOT NULL,
    performed_by        BIGINT UNSIGNED NOT NULL,
    approved_by         BIGINT UNSIGNED NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_inventory_adjustments_number UNIQUE (adjustment_number),
    CONSTRAINT fk_inventory_adjustments_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_adjustments_user
      FOREIGN KEY (performed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_adjustments_approver
      FOREIGN KEY (approved_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_adjustments_reason CHECK (CHAR_LENGTH(TRIM(reason)) >= 5),
    INDEX idx_inventory_adjustments_branch_date (branch_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 6. CAJA
-- ============================================================================

CREATE TABLE IF NOT EXISTS cash_registers (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    branch_id       BIGINT UNSIGNED NOT NULL,
    code            VARCHAR(20) NOT NULL,
    name            VARCHAR(80) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_cash_registers UNIQUE (branch_id, code),
    CONSTRAINT fk_cash_registers_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_sessions (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    session_number      VARCHAR(40) NOT NULL,
    cash_register_id    BIGINT UNSIGNED NOT NULL,
    opened_by           BIGINT UNSIGNED NOT NULL,
    opened_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opening_amount      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    status              ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
    closed_by           BIGINT UNSIGNED NULL,
    closed_at           DATETIME NULL,
    expected_amount     DECIMAL(12,2) NULL,   -- calculado por trigger al cerrar
    counted_amount      DECIMAL(12,2) NULL,   -- arqueo físico
    difference_amount   DECIMAL(12,2) GENERATED ALWAYS AS (counted_amount - expected_amount) STORED,
    opening_notes       VARCHAR(500) NULL,
    closing_notes       VARCHAR(500) NULL,
    open_flag           TINYINT GENERATED ALWAYS AS (IF(status = 'OPEN', 1, NULL)) STORED,
    CONSTRAINT uq_cash_sessions_number UNIQUE (session_number),
    CONSTRAINT uq_cash_sessions_one_open_per_register UNIQUE (cash_register_id, open_flag),
    CONSTRAINT uq_cash_sessions_one_open_per_user UNIQUE (opened_by, open_flag),
    CONSTRAINT fk_cash_sessions_register
      FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cash_sessions_opened_by
      FOREIGN KEY (opened_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cash_sessions_closed_by
      FOREIGN KEY (closed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_cash_sessions_opening CHECK (opening_amount >= 0),
    CONSTRAINT chk_cash_sessions_counted CHECK (counted_amount IS NULL OR counted_amount >= 0),
    CONSTRAINT chk_cash_sessions_state CHECK (
         (status = 'OPEN'   AND closed_at IS NULL AND closed_by IS NULL
                            AND counted_amount IS NULL AND expected_amount IS NULL)
      OR (status = 'CLOSED' AND closed_at IS NOT NULL AND closed_by IS NOT NULL
                            AND counted_amount IS NOT NULL AND expected_amount IS NOT NULL)),
    CONSTRAINT chk_cash_sessions_dates CHECK (closed_at IS NULL OR closed_at >= opened_at),
    INDEX idx_cash_sessions_status (status, opened_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 7. TIENDA VIRTUAL: CARRITO Y PEDIDOS
-- ============================================================================

CREATE TABLE IF NOT EXISTS carts (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id     BIGINT UNSIGNED NOT NULL,
    branch_id       BIGINT UNSIGNED NULL,    -- sucursal elegida para consultar stock/precio
    status          ENUM('ACTIVE','CONVERTED','ABANDONED') NOT NULL DEFAULT 'ACTIVE',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    active_flag     TINYINT GENERATED ALWAYS AS (IF(status = 'ACTIVE', 1, NULL)) STORED,
    CONSTRAINT uq_carts_one_active UNIQUE (customer_id, active_flag),
    CONSTRAINT fk_carts_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_carts_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    INDEX idx_carts_customer_status (customer_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cart_items (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    cart_id         BIGINT UNSIGNED NOT NULL,
    product_id      BIGINT UNSIGNED NOT NULL,
    quantity        INT UNSIGNED NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_cart_product UNIQUE (cart_id, product_id),
    CONSTRAINT fk_cart_items_cart
      FOREIGN KEY (cart_id) REFERENCES carts(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_cart_items_product
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_cart_items_quantity CHECK (quantity > 0),
    INDEX idx_cart_items_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_number            VARCHAR(40) NOT NULL,
    customer_id             BIGINT UNSIGNED NOT NULL,
    branch_id               BIGINT UNSIGNED NOT NULL,   -- sucursal responsable
    fulfillment_type        ENUM('PICKUP','DELIVERY') NOT NULL,
    status                  ENUM('PENDING','CONFIRMED','PREPARING','READY_FOR_PICKUP',
                                 'OUT_FOR_DELIVERY','COMPLETED','CANCELLED','REJECTED')
                            NOT NULL DEFAULT 'PENDING',
    address_id              BIGINT UNSIGNED NULL,
    -- Copia de la dirección al momento del pedido (la dirección puede cambiar luego)
    delivery_recipient_name VARCHAR(150) NULL,
    delivery_phone          VARCHAR(30)  NULL,
    delivery_address_line   VARCHAR(255) NULL,
    delivery_reference      VARCHAR(255) NULL,
    delivery_district       VARCHAR(100) NULL,
    delivery_province       VARCHAR(100) NULL,
    delivery_department     VARCHAR(100) NULL,
    subtotal                DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    discount_total          DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    delivery_fee            DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total                   DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    customer_note           VARCHAR(500) NULL,
    internal_note           VARCHAR(500) NULL,
    assigned_user_id        BIGINT UNSIGNED NULL,
    confirmed_by            BIGINT UNSIGNED NULL,
    confirmed_at            DATETIME NULL,
    completed_at            DATETIME NULL,
    cancelled_by            BIGINT UNSIGNED NULL,
    cancelled_at            DATETIME NULL,
    cancel_reason           VARCHAR(500) NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_orders_number UNIQUE (order_number),
    CONSTRAINT fk_orders_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_orders_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_orders_address
      FOREIGN KEY (address_id) REFERENCES customer_addresses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_orders_assigned_user
      FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_orders_confirmed_by
      FOREIGN KEY (confirmed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_orders_cancelled_by
      FOREIGN KEY (cancelled_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_orders_amounts CHECK (subtotal >= 0 AND delivery_fee >= 0
                                         AND discount_total >= 0 AND discount_total <= subtotal),
    CONSTRAINT chk_orders_total CHECK (total = subtotal - discount_total + delivery_fee),
    CONSTRAINT chk_orders_delivery CHECK (
         (fulfillment_type = 'DELIVERY' AND delivery_address_line IS NOT NULL AND delivery_phone IS NOT NULL)
      OR (fulfillment_type = 'PICKUP'   AND delivery_fee = 0)),
    CONSTRAINT chk_orders_status_mode CHECK (
         (status <> 'READY_FOR_PICKUP' OR fulfillment_type = 'PICKUP')
     AND (status <> 'OUT_FOR_DELIVERY' OR fulfillment_type = 'DELIVERY')),
    CONSTRAINT chk_orders_cancel CHECK (status NOT IN ('CANCELLED','REJECTED') OR cancel_reason IS NOT NULL),
    INDEX idx_orders_customer_date (customer_id, created_at),
    INDEX idx_orders_branch_status_date (branch_id, status, created_at),
    INDEX idx_orders_assigned (assigned_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id                BIGINT UNSIGNED NOT NULL,
    product_id              BIGINT UNSIGNED NOT NULL,
    product_name_snapshot   VARCHAR(180) NOT NULL,
    sku_snapshot            VARCHAR(60)  NOT NULL,
    quantity                INT UNSIGNED NOT NULL,
    unit_price              DECIMAL(10,2) NOT NULL,
    line_total              DECIMAL(12,2) NOT NULL,
    CONSTRAINT uq_order_items_product UNIQUE (order_id, product_id),
    CONSTRAINT fk_order_items_order
      FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_order_items_product
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_order_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_order_items_price CHECK (unit_price >= 0),
    CONSTRAINT chk_order_items_total CHECK (line_total = quantity * unit_price),
    INDEX idx_order_items_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_status_history (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id        BIGINT UNSIGNED NOT NULL,
    from_status     VARCHAR(30) NULL,
    to_status       VARCHAR(30) NOT NULL,
    changed_by      BIGINT UNSIGNED NULL,   -- NULL = acción del cliente o del sistema
    note            VARCHAR(500) NULL,
    changed_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_order_status_history_order
      FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_order_status_history_user
      FOREIGN KEY (changed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    INDEX idx_order_status_history_order (order_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 8. VENTAS (POS y pedidos confirmados), LOTES VENDIDOS, PAGOS Y TICKETS
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales (
    id                          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sale_number                 VARCHAR(40) NOT NULL,
    branch_id                   BIGINT UNSIGNED NOT NULL,
    order_id                    BIGINT UNSIGNED NULL,     -- UNIQUE: un pedido genera UNA sola venta
    customer_id                 BIGINT UNSIGNED NULL,     -- NULL = venta rápida
    customer_name_snapshot      VARCHAR(150) NULL,
    customer_document_snapshot  VARCHAR(40)  NULL,
    seller_user_id              BIGINT UNSIGNED NOT NULL,
    cash_session_id             BIGINT UNSIGNED NULL,     -- obligatorio en ventas POS
    sale_channel                ENUM('POS','ONLINE') NOT NULL DEFAULT 'POS',
    status                      ENUM('COMPLETED','VOIDED') NOT NULL DEFAULT 'COMPLETED',
    subtotal                    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    discount_total              DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    delivery_fee                DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total                       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    sold_at                     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes                       VARCHAR(500) NULL,
    created_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_sales_number UNIQUE (sale_number),
    CONSTRAINT uq_sales_order UNIQUE (order_id),
    CONSTRAINT fk_sales_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_order
      FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_seller
      FOREIGN KEY (seller_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_cash_session
      FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sales_amounts CHECK (subtotal >= 0 AND delivery_fee >= 0
                                        AND discount_total >= 0 AND discount_total <= subtotal),
    CONSTRAINT chk_sales_total CHECK (total = subtotal - discount_total + delivery_fee),
    CONSTRAINT chk_sales_channel CHECK (
         (sale_channel = 'POS'    AND order_id IS NULL AND cash_session_id IS NOT NULL AND delivery_fee = 0)
      OR (sale_channel = 'ONLINE' AND order_id IS NOT NULL)),
    INDEX idx_sales_branch_date (branch_id, sold_at),
    INDEX idx_sales_date_status (sold_at, status),
    INDEX idx_sales_customer (customer_id),
    INDEX idx_sales_seller (seller_user_id, sold_at),
    INDEX idx_sales_cash_session (cash_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sale_items (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sale_id                 BIGINT UNSIGNED NOT NULL,
    product_id              BIGINT UNSIGNED NOT NULL,
    product_name_snapshot   VARCHAR(180) NOT NULL,
    sku_snapshot            VARCHAR(60)  NOT NULL,
    quantity                INT UNSIGNED NOT NULL,
    unit_price              DECIMAL(10,2) NOT NULL,
    line_subtotal           DECIMAL(12,2) NOT NULL,
    discount_amount         DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    line_total              DECIMAL(12,2) NOT NULL,
    prescription_reference  VARCHAR(80) NULL,   -- N.º de receta (productos con receta)
    CONSTRAINT uq_sale_items_product UNIQUE (sale_id, product_id),
    CONSTRAINT fk_sale_items_sale
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_items_product
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sale_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_sale_items_price CHECK (unit_price >= 0),
    CONSTRAINT chk_sale_items_subtotal CHECK (line_subtotal = quantity * unit_price),
    CONSTRAINT chk_sale_items_discount CHECK (discount_amount >= 0 AND discount_amount <= line_subtotal),
    CONSTRAINT chk_sale_items_total CHECK (line_total = line_subtotal - discount_amount),
    INDEX idx_sale_items_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Qué lote (y cuántas unidades de cada lote) salió en cada línea de venta.
CREATE TABLE IF NOT EXISTS sale_item_batches (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sale_item_id            BIGINT UNSIGNED NOT NULL,
    batch_id                BIGINT UNSIGNED NOT NULL,
    quantity                INT UNSIGNED NOT NULL,
    batch_number_snapshot   VARCHAR(60) NOT NULL,
    expiry_date_snapshot    DATE NOT NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_sale_item_batches UNIQUE (sale_item_id, batch_id),
    CONSTRAINT fk_sale_item_batches_item
      FOREIGN KEY (sale_item_id) REFERENCES sale_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_item_batches_batch
      FOREIGN KEY (batch_id) REFERENCES product_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sale_item_batches_quantity CHECK (quantity > 0),
    INDEX idx_sale_item_batches_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pagos (incluye pagos divididos). Modo DEMO: is_simulated = TRUE.
-- NUNCA se guardan números de tarjeta, CVV ni fechas de vencimiento de tarjetas.
CREATE TABLE IF NOT EXISTS payments (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    operation_code          VARCHAR(60) NOT NULL,
    sale_id                 BIGINT UNSIGNED NULL,
    order_id                BIGINT UNSIGNED NULL,
    cash_session_id         BIGINT UNSIGNED NULL,
    method                  ENUM('CASH','CARD','TRANSFER','YAPE','PLIN','OTHER') NOT NULL,
    status                  ENUM('PENDING','APPROVED','REJECTED','CANCELLED','REFUNDED') NOT NULL DEFAULT 'PENDING',
    amount                  DECIMAL(12,2) NOT NULL,
    tendered_amount         DECIMAL(12,2) NULL,   -- efectivo entregado por el cliente
    change_amount           DECIMAL(12,2) NULL,   -- vuelto
    is_simulated            BOOLEAN NOT NULL DEFAULT TRUE,
    external_reference      VARCHAR(100) NULL,    -- p.ej. N.º de operación Yape simulado
    failure_reason          VARCHAR(255) NULL,
    processed_by            BIGINT UNSIGNED NULL,
    paid_at                 DATETIME NULL,
    refunded_at             DATETIME NULL,
    refund_cash_session_id  BIGINT UNSIGNED NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_payments_operation_code UNIQUE (operation_code),
    CONSTRAINT fk_payments_sale
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_payments_order
      FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_payments_cash_session
      FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_payments_refund_session
      FOREIGN KEY (refund_cash_session_id) REFERENCES cash_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_payments_processed_by
      FOREIGN KEY (processed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_payments_target CHECK (sale_id IS NOT NULL OR order_id IS NOT NULL),
    CONSTRAINT chk_payments_amount CHECK (amount > 0),
    CONSTRAINT chk_payments_cash_change CHECK (
         (tendered_amount IS NULL AND change_amount IS NULL)
      OR (method = 'CASH' AND tendered_amount >= amount AND change_amount = tendered_amount - amount)),
    CONSTRAINT chk_payments_cash_session CHECK (cash_session_id IS NULL OR processed_by IS NOT NULL),
    CONSTRAINT chk_payments_paid_at CHECK (status NOT IN ('APPROVED','REFUNDED') OR paid_at IS NOT NULL),
    CONSTRAINT chk_payments_refunded CHECK ((status = 'REFUNDED') = (refunded_at IS NOT NULL)),
    CONSTRAINT chk_payments_rejected CHECK (status <> 'REJECTED' OR failure_reason IS NOT NULL),
    CONSTRAINT chk_payments_cash_refund CHECK (status <> 'REFUNDED' OR method <> 'CASH'
                                               OR cash_session_id IS NULL OR refund_cash_session_id IS NOT NULL),
    -- Defensa adicional: impide guardar algo con forma de número de tarjeta (13-19 dígitos seguidos)
    CONSTRAINT chk_payments_no_card_data CHECK (
          (external_reference IS NULL OR NOT REGEXP_LIKE(external_reference, '[0-9]{13,19}'))
      AND NOT REGEXP_LIKE(operation_code, '[0-9]{13,19}')),
    INDEX idx_payments_sale (sale_id, status),
    INDEX idx_payments_order (order_id, status),
    INDEX idx_payments_session (cash_session_id),
    INDEX idx_payments_method_date (method, created_at),
    INDEX idx_payments_status_date (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ticket interno imprimible (NO es comprobante electrónico; sin integración SUNAT).
CREATE TABLE IF NOT EXISTS sale_tickets (
    id                       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ticket_number            VARCHAR(40) NOT NULL,
    sale_id                  BIGINT UNSIGNED NOT NULL,
    issued_by                BIGINT UNSIGNED NOT NULL,
    issued_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    business_name_snapshot   VARCHAR(180) NOT NULL,
    business_ruc_snapshot    VARCHAR(20)  NULL,
    branch_name_snapshot     VARCHAR(120) NOT NULL,
    branch_address_snapshot  VARCHAR(400) NULL,
    branch_phone_snapshot    VARCHAR(30)  NULL,
    seller_name_snapshot     VARCHAR(150) NOT NULL,
    customer_name_snapshot   VARCHAR(150) NULL,
    legend                   VARCHAR(255) NOT NULL
                             DEFAULT 'Ticket interno. No es un comprobante de pago electrónico.',
    print_count              INT UNSIGNED NOT NULL DEFAULT 0,
    last_printed_at          DATETIME NULL,
    CONSTRAINT uq_sale_tickets_number UNIQUE (ticket_number),
    CONSTRAINT uq_sale_tickets_sale UNIQUE (sale_id),
    CONSTRAINT fk_sale_tickets_sale
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_tickets_user
      FOREIGN KEY (issued_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 9. ANULACIONES Y DEVOLUCIONES
-- ============================================================================

CREATE TABLE IF NOT EXISTS sale_voids (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sale_id             BIGINT UNSIGNED NOT NULL,
    reason              VARCHAR(500) NOT NULL,
    sale_total_snapshot DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    voided_by           BIGINT UNSIGNED NOT NULL,
    authorized_by       BIGINT UNSIGNED NULL,
    voided_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_sale_voids_sale UNIQUE (sale_id),
    CONSTRAINT fk_sale_voids_sale
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_voids_user
      FOREIGN KEY (voided_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_voids_authorizer
      FOREIGN KEY (authorized_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sale_voids_reason CHECK (CHAR_LENGTH(TRIM(reason)) >= 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS return_reasons (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code            VARCHAR(40)  NOT NULL,
    name            VARCHAR(120) NOT NULL,
    description     VARCHAR(255) NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_return_reasons_code UNIQUE (code),
    CONSTRAINT chk_return_reasons_code CHECK (REGEXP_LIKE(code, '^[A-Z][A-Z0-9_]*$', 'c'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sale_returns (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    return_number           VARCHAR(40) NOT NULL,
    sale_id                 BIGINT UNSIGNED NOT NULL,
    return_type             ENUM('PARTIAL','TOTAL') NOT NULL,
    reason_id               BIGINT UNSIGNED NOT NULL,
    status                  ENUM('REQUESTED','APPROVED','REJECTED','COMPLETED') NOT NULL DEFAULT 'REQUESTED',
    requested_by            BIGINT UNSIGNED NOT NULL,
    requested_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_by             BIGINT UNSIGNED NULL,
    reviewed_at             DATETIME NULL,
    completed_at            DATETIME NULL,
    refund_amount           DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    refund_method           ENUM('CASH','CARD','TRANSFER','YAPE','PLIN','OTHER') NULL,
    refund_status           ENUM('NONE','PENDING','REFUNDED') NOT NULL DEFAULT 'PENDING',
    refund_cash_session_id  BIGINT UNSIGNED NULL,
    refund_operation_code   VARCHAR(60) NULL,
    notes                   VARCHAR(500) NULL,
    rejection_reason        VARCHAR(500) NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_sale_returns_number UNIQUE (return_number),
    CONSTRAINT fk_sale_returns_sale
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_returns_reason
      FOREIGN KEY (reason_id) REFERENCES return_reasons(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_returns_requested_by
      FOREIGN KEY (requested_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_returns_reviewed_by
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_returns_cash_session
      FOREIGN KEY (refund_cash_session_id) REFERENCES cash_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sale_returns_amount CHECK (refund_amount >= 0),
    CONSTRAINT chk_sale_returns_refund CHECK (
         refund_status <> 'REFUNDED'
      OR (status = 'COMPLETED' AND refund_method IS NOT NULL
          AND (refund_method <> 'CASH' OR refund_cash_session_id IS NOT NULL))),
    CONSTRAINT chk_sale_returns_rejected CHECK (
         status <> 'REJECTED' OR (rejection_reason IS NOT NULL AND refund_status = 'NONE')),
    CONSTRAINT chk_sale_returns_review CHECK (status = 'REQUESTED' OR reviewed_by IS NOT NULL),
    INDEX idx_sale_returns_sale (sale_id),
    INDEX idx_sale_returns_status_date (status, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sale_return_items (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sale_return_id      BIGINT UNSIGNED NOT NULL,
    sale_item_batch_id  BIGINT UNSIGNED NOT NULL,   -- identifica venta, producto y lote
    quantity            INT UNSIGNED NOT NULL,
    unit_refund_amount  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    line_refund_amount  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    item_condition      ENUM('RESELLABLE','DAMAGED','EXPIRED','OPENED','NOT_SUITABLE') NOT NULL,
    restock             BOOLEAN GENERATED ALWAYS AS (item_condition = 'RESELLABLE') STORED,
    notes               VARCHAR(255) NULL,
    CONSTRAINT uq_sale_return_items UNIQUE (sale_return_id, sale_item_batch_id),
    CONSTRAINT fk_sale_return_items_return
      FOREIGN KEY (sale_return_id) REFERENCES sale_returns(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_return_items_allocation
      FOREIGN KEY (sale_item_batch_id) REFERENCES sale_item_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sale_return_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_sale_return_items_amount CHECK (unit_refund_amount >= 0
                                                   AND line_refund_amount = quantity * unit_refund_amount),
    INDEX idx_sale_return_items_allocation (sale_item_batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 10. MOVIMIENTOS DE CAJA
-- ============================================================================

CREATE TABLE IF NOT EXISTS cash_movements (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    cash_session_id BIGINT UNSIGNED NOT NULL,
    movement_type   ENUM('SALE_INCOME','PAYMENT_REFUND','RETURN_REFUND','CASH_IN','CASH_OUT') NOT NULL,
    direction       ENUM('IN','OUT') GENERATED ALWAYS AS (
                      IF(movement_type IN ('SALE_INCOME','CASH_IN'), 'IN', 'OUT')) STORED,
    amount          DECIMAL(12,2) NOT NULL,
    payment_id      BIGINT UNSIGNED NULL,
    sale_return_id  BIGINT UNSIGNED NULL,
    description     VARCHAR(255) NULL,
    performed_by    BIGINT UNSIGNED NOT NULL,
    created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT uq_cash_movements_payment UNIQUE (payment_id, movement_type),
    CONSTRAINT uq_cash_movements_return UNIQUE (sale_return_id),
    CONSTRAINT fk_cash_movements_session
      FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cash_movements_payment
      FOREIGN KEY (payment_id) REFERENCES payments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cash_movements_return
      FOREIGN KEY (sale_return_id) REFERENCES sale_returns(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cash_movements_user
      FOREIGN KEY (performed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_cash_movements_amount CHECK (amount > 0),
    CONSTRAINT chk_cash_movements_source CHECK (
         (movement_type IN ('SALE_INCOME','PAYMENT_REFUND') AND payment_id IS NOT NULL AND sale_return_id IS NULL)
      OR (movement_type = 'RETURN_REFUND' AND sale_return_id IS NOT NULL AND payment_id IS NULL)
      OR (movement_type IN ('CASH_IN','CASH_OUT') AND payment_id IS NULL AND sale_return_id IS NULL
          AND description IS NOT NULL)),
    INDEX idx_cash_movements_session (cash_session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 11. TRANSFERENCIAS ENTRE SUCURSALES
-- ============================================================================

CREATE TABLE IF NOT EXISTS branch_transfers (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    transfer_number         VARCHAR(40) NOT NULL,
    origin_branch_id        BIGINT UNSIGNED NOT NULL,
    destination_branch_id   BIGINT UNSIGNED NOT NULL,
    status                  ENUM('DRAFT','IN_TRANSIT','RECEIVED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
    requested_by            BIGINT UNSIGNED NOT NULL,
    requested_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dispatched_by           BIGINT UNSIGNED NULL,
    dispatched_at           DATETIME NULL,
    received_by             BIGINT UNSIGNED NULL,
    received_at             DATETIME NULL,
    cancelled_by            BIGINT UNSIGNED NULL,
    cancelled_at            DATETIME NULL,
    notes                   VARCHAR(500) NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_branch_transfers_number UNIQUE (transfer_number),
    CONSTRAINT fk_branch_transfers_origin
      FOREIGN KEY (origin_branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_transfers_destination
      FOREIGN KEY (destination_branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_transfers_requested_by
      FOREIGN KEY (requested_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_transfers_dispatched_by
      FOREIGN KEY (dispatched_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_transfers_received_by
      FOREIGN KEY (received_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_transfers_cancelled_by
      FOREIGN KEY (cancelled_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_branch_transfers_branches CHECK (origin_branch_id <> destination_branch_id),
    CONSTRAINT chk_branch_transfers_state CHECK (
         (status = 'DRAFT')
      OR (status = 'IN_TRANSIT' AND dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL)
      OR (status = 'RECEIVED'   AND dispatched_at IS NOT NULL AND received_by IS NOT NULL AND received_at IS NOT NULL)
      OR (status = 'CANCELLED'  AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)),
    INDEX idx_branch_transfers_origin (origin_branch_id, status),
    INDEX idx_branch_transfers_destination (destination_branch_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS branch_transfer_items (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    transfer_id             BIGINT UNSIGNED NOT NULL,
    product_id              BIGINT UNSIGNED NOT NULL,
    origin_batch_id         BIGINT UNSIGNED NOT NULL,
    destination_batch_id    BIGINT UNSIGNED NULL,     -- lote creado/usado en la sucursal destino
    quantity                INT UNSIGNED NOT NULL,
    received_quantity       INT UNSIGNED NULL,
    discrepancy_note        VARCHAR(255) NULL,
    CONSTRAINT uq_branch_transfer_items UNIQUE (transfer_id, origin_batch_id),
    CONSTRAINT fk_branch_transfer_items_transfer
      FOREIGN KEY (transfer_id) REFERENCES branch_transfers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_transfer_items_product
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_transfer_items_origin_batch
      FOREIGN KEY (origin_batch_id) REFERENCES product_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_transfer_items_destination_batch
      FOREIGN KEY (destination_batch_id) REFERENCES product_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_branch_transfer_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_branch_transfer_items_received CHECK (received_quantity IS NULL OR received_quantity <= quantity),
    CONSTRAINT chk_branch_transfer_items_discrepancy CHECK (
         received_quantity IS NULL OR received_quantity = quantity OR discrepancy_note IS NOT NULL),
    INDEX idx_branch_transfer_items_product (product_id),
    INDEX idx_branch_transfer_items_dest_batch (destination_batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 12. KARDEX: MOVIMIENTOS DE INVENTARIO (única vía para cambiar stock)
-- ============================================================================

CREATE TABLE IF NOT EXISTS inventory_movements (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    branch_id           BIGINT UNSIGNED NOT NULL,   -- se completa desde el lote si se omite
    product_id          BIGINT UNSIGNED NOT NULL,   -- se completa desde el lote si se omite
    batch_id            BIGINT UNSIGNED NOT NULL,
    movement_type       ENUM('PURCHASE_ENTRY','SALE_OUT','SALE_VOID_IN','RETURN_IN',
                             'TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT_IN','ADJUSTMENT_OUT',
                             'EXPIRED_WRITE_OFF','DAMAGE_WRITE_OFF') NOT NULL,
    direction           ENUM('IN','OUT') GENERATED ALWAYS AS (
                          IF(movement_type IN ('PURCHASE_ENTRY','SALE_VOID_IN','RETURN_IN',
                                               'TRANSFER_IN','ADJUSTMENT_IN'), 'IN', 'OUT')) STORED,
    quantity            INT UNSIGNED NOT NULL,
    stock_before        INT UNSIGNED NOT NULL,   -- stock físico del producto en la sucursal (todos los lotes)
    stock_after         INT UNSIGNED NOT NULL,
    batch_stock_before  INT UNSIGNED NOT NULL,   -- existencia del lote
    batch_stock_after   INT UNSIGNED NOT NULL,
    reason              VARCHAR(500) NULL,
    performed_by        BIGINT UNSIGNED NOT NULL,
    -- Documento de origen (exactamente uno, según el tipo)
    stock_entry_item_id BIGINT UNSIGNED NULL,
    sale_item_batch_id  BIGINT UNSIGNED NULL,
    sale_return_item_id BIGINT UNSIGNED NULL,
    transfer_item_id    BIGINT UNSIGNED NULL,
    adjustment_id       BIGINT UNSIGNED NULL,
    request_id          VARCHAR(64) NULL,
    created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    -- Garantías de "una sola vez"
    CONSTRAINT uq_movements_entry_item UNIQUE (stock_entry_item_id),
    CONSTRAINT uq_movements_sale_alloc UNIQUE (sale_item_batch_id, movement_type),
    CONSTRAINT uq_movements_return_item UNIQUE (sale_return_item_id),
    CONSTRAINT uq_movements_transfer_item UNIQUE (transfer_item_id, movement_type),
    CONSTRAINT uq_movements_adjustment_batch UNIQUE (adjustment_id, batch_id),
    CONSTRAINT fk_movements_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_movements_product
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_movements_batch
      FOREIGN KEY (batch_id) REFERENCES product_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_movements_user
      FOREIGN KEY (performed_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_movements_entry_item
      FOREIGN KEY (stock_entry_item_id) REFERENCES stock_entry_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_movements_sale_alloc
      FOREIGN KEY (sale_item_batch_id) REFERENCES sale_item_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_movements_return_item
      FOREIGN KEY (sale_return_item_id) REFERENCES sale_return_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_movements_transfer_item
      FOREIGN KEY (transfer_item_id) REFERENCES branch_transfer_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_movements_adjustment
      FOREIGN KEY (adjustment_id) REFERENCES inventory_adjustments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_movements_quantity CHECK (quantity > 0),
    CONSTRAINT chk_movements_single_source CHECK (
        (stock_entry_item_id IS NOT NULL) + (sale_item_batch_id IS NOT NULL)
      + (sale_return_item_id IS NOT NULL) + (transfer_item_id IS NOT NULL)
      + (adjustment_id IS NOT NULL) = 1),
    CONSTRAINT chk_movements_source_type CHECK (
         (movement_type = 'PURCHASE_ENTRY' AND stock_entry_item_id IS NOT NULL)
      OR (movement_type IN ('SALE_OUT','SALE_VOID_IN') AND sale_item_batch_id IS NOT NULL)
      OR (movement_type = 'RETURN_IN' AND sale_return_item_id IS NOT NULL)
      OR (movement_type IN ('TRANSFER_OUT','TRANSFER_IN') AND transfer_item_id IS NOT NULL)
      OR (movement_type IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT','EXPIRED_WRITE_OFF','DAMAGE_WRITE_OFF')
          AND adjustment_id IS NOT NULL)),
    CONSTRAINT chk_movements_arithmetic CHECK (
         (direction = 'IN'  AND stock_after = stock_before + quantity
                            AND batch_stock_after = batch_stock_before + quantity)
      OR (direction = 'OUT' AND stock_before = stock_after + quantity
                            AND batch_stock_before = batch_stock_after + quantity)),
    INDEX idx_movements_branch_product_date (branch_id, product_id, created_at),
    INDEX idx_movements_batch_date (batch_id, created_at),
    INDEX idx_movements_type_date (movement_type, created_at),
    INDEX idx_movements_user_date (performed_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 13. ALERTAS DE STOCK Y VENCIMIENTO
-- ============================================================================

CREATE TABLE IF NOT EXISTS stock_alerts (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    branch_id               BIGINT UNSIGNED NOT NULL,
    product_id              BIGINT UNSIGNED NOT NULL,
    batch_id                BIGINT UNSIGNED NULL,   -- solo alertas de vencimiento
    alert_type              ENUM('LOW_STOCK','OUT_OF_STOCK','EXPIRING_SOON','EXPIRED') NOT NULL,
    status                  ENUM('OPEN','RESOLVED','DISMISSED') NOT NULL DEFAULT 'OPEN',
    stock_at_alert          INT UNSIGNED NOT NULL,
    threshold_at_alert      INT UNSIGNED NULL,
    expiry_date_at_alert    DATE NULL,
    message                 VARCHAR(255) NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    resolved_at             DATETIME NULL,
    resolved_by             BIGINT UNSIGNED NULL,   -- NULL + resolved_at = resuelta automáticamente
    resolution_note         VARCHAR(255) NULL,
    batch_key               BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(batch_id, 0)) STORED,
    open_flag               TINYINT GENERATED ALWAYS AS (IF(status = 'OPEN', 1, NULL)) STORED,
    -- Evita alertas ABIERTAS duplicadas (las cerradas pueden repetirse en el historial)
    CONSTRAINT uq_stock_alerts_open UNIQUE (branch_id, product_id, alert_type, batch_key, open_flag),
    CONSTRAINT fk_stock_alerts_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_alerts_product
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_alerts_batch
      FOREIGN KEY (batch_id) REFERENCES product_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_alerts_user
      FOREIGN KEY (resolved_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_alerts_batch CHECK ((alert_type IN ('EXPIRING_SOON','EXPIRED')) = (batch_id IS NOT NULL)),
    CONSTRAINT chk_stock_alerts_resolution CHECK ((status = 'OPEN') = (resolved_at IS NULL)),
    INDEX idx_stock_alerts_status_date (status, created_at),
    INDEX idx_stock_alerts_branch_status (branch_id, status, alert_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 14. AUDITORÍA
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NULL,
    branch_id       BIGINT UNSIGNED NULL,
    action          VARCHAR(40)  NOT NULL,     -- CREATE, UPDATE, DELETE, LOGIN, VOID, GRANT, REVOKE...
    module          VARCHAR(60)  NOT NULL,
    entity_table    VARCHAR(64)  NULL,
    entity_id       VARCHAR(64)  NULL,
    old_values      JSON NULL,
    new_values      JSON NULL,
    ip_address      VARCHAR(45)  NULL,
    user_agent      VARCHAR(255) NULL,
    request_id      VARCHAR(64)  NULL,
    session_ref     VARCHAR(64)  NULL,         -- identificador NO secreto (nunca el token)
    created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_audit_logs_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_audit_logs_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_audit_logs_no_secrets_old CHECK (old_values IS NULL OR JSON_CONTAINS_PATH(old_values, 'one',
      '$.password', '$.password_hash', '$.token', '$.access_token', '$.refresh_token', '$.secret') = 0),
    CONSTRAINT chk_audit_logs_no_secrets_new CHECK (new_values IS NULL OR JSON_CONTAINS_PATH(new_values, 'one',
      '$.password', '$.password_hash', '$.token', '$.access_token', '$.refresh_token', '$.secret') = 0),
    INDEX idx_audit_logs_user_date (user_id, created_at),
    INDEX idx_audit_logs_module_date (module, created_at),
    INDEX idx_audit_logs_entity (entity_table, entity_id),
    INDEX idx_audit_logs_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 15. PROCEDIMIENTOS ALMACENADOS DE APOYO
-- ============================================================================

DROP PROCEDURE IF EXISTS sp_audit;
DROP PROCEDURE IF EXISTS sp_next_document_number;
DROP PROCEDURE IF EXISTS sp_refresh_expiry_alerts;
DROP PROCEDURE IF EXISTS sp_set_app_context;

DELIMITER $$

-- Registra una entrada de auditoría usando el contexto de la conexión.
CREATE PROCEDURE sp_audit(
    IN p_action VARCHAR(40), IN p_module VARCHAR(60), IN p_table VARCHAR(64),
    IN p_entity_id VARCHAR(64), IN p_old JSON, IN p_new JSON)
BEGIN
    INSERT INTO audit_logs (user_id, branch_id, action, module, entity_table, entity_id,
                            old_values, new_values, ip_address, user_agent, request_id, session_ref)
    VALUES (@app_user_id, @app_branch_id, p_action, p_module, p_table, p_entity_id,
            p_old, p_new, @app_ip_address, @app_user_agent, @app_request_id, @app_session_ref);
END$$

-- Fija el contexto de la petición (llamar al inicio de cada request del backend).
CREATE PROCEDURE sp_set_app_context(
    IN p_user_id BIGINT UNSIGNED, IN p_branch_id BIGINT UNSIGNED,
    IN p_request_id VARCHAR(64), IN p_ip VARCHAR(45))
BEGIN
    SET @app_user_id    = p_user_id;
    SET @app_branch_id  = p_branch_id;
    SET @app_request_id = p_request_id;
    SET @app_ip_address = p_ip;
END$$

-- Genera el siguiente número de documento de forma segura ante concurrencia.
-- Debe llamarse DENTRO de la transacción del documento.
CREATE PROCEDURE sp_next_document_number(
    IN p_branch_id BIGINT UNSIGNED, IN p_document_type VARCHAR(30), OUT p_number VARCHAR(40))
BEGIN
    DECLARE v_prefix VARCHAR(30);
    DECLARE v_next BIGINT UNSIGNED;
    DECLARE v_padding TINYINT UNSIGNED;

    SELECT prefix, next_number, padding INTO v_prefix, v_next, v_padding
      FROM document_sequences
     WHERE branch_id = p_branch_id AND document_type = p_document_type
       FOR UPDATE;

    IF v_prefix IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no existe secuencia para esa sucursal y tipo de documento';
    END IF;

    UPDATE document_sequences SET next_number = next_number + 1
     WHERE branch_id = p_branch_id AND document_type = p_document_type;

    SET p_number = CONCAT(v_prefix, LPAD(v_next, v_padding, '0'));
END$$

-- Crea/resuelve alertas de vencimiento. Ejecutar a diario (cron del backend
-- o el EVENT opcional documentado al final del archivo).
CREATE PROCEDURE sp_refresh_expiry_alerts()
BEGIN
    DECLARE v_days INT DEFAULT 90;

    SELECT CAST(setting_value AS SIGNED) INTO v_days
      FROM settings WHERE setting_key = 'inventory.expiry_alert_days';

    -- 1) Resolver alertas de lotes agotados, bloqueados o que cambiaron de categoría
    UPDATE stock_alerts sa
      JOIN product_batches pb ON pb.id = sa.batch_id
       SET sa.status = 'RESOLVED', sa.resolved_at = NOW(),
           sa.resolution_note = 'Resuelta automáticamente: lote sin existencias o reclasificado'
     WHERE sa.status = 'OPEN'
       AND sa.alert_type IN ('EXPIRING_SOON','EXPIRED')
       AND (pb.current_quantity = 0
            OR (sa.alert_type = 'EXPIRING_SOON' AND pb.expiry_date <= CURDATE()));

    -- 2) Lotes vencidos con existencias
    INSERT INTO stock_alerts (branch_id, product_id, batch_id, alert_type, stock_at_alert,
                              expiry_date_at_alert, message)
    SELECT pb.branch_id, pb.product_id, pb.id, 'EXPIRED', pb.current_quantity, pb.expiry_date,
           CONCAT('Lote ', pb.batch_number, ' vencido el ', DATE_FORMAT(pb.expiry_date, '%d/%m/%Y'))
      FROM product_batches pb
     WHERE pb.current_quantity > 0 AND pb.expiry_date <= CURDATE()
    ON DUPLICATE KEY UPDATE stock_at_alert = pb.current_quantity;

    -- 3) Lotes próximos a vencer
    INSERT INTO stock_alerts (branch_id, product_id, batch_id, alert_type, stock_at_alert,
                              threshold_at_alert, expiry_date_at_alert, message)
    SELECT pb.branch_id, pb.product_id, pb.id, 'EXPIRING_SOON', pb.current_quantity, v_days, pb.expiry_date,
           CONCAT('Lote ', pb.batch_number, ' vence el ', DATE_FORMAT(pb.expiry_date, '%d/%m/%Y'))
      FROM product_batches pb
     WHERE pb.current_quantity > 0
       AND pb.expiry_date > CURDATE()
       AND pb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL v_days DAY)
    ON DUPLICATE KEY UPDATE stock_at_alert = pb.current_quantity;
END$$

DELIMITER ;

-- ============================================================================
-- 16. TRIGGERS DE INTEGRIDAD Y NEGOCIO
--     Convención de errores: SQLSTATE 45000 y mensajes con prefijo "PP:".
-- ============================================================================

DROP TRIGGER IF EXISTS trg_branches_ai;
DROP TRIGGER IF EXISTS trg_branches_bd;
DROP TRIGGER IF EXISTS trg_users_ai;
DROP TRIGGER IF EXISTS trg_users_au;
DROP TRIGGER IF EXISTS trg_users_bd;
DROP TRIGGER IF EXISTS trg_role_permissions_ai;
DROP TRIGGER IF EXISTS trg_role_permissions_ad;
DROP TRIGGER IF EXISTS trg_user_permissions_ai;
DROP TRIGGER IF EXISTS trg_user_permissions_au;
DROP TRIGGER IF EXISTS trg_user_permissions_ad;
DROP TRIGGER IF EXISTS trg_settings_au;
DROP TRIGGER IF EXISTS trg_products_au;
DROP TRIGGER IF EXISTS trg_products_bd;
DROP TRIGGER IF EXISTS trg_branch_products_au;
DROP TRIGGER IF EXISTS trg_product_batches_bi;
DROP TRIGGER IF EXISTS trg_product_batches_bu;
DROP TRIGGER IF EXISTS trg_stock_entries_bu;
DROP TRIGGER IF EXISTS trg_stock_entries_bd;
DROP TRIGGER IF EXISTS trg_stock_entry_items_bi;
DROP TRIGGER IF EXISTS trg_stock_entry_items_bu;
DROP TRIGGER IF EXISTS trg_stock_entry_items_bd;
DROP TRIGGER IF EXISTS trg_cash_sessions_bi;
DROP TRIGGER IF EXISTS trg_cash_sessions_bu;
DROP TRIGGER IF EXISTS trg_cash_sessions_bd;
DROP TRIGGER IF EXISTS trg_orders_bi;
DROP TRIGGER IF EXISTS trg_orders_ai;
DROP TRIGGER IF EXISTS trg_orders_bu;
DROP TRIGGER IF EXISTS trg_orders_au;
DROP TRIGGER IF EXISTS trg_orders_bd;
DROP TRIGGER IF EXISTS trg_order_items_bi;
DROP TRIGGER IF EXISTS trg_order_items_bu;
DROP TRIGGER IF EXISTS trg_order_items_bd;
DROP TRIGGER IF EXISTS trg_order_status_history_bu;
DROP TRIGGER IF EXISTS trg_order_status_history_bd;
DROP TRIGGER IF EXISTS trg_sales_bi;
DROP TRIGGER IF EXISTS trg_sales_bu;
DROP TRIGGER IF EXISTS trg_sales_bd;
DROP TRIGGER IF EXISTS trg_sale_items_bi;
DROP TRIGGER IF EXISTS trg_sale_items_bu;
DROP TRIGGER IF EXISTS trg_sale_items_bd;
DROP TRIGGER IF EXISTS trg_sale_item_batches_bi;
DROP TRIGGER IF EXISTS trg_sale_item_batches_bu;
DROP TRIGGER IF EXISTS trg_sale_item_batches_bd;
DROP TRIGGER IF EXISTS trg_payments_bi;
DROP TRIGGER IF EXISTS trg_payments_ai;
DROP TRIGGER IF EXISTS trg_payments_bu;
DROP TRIGGER IF EXISTS trg_payments_au;
DROP TRIGGER IF EXISTS trg_payments_bd;
DROP TRIGGER IF EXISTS trg_sale_tickets_bi;
DROP TRIGGER IF EXISTS trg_sale_tickets_bd;
DROP TRIGGER IF EXISTS trg_sale_voids_bi;
DROP TRIGGER IF EXISTS trg_sale_voids_ai;
DROP TRIGGER IF EXISTS trg_sale_voids_bu;
DROP TRIGGER IF EXISTS trg_sale_voids_bd;
DROP TRIGGER IF EXISTS trg_sale_returns_bi;
DROP TRIGGER IF EXISTS trg_sale_returns_bu;
DROP TRIGGER IF EXISTS trg_sale_returns_au;
DROP TRIGGER IF EXISTS trg_sale_returns_bd;
DROP TRIGGER IF EXISTS trg_sale_return_items_bi;
DROP TRIGGER IF EXISTS trg_sale_return_items_bu;
DROP TRIGGER IF EXISTS trg_sale_return_items_bd;
DROP TRIGGER IF EXISTS trg_cash_movements_bi;
DROP TRIGGER IF EXISTS trg_cash_movements_bu;
DROP TRIGGER IF EXISTS trg_cash_movements_bd;
DROP TRIGGER IF EXISTS trg_branch_transfers_bi;
DROP TRIGGER IF EXISTS trg_branch_transfers_bu;
DROP TRIGGER IF EXISTS trg_branch_transfers_bd;
DROP TRIGGER IF EXISTS trg_branch_transfer_items_bi;
DROP TRIGGER IF EXISTS trg_branch_transfer_items_bu;
DROP TRIGGER IF EXISTS trg_branch_transfer_items_bd;
DROP TRIGGER IF EXISTS trg_inventory_movements_bi;
DROP TRIGGER IF EXISTS trg_inventory_movements_ai;
DROP TRIGGER IF EXISTS trg_inventory_movements_bu;
DROP TRIGGER IF EXISTS trg_inventory_movements_bd;
DROP TRIGGER IF EXISTS trg_stock_alerts_bd;
DROP TRIGGER IF EXISTS trg_audit_logs_bu;
DROP TRIGGER IF EXISTS trg_audit_logs_bd;

DELIMITER $$

-- ---------------------------------------------------------------------------
-- 16.1 Sucursales, usuarios, permisos y configuración
-- ---------------------------------------------------------------------------

-- Al crear una sucursal se crean sus secuencias de numeración.
CREATE TRIGGER trg_branches_ai AFTER INSERT ON branches FOR EACH ROW
BEGIN
    INSERT INTO document_sequences (branch_id, document_type, prefix) VALUES
      (NEW.id, 'SALE',         CONCAT('V-',  NEW.code, '-')),
      (NEW.id, 'TICKET',       CONCAT('T-',  NEW.code, '-')),
      (NEW.id, 'ORDER',        CONCAT('P-',  NEW.code, '-')),
      (NEW.id, 'STOCK_ENTRY',  CONCAT('E-',  NEW.code, '-')),
      (NEW.id, 'TRANSFER',     CONCAT('TR-', NEW.code, '-')),
      (NEW.id, 'RETURN',       CONCAT('D-',  NEW.code, '-')),
      (NEW.id, 'ADJUSTMENT',   CONCAT('AJ-', NEW.code, '-')),
      (NEW.id, 'CASH_SESSION', CONCAT('C-',  NEW.code, '-')),
      (NEW.id, 'PAYMENT',      CONCAT('PG-', NEW.code, '-'));
    CALL sp_audit('CREATE', 'branches', 'branches', NEW.id, NULL,
                  JSON_OBJECT('code', NEW.code, 'name', NEW.name, 'is_main', NEW.is_main));
END$$

CREATE TRIGGER trg_branches_bd BEFORE DELETE ON branches FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las sucursales no se eliminan; cambie status a INACTIVE';
END$$

CREATE TRIGGER trg_users_ai AFTER INSERT ON users FOR EACH ROW
BEGIN
    CALL sp_audit('CREATE', 'users', 'users', NEW.id, NULL,
                  JSON_OBJECT('email', NEW.email, 'full_name', NEW.full_name,
                              'role_id', NEW.role_id, 'status', NEW.status));
END$$

CREATE TRIGGER trg_users_au AFTER UPDATE ON users FOR EACH ROW
BEGIN
    -- Nunca se registra el hash; solo se indica que cambió.
    IF NOT (OLD.role_id <=> NEW.role_id) OR NOT (OLD.status <=> NEW.status)
       OR NOT (OLD.email <=> NEW.email) OR NOT (OLD.full_name <=> NEW.full_name)
       OR NOT (OLD.password_hash <=> NEW.password_hash) THEN
        CALL sp_audit('UPDATE', 'users', 'users', NEW.id,
             JSON_OBJECT('email', OLD.email, 'full_name', OLD.full_name, 'role_id', OLD.role_id, 'status', OLD.status),
             JSON_OBJECT('email', NEW.email, 'full_name', NEW.full_name, 'role_id', NEW.role_id, 'status', NEW.status,
                         'password_changed', NOT (OLD.password_hash <=> NEW.password_hash)));
    END IF;
END$$

CREATE TRIGGER trg_users_bd BEFORE DELETE ON users FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los usuarios no se eliminan; cambie status a INACTIVE o BLOCKED';
END$$

CREATE TRIGGER trg_role_permissions_ai AFTER INSERT ON role_permissions FOR EACH ROW
BEGIN
    CALL sp_audit('GRANT', 'security', 'role_permissions', CONCAT(NEW.role_id, ':', NEW.permission_id), NULL,
                  JSON_OBJECT('role_id', NEW.role_id, 'permission_id', NEW.permission_id));
END$$

CREATE TRIGGER trg_role_permissions_ad AFTER DELETE ON role_permissions FOR EACH ROW
BEGIN
    CALL sp_audit('REVOKE', 'security', 'role_permissions', CONCAT(OLD.role_id, ':', OLD.permission_id),
                  JSON_OBJECT('role_id', OLD.role_id, 'permission_id', OLD.permission_id), NULL);
END$$

CREATE TRIGGER trg_user_permissions_ai AFTER INSERT ON user_permissions FOR EACH ROW
BEGIN
    CALL sp_audit(NEW.effect, 'security', 'user_permissions', CONCAT(NEW.user_id, ':', NEW.permission_id), NULL,
                  JSON_OBJECT('user_id', NEW.user_id, 'permission_id', NEW.permission_id, 'effect', NEW.effect));
END$$

CREATE TRIGGER trg_user_permissions_au AFTER UPDATE ON user_permissions FOR EACH ROW
BEGIN
    CALL sp_audit('UPDATE', 'security', 'user_permissions', CONCAT(NEW.user_id, ':', NEW.permission_id),
                  JSON_OBJECT('effect', OLD.effect), JSON_OBJECT('effect', NEW.effect));
END$$

CREATE TRIGGER trg_user_permissions_ad AFTER DELETE ON user_permissions FOR EACH ROW
BEGIN
    CALL sp_audit('REVOKE', 'security', 'user_permissions', CONCAT(OLD.user_id, ':', OLD.permission_id),
                  JSON_OBJECT('user_id', OLD.user_id, 'permission_id', OLD.permission_id, 'effect', OLD.effect), NULL);
END$$

CREATE TRIGGER trg_settings_au AFTER UPDATE ON settings FOR EACH ROW
BEGIN
    IF NOT (OLD.setting_value <=> NEW.setting_value) THEN
        CALL sp_audit('UPDATE', 'settings', 'settings', NEW.setting_key,
                      JSON_OBJECT('value', OLD.setting_value), JSON_OBJECT('value', NEW.setting_value));
    END IF;
END$$

-- ---------------------------------------------------------------------------
-- 16.2 Productos y configuración por sucursal
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_products_au AFTER UPDATE ON products FOR EACH ROW
BEGIN
    IF NOT (OLD.sale_price <=> NEW.sale_price) OR NOT (OLD.purchase_price <=> NEW.purchase_price)
       OR NOT (OLD.status <=> NEW.status) OR NOT (OLD.requires_prescription <=> NEW.requires_prescription) THEN
        CALL sp_audit('UPDATE', 'products', 'products', NEW.id,
             JSON_OBJECT('sale_price', OLD.sale_price, 'purchase_price', OLD.purchase_price,
                         'status', OLD.status, 'requires_prescription', OLD.requires_prescription),
             JSON_OBJECT('sale_price', NEW.sale_price, 'purchase_price', NEW.purchase_price,
                         'status', NEW.status, 'requires_prescription', NEW.requires_prescription));
    END IF;
END$$

CREATE TRIGGER trg_products_bd BEFORE DELETE ON products FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los productos no se eliminan; cambie status a INACTIVE o DISCONTINUED';
END$$

CREATE TRIGGER trg_branch_products_au AFTER UPDATE ON branch_products FOR EACH ROW
BEGIN
    IF NOT (OLD.sale_price <=> NEW.sale_price) OR NOT (OLD.minimum_stock <=> NEW.minimum_stock)
       OR NOT (OLD.is_available <=> NEW.is_available) THEN
        CALL sp_audit('UPDATE', 'inventory', 'branch_products', NEW.id,
             JSON_OBJECT('sale_price', OLD.sale_price, 'minimum_stock', OLD.minimum_stock, 'is_available', OLD.is_available),
             JSON_OBJECT('sale_price', NEW.sale_price, 'minimum_stock', NEW.minimum_stock, 'is_available', NEW.is_available));
    END IF;
END$$

-- ---------------------------------------------------------------------------
-- 16.3 Lotes: nacen vacíos y su stock solo cambia por inventory_movements
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_product_batches_bi BEFORE INSERT ON product_batches FOR EACH ROW
BEGIN
    DECLARE v_entry_branch BIGINT UNSIGNED;

    IF NEW.current_quantity <> 0 OR NEW.received_quantity <> 0 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'PP: un lote se crea con existencia 0; el stock ingresa con inventory_movements';
    END IF;
    IF NEW.stock_entry_id IS NOT NULL THEN
        SELECT branch_id INTO v_entry_branch FROM stock_entries WHERE id = NEW.stock_entry_id;
        IF v_entry_branch <> NEW.branch_id THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la entrada del lote pertenece a otra sucursal';
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_product_batches_bu BEFORE UPDATE ON product_batches FOR EACH ROW
BEGIN
    IF NEW.current_quantity <> OLD.current_quantity OR NEW.received_quantity <> OLD.received_quantity THEN
        IF COALESCE(@pp_stock_write, 0) <> 1 THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'PP: el stock del lote solo cambia insertando en inventory_movements';
        END IF;
        SET @pp_stock_write = NULL;   -- la autorización se consume en un solo UPDATE
    END IF;

    IF NEW.product_id <> OLD.product_id OR NEW.branch_id <> OLD.branch_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se puede cambiar el producto ni la sucursal de un lote';
    END IF;

    IF (NEW.batch_number <> OLD.batch_number OR NEW.expiry_date <> OLD.expiry_date)
       AND EXISTS (SELECT 1 FROM inventory_movements WHERE batch_id = OLD.id) THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'PP: lote con movimientos; no se puede cambiar su número ni su vencimiento';
    END IF;
END$$

-- ---------------------------------------------------------------------------
-- 16.4 Entradas de mercadería
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_stock_entries_bu BEFORE UPDATE ON stock_entries FOR EACH ROW
BEGIN
    DECLARE v_pending INT DEFAULT 0;
    DECLARE v_moves INT DEFAULT 0;

    IF OLD.status IN ('POSTED','CANCELLED') AND (NEW.status <> OLD.status
       OR NEW.branch_id <> OLD.branch_id OR NOT (NEW.supplier_id <=> OLD.supplier_id)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: una entrada contabilizada o anulada no se modifica';
    END IF;

    IF OLD.status = 'DRAFT' AND NEW.status = 'POSTED' THEN
        SELECT COUNT(*) INTO v_pending
          FROM stock_entry_items sei
         WHERE sei.stock_entry_id = NEW.id
           AND NOT EXISTS (SELECT 1 FROM inventory_movements im WHERE im.stock_entry_item_id = sei.id);
        IF v_pending > 0 OR NOT EXISTS (SELECT 1 FROM stock_entry_items WHERE stock_entry_id = NEW.id) THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'PP: para contabilizar, cada línea debe tener su movimiento PURCHASE_ENTRY';
        END IF;
        SET NEW.total_cost = (SELECT COALESCE(SUM(line_total), 0) FROM stock_entry_items WHERE stock_entry_id = NEW.id);
        IF NEW.posted_at IS NULL THEN SET NEW.posted_at = NOW(); END IF;
    END IF;

    IF OLD.status = 'DRAFT' AND NEW.status = 'CANCELLED' THEN
        SELECT COUNT(*) INTO v_moves
          FROM inventory_movements im
          JOIN stock_entry_items sei ON sei.id = im.stock_entry_item_id
         WHERE sei.stock_entry_id = NEW.id;
        IF v_moves > 0 THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'PP: la entrada ya movió stock; revierta con un ajuste ADJUSTMENT_OUT';
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_stock_entries_bd BEFORE DELETE ON stock_entries FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las entradas no se eliminan; use status CANCELLED';
END$$

CREATE TRIGGER trg_stock_entry_items_bi BEFORE INSERT ON stock_entry_items FOR EACH ROW
BEGIN
    DECLARE v_entry_branch BIGINT UNSIGNED;
    DECLARE v_entry_status VARCHAR(20);
    DECLARE v_batch_branch BIGINT UNSIGNED;
    DECLARE v_batch_product BIGINT UNSIGNED;

    SELECT branch_id, status INTO v_entry_branch, v_entry_status FROM stock_entries WHERE id = NEW.stock_entry_id;
    SELECT branch_id, product_id INTO v_batch_branch, v_batch_product FROM product_batches WHERE id = NEW.batch_id;

    IF v_entry_status <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se agregan líneas a entradas en estado DRAFT';
    END IF;
    IF v_batch_branch <> v_entry_branch OR v_batch_product <> NEW.product_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el lote no coincide con el producto o la sucursal de la entrada';
    END IF;
    SET NEW.line_total = NEW.quantity * NEW.unit_cost;
END$$

CREATE TRIGGER trg_stock_entry_items_bu BEFORE UPDATE ON stock_entry_items FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM inventory_movements WHERE stock_entry_item_id = OLD.id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la línea ya ingresó al inventario y no se modifica';
    END IF;
    IF NEW.batch_id <> OLD.batch_id OR NEW.product_id <> OLD.product_id OR NEW.stock_entry_id <> OLD.stock_entry_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se puede cambiar entrada, producto o lote de la línea';
    END IF;
    SET NEW.line_total = NEW.quantity * NEW.unit_cost;
END$$

CREATE TRIGGER trg_stock_entry_items_bd BEFORE DELETE ON stock_entry_items FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM stock_entries WHERE id = OLD.stock_entry_id AND status <> 'DRAFT') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se eliminan líneas de entradas en DRAFT';
    END IF;
END$$

-- ---------------------------------------------------------------------------
-- 16.5 Caja
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_cash_sessions_bi BEFORE INSERT ON cash_sessions FOR EACH ROW
BEGIN
    DECLARE v_branch BIGINT UNSIGNED;
    DECLARE v_active BOOLEAN;

    IF NEW.status <> 'OPEN' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: una sesión de caja se crea en estado OPEN';
    END IF;
    SELECT branch_id, is_active INTO v_branch, v_active FROM cash_registers WHERE id = NEW.cash_register_id;
    IF NOT v_active THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la caja está inactiva';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM user_branches WHERE user_id = NEW.opened_by AND branch_id = v_branch) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el trabajador no está asignado a la sucursal de la caja';
    END IF;
END$$

CREATE TRIGGER trg_cash_sessions_bu BEFORE UPDATE ON cash_sessions FOR EACH ROW
BEGIN
    DECLARE v_in  DECIMAL(12,2) DEFAULT 0;
    DECLARE v_out DECIMAL(12,2) DEFAULT 0;

    IF OLD.status = 'CLOSED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: una caja cerrada no se reabre ni se modifica';
    END IF;
    IF NEW.opening_amount <> OLD.opening_amount OR NEW.opened_by <> OLD.opened_by
       OR NEW.cash_register_id <> OLD.cash_register_id OR NEW.opened_at <> OLD.opened_at THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los datos de apertura no se modifican';
    END IF;

    IF OLD.status = 'OPEN' AND NEW.status = 'CLOSED' THEN
        SELECT COALESCE(SUM(CASE WHEN direction = 'IN'  THEN amount END), 0),
               COALESCE(SUM(CASE WHEN direction = 'OUT' THEN amount END), 0)
          INTO v_in, v_out
          FROM cash_movements WHERE cash_session_id = OLD.id;
        SET NEW.expected_amount = OLD.opening_amount + v_in - v_out;   -- siempre calculado
        IF NEW.closed_at IS NULL THEN SET NEW.closed_at = NOW(); END IF;
        IF NEW.closed_by IS NULL THEN SET NEW.closed_by = @app_user_id; END IF;
        CALL sp_audit('CLOSE', 'cash', 'cash_sessions', OLD.id,
             JSON_OBJECT('status', 'OPEN'),
             JSON_OBJECT('status', 'CLOSED', 'expected_amount', NEW.expected_amount,
                         'counted_amount', NEW.counted_amount));
    END IF;
END$$

CREATE TRIGGER trg_cash_sessions_bd BEFORE DELETE ON cash_sessions FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las sesiones de caja no se eliminan';
END$$

CREATE TRIGGER trg_cash_movements_bi BEFORE INSERT ON cash_movements FOR EACH ROW
BEGIN
    DECLARE v_status VARCHAR(10);
    DECLARE v_balance DECIMAL(12,2);

    SELECT status INTO v_status FROM cash_sessions WHERE id = NEW.cash_session_id FOR UPDATE;
    IF v_status IS NULL OR v_status <> 'OPEN' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se registran movimientos en una caja cerrada';
    END IF;

    IF NEW.movement_type IN ('PAYMENT_REFUND','RETURN_REFUND','CASH_OUT') THEN
        SELECT cs.opening_amount
               + COALESCE(SUM(CASE WHEN cm.direction = 'IN'  THEN cm.amount END), 0)
               - COALESCE(SUM(CASE WHEN cm.direction = 'OUT' THEN cm.amount END), 0)
          INTO v_balance
          FROM cash_sessions cs
          LEFT JOIN cash_movements cm ON cm.cash_session_id = cs.id
         WHERE cs.id = NEW.cash_session_id
         GROUP BY cs.id, cs.opening_amount;
        IF NEW.amount > v_balance THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: efectivo insuficiente en caja para esta salida';
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_cash_movements_bu BEFORE UPDATE ON cash_movements FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los movimientos de caja son inmutables; registre un contramovimiento';
END$$

CREATE TRIGGER trg_cash_movements_bd BEFORE DELETE ON cash_movements FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los movimientos de caja no se eliminan';
END$$

-- ---------------------------------------------------------------------------
-- 16.6 Pedidos
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_orders_bi BEFORE INSERT ON orders FOR EACH ROW
BEGIN
    DECLARE v_addr_customer BIGINT UNSIGNED;

    IF NEW.status <> 'PENDING' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: un pedido se crea en estado PENDING';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM branches WHERE id = NEW.branch_id AND status = 'ACTIVE') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la sucursal del pedido no está activa';
    END IF;

    IF NEW.address_id IS NOT NULL THEN
        SELECT customer_id INTO v_addr_customer FROM customer_addresses WHERE id = NEW.address_id;
        IF v_addr_customer <> NEW.customer_id THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la dirección no pertenece al cliente';
        END IF;
        IF NEW.fulfillment_type = 'DELIVERY' AND NEW.delivery_address_line IS NULL THEN
            SET NEW.delivery_recipient_name = (SELECT recipient_name FROM customer_addresses WHERE id = NEW.address_id);
            SET NEW.delivery_phone          = (SELECT phone          FROM customer_addresses WHERE id = NEW.address_id);
            SET NEW.delivery_address_line   = (SELECT address_line   FROM customer_addresses WHERE id = NEW.address_id);
            SET NEW.delivery_reference      = (SELECT reference_note FROM customer_addresses WHERE id = NEW.address_id);
            SET NEW.delivery_district       = (SELECT district       FROM customer_addresses WHERE id = NEW.address_id);
            SET NEW.delivery_province       = (SELECT province       FROM customer_addresses WHERE id = NEW.address_id);
            SET NEW.delivery_department     = (SELECT department     FROM customer_addresses WHERE id = NEW.address_id);
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_orders_ai AFTER INSERT ON orders FOR EACH ROW
BEGIN
    INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
    VALUES (NEW.id, NULL, NEW.status, @app_user_id, 'Pedido creado');
END$$

CREATE TRIGGER trg_orders_bu BEFORE UPDATE ON orders FOR EACH ROW
BEGIN
    DECLARE v_ok BOOLEAN DEFAULT FALSE;

    IF OLD.status IN ('COMPLETED','CANCELLED','REJECTED') AND NEW.status <> OLD.status THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el pedido está en un estado final';
    END IF;

    IF OLD.status <> 'PENDING' AND (NEW.subtotal <> OLD.subtotal OR NEW.total <> OLD.total
       OR NEW.discount_total <> OLD.discount_total OR NEW.delivery_fee <> OLD.delivery_fee
       OR NEW.branch_id <> OLD.branch_id OR NEW.customer_id <> OLD.customer_id
       OR NEW.fulfillment_type <> OLD.fulfillment_type) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: importes, sucursal y modalidad solo cambian en PENDING';
    END IF;

    IF NEW.status <> OLD.status THEN
        SET v_ok = CASE
            WHEN OLD.status = 'PENDING'          AND NEW.status IN ('CONFIRMED','CANCELLED','REJECTED') THEN TRUE
            WHEN OLD.status = 'CONFIRMED'        AND NEW.status IN ('PREPARING','CANCELLED') THEN TRUE
            WHEN OLD.status = 'PREPARING'        AND NEW.status IN ('READY_FOR_PICKUP','OUT_FOR_DELIVERY','CANCELLED') THEN TRUE
            WHEN OLD.status = 'READY_FOR_PICKUP' AND NEW.status IN ('COMPLETED','CANCELLED') THEN TRUE
            WHEN OLD.status = 'OUT_FOR_DELIVERY' AND NEW.status IN ('COMPLETED','CANCELLED') THEN TRUE
            ELSE FALSE END;
        IF NOT v_ok THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: transición de estado de pedido no permitida';
        END IF;

        -- Confirmar = la venta (con su salida de inventario) ya fue registrada en esta transacción.
        IF NEW.status = 'CONFIRMED' THEN
            IF NOT EXISTS (SELECT 1 FROM sales WHERE order_id = NEW.id AND status = 'COMPLETED') THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = 'PP: registre primero la venta del pedido (descuenta stock) y luego confirme';
            END IF;
            SET NEW.confirmed_at = COALESCE(NEW.confirmed_at, NOW());
            SET NEW.confirmed_by = COALESCE(NEW.confirmed_by, @app_user_id);
        END IF;

        -- No se cancela un pedido cuya venta sigue vigente: primero se anula la venta (repone stock).
        IF NEW.status IN ('CANCELLED','REJECTED') THEN
            IF EXISTS (SELECT 1 FROM sales WHERE order_id = NEW.id AND status = 'COMPLETED') THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: anule primero la venta asociada al pedido';
            END IF;
            SET NEW.cancelled_at = COALESCE(NEW.cancelled_at, NOW());
            SET NEW.cancelled_by = COALESCE(NEW.cancelled_by, @app_user_id);
        END IF;

        IF NEW.status = 'COMPLETED' THEN
            SET NEW.completed_at = COALESCE(NEW.completed_at, NOW());
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_orders_au AFTER UPDATE ON orders FOR EACH ROW
BEGIN
    IF NEW.status <> OLD.status THEN
        INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
        VALUES (NEW.id, OLD.status, NEW.status, @app_user_id,
                CASE WHEN NEW.status IN ('CANCELLED','REJECTED') THEN NEW.cancel_reason ELSE NULL END);
    END IF;
    IF NOT (NEW.assigned_user_id <=> OLD.assigned_user_id) THEN
        CALL sp_audit('ASSIGN', 'orders', 'orders', NEW.id,
                      JSON_OBJECT('assigned_user_id', OLD.assigned_user_id),
                      JSON_OBJECT('assigned_user_id', NEW.assigned_user_id));
    END IF;
END$$

CREATE TRIGGER trg_orders_bd BEFORE DELETE ON orders FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los pedidos no se eliminan; use CANCELLED o REJECTED';
END$$

CREATE TRIGGER trg_order_items_bi BEFORE INSERT ON order_items FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND status = 'PENDING') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se agregan productos a pedidos PENDING';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM products WHERE id = NEW.product_id AND status = 'ACTIVE') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el producto no está activo';
    END IF;
    IF NEW.product_name_snapshot IS NULL OR NEW.sku_snapshot IS NULL THEN
        SET NEW.product_name_snapshot = (SELECT name FROM products WHERE id = NEW.product_id);
        SET NEW.sku_snapshot          = (SELECT sku  FROM products WHERE id = NEW.product_id);
    END IF;
END$$

CREATE TRIGGER trg_order_items_bu BEFORE UPDATE ON order_items FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM orders WHERE id = OLD.order_id AND status = 'PENDING') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el detalle solo cambia mientras el pedido está PENDING';
    END IF;
END$$

CREATE TRIGGER trg_order_items_bd BEFORE DELETE ON order_items FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM orders WHERE id = OLD.order_id AND status = 'PENDING') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el detalle solo cambia mientras el pedido está PENDING';
    END IF;
END$$

CREATE TRIGGER trg_order_status_history_bu BEFORE UPDATE ON order_status_history FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el historial de estados es inmutable';
END$$

CREATE TRIGGER trg_order_status_history_bd BEFORE DELETE ON order_status_history FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el historial de estados es inmutable';
END$$

-- ---------------------------------------------------------------------------
-- 16.7 Ventas, líneas y lotes vendidos
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_sales_bi BEFORE INSERT ON sales FOR EACH ROW
BEGIN
    DECLARE v_session_status VARCHAR(10);
    DECLARE v_session_branch BIGINT UNSIGNED;
    DECLARE v_order_branch BIGINT UNSIGNED;
    DECLARE v_order_customer BIGINT UNSIGNED;
    DECLARE v_order_status VARCHAR(30);
    DECLARE v_order_fee DECIMAL(10,2);

    IF NEW.status <> 'COMPLETED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: una venta se registra en estado COMPLETED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM branches WHERE id = NEW.branch_id AND status = 'ACTIVE') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la sucursal no está activa';
    END IF;

    IF NEW.cash_session_id IS NOT NULL THEN
        SELECT cs.status, cr.branch_id INTO v_session_status, v_session_branch
          FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id
         WHERE cs.id = NEW.cash_session_id;
        IF v_session_status <> 'OPEN' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se puede vender con una caja cerrada';
        END IF;
        IF v_session_branch <> NEW.branch_id THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la caja pertenece a otra sucursal';
        END IF;
    END IF;

    IF NEW.order_id IS NOT NULL THEN
        SELECT branch_id, customer_id, status, delivery_fee
          INTO v_order_branch, v_order_customer, v_order_status, v_order_fee
          FROM orders WHERE id = NEW.order_id FOR UPDATE;
        IF v_order_status <> 'PENDING' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se genera venta para un pedido PENDING';
        END IF;
        IF v_order_branch <> NEW.branch_id THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la venta debe registrarse en la sucursal del pedido';
        END IF;
        SET NEW.customer_id = COALESCE(NEW.customer_id, v_order_customer);
        IF NEW.customer_id <> v_order_customer THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el cliente de la venta no coincide con el del pedido';
        END IF;
    END IF;

    IF NEW.customer_id IS NOT NULL AND NEW.customer_name_snapshot IS NULL THEN
        SET NEW.customer_name_snapshot = (SELECT full_name FROM customers WHERE id = NEW.customer_id);
        SET NEW.customer_document_snapshot =
            (SELECT NULLIF(CONCAT_WS(' ', document_type, document_number), '') FROM customers WHERE id = NEW.customer_id);
    END IF;
END$$

CREATE TRIGGER trg_sales_bu BEFORE UPDATE ON sales FOR EACH ROW
BEGIN
    IF NEW.branch_id <> OLD.branch_id OR NOT (NEW.order_id <=> OLD.order_id)
       OR NOT (NEW.customer_id <=> OLD.customer_id) OR NEW.seller_user_id <> OLD.seller_user_id
       OR NOT (NEW.cash_session_id <=> OLD.cash_session_id) OR NEW.sale_channel <> OLD.sale_channel
       OR NEW.subtotal <> OLD.subtotal OR NEW.discount_total <> OLD.discount_total
       OR NEW.delivery_fee <> OLD.delivery_fee OR NEW.total <> OLD.total
       OR NEW.sold_at <> OLD.sold_at OR NEW.sale_number <> OLD.sale_number THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'PP: una venta registrada no se modifica; use anulación o devolución';
    END IF;
    IF OLD.status = 'VOIDED' AND NEW.status <> 'VOIDED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: una venta anulada no puede reactivarse';
    END IF;
    IF OLD.status = 'COMPLETED' AND NEW.status = 'VOIDED'
       AND NOT EXISTS (SELECT 1 FROM sale_voids WHERE sale_id = OLD.id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: para anular una venta inserte un registro en sale_voids';
    END IF;
END$$

CREATE TRIGGER trg_sales_bd BEFORE DELETE ON sales FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las ventas no se eliminan; use sale_voids';
END$$

CREATE TRIGGER trg_sale_items_bi BEFORE INSERT ON sale_items FOR EACH ROW
BEGIN
    DECLARE v_sale_status VARCHAR(20);
    DECLARE v_branch BIGINT UNSIGNED;
    DECLARE v_requires_rx BOOLEAN;
    DECLARE v_status VARCHAR(20);
    DECLARE v_rx_setting VARCHAR(10);

    SELECT status, branch_id INTO v_sale_status, v_branch FROM sales WHERE id = NEW.sale_id;
    IF v_sale_status <> 'COMPLETED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se agregan líneas a una venta anulada';
    END IF;

    SELECT requires_prescription, status INTO v_requires_rx, v_status FROM products WHERE id = NEW.product_id;
    IF v_status <> 'ACTIVE' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el producto no está activo';
    END IF;
    IF EXISTS (SELECT 1 FROM branch_products WHERE branch_id = v_branch AND product_id = NEW.product_id
               AND is_available = FALSE) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el producto no está habilitado en esta sucursal';
    END IF;

    SELECT setting_value INTO v_rx_setting FROM settings WHERE setting_key = 'sales.require_prescription_reference';
    IF v_requires_rx AND COALESCE(v_rx_setting, 'true') = 'true'
       AND (NEW.prescription_reference IS NULL OR TRIM(NEW.prescription_reference) = '') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el producto requiere registrar la referencia de la receta';
    END IF;

    IF NEW.product_name_snapshot IS NULL OR NEW.sku_snapshot IS NULL THEN
        SET NEW.product_name_snapshot = (SELECT name FROM products WHERE id = NEW.product_id);
        SET NEW.sku_snapshot          = (SELECT sku  FROM products WHERE id = NEW.product_id);
    END IF;
    IF NEW.line_subtotal IS NULL THEN SET NEW.line_subtotal = NEW.quantity * NEW.unit_price; END IF;
    IF NEW.line_total IS NULL THEN SET NEW.line_total = NEW.line_subtotal - NEW.discount_amount; END IF;
END$$

CREATE TRIGGER trg_sale_items_bu BEFORE UPDATE ON sale_items FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las líneas de venta son inmutables';
END$$

CREATE TRIGGER trg_sale_items_bd BEFORE DELETE ON sale_items FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las líneas de venta no se eliminan';
END$$

CREATE TRIGGER trg_sale_item_batches_bi BEFORE INSERT ON sale_item_batches FOR EACH ROW
BEGIN
    DECLARE v_item_product BIGINT UNSIGNED;
    DECLARE v_item_qty INT UNSIGNED;
    DECLARE v_sale_branch BIGINT UNSIGNED;
    DECLARE v_sale_status VARCHAR(20);
    DECLARE v_b_product BIGINT UNSIGNED;
    DECLARE v_b_branch BIGINT UNSIGNED;
    DECLARE v_b_expiry DATE;
    DECLARE v_b_status VARCHAR(20);
    DECLARE v_b_number VARCHAR(60);
    DECLARE v_allocated BIGINT DEFAULT 0;

    SELECT si.product_id, si.quantity, s.branch_id, s.status
      INTO v_item_product, v_item_qty, v_sale_branch, v_sale_status
      FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.id = NEW.sale_item_id;
    SELECT product_id, branch_id, expiry_date, status, batch_number
      INTO v_b_product, v_b_branch, v_b_expiry, v_b_status, v_b_number
      FROM product_batches WHERE id = NEW.batch_id;

    IF v_sale_status <> 'COMPLETED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la venta está anulada';
    END IF;
    IF v_b_product <> v_item_product OR v_b_branch <> v_sale_branch THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el lote no corresponde al producto o a la sucursal de la venta';
    END IF;
    IF v_b_expiry <= CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se puede vender un lote vencido';
    END IF;
    IF v_b_status <> 'ACTIVE' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el lote no está disponible para la venta';
    END IF;

    SELECT COALESCE(SUM(quantity), 0) INTO v_allocated FROM sale_item_batches WHERE sale_item_id = NEW.sale_item_id;
    IF v_allocated + NEW.quantity > v_item_qty THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: se asignan más unidades de lote que las vendidas en la línea';
    END IF;

    SET NEW.batch_number_snapshot = v_b_number;
    SET NEW.expiry_date_snapshot = v_b_expiry;
END$$

CREATE TRIGGER trg_sale_item_batches_bu BEFORE UPDATE ON sale_item_batches FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la asignación de lotes de una venta es inmutable';
END$$

CREATE TRIGGER trg_sale_item_batches_bd BEFORE DELETE ON sale_item_batches FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la asignación de lotes de una venta no se elimina';
END$$

-- ---------------------------------------------------------------------------
-- 16.8 Pagos (simulados o en efectivo) y su reflejo en caja
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_payments_bi BEFORE INSERT ON payments FOR EACH ROW
BEGIN
    DECLARE v_target_total DECIMAL(12,2);
    DECLARE v_paid DECIMAL(12,2) DEFAULT 0;
    DECLARE v_branch BIGINT UNSIGNED;
    DECLARE v_status VARCHAR(30);
    DECLARE v_sale_order BIGINT UNSIGNED;
    DECLARE v_session_status VARCHAR(10);
    DECLARE v_session_branch BIGINT UNSIGNED;
    DECLARE v_mode VARCHAR(20);

    IF NEW.status NOT IN ('PENDING','APPROVED','REJECTED') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: un pago nuevo debe ser PENDING, APPROVED o REJECTED';
    END IF;

    SELECT setting_value INTO v_mode FROM settings WHERE setting_key = 'payments.mode';
    IF COALESCE(v_mode, 'DEMO') = 'DEMO' AND NEW.method <> 'CASH' AND NOT NEW.is_simulated THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: en modo DEMO los pagos electrónicos deben ser simulados';
    END IF;
    IF NEW.method = 'CASH' AND NEW.cash_session_id IS NOT NULL THEN
        SET NEW.is_simulated = FALSE;   -- efectivo cobrado físicamente en caja
    END IF;

    IF NEW.sale_id IS NOT NULL THEN
        SELECT total, branch_id, status, order_id INTO v_target_total, v_branch, v_status, v_sale_order
          FROM sales WHERE id = NEW.sale_id;
        IF v_status <> 'COMPLETED' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se registran pagos para una venta anulada';
        END IF;
        IF NEW.order_id IS NULL THEN
            SET NEW.order_id = v_sale_order;
        ELSEIF NOT (NEW.order_id <=> v_sale_order) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el pedido del pago no coincide con el de la venta';
        END IF;
    END IF;
    IF NEW.order_id IS NOT NULL THEN
        SELECT total, branch_id, status INTO v_target_total, v_branch, v_status
          FROM orders WHERE id = NEW.order_id;
        IF v_status IN ('CANCELLED','REJECTED') THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se registran pagos para un pedido cancelado';
        END IF;
    END IF;

    IF NEW.cash_session_id IS NOT NULL THEN
        SELECT cs.status, cr.branch_id INTO v_session_status, v_session_branch
          FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id
         WHERE cs.id = NEW.cash_session_id;
        IF v_session_status <> 'OPEN' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se registran pagos en una caja cerrada';
        END IF;
        IF v_session_branch <> v_branch THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la caja del pago pertenece a otra sucursal';
        END IF;
    END IF;

    IF NEW.status = 'APPROVED' THEN
        SET NEW.paid_at = COALESCE(NEW.paid_at, NOW());
        IF NEW.order_id IS NOT NULL THEN
            SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments
             WHERE order_id = NEW.order_id AND status = 'APPROVED';
        ELSE
            SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments
             WHERE sale_id = NEW.sale_id AND status = 'APPROVED';
        END IF;
        IF v_paid + NEW.amount > v_target_total THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el pago excede el saldo pendiente';
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_payments_ai AFTER INSERT ON payments FOR EACH ROW
BEGIN
    IF NEW.status = 'APPROVED' AND NEW.method = 'CASH' AND NEW.cash_session_id IS NOT NULL THEN
        INSERT INTO cash_movements (cash_session_id, movement_type, amount, payment_id, description, performed_by)
        VALUES (NEW.cash_session_id, 'SALE_INCOME', NEW.amount, NEW.id,
                CONCAT('Cobro en efectivo ', NEW.operation_code), NEW.processed_by);
    END IF;
END$$

CREATE TRIGGER trg_payments_bu BEFORE UPDATE ON payments FOR EACH ROW
BEGIN
    DECLARE v_ok BOOLEAN DEFAULT FALSE;
    DECLARE v_target_total DECIMAL(12,2);
    DECLARE v_paid DECIMAL(12,2) DEFAULT 0;
    DECLARE v_sale_order BIGINT UNSIGNED;

    IF NEW.amount <> OLD.amount OR NEW.method <> OLD.method OR NEW.operation_code <> OLD.operation_code
       OR NEW.is_simulated <> OLD.is_simulated OR NOT (NEW.order_id <=> OLD.order_id)
       OR NOT (NEW.cash_session_id <=> OLD.cash_session_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los datos principales de un pago no se modifican';
    END IF;

    -- Se permite enlazar a la venta un pago hecho antes sobre el pedido.
    IF NOT (NEW.sale_id <=> OLD.sale_id) THEN
        IF OLD.sale_id IS NOT NULL THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el pago ya está asociado a una venta';
        END IF;
        SELECT order_id INTO v_sale_order FROM sales WHERE id = NEW.sale_id;
        IF NOT (v_sale_order <=> OLD.order_id) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se enlaza a la venta generada por el mismo pedido';
        END IF;
    END IF;

    IF NEW.status <> OLD.status THEN
        SET v_ok = CASE
            WHEN OLD.status = 'PENDING'  AND NEW.status IN ('APPROVED','REJECTED','CANCELLED') THEN TRUE
            WHEN OLD.status = 'APPROVED' AND NEW.status = 'REFUNDED' THEN TRUE
            ELSE FALSE END;
        IF NOT v_ok THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: transición de estado de pago no permitida';
        END IF;

        IF NEW.status = 'APPROVED' THEN
            SET NEW.paid_at = COALESCE(NEW.paid_at, NOW());
            IF NEW.order_id IS NOT NULL THEN
                SELECT total INTO v_target_total FROM orders WHERE id = NEW.order_id;
                SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments
                 WHERE order_id = NEW.order_id AND status = 'APPROVED';
            ELSE
                SELECT total INTO v_target_total FROM sales WHERE id = NEW.sale_id;
                SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments
                 WHERE sale_id = NEW.sale_id AND status = 'APPROVED';
            END IF;
            IF v_paid + NEW.amount > v_target_total THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el pago excede el saldo pendiente';
            END IF;
        END IF;

        IF NEW.status = 'REFUNDED' THEN
            SET NEW.refunded_at = COALESCE(NEW.refunded_at, NOW());
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_payments_au AFTER UPDATE ON payments FOR EACH ROW
BEGIN
    IF NEW.method = 'CASH' AND NEW.status <> OLD.status THEN
        IF NEW.status = 'APPROVED' AND NEW.cash_session_id IS NOT NULL THEN
            INSERT INTO cash_movements (cash_session_id, movement_type, amount, payment_id, description, performed_by)
            VALUES (NEW.cash_session_id, 'SALE_INCOME', NEW.amount, NEW.id,
                    CONCAT('Cobro en efectivo ', NEW.operation_code), NEW.processed_by);
        END IF;
        IF NEW.status = 'REFUNDED' AND NEW.refund_cash_session_id IS NOT NULL THEN
            INSERT INTO cash_movements (cash_session_id, movement_type, amount, payment_id, description, performed_by)
            VALUES (NEW.refund_cash_session_id, 'PAYMENT_REFUND', NEW.amount, NEW.id,
                    CONCAT('Reembolso de pago ', NEW.operation_code), COALESCE(@app_user_id, NEW.processed_by));
        END IF;
    END IF;
    IF NEW.status <> OLD.status AND NEW.status = 'REFUNDED' THEN
        CALL sp_audit('REFUND', 'payments', 'payments', NEW.id,
                      JSON_OBJECT('status', OLD.status), JSON_OBJECT('status', NEW.status, 'amount', NEW.amount));
    END IF;
END$$

CREATE TRIGGER trg_payments_bd BEFORE DELETE ON payments FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los pagos no se eliminan';
END$$

-- ---------------------------------------------------------------------------
-- 16.9 Tickets internos
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_sale_tickets_bi BEFORE INSERT ON sale_tickets FOR EACH ROW
BEGIN
    -- Completa los datos del encabezado a partir de la configuración y la venta.
    IF NEW.business_name_snapshot IS NULL THEN
        SET NEW.business_name_snapshot =
            COALESCE((SELECT setting_value FROM settings WHERE setting_key = 'business.name'), 'Pharma Plus');
    END IF;
    IF NEW.business_ruc_snapshot IS NULL THEN
        SET NEW.business_ruc_snapshot = (SELECT NULLIF(setting_value, '') FROM settings WHERE setting_key = 'business.ruc');
    END IF;
    IF NEW.branch_name_snapshot IS NULL THEN
        SET NEW.branch_name_snapshot = (SELECT b.name FROM sales s JOIN branches b ON b.id = s.branch_id
                                         WHERE s.id = NEW.sale_id);
        SET NEW.branch_address_snapshot = (SELECT NULLIF(CONCAT_WS(', ', b.address_line, b.district, b.province), '')
                                             FROM sales s JOIN branches b ON b.id = s.branch_id WHERE s.id = NEW.sale_id);
        SET NEW.branch_phone_snapshot = (SELECT b.phone FROM sales s JOIN branches b ON b.id = s.branch_id
                                          WHERE s.id = NEW.sale_id);
    END IF;
    IF NEW.seller_name_snapshot IS NULL THEN
        SET NEW.seller_name_snapshot = (SELECT u.full_name FROM sales s JOIN users u ON u.id = s.seller_user_id
                                         WHERE s.id = NEW.sale_id);
        SET NEW.customer_name_snapshot = COALESCE(NEW.customer_name_snapshot,
                                         (SELECT customer_name_snapshot FROM sales WHERE id = NEW.sale_id));
    END IF;
END$$

CREATE TRIGGER trg_sale_tickets_bd BEFORE DELETE ON sale_tickets FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los tickets no se eliminan';
END$$

-- ---------------------------------------------------------------------------
-- 16.10 Anulaciones
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_sale_voids_bi BEFORE INSERT ON sale_voids FOR EACH ROW
BEGIN
    DECLARE v_status VARCHAR(20);
    DECLARE v_total DECIMAL(12,2);

    SELECT status, total INTO v_status, v_total FROM sales WHERE id = NEW.sale_id FOR UPDATE;
    IF v_status <> 'COMPLETED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la venta ya está anulada';
    END IF;
    IF EXISTS (SELECT 1 FROM sale_returns WHERE sale_id = NEW.sale_id AND status <> 'REJECTED') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la venta tiene devoluciones; no puede anularse';
    END IF;
    SET NEW.sale_total_snapshot = v_total;
END$$

CREATE TRIGGER trg_sale_voids_ai AFTER INSERT ON sale_voids FOR EACH ROW
BEGIN
    UPDATE sales SET status = 'VOIDED' WHERE id = NEW.sale_id;
    CALL sp_audit('VOID', 'sales', 'sales', NEW.sale_id,
                  JSON_OBJECT('status', 'COMPLETED'),
                  JSON_OBJECT('status', 'VOIDED', 'reason', NEW.reason, 'voided_by', NEW.voided_by));
END$$

CREATE TRIGGER trg_sale_voids_bu BEFORE UPDATE ON sale_voids FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las anulaciones son inmutables';
END$$

CREATE TRIGGER trg_sale_voids_bd BEFORE DELETE ON sale_voids FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las anulaciones no se eliminan';
END$$

-- ---------------------------------------------------------------------------
-- 16.11 Devoluciones
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_sale_returns_bi BEFORE INSERT ON sale_returns FOR EACH ROW
BEGIN
    IF NEW.status <> 'REQUESTED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: una devolución se crea en estado REQUESTED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM sales WHERE id = NEW.sale_id AND status = 'COMPLETED') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se devuelven productos de ventas vigentes';
    END IF;
END$$

CREATE TRIGGER trg_sale_returns_bu BEFORE UPDATE ON sale_returns FOR EACH ROW
BEGIN
    DECLARE v_ok BOOLEAN DEFAULT FALSE;
    DECLARE v_pending INT DEFAULT 0;
    DECLARE v_branch BIGINT UNSIGNED;
    DECLARE v_session_status VARCHAR(10);
    DECLARE v_session_branch BIGINT UNSIGNED;

    IF NEW.sale_id <> OLD.sale_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se cambia la venta de una devolución';
    END IF;
    IF OLD.status IN ('REJECTED') AND NEW.status <> OLD.status THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la devolución rechazada es final';
    END IF;
    IF OLD.status = 'COMPLETED' AND (NEW.status <> OLD.status OR NEW.refund_amount <> OLD.refund_amount
       OR (OLD.refund_status = 'REFUNDED' AND NEW.refund_status <> 'REFUNDED')) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la devolución completada es final';
    END IF;

    IF NEW.status <> OLD.status THEN
        SET v_ok = CASE
            WHEN OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED','REJECTED') THEN TRUE
            WHEN OLD.status = 'APPROVED'  AND NEW.status = 'COMPLETED' THEN TRUE
            ELSE FALSE END;
        IF NOT v_ok THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: transición de estado de devolución no permitida';
        END IF;
        IF NEW.status IN ('APPROVED','REJECTED') THEN
            SET NEW.reviewed_at = COALESCE(NEW.reviewed_at, NOW());
            SET NEW.reviewed_by = COALESCE(NEW.reviewed_by, @app_user_id);
        END IF;
        IF NEW.status = 'REJECTED' THEN
            SET NEW.refund_status = 'NONE';
            SET NEW.refund_amount = 0;
        END IF;
        IF NEW.status = 'COMPLETED' THEN
            -- Toda unidad apta debe haber reingresado al stock antes de completar.
            SELECT COUNT(*) INTO v_pending FROM sale_return_items sri
             WHERE sri.sale_return_id = NEW.id AND sri.restock = TRUE
               AND NOT EXISTS (SELECT 1 FROM inventory_movements im WHERE im.sale_return_item_id = sri.id);
            IF v_pending > 0 THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = 'PP: faltan movimientos RETURN_IN para ítems aptos para la venta';
            END IF;
            SET NEW.refund_amount = (SELECT COALESCE(SUM(line_refund_amount), 0)
                                       FROM sale_return_items WHERE sale_return_id = NEW.id);
            SET NEW.completed_at = COALESCE(NEW.completed_at, NOW());
        END IF;
    END IF;

    IF NEW.refund_status = 'REFUNDED' AND OLD.refund_status <> 'REFUNDED'
       AND NEW.refund_method = 'CASH' THEN
        SELECT s.branch_id INTO v_branch FROM sales s WHERE s.id = NEW.sale_id;
        SELECT cs.status, cr.branch_id INTO v_session_status, v_session_branch
          FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id
         WHERE cs.id = NEW.refund_cash_session_id;
        IF v_session_status <> 'OPEN' OR v_session_branch <> v_branch THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'PP: el reembolso en efectivo requiere una caja abierta de la sucursal';
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_sale_returns_au AFTER UPDATE ON sale_returns FOR EACH ROW
BEGIN
    IF NEW.refund_status = 'REFUNDED' AND OLD.refund_status <> 'REFUNDED'
       AND NEW.refund_method = 'CASH' AND NEW.refund_amount > 0 THEN
        INSERT INTO cash_movements (cash_session_id, movement_type, amount, sale_return_id, description, performed_by)
        VALUES (NEW.refund_cash_session_id, 'RETURN_REFUND', NEW.refund_amount, NEW.id,
                CONCAT('Reembolso devolución ', NEW.return_number),
                COALESCE(@app_user_id, NEW.reviewed_by));
    END IF;
    IF NEW.status <> OLD.status THEN
        CALL sp_audit(NEW.status, 'returns', 'sale_returns', NEW.id,
                      JSON_OBJECT('status', OLD.status),
                      JSON_OBJECT('status', NEW.status, 'refund_amount', NEW.refund_amount));
    END IF;
END$$

CREATE TRIGGER trg_sale_returns_bd BEFORE DELETE ON sale_returns FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las devoluciones no se eliminan; use REJECTED';
END$$

CREATE TRIGGER trg_sale_return_items_bi BEFORE INSERT ON sale_return_items FOR EACH ROW
BEGIN
    DECLARE v_return_sale BIGINT UNSIGNED;
    DECLARE v_return_status VARCHAR(20);
    DECLARE v_alloc_sale BIGINT UNSIGNED;
    DECLARE v_alloc_qty INT UNSIGNED;
    DECLARE v_sale_item BIGINT UNSIGNED;
    DECLARE v_item_total DECIMAL(12,2);
    DECLARE v_expiry DATE;
    DECLARE v_returned BIGINT DEFAULT 0;
    DECLARE v_refunded DECIMAL(12,2) DEFAULT 0;

    SELECT sale_id, status INTO v_return_sale, v_return_status FROM sale_returns WHERE id = NEW.sale_return_id;
    IF v_return_status <> 'REQUESTED' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se agregan ítems a devoluciones REQUESTED';
    END IF;

    SELECT si.sale_id, sib.quantity, si.id, si.line_total, pb.expiry_date
      INTO v_alloc_sale, v_alloc_qty, v_sale_item, v_item_total, v_expiry
      FROM sale_item_batches sib
      JOIN sale_items si ON si.id = sib.sale_item_id
      JOIN product_batches pb ON pb.id = sib.batch_id
     WHERE sib.id = NEW.sale_item_batch_id;
    IF v_alloc_sale <> v_return_sale THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el ítem no pertenece a la venta de la devolución';
    END IF;

    -- No devolver más de lo vendido en ese lote (sumando devoluciones previas no rechazadas)
    SELECT COALESCE(SUM(sri.quantity), 0) INTO v_returned
      FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.sale_return_id
     WHERE sri.sale_item_batch_id = NEW.sale_item_batch_id AND sr.status <> 'REJECTED';
    IF v_returned + NEW.quantity > v_alloc_qty THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la cantidad devuelta supera la vendida de ese lote';
    END IF;

    -- No reembolsar más de lo cobrado por la línea
    SET NEW.line_refund_amount = NEW.quantity * NEW.unit_refund_amount;
    SELECT COALESCE(SUM(sri.line_refund_amount), 0) INTO v_refunded
      FROM sale_return_items sri
      JOIN sale_returns sr ON sr.id = sri.sale_return_id
      JOIN sale_item_batches sib ON sib.id = sri.sale_item_batch_id
     WHERE sib.sale_item_id = v_sale_item AND sr.status <> 'REJECTED';
    IF v_refunded + NEW.line_refund_amount > v_item_total THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el reembolso supera el importe cobrado por la línea';
    END IF;

    IF NEW.item_condition = 'RESELLABLE' AND v_expiry <= CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el lote está vencido; registre la condición EXPIRED';
    END IF;
END$$

CREATE TRIGGER trg_sale_return_items_bu BEFORE UPDATE ON sale_return_items FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sale_returns WHERE id = OLD.sale_return_id AND status = 'REQUESTED') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los ítems solo cambian mientras la devolución está REQUESTED';
    END IF;
    IF NEW.sale_item_batch_id <> OLD.sale_item_batch_id OR NEW.quantity <> OLD.quantity
       OR NEW.sale_return_id <> OLD.sale_return_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: para cambiar cantidad o lote, elimine y vuelva a registrar el ítem';
    END IF;
    SET NEW.line_refund_amount = NEW.quantity * NEW.unit_refund_amount;
END$$

CREATE TRIGGER trg_sale_return_items_bd BEFORE DELETE ON sale_return_items FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sale_returns WHERE id = OLD.sale_return_id AND status = 'REQUESTED') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: los ítems solo se eliminan mientras la devolución está REQUESTED';
    END IF;
END$$

-- ---------------------------------------------------------------------------
-- 16.12 Transferencias
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_branch_transfers_bi BEFORE INSERT ON branch_transfers FOR EACH ROW
BEGIN
    IF NEW.status <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: una transferencia se crea en estado DRAFT';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM branches WHERE id = NEW.destination_branch_id AND status = 'ACTIVE') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la sucursal destino no está activa';
    END IF;
END$$

CREATE TRIGGER trg_branch_transfers_bu BEFORE UPDATE ON branch_transfers FOR EACH ROW
BEGIN
    DECLARE v_missing INT DEFAULT 0;

    IF NEW.origin_branch_id <> OLD.origin_branch_id OR NEW.destination_branch_id <> OLD.destination_branch_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se cambian las sucursales de una transferencia';
    END IF;
    IF OLD.status IN ('RECEIVED','CANCELLED') AND NEW.status <> OLD.status THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la transferencia está en un estado final';
    END IF;

    IF NEW.status <> OLD.status THEN
        IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('IN_TRANSIT','CANCELLED'))
             OR (OLD.status = 'IN_TRANSIT' AND NEW.status = 'RECEIVED')) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: transición de transferencia no permitida';
        END IF;

        IF NEW.status = 'IN_TRANSIT' THEN
            SELECT COUNT(*) INTO v_missing FROM branch_transfer_items ti
             WHERE ti.transfer_id = NEW.id
               AND NOT EXISTS (SELECT 1 FROM inventory_movements im
                                WHERE im.transfer_item_id = ti.id AND im.movement_type = 'TRANSFER_OUT');
            IF v_missing > 0 OR NOT EXISTS (SELECT 1 FROM branch_transfer_items WHERE transfer_id = NEW.id) THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: cada ítem debe tener su salida TRANSFER_OUT antes del despacho';
            END IF;
            SET NEW.dispatched_at = COALESCE(NEW.dispatched_at, NOW());
            SET NEW.dispatched_by = COALESCE(NEW.dispatched_by, @app_user_id);
        END IF;

        IF NEW.status = 'RECEIVED' THEN
            SELECT COUNT(*) INTO v_missing FROM branch_transfer_items ti
             WHERE ti.transfer_id = NEW.id
               AND (ti.received_quantity IS NULL
                    OR (ti.received_quantity > 0 AND NOT EXISTS (
                          SELECT 1 FROM inventory_movements im
                           WHERE im.transfer_item_id = ti.id AND im.movement_type = 'TRANSFER_IN')));
            IF v_missing > 0 THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: registre la cantidad recibida y el ingreso TRANSFER_IN de cada ítem';
            END IF;
            SET NEW.received_at = COALESCE(NEW.received_at, NOW());
            SET NEW.received_by = COALESCE(NEW.received_by, @app_user_id);
        END IF;

        IF NEW.status = 'CANCELLED' THEN
            IF EXISTS (SELECT 1 FROM inventory_movements im JOIN branch_transfer_items ti ON ti.id = im.transfer_item_id
                        WHERE ti.transfer_id = NEW.id) THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la transferencia ya movió stock y no puede cancelarse';
            END IF;
            SET NEW.cancelled_at = COALESCE(NEW.cancelled_at, NOW());
            SET NEW.cancelled_by = COALESCE(NEW.cancelled_by, @app_user_id);
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_branch_transfers_bd BEFORE DELETE ON branch_transfers FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las transferencias no se eliminan; use CANCELLED';
END$$

CREATE TRIGGER trg_branch_transfer_items_bi BEFORE INSERT ON branch_transfer_items FOR EACH ROW
BEGIN
    DECLARE v_status VARCHAR(20);
    DECLARE v_origin BIGINT UNSIGNED;
    DECLARE v_b_branch BIGINT UNSIGNED;
    DECLARE v_b_product BIGINT UNSIGNED;
    DECLARE v_b_qty INT UNSIGNED;
    DECLARE v_b_expiry DATE;

    SELECT status, origin_branch_id INTO v_status, v_origin FROM branch_transfers WHERE id = NEW.transfer_id;
    IF v_status <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se agregan ítems a transferencias DRAFT';
    END IF;
    SELECT branch_id, product_id, current_quantity, expiry_date INTO v_b_branch, v_b_product, v_b_qty, v_b_expiry
      FROM product_batches WHERE id = NEW.origin_batch_id;
    IF v_b_branch <> v_origin OR v_b_product <> NEW.product_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el lote de origen no coincide con la sucursal o el producto';
    END IF;
    IF v_b_expiry <= CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se transfiere un lote vencido';
    END IF;
    IF NEW.quantity > v_b_qty THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la cantidad a transferir supera el stock del lote';
    END IF;
    IF NEW.destination_batch_id IS NOT NULL OR NEW.received_quantity IS NOT NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el lote destino y lo recibido se registran en la recepción';
    END IF;
END$$

CREATE TRIGGER trg_branch_transfer_items_bu BEFORE UPDATE ON branch_transfer_items FOR EACH ROW
BEGIN
    DECLARE v_status VARCHAR(20);
    DECLARE v_destination BIGINT UNSIGNED;
    DECLARE v_o_number VARCHAR(60);
    DECLARE v_o_expiry DATE;
    DECLARE v_d_branch BIGINT UNSIGNED;
    DECLARE v_d_product BIGINT UNSIGNED;
    DECLARE v_d_number VARCHAR(60);
    DECLARE v_d_expiry DATE;

    SELECT status, destination_branch_id INTO v_status, v_destination FROM branch_transfers WHERE id = OLD.transfer_id;

    IF NEW.transfer_id <> OLD.transfer_id OR NEW.product_id <> OLD.product_id
       OR NEW.origin_batch_id <> OLD.origin_batch_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no se cambia transferencia, producto ni lote de origen';
    END IF;
    IF NEW.quantity <> OLD.quantity AND v_status <> 'DRAFT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la cantidad solo cambia en DRAFT';
    END IF;
    IF (NOT (NEW.destination_batch_id <=> OLD.destination_batch_id)
        OR NOT (NEW.received_quantity <=> OLD.received_quantity)) AND v_status <> 'IN_TRANSIT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la recepción se registra con la transferencia IN_TRANSIT';
    END IF;
    IF EXISTS (SELECT 1 FROM inventory_movements WHERE transfer_item_id = OLD.id AND movement_type = 'TRANSFER_IN') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el ítem ya ingresó a destino y no se modifica';
    END IF;

    IF NEW.destination_batch_id IS NOT NULL THEN
        SELECT batch_number, expiry_date INTO v_o_number, v_o_expiry FROM product_batches WHERE id = NEW.origin_batch_id;
        SELECT branch_id, product_id, batch_number, expiry_date INTO v_d_branch, v_d_product, v_d_number, v_d_expiry
          FROM product_batches WHERE id = NEW.destination_batch_id;
        IF v_d_branch <> v_destination OR v_d_product <> NEW.product_id
           OR v_d_number <> v_o_number OR v_d_expiry <> v_o_expiry THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'PP: el lote destino debe ser el mismo lote (número y vencimiento) en la sucursal destino';
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_branch_transfer_items_bd BEFORE DELETE ON branch_transfer_items FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM branch_transfers WHERE id = OLD.transfer_id AND status = 'DRAFT')
       OR EXISTS (SELECT 1 FROM inventory_movements WHERE transfer_item_id = OLD.id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se eliminan ítems de transferencias DRAFT sin movimientos';
    END IF;
END$$

-- ---------------------------------------------------------------------------
-- 16.13 KARDEX: núcleo del control de inventario
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_inventory_movements_bi BEFORE INSERT ON inventory_movements FOR EACH ROW
BEGIN
    DECLARE v_b_product BIGINT UNSIGNED;
    DECLARE v_b_branch BIGINT UNSIGNED;
    DECLARE v_b_qty INT UNSIGNED;
    DECLARE v_b_expiry DATE;
    DECLARE v_b_status VARCHAR(20);
    DECLARE v_branch_stock BIGINT DEFAULT 0;
    DECLARE v_ref_batch BIGINT UNSIGNED;
    DECLARE v_ref_qty INT UNSIGNED;
    DECLARE v_ref_ok BOOLEAN DEFAULT FALSE;
    DECLARE v_new_qty BIGINT;
    DECLARE v_is_in BOOLEAN;

    SET v_is_in = NEW.movement_type IN ('PURCHASE_ENTRY','SALE_VOID_IN','RETURN_IN','TRANSFER_IN','ADJUSTMENT_IN');

    -- 1) Bloquear el lote (serializa operaciones concurrentes sobre el mismo lote)
    SELECT product_id, branch_id, current_quantity, expiry_date, status
      INTO v_b_product, v_b_branch, v_b_qty, v_b_expiry, v_b_status
      FROM product_batches WHERE id = NEW.batch_id FOR UPDATE;
    IF v_b_product IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el lote indicado no existe';
    END IF;

    SET NEW.product_id = COALESCE(NEW.product_id, v_b_product);
    SET NEW.branch_id  = COALESCE(NEW.branch_id,  v_b_branch);
    IF NEW.product_id <> v_b_product OR NEW.branch_id <> v_b_branch THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: producto o sucursal del movimiento no coinciden con el lote';
    END IF;
    SET NEW.performed_by = COALESCE(NEW.performed_by, @app_user_id);
    SET NEW.request_id   = COALESCE(NEW.request_id, @app_request_id);

    -- 2) Validar el documento de origen según el tipo
    CASE NEW.movement_type
      WHEN 'PURCHASE_ENTRY' THEN
        SELECT sei.batch_id, sei.quantity, se.status = 'DRAFT'
          INTO v_ref_batch, v_ref_qty, v_ref_ok
          FROM stock_entry_items sei JOIN stock_entries se ON se.id = sei.stock_entry_id
         WHERE sei.id = NEW.stock_entry_item_id;
        IF NOT v_ref_ok THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la entrada debe estar en DRAFT para ingresar stock';
        END IF;
      WHEN 'SALE_OUT' THEN
        SELECT sib.batch_id, sib.quantity, s.status = 'COMPLETED'
          INTO v_ref_batch, v_ref_qty, v_ref_ok
          FROM sale_item_batches sib
          JOIN sale_items si ON si.id = sib.sale_item_id
          JOIN sales s ON s.id = si.sale_id
         WHERE sib.id = NEW.sale_item_batch_id;
        IF NOT v_ref_ok THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la venta no está vigente';
        END IF;
      WHEN 'SALE_VOID_IN' THEN
        SELECT sib.batch_id, sib.quantity, s.status = 'VOIDED'
          INTO v_ref_batch, v_ref_qty, v_ref_ok
          FROM sale_item_batches sib
          JOIN sale_items si ON si.id = sib.sale_item_id
          JOIN sales s ON s.id = si.sale_id
         WHERE sib.id = NEW.sale_item_batch_id;
        IF NOT v_ref_ok THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: solo se repone stock por anulación de una venta VOIDED';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventory_movements
                        WHERE sale_item_batch_id = NEW.sale_item_batch_id AND movement_type = 'SALE_OUT') THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: no existe la salida SALE_OUT que se quiere revertir';
        END IF;
      WHEN 'RETURN_IN' THEN
        SELECT sib.batch_id, sri.quantity,
               sr.status IN ('APPROVED','COMPLETED') AND sri.item_condition = 'RESELLABLE'
          INTO v_ref_batch, v_ref_qty, v_ref_ok
          FROM sale_return_items sri
          JOIN sale_returns sr ON sr.id = sri.sale_return_id
          JOIN sale_item_batches sib ON sib.id = sri.sale_item_batch_id
         WHERE sri.id = NEW.sale_return_item_id;
        IF NOT v_ref_ok THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'PP: solo reingresan ítems RESELLABLE de devoluciones aprobadas';
        END IF;
      WHEN 'TRANSFER_OUT' THEN
        SELECT ti.origin_batch_id, ti.quantity, t.status = 'DRAFT'
          INTO v_ref_batch, v_ref_qty, v_ref_ok
          FROM branch_transfer_items ti JOIN branch_transfers t ON t.id = ti.transfer_id
         WHERE ti.id = NEW.transfer_item_id;
        IF NOT v_ref_ok THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la salida por transferencia se registra en DRAFT';
        END IF;
      WHEN 'TRANSFER_IN' THEN
        SELECT ti.destination_batch_id, ti.received_quantity, t.status = 'IN_TRANSIT'
          INTO v_ref_batch, v_ref_qty, v_ref_ok
          FROM branch_transfer_items ti JOIN branch_transfers t ON t.id = ti.transfer_id
         WHERE ti.id = NEW.transfer_item_id;
        IF NOT v_ref_ok THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el ingreso por transferencia requiere estado IN_TRANSIT';
        END IF;
      ELSE
        -- Ajustes y bajas: el ajuste debe ser de la misma sucursal
        IF NOT EXISTS (SELECT 1 FROM inventory_adjustments
                        WHERE id = NEW.adjustment_id AND branch_id = v_b_branch) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el ajuste pertenece a otra sucursal';
        END IF;
        SET v_ref_batch = NEW.batch_id;
        SET v_ref_qty = NEW.quantity;
    END CASE;

    IF v_ref_batch IS NULL OR v_ref_batch <> NEW.batch_id THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el lote del movimiento no coincide con el documento de origen';
    END IF;
    IF v_ref_qty IS NULL OR v_ref_qty <> NEW.quantity THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la cantidad del movimiento no coincide con el documento de origen';
    END IF;

    -- 3) Reglas de vencimiento y disponibilidad
    IF NEW.movement_type IN ('SALE_OUT','TRANSFER_OUT','RETURN_IN','PURCHASE_ENTRY') AND v_b_expiry <= CURDATE() THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'PP: lote vencido: no se recibe, no se vende, no se transfiere ni se reingresa';
    END IF;
    IF NEW.movement_type IN ('SALE_OUT','TRANSFER_OUT') AND v_b_status <> 'ACTIVE' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el lote no está ACTIVE (agotado, en cuarentena o retirado)';
    END IF;
    IF NOT v_is_in AND NEW.quantity > v_b_qty THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: stock insuficiente en el lote';
    END IF;

    -- 4) Stock anterior/posterior (bloquea todos los lotes del producto en la sucursal)
    SELECT COALESCE(SUM(current_quantity), 0) INTO v_branch_stock
      FROM product_batches
     WHERE branch_id = v_b_branch AND product_id = v_b_product
       FOR UPDATE;

    SET NEW.batch_stock_before = v_b_qty;
    SET NEW.stock_before = v_branch_stock;
    IF v_is_in THEN
        SET v_new_qty = v_b_qty + NEW.quantity;
        SET NEW.stock_after = v_branch_stock + NEW.quantity;
    ELSE
        SET v_new_qty = v_b_qty - NEW.quantity;
        SET NEW.stock_after = v_branch_stock - NEW.quantity;
    END IF;
    SET NEW.batch_stock_after = v_new_qty;

    -- 5) Aplicar al lote (misma transacción y mismo statement)
    SET @pp_stock_write = 1;
    UPDATE product_batches
       SET current_quantity = v_new_qty,
           received_quantity = received_quantity
                               + IF(NEW.movement_type IN ('PURCHASE_ENTRY','TRANSFER_IN'), NEW.quantity, 0),
           status = CASE
                      WHEN v_new_qty = 0 AND status = 'ACTIVE'  THEN 'DEPLETED'
                      WHEN v_new_qty > 0 AND status = 'DEPLETED' THEN 'ACTIVE'
                      ELSE status END
     WHERE id = NEW.batch_id;
    SET @pp_stock_write = NULL;
END$$

-- Alertas automáticas de stock bajo / agotado (sin duplicar alertas abiertas)
CREATE TRIGGER trg_inventory_movements_ai AFTER INSERT ON inventory_movements FOR EACH ROW
BEGIN
    DECLARE v_available BIGINT DEFAULT 0;
    DECLARE v_min INT UNSIGNED;

    SELECT COALESCE(SUM(current_quantity), 0) INTO v_available
      FROM product_batches
     WHERE branch_id = NEW.branch_id AND product_id = NEW.product_id
       AND status = 'ACTIVE' AND expiry_date > CURDATE();

    SELECT minimum_stock INTO v_min FROM branch_products
     WHERE branch_id = NEW.branch_id AND product_id = NEW.product_id;
    IF v_min IS NULL THEN
        SELECT CAST(setting_value AS UNSIGNED) INTO v_min FROM settings
         WHERE setting_key = 'inventory.default_minimum_stock';
    END IF;
    SET v_min = COALESCE(v_min, 20);

    IF v_available = 0 THEN
        UPDATE stock_alerts SET status = 'RESOLVED', resolved_at = NOW(),
               resolution_note = 'Reemplazada por alerta de producto agotado'
         WHERE branch_id = NEW.branch_id AND product_id = NEW.product_id
           AND alert_type = 'LOW_STOCK' AND status = 'OPEN';
        INSERT INTO stock_alerts (branch_id, product_id, alert_type, stock_at_alert, threshold_at_alert, message)
        VALUES (NEW.branch_id, NEW.product_id, 'OUT_OF_STOCK', 0, v_min, 'Producto agotado en la sucursal')
        ON DUPLICATE KEY UPDATE stock_at_alert = 0;
    ELSEIF v_available <= v_min THEN
        UPDATE stock_alerts SET status = 'RESOLVED', resolved_at = NOW(),
               resolution_note = 'Resuelta automáticamente: hay stock disponible'
         WHERE branch_id = NEW.branch_id AND product_id = NEW.product_id
           AND alert_type = 'OUT_OF_STOCK' AND status = 'OPEN';
        INSERT INTO stock_alerts (branch_id, product_id, alert_type, stock_at_alert, threshold_at_alert, message)
        VALUES (NEW.branch_id, NEW.product_id, 'LOW_STOCK', v_available, v_min,
                CONCAT('Stock disponible (', v_available, ') igual o menor al mínimo (', v_min, ')'))
        ON DUPLICATE KEY UPDATE stock_at_alert = v_available, threshold_at_alert = v_min;
    ELSE
        UPDATE stock_alerts SET status = 'RESOLVED', resolved_at = NOW(),
               resolution_note = 'Resuelta automáticamente por reposición'
         WHERE branch_id = NEW.branch_id AND product_id = NEW.product_id
           AND alert_type IN ('LOW_STOCK','OUT_OF_STOCK') AND status = 'OPEN';
    END IF;
END$$

CREATE TRIGGER trg_inventory_movements_bu BEFORE UPDATE ON inventory_movements FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el kardex es inmutable; registre un movimiento de ajuste';
END$$

CREATE TRIGGER trg_inventory_movements_bd BEFORE DELETE ON inventory_movements FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: el kardex no se elimina';
END$$

-- ---------------------------------------------------------------------------
-- 16.14 Alertas y auditoría (históricos)
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_stock_alerts_bd BEFORE DELETE ON stock_alerts FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: las alertas no se eliminan; use RESOLVED o DISMISSED';
END$$

CREATE TRIGGER trg_audit_logs_bu BEFORE UPDATE ON audit_logs FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la auditoría es de solo inserción';
END$$

CREATE TRIGGER trg_audit_logs_bd BEFORE DELETE ON audit_logs FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PP: la auditoría es de solo inserción';
END$$

DELIMITER ;

-- ============================================================================
-- 17. VISTAS (panel administrativo, POS y reportes)
-- ============================================================================

-- Stock por sucursal y producto, calculado SIEMPRE desde los lotes.
CREATE OR REPLACE VIEW vw_branch_product_stock AS
SELECT
    k.branch_id,
    b.name                                  AS branch_name,
    k.product_id,
    p.sku,
    p.name                                  AS product_name,
    c.name                                  AS category_name,
    p.status                                AS product_status,
    COALESCE(bp.is_available, TRUE)         AS is_available,
    COALESCE(bp.sale_price, p.sale_price)   AS effective_sale_price,
    COALESCE(bp.minimum_stock,
             (SELECT CAST(s.setting_value AS UNSIGNED) FROM settings s
               WHERE s.setting_key = 'inventory.default_minimum_stock'), 20) AS minimum_stock,
    COALESCE(SUM(pb.current_quantity), 0)   AS physical_stock,
    COALESCE(SUM(CASE WHEN pb.status = 'ACTIVE' AND pb.expiry_date > CURDATE()
                      THEN pb.current_quantity END), 0) AS available_stock,
    COALESCE(SUM(CASE WHEN pb.expiry_date <= CURDATE()
                      THEN pb.current_quantity END), 0) AS expired_stock,
    COALESCE(SUM(CASE WHEN pb.status IN ('QUARANTINE','RECALLED') AND pb.expiry_date > CURDATE()
                      THEN pb.current_quantity END), 0) AS blocked_stock,
    MIN(CASE WHEN pb.status = 'ACTIVE' AND pb.current_quantity > 0 AND pb.expiry_date > CURDATE()
             THEN pb.expiry_date END)       AS next_expiry_date,
    CASE
      WHEN COALESCE(SUM(CASE WHEN pb.status = 'ACTIVE' AND pb.expiry_date > CURDATE()
                             THEN pb.current_quantity END), 0) = 0 THEN 'OUT_OF_STOCK'
      WHEN COALESCE(SUM(CASE WHEN pb.status = 'ACTIVE' AND pb.expiry_date > CURDATE()
                             THEN pb.current_quantity END), 0)
           <= COALESCE(bp.minimum_stock,
                       (SELECT CAST(s.setting_value AS UNSIGNED) FROM settings s
                         WHERE s.setting_key = 'inventory.default_minimum_stock'), 20) THEN 'LOW_STOCK'
      ELSE 'OK'
    END                                     AS stock_status
FROM (
    SELECT branch_id, product_id FROM branch_products
    UNION
    SELECT branch_id, product_id FROM product_batches
) k
JOIN branches b        ON b.id = k.branch_id
JOIN products p        ON p.id = k.product_id
JOIN categories c      ON c.id = p.category_id
LEFT JOIN branch_products bp ON bp.branch_id = k.branch_id AND bp.product_id = k.product_id
LEFT JOIN product_batches pb ON pb.branch_id = k.branch_id AND pb.product_id = k.product_id
GROUP BY k.branch_id, b.name, k.product_id, p.sku, p.name, c.name, p.status,
         bp.is_available, bp.sale_price, p.sale_price, bp.minimum_stock;

-- Equivalente evolucionado de la vista original (ahora por sucursal).
CREATE OR REPLACE VIEW vw_products_low_stock AS
SELECT branch_id, branch_name, product_id AS id, sku, product_name AS name, category_name,
       available_stock AS current_stock, minimum_stock,
       CAST(minimum_stock AS SIGNED) - CAST(available_stock AS SIGNED) AS units_to_minimum,
       stock_status
FROM vw_branch_product_stock
WHERE product_status = 'ACTIVE' AND stock_status IN ('LOW_STOCK','OUT_OF_STOCK');

-- Stock consolidado de todas las sucursales.
CREATE OR REPLACE VIEW vw_consolidated_stock AS
SELECT product_id, sku, product_name, category_name,
       COUNT(DISTINCT branch_id)  AS branches_count,
       SUM(physical_stock)        AS physical_stock,
       SUM(available_stock)       AS available_stock,
       SUM(expired_stock)         AS expired_stock,
       MIN(next_expiry_date)      AS next_expiry_date
FROM vw_branch_product_stock
GROUP BY product_id, sku, product_name, category_name;

-- Lotes con estado de vencimiento.
CREATE OR REPLACE VIEW vw_batch_expiry_status AS
SELECT pb.id AS batch_id, pb.branch_id, b.name AS branch_name, pb.product_id, p.sku, p.name AS product_name,
       pb.batch_number, pb.manufacturing_date, pb.expiry_date, pb.current_quantity, pb.status AS batch_status,
       DATEDIFF(pb.expiry_date, CURDATE()) AS days_to_expiry,
       CASE
         WHEN pb.expiry_date <= CURDATE() THEN 'EXPIRED'
         WHEN DATEDIFF(pb.expiry_date, CURDATE()) <=
              COALESCE((SELECT CAST(setting_value AS SIGNED) FROM settings
                         WHERE setting_key = 'inventory.expiry_critical_days'), 30) THEN 'CRITICAL'
         WHEN DATEDIFF(pb.expiry_date, CURDATE()) <=
              COALESCE((SELECT CAST(setting_value AS SIGNED) FROM settings
                         WHERE setting_key = 'inventory.expiry_alert_days'), 90) THEN 'WARNING'
         ELSE 'OK'
       END AS expiry_status
FROM product_batches pb
JOIN branches b ON b.id = pb.branch_id
JOIN products p ON p.id = pb.product_id
WHERE pb.current_quantity > 0;

-- Lotes vendibles ordenados por FEFO (fefo_rank = 1 es el que debe salir primero).
CREATE OR REPLACE VIEW vw_fefo_batches AS
SELECT pb.id AS batch_id, pb.branch_id, pb.product_id, p.sku, p.name AS product_name,
       pb.batch_number, pb.expiry_date, pb.current_quantity,
       DATEDIFF(pb.expiry_date, CURDATE()) AS days_to_expiry,
       ROW_NUMBER() OVER (PARTITION BY pb.branch_id, pb.product_id
                          ORDER BY pb.expiry_date ASC, pb.id ASC) AS fefo_rank
FROM product_batches pb
JOIN products p ON p.id = pb.product_id
WHERE pb.status = 'ACTIVE' AND pb.current_quantity > 0 AND pb.expiry_date > CURDATE();

-- Precio efectivo por sucursal.
CREATE OR REPLACE VIEW vw_product_prices_by_branch AS
SELECT b.id AS branch_id, b.name AS branch_name, p.id AS product_id, p.sku, p.name AS product_name,
       p.sale_price AS general_price, bp.sale_price AS branch_price,
       COALESCE(bp.sale_price, p.sale_price) AS effective_price,
       (bp.sale_price IS NOT NULL) AS has_branch_override
FROM branches b
CROSS JOIN products p
LEFT JOIN branch_products bp ON bp.branch_id = b.id AND bp.product_id = p.id
WHERE b.status = 'ACTIVE' AND p.status = 'ACTIVE';

-- Ventas diarias por sucursal (vista original, ahora con sucursal y anulaciones excluidas).
CREATE OR REPLACE VIEW vw_daily_sales AS
SELECT DATE(s.sold_at) AS sale_date, s.branch_id, b.name AS branch_name,
       COUNT(*) AS sales_count,
       SUM(s.subtotal) AS gross_amount,
       SUM(s.discount_total) AS discount_amount,
       SUM(s.total) AS total_amount
FROM sales s
JOIN branches b ON b.id = s.branch_id
WHERE s.status = 'COMPLETED'
GROUP BY DATE(s.sold_at), s.branch_id, b.name;

-- Productos más vendidos (unidades e importe neto de devoluciones).
CREATE OR REPLACE VIEW vw_sales_by_product AS
SELECT s.branch_id, si.product_id, p.sku, p.name AS product_name,
       SUM(si.quantity) AS units_sold,
       SUM(si.line_total) AS amount_sold,
       COALESCE(SUM(r.units_returned), 0) AS units_returned,
       COALESCE(SUM(r.amount_refunded), 0) AS amount_refunded
FROM sale_items si
JOIN sales s ON s.id = si.sale_id AND s.status = 'COMPLETED'
JOIN products p ON p.id = si.product_id
LEFT JOIN (
    SELECT sib.sale_item_id, SUM(sri.quantity) AS units_returned, SUM(sri.line_refund_amount) AS amount_refunded
      FROM sale_return_items sri
      JOIN sale_returns sr ON sr.id = sri.sale_return_id AND sr.status = 'COMPLETED'
      JOIN sale_item_batches sib ON sib.id = sri.sale_item_batch_id
     GROUP BY sib.sale_item_id
) r ON r.sale_item_id = si.id
GROUP BY s.branch_id, si.product_id, p.sku, p.name;

-- Resumen de pagos por venta (pagos divididos incluidos).
CREATE OR REPLACE VIEW vw_sale_payment_summary AS
SELECT s.id AS sale_id, s.sale_number, s.branch_id, s.status AS sale_status, s.total,
       COALESCE(SUM(CASE WHEN p.status = 'APPROVED' THEN p.amount END), 0) AS approved_amount,
       COALESCE(SUM(CASE WHEN p.status = 'REFUNDED' THEN p.amount END), 0) AS refunded_amount,
       s.total - COALESCE(SUM(CASE WHEN p.status = 'APPROVED' THEN p.amount END), 0) AS balance_due,
       COUNT(p.id) AS payments_count,
       SUM(p.is_simulated) AS simulated_payments,
       CASE
         WHEN s.status = 'VOIDED' THEN 'VOIDED'
         WHEN COALESCE(SUM(CASE WHEN p.status = 'APPROVED' THEN p.amount END), 0) >= s.total THEN 'PAID'
         WHEN COALESCE(SUM(CASE WHEN p.status = 'APPROVED' THEN p.amount END), 0) > 0 THEN 'PARTIALLY_PAID'
         ELSE 'UNPAID'
       END AS payment_state
FROM sales s
LEFT JOIN payments p ON p.sale_id = s.id OR (s.order_id IS NOT NULL AND p.order_id = s.order_id)
GROUP BY s.id, s.sale_number, s.branch_id, s.status, s.total;

-- Historial completo de pagos.
CREATE OR REPLACE VIEW vw_payment_history AS
SELECT p.id, p.operation_code, p.method, p.status, p.amount, p.is_simulated,
       CASE WHEN p.is_simulated THEN 'DEMO' ELSE 'REAL' END AS payment_mode,
       p.sale_id, s.sale_number, p.order_id, o.order_number,
       COALESCE(s.branch_id, o.branch_id) AS branch_id,
       p.processed_by, u.full_name AS processed_by_name,
       p.created_at, p.paid_at, p.refunded_at, p.failure_reason
FROM payments p
LEFT JOIN sales s  ON s.id = p.sale_id
LEFT JOIN orders o ON o.id = p.order_id
LEFT JOIN users u  ON u.id = p.processed_by;

-- Encabezado del ticket interno.
CREATE OR REPLACE VIEW vw_sale_ticket_header AS
SELECT t.ticket_number, t.issued_at, s.id AS sale_id, s.sale_number, s.sold_at,
       t.business_name_snapshot AS business_name, t.business_ruc_snapshot AS business_ruc,
       t.branch_name_snapshot AS branch_name, t.branch_address_snapshot AS branch_address,
       t.branch_phone_snapshot AS branch_phone, t.seller_name_snapshot AS seller_name,
       t.customer_name_snapshot AS customer_name,
       s.subtotal, s.discount_total, s.delivery_fee, s.total, s.status AS sale_status,
       (SELECT GROUP_CONCAT(CONCAT(p.method, ' ', p.amount) ORDER BY p.id SEPARATOR ' | ')
          FROM payments p WHERE p.sale_id = s.id AND p.status IN ('APPROVED','REFUNDED')) AS payment_methods,
       (SELECT SUM(p.change_amount) FROM payments p WHERE p.sale_id = s.id AND p.status = 'APPROVED') AS change_given,
       t.legend, t.print_count
FROM sale_tickets t
JOIN sales s ON s.id = t.sale_id;

-- Líneas del ticket (con lotes vendidos).
CREATE OR REPLACE VIEW vw_sale_ticket_lines AS
SELECT si.sale_id, si.id AS sale_item_id, si.sku_snapshot AS sku, si.product_name_snapshot AS product_name,
       si.quantity, si.unit_price, si.discount_amount, si.line_total,
       (SELECT GROUP_CONCAT(CONCAT(sib.batch_number_snapshot, ' (', sib.quantity, ')')
                            ORDER BY sib.expiry_date_snapshot SEPARATOR ', ')
          FROM sale_item_batches sib WHERE sib.sale_item_id = si.id) AS batches
FROM sale_items si;

-- Caja: saldo esperado en vivo y arqueo.
CREATE OR REPLACE VIEW vw_cash_session_summary AS
SELECT cs.id AS cash_session_id, cs.session_number, cr.branch_id, b.name AS branch_name,
       cr.code AS register_code, cs.status, cs.opened_by, u.full_name AS opened_by_name,
       cs.opened_at, cs.closed_at, cs.opening_amount,
       COALESCE(SUM(CASE WHEN cm.direction = 'IN'  THEN cm.amount END), 0) AS total_in,
       COALESCE(SUM(CASE WHEN cm.direction = 'OUT' THEN cm.amount END), 0) AS total_out,
       cs.opening_amount
         + COALESCE(SUM(CASE WHEN cm.direction = 'IN'  THEN cm.amount END), 0)
         - COALESCE(SUM(CASE WHEN cm.direction = 'OUT' THEN cm.amount END), 0) AS current_expected_amount,
       cs.expected_amount AS closing_expected_amount, cs.counted_amount, cs.difference_amount
FROM cash_sessions cs
JOIN cash_registers cr ON cr.id = cs.cash_register_id
JOIN branches b ON b.id = cr.branch_id
JOIN users u ON u.id = cs.opened_by
LEFT JOIN cash_movements cm ON cm.cash_session_id = cs.id
GROUP BY cs.id, cs.session_number, cr.branch_id, b.name, cr.code, cs.status, cs.opened_by, u.full_name,
         cs.opened_at, cs.closed_at, cs.opening_amount, cs.expected_amount, cs.counted_amount, cs.difference_amount;

-- Permisos efectivos = permisos del rol + concedidos al usuario - denegados al usuario.
CREATE OR REPLACE VIEW vw_user_effective_permissions AS
SELECT u.id AS user_id, u.email, r.code AS role_code, p.code AS permission_code, p.module, 'ROLE' AS source
FROM users u
JOIN roles r ON r.id = u.role_id AND r.is_active
JOIN role_permissions rp ON rp.role_id = u.role_id
JOIN permissions p ON p.id = rp.permission_id AND p.is_active
WHERE NOT EXISTS (SELECT 1 FROM user_permissions up
                   WHERE up.user_id = u.id AND up.permission_id = p.id AND up.effect = 'DENY')
UNION ALL
SELECT u.id, u.email, r.code, p.code, p.module, 'USER'
FROM users u
JOIN roles r ON r.id = u.role_id
JOIN user_permissions up ON up.user_id = u.id AND up.effect = 'GRANT'
JOIN permissions p ON p.id = up.permission_id AND p.is_active
WHERE NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = u.role_id AND rp.permission_id = p.id);

-- Alertas abiertas con datos legibles.
CREATE OR REPLACE VIEW vw_open_stock_alerts AS
SELECT sa.id, sa.alert_type, sa.branch_id, b.name AS branch_name, sa.product_id, p.sku, p.name AS product_name,
       sa.batch_id, pb.batch_number, sa.stock_at_alert, sa.threshold_at_alert, sa.expiry_date_at_alert,
       sa.message, sa.created_at, sa.updated_at
FROM stock_alerts sa
JOIN branches b ON b.id = sa.branch_id
JOIN products p ON p.id = sa.product_id
LEFT JOIN product_batches pb ON pb.id = sa.batch_id
WHERE sa.status = 'OPEN';

-- Kardex legible.
CREATE OR REPLACE VIEW vw_kardex AS
SELECT im.id, im.created_at, im.branch_id, b.name AS branch_name, im.product_id, p.sku, p.name AS product_name,
       im.batch_id, pb.batch_number, pb.expiry_date, im.movement_type, im.direction, im.quantity,
       im.stock_before, im.stock_after, im.batch_stock_before, im.batch_stock_after,
       im.performed_by, u.full_name AS performed_by_name, im.reason,
       COALESCE(se.entry_number, s.sale_number, sr.return_number, bt.transfer_number, ia.adjustment_number)
         AS source_document
FROM inventory_movements im
JOIN branches b ON b.id = im.branch_id
JOIN products p ON p.id = im.product_id
JOIN product_batches pb ON pb.id = im.batch_id
JOIN users u ON u.id = im.performed_by
LEFT JOIN stock_entry_items sei ON sei.id = im.stock_entry_item_id
LEFT JOIN stock_entries se ON se.id = sei.stock_entry_id
LEFT JOIN sale_item_batches sib ON sib.id = im.sale_item_batch_id
LEFT JOIN sale_items si ON si.id = sib.sale_item_id
LEFT JOIN sales s ON s.id = si.sale_id
LEFT JOIN sale_return_items sri ON sri.id = im.sale_return_item_id
LEFT JOIN sale_returns sr ON sr.id = sri.sale_return_id
LEFT JOIN branch_transfer_items bti ON bti.id = im.transfer_item_id
LEFT JOIN branch_transfers bt ON bt.id = bti.transfer_id
LEFT JOIN inventory_adjustments ia ON ia.id = im.adjustment_id;

-- Control de consistencia: debe devolver 0 filas en una base sana.
CREATE OR REPLACE VIEW vw_integrity_issues AS
SELECT 'SALE_SUBTOTAL_MISMATCH' AS issue, CONVERT(s.id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS reference,
       CONCAT('subtotal=', s.subtotal, ' suma_lineas=', COALESCE(x.line_sum, 0)) AS detail
FROM sales s
LEFT JOIN (SELECT sale_id, SUM(line_subtotal) AS line_sum FROM sale_items GROUP BY sale_id) x ON x.sale_id = s.id
WHERE s.subtotal <> COALESCE(x.line_sum, 0)
UNION ALL
SELECT 'SALE_ITEM_NOT_ALLOCATED', CONVERT(si.id USING utf8mb4) COLLATE utf8mb4_unicode_ci,
       CONCAT('vendido=', si.quantity, ' asignado_a_lotes=', COALESCE(SUM(sib.quantity), 0))
FROM sale_items si
LEFT JOIN sale_item_batches sib ON sib.sale_item_id = si.id
GROUP BY si.id, si.quantity
HAVING si.quantity <> COALESCE(SUM(sib.quantity), 0)
UNION ALL
SELECT 'ALLOCATION_WITHOUT_STOCK_OUT', CONVERT(sib.id USING utf8mb4) COLLATE utf8mb4_unicode_ci, 'Lote asignado sin movimiento SALE_OUT'
FROM sale_item_batches sib
WHERE NOT EXISTS (SELECT 1 FROM inventory_movements im
                   WHERE im.sale_item_batch_id = sib.id AND im.movement_type = 'SALE_OUT')
UNION ALL
SELECT 'VOIDED_SALE_NOT_RESTOCKED', CONVERT(sib.id USING utf8mb4) COLLATE utf8mb4_unicode_ci, 'Venta anulada sin reposición SALE_VOID_IN'
FROM sale_item_batches sib
JOIN sale_items si ON si.id = sib.sale_item_id
JOIN sales s ON s.id = si.sale_id AND s.status = 'VOIDED'
WHERE NOT EXISTS (SELECT 1 FROM inventory_movements im
                   WHERE im.sale_item_batch_id = sib.id AND im.movement_type = 'SALE_VOID_IN')
UNION ALL
SELECT 'BATCH_LEDGER_MISMATCH', CONVERT(pb.id USING utf8mb4) COLLATE utf8mb4_unicode_ci,
       CONCAT('lote=', pb.current_quantity, ' kardex=', COALESCE(SUM(CASE WHEN im.direction = 'IN'
              THEN im.quantity ELSE -CAST(im.quantity AS SIGNED) END), 0))
FROM product_batches pb
LEFT JOIN inventory_movements im ON im.batch_id = pb.id
GROUP BY pb.id, pb.current_quantity
HAVING pb.current_quantity <> COALESCE(SUM(CASE WHEN im.direction = 'IN'
              THEN im.quantity ELSE -CAST(im.quantity AS SIGNED) END), 0)
UNION ALL
SELECT 'POSTED_ENTRY_TOTAL_MISMATCH', CONVERT(se.entry_number USING utf8mb4) COLLATE utf8mb4_unicode_ci,
       CONCAT('total=', se.total_cost, ' suma_lineas=', COALESCE(SUM(sei.line_total), 0))
FROM stock_entries se
LEFT JOIN stock_entry_items sei ON sei.stock_entry_id = se.id
WHERE se.status = 'POSTED'
GROUP BY se.id, se.entry_number, se.total_cost
HAVING se.total_cost <> COALESCE(SUM(sei.line_total), 0)
UNION ALL
SELECT 'ORDER_TOTAL_MISMATCH', CONVERT(o.order_number USING utf8mb4) COLLATE utf8mb4_unicode_ci,
       CONCAT('subtotal=', o.subtotal, ' suma_lineas=', COALESCE(SUM(oi.line_total), 0))
FROM orders o
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id, o.order_number, o.subtotal
HAVING o.subtotal <> COALESCE(SUM(oi.line_total), 0)
UNION ALL
SELECT 'CONFIRMED_ORDER_WITHOUT_SALE', CONVERT(o.order_number USING utf8mb4) COLLATE utf8mb4_unicode_ci, CONCAT('estado=', o.status)
FROM orders o
WHERE o.status IN ('CONFIRMED','PREPARING','READY_FOR_PICKUP','OUT_FOR_DELIVERY','COMPLETED')
  AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.order_id = o.id);

-- ============================================================================
-- 18. DATOS INICIALES DE CONFIGURACIÓN (sin datos de negocio inventados)
-- ============================================================================

-- 18.1 Roles
INSERT INTO roles (code, name, description, is_system) VALUES
  ('ADMIN',    'Administrador', 'Acceso total al sistema y a su configuración', TRUE),
  ('STAFF',    'Personal',      'Trabajador de botica: ventas, inventario y pedidos según permisos', TRUE),
  ('CUSTOMER', 'Cliente',       'Cliente de la tienda virtual', TRUE)
ON DUPLICATE KEY UPDATE code = code;

-- 18.2 Catálogo de permisos
INSERT INTO permissions (code, module, name) VALUES
  ('products.view',             'products',   'Consultar productos'),
  ('products.create',           'products',   'Crear productos'),
  ('products.update',           'products',   'Editar productos'),
  ('products.deactivate',       'products',   'Desactivar productos'),
  ('products.prices',           'products',   'Modificar precios (generales y por sucursal)'),
  ('categories.manage',         'products',   'Administrar categorías y laboratorios'),
  ('inventory.view',            'inventory',  'Consultar inventario y lotes'),
  ('inventory.entries',         'inventory',  'Registrar entradas de mercadería'),
  ('inventory.adjust',          'inventory',  'Ajustar inventario'),
  ('inventory.write_off',       'inventory',  'Dar de baja productos vencidos o dañados'),
  ('inventory.transfers',       'inventory',  'Crear y despachar transferencias'),
  ('inventory.receive_transfers','inventory', 'Recibir transferencias'),
  ('inventory.minimum_stock',   'inventory',  'Configurar stock mínimo'),
  ('suppliers.view',            'suppliers',  'Consultar proveedores'),
  ('suppliers.manage',          'suppliers',  'Administrar proveedores'),
  ('alerts.view',               'alerts',     'Consultar alertas'),
  ('alerts.resolve',            'alerts',     'Resolver o descartar alertas'),
  ('sales.create',              'sales',      'Registrar ventas'),
  ('sales.view',                'sales',      'Consultar ventas'),
  ('sales.discount',            'sales',      'Aplicar descuentos'),
  ('sales.void',                'sales',      'Anular ventas'),
  ('returns.create',            'returns',    'Registrar devoluciones'),
  ('returns.approve',           'returns',    'Aprobar o rechazar devoluciones'),
  ('payments.view',             'payments',   'Consultar historial de pagos'),
  ('payments.register',         'payments',   'Registrar pagos'),
  ('payments.refund',           'payments',   'Reembolsar pagos'),
  ('tickets.print',             'sales',      'Emitir y reimprimir tickets internos'),
  ('cash.open',                 'cash',       'Abrir caja'),
  ('cash.close',                'cash',       'Cerrar caja'),
  ('cash.movements',            'cash',       'Registrar ingresos y egresos de efectivo'),
  ('cash.view_all',             'cash',       'Consultar todas las cajas'),
  ('orders.view',               'orders',     'Consultar pedidos'),
  ('orders.manage',             'orders',     'Administrar pedidos'),
  ('orders.assign',             'orders',     'Asignar pedidos a trabajadores'),
  ('customers.view',            'customers',  'Consultar clientes'),
  ('customers.manage',          'customers',  'Administrar clientes'),
  ('reports.view',              'reports',    'Consultar reportes de su sucursal'),
  ('reports.consolidated',      'reports',    'Consultar reportes consolidados'),
  ('users.view',                'users',      'Consultar trabajadores'),
  ('users.manage',              'users',      'Gestionar trabajadores'),
  ('roles.manage',              'users',      'Gestionar roles y permisos'),
  ('branches.manage',           'settings',   'Administrar sucursales'),
  ('settings.manage',           'settings',   'Administrar configuración'),
  ('audit.view',                'settings',   'Consultar auditoría'),
  ('store.browse',              'store',      'Ver catálogo de la tienda virtual'),
  ('store.cart',                'store',      'Usar el carrito de compras'),
  ('store.orders',              'store',      'Crear y consultar sus pedidos'),
  ('store.profile',             'store',      'Gestionar su perfil y direcciones')
ON DUPLICATE KEY UPDATE code = code;

-- 18.3 Permisos predeterminados por rol
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
 WHERE r.code = 'ADMIN' AND p.module <> 'store'
ON DUPLICATE KEY UPDATE role_id = role_permissions.role_id;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
 WHERE r.code = 'STAFF' AND p.code IN (
   'products.view','inventory.view','inventory.entries','inventory.receive_transfers',
   'suppliers.view','alerts.view','sales.create','sales.view','returns.create',
   'payments.view','payments.register','tickets.print','cash.open','cash.close','cash.movements',
   'orders.view','orders.manage','customers.view','customers.manage','reports.view')
ON DUPLICATE KEY UPDATE role_id = role_permissions.role_id;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
 WHERE r.code = 'CUSTOMER' AND p.module = 'store'
ON DUPLICATE KEY UPDATE role_id = role_permissions.role_id;

-- 18.4 Sucursal principal (el trigger crea sus secuencias de numeración).
--      La dirección real se completa desde el panel; no se inventa.
INSERT INTO branches (code, name, is_main, status)
VALUES ('SP01', 'Sucursal Principal', TRUE, 'ACTIVE')
ON DUPLICATE KEY UPDATE code = code;

-- 18.5 Caja inicial de la sucursal principal
INSERT INTO cash_registers (branch_id, code, name)
SELECT id, 'CAJA01', 'Caja 1' FROM branches WHERE code = 'SP01'
ON DUPLICATE KEY UPDATE code = cash_registers.code;

-- 18.6 Configuración general
INSERT INTO settings (setting_key, setting_value, value_type, description) VALUES
  ('business.name',                         'Pharma Plus',   'STRING',  'Nombre comercial mostrado en tickets'),
  ('business.ruc',                          '',              'STRING',  'RUC del negocio (completar desde el panel)'),
  ('app.currency',                          'PEN',           'STRING',  'Moneda (ISO 4217)'),
  ('app.currency_symbol',                   'S/',            'STRING',  'Símbolo de moneda'),
  ('app.timezone',                          'America/Lima',  'STRING',  'Zona horaria de la aplicación'),
  ('app.utc_offset',                        '-05:00',        'STRING',  'Desfase usado en SET time_zone (Perú no usa horario de verano)'),
  ('inventory.default_minimum_stock',       '20',            'INTEGER', 'Stock mínimo por defecto para productos sin configuración por sucursal'),
  ('inventory.expiry_alert_days',           '90',            'INTEGER', 'Días antes del vencimiento para alertar'),
  ('inventory.expiry_critical_days',        '30',            'INTEGER', 'Días antes del vencimiento considerados críticos'),
  ('inventory.method',                      'FEFO',          'STRING',  'Método de salida de lotes: First Expired, First Out'),
  ('payments.mode',                         'DEMO',          'STRING',  'DEMO: los pagos electrónicos son simulados'),
  ('sales.require_prescription_reference',  'true',          'BOOLEAN', 'Exigir N.º de receta al vender productos con receta'),
  ('sales.max_discount_percent',            '100',           'DECIMAL', 'Descuento máximo permitido por línea (%)'),
  ('orders.default_delivery_fee',           '0.00',          'DECIMAL', 'Costo de delivery por defecto (configurable)'),
  ('tickets.legend',                        'Ticket interno. No es un comprobante de pago electrónico.', 'STRING', 'Leyenda impresa en tickets')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- 18.7 Categorías del SQL original
INSERT INTO categories (name, description) VALUES
  ('Cuidado de la piel',      'Productos para limpieza, hidratación y cuidado de la piel'),
  ('Alivio del dolor',        'Productos de venta permitida para el alivio del dolor'),
  ('Gripe y resfrío',         'Productos para síntomas de gripe y resfrío'),
  ('Vitaminas y suplementos', 'Vitaminas y suplementos'),
  ('Cuidado personal',        'Productos de cuidado e higiene personal'),
  ('Higiene y protección',    'Productos de higiene y protección'),
  ('Salud digestiva',         'Productos para el cuidado digestivo'),
  ('Primeros auxilios',       'Productos básicos para primeros auxilios')
ON DUPLICATE KEY UPDATE name = name;

-- 18.8 Motivos de devolución
INSERT INTO return_reasons (code, name, description) VALUES
  ('SALE_ERROR',        'Error en la venta',            'Producto o cantidad registrados por error'),
  ('DEFECTIVE',         'Producto defectuoso',          'Empaque o producto en mal estado'),
  ('EXPIRED_AT_SALE',   'Producto vencido',             'El cliente recibió un producto vencido'),
  ('CUSTOMER_CHANGE',   'Cliente desistió',             'El cliente ya no desea el producto'),
  ('WRONG_PRODUCT',     'Producto equivocado',          'Se entregó un producto distinto al solicitado'),
  ('DELIVERY_ISSUE',    'Problema en la entrega',       'Pedido entregado con problemas'),
  ('OTHER',             'Otro motivo',                  'Detallar en observaciones')
ON DUPLICATE KEY UPDATE code = code;

-- ============================================================================
-- 19. TAREA PROGRAMADA OPCIONAL (requiere event_scheduler=ON y privilegio EVENT)
--     Descomente si desea que MySQL refresque las alertas de vencimiento a diario.
-- ----------------------------------------------------------------------------
-- CREATE EVENT IF NOT EXISTS ev_refresh_expiry_alerts
--   ON SCHEDULE EVERY 1 DAY STARTS (CURRENT_DATE + INTERVAL 1 DAY + INTERVAL 6 HOUR)
--   DO CALL sp_refresh_expiry_alerts();
-- ============================================================================

-- ============================================================================
-- FIN DEL SCRIPT
-- ============================================================================
