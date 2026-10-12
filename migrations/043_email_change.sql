-- Cambio de email desde «Mi perfil» (routes/auth.ts): el email nuevo no se
-- aplica hasta que el cliente abre el enlace que le llega a esa dirección.
-- El token se guarda como hash SHA-256; el enlace caduca a las 24 h.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_email_change_token ON users (email_change_token_hash) WHERE email_change_token_hash IS NOT NULL;
