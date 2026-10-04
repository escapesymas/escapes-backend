-- Chat con un asesor humano: cuando el asistente IA no resuelve la consulta y
-- hay alguien atendiendo (horario de app_settings.support_hours), el cliente
-- puede pasar a hablar con el administrador, que responde desde el panel.

CREATE TABLE IF NOT EXISTS chat_conversations (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  -- waiting: esperando al asesor · open: el asesor ya ha respondido · closed
  status           TEXT NOT NULL DEFAULT 'waiting',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  taken_at         TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ,
  closed_by        TEXT,
  customer_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admin_seen_at    TIMESTAMPTZ,
  last_email_at    TIMESTAMPTZ,
  last_push_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS chat_conversations_user_idx ON chat_conversations (user_id, status);
CREATE INDEX IF NOT EXISTS chat_conversations_status_idx ON chat_conversations (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  -- customer · ai (conversación previa con el asistente) · agent · system
  sender          TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages (conversation_id, id);

-- Ajustes generales de la tienda (clave → JSON).
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Horario inicial: lunes a viernes de 10:00 a 14:00 y de 16:00 a 20:00 (se cambia en el panel).
INSERT INTO app_settings (key, value) VALUES ('support_hours', '{
  "mode": "auto",
  "timezone": "Europe/Madrid",
  "agentName": "Equipo de Escapes y Más",
  "days": {
    "1": [["10:00", "14:00"], ["16:00", "20:00"]],
    "2": [["10:00", "14:00"], ["16:00", "20:00"]],
    "3": [["10:00", "14:00"], ["16:00", "20:00"]],
    "4": [["10:00", "14:00"], ["16:00", "20:00"]],
    "5": [["10:00", "14:00"], ["16:00", "20:00"]],
    "6": [],
    "0": []
  }
}'::jsonb) ON CONFLICT (key) DO NOTHING;
