# Pharma Plus — Sistema web para botica

Sistema web integral para botica: API Node.js + Express conectada a la base **MariaDB real `pharma_plus`**, con autenticación segura, roles y permisos, auditoría, inventario por lotes (FEFO), POS, caja, devoluciones, transferencias, tienda virtual, pedidos y reportes. Desde la fase 10 incluye el **frontend completo**: panel administrativo y tienda virtual (HTML/CSS/JS sin compilación) servidos por el mismo servidor.

| Portal | URL local | Quién lo usa |
|---|---|---|
| Tienda virtual | `http://localhost:3000/` | Clientes (cuentas CUSTOMER) |
| Panel administrativo | `http://localhost:3000/admin/` | Personal (ADMIN, STAFF y roles creados) |
| Estado de la API | `http://localhost:3000/api/health` | Monitoreo |

---

## 1. Requisitos

| Componente | Versión |
|---|---|
| Node.js | 20 o superior (probado en 24.21) |
| npm | 10 o superior |
| XAMPP con MariaDB | 10.11.x (probado en 10.11.16) |
| Base de datos | `pharma_plus` ya importada desde `database/pharma_plus_mariadb_10_11.sql` |

El backend **no crea, altera ni reimporta** la base de datos. Solo opera sobre ella.

## 2. Instalación

```bash
cd D:\Users\edwar\Desktop\sistema_farmacia
npm install
```

### Dependencias

| Paquete | Uso |
|---|---|
| `express` 5 | Servidor HTTP y rutas (los errores async llegan solos al manejador central) |
| `mysql2` | Conector MariaDB (`mysql2/promise`, pool de conexiones) |
| `helmet` | Cabeceras de seguridad (CSP, HSTS, no-sniff, frame-ancestors…) |
| `bcryptjs` | Hash de contraseñas bcrypt (`$2b$`, costo 12) |
| `jsonwebtoken` | Token de sesión firmado (HS256) dentro de una cookie HttpOnly |
| `cookie-parser` | Lectura de cookies |
| `express-rate-limit` | Límite de intentos de login por IP |
| `zod` | Validación de datos en el backend |
| `socket.io` | Notificaciones en tiempo real autenticadas con la cookie de sesión |
| `multer` | Subida de imágenes (en memoria; se valida antes de escribir en disco) |
| `pino`, `pino-http` | Registro de eventos con ocultación de datos sensibles |
| `dotenv` | Variables de entorno |
| `supertest` (dev) | Pruebas HTTP |
| `socket.io-client` (dev) | Pruebas de tiempo real |
| `pino-pretty` (dev) | Registros legibles en desarrollo (`npm run dev \| npx pino-pretty`) |

## 3. Usuario de aplicación `pharma_app`

La aplicación **nunca usa root**. Se conecta con `pharma_app`, que existe para `localhost` y `127.0.0.1`:

| Tiene (sobre `pharma_plus.*`) | No tiene |
|---|---|
| `SELECT, INSERT, UPDATE, DELETE, EXECUTE` | `CREATE`, `ALTER`, `DROP`, `TRIGGER`, `CREATE ROUTINE`, `GRANT`, privilegios globales |

- Opera los datos y ejecuta los procedimientos `sp_*`, pero **no puede modificar el esquema**. Las migraciones (`database/migrations/`) las aplica un administrador con root.
- Los triggers de auditoría e integridad siguen activos porque se ejecutan con los privilegios de su DEFINER. Los borrados prohibidos (ventas, kardex, auditoría, usuarios…) los siguen impidiendo los triggers.
- Las tablas nuevas que agreguen las migraciones quedan cubiertas por el mismo `GRANT` sin permisos adicionales.

**Instalación actual:** `pharma_app` se creó ejecutando `database/setup/01_crear_usuario_pharma_app.sql` como root desde la terminal, con una contraseña aleatoria de 43 caracteres. La contraseña se sustituyó en memoria y se guardó **solo** en `.env`; el archivo SQL conserva sus marcadores.

**Para recrearla o instalar en otro equipo:**

1. Genere una contraseña: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. En una copia del SQL, reemplace las dos sentencias `IDENTIFIED BY 'CAMBIE_ESTA_CONTRASENA'` y ejecútela como root:
   - por consola: `C:\xampp\mysql\bin\mariadb.exe -u root -p < copia.sql`
   - o en phpMyAdmin, pestaña SQL.

   Después borre la copia.
3. Escriba la contraseña en `.env` **entre comillas simples**: `DB_PASSWORD='...'`. Sin comillas, dotenv corta el valor en un `#`.

Para cambiarla: `ALTER USER 'pharma_app'@'localhost' IDENTIFIED BY '...'` (y lo mismo para `@'127.0.0.1'`), y actualice `.env`.

## 4. Configurar `.env`

```bash
copy .env.example .env
```

| Variable | Descripción |
|---|---|
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` (verifique el puerto en XAMPP → MySQL → Config → `my.ini`) |
| `DB_USER` / `DB_PASSWORD` | `pharma_app` y su contraseña, entre comillas simples (`DB_PASSWORD='...'`) |
| `DB_NAME` | `pharma_plus` |
| `JWT_SECRET`, `CSRF_SECRET` | Dos secretos aleatorios **distintos** de 32+ caracteres:<br>`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `SESSION_TTL_MINUTES` | Duración de la sesión (por defecto 480 = 8 h) |
| `BCRYPT_COST` | Costo bcrypt (por defecto 12) |
| `AUTH_MAX_FAILED_ATTEMPTS`, `AUTH_LOCKOUT_MINUTES` | Valores de respaldo del bloqueo temporal (5 / 15 min). Mandan los de `settings` (sección 5.2) |
| `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MINUTES` | Límite de peticiones de login por IP |
| `ALLOWED_ORIGINS` | Orígenes autorizados para peticiones que modifican datos |
| `TRUST_PROXY` | `1` solo si está detrás de un proxy inverso |

El servidor **se niega a arrancar** si falta la contraseña, si `DB_USER=root` o si los secretos son cortos o iguales. `.env` está en `.gitignore`.

## 5. Verificar la conexión

