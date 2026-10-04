-- Resumen de la IA al día (se rehace si hay mensajes nuevos) y notas de la
-- ficha del cliente que la IA apunta al cerrar cada conversación.
ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS summary_msg_id BIGINT,       -- último mensaje incluido en el resumen
  ADD COLUMN IF NOT EXISTS notes_ai_at TIMESTAMPTZ;     -- notas de la IA ya apuntadas
ALTER TABLE customer_notes
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',   -- manual · ia
  ADD COLUMN IF NOT EXISTS conversation_id INTEGER;
