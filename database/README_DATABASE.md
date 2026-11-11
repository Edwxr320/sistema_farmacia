# Pharma Plus — Guía de instalación y uso de la base de datos

Base de datos: **`pharma_plus`** · Motor: **MySQL 8.0.16 o superior** (probada en MySQL 8.0.46) · `utf8mb4` / `utf8mb4_unicode_ci` · InnoDB.

## Contenido de la carpeta `database/`

| Archivo | Para qué sirve |
|---|---|
| `pharma_plus_mysql8.sql` | **Script principal.** Crea la base, 42 tablas, 103 FK, 82 CHECK, 77 triggers, 4 procedimientos, 17 vistas y los datos iniciales. |
| `VALIDAR_DATABASE.sql` | Verificación de solo lectura (23 comprobaciones PASS/FAIL). |
| `PRUEBAS_ESCENARIOS.sql` | Los 20 escenarios obligatorios (52 verificaciones). Usa una transacción y termina en `ROLLBACK`: no deja datos. |
| `DIAGRAMA_ER.md` | Diagrama entidad-relación en Mermaid, por módulos. |
| `DICCIONARIO_DATOS.md` | Diccionario de datos generado desde `information_schema`. |
| `CAMBIOS_RESPECTO_SQL_ORIGINAL.md` | Qué se conservó, modificó, reemplazó o agregó, y por qué. |
| `pharma_plus_original.sql` | SQL original, sin modificar (referencia). |

---

## 1. Requisitos

- **MySQL Server 8.0.16 o superior.** Se usan `CHECK` con `REGEXP_LIKE`, columnas generadas, funciones de ventana y `JSON`.
- **No es compatible con MariaDB.** XAMPP trae MariaDB: use MySQL 8 (MySQL Installer en Windows, Laragon con MySQL 8, Homebrew, el paquete `mysql-server` de Linux o Docker).
- Un usuario con privilegios para crear base de datos, tablas, vistas, **triggers** y **procedimientos** (por ejemplo `root` en su equipo).
  - Si el binary log está activo (lo está por defecto en MySQL 8) y el usuario no es administrador, MySQL puede exigir `SET GLOBAL log_bin_trust_function_creators = 1;` para crear triggers.
- Cliente: MySQL Workbench 8, phpMyAdmin conectado a un servidor **MySQL 8**, o la consola `mysql`.

Compruebe la versión:

```sql
SELECT VERSION();   -- debe ser 8.0.16 o mayor
```

## 2. Iniciar el servidor MySQL

| Sistema | Comando |
|---|---|
| Windows | `services.msc` → servicio **MySQL80** → Iniciar. O en una consola como administrador: `net start MySQL80` |
| Linux | `sudo systemctl start mysql` |
| macOS (Homebrew) | `brew services start mysql` |
| Docker | `docker run --name pharma-mysql -e MYSQL_ROOT_PASSWORD=<su_clave> -p 3306:3306 -d mysql:8.0` |

## 3. Importar la base de datos

> **Importante:** importe en un servidor **sin** una base `pharma_plus` previa, o **respáldela primero**:
> `mysqldump -u root -p --routines --triggers --events pharma_plus > respaldo_pharma_plus.sql`
>
> El script no contiene `DROP DATABASE` ni `DROP TABLE`. Si detecta la estructura **antigua** (`products.current_stock` o `users.role`), se detiene con el mensaje *"PP: la base pharma_plus tiene la estructura antigua…"* sin modificar nada. En ese caso renombre o respalde y elimine la base anterior manualmente, y vuelva a importar (puede quedar el procedimiento auxiliar `pp_install_guard`, que es inofensivo: `DROP PROCEDURE pp_install_guard;`).
>
> Reimportar sobre una base **ya creada con este script** es seguro: no duplica datos iniciales y recrea triggers, procedimientos y vistas.

### Opción A — MySQL Workbench