```bash
npm run db:check
```

Muestra versión de MariaDB, base, zona horaria, collation, modo estricto, si existen las 42 tablas, 17 vistas y 4 procedimientos esperados, y las **migraciones aplicadas o pendientes**. Con una migración pendiente, el estado es `degraded` (HTTP 503).

### 5.1 Migraciones (requieren root)

| Archivo | Contenido | Tipo |
|---|---|---|
| `database/migrations/001_user_sessions.sql` | Tabla `user_sessions` (sesiones persistentes) | No destructiva: `CREATE TABLE IF NOT EXISTS` |

`pharma_app` no tiene permisos DDL, así que las migraciones se ejecutan con el administrador de MariaDB:

1. Abra `http://localhost/phpmyadmin`, entrando como **root**.
2. Pestaña **Importar** → seleccione `database/migrations/001_user_sessions.sql` → **Importar**. También puede usar la pestaña SQL y pegar el contenido.
3. Verifique con `npm run db:check`: `"migrations": { "applied": ["001"], "pending": [] }`.

Repetir la importación es seguro. **Mientras la migración 001 no esté aplicada, el inicio de sesión responde `503 MIGRATION_PENDING`.**

### 5.2 Configuración de seguridad en `settings`

```bash
npm run settings:security
```

Inserta `security.max_failed_logins` y `security.lockout_minutes` **solo si no existen**, con los valores actuales de `.env` como referencia. Nunca sobrescribe y queda auditado. Basta con `INSERT`, así que funciona con `pharma_app`. Ya se aplicó: los valores actuales son 5 intentos y 15 minutos. Para cambiarlos más adelante, edite esas filas de `settings`.

## 6. Ejecutar el sistema

El frontend es React + Vite (carpeta `frontend/`). Express sirve el build (`frontend/dist`) y la API en el mismo puerto.

```bash
npm run build      # compila React → frontend/dist (necesario antes de npm start)
npm start          # producción / normal: API + frontend compilado
npm run dev        # API con reinicio al guardar cambios
npm run dev:web    # (desarrollo) Vite en http://localhost:5173 con recarga en caliente; reenvía /api, /uploads y /socket.io a Express
```

En desarrollo se ejecutan `npm run dev` y `npm run dev:web` a la vez y se abre `http://localhost:5173/`. Abra `http://localhost:3000/` (tienda), `http://localhost:3000/admin/` (panel) o `http://localhost:3000/api/health`. Con `Ctrl+C` el servidor deja de aceptar peticiones, termina las que están en curso y cierra el pool de MariaDB. Al iniciar, y luego cada hora, elimina las sesiones expiradas. También se puede hacer a mano con `npm run sessions:cleanup`.

## 7. Crear el primer administrador

Es **interactivo**: ejecútelo en PowerShell o en la terminal integrada de VS Code (**Terminal → Nuevo terminal**). Con el prefijo `!` de Claude Code o con la entrada redirigida no hay teclado: el script se detiene sin hacer cambios.

```bash
cd D:\Users\edwar\Desktop\sistema_farmacia
npm run admin:create
```

Pide nombre, correo y contraseña (oculta, dos veces) y una confirmación final (`s`). Luego:

1. Valida la política: 10+ caracteres, mayúscula, minúscula, número, sin espacios, máximo 72 bytes, sin contener el correo.
2. Genera el hash bcrypt antes de tocar la base.
3. Toma un bloqueo con nombre (`GET_LOCK`) para evitar dos ejecuciones simultáneas.
4. Usa el rol `ADMIN` existente y la **Sucursal Principal** existente (`is_main = TRUE`).
5. Inserta `users` y `user_branches` en una sola transacción.
6. Se audita mediante el trigger `trg_users_ai` y un evento `BOOTSTRAP_ADMIN` (sin hash).
7. **Se niega** si ya existe cualquier usuario con rol ADMIN o si el correo ya está registrado.

No hay contraseñas predeterminadas ni usuarios de ejemplo. El administrador se crea con `must_change_password = FALSE` porque elige su propia contraseña en ese momento. Para iniciar sesión hace falta la migración 001 (sección 5.1).

## 8. Rutas disponibles

Todas bajo `/api`. Respuestas JSON. Los errores tienen la forma `{ "error": { "code", "message", "details?", "requestId" } }`.

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| GET | `/api/health` | Público | Estado de Express, MariaDB, versión y esquema (200 ok / 503) |
| GET | `/api/auth/csrf-token` | Público | Entrega el token CSRF (cookie `pp_csrf` + cuerpo) |
| POST | `/api/auth/access` | Público + CSRF | **Acceso único** (personal y clientes): `{ email, password }` → usuario, permisos y `accountType` (`STAFF`/`CUSTOMER`); revoca la sesión previa del navegador |
| POST | `/api/auth/login` | Público + CSRF | `{ email, password }` → usuario, sucursales, permisos; fija la cookie de sesión |
| POST | `/api/auth/logout` | CSRF | Revoca la sesión y borra las cookies |
| GET | `/api/auth/me` | Sesión | Usuario autenticado, sucursales, permisos efectivos y `mustChangePassword` |
| POST | `/api/auth/change-password` | Sesión + CSRF | `{ currentPassword, newPassword, confirmPassword }` → cierra todas las sesiones y entrega una nueva a este cliente |
| GET | `/api/users?page=&pageSize=` | `users.view` | Lista de usuarios (sin hashes) |
| GET | `/api/roles` | `roles.manage` | Roles con sus permisos |
| GET | `/api/roles/permissions` | `roles.manage` | Catálogo de permisos |

Códigos de error:

- **Login:** `401 AUTH_INVALID_CREDENTIALS`, `423 AUTH_LOCKED`, `403 AUTH_USER_BLOCKED`, `403 AUTH_USER_INACTIVE`, `429 RATE_LIMITED`, `403 CSRF_INVALID`, `503 MIGRATION_PENDING`.
- **Cambio de contraseña:** `400 VALIDATION_ERROR` (política, confirmación o igual a la actual), `400 AUTH_INVALID_CURRENT_PASSWORD`, `400 AUTH_PASSWORD_REUSED`.
- **Cambio obligatorio:** `403 PASSWORD_CHANGE_REQUIRED`, mientras `must_change_password = TRUE` (solo se permiten `/me`, `/change-password` y `/logout`).

