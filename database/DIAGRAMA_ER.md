# Diagrama entidad-relación — Pharma Plus (`pharma_plus`)

Modelo de **42 tablas**, **103 claves foráneas** y **17 vistas** para MySQL 8. Para que sea legible, el modelo se presenta en una vista general y luego por módulos. Todas las relaciones coinciden con las FK reales de `pharma_plus_mysql8.sql` (ver `DICCIONARIO_DATOS.md`).

**Lectura de cardinalidades (notación pata de gallo de Mermaid)**

| Símbolo | Significado |
|---|---|
| `\|\|--o{` | uno a cero o muchos |
| `\|\|--\|{` | uno a uno o muchos |
| `\|o--o{` | cero o uno a cero o muchos (FK opcional) |
| `\|\|--o\|` | uno a cero o uno (FK única) |

---

## 1. Vista general

Las flechas resumen el flujo principal: catálogo único → configuración por sucursal → lotes → kardex, y cómo ventas, pedidos, devoluciones y transferencias afectan al inventario **solo** a través de `inventory_movements`.

```mermaid
erDiagram
    branches ||--o{ branch_products : "configura"
    products ||--o{ branch_products : "se ofrece en"
    products ||--o{ product_batches : "tiene lotes"
    branches ||--o{ product_batches : "almacena"
    stock_entries ||--|{ stock_entry_items : "detalla"
    product_batches ||--o{ stock_entry_items : "ingresa por"
    product_batches ||--o{ inventory_movements : "kardex"
    sales ||--|{ sale_items : "contiene"
    sale_items ||--|{ sale_item_batches : "sale de lotes"
    product_batches ||--o{ sale_item_batches : "vendido en"
    orders |o--o| sales : "genera una venta"
    sales ||--o{ payments : "se paga con"
    sales ||--o| sale_voids : "puede anularse"
    sales ||--o{ sale_returns : "puede devolverse"
    sale_returns ||--|{ sale_return_items : "detalla"
    branch_transfers ||--|{ branch_transfer_items : "detalla"
    cash_sessions ||--o{ cash_movements : "registra"
    cash_sessions |o--o{ sales : "cobra"
    users ||--o{ inventory_movements : "responsable"
    product_batches ||--o{ stock_alerts : "alerta vencimiento"
```

---

## 2. Seguridad, sucursales y configuración

```mermaid
erDiagram
    roles ||--o{ users : "asigna"
    roles ||--o{ role_permissions : "tiene"
    permissions ||--o{ role_permissions : "otorgado a"
    users ||--o{ user_permissions : "excepciones"
    permissions ||--o{ user_permissions : "concede o niega"
    users |o--o{ user_permissions : "granted_by"
    users ||--o{ user_branches : "trabaja en"
    branches ||--o{ user_branches : "tiene personal"
    branches ||--|{ document_sequences : "numeración"
    users |o--o{ settings : "updated_by"
    users |o--o{ audit_logs : "actúa"
    branches |o--o{ audit_logs : "contexto"

    roles {
        bigint id PK
        varchar code UK "ADMIN, STAFF, CUSTOMER"
        varchar name
        boolean is_system
    }
    permissions {
        bigint id PK
        varchar code UK "modulo.accion"
        varchar module
        varchar name
    }
    role_permissions {
        bigint role_id PK,FK
        bigint permission_id PK,FK
    }
    users {
        bigint id PK
        bigint role_id FK
        varchar email UK
        varchar password_hash "solo bcrypt o Argon2"
        enum status
    }
    user_permissions {
        bigint user_id PK,FK
        bigint permission_id PK,FK
        enum effect "GRANT o DENY"
        bigint granted_by FK
    }
    user_branches {
        bigint user_id PK,FK
        bigint branch_id PK,FK
        boolean is_default
    }
    branches {
        bigint id PK
        varchar code UK
        varchar name UK
        boolean is_main "una sola principal"
        enum status
    }
    document_sequences {
        bigint id PK
        bigint branch_id FK
        enum document_type
        varchar prefix
        bigint next_number
    }
    settings {
        varchar setting_key PK
        varchar setting_value
        enum value_type
        bigint updated_by FK
    }
    audit_logs {
        bigint id PK
        bigint user_id FK
        bigint branch_id FK
        varchar action
        varchar module
        json old_values
        json new_values
    }
```

