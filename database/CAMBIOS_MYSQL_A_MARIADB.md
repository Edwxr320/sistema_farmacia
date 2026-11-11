# Cambios de MySQL 8 a MariaDB 10.11 — Pharma Plus

Adaptación de `pharma_plus_mysql8.sql` (v2.0) a `pharma_plus_mariadb_10_11.sql`, para usarla con **XAMPP + MariaDB 10.11 + phpMyAdmin**.

- **El modelo no cambia.** Se mantienen las 42 tablas, 103 claves foráneas, 82 restricciones CHECK, 77 triggers, 4 procedimientos, 17 vistas y los mismos datos iniciales. No se eliminó ninguna restricción, trigger ni procedimiento.
- **Cambios reales en el SQL:** 14 expresiones `REGEXP_LIKE`, el `sql_mode` de la sesión de importación y la guarda de instalación (además de los comentarios de cabecera). Son 78 líneas de diferencia en total.
- Los archivos `pharma_plus_mysql8.sql` y `pharma_plus_original.sql` no se modificaron.

---

## 1. Cómo se verificó

| Prueba | Resultado |
|---|---|
| Servidor usado | **MariaDB 10.11.14** (Ubuntu). Desde este entorno no fue posible descargar la 10.11.16 (los repositorios de MariaDB están bloqueados). Es la misma serie LTS 10.11; ver la sección 6. |
| Importación por consola en una base limpia | Sin errores. 42 tablas, 17 vistas, 103 FK, 77 triggers, 4 procedimientos y 82 CHECK más 2 automáticos de JSON. |
| Importación por la **web real de phpMyAdmin 5.2.1** (pestaña Importar, automatizada con un navegador) | «Import has been successfully finished, **241 queries executed**» en unos 3 s. |
| Reimportación sobre la base ya creada (consola y phpMyAdmin) | Sin errores y sin duplicar datos iniciales. |
| `VALIDAR_DATABASE_MARIADB.sql` en la pestaña SQL de phpMyAdmin | **30 de 30 PASS.** |
| `PRUEBAS_ESCENARIOS_MARIADB.sql` en la pestaña SQL de phpMyAdmin y por consola | **61 de 61 PASS** y limpieza verificada (fila CLEAN); la base queda sin datos de prueba. |
| Las mismas pruebas con `sql_mode` vacío (XAMPP sin modo estricto) | 61 de 61 PASS. |
| Concurrencia: dos ventas simultáneas de las últimas 5 unidades de un lote | La segunda esperó el bloqueo y fue rechazada; stock final 0 y un solo `SALE_OUT`. |
| Guarda ante una base `pharma_plus` con la estructura antigua (phpMyAdmin y consola con `--force`) | Importación detenida; la base antigua quedó intacta (ver 2.3). |

---

## 2. Cambios en `pharma_plus_mariadb_10_11.sql`

### 2.1 `REGEXP_LIKE()` no existe en MariaDB (14 usos, todos en restricciones CHECK)

MariaDB no tiene la función `REGEXP_LIKE`, así que se usa el operador `REGEXP`, que en MariaDB 10.11 emplea PCRE2.

| MySQL 8 | MariaDB 10.11 | Usos |
|---|---|---|
| `REGEXP_LIKE(col, 'patrón', 'c')` (sensible a mayúsculas) | `(col REGEXP '(?-i)patrón')` | 6: `chk_roles_code`, `chk_permissions_code`, `chk_branches_code`, `chk_users_password_hash`, `chk_settings_key`, `chk_return_reasons_code` |
| `REGEXP_LIKE(col, 'patrón')` (según la collation) | `(col REGEXP 'patrón')` | 8: `chk_users_email`, `chk_settings_value_type` (2), `chk_customers_dni`, `chk_customers_ruc`, `chk_suppliers_ruc`, `chk_payments_no_card_data` (2) |
| `NOT REGEXP_LIKE(col, 'p')` | `NOT (col REGEXP 'p')` | incluido arriba |

**Por qué hace falta `(?-i)`:** con la collation `utf8mb4_unicode_ci`, `REGEXP` en MariaDB **no distingue mayúsculas**. Sin el prefijo cambiaría el comportamiento sin avisar. Experimento de control en el servidor:

| Expresión | Resultado |
|---|---|
| `'cajero' REGEXP '^[A-Z][A-Z0-9_]*$'` | 1 (sería aceptado: incorrecto) |
| `'cajero' REGEXP '(?-i)^[A-Z][A-Z0-9_]*$'` | 0 (rechazado, igual que MySQL con `'c'`) |
| prefijo `$2B$` evaluado sin `(?-i)` | aceptado (incorrecto) |

Las 8 reglas sin bandera conservan la misma semántica: en MySQL también dependían de la collation `_ci`, y sus patrones solo usan dígitos o símbolos. Los patrones (escapes `\\.`, `\\$`, cuantificadores `{n,m}`, clases `[:space:]`) se copiaron sin cambios; PCRE2 los interpreta igual. Las pruebas T19r–T19y confirman el comportamiento en el servidor.