## 8.1 Cómo funciona la autenticación

1. **Login.** Se verifica la contraseña con bcrypt, con la fila del usuario bloqueada (`FOR UPDATE`). Se crea una fila en `user_sessions` que guarda el **SHA-256 del id de sesión** (`jti`), nunca el token, y se entrega un JWT firmado en la cookie HttpOnly `pp_session`.
2. **Cada petición.** Se exige firma del JWT válida **y** una fila vigente en `user_sessions` (no revocada, no expirada). Luego se cargan el estado del usuario y sus permisos desde la base.
3. **Logout.** La fila queda revocada (`revoked_reason = 'LOGOUT'`). Como la revocación está en la base, **sigue vigente aunque Node.js se reinicie**.
4. **Revocación automática:**
   - `USER_DISABLED` si el usuario pasa a `BLOCKED` o `INACTIVE`.
   - `PASSWORD_CHANGED` en todas sus sesiones al cambiar la contraseña.
5. **Expiración y limpieza.** `expires_at` coincide con la del JWT. Las filas vencidas se eliminan cada hora; el historial queda en `audit_logs` (`LOGIN`, `LOGOUT`, `LOGIN_FAILED`…).
6. **Bloqueo por intentos.** Se usan `security.max_failed_logins` y `security.lockout_minutes` de `settings`. Una contraseña actual incorrecta en `/change-password` también cuenta como intento fallido.
7. **Cambio de contraseña.** Valida la contraseña actual y la política de la nueva. Guarda el nuevo hash con `must_change_password = FALSE` y `password_changed_at = NOW()`, y reinicia los intentos fallidos. Se audita con el trigger `trg_users_au` (`password_changed: true`, sin hash) y con el evento `PASSWORD_CHANGE`.

### Cómo debe llamar el frontend

`frontend/src/core/api-client.js` ya lo resuelve: envía cookies (`credentials: 'same-origin'`) y, en POST/PUT/PATCH/DELETE, la cabecera `X-CSRF-Token` con el valor de la cookie `pp_csrf`.

```js
import { api } from './core/api-client.js';
await api.login('correo@botica.pe', 'contraseña');
const { user, permissions } = await api.me();
await api.changePassword('actual', 'NuevaClave2026', 'NuevaClave2026');
await api.logout();
```

## 8.2 Catálogo, proveedores e inventario (fases 2 y 3)

Todas las rutas requieren sesión. Los listados son paginados (`?page=&pageSize=`, máximo 100) y responden `{ data, pagination }`. Los importes viajan como **texto decimal** (`"12.50"`).

| Ruta | Métodos | Permiso |
|---|---|---|
| `/api/categories`, `/api/laboratories` | GET (`?q=&isActive=`) | `products.view` |
| | POST · PUT `/:id` · PATCH `/:id/status` · DELETE `/:id` (solo si no tiene productos) | `categories.manage` |
| `/api/products` | GET (`?q=&sku=&barcode=&categoryId=&laboratoryId=&status=&sort=&order=`) · GET `/:id` (detalle + sucursales + stock + lotes) | `products.view` |
| | POST | `products.create` |
| | PUT `/:id` (si cambia precios, también `products.prices`) · PUT `/:id/image` (multipart, campo `image`) | `products.update` |
| | PATCH `/:id/status` (`ACTIVE`/`INACTIVE`/`DISCONTINUED`) | `products.deactivate` |
| `/api/products/:id/branches[/:branchId]` | GET · PUT. Permiso por campo: precio → `products.prices`; mínimo y máximo → `inventory.minimum_stock`; ubicación y disponibilidad → `products.update` | |
| `/api/suppliers` | GET (`?q=&ruc=&status=`) · GET `/:id` · GET `/:id/entries` | `suppliers.view` |
| | POST · PUT `/:id` · PATCH `/:id/status` | `suppliers.manage` |
| `/api/inventory` | GET (stock por sucursal: físico, disponible, vencido, bloqueado, mínimo, máximo) · `/low-stock` · `/batches` · `/batches/:id` · `/movements` (kardex) · `/fefo?productId=&quantity=` | `inventory.view` |
| `/api/inventory/entries` | GET · GET `/:id` | `inventory.view` |
| | POST (`confirm: true` registra y contabiliza en una sola transacción) · PUT `/:id` (solo DRAFT) · POST `/:id/post` · POST `/:id/cancel` | `inventory.entries` |
| `/api/inventory/alerts` | GET (`?status=&alertType=`) · GET `/:id` | `alerts.view` |
| | POST `/:id/close` (`RESOLVED`/`DISMISSED`) · POST `/refresh-expiry` | `alerts.resolve` |

**Acceso por sucursal:** quien tiene `branches.manage` (ADMIN) opera en cualquier sucursal activa. El resto, solo en las sucursales asignadas en `user_branches`; otra sucursal responde `403 BRANCH_FORBIDDEN`.

**Entradas de mercadería** (flujo de la base, todo en una transacción):

1. **DRAFT:** se crea la cabecera con su número (`sp_next_document_number`), los lotes con existencia 0 y las líneas. `line_total` lo calcula el trigger.
2. **POST `/post`:** bloquea la entrada y sus lotes (`FOR UPDATE`) e inserta un `PURCHASE_ENTRY` por línea. Los triggers suben el stock; luego la entrada pasa a `POSTED` y el trigger calcula el total.
3. **Idempotencia:** repetir el POST devuelve `alreadyPosted: true` sin crear movimientos, y un comprobante (proveedor + tipo + número) ya registrado responde `409 DUPLICATE_DOCUMENT`.
4. **Errores:** cualquier fallo provoca ROLLBACK completo. Los lotes vencidos se rechazan en la API (`400`) y en el trigger (`422`).
5. **Regla de stock:** el código nunca ejecuta `UPDATE product_batches SET current_quantity/received_quantity`; una prueba automática lo verifica.