---

## 3. Catálogo, proveedores, lotes e inventario

```mermaid
erDiagram
    categories ||--o{ products : "clasifica"
    laboratories |o--o{ products : "fabrica"
    products ||--o{ branch_products : "por sucursal"
    branches ||--o{ branch_products : "configura"
    products ||--o{ product_batches : "lotes"
    branches ||--o{ product_batches : "almacena"
    suppliers |o--o{ stock_entries : "provee"
    branches ||--o{ stock_entries : "recibe"
    users ||--o{ stock_entries : "registra"
    stock_entries |o--o{ product_batches : "origina"
    stock_entries ||--|{ stock_entry_items : "detalle"
    product_batches ||--o{ stock_entry_items : "lote recibido"
    products ||--o{ stock_entry_items : "producto"
    branches ||--o{ inventory_adjustments : "ajusta"
    users ||--o{ inventory_adjustments : "realiza"
    product_batches ||--o{ inventory_movements : "mueve"
    products ||--o{ inventory_movements : "producto"
    branches ||--o{ inventory_movements : "sucursal"
    users ||--o{ inventory_movements : "performed_by"
    stock_entry_items |o--o| inventory_movements : "PURCHASE_ENTRY (una vez)"
    inventory_adjustments |o--o{ inventory_movements : "ajustes y bajas"
    branches ||--o{ stock_alerts : "alertas"
    products ||--o{ stock_alerts : "alertas"
    product_batches |o--o{ stock_alerts : "vencimiento"
    users |o--o{ stock_alerts : "resolved_by"

    products {
        bigint id PK
        bigint category_id FK
        bigint laboratory_id FK
        varchar sku UK
        varchar barcode UK
        varchar name
        varchar active_ingredient
        varchar concentration
        varchar dosage_form
        decimal sale_price "precio general"
        boolean requires_prescription
        enum status
    }
    branch_products {
        bigint id PK
        bigint branch_id FK
        bigint product_id FK
        decimal sale_price "NULL usa el general"
        int minimum_stock "20 por defecto"
    }
    product_batches {
        bigint id PK
        bigint product_id FK
        bigint branch_id FK
        varchar batch_number
        date expiry_date
        int received_quantity
        int current_quantity "fuente del stock"
        bigint stock_entry_id FK
        enum status
    }
    stock_entries {
        bigint id PK
        varchar entry_number UK
        bigint branch_id FK
        bigint supplier_id FK
        enum status "DRAFT POSTED CANCELLED"
        decimal total_cost
    }
    stock_entry_items {
        bigint id PK
        bigint stock_entry_id FK
        bigint batch_id FK
        int quantity
        decimal unit_cost
    }
    inventory_movements {
        bigint id PK
        bigint batch_id FK
        enum movement_type
        enum direction "generada"
        int quantity
        int stock_before
        int stock_after
        bigint performed_by FK
        bigint source_FKs "uno según el tipo"
    }
    stock_alerts {
        bigint id PK
        bigint branch_id FK
        bigint product_id FK
        bigint batch_id FK
        enum alert_type
        enum status "una abierta por clave"
    }
```

`inventory_movements` además referencia, de forma excluyente según `movement_type`, a `sale_item_batches`, `sale_return_items` y `branch_transfer_items` (ver secciones 4 y 6). Un CHECK obliga a que exista exactamente un documento de origen.

---

## 4. Ventas, pagos, tickets y caja

