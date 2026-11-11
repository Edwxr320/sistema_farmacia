-- ============================================================================
-- PHARMA PLUS - MIGRACIÓN 001: sesiones persistentes (user_sessions)
-- ----------------------------------------------------------------------------
-- Motor   : MariaDB 10.11
-- Tipo    : NO destructiva. Solo crea una tabla nueva si no existe.
--           No modifica, elimina ni recrea tablas existentes ni datos.
-- Ejecutar: UNA VEZ, con root (u otro usuario con privilegio CREATE y
--           REFERENCES), desde phpMyAdmin → pestaña SQL, o por consola:
--   C:\xampp\mysql\bin\mariadb.exe -u root -p < database\migrations\001_user_sessions.sql
-- Repetir la ejecución es seguro (CREATE TABLE IF NOT EXISTS).
--
-- pharma_app NO necesita permisos nuevos: su GRANT sobre pharma_plus.*
-- (SELECT, INSERT, UPDATE, DELETE) ya cubre esta tabla.
--
-- Seguridad: se guarda el SHA-256 del identificador de sesión (jti), nunca el
-- token ni el identificador en texto plano. Robar esta tabla no permite
-- suplantar sesiones.
-- ============================================================================

USE pharma_plus;

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION';

CREATE TABLE IF NOT EXISTS user_sessions (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    session_hash    CHAR(64)        NOT NULL,          -- SHA-256 hex del jti
    user_id         BIGINT UNSIGNED NOT NULL,
    branch_id       BIGINT UNSIGNED NULL,              -- sucursal activa de la sesión
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at    DATETIME        NULL,
    expires_at      DATETIME        NOT NULL,
    revoked_at      DATETIME        NULL,
    revoked_reason  ENUM('LOGOUT','PASSWORD_CHANGED','USER_DISABLED','ADMIN') NULL,
    ip_address      VARCHAR(45)     NULL,
    user_agent      VARCHAR(255)    NULL,
    CONSTRAINT uq_user_sessions_hash UNIQUE (session_hash),
    CONSTRAINT fk_user_sessions_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_user_sessions_branch
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_user_sessions_hash CHECK ((session_hash REGEXP '(?-i)^[0-9a-f]{64}$')),
    CONSTRAINT chk_user_sessions_expiry CHECK (expires_at > created_at),
    CONSTRAINT chk_user_sessions_revoked CHECK (
      (revoked_at IS NULL AND revoked_reason IS NULL) OR
      (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)),
    INDEX idx_user_sessions_user_active (user_id, revoked_at, expires_at),
    INDEX idx_user_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verificación: debe devolver una fila con user_sessions
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'pharma_plus' AND TABLE_NAME = 'user_sessions';
