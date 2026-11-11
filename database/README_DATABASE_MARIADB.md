# Pharma Plus — Instalación en XAMPP (MariaDB 10.11) con phpMyAdmin

Base de datos **`pharma_plus`**: 42 tablas, 103 relaciones, 82 restricciones CHECK, 77 triggers, 4 procedimientos y 17 vistas. Probada en **MariaDB 10.11.14** con **phpMyAdmin 5.2.1**: la importación, la validación y las pruebas se ejecutaron por la web real de phpMyAdmin.

## Archivos

| Archivo | Uso |
|---|---|
| `pharma_plus_mariadb_10_11.sql` | **Script principal para XAMPP/MariaDB.** |
| `VALIDAR_DATABASE_MARIADB.sql` | Verificación de solo lectura: 30 comprobaciones PASS/FAIL. |
| `PRUEBAS_ESCENARIOS_MARIADB.sql` | Escenarios funcionales (61 verificaciones). No deja datos. |
| `CAMBIOS_MYSQL_A_MARIADB.md` | Incompatibilidades encontradas y cómo se resolvieron. |
| `pharma_plus_mysql8.sql` y documentos sin sufijo | Versión para MySQL 8 (no usar en XAMPP). |

---

## 1. Requisitos

- **XAMPP** con el módulo «MySQL», que en XAMPP es **MariaDB**, en la serie **10.11**.
- **phpMyAdmin 5.2.x** (el incluido en XAMPP).
- Importar con el usuario **root** de XAMPP, o con otro usuario que tenga permisos para crear bases, tablas, vistas, triggers y procedimientos.

Comprobar la versión (phpMyAdmin → pestaña SQL):

```sql
SELECT VERSION();   -- debe mostrar 10.11.x-MariaDB
```

## 2. Iniciar los servicios

1. Abra el **XAMPP Control Panel**.
2. Pulse **Start** en **Apache** y en **MySQL**; ambos deben quedar en verde.
3. Abra en el navegador `http://localhost/phpmyadmin`.

## 3. Configuración recomendada (opcional para importar, recomendada para el sistema)

El script ya fija en su propia sesión el modo estricto y la collation correcta, así que **la importación no requiere cambiar nada**. Para el funcionamiento diario del sistema conviene ajustar `C:\xampp\mysql\bin\my.ini` (XAMPP Control Panel → MySQL → **Config** → `my.ini`), en la sección `[mysqld]`:

```ini
[mysqld]
character-set-server = utf8mb4
collation-server     = utf8mb4_unicode_ci
sql_mode             = STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION
max_allowed_packet   = 16M
default-time-zone    = '-05:00'
; event_scheduler    = ON      ; solo si usará el EVENT opcional de alertas de vencimiento
```

Guarde el archivo y reinicie el módulo MySQL (**Stop** y luego **Start**).

> Seguridad: en XAMPP, `root` no tiene contraseña por defecto. Asígnele una (phpMyAdmin → Cuentas de usuarios) y no la guarde en el código ni en el repositorio.

## 4. Respaldo previo (si ya existe una base `pharma_plus`)

En phpMyAdmin seleccione `pharma_plus` → **Exportar** → método Rápido, formato SQL → **Continuar**. O por consola:

```bat
C:\xampp\mysql\bin\mysqldump.exe -u root -p --routines --triggers --events pharma_plus > respaldo_pharma_plus.sql
```

El script **no** contiene `DROP DATABASE` ni `DROP TABLE`. Si encuentra una base `pharma_plus` con la estructura antigua (`products.current_stock` o `users.role`):

- Se detiene con el error **#1644 «PP: la base pharma_plus tiene la estructura antigua…»**.
- Deja la sesión en **solo lectura**, por lo que el resto del archivo no modifica nada. Si aparecen errores #1792 («READ ONLY transaction»), son parte de esa protección.

En ese caso respalde la base antigua, renómbrela o elimínela manualmente y vuelva a importar. Puede quedar el procedimiento `pp_install_guard`, que es inofensivo (`DROP PROCEDURE pp_install_guard;`).

## 5. Importar en phpMyAdmin