**FEFO:** `inventoryService.reserveFefoInTransaction(conn, sucursal, producto, cantidad)` bloquea los lotes vendibles (`ACTIVE`, con stock y no vencidos) en orden de vencimiento y devuelve el reparto. Lo usará el módulo POS.

**Alertas:** los triggers generan `LOW_STOCK` y `OUT_OF_STOCK` sin duplicados. `CALL sp_refresh_expiry_alerts()` se ejecuta:

- a diario a las **06:00 America/Lima**, sin solaparse gracias a una bandera en el proceso y `GET_LOCK` entre procesos (`JOBS_ENABLED`, `EXPIRY_ALERTS_HOUR`);
- al contabilizar lotes que vencen dentro de la ventana de alerta;
- manualmente, con `/refresh-expiry`.

El `event_scheduler` de MariaDB no se modifica.

**Imágenes:**

- Se aceptan JPG, PNG y WEBP de hasta `UPLOAD_MAX_IMAGE_KB`, y el tipo se comprueba por la firma binaria del archivo.
- El nombre lo genera el servidor y el archivo se guarda en `UPLOADS_DIR`. En MariaDB solo queda la ruta (`/uploads/products/...`).
- Al reemplazar una imagen, la anterior se elimina.

**Auditoría:** se registran explícitamente las altas y cambios de categorías, laboratorios, proveedores, productos (los campos que no audita `trg_products_au`), entradas (`CREATE`/`UPDATE`/`POST`/`CANCEL`) y el cierre de alertas. Precios, estado y receta de productos, y precio, mínimo y disponibilidad por sucursal, los audita el trigger: no se duplican.

## 8.3 Ajustes, caja, POS, pagos y tickets (fases 4 y 5)

| Ruta | Métodos | Permiso |
|---|---|---|
| `/api/inventory/adjustments` | GET (`?branchId=&adjustmentType=&productId=&q=`) · GET `/:id` | `inventory.view` |
| | POST — `PHYSICAL_COUNT`, `CORRECTION`, `OTHER` | `inventory.adjust` |
| | POST — `EXPIRED_WRITE_OFF`, `DAMAGE`, `LOSS` | `inventory.write_off` |
| `/api/cash/registers` · `/api/cash/sessions[/current\|/:id]` · `/api/cash/movements` | GET | cualquier `cash.*` |
| `/api/cash/sessions` | POST (apertura) | `cash.open` |
| `/api/cash/sessions/:id/close` | POST (`countedAmount`) | `cash.close` |
| `/api/cash/movements` | POST (`CASH_IN`/`CASH_OUT`) | `cash.movements` |
| `/api/sales/catalog` · `/api/sales/quote` | GET · POST (carrito recalculado por el servidor) | `sales.create` |
| `/api/sales` | POST (cabecera opcional `Idempotency-Key`) | `sales.create` + `payments.register` |
| | GET · GET `/:id` | `sales.view` |
| `/api/sales/:id/void` | POST (`reason`; con pagos aprobados también `payments.refund`) | `sales.void` |
| `/api/sales/:id/ticket` | GET (`?format=html` imprimible) | `sales.view` o `tickets.print` |
| | POST (emitir si falta) · POST `/print` (impresión/reimpresión) | `tickets.print` |
| `/api/payments` | GET (`?method=&status=&saleId=&cashSessionId=`) | `payments.view` |

**Ajustes:**

- `inventory_adjustments` es el encabezado y cada lote ajustado es un movimiento en `inventory_movements`. No hace falta una tabla de detalle.
- En el conteo físico, el servidor bloquea los lotes (`FOR UPDATE`), lee el stock real y registra `ADJUSTMENT_IN` o `ADJUSTMENT_OUT` solo si hay diferencia.
- Las bajas usan `EXPIRED_WRITE_OFF` (solo lotes vencidos), `DAMAGE_WRITE_OFF` o `ADJUSTMENT_OUT`. En las bajas, `approved_by` es quien las registra con `inventory.write_off`.

**Caja:**

- Una sesión abierta por caja y por trabajador, y el trabajador debe estar asignado a la sucursal de la caja.
- El saldo esperado lo calcula el trigger al cerrar y la diferencia es una columna generada; el código no escribe ninguno de los dos.
- Una caja cerrada no se reabre.
- Sin `cash.view_all`, cada trabajador solo ve y opera sus propias sesiones.

**Venta POS** (una transacción, en el orden de los triggers):

1. Verifica la caja abierta (bloqueo compartido para que no se cierre durante la venta).
2. Recalcula precios desde MariaDB, en céntimos enteros; los importes del navegador se ignoran.
3. Valida el descuento (`sales.discount` y `sales.max_discount_percent`) y la receta (`sales.require_prescription_reference`).
4. Bloquea los lotes por FEFO con `reserveFefoInTransaction`, el mismo servicio de la fase 3.
5. Inserta `sales` (COMPLETED), luego `sale_items`, `sale_item_batches` y `SALE_OUT` por lote.
6. Registra los pagos y emite el ticket.

**Pagos DEMO:**

- La tarjeta, transferencia, Yape y Plin generan una referencia `DEMO-<MÉTODO>-<hex>` con `is_simulated = TRUE`.
- `simulate: "REJECT"` permite probar un rechazo. No se guardan datos de tarjeta.
- En efectivo se registra lo recibido y el vuelto. El `SALE_INCOME` de caja lo crea el trigger, así que no se duplica.
- Los pagos divididos deben sumar exactamente el total.
- **Pago rechazado:** en la misma transacción se registra el pago `REJECTED` con su motivo, los demás pagos quedan `CANCELLED`, la venta se anula con `sale_voids` y cada lote se repone con `SALE_VOID_IN`. La API responde `422 PAYMENT_REJECTED` con el id de la venta anulada, para mantener la trazabilidad.

**Anulación:**

- Se registra `sale_voids` (el trigger marca la venta y audita) y se crea un `SALE_VOID_IN` por cada lote.
- Los pagos aprobados pasan a `REFUNDED`. En efectivo, el reembolso sale de la caja abierta de quien anula y el trigger valida que haya fondos; en DEMO es un reembolso simulado.
- No se anulan ventas con devoluciones.