```mermaid
erDiagram
    branches ||--o{ cash_registers : "tiene cajas"
    cash_registers ||--o{ cash_sessions : "turnos"
    users ||--o{ cash_sessions : "opened_by"
    users |o--o{ cash_sessions : "closed_by"
    cash_sessions ||--o{ cash_movements : "efectivo"
    users ||--o{ cash_movements : "performed_by"
    branches ||--o{ sales : "vende"
    users ||--o{ sales : "seller"
    customers |o--o{ sales : "cliente opcional"
    cash_sessions |o--o{ sales : "POS obligatorio"
    orders |o--o| sales : "pedido confirmado"
    sales ||--|{ sale_items : "líneas"
    products ||--o{ sale_items : "producto"
    sale_items ||--|{ sale_item_batches : "lotes FEFO"
    product_batches ||--o{ sale_item_batches : "lote"
    sale_item_batches ||--o{ inventory_movements : "SALE_OUT y SALE_VOID_IN"
    sales |o--o{ payments : "pagos divididos"
    orders |o--o{ payments : "pago del pedido"
    cash_sessions |o--o{ payments : "cobro en caja"
    payments |o--o{ cash_movements : "SALE_INCOME o PAYMENT_REFUND"
    sales ||--o| sale_tickets : "ticket interno"
    users ||--o{ sale_tickets : "issued_by"

    sales {
        bigint id PK
        varchar sale_number UK
        bigint branch_id FK
        bigint order_id FK,UK "una venta por pedido"
        bigint customer_id FK
        bigint seller_user_id FK
        bigint cash_session_id FK
        enum sale_channel "POS u ONLINE"
        enum status "COMPLETED o VOIDED"
        decimal subtotal
        decimal discount_total
        decimal total
    }
    sale_items {
        bigint id PK
        bigint sale_id FK
        bigint product_id FK
        int quantity
        decimal unit_price
        decimal discount_amount
        decimal line_total
        varchar prescription_reference
    }
    sale_item_batches {
        bigint id PK
        bigint sale_item_id FK
        bigint batch_id FK
        int quantity
        date expiry_date_snapshot
    }
    payments {
        bigint id PK
        varchar operation_code UK
        bigint sale_id FK
        bigint order_id FK
        bigint cash_session_id FK
        enum method
        enum status
        decimal amount
        boolean is_simulated
    }
    sale_tickets {
        bigint id PK
        varchar ticket_number UK
        bigint sale_id FK,UK
        varchar business_name_snapshot
        varchar branch_name_snapshot
        varchar seller_name_snapshot
    }
    cash_sessions {
        bigint id PK
        bigint cash_register_id FK
        bigint opened_by FK
        decimal opening_amount
        enum status "OPEN o CLOSED"
        decimal expected_amount "calculado al cerrar"
        decimal counted_amount
        decimal difference_amount "generada"
    }
    cash_movements {
        bigint id PK
        bigint cash_session_id FK
        enum movement_type
        decimal amount
        bigint payment_id FK
        bigint sale_return_id FK
    }
```

---

## 5. Tienda virtual: clientes, carrito y pedidos

```mermaid
erDiagram
    users |o--o| customers : "cuenta web"
    users |o--o{ customers : "created_by"
    customers ||--o{ customer_addresses : "direcciones"
    customers ||--o{ carts : "carritos"
    branches |o--o{ carts : "sucursal elegida"
    carts ||--o{ cart_items : "contiene"
    products ||--o{ cart_items : "producto"
    customers ||--o{ orders : "realiza"
    branches ||--o{ orders : "responsable"
    customer_addresses |o--o{ orders : "entrega"
    users |o--o{ orders : "assigned, confirmed, cancelled"
    orders ||--|{ order_items : "detalle"
    products ||--o{ order_items : "producto"
    orders ||--|{ order_status_history : "historial"
    users |o--o{ order_status_history : "changed_by"
    orders |o--o| sales : "al confirmar"

    customers {
        bigint id PK
        bigint user_id FK,UK "NULL si no tiene cuenta"
        varchar full_name
        enum document_type
        varchar document_number
    }
    customer_addresses {
        bigint id PK
        bigint customer_id FK
        varchar address_line
        varchar district
        boolean is_default
    }
    carts {
        bigint id PK
        bigint customer_id FK
        bigint branch_id FK
        enum status "un ACTIVE por cliente"
    }
    orders {
        bigint id PK
        varchar order_number UK
        bigint customer_id FK
        bigint branch_id FK
        enum fulfillment_type "PICKUP o DELIVERY"
        enum status
        bigint address_id FK
        varchar delivery_address_line "copia"
        decimal delivery_fee
        decimal total
        bigint assigned_user_id FK
    }
    order_status_history {
        bigint id PK
        bigint order_id FK
        varchar from_status
        varchar to_status
        datetime changed_at
    }
```

