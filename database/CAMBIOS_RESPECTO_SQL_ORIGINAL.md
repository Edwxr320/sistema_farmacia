# Cambios respecto al SQL original

Comparación entre `pharma_plus_original.sql` (15 tablas, 2 vistas, 8 categorías) y `pharma_plus_mysql8.sql` (42 tablas, 17 vistas, 77 triggers, 4 procedimientos).

Resumen: **se conservaron los nombres de las 15 tablas originales** y las 2 vistas; todas se modificaron para soportar sucursales, lotes y trazabilidad. Se agregaron **27 tablas nuevas**. No se eliminó ninguna tabla original.

---

## 1. Diagnóstico del SQL original

| # | Problema | Consecuencia | Solución adoptada |
|---|---|---|---|
| 1 | Stock como un número en `products.current_stock` | Sin sucursales, lotes ni vencimientos; imposible aplicar FEFO ni bloquear vencidos | Stock en `product_batches` por lote y sucursal |
| 2 | Stock y kardex podían diferir (dos fuentes de verdad) | Inventario inconsistente si el backend olvida un paso | El stock **solo** cambia insertando en `inventory_movements`; un trigger actualiza el lote en la misma transacción y otro bloquea las actualizaciones directas |
| 3 | `users.role` como ENUM | Permisos rígidos | RBAC: `roles`, `permissions`, `role_permissions`, `user_permissions` (GRANT/DENY) |
| 4 | Un solo `payment_method` en `sales` | Sin pagos divididos ni pagos simulados trazables | Tabla `payments` (N pagos por venta, `is_simulated`) |
| 5 | Proveedor como texto libre en `stock_entries` | Datos repetidos y sin control | Tabla `suppliers` con RUC validado |
| 6 | Sin caja, devoluciones, anulaciones, transferencias, tickets ni auditoría | Requisitos del caso no cubiertos | Módulos nuevos (ver sección 4) |
| 7 | `ON UPDATE CASCADE` en todas las FK | Innecesario con PK autoincrementales; además MySQL 8 impide CHECK sobre columnas con acciones en cascada | `ON UPDATE RESTRICT ON DELETE RESTRICT` |
| 8 | `ON DELETE CASCADE` en `order_items` y `ON DELETE SET NULL` en `sales.customer_id` y `orders.address_id` | Borrar un pedido o cliente borraba o desvinculaba historial | `RESTRICT` + triggers que impiden borrar históricos (se usan estados) |
| 9 | Sin control de pedido → venta → descuento único | Riesgo de descontar stock dos veces | `sales.order_id UNIQUE`, confirmación exige venta, índices únicos por movimiento |
| 10 | Alertas sin prevención de duplicados | Varias alertas abiertas iguales | Índice único sobre alertas **abiertas** (columna generada `open_flag`) |
| 11 | `TIMESTAMP` dependiente de la zona horaria de sesión | Fechas desplazadas según el servidor | `DATETIME` en hora de Lima (`SET time_zone='-05:00'` en el backend) |

---

## 2. Tablas originales: qué pasó con cada una

