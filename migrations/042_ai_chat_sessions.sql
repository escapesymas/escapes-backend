-- Conversaciones con el asistente IA de la web: una fila por conversación
-- (session_key la genera el navegador), con los turnos añadidos al final en
-- orden y, si el cliente pasa a un asesor, la conversación de asesor creada.
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id                       SERIAL PRIMARY KEY,
  session_key              TEXT NOT NULL UNIQUE,
  user_id                  INTEGER NOT NULL,
  messages                 JSONB NOT NULL DEFAULT '[]',
  turns                    INTEGER NOT NULL DEFAULT 0,
  handoff_conversation_id  INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_chat_sessions_updated_idx ON ai_chat_sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS ai_chat_sessions_user_idx ON ai_chat_sessions (user_id, updated_at DESC);