**Idempotencia:** con la cabecera `Idempotency-Key`, un reintento devuelve la misma venta (HTTP 200, `idempotentReplay: true`). La clave queda como `request_id` en la auditoría y el kardex. Un bloqueo con nombre que abarca hasta el COMMIT evita duplicados incluso con envíos simultáneos.

**Tickets:**

- Son internos y nunca boleta ni factura: `isTaxReceipt: false`, con la leyenda de `tickets.legend`.
- Incluyen logo (`/img/Logo-pharma-plus.jpeg`), sucursal, número de ticket y de venta, trabajador, cliente, productos, descuentos, pagos y referencias DEMO.
- `print_count` cuenta las impresiones y reimpresiones, que quedan auditadas.

**Tiempo real (Socket.IO, mismo puerto, ruta `/socket.io`):**

- Se autentica con la misma cookie de sesión y cada usuario solo entra a las salas de sus sucursales (`branch:<id>`); con `branches.manage` también a `branches:all`.
- Eventos: `sale:created`, `sale:voided`, `inventory:changed`, `alerts:changed`, `cash:opened`, `cash:closed` y `cash:movement`.
- Se emiten solo después del COMMIT y llevan únicamente ids y totales.

**Prueba de concurrencia:** `tests/integration/08-concurrency.test.js` confirma datos, así que solo corre contra una base temporal: `PP_CONCURRENCY_DB=1 DB_NAME=<base_temporal> node --test tests/integration/08-concurrency.test.js`. Con la base real se omite.

## 8.4 Devoluciones y transferencias (fases 6 y 7)

| Ruta | Métodos | Permiso |
|---|---|---|
| `/api/returns/reasons` · `/api/returns/lookup?ticketNumber=\|saleNumber=` · `/api/returns/sales/:id` | GET (lo vendido, lo devuelto y lo disponible por lote) | `returns.create` o `returns.approve` |
| `/api/returns` | GET · GET `/:id` | `returns.*` o `sales.view` |
| | POST (`items` por `saleItemId` o `saleItemBatchId`, `condition`; `process: true` aprueba y completa en la misma transacción) | `returns.create` (+ `returns.approve` si `process`) |
| `/api/returns/:id/approve` · `/reject` · `/complete` (`refundMethod`) | POST | `returns.approve` (+ `payments.refund` si hay reembolso) |
| `/api/inventory/transfers` | GET · GET `/:id` | `inventory.view` o `inventory.*transfers` |
| | POST · PUT `/:id` · POST `/:id/approve` · `/dispatch` · `/cancel` | `inventory.transfers` + acceso a la sucursal de origen |
| `/api/inventory/transfers/:id/receive` | POST (`receivedQuantity`, `damagedQuantity`, `surplusQuantity`, `note` por ítem) | `inventory.receive_transfers` + acceso a la sucursal de destino |

**Devoluciones** (REQUESTED → APPROVED/REJECTED → COMPLETED, estados del esquema):

- Se valida lo vendido y lo ya devuelto por lote (las solicitudes pendientes reservan unidades). La venta queda bloqueada (`FOR UPDATE`), así que dos devoluciones simultáneas no pueden superar lo vendido.
- El importe por unidad es lo cobrado en la línea (con descuento) dividido entre las unidades, redondeado hacia abajo al céntimo. Nunca supera lo cobrado.
- Solo las unidades `RESELLABLE` reingresan, con `RETURN_IN` al **mismo lote vendido**. Las dañadas, vencidas, abiertas o no aptas se reembolsan pero no vuelven al stock, y un lote vencido no puede devolverse como apto.
- El reembolso sale por un medio de pago usado en la venta, hasta lo cobrado con ese medio:
  - **Efectivo:** sale de la caja abierta de quien completa; el trigger registra `RETURN_REFUND` y valida que haya fondos.
  - **DEMO electrónico:** se registra con `refund_operation_code = DEMO-REFUND-<MÉTODO>-…`.
- La venta original y sus pagos no se modifican. Una venta con devoluciones ya no puede anularse.

**Transferencias** (sobre `DRAFT/IN_TRANSIT/RECEIVED/CANCELLED`):

- **Etapas:** `REQUESTED` → `APPROVED` → `IN_TRANSIT` → `PARTIALLY_RECEIVED` → `RECEIVED` o `RECEIVED_WITH_DISCREPANCIES`, además de `CANCELLED`.
- **Aprobación:** fija las cantidades aprobadas (como máximo las solicitadas); la auditoría conserva solicitadas y aprobadas. Es obligatoria antes del despacho.
- **Despacho:** un `TRANSFER_OUT` por lote, con los lotes de origen bloqueados.
- **Recepción:** cada ítem se recibe una sola vez con `TRANSFER_IN`, al mismo lote (número y vencimiento) en destino; si no existe, se crea vacío. Se pueden recibir unos ítems ahora y otros después.
- **Diferencias:** los faltantes quedan en `discrepancy_note`. Las unidades dañadas ingresan y se dan de baja de inmediato con un ajuste `DAMAGE` en destino. Los sobrantes se documentan, pero no ingresan.
- Solo se cancelan transferencias no despachadas.

**Pruebas sobre base temporal:** `npm run test:tempdb` crea `pp_test_<marca>` desde el esquema y `database/migrations/`, concede a `pharma_app` los mismos privilegios, ejecuta toda la suite incluida la concurrencia real y elimina la base al final. Requiere el cliente `mariadb` y una cuenta administrativa local (`MARIADB_CLI`, `TEST_DB_ADMIN_USER`, `TEST_DB_ADMIN_PASSWORD`; por defecto, root de XAMPP sin contraseña).

## 8.5 Tienda virtual, pedidos y reportes (fases 8 y 9)

**Portales separados:** `/api/auth/login` admite solo trabajadores y `/api/store/auth/login` solo clientes (rol `CUSTOMER`). En caso contrario responde `403 AUTH_WRONG_PORTAL`. La sesión, la cookie y el CSRF son los mismos; un cliente solo tiene permisos `store.*`, así que cualquier API administrativa le responde 403.