---

## 6. Anulaciones, devoluciones y transferencias

```mermaid
erDiagram
    sales ||--o| sale_voids : "anulación"
    users ||--o{ sale_voids : "voided_by"
    sales ||--o{ sale_returns : "devoluciones"
    return_reasons ||--o{ sale_returns : "motivo"
    users ||--o{ sale_returns : "requested, reviewed"
    cash_sessions |o--o{ sale_returns : "caja del reembolso"
    sale_returns ||--|{ sale_return_items : "ítems"
    sale_item_batches ||--o{ sale_return_items : "lote vendido"
    sale_return_items |o--o| inventory_movements : "RETURN_IN si RESELLABLE"
    sale_returns |o--o| cash_movements : "RETURN_REFUND"
    branches ||--o{ branch_transfers : "origen"
    branches ||--o{ branch_transfers : "destino"
    users ||--o{ branch_transfers : "requested, dispatched, received"
    branch_transfers ||--|{ branch_transfer_items : "ítems"
    product_batches ||--o{ branch_transfer_items : "lote origen"
    product_batches |o--o{ branch_transfer_items : "lote destino"
    branch_transfer_items ||--o{ inventory_movements : "TRANSFER_OUT y TRANSFER_IN"

    sale_voids {
        bigint id PK
        bigint sale_id FK,UK
        varchar reason
        bigint voided_by FK
        bigint authorized_by FK
    }
    sale_returns {
        bigint id PK
        varchar return_number UK
        bigint sale_id FK
        enum return_type "PARTIAL o TOTAL"
        enum status
        decimal refund_amount
        enum refund_status
    }
    sale_return_items {
        bigint id PK
        bigint sale_return_id FK
        bigint sale_item_batch_id FK
        int quantity
        enum item_condition
        boolean restock "generada"
    }
    branch_transfers {
        bigint id PK
        varchar transfer_number UK
        bigint origin_branch_id FK
        bigint destination_branch_id FK
        enum status
    }
    branch_transfer_items {
        bigint id PK
        bigint transfer_id FK
        bigint origin_batch_id FK
        bigint destination_batch_id FK
        int quantity
        int received_quantity
    }
```

---

## 7. Cardinalidades clave y reglas que las garantizan

| Relación | Cardinalidad | Cómo se garantiza en la BD |
|---|---|---|
| Producto ↔ Sucursal | N:M vía `branch_products` | `UNIQUE (branch_id, product_id)`; el catálogo no se duplica |
| Producto + Sucursal → Lotes | 1:N | `UNIQUE (branch_id, product_id, batch_number)` |
| Pedido → Venta | 1:0..1 | `sales.order_id UNIQUE`; trigger exige pedido `PENDING` |
| Venta → Anulación | 1:0..1 | `sale_voids.sale_id UNIQUE` |
| Venta → Ticket | 1:0..1 | `sale_tickets.sale_id UNIQUE` |
| Línea de entrada → Movimiento | 1:0..1 | `UNIQUE (stock_entry_item_id)` |
| Lote vendido → Movimiento | 1:0..1 por tipo | `UNIQUE (sale_item_batch_id, movement_type)` |
| Ítem devuelto → Movimiento | 1:0..1 | `UNIQUE (sale_return_item_id)` |
| Ítem transferido → Movimiento | 1:0..1 por tipo | `UNIQUE (transfer_item_id, movement_type)` |
| Caja → Sesión abierta | 1:0..1 | `UNIQUE (cash_register_id, open_flag)` |
| Trabajador → Sesión abierta | 1:0..1 | `UNIQUE (opened_by, open_flag)` |
| Cliente → Carrito activo | 1:0..1 | `UNIQUE (customer_id, active_flag)` |
| Alerta abierta por producto/sucursal/tipo/lote | 0..1 | `UNIQUE (branch_id, product_id, alert_type, batch_key, open_flag)` |
| Sistema → Sucursal principal | exactamente 1 | `UNIQUE (main_flag)` + dato inicial |
