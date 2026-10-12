-- Programa de escritorio de asesores «recordado»: tras completar la verificación
-- en dos pasos, el programa guarda un token de dispositivo (aquí solo su
-- SHA-256) con el que renueva la sesión de 24 h sin volver a pedir contraseña
-- ni código. Caduca a los 30 días sin uso y se puede revocar.
CREATE TABLE IF NOT EXISTS staff_devices (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS staff_devices_user_idx ON staff_devices (user_id);