| Tabla original | Estado | Cambios principales y motivo |
|---|---|---|
| `users` | **Modificada** | `role` (ENUM) → `role_id` FK a `roles`. CHECK que solo acepta hashes bcrypt/Argon2. Nuevos: `must_change_password`, `failed_login_attempts`, `locked_until`, `password_changed_at`. No se elimina (trigger). |
| `customers` | **Modificada** | `user_id` pasa a ser opcional (clientes registrados en caja sin cuenta web). Nuevos: `full_name`, `phone`, `email`, `is_active`, `created_by`. Tipo de documento `RUC`; CHECK de DNI (8 dígitos) y RUC (11). |
| `customer_addresses` | **Modificada** | Nuevos: `label`, `latitude`, `longitude`, `is_active`, `updated_at`; una sola dirección por defecto activa por cliente. |
| `categories` | **Conservada** | Mismas columnas; fechas a `DATETIME`. Se conservan las 8 categorías originales con su texto exacto. |
| `products` | **Modificada** | **Se quitan** `current_stock` y `minimum_stock` (pasan a `product_batches` y `branch_products`). `is_active` → `status` (ACTIVE/INACTIVE/DISCONTINUED). Nuevos: `laboratory_id`, `active_ingredient`, `concentration`, `dosage_form`, `presentation`, `sanitary_registration`, índice FULLTEXT. `purchase_price` y `sale_price` conservan su nombre (referencia y precio general). |
| `carts` | **Modificada** | Nuevo `branch_id` (sucursal elegida); un solo carrito `ACTIVE` por cliente. |
| `cart_items` | **Conservada** | Igual; FK `ON UPDATE CASCADE` → `RESTRICT` (se mantiene `ON DELETE CASCADE` desde `carts`). |
| `orders` | **Modificada** | Nuevos: `branch_id` (sucursal responsable), `fulfillment_type` (PICKUP/DELIVERY), copia de la dirección de entrega, `discount_total`, `assigned_user_id`, `internal_note`, datos de confirmación, entrega y cancelación. Estados ampliados (ver sección 3). |
| `order_items` | **Modificada** | CHECK `line_total = quantity × unit_price`; un producto por pedido; ya no se borra en cascada. |
| `sales` | **Modificada** | Nuevos: `branch_id`, `cash_session_id`, `status` (COMPLETED/VOIDED), `delivery_fee`, `customer_*_snapshot`. **Se quitan** `payment_method` y `payment_status` (ahora en `payments` y `vw_sale_payment_summary`). `discount` → `discount_total`. CHECK de totales y de canal. Inmutable. |
| `sale_items` | **Modificada** | Nuevos: `line_subtotal`, `discount_amount`, `prescription_reference`. Los lotes vendidos van en `sale_item_batches`. Inmutable. |
| `stock_entries` | **Modificada** | `supplier_name` (texto) → `supplier_id` FK. Nuevos: `branch_id`, `entry_type`, `reference_document_type`, `status` (DRAFT/POSTED/CANCELLED), `posted_at`. `invoice_number` → `reference_document_number`. El total lo calcula la base al contabilizar. |
| `stock_entry_items` | **Modificada** | Nuevo `batch_id` (qué lote ingresó). `line_total` validado por CHECK. |
| `inventory_movements` | **Modificada (rediseñada)** | Nuevos: `branch_id`, `batch_id`, `batch_stock_before/after`, `reason`, documento de origen (`stock_entry_item_id`, `sale_item_batch_id`, `sale_return_item_id`, `transfer_item_id`, `adjustment_id`), `request_id`. `description` → `reason`. Tipos ampliados; `direction` generada. Inmutable y única vía para cambiar stock. |
| `stock_alerts` | **Modificada** | Nuevos: `branch_id`, `batch_id`, `alert_type`, `threshold_at_alert`, `expiry_date_at_alert`, `message`, `resolution_note`. `minimum_stock_at_alert` → `threshold_at_alert`. Prevención de alertas abiertas duplicadas. Generación automática por trigger (stock) y por `sp_refresh_expiry_alerts` (vencimiento). |

### Equivalencias de valores

| Original | Nuevo |
|---|---|
| `users.role = 'ADMIN' / 'STAFF' / 'CUSTOMER'` | `roles.code` con el mismo valor |
| `sales.sale_channel = 'ADMIN'` | `'POS'` (venta presencial) |
| `sales.sale_channel = 'STORE'` | `'ONLINE'` (venta generada por un pedido) |
| `sales.payment_status = 'PAID'` | `vw_sale_payment_summary.payment_state = 'PAID'` |
| `sales.payment_status = 'REFUNDED'` | `payments.status = 'REFUNDED'` o `sales.status = 'VOIDED'` |
| `inventory_movements.movement_type = 'IN'` | `PURCHASE_ENTRY`, `TRANSFER_IN`, `RETURN_IN`, `SALE_VOID_IN`, `ADJUSTMENT_IN` |
| `inventory_movements.movement_type = 'OUT'` | `SALE_OUT`, `TRANSFER_OUT`, `EXPIRED_WRITE_OFF`, `DAMAGE_WRITE_OFF`, `ADJUSTMENT_OUT` |
| `inventory_movements.movement_type = 'ADJUSTMENT'` | `ADJUSTMENT_IN` / `ADJUSTMENT_OUT` según el sentido |
| `products.is_active = TRUE/FALSE` | `products.status = 'ACTIVE' / 'INACTIVE'` |
| `products.current_stock` | `vw_branch_product_stock.available_stock` (por sucursal) o `vw_consolidated_stock` |
| `products.minimum_stock` | `branch_products.minimum_stock` (por sucursal; 20 por defecto, también en `settings`) |

---

## 3. Estados nuevos de pedido

`PENDING → CONFIRMED → PREPARING → READY_FOR_PICKUP | OUT_FOR_DELIVERY → COMPLETED`, más `CANCELLED` y `REJECTED`. Se conservan los 4 estados originales (`PENDING`, `CONFIRMED`, `CANCELLED`, `COMPLETED`). Las transiciones inválidas y la confirmación sin venta son rechazadas por trigger, y cada cambio se registra en `order_status_history`.

