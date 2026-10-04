-- Rol de asesor y panel de asesores (asesores.escapesymas.com).
--
-- chat_agents: si cada asesor está conectado para atender el chat. La IA ofrece
-- hablar con un asesor si estamos en horario y al menos uno está conectado.
-- El administrador empieza conectado para no cambiar lo que ya funcionaba.
CREATE TABLE IF NOT EXISTS chat_agents (
  user_id    INTEGER PRIMARY KEY,
  online     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO chat_agents (user_id, online) SELECT id, TRUE FROM users WHERE role = 'admin' ON CONFLICT (user_id) DO NOTHING;

-- Invitaciones por email para darse de alta como asesor (enlace de 7 días).
CREATE TABLE IF NOT EXISTS agent_invitations (
  id               SERIAL PRIMARY KEY,
  email            TEXT NOT NULL,
  name             TEXT,
  token_hash       TEXT NOT NULL UNIQUE,
  invited_by       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  accepted_at      TIMESTAMPTZ,
  accepted_user_id INTEGER,
  revoked_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_invitations_email_idx ON agent_invitations (lower(email));
