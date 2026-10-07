-- Verificación en dos pasos del personal (administradores y asesores):
-- llaves de acceso (Face ID / huella, WebAuthn), Google Authenticator (TOTP)
-- y códigos de recuperación de un solo uso.
CREATE TABLE IF NOT EXISTS staff_mfa (
  user_id         INTEGER PRIMARY KEY,
  totp_secret_enc TEXT,                                   -- cifrado AES-256-GCM
  totp_enabled    BOOLEAN NOT NULL DEFAULT false,
  recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,     -- sha256 de los códigos sin usar
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS staff_passkeys (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,                     -- base64url
  public_key    TEXT NOT NULL,                            -- base64url
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    JSONB NOT NULL DEFAULT '[]'::jsonb,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_staff_passkeys_user ON staff_passkeys(user_id);
