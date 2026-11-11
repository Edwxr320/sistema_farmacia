-- ============================================================================
-- PHARMA PLUS - Usuario restringido de la aplicación (pharma_app)
-- ----------------------------------------------------------------------------
-- Ejecutar UNA VEZ como root en phpMyAdmin (pestaña SQL) o en la consola:
--   C:\xampp\mysql\bin\mariadb.exe -u root -p < database\setup\01_crear_usuario_pharma_app.sql
--
-- ANTES DE EJECUTAR: reemplace las DOS apariciones de  CAMBIE_ESTA_CONTRASENA
-- por una contraseña elegida por usted (16+ caracteres, sin comillas simples).
-- Guárdela solo en el archivo .env (DB_PASSWORD). No la suba al repositorio.
--
-- Privilegios: solo datos (SELECT, INSERT, UPDATE, DELETE) y EXECUTE para los
-- procedimientos sp_*. NO puede crear, alterar ni eliminar tablas, vistas,
-- triggers ni procedimientos, ni administrar usuarios.
--   - DELETE se concede porque algunas tablas lo permiten (cart_items,
--     user_permissions...). Los triggers de la base siguen impidiendo borrar
--     ventas, pagos, kardex, auditoría, usuarios, etc.
--   - Los triggers y vistas se ejecutan con los privilegios de su DEFINER,
--     por lo que la auditoría funciona sin dar más permisos a pharma_app.
--
-- Se crea para 'localhost' y '127.0.0.1' porque Node.js se conecta por TCP a
-- 127.0.0.1 y, según la resolución de nombres, MariaDB puede identificar la
-- conexión con cualquiera de los dos hosts.
-- ============================================================================

CREATE USER IF NOT EXISTS 'pharma_app'@'localhost' IDENTIFIED BY 'CAMBIE_ESTA_CONTRASENA';
CREATE USER IF NOT EXISTS 'pharma_app'@'127.0.0.1' IDENTIFIED BY 'CAMBIE_ESTA_CONTRASENA';

GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON pharma_plus.* TO 'pharma_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON pharma_plus.* TO 'pharma_app'@'127.0.0.1';

-- Verificación
SHOW GRANTS FOR 'pharma_app'@'localhost';
SHOW GRANTS FOR 'pharma_app'@'127.0.0.1';

-- ----------------------------------------------------------------------------
-- Para cambiar la contraseña más adelante:
--   ALTER USER 'pharma_app'@'localhost' IDENTIFIED BY 'NUEVA';
--   ALTER USER 'pharma_app'@'127.0.0.1' IDENTIFIED BY 'NUEVA';
-- y actualice DB_PASSWORD en .env.
-- ----------------------------------------------------------------------------