1. Conéctese a su servidor MySQL 8.
2. **File → Open SQL Script…** y elija `database/pharma_plus_mysql8.sql`.
3. Ejecute todo el script con el **rayo** (Execute, `Ctrl+Shift+Enter`). Workbench interpreta las líneas `DELIMITER`.
4. En el panel *Navigator → Schemas* pulse **Refresh**: aparecerá `pharma_plus`.

Alternativa: **Server → Data Import → Import from Self-Contained File**, elija el archivo y pulse *Start Import*.

### Opción B — phpMyAdmin (conectado a MySQL 8)

1. Entre a phpMyAdmin y **no** seleccione ninguna base (el script crea `pharma_plus`).
2. Pestaña **Importar** → *Seleccionar archivo* → `pharma_plus_mysql8.sql`.
3. Juego de caracteres: **utf-8**. Formato: **SQL**.
4. Pulse **Importar**. phpMyAdmin admite las instrucciones `DELIMITER` del archivo.

### Opción C — Consola

Linux / macOS / CMD de Windows:

```bash
mysql -u root -p --default-character-set=utf8mb4 < database/pharma_plus_mysql8.sql
```

PowerShell no admite `<`; use la consola de MySQL:

```sql
mysql -u root -p --default-character-set=utf8mb4
mysql> SOURCE C:/ruta/al/proyecto/database/pharma_plus_mysql8.sql;
```

## 4. Verificar que se creó correctamente

Ejecute `database/VALIDAR_DATABASE.sql` (mismo procedimiento que el paso 3). El último resultado es un resumen y **todas las filas deben decir `PASS`**:

| Verificación | Esperado |
|---|---|
| Tablas | 42 (todas InnoDB) |
| Claves foráneas | 103 |
| Restricciones CHECK | 82 |
| Vistas | 17 |
| Triggers | 77 |
| Procedimientos | 4 |
| Sucursal Principal | 1 (con sus 9 secuencias de numeración) |
| Categorías originales | 8 |
| Roles / permisos | 3 / 48 |
| Moneda, zona horaria, stock mínimo | PEN, America/Lima, 20 |
| Columnas FLOAT/DOUBLE, huérfanos, inconsistencias | 0 |

Para ejecutar los 20 escenarios de prueba, corra `database/PRUEBAS_ESCENARIOS.sql`: debe mostrar **52 PASS / 0 FAIL** y *Datos de prueba restantes = 0*.

## 5. Consultar tablas y vistas

```sql
USE pharma_plus;
SHOW FULL TABLES WHERE Table_type = 'BASE TABLE';
SHOW FULL TABLES WHERE Table_type = 'VIEW';
DESCRIBE product_batches;

-- Inventario y lotes
SELECT * FROM vw_branch_product_stock;           -- stock por sucursal (disponible, vencido, bloqueado, estado)
SELECT * FROM vw_products_low_stock;             -- productos en stock bajo o agotados
SELECT * FROM vw_consolidated_stock;             -- stock consolidado de todas las sucursales
SELECT * FROM vw_batch_expiry_status ORDER BY days_to_expiry;   -- lotes vencidos / críticos / por vencer
SELECT * FROM vw_fefo_batches WHERE fefo_rank = 1;              -- lote que debe salir primero
SELECT * FROM vw_kardex ORDER BY created_at DESC;               -- historial de movimientos
SELECT * FROM vw_open_stock_alerts;

-- Ventas, pagos y caja
SELECT * FROM vw_daily_sales;
SELECT * FROM vw_sales_by_product;
SELECT * FROM vw_sale_payment_summary;
SELECT * FROM vw_payment_history;
SELECT * FROM vw_sale_ticket_header;  SELECT * FROM vw_sale_ticket_lines;
SELECT * FROM vw_cash_session_summary WHERE status = 'OPEN';

-- Seguridad y control
SELECT * FROM vw_user_effective_permissions;
SELECT * FROM vw_product_prices_by_branch;
SELECT * FROM vw_integrity_issues;     -- debe estar vacía
SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50;
```

## 6. Comprobar las relaciones