---

## 4. Tablas agregadas (27)

| Módulo | Tablas | Motivo |
|---|---|---|
| Seguridad (RBAC) | `roles`, `permissions`, `role_permissions`, `user_permissions` | Permisos configurables por datos |
| Sucursales | `branches`, `user_branches`, `branch_products` | Crecimiento multi-sucursal sin duplicar productos; precio y mínimo por sucursal |
| Configuración | `settings`, `document_sequences` | Moneda, zona horaria, stock mínimo, modo DEMO; numeración segura ante concurrencia |
| Catálogo | `laboratories` | Fabricante o laboratorio normalizado |
| Proveedores | `suppliers` | Módulo independiente con RUC |
| Lotes | `product_batches` | Lotes, vencimientos, FEFO; fuente única del stock |
| Ajustes | `inventory_adjustments` | Ajustes y bajas con motivo y responsable |
| Caja | `cash_registers`, `cash_sessions`, `cash_movements` | Apertura, cierre, arqueo y diferencias |
| Pedidos | `order_status_history` | Historial de estados |
| Ventas | `sale_item_batches`, `payments`, `sale_tickets` | Lotes vendidos, pagos divididos/simulados, ticket interno |
| Anulaciones y devoluciones | `sale_voids`, `return_reasons`, `sale_returns`, `sale_return_items` | Trazabilidad sin borrar ventas; solo lo apto reingresa |
| Transferencias | `branch_transfers`, `branch_transfer_items` | Mover lotes entre sucursales sin duplicar stock |
| Auditoría | `audit_logs` | Registro de operaciones sensibles, de solo inserción |

---

## 5. Vistas

| Vista original | Estado | Cambio |
|---|---|---|
| `vw_products_low_stock` | **Conservada (mismo nombre)** | Ahora por sucursal y calculada desde los lotes no vencidos. Conserva las columnas `id`, `sku`, `name`, `category_name`, `current_stock`, `minimum_stock`, `units_to_minimum` y agrega `branch_id`, `branch_name`, `stock_status`. |
| `vw_daily_sales` | **Conservada (mismo nombre)** | Agrega sucursal, importe bruto y descuentos; excluye ventas anuladas (ya no depende de `payment_status`). |

Vistas nuevas (15): `vw_branch_product_stock`, `vw_consolidated_stock`, `vw_batch_expiry_status`, `vw_fefo_batches`, `vw_product_prices_by_branch`, `vw_sales_by_product`, `vw_sale_payment_summary`, `vw_payment_history`, `vw_sale_ticket_header`, `vw_sale_ticket_lines`, `vw_cash_session_summary`, `vw_user_effective_permissions`, `vw_open_stock_alerts`, `vw_kardex`, `vw_integrity_issues`.

---

## 6. Lógica programada nueva

- **77 triggers**: kardex como única vía de stock, validación de vencimientos/FEFO/cantidades, alertas automáticas, transiciones de estado, caja (saldo esperado, efectivo de pagos y reembolsos), anulaciones, devoluciones, transferencias, auditoría y bloqueo de borrado o edición de registros históricos.
- **4 procedimientos**: `sp_next_document_number`, `sp_refresh_expiry_alerts`, `sp_audit`, `sp_set_app_context`.
- **82 restricciones CHECK** (importes, totales, estados coherentes, formatos de RUC/DNI/hash, no almacenamiento de números de tarjeta, etc.).

---

## 7. Datos iniciales

| Original | Nuevo |
|---|---|
| 8 categorías | Las mismas 8 categorías, con el mismo texto |
| — | Sucursal Principal (`SP01`), con 9 secuencias de numeración y una caja (`CAJA01`) |
| — | Roles ADMIN, STAFF y CUSTOMER; 48 permisos y sus asignaciones por defecto |
| — | Configuración: PEN, America/Lima, stock mínimo 20, alertas a 90/30 días, FEFO, pagos en modo DEMO, receta obligatoria |
| — | 7 motivos de devolución |

No se crean usuarios, productos, clientes, proveedores, ventas ni trabajadores. La dirección y el RUC de la botica quedan vacíos para completarse desde el panel.

---

## 8. Migración de datos

El SQL original no contenía datos de negocio (solo categorías), por lo que no se incluye un script de migración. Si existiera una base antigua con datos, el nuevo script **se detiene** al detectarla para no mezclar estructuras; migrar esos datos requeriría un script específico (por ejemplo, convertir `products.current_stock` en un lote inicial con una entrada `INITIAL_STOCK` y su movimiento `PURCHASE_ENTRY`).
