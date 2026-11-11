-- ============================================================
-- PHARMA PLUS
-- Base de datos: pharma_plus
-- Motor: MySQL 8.0+
-- Charset: utf8mb4
--
-- IMPORTANTE:
-- 1. Ejecutar este archivo en MySQL Workbench o phpMyAdmin.
-- 2. No se crea un usuario administrador con contraseña fija.
--    El primer administrador debe crearse desde un proceso seguro
--    del backend, guardando la contraseña con bcrypt o Argon2.
-- 3. La lógica de ventas, reposición y alertas se implementa en
--    el backend usando transacciones. No descontar stock dos veces.
-- ============================================================

CREATE DATABASE IF NOT EXISTS pharma_plus
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE pharma_plus;

-- ------------------------------------------------------------
-- 1. USUARIOS Y CLIENTES
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    phone VARCHAR(30) NULL,
    role ENUM('ADMIN', 'STAFF', 'CUSTOMER') NOT NULL DEFAULT 'CUSTOMER',
    status ENUM('ACTIVE', 'INACTIVE', 'BLOCKED') NOT NULL DEFAULT 'ACTIVE',
    last_login_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_role_status (role, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS customers (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL UNIQUE,
    document_type ENUM('DNI', 'CE', 'PASSPORT', 'OTHER') NULL,
    document_number VARCHAR(30) NULL,
    birth_date DATE NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_customers_user
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    UNIQUE KEY uq_customer_document (document_type, document_number)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS customer_addresses (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NOT NULL,
    recipient_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    address_line VARCHAR(255) NOT NULL,
    reference_note VARCHAR(255) NULL,
    district VARCHAR(100) NULL,
    province VARCHAR(100) NULL,
    department VARCHAR(100) NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_addresses_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    INDEX idx_addresses_customer (customer_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 2. CATEGORÍAS Y PRODUCTOS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categories (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description VARCHAR(255) NULL,
    image_url VARCHAR(500) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS products (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    category_id BIGINT UNSIGNED NOT NULL,
    sku VARCHAR(60) NOT NULL UNIQUE,
    barcode VARCHAR(80) NULL UNIQUE,
    name VARCHAR(180) NOT NULL,
    description TEXT NULL,
    image_url VARCHAR(500) NULL,
    unit VARCHAR(30) NOT NULL DEFAULT 'unidad',
    purchase_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    sale_price DECIMAL(10,2) NOT NULL,
    current_stock INT UNSIGNED NOT NULL DEFAULT 0,
    minimum_stock INT UNSIGNED NOT NULL DEFAULT 20,
    requires_prescription BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_products_category
      FOREIGN KEY (category_id) REFERENCES categories(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_products_purchase_price CHECK (purchase_price >= 0),
    CONSTRAINT chk_products_sale_price CHECK (sale_price >= 0),
    CONSTRAINT chk_products_minimum_stock CHECK (minimum_stock >= 0),
    INDEX idx_products_category_active (category_id, is_active),
    INDEX idx_products_name (name),
    INDEX idx_products_stock (current_stock, minimum_stock)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 3. CARRITO DE COMPRAS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS carts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NOT NULL,
    status ENUM('ACTIVE', 'CONVERTED', 'ABANDONED') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_carts_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    INDEX idx_carts_customer_status (customer_id, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cart_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    cart_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_cart_items_cart
      FOREIGN KEY (cart_id) REFERENCES carts(id)
      ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_cart_items_product
      FOREIGN KEY (product_id) REFERENCES products(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_cart_items_quantity CHECK (quantity > 0),
    UNIQUE KEY uq_cart_product (cart_id, product_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 4. PEDIDOS DE LA TIENDA VIRTUAL
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_number VARCHAR(40) NOT NULL UNIQUE,
    customer_id BIGINT UNSIGNED NOT NULL,
    address_id BIGINT UNSIGNED NULL,
    status ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED') NOT NULL DEFAULT 'PENDING',
    subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    customer_note VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_orders_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_orders_address
      FOREIGN KEY (address_id) REFERENCES customer_addresses(id)
      ON UPDATE CASCADE ON DELETE SET NULL,
    INDEX idx_orders_customer_date (customer_id, created_at),
    INDEX idx_orders_status_date (status, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    product_name_snapshot VARCHAR(180) NOT NULL,
    sku_snapshot VARCHAR(60) NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    line_total DECIMAL(12,2) NOT NULL,
    CONSTRAINT fk_order_items_order
      FOREIGN KEY (order_id) REFERENCES orders(id)
      ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_order_items_product
      FOREIGN KEY (product_id) REFERENCES products(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_order_items_quantity CHECK (quantity > 0),
    INDEX idx_order_items_product (product_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 5. VENTAS (incluye ventas del panel y pedidos confirmados)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sale_number VARCHAR(40) NOT NULL UNIQUE,
    order_id BIGINT UNSIGNED NULL UNIQUE,
    customer_id BIGINT UNSIGNED NULL,
    seller_user_id BIGINT UNSIGNED NOT NULL,
    sale_channel ENUM('STORE', 'ADMIN') NOT NULL DEFAULT 'ADMIN',
    payment_method ENUM('CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN', 'OTHER') NOT NULL DEFAULT 'CASH',
    payment_status ENUM('PENDING', 'PAID', 'REFUNDED') NOT NULL DEFAULT 'PAID',
    subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    discount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    sold_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes VARCHAR(500) NULL,
    CONSTRAINT fk_sales_order
      FOREIGN KEY (order_id) REFERENCES orders(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_sales_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id)
      ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_sales_seller
      FOREIGN KEY (seller_user_id) REFERENCES users(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    INDEX idx_sales_date (sold_at),
    INDEX idx_sales_customer (customer_id),
    INDEX idx_sales_seller (seller_user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sale_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sale_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    product_name_snapshot VARCHAR(180) NOT NULL,
    sku_snapshot VARCHAR(60) NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    line_total DECIMAL(12,2) NOT NULL,
    CONSTRAINT fk_sale_items_sale
      FOREIGN KEY (sale_id) REFERENCES sales(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_sale_items_product
      FOREIGN KEY (product_id) REFERENCES products(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_sale_items_quantity CHECK (quantity > 0),
    INDEX idx_sale_items_product (product_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 6. INGRESO / REPOSICIÓN DE MERCADERÍA
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_entries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    entry_number VARCHAR(40) NOT NULL UNIQUE,
    supplier_name VARCHAR(180) NULL,
    invoice_number VARCHAR(80) NULL,
    registered_by BIGINT UNSIGNED NOT NULL,
    notes VARCHAR(500) NULL,
    total_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_stock_entries_user
      FOREIGN KEY (registered_by) REFERENCES users(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    INDEX idx_stock_entries_date (received_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stock_entry_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    stock_entry_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    line_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    CONSTRAINT fk_stock_entry_items_entry
      FOREIGN KEY (stock_entry_id) REFERENCES stock_entries(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_stock_entry_items_product
      FOREIGN KEY (product_id) REFERENCES products(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_stock_entry_items_quantity CHECK (quantity > 0),
    INDEX idx_stock_entry_items_product (product_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 7. HISTORIAL DE MOVIMIENTOS DE INVENTARIO
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory_movements (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT UNSIGNED NOT NULL,
    movement_type ENUM('IN', 'OUT', 'ADJUSTMENT') NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    stock_before INT UNSIGNED NOT NULL,
    stock_after INT UNSIGNED NOT NULL,
    sale_id BIGINT UNSIGNED NULL,
    stock_entry_id BIGINT UNSIGNED NULL,
    performed_by BIGINT UNSIGNED NOT NULL,
    description VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_movements_product
      FOREIGN KEY (product_id) REFERENCES products(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_movements_sale
      FOREIGN KEY (sale_id) REFERENCES sales(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_movements_stock_entry
      FOREIGN KEY (stock_entry_id) REFERENCES stock_entries(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_movements_user
      FOREIGN KEY (performed_by) REFERENCES users(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_movements_quantity CHECK (quantity > 0),
    INDEX idx_movements_product_date (product_id, created_at),
    INDEX idx_movements_type_date (movement_type, created_at)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 8. ALERTAS DE STOCK
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_alerts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT UNSIGNED NOT NULL,
    stock_at_alert INT UNSIGNED NOT NULL,
    minimum_stock_at_alert INT UNSIGNED NOT NULL,
    status ENUM('OPEN', 'RESOLVED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    resolved_by BIGINT UNSIGNED NULL,
    CONSTRAINT fk_stock_alerts_product
      FOREIGN KEY (product_id) REFERENCES products(id)
      ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_stock_alerts_user
      FOREIGN KEY (resolved_by) REFERENCES users(id)
      ON UPDATE CASCADE ON DELETE SET NULL,
    INDEX idx_stock_alerts_status_date (status, created_at),
    INDEX idx_stock_alerts_product_status (product_id, status)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 9. VISTAS PARA EL PANEL ADMINISTRATIVO
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW vw_products_low_stock AS
SELECT
    p.id,
    p.sku,
    p.name,
    c.name AS category_name,
    p.current_stock,
    p.minimum_stock,
    (p.minimum_stock - p.current_stock) AS units_to_minimum
FROM products p
INNER JOIN categories c ON c.id = p.category_id
WHERE p.is_active = TRUE
  AND p.current_stock <= p.minimum_stock;

CREATE OR REPLACE VIEW vw_daily_sales AS
SELECT
    DATE(s.sold_at) AS sale_date,
    COUNT(*) AS sales_count,
    SUM(s.total) AS total_amount
FROM sales s
WHERE s.payment_status = 'PAID'
GROUP BY DATE(s.sold_at);

-- ------------------------------------------------------------
-- 10. CATEGORÍAS INICIALES
-- ------------------------------------------------------------

INSERT IGNORE INTO categories (name, description) VALUES
('Cuidado de la piel', 'Productos para limpieza, hidratación y cuidado de la piel'),
('Alivio del dolor', 'Productos de venta permitida para el alivio del dolor'),
('Gripe y resfrío', 'Productos para síntomas de gripe y resfrío'),
('Vitaminas y suplementos', 'Vitaminas y suplementos'),
('Cuidado personal', 'Productos de cuidado e higiene personal'),
('Higiene y protección', 'Productos de higiene y protección'),
('Salud digestiva', 'Productos para el cuidado digestivo'),
('Primeros auxilios', 'Productos básicos para primeros auxilios');

-- ------------------------------------------------------------
-- FIN DEL SCRIPT
-- ------------------------------------------------------------