```sql
SELECT table_name, constraint_name, referenced_table_name, update_rule, delete_rule
  FROM information_schema.referential_constraints
 WHERE constraint_schema = 'pharma_plus'
 ORDER BY table_name;
```

En MySQL Workbench: **Database → Reverse Engineer…** → elija `pharma_plus` para generar el diagrama EER visual. El diagrama documentado está en `DIAGRAMA_ER.md` (GitHub y VS Code lo muestran directamente).

## 7. Crear el primer administrador de forma segura

El script **no** crea usuarios ni contraseñas. La tabla `users` rechaza cualquier valor que no sea un hash bcrypt (`$2a$`, `$2b$`, `$2y$`) o Argon2 (`$argon2id$…`).

Procedimiento recomendado (un comando/semilla del backend que se ejecuta **una sola vez**):

1. Leer el correo y la contraseña desde un **prompt interactivo** o variables de entorno; nunca escribirlos en el código ni en el repositorio.
2. Generar el hash en el backend (bcrypt con costo ≥ 12, o Argon2id).
3. Insertar en una transacción el usuario, su sucursal por defecto y marcar `must_change_password = TRUE`.

Ejemplo de la parte SQL que ejecutaría el backend (los valores entre `< >` los pone el programa, con consultas parametrizadas):

```sql
START TRANSACTION;
INSERT INTO users (role_id, full_name, email, password_hash, must_change_password)
VALUES ((SELECT id FROM roles WHERE code = 'ADMIN'), <nombre>, <correo>, <hash_bcrypt_o_argon2>, TRUE);
SET @admin_id = LAST_INSERT_ID();
INSERT INTO user_branches (user_id, branch_id, is_default)
VALUES (@admin_id, (SELECT id FROM branches WHERE is_main = TRUE), TRUE);
COMMIT;
```

Generar el hash (ejemplo de referencia en Node.js con la librería `bcrypt`, a usar cuando se construya el backend):

```js
const hash = await bcrypt.hash(passwordIngresada, 12); // nunca registrar passwordIngresada en logs
```

La auditoría registra la creación (correo, nombre, rol), **nunca** el hash. Se verificó que hashes reales bcrypt y Argon2id son aceptados.

## 8. Reglas para el backend (lo que la base garantiza y lo que espera)

### 8.1 Conexión

Al abrir cada conexión del pool:

```sql
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;  -- misma collation que la base
SET time_zone = '-05:00';                      -- hora de Lima (Perú no usa horario de verano)
CALL sp_set_app_context(<id_usuario>, <id_sucursal>, <id_peticion>, <ip>);  -- auditoría
```

Usuario de aplicación con privilegios mínimos (no use `root` en la aplicación):

```sql
CREATE USER 'pharma_app'@'localhost' IDENTIFIED BY '<CONTRASEÑA_SEGURA_DESDE_VARIABLE_DE_ENTORNO>';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON pharma_plus.* TO 'pharma_app'@'localhost';
```

`DELETE` se concede porque algunos detalles en borrador se pueden quitar (carrito, permisos, líneas en `DRAFT`); los triggers impiden borrar ventas, pagos, kardex, auditoría y demás registros históricos.

### 8.2 Inventario: una sola vía

- El stock está en `product_batches.current_quantity`. **Nunca** se actualiza directamente (un trigger lo rechaza).
- Todo cambio de stock es un `INSERT` en `inventory_movements` con el lote y su documento de origen. El trigger bloquea el lote (`FOR UPDATE`), valida vencimiento, estado y cantidad, calcula stock anterior/posterior, actualiza el lote y genera/resuelve alertas de stock, todo en la misma transacción.
- Los lotes se crean con existencia 0; el primer movimiento les da stock.
- Índices únicos impiden que una misma línea de entrada, lote vendido, ítem devuelto o ítem transferido mueva stock dos veces.

### 8.3 Flujos transaccionales (resumen)

