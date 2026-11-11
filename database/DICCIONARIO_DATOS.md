# Diccionario de datos — Pharma Plus (`pharma_plus`, MySQL 8)

Generado automáticamente desde `information_schema` de la base importada en MySQL 8.0.46, por lo que coincide exactamente con `pharma_plus_mysql8.sql`.

**Convenciones**

- Todas las tablas: `InnoDB`, `utf8mb4` / `utf8mb4_unicode_ci`, claves `BIGINT UNSIGNED AUTO_INCREMENT`.
- Importes en `DECIMAL(10,2)` o `DECIMAL(12,2)`; no existe ninguna columna `FLOAT`/`DOUBLE`.
- Fechas en `DATETIME` en hora de Lima (el backend fija `SET time_zone = '-05:00'`).
- Las FK usan `ON UPDATE RESTRICT ON DELETE RESTRICT` (salvo `cart_items → carts`, que borra en cascada). La información histórica no se elimina: triggers bloquean el borrado.
- Columnas *generadas* (`GENERATED ... STORED`) se marcan como tales; nunca se escriben desde el backend.
- Claves: **PK** primaria, **FK** foránea, **UQ** única.

**Resumen:** 42 tablas · 103 claves foráneas · 82 restricciones CHECK · 77 triggers.

## Índice