| Ruta | Acceso |
|---|---|
| `POST /api/store/auth/register` · `POST /api/store/auth/login` | Público (con límite de peticiones) |
| `GET /api/store/products` (`?branchId=&q=&categoryId=&inStock=&sort=`) · `/products/:id` · `/categories` · `/branches` | Público: solo productos activos y habilitados en la sucursal; indica si hay stock, sin exponer el inventario exacto |
| `GET/PUT /api/store/me` · `GET/POST/PUT/DELETE /api/store/me/addresses[/:id]` | `store.profile` |
| `GET/PUT/DELETE /api/store/cart` · `PUT/DELETE /api/store/cart/items/:productId` | `store.cart` |
| `POST /api/store/orders` (`Idempotency-Key`) · `GET /api/store/orders[/:id]` · `POST /api/store/orders/:id/cancel` | `store.orders` (solo sus propios pedidos) |
| `GET /api/orders[/:id]` | `orders.view` |
| `POST /api/orders/:id/accept\|reject\|prepare\|ready\|complete\|cancel` | `orders.manage` (+ `payments.refund` para reembolsar; + `payments.register` y caja abierta para cobrar efectivo) |
| `POST /api/orders/:id/assign` | `orders.assign` |
| `GET /api/reports/dashboard` · `/sales/summary\|compare\|series\|top-products\|by-category\|by-branch\|by-seller` · `/payments/methods` · `/inventory/valuation\|low-stock\|expiring\|movements` · `/returns` · `/orders` · `/cash` | `reports.view` (varias sucursales a la vez: `reports.consolidated`) |
| `GET /api/reports/activity` | `reports.view` + `audit.view` |

**Pedidos** (modelo de la base: `PENDING` no descuenta stock; confirmar crea la venta):

- **Checkout:**
  - Precios desde MariaDB; si el total cambió respecto de `expectedTotal`, responde `409 PRICE_CHANGED`.
  - Bloquea los lotes vendibles y, con lectura bloqueante, descuenta las unidades comprometidas en otros pedidos `PENDING`, así dos clientes no pueden comprometer las mismas últimas unidades.
  - Delivery: dirección propia, cobertura y costo de envío (`orders.default_delivery_fee`). La cobertura usa el setting opcional `orders.delivery_districts` (JSON con distritos); si no existe, se exige la misma provincia que la sucursal, cuando esta la tenga registrada.
  - Productos con receta: el cliente declara la referencia y el personal la valida al aceptar.
- **Pagos:** tarjeta, transferencia, Yape y Plin se pagan en el checkout (DEMO, `simulatePayment: "REJECT"` para probar rechazos); un rechazo cancela el pedido, lo deja trazable y conserva el carrito. El efectivo se cobra al entregar o recoger, en la caja abierta del trabajador.
- **Aceptar:** venta `ONLINE` con FEFO (`reserveFefoInTransaction`) y `SALE_OUT`, enlace de los pagos a la venta y paso a `CONFIRMED`. El stock se descuenta una sola vez.
- **Avance:** preparar → listo para recojo o en reparto → completar (cobra el saldo en efectivo si queda y emite el ticket interno).
- **Cancelación:** el cliente solo cancela pedidos `PENDING` (con reembolso DEMO). El personal cancela después de confirmados anulando la venta (`SALE_VOID_IN` una sola vez y reembolsos). El historial de estados registra quién hizo cada cambio.

**Reportes:** son de solo lectura y cada métrica se agrega desde su tabla base, sin duplicados por joins. Cada respuesta incluye `definitions`:

- ventas brutas;
- descuentos;
- ventas netas (sin anuladas);
- reembolsos por devoluciones;
- ingreso neto (ventas netas − reembolsos);
- costo de lo vendido (costo del lote − unidades devueltas aptas);
- **margen bruto estimado**, que **no es ganancia neta** (no descuenta gastos, impuestos ni mermas).

El inventario se valoriza a costo del lote y a precio de venta. Los filtros son fecha (máximo 366 días), sucursal, categoría, canal y trabajador.

**Auditoría por sucursal de la operación:** cuando un usuario opera en una sucursal distinta de la de su sesión (por ejemplo ADMIN), la conexión fija `@app_branch_id` a la sucursal de la operación, así los registros quedan con la sucursal correcta.

## 8.6 Frontend (React + Vite)

Una aplicación React (React Router, hooks y contexto) en `frontend/`, compilada con Vite y servida por Express desde `frontend/dist`. Cada portal (`/admin/*` y la tienda) y cada vista del panel se descargan por separado. Express devuelve `index.html` en las rutas de React (recargar `/admin/pos` o `/pedidos/5` funciona) sin interceptar `/api`, `/uploads`, `/socket.io` ni archivos inexistentes. La CSP solo permite scripts propios (`script-src 'self'`, sin scripts inline) y React escapa todo el texto (no se usa `innerHTML` ni `dangerouslySetInnerHTML`). El navegador **no calcula precios ni totales**: muestra lo que devuelve el servidor (cotización del POS, carrito, checkout).

### Acceso único — `/acceso`

Una sola pantalla de ingreso para administradores, trabajadores y clientes (diseño de `Bocetos/`, tema claro/oscuro, PC y móvil). El navegador envía solo correo y contraseña a `POST /api/auth/access`; el **backend** reconoce el tipo de cuenta por el rol guardado en `users` (correo único: un correo = una cuenta) reutilizando el mismo servicio de login (bcrypt, bloqueo por intentos, auditoría, cookie `pp_session` y CSRF). Se emite solo esa sesión y, si había otra en el navegador, se revoca al validar las nuevas credenciales. El error de credenciales es el mismo para correo inexistente y contraseña incorrecta.