**Matiz no verificable aquí:** en PCRE2, `$` también coincide antes de un salto de línea final (`'ABC\n'` cumple `^[A-Z]+$`). Según su documentación, el motor ICU de MySQL se comporta igual sin el modo multilínea, pero en esta sesión no pude comprobarlo contra MySQL 8.

### 2.2 `sql_mode` estricto fijado en la sesión de importación

MariaDB guarda dentro de cada trigger y procedimiento el `sql_mode` vigente al crearlo, y lo usa siempre que se ejecuta. El `my.ini` de XAMPP puede no traer el modo estricto, así que el script fija:

```sql
SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION';
SET SESSION foreign_key_checks = 1;
```

Así los 77 triggers y los 4 procedimientos quedan en modo estricto, como en MySQL 8; la validación lo comprueba. Solo afecta a la sesión de importación, no a la configuración global del servidor. No se incluye `ONLY_FULL_GROUP_BY`, que no viene activo por defecto en MariaDB; aun así, las 17 vistas se probaron también con esa opción activa y funcionan.

### 2.3 Guarda de instalación reforzada (seguridad ante phpMyAdmin)

Durante la prueba real con phpMyAdmin apareció un comportamiento que no existe en la consola. Con una base `pharma_plus` antigua, la guarda lanzaba su error, pero **phpMyAdmin siguió ejecutando** el resto del archivo: phpMyAdmin acumula las primeras 49 sentencias y las ejecuta sin cortar ante errores (`libraries/classes/Import.php`). Como resultado se crearon 27 tablas nuevas junto a las 15 antiguas.

**Solución:** antes de lanzar el error, la guarda ejecuta `SET SESSION TRANSACTION READ ONLY`. Toda sentencia posterior de esa conexión (CREATE, DROP, CREATE OR REPLACE VIEW, CREATE TRIGGER, INSERT…) es rechazada con el error 1792. Resultado verificado en phpMyAdmin y en la consola con `--force` (232 sentencias rechazadas):

- Siguen los 17 objetos originales y no se creó ningún trigger.
- `vw_products_low_stock` sigue con su definición original y `users.role` sigue existiendo.

El modo solo lectura dura hasta que se cierra esa conexión (phpMyAdmin abre una nueva en cada petición). Queda el procedimiento auxiliar `pp_install_guard`, que es inofensivo. El mensaje de error se amplió a 133 caracteres; MariaDB admite hasta 512 en `MESSAGE_TEXT` (MySQL, 128).

En una base nueva o ya creada con este script la guarda no hace nada y se elimina sola.

### 2.4 Cabecera

Se indican el motor, la versión probada, cómo importar desde phpMyAdmin y la configuración que necesita la conexión del backend.

---

## 3. Revisado y compatible sin cambios (comprobado en MariaDB 10.11.14)

| Elemento | Resultado en MariaDB |
|---|---|
| **82 restricciones CHECK** | Se aplican, incluidas las que usan columnas generadas (`chk_movements_arithmetic` usa `direction`), `JSON_CONTAINS_PATH` y aritmética de importes. |
| **Columnas JSON** (`audit_logs.old_values/new_values`) | MariaDB convierte `JSON` en `LONGTEXT COLLATE utf8mb4_bin` y agrega un `CHECK (json_valid(...))` automático. Valida igual y `JSON_OBJECT`, `JSON_KEYS` y `JSON_EXTRACT` funcionan. Por eso `information_schema` cuenta 82 + 2 CHECK. |
| **11 columnas `GENERATED ALWAYS … STORED`** | Funcionan, incluidas las de tipo ENUM y BOOLEAN y las que forman parte de índices únicos (alertas abiertas, caja abierta, sucursal principal…). |
| **77 triggers** | Admiten varios por evento, `SIGNAL`, `SELECT … FOR UPDATE`, llamadas a procedimientos y lectura de la tabla que los dispara. Las columnas NOT NULL que completa un trigger BEFORE también funcionan en modo estricto. |
| **4 procedimientos** | Parámetros `OUT`, `FOR UPDATE` e `INSERT … SELECT … ON DUPLICATE KEY UPDATE` que usa columnas de la consulta de origen. |
| **17 vistas** | `ROW_NUMBER() OVER (PARTITION BY …)`, `UNION` con `CONVERT(… USING utf8mb4) COLLATE`, subconsultas correlacionadas. |
| Tipos e índices | `DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)`, `ON UPDATE CURRENT_TIMESTAMP`, `DECIMAL`, `FULLTEXT` en InnoDB, `utf8mb4_unicode_ci`: todos compatibles. |
| `DELIMITER $$` | phpMyAdmin (pestañas Importar y SQL) y la consola lo interpretan correctamente. |
| Concurrencia | `FOR UPDATE` serializa igual que en MySQL. |
| Funciones exclusivas de MySQL | No se usan (`JSON_TABLE`, `->>`, `LATERAL`, columnas invisibles, roles de MySQL, `utf8mb4_0900_*`). |