[`roles`](#roles) · [`permissions`](#permissions) · [`role_permissions`](#role_permissions) · [`branches`](#branches) · [`users`](#users) · [`user_permissions`](#user_permissions) · [`user_branches`](#user_branches) · [`settings`](#settings) · [`document_sequences`](#document_sequences) · [`customers`](#customers) · [`customer_addresses`](#customer_addresses) · [`categories`](#categories) · [`laboratories`](#laboratories) · [`products`](#products) · [`branch_products`](#branch_products) · [`suppliers`](#suppliers) · [`stock_entries`](#stock_entries) · [`product_batches`](#product_batches) · [`stock_entry_items`](#stock_entry_items) · [`inventory_adjustments`](#inventory_adjustments) · [`cash_registers`](#cash_registers) · [`cash_sessions`](#cash_sessions) · [`carts`](#carts) · [`cart_items`](#cart_items) · [`orders`](#orders) · [`order_items`](#order_items) · [`order_status_history`](#order_status_history) · [`sales`](#sales) · [`sale_items`](#sale_items) · [`sale_item_batches`](#sale_item_batches) · [`payments`](#payments) · [`sale_tickets`](#sale_tickets) · [`sale_voids`](#sale_voids) · [`return_reasons`](#return_reasons) · [`sale_returns`](#sale_returns) · [`sale_return_items`](#sale_return_items) · [`cash_movements`](#cash_movements) · [`branch_transfers`](#branch_transfers) · [`branch_transfer_items`](#branch_transfer_items) · [`inventory_movements`](#inventory_movements) · [`stock_alerts`](#stock_alerts) · [`audit_logs`](#audit_logs)


---

## `roles`

**Propósito:** Roles del sistema (ADMIN, STAFF, CUSTOMER) y roles futuros. Reemplaza el ENUM `users.role`.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `code` | `varchar(40)` | No |  | UQ |  |
| 3 | `name` | `varchar(100)` | No |  |  |  |
| 4 | `description` | `varchar(255)` | Sí |  |  |  |
| 5 | `is_system` | `tinyint(1)` | No | `0` |  |  |
| 6 | `is_active` | `tinyint(1)` | No | `1` |  |  |
| 7 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 8 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_roles_code` (code)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Referenciada por:** `role_permissions.role_id`, `users.role_id`

**Restricciones CHECK:**

- `chk_roles_code`: `regexp_like(code,'^[A-Z][A-Z0-9_]*$','c')`

---

## `permissions`

**Propósito:** Catálogo de permisos (código `modulo.accion`). Se agregan por datos, sin cambiar el esquema.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `code` | `varchar(80)` | No |  | UQ |  |
| 3 | `module` | `varchar(50)` | No |  |  |  |
| 4 | `name` | `varchar(120)` | No |  |  |  |
| 5 | `description` | `varchar(255)` | Sí |  |  |  |
| 6 | `is_active` | `tinyint(1)` | No | `1` |  |  |
| 7 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |

**Únicas:** `uq_permissions_code` (code)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Referenciada por:** `role_permissions.permission_id`, `user_permissions.permission_id`

**Restricciones CHECK:**

- `chk_permissions_code`: `regexp_like(code,'^[a-z_]+(\.[a-z_]+)+$','c')`

---

## `role_permissions`

**Propósito:** Permisos asignados a cada rol (N:M roles–permisos).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `role_id` | `bigint unsigned` | No |  | PK FK | → `roles.id` |
| 2 | `permission_id` | `bigint unsigned` | No |  | PK FK | → `permissions.id` |
| 3 | `granted_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |

**Relaciones (esta tabla referencia a):**

- `permission_id` → `permissions.id` (N:1, `fk_role_permissions_permission`, ON DELETE RESTRICT)
- `role_id` → `roles.id` (N:1, `fk_role_permissions_role`, ON DELETE RESTRICT)

**Triggers:** `trg_role_permissions_ad` (AFTER DELETE), `trg_role_permissions_ai` (AFTER INSERT)

---

## `branches`

**Propósito:** Sucursales (boticas). Una sola puede ser principal. Al insertar una se crean sus secuencias de numeración.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `code` | `varchar(20)` | No |  | UQ |  |
| 3 | `name` | `varchar(120)` | No |  | UQ |  |
| 4 | `address_line` | `varchar(255)` | Sí |  |  |  |
| 5 | `district` | `varchar(100)` | Sí |  |  |  |
| 6 | `province` | `varchar(100)` | Sí |  |  |  |
| 7 | `department` | `varchar(100)` | Sí |  |  |  |
| 8 | `phone` | `varchar(30)` | Sí |  |  |  |
| 9 | `email` | `varchar(190)` | Sí |  |  |  |
| 10 | `is_main` | `tinyint(1)` | No | `0` |  |  |
| 11 | `status` | `enum('ACTIVE','INACTIVE')` | No | `ACTIVE` |  |  |
| 12 | `opened_on` | `date` | Sí |  |  |  |
| 13 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 14 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |
| 15 | `main_flag` | `tinyint` | Sí |  | UQ | columna generada |

**Únicas:** `uq_branches_code` (code); `uq_branches_name` (name); `uq_branches_single_main` (main_flag)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Referenciada por:** `audit_logs.branch_id`, `branch_products.branch_id`, `branch_transfers.destination_branch_id`, `branch_transfers.origin_branch_id`, `carts.branch_id`, `cash_registers.branch_id`, `document_sequences.branch_id`, `inventory_adjustments.branch_id`, `inventory_movements.branch_id`, `orders.branch_id`, `product_batches.branch_id`, `sales.branch_id`, `stock_alerts.branch_id`, `stock_entries.branch_id`, `user_branches.branch_id`

**Restricciones CHECK:**

- `chk_branches_code`: `regexp_like(code,'^[A-Z0-9]{2,20}$','c')`

**Triggers:** `trg_branches_ai` (AFTER INSERT), `trg_branches_bd` (BEFORE DELETE)

---

## `users`

**Propósito:** Cuentas de acceso (trabajadores y clientes web). Solo acepta hashes bcrypt/Argon2. No se eliminan.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `role_id` | `bigint unsigned` | No |  | FK | → `roles.id` |
| 3 | `full_name` | `varchar(150)` | No |  |  |  |
| 4 | `email` | `varchar(190)` | No |  | UQ |  |
| 5 | `password_hash` | `varchar(255)` | No |  |  |  |
| 6 | `phone` | `varchar(30)` | Sí |  |  |  |
| 7 | `status` | `enum('ACTIVE','INACTIVE','BLOCKED')` | No | `ACTIVE` |  |  |
| 8 | `must_change_password` | `tinyint(1)` | No | `0` |  |  |
| 9 | `failed_login_attempts` | `smallint unsigned` | No | `0` |  |  |
| 10 | `locked_until` | `datetime` | Sí |  |  |  |
| 11 | `password_changed_at` | `datetime` | Sí |  |  |  |
| 12 | `last_login_at` | `datetime` | Sí |  |  |  |
| 13 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 14 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_users_email` (email)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `role_id` → `roles.id` (N:1, `fk_users_role`, ON DELETE RESTRICT)

**Referenciada por:** `audit_logs.user_id`, `branch_transfers.cancelled_by`, `branch_transfers.dispatched_by`, `branch_transfers.received_by`, `branch_transfers.requested_by`, `cash_movements.performed_by`, `cash_sessions.closed_by`, `cash_sessions.opened_by`, `customers.created_by`, `customers.user_id`, `inventory_adjustments.approved_by`, `inventory_adjustments.performed_by`, `inventory_movements.performed_by`, `order_status_history.changed_by`, `orders.assigned_user_id`, `orders.cancelled_by`, `orders.confirmed_by`, `payments.processed_by`, `sale_returns.requested_by`, `sale_returns.reviewed_by`, `sale_tickets.issued_by`, `sale_voids.authorized_by`, `sale_voids.voided_by`, `sales.seller_user_id`, `settings.updated_by`, `stock_alerts.resolved_by`, `stock_entries.registered_by`, `user_branches.assigned_by`, `user_branches.user_id`, `user_permissions.granted_by`, `user_permissions.user_id`

**Restricciones CHECK:**

- `chk_users_email`: `regexp_like(email,'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')`
- `chk_users_password_hash`: `regexp_like(password_hash,'^\$(2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}|argon2(id|i|d)\$v=[0-9]+\$.+)$','c')`

**Triggers:** `trg_users_ai` (AFTER INSERT), `trg_users_au` (AFTER UPDATE), `trg_users_bd` (BEFORE DELETE)

---

## `user_permissions`

**Propósito:** Excepciones de permisos por usuario: GRANT (concede) o DENY (deniega aunque el rol lo tenga).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `user_id` | `bigint unsigned` | No |  | PK FK | → `users.id` |
| 2 | `permission_id` | `bigint unsigned` | No |  | PK FK | → `permissions.id` |
| 3 | `effect` | `enum('GRANT','DENY')` | No | `GRANT` |  |  |
| 4 | `reason` | `varchar(255)` | Sí |  |  |  |
| 5 | `granted_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 6 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 7 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Relaciones (esta tabla referencia a):**

- `granted_by` → `users.id` (N:1, `fk_user_permissions_granted_by`, ON DELETE RESTRICT)
- `permission_id` → `permissions.id` (N:1, `fk_user_permissions_permission`, ON DELETE RESTRICT)
- `user_id` → `users.id` (N:1, `fk_user_permissions_user`, ON DELETE RESTRICT)

**Triggers:** `trg_user_permissions_ad` (AFTER DELETE), `trg_user_permissions_ai` (AFTER INSERT), `trg_user_permissions_au` (AFTER UPDATE)

---

## `user_branches`

**Propósito:** Sucursales en las que puede operar cada trabajador (N:M), con una sucursal por defecto.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `user_id` | `bigint unsigned` | No |  | PK FK | → `users.id` |
| 2 | `branch_id` | `bigint unsigned` | No |  | PK FK | → `branches.id` |
| 3 | `is_default` | `tinyint(1)` | No | `0` |  |  |
| 4 | `assigned_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 5 | `assigned_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 6 | `default_flag` | `tinyint` | Sí |  | UQ* | columna generada |

**Únicas:** `uq_user_branches_default` (user_id, default_flag)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `assigned_by` → `users.id` (N:1, `fk_user_branches_assigned_by`, ON DELETE RESTRICT)
- `branch_id` → `branches.id` (N:1, `fk_user_branches_branch`, ON DELETE RESTRICT)
- `user_id` → `users.id` (N:1, `fk_user_branches_user`, ON DELETE RESTRICT)

---

## `settings`

**Propósito:** Configuración general clave/valor con tipo validado (moneda, zona horaria, stock mínimo, modo de pagos...).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `setting_key` | `varchar(80)` | No |  | PK |  |
| 2 | `setting_value` | `varchar(1000)` | No |  |  |  |
| 3 | `value_type` | `enum('STRING','INTEGER','DECIMAL','BOOLEAN','JSON')` | No | `STRING` |  |  |
| 4 | `description` | `varchar(255)` | Sí |  |  |  |
| 5 | `is_editable` | `tinyint(1)` | No | `1` |  |  |
| 6 | `updated_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 7 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 8 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Relaciones (esta tabla referencia a):**

- `updated_by` → `users.id` (N:1, `fk_settings_updated_by`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_settings_key`: `regexp_like(setting_key,'^[a-z_]+(\.[a-z_]+)+$','c')`
- `chk_settings_value_type`: `((value_type = 'STRING') or ((value_type = 'INTEGER') and regexp_like(setting_value,'^-?[0-9]+$')) or ((value_type = 'DECIMAL') and regexp_like(setting_value,'^-?[0-9]+(\.[0-9]+)?$')) or ((value_type = 'BOOLEAN') and (setting_value in ('true','false'))) or ((value_type = 'JSON') and json_valid(setting_value)))`

**Triggers:** `trg_settings_au` (AFTER UPDATE)

---

## `document_sequences`

**Propósito:** Correlativos por sucursal y tipo de documento. Se consumen con `sp_next_document_number` (seguro ante concurrencia).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `branch_id` | `bigint unsigned` | No |  | FK UQ* | → `branches.id` |
| 3 | `document_type` | `enum('SALE','TICKET','ORDER','STOCK_ENTRY','TRANSFER','RETURN','ADJUSTMENT','CASH_SESSION','PAYMENT')` | No |  | UQ* |  |
| 4 | `prefix` | `varchar(30)` | No |  |  |  |
| 5 | `next_number` | `bigint unsigned` | No | `1` |  |  |
| 6 | `padding` | `tinyint unsigned` | No | `8` |  |  |
| 7 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_document_sequences` (branch_id, document_type)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `branch_id` → `branches.id` (N:1, `fk_document_sequences_branch`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_document_sequences_next`: `(next_number >= 1)`
- `chk_document_sequences_padding`: `(padding between 4 and 12)`

---

## `customers`

**Propósito:** Clientes. Pueden tener cuenta web (`user_id`) o ser clientes registrados en caja sin cuenta. Las ventas rápidas no requieren cliente.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `user_id` | `bigint unsigned` | Sí |  | FK UQ | → `users.id` |
| 3 | `full_name` | `varchar(150)` | No |  |  |  |
| 4 | `document_type` | `enum('DNI','CE','PASSPORT','RUC','OTHER')` | Sí |  | UQ* |  |
| 5 | `document_number` | `varchar(30)` | Sí |  | UQ* |  |
| 6 | `phone` | `varchar(30)` | Sí |  |  |  |
| 7 | `email` | `varchar(190)` | Sí |  |  |  |
| 8 | `birth_date` | `date` | Sí |  |  |  |
| 9 | `is_active` | `tinyint(1)` | No | `1` |  |  |
| 10 | `created_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 11 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 12 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_customers_document` (document_type, document_number); `uq_customers_user` (user_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `created_by` → `users.id` (N:1, `fk_customers_created_by`, ON DELETE RESTRICT)
- `user_id` → `users.id` (N:1, `fk_customers_user`, ON DELETE RESTRICT)

**Referenciada por:** `carts.customer_id`, `customer_addresses.customer_id`, `orders.customer_id`, `sales.customer_id`

**Restricciones CHECK:**

- `chk_customers_dni`: `((document_type is null) or (document_type <> 'DNI') or regexp_like(document_number,'^[0-9]{8}$'))`
- `chk_customers_document_pair`: `((document_type is null) = (document_number is null))`
- `chk_customers_ruc`: `((document_type is null) or (document_type <> 'RUC') or regexp_like(document_number,'^[12][0-9]{10}$'))`

---

## `customer_addresses`

**Propósito:** Direcciones de entrega del cliente (una por defecto).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `customer_id` | `bigint unsigned` | No |  | FK UQ* | → `customers.id` |
| 3 | `label` | `varchar(60)` | Sí |  |  |  |
| 4 | `recipient_name` | `varchar(150)` | No |  |  |  |
| 5 | `phone` | `varchar(30)` | No |  |  |  |
| 6 | `address_line` | `varchar(255)` | No |  |  |  |
| 7 | `reference_note` | `varchar(255)` | Sí |  |  |  |
| 8 | `district` | `varchar(100)` | Sí |  |  |  |
| 9 | `province` | `varchar(100)` | Sí |  |  |  |
| 10 | `department` | `varchar(100)` | Sí |  |  |  |
| 11 | `latitude` | `decimal(10,7)` | Sí |  |  |  |
| 12 | `longitude` | `decimal(10,7)` | Sí |  |  |  |
| 13 | `is_default` | `tinyint(1)` | No | `0` |  |  |
| 14 | `is_active` | `tinyint(1)` | No | `1` |  |  |
| 15 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 16 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |
| 17 | `default_flag` | `tinyint` | Sí |  | UQ* | columna generada |

**Únicas:** `uq_customer_addresses_default` (customer_id, default_flag)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `customer_id` → `customers.id` (N:1, `fk_addresses_customer`, ON DELETE RESTRICT)

**Referenciada por:** `orders.address_id`

**Restricciones CHECK:**

- `chk_addresses_lat`: `((latitude is null) or (latitude between -(90) and 90))`
- `chk_addresses_lng`: `((longitude is null) or (longitude between -(180) and 180))`

---

## `categories`

**Propósito:** Categorías del catálogo (se conservan las 8 del SQL original).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `name` | `varchar(100)` | No |  | UQ |  |
| 3 | `description` | `varchar(255)` | Sí |  |  |  |
| 4 | `image_url` | `varchar(500)` | Sí |  |  |  |
| 5 | `is_active` | `tinyint(1)` | No | `1` |  |  |
| 6 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 7 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_categories_name` (name)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Referenciada por:** `products.category_id`

---

## `laboratories`

**Propósito:** Fabricantes o laboratorios.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `name` | `varchar(150)` | No |  | UQ |  |
| 3 | `country` | `varchar(80)` | Sí |  |  |  |
| 4 | `is_active` | `tinyint(1)` | No | `1` |  |  |
| 5 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 6 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_laboratories_name` (name)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Referenciada por:** `products.laboratory_id`

---

## `products`

**Propósito:** Catálogo ÚNICO de productos compartido por todas las sucursales. Ya no guarda stock.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `category_id` | `bigint unsigned` | No |  | FK | → `categories.id` |
| 3 | `laboratory_id` | `bigint unsigned` | Sí |  | FK | → `laboratories.id` |
| 4 | `sku` | `varchar(60)` | No |  | UQ |  |
| 5 | `barcode` | `varchar(80)` | Sí |  | UQ |  |
| 6 | `name` | `varchar(180)` | No |  |  |  |
| 7 | `description` | `text` | Sí |  |  |  |
| 8 | `image_url` | `varchar(500)` | Sí |  |  |  |
| 9 | `active_ingredient` | `varchar(255)` | Sí |  |  |  |
| 10 | `concentration` | `varchar(100)` | Sí |  |  |  |
| 11 | `dosage_form` | `varchar(80)` | Sí |  |  |  |
| 12 | `presentation` | `varchar(150)` | Sí |  |  |  |
| 13 | `sanitary_registration` | `varchar(50)` | Sí |  |  |  |
| 14 | `unit` | `varchar(30)` | No | `unidad` |  |  |
| 15 | `purchase_price` | `decimal(10,2)` | No | `0.00` |  |  |
| 16 | `sale_price` | `decimal(10,2)` | No |  |  |  |
| 17 | `requires_prescription` | `tinyint(1)` | No | `0` |  |  |
| 18 | `status` | `enum('ACTIVE','INACTIVE','DISCONTINUED')` | No | `ACTIVE` |  |  |
| 19 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 20 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_products_barcode` (barcode); `uq_products_sku` (sku)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `category_id` → `categories.id` (N:1, `fk_products_category`, ON DELETE RESTRICT)
- `laboratory_id` → `laboratories.id` (N:1, `fk_products_laboratory`, ON DELETE RESTRICT)

**Referenciada por:** `branch_products.product_id`, `branch_transfer_items.product_id`, `cart_items.product_id`, `inventory_movements.product_id`, `order_items.product_id`, `product_batches.product_id`, `sale_items.product_id`, `stock_alerts.product_id`, `stock_entry_items.product_id`

**Restricciones CHECK:**

- `chk_products_purchase_price`: `(purchase_price >= 0)`
- `chk_products_sale_price`: `(sale_price >= 0)`

**Triggers:** `trg_products_au` (AFTER UPDATE), `trg_products_bd` (BEFORE DELETE)

---

## `branch_products`

**Propósito:** Configuración del producto en cada sucursal: precio propio opcional, stock mínimo (20 por defecto), ubicación y disponibilidad.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `branch_id` | `bigint unsigned` | No |  | FK UQ* | → `branches.id` |
| 3 | `product_id` | `bigint unsigned` | No |  | FK UQ* | → `products.id` |
| 4 | `sale_price` | `decimal(10,2)` | Sí |  |  |  |
| 5 | `minimum_stock` | `int unsigned` | No | `20` |  |  |
| 6 | `maximum_stock` | `int unsigned` | Sí |  |  |  |
| 7 | `shelf_location` | `varchar(40)` | Sí |  |  |  |
| 8 | `is_available` | `tinyint(1)` | No | `1` |  |  |
| 9 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 10 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_branch_products` (branch_id, product_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `branch_id` → `branches.id` (N:1, `fk_branch_products_branch`, ON DELETE RESTRICT)
- `product_id` → `products.id` (N:1, `fk_branch_products_product`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_branch_products_max`: `((maximum_stock is null) or (maximum_stock >= minimum_stock))`
- `chk_branch_products_price`: `((sale_price is null) or (sale_price >= 0))`

**Triggers:** `trg_branch_products_au` (AFTER UPDATE)

---

## `suppliers`

**Propósito:** Proveedores (razón social, RUC, contacto).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `business_name` | `varchar(180)` | No |  |  |  |
| 3 | `trade_name` | `varchar(180)` | Sí |  |  |  |
| 4 | `ruc` | `char(11)` | Sí |  | UQ |  |
| 5 | `contact_name` | `varchar(150)` | Sí |  |  |  |
| 6 | `phone` | `varchar(30)` | Sí |  |  |  |
| 7 | `email` | `varchar(190)` | Sí |  |  |  |
| 8 | `address_line` | `varchar(255)` | Sí |  |  |  |
| 9 | `district` | `varchar(100)` | Sí |  |  |  |
| 10 | `province` | `varchar(100)` | Sí |  |  |  |
| 11 | `department` | `varchar(100)` | Sí |  |  |  |
| 12 | `status` | `enum('ACTIVE','INACTIVE')` | No | `ACTIVE` |  |  |
| 13 | `notes` | `varchar(500)` | Sí |  |  |  |
| 14 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 15 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_suppliers_ruc` (ruc)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Referenciada por:** `stock_entries.supplier_id`

**Restricciones CHECK:**

- `chk_suppliers_ruc`: `((ruc is null) or regexp_like(ruc,'^[12][0-9]{10}$'))`

---

## `stock_entries`

**Propósito:** Cabecera de entradas/reposiciones de mercadería por sucursal y proveedor (DRAFT → POSTED / CANCELLED).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `entry_number` | `varchar(40)` | No |  | UQ |  |
| 3 | `branch_id` | `bigint unsigned` | No |  | FK | → `branches.id` |
| 4 | `supplier_id` | `bigint unsigned` | Sí |  | FK UQ* | → `suppliers.id` |
| 5 | `entry_type` | `enum('PURCHASE','INITIAL_STOCK','DONATION','OTHER')` | No | `PURCHASE` |  |  |
| 6 | `reference_document_type` | `enum('FACTURA','BOLETA','GUIA_REMISION','NOTA','OTHER')` | Sí |  | UQ* |  |
| 7 | `reference_document_number` | `varchar(80)` | Sí |  | UQ* |  |
| 8 | `status` | `enum('DRAFT','POSTED','CANCELLED')` | No | `DRAFT` |  |  |
| 9 | `registered_by` | `bigint unsigned` | No |  | FK | → `users.id` |
| 10 | `received_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 11 | `posted_at` | `datetime` | Sí |  |  |  |
| 12 | `total_cost` | `decimal(12,2)` | No | `0.00` |  |  |
| 13 | `notes` | `varchar(500)` | Sí |  |  |  |
| 14 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 15 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_stock_entries_number` (entry_number); `uq_stock_entries_supplier_doc` (supplier_id, reference_document_type, reference_document_number)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `branch_id` → `branches.id` (N:1, `fk_stock_entries_branch`, ON DELETE RESTRICT)
- `supplier_id` → `suppliers.id` (N:1, `fk_stock_entries_supplier`, ON DELETE RESTRICT)
- `registered_by` → `users.id` (N:1, `fk_stock_entries_user`, ON DELETE RESTRICT)

**Referenciada por:** `product_batches.stock_entry_id`, `stock_entry_items.stock_entry_id`

**Restricciones CHECK:**

- `chk_stock_entries_posted`: `((status = 'POSTED') = (posted_at is not null))`
- `chk_stock_entries_supplier`: `((entry_type <> 'PURCHASE') or (supplier_id is not null))`
- `chk_stock_entries_total`: `(total_cost >= 0)`

**Triggers:** `trg_stock_entries_bd` (BEFORE DELETE), `trg_stock_entries_bu` (BEFORE UPDATE)

---

## `product_batches`

**Propósito:** Lotes por producto y sucursal con vencimiento. ÚNICA fuente de stock (`current_quantity`), modificada solo por `inventory_movements`.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `product_id` | `bigint unsigned` | No |  | FK UQ* | → `products.id` |
| 3 | `branch_id` | `bigint unsigned` | No |  | FK UQ* | → `branches.id` |
| 4 | `batch_number` | `varchar(60)` | No |  | UQ* |  |
| 5 | `manufacturing_date` | `date` | Sí |  |  |  |
| 6 | `expiry_date` | `date` | No |  |  |  |
| 7 | `received_quantity` | `int unsigned` | No | `0` |  |  |
| 8 | `current_quantity` | `int unsigned` | No | `0` |  |  |
| 9 | `unit_cost` | `decimal(10,2)` | No | `0.00` |  |  |
| 10 | `stock_entry_id` | `bigint unsigned` | Sí |  | FK | → `stock_entries.id` |
| 11 | `status` | `enum('ACTIVE','DEPLETED','QUARANTINE','RECALLED')` | No | `ACTIVE` |  |  |
| 12 | `notes` | `varchar(500)` | Sí |  |  |  |
| 13 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 14 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_product_batches` (branch_id, product_id, batch_number)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `branch_id` → `branches.id` (N:1, `fk_product_batches_branch`, ON DELETE RESTRICT)
- `stock_entry_id` → `stock_entries.id` (N:1, `fk_product_batches_entry`, ON DELETE RESTRICT)
- `product_id` → `products.id` (N:1, `fk_product_batches_product`, ON DELETE RESTRICT)

**Referenciada por:** `branch_transfer_items.destination_batch_id`, `branch_transfer_items.origin_batch_id`, `inventory_movements.batch_id`, `sale_item_batches.batch_id`, `stock_alerts.batch_id`, `stock_entry_items.batch_id`

**Restricciones CHECK:**

- `chk_product_batches_cost`: `(unit_cost >= 0)`
- `chk_product_batches_dates`: `((manufacturing_date is null) or (manufacturing_date < expiry_date))`

**Triggers:** `trg_product_batches_bi` (BEFORE INSERT), `trg_product_batches_bu` (BEFORE UPDATE)

---

## `stock_entry_items`

**Propósito:** Detalle de la entrada: qué lote, cuántas unidades y a qué costo ingresaron.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `stock_entry_id` | `bigint unsigned` | No |  | FK UQ* | → `stock_entries.id` |
| 3 | `product_id` | `bigint unsigned` | No |  | FK | → `products.id` |
| 4 | `batch_id` | `bigint unsigned` | No |  | FK UQ* | → `product_batches.id` |
| 5 | `quantity` | `int unsigned` | No |  |  |  |
| 6 | `unit_cost` | `decimal(10,2)` | No | `0.00` |  |  |
| 7 | `line_total` | `decimal(12,2)` | No | `0.00` |  |  |

**Únicas:** `uq_stock_entry_items_batch` (stock_entry_id, batch_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `batch_id` → `product_batches.id` (N:1, `fk_stock_entry_items_batch`, ON DELETE RESTRICT)
- `stock_entry_id` → `stock_entries.id` (N:1, `fk_stock_entry_items_entry`, ON DELETE RESTRICT)
- `product_id` → `products.id` (N:1, `fk_stock_entry_items_product`, ON DELETE RESTRICT)

**Referenciada por:** `inventory_movements.stock_entry_item_id`

**Restricciones CHECK:**

- `chk_stock_entry_items_cost`: `(unit_cost >= 0)`
- `chk_stock_entry_items_quantity`: `(quantity > 0)`
- `chk_stock_entry_items_total`: `(line_total = (quantity * unit_cost))`

**Triggers:** `trg_stock_entry_items_bd` (BEFORE DELETE), `trg_stock_entry_items_bi` (BEFORE INSERT), `trg_stock_entry_items_bu` (BEFORE UPDATE)

---

## `inventory_adjustments`

**Propósito:** Cabecera de ajustes y bajas (conteo físico, vencidos, daños, pérdidas) con motivo obligatorio.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `adjustment_number` | `varchar(40)` | No |  | UQ |  |
| 3 | `branch_id` | `bigint unsigned` | No |  | FK | → `branches.id` |
| 4 | `adjustment_type` | `enum('PHYSICAL_COUNT','EXPIRED_WRITE_OFF','DAMAGE','LOSS','CORRECTION','OTHER')` | No |  |  |  |
| 5 | `reason` | `varchar(500)` | No |  |  |  |
| 6 | `performed_by` | `bigint unsigned` | No |  | FK | → `users.id` |
| 7 | `approved_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 8 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |

**Únicas:** `uq_inventory_adjustments_number` (adjustment_number)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `approved_by` → `users.id` (N:1, `fk_inventory_adjustments_approver`, ON DELETE RESTRICT)
- `branch_id` → `branches.id` (N:1, `fk_inventory_adjustments_branch`, ON DELETE RESTRICT)
- `performed_by` → `users.id` (N:1, `fk_inventory_adjustments_user`, ON DELETE RESTRICT)

**Referenciada por:** `inventory_movements.adjustment_id`

**Restricciones CHECK:**

- `chk_inventory_adjustments_reason`: `(char_length(trim(reason)) >= 5)`

---

## `cash_registers`

**Propósito:** Cajas físicas de cada sucursal.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `branch_id` | `bigint unsigned` | No |  | FK UQ* | → `branches.id` |
| 3 | `code` | `varchar(20)` | No |  | UQ* |  |
| 4 | `name` | `varchar(80)` | No |  |  |  |
| 5 | `is_active` | `tinyint(1)` | No | `1` |  |  |
| 6 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 7 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_cash_registers` (branch_id, code)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `branch_id` → `branches.id` (N:1, `fk_cash_registers_branch`, ON DELETE RESTRICT)

**Referenciada por:** `cash_sessions.cash_register_id`

---

## `cash_sessions`

**Propósito:** Turnos de caja: apertura, cierre, saldo esperado (calculado), contado y diferencia. Una sesión abierta por caja y por trabajador.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `session_number` | `varchar(40)` | No |  | UQ |  |
| 3 | `cash_register_id` | `bigint unsigned` | No |  | FK UQ* | → `cash_registers.id` |
| 4 | `opened_by` | `bigint unsigned` | No |  | FK UQ* | → `users.id` |
| 5 | `opened_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 6 | `opening_amount` | `decimal(12,2)` | No | `0.00` |  |  |
| 7 | `status` | `enum('OPEN','CLOSED')` | No | `OPEN` |  |  |
| 8 | `closed_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 9 | `closed_at` | `datetime` | Sí |  |  |  |
| 10 | `expected_amount` | `decimal(12,2)` | Sí |  |  |  |
| 11 | `counted_amount` | `decimal(12,2)` | Sí |  |  |  |
| 12 | `difference_amount` | `decimal(12,2)` | Sí |  |  | columna generada |
| 13 | `opening_notes` | `varchar(500)` | Sí |  |  |  |
| 14 | `closing_notes` | `varchar(500)` | Sí |  |  |  |
| 15 | `open_flag` | `tinyint` | Sí |  | UQ* | columna generada |

**Únicas:** `uq_cash_sessions_number` (session_number); `uq_cash_sessions_one_open_per_register` (cash_register_id, open_flag); `uq_cash_sessions_one_open_per_user` (opened_by, open_flag)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `closed_by` → `users.id` (N:1, `fk_cash_sessions_closed_by`, ON DELETE RESTRICT)
- `opened_by` → `users.id` (N:1, `fk_cash_sessions_opened_by`, ON DELETE RESTRICT)
- `cash_register_id` → `cash_registers.id` (N:1, `fk_cash_sessions_register`, ON DELETE RESTRICT)

**Referenciada por:** `cash_movements.cash_session_id`, `payments.cash_session_id`, `payments.refund_cash_session_id`, `sale_returns.refund_cash_session_id`, `sales.cash_session_id`

**Restricciones CHECK:**

- `chk_cash_sessions_counted`: `((counted_amount is null) or (counted_amount >= 0))`
- `chk_cash_sessions_dates`: `((closed_at is null) or (closed_at >= opened_at))`
- `chk_cash_sessions_opening`: `(opening_amount >= 0)`
- `chk_cash_sessions_state`: `(((status = 'OPEN') and (closed_at is null) and (closed_by is null) and (counted_amount is null) and (expected_amount is null)) or ((status = 'CLOSED') and (closed_at is not null) and (closed_by is not null) and (counted_amount is not null) and (expected_amount is not null)))`

**Triggers:** `trg_cash_sessions_bd` (BEFORE DELETE), `trg_cash_sessions_bi` (BEFORE INSERT), `trg_cash_sessions_bu` (BEFORE UPDATE)

---

## `carts`

**Propósito:** Carrito del cliente (un carrito ACTIVE por cliente).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `customer_id` | `bigint unsigned` | No |  | FK UQ* | → `customers.id` |
| 3 | `branch_id` | `bigint unsigned` | Sí |  | FK | → `branches.id` |
| 4 | `status` | `enum('ACTIVE','CONVERTED','ABANDONED')` | No | `ACTIVE` |  |  |
| 5 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 6 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |
| 7 | `active_flag` | `tinyint` | Sí |  | UQ* | columna generada |

**Únicas:** `uq_carts_one_active` (customer_id, active_flag)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `branch_id` → `branches.id` (N:1, `fk_carts_branch`, ON DELETE RESTRICT)
- `customer_id` → `customers.id` (N:1, `fk_carts_customer`, ON DELETE RESTRICT)

**Referenciada por:** `cart_items.cart_id`

---

## `cart_items`

**Propósito:** Productos del carrito.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `cart_id` | `bigint unsigned` | No |  | FK UQ* | → `carts.id` |
| 3 | `product_id` | `bigint unsigned` | No |  | FK UQ* | → `products.id` |
| 4 | `quantity` | `int unsigned` | No |  |  |  |
| 5 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 6 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_cart_product` (cart_id, product_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `cart_id` → `carts.id` (N:1, `fk_cart_items_cart`, ON DELETE CASCADE)
- `product_id` → `products.id` (N:1, `fk_cart_items_product`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_cart_items_quantity`: `(quantity > 0)`

---

## `orders`

**Propósito:** Pedidos de la tienda virtual: recojo o delivery, sucursal responsable, estados, dirección copiada, costo de delivery y trabajador asignado.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `order_number` | `varchar(40)` | No |  | UQ |  |
| 3 | `customer_id` | `bigint unsigned` | No |  | FK | → `customers.id` |
| 4 | `branch_id` | `bigint unsigned` | No |  | FK | → `branches.id` |
| 5 | `fulfillment_type` | `enum('PICKUP','DELIVERY')` | No |  |  |  |
| 6 | `status` | `enum('PENDING','CONFIRMED','PREPARING','READY_FOR_PICKUP','OUT_FOR_DELIVERY','COMPLETED','CANCELLED','REJECTED')` | No | `PENDING` |  |  |
| 7 | `address_id` | `bigint unsigned` | Sí |  | FK | → `customer_addresses.id` |
| 8 | `delivery_recipient_name` | `varchar(150)` | Sí |  |  |  |
| 9 | `delivery_phone` | `varchar(30)` | Sí |  |  |  |
| 10 | `delivery_address_line` | `varchar(255)` | Sí |  |  |  |
| 11 | `delivery_reference` | `varchar(255)` | Sí |  |  |  |
| 12 | `delivery_district` | `varchar(100)` | Sí |  |  |  |
| 13 | `delivery_province` | `varchar(100)` | Sí |  |  |  |
| 14 | `delivery_department` | `varchar(100)` | Sí |  |  |  |
| 15 | `subtotal` | `decimal(12,2)` | No | `0.00` |  |  |
| 16 | `discount_total` | `decimal(12,2)` | No | `0.00` |  |  |
| 17 | `delivery_fee` | `decimal(10,2)` | No | `0.00` |  |  |
| 18 | `total` | `decimal(12,2)` | No | `0.00` |  |  |
| 19 | `customer_note` | `varchar(500)` | Sí |  |  |  |
| 20 | `internal_note` | `varchar(500)` | Sí |  |  |  |
| 21 | `assigned_user_id` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 22 | `confirmed_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 23 | `confirmed_at` | `datetime` | Sí |  |  |  |
| 24 | `completed_at` | `datetime` | Sí |  |  |  |
| 25 | `cancelled_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 26 | `cancelled_at` | `datetime` | Sí |  |  |  |
| 27 | `cancel_reason` | `varchar(500)` | Sí |  |  |  |
| 28 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 29 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_orders_number` (order_number)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `address_id` → `customer_addresses.id` (N:1, `fk_orders_address`, ON DELETE RESTRICT)
- `assigned_user_id` → `users.id` (N:1, `fk_orders_assigned_user`, ON DELETE RESTRICT)
- `branch_id` → `branches.id` (N:1, `fk_orders_branch`, ON DELETE RESTRICT)
- `cancelled_by` → `users.id` (N:1, `fk_orders_cancelled_by`, ON DELETE RESTRICT)
- `confirmed_by` → `users.id` (N:1, `fk_orders_confirmed_by`, ON DELETE RESTRICT)
- `customer_id` → `customers.id` (N:1, `fk_orders_customer`, ON DELETE RESTRICT)

**Referenciada por:** `order_items.order_id`, `order_status_history.order_id`, `payments.order_id`, `sales.order_id`

**Restricciones CHECK:**

- `chk_orders_amounts`: `((subtotal >= 0) and (delivery_fee >= 0) and (discount_total >= 0) and (discount_total <= subtotal))`
- `chk_orders_cancel`: `((status not in ('CANCELLED','REJECTED')) or (cancel_reason is not null))`
- `chk_orders_delivery`: `(((fulfillment_type = 'DELIVERY') and (delivery_address_line is not null) and (delivery_phone is not null)) or ((fulfillment_type = 'PICKUP') and (delivery_fee = 0)))`
- `chk_orders_status_mode`: `(((status <> 'READY_FOR_PICKUP') or (fulfillment_type = 'PICKUP')) and ((status <> 'OUT_FOR_DELIVERY') or (fulfillment_type = 'DELIVERY')))`
- `chk_orders_total`: `(total = ((subtotal - discount_total) + delivery_fee))`

**Triggers:** `trg_orders_ai` (AFTER INSERT), `trg_orders_au` (AFTER UPDATE), `trg_orders_bd` (BEFORE DELETE), `trg_orders_bi` (BEFORE INSERT), `trg_orders_bu` (BEFORE UPDATE)

---

## `order_items`

**Propósito:** Detalle del pedido con copia de nombre/SKU y precio.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `order_id` | `bigint unsigned` | No |  | FK UQ* | → `orders.id` |
| 3 | `product_id` | `bigint unsigned` | No |  | FK UQ* | → `products.id` |
| 4 | `product_name_snapshot` | `varchar(180)` | No |  |  |  |
| 5 | `sku_snapshot` | `varchar(60)` | No |  |  |  |
| 6 | `quantity` | `int unsigned` | No |  |  |  |
| 7 | `unit_price` | `decimal(10,2)` | No |  |  |  |
| 8 | `line_total` | `decimal(12,2)` | No |  |  |  |

**Únicas:** `uq_order_items_product` (order_id, product_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `order_id` → `orders.id` (N:1, `fk_order_items_order`, ON DELETE RESTRICT)
- `product_id` → `products.id` (N:1, `fk_order_items_product`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_order_items_price`: `(unit_price >= 0)`
- `chk_order_items_quantity`: `(quantity > 0)`
- `chk_order_items_total`: `(line_total = (quantity * unit_price))`

**Triggers:** `trg_order_items_bd` (BEFORE DELETE), `trg_order_items_bi` (BEFORE INSERT), `trg_order_items_bu` (BEFORE UPDATE)

---

## `order_status_history`

**Propósito:** Historial inmutable de cambios de estado del pedido (lo llena un trigger).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `order_id` | `bigint unsigned` | No |  | FK | → `orders.id` |
| 3 | `from_status` | `varchar(30)` | Sí |  |  |  |
| 4 | `to_status` | `varchar(30)` | No |  |  |  |
| 5 | `changed_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 6 | `note` | `varchar(500)` | Sí |  |  |  |
| 7 | `changed_at` | `datetime(3)` | No | `CURRENT_TIMESTAMP(3)` |  |  |

**Relaciones (esta tabla referencia a):**

- `order_id` → `orders.id` (N:1, `fk_order_status_history_order`, ON DELETE RESTRICT)
- `changed_by` → `users.id` (N:1, `fk_order_status_history_user`, ON DELETE RESTRICT)

**Triggers:** `trg_order_status_history_bd` (BEFORE DELETE), `trg_order_status_history_bu` (BEFORE UPDATE)

---

## `sales`

**Propósito:** Ventas POS y ventas generadas al confirmar pedidos (una sola por pedido). No se eliminan ni se editan; se anulan.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `sale_number` | `varchar(40)` | No |  | UQ |  |
| 3 | `branch_id` | `bigint unsigned` | No |  | FK | → `branches.id` |
| 4 | `order_id` | `bigint unsigned` | Sí |  | FK UQ | → `orders.id` |
| 5 | `customer_id` | `bigint unsigned` | Sí |  | FK | → `customers.id` |
| 6 | `customer_name_snapshot` | `varchar(150)` | Sí |  |  |  |
| 7 | `customer_document_snapshot` | `varchar(40)` | Sí |  |  |  |
| 8 | `seller_user_id` | `bigint unsigned` | No |  | FK | → `users.id` |
| 9 | `cash_session_id` | `bigint unsigned` | Sí |  | FK | → `cash_sessions.id` |
| 10 | `sale_channel` | `enum('POS','ONLINE')` | No | `POS` |  |  |
| 11 | `status` | `enum('COMPLETED','VOIDED')` | No | `COMPLETED` |  |  |
| 12 | `subtotal` | `decimal(12,2)` | No | `0.00` |  |  |
| 13 | `discount_total` | `decimal(12,2)` | No | `0.00` |  |  |
| 14 | `delivery_fee` | `decimal(10,2)` | No | `0.00` |  |  |
| 15 | `total` | `decimal(12,2)` | No | `0.00` |  |  |
| 16 | `sold_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 17 | `notes` | `varchar(500)` | Sí |  |  |  |
| 18 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 19 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_sales_number` (sale_number); `uq_sales_order` (order_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `branch_id` → `branches.id` (N:1, `fk_sales_branch`, ON DELETE RESTRICT)
- `cash_session_id` → `cash_sessions.id` (N:1, `fk_sales_cash_session`, ON DELETE RESTRICT)
- `customer_id` → `customers.id` (N:1, `fk_sales_customer`, ON DELETE RESTRICT)
- `order_id` → `orders.id` (N:1, `fk_sales_order`, ON DELETE RESTRICT)
- `seller_user_id` → `users.id` (N:1, `fk_sales_seller`, ON DELETE RESTRICT)

**Referenciada por:** `payments.sale_id`, `sale_items.sale_id`, `sale_returns.sale_id`, `sale_tickets.sale_id`, `sale_voids.sale_id`

**Restricciones CHECK:**

- `chk_sales_amounts`: `((subtotal >= 0) and (delivery_fee >= 0) and (discount_total >= 0) and (discount_total <= subtotal))`
- `chk_sales_channel`: `(((sale_channel = 'POS') and (order_id is null) and (cash_session_id is not null) and (delivery_fee = 0)) or ((sale_channel = 'ONLINE') and (order_id is not null)))`
- `chk_sales_total`: `(total = ((subtotal - discount_total) + delivery_fee))`

**Triggers:** `trg_sales_bd` (BEFORE DELETE), `trg_sales_bi` (BEFORE INSERT), `trg_sales_bu` (BEFORE UPDATE)

---

## `sale_items`

**Propósito:** Líneas de venta con precio, descuento y referencia de receta.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `sale_id` | `bigint unsigned` | No |  | FK UQ* | → `sales.id` |
| 3 | `product_id` | `bigint unsigned` | No |  | FK UQ* | → `products.id` |
| 4 | `product_name_snapshot` | `varchar(180)` | No |  |  |  |
| 5 | `sku_snapshot` | `varchar(60)` | No |  |  |  |
| 6 | `quantity` | `int unsigned` | No |  |  |  |
| 7 | `unit_price` | `decimal(10,2)` | No |  |  |  |
| 8 | `line_subtotal` | `decimal(12,2)` | No |  |  |  |
| 9 | `discount_amount` | `decimal(12,2)` | No | `0.00` |  |  |
| 10 | `line_total` | `decimal(12,2)` | No |  |  |  |
| 11 | `prescription_reference` | `varchar(80)` | Sí |  |  |  |

**Únicas:** `uq_sale_items_product` (sale_id, product_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `product_id` → `products.id` (N:1, `fk_sale_items_product`, ON DELETE RESTRICT)
- `sale_id` → `sales.id` (N:1, `fk_sale_items_sale`, ON DELETE RESTRICT)

**Referenciada por:** `sale_item_batches.sale_item_id`

**Restricciones CHECK:**

- `chk_sale_items_discount`: `((discount_amount >= 0) and (discount_amount <= line_subtotal))`
- `chk_sale_items_price`: `(unit_price >= 0)`
- `chk_sale_items_quantity`: `(quantity > 0)`
- `chk_sale_items_subtotal`: `(line_subtotal = (quantity * unit_price))`
- `chk_sale_items_total`: `(line_total = (line_subtotal - discount_amount))`

**Triggers:** `trg_sale_items_bd` (BEFORE DELETE), `trg_sale_items_bi` (BEFORE INSERT), `trg_sale_items_bu` (BEFORE UPDATE)

---

## `sale_item_batches`

**Propósito:** Lotes usados en cada línea de venta (trazabilidad FEFO).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `sale_item_id` | `bigint unsigned` | No |  | FK UQ* | → `sale_items.id` |
| 3 | `batch_id` | `bigint unsigned` | No |  | FK UQ* | → `product_batches.id` |
| 4 | `quantity` | `int unsigned` | No |  |  |  |
| 5 | `batch_number_snapshot` | `varchar(60)` | No |  |  |  |
| 6 | `expiry_date_snapshot` | `date` | No |  |  |  |
| 7 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |

**Únicas:** `uq_sale_item_batches` (sale_item_id, batch_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `batch_id` → `product_batches.id` (N:1, `fk_sale_item_batches_batch`, ON DELETE RESTRICT)
- `sale_item_id` → `sale_items.id` (N:1, `fk_sale_item_batches_item`, ON DELETE RESTRICT)

**Referenciada por:** `inventory_movements.sale_item_batch_id`, `sale_return_items.sale_item_batch_id`

**Restricciones CHECK:**

- `chk_sale_item_batches_quantity`: `(quantity > 0)`

**Triggers:** `trg_sale_item_batches_bd` (BEFORE DELETE), `trg_sale_item_batches_bi` (BEFORE INSERT), `trg_sale_item_batches_bu` (BEFORE UPDATE)

---

## `payments`

**Propósito:** Pagos (divididos, simulados en modo DEMO o efectivo real en caja). Nunca guarda datos de tarjeta.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `operation_code` | `varchar(60)` | No |  | UQ |  |
| 3 | `sale_id` | `bigint unsigned` | Sí |  | FK | → `sales.id` |
| 4 | `order_id` | `bigint unsigned` | Sí |  | FK | → `orders.id` |
| 5 | `cash_session_id` | `bigint unsigned` | Sí |  | FK | → `cash_sessions.id` |
| 6 | `method` | `enum('CASH','CARD','TRANSFER','YAPE','PLIN','OTHER')` | No |  |  |  |
| 7 | `status` | `enum('PENDING','APPROVED','REJECTED','CANCELLED','REFUNDED')` | No | `PENDING` |  |  |
| 8 | `amount` | `decimal(12,2)` | No |  |  |  |
| 9 | `tendered_amount` | `decimal(12,2)` | Sí |  |  |  |
| 10 | `change_amount` | `decimal(12,2)` | Sí |  |  |  |
| 11 | `is_simulated` | `tinyint(1)` | No | `1` |  |  |
| 12 | `external_reference` | `varchar(100)` | Sí |  |  |  |
| 13 | `failure_reason` | `varchar(255)` | Sí |  |  |  |
| 14 | `processed_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 15 | `paid_at` | `datetime` | Sí |  |  |  |
| 16 | `refunded_at` | `datetime` | Sí |  |  |  |
| 17 | `refund_cash_session_id` | `bigint unsigned` | Sí |  | FK | → `cash_sessions.id` |
| 18 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 19 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_payments_operation_code` (operation_code)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `cash_session_id` → `cash_sessions.id` (N:1, `fk_payments_cash_session`, ON DELETE RESTRICT)
- `order_id` → `orders.id` (N:1, `fk_payments_order`, ON DELETE RESTRICT)
- `processed_by` → `users.id` (N:1, `fk_payments_processed_by`, ON DELETE RESTRICT)
- `refund_cash_session_id` → `cash_sessions.id` (N:1, `fk_payments_refund_session`, ON DELETE RESTRICT)
- `sale_id` → `sales.id` (N:1, `fk_payments_sale`, ON DELETE RESTRICT)

**Referenciada por:** `cash_movements.payment_id`

**Restricciones CHECK:**

- `chk_payments_amount`: `(amount > 0)`
- `chk_payments_cash_change`: `(((tendered_amount is null) and (change_amount is null)) or ((method = 'CASH') and (tendered_amount >= amount) and (change_amount = (tendered_amount - amount))))`
- `chk_payments_cash_refund`: `((status <> 'REFUNDED') or (method <> 'CASH') or (cash_session_id is null) or (refund_cash_session_id is not null))`
- `chk_payments_cash_session`: `((cash_session_id is null) or (processed_by is not null))`
- `chk_payments_no_card_data`: `(((external_reference is null) or (not(regexp_like(external_reference,'[0-9]{13,19}')))) and (not(regexp_like(operation_code,'[0-9]{13,19}'))))`
- `chk_payments_paid_at`: `((status not in ('APPROVED','REFUNDED')) or (paid_at is not null))`
- `chk_payments_refunded`: `((status = 'REFUNDED') = (refunded_at is not null))`
- `chk_payments_rejected`: `((status <> 'REJECTED') or (failure_reason is not null))`
- `chk_payments_target`: `((sale_id is not null) or (order_id is not null))`

**Triggers:** `trg_payments_ai` (AFTER INSERT), `trg_payments_au` (AFTER UPDATE), `trg_payments_bd` (BEFORE DELETE), `trg_payments_bi` (BEFORE INSERT), `trg_payments_bu` (BEFORE UPDATE)

---

## `sale_tickets`

**Propósito:** Ticket interno imprimible con copia de los datos de la botica, sucursal y vendedor. No es comprobante SUNAT.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `ticket_number` | `varchar(40)` | No |  | UQ |  |
| 3 | `sale_id` | `bigint unsigned` | No |  | FK UQ | → `sales.id` |
| 4 | `issued_by` | `bigint unsigned` | No |  | FK | → `users.id` |
| 5 | `issued_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 6 | `business_name_snapshot` | `varchar(180)` | No |  |  |  |
| 7 | `business_ruc_snapshot` | `varchar(20)` | Sí |  |  |  |
| 8 | `branch_name_snapshot` | `varchar(120)` | No |  |  |  |
| 9 | `branch_address_snapshot` | `varchar(400)` | Sí |  |  |  |
| 10 | `branch_phone_snapshot` | `varchar(30)` | Sí |  |  |  |
| 11 | `seller_name_snapshot` | `varchar(150)` | No |  |  |  |
| 12 | `customer_name_snapshot` | `varchar(150)` | Sí |  |  |  |
| 13 | `legend` | `varchar(255)` | No | `Ticket interno. No es un comprobante de pago electrónico.` |  |  |
| 14 | `print_count` | `int unsigned` | No | `0` |  |  |
| 15 | `last_printed_at` | `datetime` | Sí |  |  |  |

**Únicas:** `uq_sale_tickets_number` (ticket_number); `uq_sale_tickets_sale` (sale_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `sale_id` → `sales.id` (N:1, `fk_sale_tickets_sale`, ON DELETE RESTRICT)
- `issued_by` → `users.id` (N:1, `fk_sale_tickets_user`, ON DELETE RESTRICT)

**Triggers:** `trg_sale_tickets_bd` (BEFORE DELETE), `trg_sale_tickets_bi` (BEFORE INSERT)

---

## `sale_voids`

**Propósito:** Anulaciones de venta (motivo, responsable, autorizador). La venta original se conserva.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `sale_id` | `bigint unsigned` | No |  | FK UQ | → `sales.id` |
| 3 | `reason` | `varchar(500)` | No |  |  |  |
| 4 | `sale_total_snapshot` | `decimal(12,2)` | No | `0.00` |  |  |
| 5 | `voided_by` | `bigint unsigned` | No |  | FK | → `users.id` |
| 6 | `authorized_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 7 | `voided_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |

**Únicas:** `uq_sale_voids_sale` (sale_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `authorized_by` → `users.id` (N:1, `fk_sale_voids_authorizer`, ON DELETE RESTRICT)
- `sale_id` → `sales.id` (N:1, `fk_sale_voids_sale`, ON DELETE RESTRICT)
- `voided_by` → `users.id` (N:1, `fk_sale_voids_user`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_sale_voids_reason`: `(char_length(trim(reason)) >= 5)`

**Triggers:** `trg_sale_voids_ai` (AFTER INSERT), `trg_sale_voids_bd` (BEFORE DELETE), `trg_sale_voids_bi` (BEFORE INSERT), `trg_sale_voids_bu` (BEFORE UPDATE)

---

## `return_reasons`

**Propósito:** Catálogo de motivos de devolución.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `code` | `varchar(40)` | No |  | UQ |  |
| 3 | `name` | `varchar(120)` | No |  |  |  |
| 4 | `description` | `varchar(255)` | Sí |  |  |  |
| 5 | `is_active` | `tinyint(1)` | No | `1` |  |  |

**Únicas:** `uq_return_reasons_code` (code)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Referenciada por:** `sale_returns.reason_id`

**Restricciones CHECK:**

- `chk_return_reasons_code`: `regexp_like(code,'^[A-Z][A-Z0-9_]*$','c')`

---

## `sale_returns`

**Propósito:** Devoluciones (parciales o totales): estado, revisión, reembolso y caja usada.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `return_number` | `varchar(40)` | No |  | UQ |  |
| 3 | `sale_id` | `bigint unsigned` | No |  | FK | → `sales.id` |
| 4 | `return_type` | `enum('PARTIAL','TOTAL')` | No |  |  |  |
| 5 | `reason_id` | `bigint unsigned` | No |  | FK | → `return_reasons.id` |
| 6 | `status` | `enum('REQUESTED','APPROVED','REJECTED','COMPLETED')` | No | `REQUESTED` |  |  |
| 7 | `requested_by` | `bigint unsigned` | No |  | FK | → `users.id` |
| 8 | `requested_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 9 | `reviewed_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 10 | `reviewed_at` | `datetime` | Sí |  |  |  |
| 11 | `completed_at` | `datetime` | Sí |  |  |  |
| 12 | `refund_amount` | `decimal(12,2)` | No | `0.00` |  |  |
| 13 | `refund_method` | `enum('CASH','CARD','TRANSFER','YAPE','PLIN','OTHER')` | Sí |  |  |  |
| 14 | `refund_status` | `enum('NONE','PENDING','REFUNDED')` | No | `PENDING` |  |  |
| 15 | `refund_cash_session_id` | `bigint unsigned` | Sí |  | FK | → `cash_sessions.id` |
| 16 | `refund_operation_code` | `varchar(60)` | Sí |  |  |  |
| 17 | `notes` | `varchar(500)` | Sí |  |  |  |
| 18 | `rejection_reason` | `varchar(500)` | Sí |  |  |  |
| 19 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 20 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_sale_returns_number` (return_number)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `refund_cash_session_id` → `cash_sessions.id` (N:1, `fk_sale_returns_cash_session`, ON DELETE RESTRICT)
- `reason_id` → `return_reasons.id` (N:1, `fk_sale_returns_reason`, ON DELETE RESTRICT)
- `requested_by` → `users.id` (N:1, `fk_sale_returns_requested_by`, ON DELETE RESTRICT)
- `reviewed_by` → `users.id` (N:1, `fk_sale_returns_reviewed_by`, ON DELETE RESTRICT)
- `sale_id` → `sales.id` (N:1, `fk_sale_returns_sale`, ON DELETE RESTRICT)

**Referenciada por:** `cash_movements.sale_return_id`, `sale_return_items.sale_return_id`

**Restricciones CHECK:**

- `chk_sale_returns_amount`: `(refund_amount >= 0)`
- `chk_sale_returns_refund`: `((refund_status <> 'REFUNDED') or ((status = 'COMPLETED') and (refund_method is not null) and ((refund_method <> 'CASH') or (refund_cash_session_id is not null))))`
- `chk_sale_returns_rejected`: `((status <> 'REJECTED') or ((rejection_reason is not null) and (refund_status = 'NONE')))`
- `chk_sale_returns_review`: `((status = 'REQUESTED') or (reviewed_by is not null))`

**Triggers:** `trg_sale_returns_au` (AFTER UPDATE), `trg_sale_returns_bd` (BEFORE DELETE), `trg_sale_returns_bi` (BEFORE INSERT), `trg_sale_returns_bu` (BEFORE UPDATE)

---

## `sale_return_items`

**Propósito:** Ítems devueltos por lote vendido y su condición. Solo RESELLABLE reingresa al stock.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `sale_return_id` | `bigint unsigned` | No |  | FK UQ* | → `sale_returns.id` |
| 3 | `sale_item_batch_id` | `bigint unsigned` | No |  | FK UQ* | → `sale_item_batches.id` |
| 4 | `quantity` | `int unsigned` | No |  |  |  |
| 5 | `unit_refund_amount` | `decimal(10,2)` | No | `0.00` |  |  |
| 6 | `line_refund_amount` | `decimal(12,2)` | No | `0.00` |  |  |
| 7 | `item_condition` | `enum('RESELLABLE','DAMAGED','EXPIRED','OPENED','NOT_SUITABLE')` | No |  |  |  |
| 8 | `restock` | `tinyint(1)` | Sí |  |  | columna generada |
| 9 | `notes` | `varchar(255)` | Sí |  |  |  |

**Únicas:** `uq_sale_return_items` (sale_return_id, sale_item_batch_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `sale_item_batch_id` → `sale_item_batches.id` (N:1, `fk_sale_return_items_allocation`, ON DELETE RESTRICT)
- `sale_return_id` → `sale_returns.id` (N:1, `fk_sale_return_items_return`, ON DELETE RESTRICT)

**Referenciada por:** `inventory_movements.sale_return_item_id`

**Restricciones CHECK:**

- `chk_sale_return_items_amount`: `((unit_refund_amount >= 0) and (line_refund_amount = (quantity * unit_refund_amount)))`
- `chk_sale_return_items_quantity`: `(quantity > 0)`

**Triggers:** `trg_sale_return_items_bd` (BEFORE DELETE), `trg_sale_return_items_bi` (BEFORE INSERT), `trg_sale_return_items_bu` (BEFORE UPDATE)

---

## `cash_movements`

**Propósito:** Movimientos de efectivo de la sesión de caja. Los cobros y reembolsos en efectivo los crean triggers.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `cash_session_id` | `bigint unsigned` | No |  | FK | → `cash_sessions.id` |
| 3 | `movement_type` | `enum('SALE_INCOME','PAYMENT_REFUND','RETURN_REFUND','CASH_IN','CASH_OUT')` | No |  | UQ* |  |
| 4 | `direction` | `enum('IN','OUT')` | Sí |  |  | columna generada |
| 5 | `amount` | `decimal(12,2)` | No |  |  |  |
| 6 | `payment_id` | `bigint unsigned` | Sí |  | FK UQ* | → `payments.id` |
| 7 | `sale_return_id` | `bigint unsigned` | Sí |  | FK UQ | → `sale_returns.id` |
| 8 | `description` | `varchar(255)` | Sí |  |  |  |
| 9 | `performed_by` | `bigint unsigned` | No |  | FK | → `users.id` |
| 10 | `created_at` | `datetime(3)` | No | `CURRENT_TIMESTAMP(3)` |  |  |

**Únicas:** `uq_cash_movements_payment` (payment_id, movement_type); `uq_cash_movements_return` (sale_return_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `payment_id` → `payments.id` (N:1, `fk_cash_movements_payment`, ON DELETE RESTRICT)
- `sale_return_id` → `sale_returns.id` (N:1, `fk_cash_movements_return`, ON DELETE RESTRICT)
- `cash_session_id` → `cash_sessions.id` (N:1, `fk_cash_movements_session`, ON DELETE RESTRICT)
- `performed_by` → `users.id` (N:1, `fk_cash_movements_user`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_cash_movements_amount`: `(amount > 0)`
- `chk_cash_movements_source`: `(((movement_type in ('SALE_INCOME','PAYMENT_REFUND')) and (payment_id is not null) and (sale_return_id is null)) or ((movement_type = 'RETURN_REFUND') and (sale_return_id is not null) and (payment_id is null)) or ((movement_type in ('CASH_IN','CASH_OUT')) and (payment_id is null) and (sale_return_id is null) and (description is not null)))`

**Triggers:** `trg_cash_movements_bd` (BEFORE DELETE), `trg_cash_movements_bi` (BEFORE INSERT), `trg_cash_movements_bu` (BEFORE UPDATE)

---

## `branch_transfers`

**Propósito:** Transferencias entre sucursales (DRAFT → IN_TRANSIT → RECEIVED / CANCELLED).

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `transfer_number` | `varchar(40)` | No |  | UQ |  |
| 3 | `origin_branch_id` | `bigint unsigned` | No |  | FK | → `branches.id` |
| 4 | `destination_branch_id` | `bigint unsigned` | No |  | FK | → `branches.id` |
| 5 | `status` | `enum('DRAFT','IN_TRANSIT','RECEIVED','CANCELLED')` | No | `DRAFT` |  |  |
| 6 | `requested_by` | `bigint unsigned` | No |  | FK | → `users.id` |
| 7 | `requested_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 8 | `dispatched_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 9 | `dispatched_at` | `datetime` | Sí |  |  |  |
| 10 | `received_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 11 | `received_at` | `datetime` | Sí |  |  |  |
| 12 | `cancelled_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 13 | `cancelled_at` | `datetime` | Sí |  |  |  |
| 14 | `notes` | `varchar(500)` | Sí |  |  |  |
| 15 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 16 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |

**Únicas:** `uq_branch_transfers_number` (transfer_number)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `cancelled_by` → `users.id` (N:1, `fk_branch_transfers_cancelled_by`, ON DELETE RESTRICT)
- `destination_branch_id` → `branches.id` (N:1, `fk_branch_transfers_destination`, ON DELETE RESTRICT)
- `dispatched_by` → `users.id` (N:1, `fk_branch_transfers_dispatched_by`, ON DELETE RESTRICT)
- `origin_branch_id` → `branches.id` (N:1, `fk_branch_transfers_origin`, ON DELETE RESTRICT)
- `received_by` → `users.id` (N:1, `fk_branch_transfers_received_by`, ON DELETE RESTRICT)
- `requested_by` → `users.id` (N:1, `fk_branch_transfers_requested_by`, ON DELETE RESTRICT)

**Referenciada por:** `branch_transfer_items.transfer_id`

**Restricciones CHECK:**

- `chk_branch_transfers_branches`: `(origin_branch_id <> destination_branch_id)`
- `chk_branch_transfers_state`: `((status = 'DRAFT') or ((status = 'IN_TRANSIT') and (dispatched_by is not null) and (dispatched_at is not null)) or ((status = 'RECEIVED') and (dispatched_at is not null) and (received_by is not null) and (received_at is not null)) or ((status = 'CANCELLED') and (cancelled_by is not null) and (cancelled_at is not null)))`

**Triggers:** `trg_branch_transfers_bd` (BEFORE DELETE), `trg_branch_transfers_bi` (BEFORE INSERT), `trg_branch_transfers_bu` (BEFORE UPDATE)

---

## `branch_transfer_items`

**Propósito:** Lotes y cantidades transferidas, lote destino y cantidad recibida.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `transfer_id` | `bigint unsigned` | No |  | FK UQ* | → `branch_transfers.id` |
| 3 | `product_id` | `bigint unsigned` | No |  | FK | → `products.id` |
| 4 | `origin_batch_id` | `bigint unsigned` | No |  | FK UQ* | → `product_batches.id` |
| 5 | `destination_batch_id` | `bigint unsigned` | Sí |  | FK | → `product_batches.id` |
| 6 | `quantity` | `int unsigned` | No |  |  |  |
| 7 | `received_quantity` | `int unsigned` | Sí |  |  |  |
| 8 | `discrepancy_note` | `varchar(255)` | Sí |  |  |  |

**Únicas:** `uq_branch_transfer_items` (transfer_id, origin_batch_id)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `destination_batch_id` → `product_batches.id` (N:1, `fk_branch_transfer_items_destination_batch`, ON DELETE RESTRICT)
- `origin_batch_id` → `product_batches.id` (N:1, `fk_branch_transfer_items_origin_batch`, ON DELETE RESTRICT)
- `product_id` → `products.id` (N:1, `fk_branch_transfer_items_product`, ON DELETE RESTRICT)
- `transfer_id` → `branch_transfers.id` (N:1, `fk_branch_transfer_items_transfer`, ON DELETE RESTRICT)

**Referenciada por:** `inventory_movements.transfer_item_id`

**Restricciones CHECK:**

- `chk_branch_transfer_items_discrepancy`: `((received_quantity is null) or (received_quantity = quantity) or (discrepancy_note is not null))`
- `chk_branch_transfer_items_quantity`: `(quantity > 0)`
- `chk_branch_transfer_items_received`: `((received_quantity is null) or (received_quantity <= quantity))`

**Triggers:** `trg_branch_transfer_items_bd` (BEFORE DELETE), `trg_branch_transfer_items_bi` (BEFORE INSERT), `trg_branch_transfer_items_bu` (BEFORE UPDATE)

---

## `inventory_movements`

**Propósito:** Kardex inmutable. Cada fila cambia el stock de un lote y guarda stock anterior/posterior, responsable, motivo y documento de origen.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `branch_id` | `bigint unsigned` | No |  | FK | → `branches.id` |
| 3 | `product_id` | `bigint unsigned` | No |  | FK | → `products.id` |
| 4 | `batch_id` | `bigint unsigned` | No |  | FK UQ* | → `product_batches.id` |
| 5 | `movement_type` | `enum('PURCHASE_ENTRY','SALE_OUT','SALE_VOID_IN','RETURN_IN','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT_IN','ADJUSTMENT_OUT','EXPIRED_WRITE_OFF','DAMAGE_WRITE_OFF')` | No |  | UQ* |  |
| 6 | `direction` | `enum('IN','OUT')` | Sí |  |  | columna generada |
| 7 | `quantity` | `int unsigned` | No |  |  |  |
| 8 | `stock_before` | `int unsigned` | No |  |  |  |
| 9 | `stock_after` | `int unsigned` | No |  |  |  |
| 10 | `batch_stock_before` | `int unsigned` | No |  |  |  |
| 11 | `batch_stock_after` | `int unsigned` | No |  |  |  |
| 12 | `reason` | `varchar(500)` | Sí |  |  |  |
| 13 | `performed_by` | `bigint unsigned` | No |  | FK | → `users.id` |
| 14 | `stock_entry_item_id` | `bigint unsigned` | Sí |  | FK UQ | → `stock_entry_items.id` |
| 15 | `sale_item_batch_id` | `bigint unsigned` | Sí |  | FK UQ* | → `sale_item_batches.id` |
| 16 | `sale_return_item_id` | `bigint unsigned` | Sí |  | FK UQ | → `sale_return_items.id` |
| 17 | `transfer_item_id` | `bigint unsigned` | Sí |  | FK UQ* | → `branch_transfer_items.id` |
| 18 | `adjustment_id` | `bigint unsigned` | Sí |  | FK UQ* | → `inventory_adjustments.id` |
| 19 | `request_id` | `varchar(64)` | Sí |  |  |  |
| 20 | `created_at` | `datetime(3)` | No | `CURRENT_TIMESTAMP(3)` |  |  |

**Únicas:** `uq_movements_adjustment_batch` (adjustment_id, batch_id); `uq_movements_entry_item` (stock_entry_item_id); `uq_movements_return_item` (sale_return_item_id); `uq_movements_sale_alloc` (sale_item_batch_id, movement_type); `uq_movements_transfer_item` (transfer_item_id, movement_type)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `adjustment_id` → `inventory_adjustments.id` (N:1, `fk_movements_adjustment`, ON DELETE RESTRICT)
- `batch_id` → `product_batches.id` (N:1, `fk_movements_batch`, ON DELETE RESTRICT)
- `branch_id` → `branches.id` (N:1, `fk_movements_branch`, ON DELETE RESTRICT)
- `stock_entry_item_id` → `stock_entry_items.id` (N:1, `fk_movements_entry_item`, ON DELETE RESTRICT)
- `product_id` → `products.id` (N:1, `fk_movements_product`, ON DELETE RESTRICT)
- `sale_return_item_id` → `sale_return_items.id` (N:1, `fk_movements_return_item`, ON DELETE RESTRICT)
- `sale_item_batch_id` → `sale_item_batches.id` (N:1, `fk_movements_sale_alloc`, ON DELETE RESTRICT)
- `transfer_item_id` → `branch_transfer_items.id` (N:1, `fk_movements_transfer_item`, ON DELETE RESTRICT)
- `performed_by` → `users.id` (N:1, `fk_movements_user`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_movements_arithmetic`: `(((direction = 'IN') and (stock_after = (stock_before + quantity)) and (batch_stock_after = (batch_stock_before + quantity))) or ((direction = 'OUT') and (stock_before = (stock_after + quantity)) and (batch_stock_before = (batch_stock_after + quantity))))`
- `chk_movements_quantity`: `(quantity > 0)`
- `chk_movements_single_source`: `((((((stock_entry_item_id is not null) + (sale_item_batch_id is not null)) + (sale_return_item_id is not null)) + (transfer_item_id is not null)) + (adjustment_id is not null)) = 1)`
- `chk_movements_source_type`: `(((movement_type = 'PURCHASE_ENTRY') and (stock_entry_item_id is not null)) or ((movement_type in ('SALE_OUT','SALE_VOID_IN')) and (sale_item_batch_id is not null)) or ((movement_type = 'RETURN_IN') and (sale_return_item_id is not null)) or ((movement_type in ('TRANSFER_OUT','TRANSFER_IN')) and (transfer_item_id is not null)) or ((movement_type in ('ADJUSTMENT_IN','ADJUSTMENT_OUT','EXPIRED_WRITE_OFF','DAMAGE_WRITE_OFF')) and (adjustment_id is not null)))`

**Triggers:** `trg_inventory_movements_ai` (AFTER INSERT), `trg_inventory_movements_bd` (BEFORE DELETE), `trg_inventory_movements_bi` (BEFORE INSERT), `trg_inventory_movements_bu` (BEFORE UPDATE)

---

## `stock_alerts`

**Propósito:** Alertas de stock bajo, agotado, por vencer y vencido, con resolución. No permite duplicar alertas abiertas.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `branch_id` | `bigint unsigned` | No |  | FK UQ* | → `branches.id` |
| 3 | `product_id` | `bigint unsigned` | No |  | FK UQ* | → `products.id` |
| 4 | `batch_id` | `bigint unsigned` | Sí |  | FK | → `product_batches.id` |
| 5 | `alert_type` | `enum('LOW_STOCK','OUT_OF_STOCK','EXPIRING_SOON','EXPIRED')` | No |  | UQ* |  |
| 6 | `status` | `enum('OPEN','RESOLVED','DISMISSED')` | No | `OPEN` |  |  |
| 7 | `stock_at_alert` | `int unsigned` | No |  |  |  |
| 8 | `threshold_at_alert` | `int unsigned` | Sí |  |  |  |
| 9 | `expiry_date_at_alert` | `date` | Sí |  |  |  |
| 10 | `message` | `varchar(255)` | Sí |  |  |  |
| 11 | `created_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  |  |
| 12 | `updated_at` | `datetime` | No | `CURRENT_TIMESTAMP` |  | on update current_timestamp |
| 13 | `resolved_at` | `datetime` | Sí |  |  |  |
| 14 | `resolved_by` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 15 | `resolution_note` | `varchar(255)` | Sí |  |  |  |
| 16 | `batch_key` | `bigint unsigned` | Sí |  | UQ* | columna generada |
| 17 | `open_flag` | `tinyint` | Sí |  | UQ* | columna generada |

**Únicas:** `uq_stock_alerts_open` (branch_id, product_id, alert_type, batch_key, open_flag)  
_UQ\* = la columna forma parte de una clave única compuesta._

**Relaciones (esta tabla referencia a):**

- `batch_id` → `product_batches.id` (N:1, `fk_stock_alerts_batch`, ON DELETE RESTRICT)
- `branch_id` → `branches.id` (N:1, `fk_stock_alerts_branch`, ON DELETE RESTRICT)
- `product_id` → `products.id` (N:1, `fk_stock_alerts_product`, ON DELETE RESTRICT)
- `resolved_by` → `users.id` (N:1, `fk_stock_alerts_user`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_stock_alerts_batch`: `((alert_type in ('EXPIRING_SOON','EXPIRED')) = (batch_id is not null))`
- `chk_stock_alerts_resolution`: `((status = 'OPEN') = (resolved_at is null))`

**Triggers:** `trg_stock_alerts_bd` (BEFORE DELETE)

---

## `audit_logs`

**Propósito:** Auditoría de solo inserción (usuario, acción, módulo, registro, valores anterior/nuevo, petición). Sin contraseñas ni tokens.

| # | Columna | Tipo | Nulo | Por defecto | Clave | Notas |
|---|---|---|---|---|---|---|
| 1 | `id` | `bigint unsigned` | No |  | PK | auto_increment |
| 2 | `user_id` | `bigint unsigned` | Sí |  | FK | → `users.id` |
| 3 | `branch_id` | `bigint unsigned` | Sí |  | FK | → `branches.id` |
| 4 | `action` | `varchar(40)` | No |  |  |  |
| 5 | `module` | `varchar(60)` | No |  |  |  |
| 6 | `entity_table` | `varchar(64)` | Sí |  |  |  |
| 7 | `entity_id` | `varchar(64)` | Sí |  |  |  |
| 8 | `old_values` | `json` | Sí |  |  |  |
| 9 | `new_values` | `json` | Sí |  |  |  |
| 10 | `ip_address` | `varchar(45)` | Sí |  |  |  |
| 11 | `user_agent` | `varchar(255)` | Sí |  |  |  |
| 12 | `request_id` | `varchar(64)` | Sí |  |  |  |
| 13 | `session_ref` | `varchar(64)` | Sí |  |  |  |
| 14 | `created_at` | `datetime(3)` | No | `CURRENT_TIMESTAMP(3)` |  |  |

**Relaciones (esta tabla referencia a):**

- `branch_id` → `branches.id` (N:1, `fk_audit_logs_branch`, ON DELETE RESTRICT)
- `user_id` → `users.id` (N:1, `fk_audit_logs_user`, ON DELETE RESTRICT)

**Restricciones CHECK:**

- `chk_audit_logs_no_secrets_new`: `((new_values is null) or (json_contains_path(new_values,'one','$.password','$.password_hash','$.token','$.access_token','$.refresh_token','$.secret') = 0))`
- `chk_audit_logs_no_secrets_old`: `((old_values is null) or (json_contains_path(old_values,'one','$.password','$.password_hash','$.token','$.access_token','$.refresh_token','$.secret') = 0))`

**Triggers:** `trg_audit_logs_bd` (BEFORE DELETE), `trg_audit_logs_bu` (BEFORE UPDATE)

