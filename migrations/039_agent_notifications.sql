-- Avisos del panel de asesores: cada asesor tiene su propio historial (chats
-- nuevos, pedidos, pagos de comisiones y avisos del administrador), además del
-- push al móvil. `tag` agrupa los avisos repetidos de una misma conversación.
CREATE TABLE IF NOT EXISTS agent_notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  category    TEXT NOT NULL DEFAULT 'chat',
  title       TEXT NOT NULL,
  body        TEXT,
  url         TEXT,
  tag         TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_notifications_user_idx ON agent_notifications (user_id, id DESC);

-- Porcentaje del margen neto que cobra cada asesor (por defecto el 50 %).
ALTER TABLE chat_agents ADD COLUMN IF NOT EXISTS commission_share NUMERIC(5,2) NOT NULL DEFAULT 50;