---

## 4. Diferencias que el backend debe conocer

El comportamiento funcional es el mismo; lo que cambia son algunos **códigos y textos de error**:

| Situación | MySQL 8 | MariaDB 10.11 |
|---|---|---|
| Regla de negocio (`SIGNAL`, mensajes `PP:`) | 1644 | **1644** (igual) |
| Restricción CHECK violada | 3819 · `Check constraint 'chk_x' is violated.` | **4025** · ``CONSTRAINT `chk_x` failed for `pharma_plus`.`tabla` `` |
| Clave duplicada | 1062 · `… for key 'tabla.uq_x'` | **1062** · `… for key 'uq_x'` |
| FK inexistente / borrado restringido | 1452 / 1451 | 1452 / 1451 (igual) |
| Sesión en solo lectura (guarda) | 1792 | 1792 (igual) |
| Deadlock / espera de bloqueo | 1213 / 1205 | 1213 / 1205 (igual) |

**Recomendación:** identificar los errores por código (`err.errno` en mysql2) y por el nombre de la restricción, no por el texto completo.

Otras diferencias:

- **Collation por defecto:** en MariaDB 10.11 la del servidor es `utf8mb4_general_ci`. Las tablas declaran `utf8mb4_unicode_ci` explícitamente; la conexión del backend debe usar esa misma collation (con mysql2: `charset: 'utf8mb4_unicode_ci'`). phpMyAdmin ya la usa por defecto.
- **DEFINER:** las vistas, triggers y procedimientos quedan con `DEFINER = root@localhost`, el usuario que importa en XAMPP. Si se importa con otro usuario, ese usuario será el DEFINER y debe seguir existiendo.

---

## 5. Cambios en los scripts de validación y pruebas

| Problema en MariaDB o phpMyAdmin | Ajuste |
|---|---|
| MariaDB no admite `GET STACKED DIAGNOSTICS` (error 1064) | En el handler de las pruebas se usa `GET DIAGNOSTICS` como primera sentencia, que lee el error que activó el handler. |
| `information_schema.check_constraints` incluye los CHECK automáticos de JSON (`level = 'Column'`) | La validación cuenta por separado 82 de tabla y 2 de columna. |
| La pestaña SQL de phpMyAdmin **cambia la base activa a `information_schema`** después de un SELECT sobre esa base (comprobado: la consulta siguiente sin prefijo falla con «Unknown table … in information_schema») | `VALIDAR_DATABASE_MARIADB.sql` escribe todos los objetos como `pharma_plus.<objeto>`, incluidas las tablas temporales y el SQL dinámico de huérfanos. |
| phpMyAdmin agrega `LIMIT 0, 25` a los SELECT sin límite | Los resultados finales tienen `LIMIT` explícito. |
| Con **50 sentencias o más**, la pestaña SQL ejecuta todo pero solo muestra «# Rows: N» (código de `Import.php`) | Los escenarios se ejecutan dentro de un procedimiento temporal `pp_run_scenarios()`. El archivo queda en unas 17 sentencias y phpMyAdmin muestra la tabla de resultados; los procedimientos auxiliares se eliminan al final. |
| phpMyAdmin trata un comentario final como una consulta más y muestra su resultado vacío | Ningún archivo termina con un comentario después de la última consulta. |
| Validar la adaptación de las expresiones regulares | Se agregaron las pruebas T19r–T19y (mayúsculas en códigos y claves, prefijo bcrypt, Argon2id, correo, DNI, valores numéricos) y la comprobación 16 de la validación. |

---

## 6. Lo que falta comprobar en el equipo del usuario

1. **La versión exacta 10.11.16.** Se probó en 10.11.14, de la misma serie LTS; las versiones de mantenimiento de una serie LTS corrigen errores y no cambian la sintaxis usada aquí. Aun así, la importación no se ha ejecutado en 10.11.16. Para confirmarlo basta ejecutar en XAMPP `VALIDAR_DATABASE_MARIADB.sql` (30 PASS) y `PRUEBAS_ESCENARIOS_MARIADB.sql` (61 PASS), lo que toma pocos segundos.
2. **Windows.** Se probó en Linux. En Windows, XAMPP usa `lower_case_table_names=1`; todos los nombres del modelo ya están en minúsculas, así que no debería afectar, pero no se probó en Windows.
3. **La versión de phpMyAdmin de su XAMPP.** Se probó con phpMyAdmin 5.2.1. Si su XAMPP trae otra versión, las indicaciones sobre la pestaña SQL siguen siendo válidas mientras sea de la serie 5.2.
4. **Versiones anteriores de MariaDB** (por ejemplo la 10.4 que traen algunos instaladores de XAMPP): no se probaron.
