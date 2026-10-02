-- Verificación del email en el registro (routes/auth.ts).
-- El token se guarda como hash SHA-256; el enlace caduca a las 24 h.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_email_verify_token ON users (email_verify_token_hash) WHERE email_verify_token_hash IS NOT NULL;

-- Las cuentas que ya existían se dan por verificadas: nadie se queda fuera.
UPDATE users SET email_verified = TRUE, email_verified_at = COALESCE(email_verified_at, NOW()) WHERE NOT email_verified;