1. En el panel izquierdo **no seleccione ninguna base**: haga clic en el logotipo o en «Servidor».
2. Pestaña **Importar**.
3. **Archivo a importar** → *Seleccionar archivo* → `database/pharma_plus_mariadb_10_11.sql`.
4. **Conjunto de caracteres del archivo:** `utf-8`.
5. **Formato:** `SQL`. Deje **marcada** la opción *Habilitar la revisión de las claves foráneas* y el resto de opciones como están.
6. Pulse **Importar** (o *Continuar*).

Resultado esperado, en unos segundos: el mensaje de éxito con **241 consultas ejecutadas** (en inglés: *Import has been successfully finished, 241 queries executed*). En el panel izquierdo aparecerá `pharma_plus`.

Volver a importar el mismo archivo sobre esta base es seguro: no duplica datos y recrea triggers, procedimientos y vistas.

## 6. Verificar la instalación

Use la **pestaña SQL** de phpMyAdmin, no la pestaña Importar: la pestaña Importar ejecuta el archivo pero no muestra los resultados de los SELECT.

### 6.1 Validación (30 comprobaciones)

1. Abra `database/VALIDAR_DATABASE_MARIADB.sql` en VS Code, seleccione todo y copie.
2. phpMyAdmin → pestaña **SQL** → pegue → **Continuar**.
3. Baje hasta la última tabla («verificacion / esperado / obtenido / resultado»): **las 30 filas deben decir PASS.** Las tablas anteriores muestran el detalle: relaciones, vistas, triggers, CHECK y datos iniciales.

### 6.2 Pruebas funcionales (61 verificaciones)

1. Copie el contenido de `database/PRUEBAS_ESCENARIOS_MARIADB.sql`.
2. phpMyAdmin → pestaña **SQL** → pegue → **Continuar**.
3. Debajo de `CALL pp_run_scenarios()` aparece la tabla de resultados:
   - La primera fila (**RESUMEN**) debe decir **61 PASS / 0 FAIL**.
   - La última fila (**CLEAN**) debe confirmar **0 registros de prueba restantes**.

Cubre productos, sucursales, lotes, vencimientos, FEFO, entradas, ventas, lotes vendidos, devoluciones parciales y totales, pagos simulados aprobados y rechazados, pedidos (pendiente sin descontar y confirmación con descuento único), transferencias, caja, auditoría, permisos, integridad y las validaciones con expresiones regulares. Todo se ejecuta dentro de una transacción que se deshace al final.

### 6.3 Consultas rápidas

```sql
SELECT VERSION();
SHOW FULL TABLES FROM pharma_plus WHERE Table_type = 'BASE TABLE';   -- 42
SHOW FULL TABLES FROM pharma_plus WHERE Table_type = 'VIEW';         -- 17
SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = 'pharma_plus';   -- 77
SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = 'pharma_plus'; -- 4 sp_*
SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = 'pharma_plus'; -- 103
SELECT LEVEL, COUNT(*) FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = 'pharma_plus' GROUP BY LEVEL; -- Table 82, Column 2

SELECT * FROM pharma_plus.branches;
SELECT * FROM pharma_plus.categories;
SELECT r.code, COUNT(*) FROM pharma_plus.role_permissions rp JOIN pharma_plus.roles r ON r.id = rp.role_id GROUP BY r.code;
SELECT * FROM pharma_plus.settings;
SELECT * FROM pharma_plus.vw_integrity_issues;   -- debe estar vacía
```

En la pestaña SQL escriba las tablas como `pharma_plus.tabla`, o seleccione antes la base en el panel izquierdo. phpMyAdmin puede cambiar la base activa después de consultar `information_schema`.

**Diagrama de relaciones:** seleccione `pharma_plus` → **Más** → **Diseñador**.

## 7. Crear el primer administrador (de forma segura)

El script **no** crea usuarios. La tabla `users` solo acepta hashes **bcrypt** (`$2a$`, `$2b$`, `$2y$`) o **Argon2** (`$argon2id$…`); una contraseña en texto plano es rechazada.

El primer administrador lo crea **una sola vez** un script del backend que:

1. Pide el correo y la contraseña por consola, o los lee de variables de entorno (nunca escritos en el código).
2. Genera el hash: bcrypt con costo 12 o más, o Argon2id.
3. Ejecuta, con consultas parametrizadas:

```sql
START TRANSACTION;
INSERT INTO users (role_id, full_name, email, password_hash, must_change_password)
VALUES ((SELECT id FROM roles WHERE code = 'ADMIN'), ?, ?, ?, TRUE);
SET @admin_id = LAST_INSERT_ID();
INSERT INTO user_branches (user_id, branch_id, is_default)
VALUES (@admin_id, (SELECT id FROM branches WHERE is_main = TRUE), TRUE);
COMMIT;
```

La auditoría registra el correo, el nombre y el rol, nunca el hash.

## 8. Configuración necesaria para el backend (Node.js + Express + mysql2)

> Referencia para la fase de backend; no se instaló ninguna dependencia.

**Usuario de aplicación con privilegios mínimos** (pestaña SQL; la contraseña se define en ese momento y se guarda solo en el `.env` del backend):

```sql
CREATE USER 'pharma_app'@'localhost' IDENTIFIED BY '<CONTRASEÑA_SEGURA>';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON pharma_plus.* TO 'pharma_app'@'localhost';
```

**Opciones de conexión** (valores sensibles desde `.env`):

```js
// Referencia de configuración mysql2/promise
const pool = mysql.createPool({
  host: '127.0.0.1', port: 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: 'pharma_plus',
  charset: 'utf8mb4_unicode_ci',   // misma collation que la base
  timezone: '-05:00',              // hora de Lima
  decimalNumbers: false,           // los DECIMAL llegan como texto: no perder precisión en importes
  multipleStatements: false,
});
// En cada conexión nueva:
//   SET time_zone = '-05:00';
//   SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION';
// En cada petición autenticada, antes de operar:
//   CALL sp_set_app_context(<id_usuario>, <id_sucursal>, '<id_peticion>', '<ip>');
```

**Códigos de error a manejar** (usar `err.errno`, no el texto):

| errno | Significado |
|---|---|
| 1644 | Regla de negocio de la base (mensaje con prefijo `PP:`); se puede mostrar al usuario |
| 4025 | Restricción CHECK violada (en MariaDB; en MySQL es 3819) |
| 1062 | Valor duplicado (clave única) |
| 1452 / 1451 | Clave foránea inexistente / registro con dependencias |
| 1213 / 1205 | Deadlock / espera de bloqueo: reintentar la transacción completa |

**Reglas que la base exige al backend** (iguales que en MySQL 8):

- El stock se modifica **solo** insertando en `inventory_movements` (lote y documento de origen).
- Los números de documento se obtienen con `CALL sp_next_document_number(<sucursal>, '<TIPO>', @n)` dentro de la transacción.
- Las ventas, pagos, kardex y auditoría no se borran; se anulan o se revierten con nuevos registros.
- Alertas de vencimiento: ejecutar `CALL sp_refresh_expiry_alerts();` una vez al día, desde el backend o con el EVENT opcional comentado al final del script (requiere `event_scheduler = ON`).

Los flujos detallados de entrada, venta, pedido, anulación, devolución, transferencia y caja están en la sección 8.3 de `README_DATABASE.md`; son idénticos en MariaDB.

## 9. Solución de problemas

| Mensaje | Causa / solución |
|---|---|
| `#1644 PP: la base pharma_plus tiene la estructura antigua…` (y posibles `#1792`) | Ya existe una base antigua. Es la protección del script: no se modificó nada. Respalde la base y use una limpia (sección 4). |
| `#1044` / `#1142 … command denied` | El usuario no tiene permisos suficientes. Importe con `root`. |
| `#1064 … near 'REGEXP_LIKE'` | Está importando `pharma_plus_mysql8.sql`. Use `pharma_plus_mariadb_10_11.sql`. |
| La pestaña SQL muestra solo `# Rows: N` | Ejecutó una versión antigua del archivo de pruebas o le agregó sentencias. Use el archivo entregado. |
| `Unknown table '…' in information_schema` en la pestaña SQL | phpMyAdmin cambió la base activa. Escriba `pharma_plus.tabla` o seleccione la base en el panel izquierdo. |
| `#2006 MySQL server has gone away` al importar | Aumente `max_allowed_packet` en `my.ini` (sección 3) y reinicie MySQL. |
| Fechas con 5 horas de diferencia | Falta `SET time_zone = '-05:00'` en la conexión. |
| `Illegal mix of collations` en consultas propias | Conexión con otra collation: use `SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci`. |