- Personal (`ADMIN` y demás roles) → `/admin` o la ruta del panel solicitada (`?next=`), si sus permisos la permiten. Contraseña temporal → cambio obligatorio.
- Cliente (`CUSTOMER`) → la tienda o la ruta protegida que intentaba abrir (`/carrito`, `/checkout`, `/cuenta`…).
- `?next=` solo acepta rutas internas (se rechazan `https://…`, `//dominio`, `\`, `javascript:`); el personal solo vuelve a `/admin/*` y un cliente nunca.
- `/admin` sin sesión → `/acceso?next=/admin/…`; con sesión de cliente → aviso "Panel solo para el personal". `/ingresar` (y `#/ingresar`) redirige a `/acceso` conservando el retorno. `/registro` sigue siendo el alta de clientes.
- `/api/auth/login` y `/api/store/auth/login` se conservan por compatibilidad.

### Panel administrativo — `/admin/`

Ingreso por el acceso único. Si la cuenta tiene contraseña temporal, se exige cambiarla antes de entrar. El menú y los botones se muestran según los permisos efectivos de `/api/auth/me` (el backend vuelve a validar cada acción). Selector de sucursal activa (si el usuario tiene varias) e indicador de conexión en tiempo real.

| Ruta | Pantalla | Permiso para verla |
|---|---|---|
| `/admin/dashboard` | Indicadores del día, ventas por día, más vendidos, métodos de pago, vencimientos, stock bajo, actividad | `reports.view` |
| `/admin/pos` | Punto de venta: búsqueda/lector de código, carrito con cotización del servidor, recetas, cliente, descuento, pagos simples o mixtos (DEMO), vuelto, ticket | `sales.create` + `payments.register` |
| `/admin/cash` | Apertura, ingresos/egresos, cierre con arqueo e historial de caja | `cash.*` |
| `/admin/sales` | Ventas, detalle, ticket/reimpresión y anulación | `sales.view` |
| `/admin/returns` | Devoluciones: búsqueda por ticket o venta, aprobación, rechazo y reembolso | `returns.*` |
| `/admin/orders` | Pedidos online por estado, receta, aceptar/rechazar/preparar/listo/entregar/cancelar (en vivo) | `orders.view` |
| `/admin/stock`, `/admin/batches`, `/admin/kardex`, `/admin/alerts` | Existencias, lotes y vencimientos, kardex, alertas (cierre y actualización de vencimientos) | `inventory.view` |
| `/admin/entries` | Entradas de mercadería (borrador → contabilización) | `inventory.entries` |
| `/admin/adjustments` | Conteo físico, correcciones y bajas | `inventory.adjust` / `inventory.write_off` |
| `/admin/transfers` | Solicitud, aprobación, despacho y recepción parcial con diferencias | `inventory.transfers` / `inventory.receive_transfers` |
| `/admin/products`, `/admin/categories`, `/admin/laboratories`, `/admin/suppliers` | Catálogo, precios por sucursal, imagen, estados, proveedores con historial | `products.view`, `suppliers.view` |
| `/admin/customers` | Clientes de mostrador y web | `customers.view` |
| `/admin/users`, `/admin/roles`, `/admin/branches` | Trabajadores (alta, sucursales, bloqueo, reseteo, permisos individuales), matriz de permisos por rol, sucursales y cajas | `users.view`, `roles.manage`, `branches.manage` |
| `/admin/settings` | Valores actuales de `settings`, costo de envío y distritos con cobertura (`orders.delivery_districts`; si no existe se muestra “No configurado”) | `settings.manage` |
| `/admin/reports` | Ventas, productos, pagos, inventario, devoluciones, pedidos, caja y auditoría | `reports.view` (+ `audit.view`) |

### Tienda virtual — `/`

Solo usa `/api/store/*`, `/api/settings/public` y la sesión (`/api/auth/me`, `logout`, `change-password`). Rutas: `/` inicio, `/catalogo` (búsqueda, categorías, orden, solo con stock), `/producto/:id`, `/carrito`, `/checkout` (recojo o delivery, dirección, receta, método de pago DEMO, total esperado y confirmación si cambia el precio, `Idempotency-Key`), `/pedidos`, `/pedidos/:id` (seguimiento con actualización en vivo y cancelación mientras está pendiente), `/cuenta` (datos, direcciones, contraseña), `/ingresar`, `/registro`. Una sesión del personal abierta en el mismo navegador no puede comprar. Los enlaces antiguos con `#/ruta` se redirigen a la ruta nueva.

### Tiempo real

Socket.IO autenticado con la cookie de sesión. El panel escucha pedidos, inventario, alertas y transferencias de su sucursal; el cliente recibe `order:status` en su sala `user:<id>` (solo número y estado del pedido).

### Endpoints administrativos agregados en esta fase

`/api/customers`, `/api/users` (alta, edición, bloqueo, reseteo, desbloqueo, permisos individuales), `/api/roles` (alta y permisos), `/api/branches` (alta, edición y cajas), `/api/settings` (lectura/edición con claves protegidas) y `/api/settings/public` (sin sesión, solo valores públicos). Protecciones: nadie cambia su propio rol/estado/permisos, no se puede dejar al sistema sin un ADMIN activo, ADMIN y CUSTOMER son roles protegidos, y `app.timezone`, `app.utc_offset`, `app.currency`, `payments.mode` e `inventory.method` no se editan.

## 9. Seguridad implementada

- **Sesión**: JWT HS256 firmado, solo en cookie `pp_session` **HttpOnly + SameSite=Strict** (+ `Secure` en producción), con expiración. Nunca en localStorage. Solo contiene ids. La validez real se comprueba en `user_sessions`, que guarda únicamente hashes SHA-256.
- **Estado fresco en cada petición**: el estado del usuario y sus permisos se leen de la base en cada petición. Bloquear o desactivar a un usuario, o cambiarle permisos, aplica de inmediato.
- **Permisos**: siempre desde `vw_user_effective_permissions` (rol + GRANT − DENY individuales). Middleware `requirePermission('codigo')`.
- **CSRF**: double-submit cookie **firmada con HMAC y ligada a la sesión**, más verificación de `Origin`.
- **Intentos fallidos**: `users.failed_login_attempts` / `locked_until` con `UPDATE` atómico y fila bloqueada (`FOR UPDATE`). Bloqueo temporal; `BLOCKED`/`INACTIVE` se respetan. Se revela el estado de la cuenta solo si la contraseña es correcta, y un correo inexistente tarda lo mismo que uno existente.
- **SQL**: solo consultas parametrizadas, `multipleStatements: false`.
- **Precisión monetaria**: `DECIMAL` se recibe como texto (`decimalNumbers: false`).
- **Errores**: manejador central. Al cliente nunca llega SQL, stack ni mensajes internos; los mensajes `PP:` de los triggers sí se muestran (422).
- **Registros**: pino con ocultación de contraseñas, hashes, cookies, tokens y SQL.
- **Helmet**, límite de cuerpo de 100 kb, `x-powered-by` desactivado.

### Contexto de auditoría y pool de conexiones

Las variables `@app_user_id`, `@app_branch_id`, etc. que usa `sp_audit` **viven en la conexión**, no en la petición. Por eso `src/config/database.js`:

1. Al obtener una conexión del pool ejecuta `CALL sp_set_app_context(usuario, sucursal, id_petición, ip)` y fija `@app_user_agent` / `@app_session_ref` **en esa misma conexión**.
2. Ejecuta las consultas o la transacción en esa conexión.
3. Antes de devolverla al pool, limpia el contexto. Si la limpieza falla, la conexión **se destruye** y no vuelve al pool.

Cada conexión física nueva se inicializa con `SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci`, `time_zone = '-05:00'` y `sql_mode` estricto. `withTransaction()` reintenta la transacción completa ante deadlock (1213) o espera de bloqueo (1205).

### Reglas de inventario (para las próximas fases)

El stock vive en `product_batches` y **solo** cambia insertando en `inventory_movements` dentro de `withTransaction()`. Los triggers de la base bloquean el lote, aplican FEFO, impiden vender vencidos y evitan stock negativo. Nunca se hará `UPDATE` directo de `current_quantity`.

## 10. Pruebas

```bash
npm test                 # todo
npm run test:unit        # sin base de datos
npm run test:integration # contra la base REAL (requiere .env con pharma_app)
npm run test:tempdb      # TODA la suite (incluida concurrencia) en una base temporal que se elimina al final
npm run test:e2e         # navegador real (Chrome + puppeteer-core) contra una base temporal
```

`test:e2e` levanta el servidor con Socket.IO en un puerto libre y recorre con Chrome: login del personal, las 23 pantallas del panel (sin errores ni textos `null`/`undefined`), una venta en el POS, alta de trabajador y de producto, configuración de distritos de delivery, registro y compra en la tienda con receta, aviso del pedido en el panel, aceptación y actualización en vivo para el cliente, devolución desde el detalle de la venta (lotes FEFO), entrada de mercadería contabilizada, transferencia completa (solicitud → aprobación → despacho → recepción), cierre de caja con arqueo, separación de portales y vistas tableta/móvil sin desborde horizontal. `npm test`, `test:tempdb` y `test:e2e` compilan el frontend antes de ejecutarse. Usa `CHROME_PATH` (por defecto `C:\Program Files\Google\Chrome\Application\chrome.exe`) y guarda capturas en `E2E_SCREENSHOTS` (por defecto, carpeta temporal del sistema).

Las pruebas de integración usan la base real, pero se ejecutan **dentro de una transacción que se revierte al final**. Los usuarios temporales y sus registros de auditoría nunca quedan guardados. Solo los contadores AUTO_INCREMENT pueden avanzar (InnoDB no los revierte).

Las pruebas que necesitan `user_sessions` aparecen como **omitidas** (`# Falta aplicar database/migrations/001_user_sessions.sql`) mientras la migración no esté importada. No cuentan como aprobadas.

## 11. Estructura del proyecto

```
sistema_farmacia/
├── database/                     # Esquema y documentación de la BD (no se modifica)
│   ├── setup/01_crear_usuario_pharma_app.sql
│   └── migrations/001_user_sessions.sql
├── frontend/                     # Frontend React + Vite (npm run build → frontend/dist)
│   ├── index.html                # Entrada única (tienda y panel)
│   ├── vite.config.js            # Build y proxy de desarrollo hacia Express
│   ├── public/img/               # Logo
│   └── src/
│       ├── main.jsx, App.jsx     # Router: /admin/* → panel, resto → tienda
│       ├── styles/app.css        # Diseño (tokens, componentes, responsive, impresión)
│       ├── core/                 # api-client.js (cookies + CSRF), format.js y permissions.js (puros, probados con Node)
│       ├── components/           # UI: botones, tablas, modales, formularios, gráficos, avisos
│       ├── admin/                # AdminApp.jsx (login, layout, rutas, tiempo real), nav.js, routes.js, views/*.jsx
│       └── store/                # StoreApp.jsx (sesión, carrito, rutas), views.jsx
├── scripts/
│   ├── create-admin.js           # npm run admin:create
│   ├── check-db.js               # npm run db:check
│   ├── seed-security-settings.js # npm run settings:security
│   └── cleanup-sessions.js       # npm run sessions:cleanup
├── src/
│   ├── app.js                    # Express: middlewares, rutas, errores
│   ├── server.js                 # Arranque y cierre ordenado
│   ├── config/                   # env, logger, pool MariaDB + contexto + transacciones
│   ├── controllers/              # HTTP → servicios (sin SQL)
│   ├── services/                 # Lógica de negocio (auth, CSRF, tokens, bootstrap…)
│   ├── repositories/             # SQL parametrizado (único lugar con consultas)
│   ├── routes/                   # Definición de rutas y permisos requeridos
│   ├── middlewares/              # auth, permisos, CSRF, validación, errores, rate limit
│   ├── validators/               # Esquemas zod
│   └── utils/                    # Errores, cookies, catálogo de esquema, prompt
└── tests/
    ├── unit/
    ├── integration/
    ├── e2e/                      # Chrome real (npm run test:e2e)
    └── helpers/                  # Entorno de prueba y transacción revertible
```

## 12. Estado de los pendientes de autenticación

| Pendiente | Estado |
|---|---|
| Sesiones persistentes | Implementado (`user_sessions`, migración 001). **Requiere importar la migración** (sección 5.1) |
| Política de bloqueo en `settings` | Aplicado (`npm run settings:security`) |
| Cambio de contraseña y `must_change_password` | Implementado (`POST /api/auth/change-password`) |