Cada flujo va dentro de `START TRANSACTION … COMMIT`. Los números de documento se obtienen con `CALL sp_next_document_number(<sucursal>, '<TIPO>', @numero);` dentro de la misma transacción.

| Flujo | Pasos |
|---|---|
| **Entrada de mercadería** | `stock_entries` (DRAFT) → `product_batches` (por lote nuevo) → `stock_entry_items` → `inventory_movements` `PURCHASE_ENTRY` por línea → `UPDATE stock_entries SET status='POSTED'` (calcula el total). |
| **Venta POS** | Caja abierta → `sales` → `sale_items` → elegir lotes con `SELECT … FROM vw_fefo_batches` y bloquearlos con `SELECT id FROM product_batches WHERE id IN (…) FOR UPDATE` → `sale_item_batches` → `inventory_movements` `SALE_OUT` por lote → `payments` (uno o varios) → `sale_tickets`. |
| **Pedido web** | `orders` + `order_items` en `PENDING` (no descuenta stock). |
| **Confirmar pedido** | Revalidar stock y bloquear lotes → `sales` (`sale_channel='ONLINE'`, `order_id`) → líneas, lotes y `SALE_OUT` → `UPDATE orders SET status='CONFIRMED'` (el trigger exige que la venta exista). |
| **Anular venta** | `INSERT INTO sale_voids` (marca la venta `VOIDED` y la conserva) → `SALE_VOID_IN` por cada lote → pagos a `REFUNDED` (efectivo: indicar `refund_cash_session_id`). |
| **Devolución** | `sale_returns` (REQUESTED) + `sale_return_items` con condición → `APPROVED` → `RETURN_IN` solo para ítems `RESELLABLE` → `COMPLETED` con método de reembolso. |
| **Transferencia** | `branch_transfers` (DRAFT) + ítems → `TRANSFER_OUT` → `IN_TRANSIT` → en destino crear el lote (mismo número y vencimiento) → registrar `destination_batch_id` y `received_quantity` → `TRANSFER_IN` → `RECEIVED`. |
| **Caja** | Abrir: `INSERT cash_sessions`. Los cobros y reembolsos en efectivo generan sus `cash_movements` automáticamente. Cerrar: `UPDATE … SET status='CLOSED', counted_amount=…` (el saldo esperado lo calcula la base). |
| **Alertas de vencimiento** | Ejecutar a diario `CALL sp_refresh_expiry_alerts();` (cron del backend o el `EVENT` opcional al final del script). |

### 8.4 Errores y concurrencia

- Las reglas de negocio devuelven `SQLSTATE 45000` con mensajes que empiezan por **`PP:`**; el backend puede mostrarlos o traducirlos.
- Ante un deadlock (`ER_LOCK_DEADLOCK`, 1213) o espera de bloqueo (1205), repetir la transacción completa.
- Se probó con dos conexiones vendiendo a la vez las últimas 5 unidades del mismo lote: la segunda esperó el bloqueo y fue rechazada; el stock terminó en 0 y hubo un solo `SALE_OUT`.

## 9. Respaldo

```bash
mysqldump -u root -p --routines --triggers --events --single-transaction pharma_plus > pharma_plus_respaldo.sql
```

## 10. Solución de problemas

| Mensaje | Causa y solución |
|---|---|
| `FUNCTION pharma_plus.REGEXP_LIKE does not exist` o errores de sintaxis en los CHECK | El servidor es MariaDB o MySQL < 8.0.16. Use MySQL 8. |
| `You do not have the SUPER privilege and binary logging is enabled` | Importe como `root` o ejecute `SET GLOBAL log_bin_trust_function_creators = 1;`. |
| `PP: la base pharma_plus tiene la estructura antigua…` | Hay una base anterior. Respáldela y use una base limpia (ver sección 3). |
| `Illegal mix of collations` en consultas propias | La conexión usa `utf8mb4_0900_ai_ci`; ejecute `SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;`. |
| Fechas con 5 horas de diferencia | Falta `SET time_zone = '-05:00';` en la conexión. |
