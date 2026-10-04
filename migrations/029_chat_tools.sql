-- Herramientas del chat con asesor: inactividad, transferencias, respuestas
-- rápidas, resumen de la IA, ficha del cliente, recordatorio de pedido,
-- valoraciones, estadísticas, mensajes fuera de horario, «escribiendo…»,
-- «visto» y estado «en pausa».

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS offline BOOLEAN NOT NULL DEFAULT FALSE,          -- mensaje dejado fuera de horario
  ADD COLUMN IF NOT EXISTS inactivity_warned_at TIMESTAMPTZ,                -- «¿Sigues ahí?»
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,                   -- primera respuesta de un asesor
  ADD COLUMN IF NOT EXISTS summary TEXT,                                    -- resumen de la IA para el asesor
  ADD COLUMN IF NOT EXISTS rating SMALLINT,                                 -- valoración del cliente (1-5)
  ADD COLUMN IF NOT EXISTS rating_comment TEXT,
  ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_typing_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_typing_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_read_id BIGINT NOT NULL DEFAULT 0,     -- último mensaje que ha visto el cliente
  ADD COLUMN IF NOT EXISTS agent_read_id BIGINT NOT NULL DEFAULT 0;        -- último mensaje que ha visto el asesor

-- Conectado y en pausa: en pausa sigue con su chat pero no recibe nuevos.
ALTER TABLE chat_agents ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE;

-- Respuestas rápidas: owner_user_id NULL = para todo el equipo.
CREATE TABLE IF NOT EXISTS chat_quick_replies (
  id            SERIAL PRIMARY KEY,
  owner_user_id INTEGER,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_quick_replies_owner_idx ON chat_quick_replies (owner_user_id);

-- Notas internas sobre un cliente (no las ve el cliente).
CREATE TABLE IF NOT EXISTS customer_notes (
  id               SERIAL PRIMARY KEY,
  customer_user_id INTEGER NOT NULL,
  author_user_id   INTEGER,
  author_name      TEXT,
  body             TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_notes_customer_idx ON customer_notes (customer_user_id, created_at DESC);

-- Recordatorio del pedido preparado en el chat que no se ha pagado.
ALTER TABLE chat_orders ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- Respuestas rápidas iniciales para todo el equipo.
INSERT INTO chat_quick_replies (owner_user_id, title, body)
SELECT NULL, t.title, t.body FROM (VALUES
  ('Plazo de envío', 'Los pedidos se preparan en 24-72 horas hábiles desde el pago y te enviamos el número de seguimiento por email en cuanto sale.'),
  ('Envío gratis', 'El envío cuesta 19,99 € y es gratis en pedidos desde 200 €.'),
  ('Devoluciones', 'Tienes 14 días desde que lo recibes para devolverlo sin usar ni montar y en su embalaje original. Se pide desde Mi cuenta → Mis pedidos → «Solicitar reembolso».'),
  ('Pedir datos de la moto', 'Para darte la pieza exacta, ¿me dices marca, modelo y año de tu moto?'),
  ('Despedida', 'Gracias por escribirnos, {cliente}. Si necesitas algo más, aquí estamos. ¡Buena ruta!')
) AS t(title, body)
WHERE NOT EXISTS (SELECT 1 FROM chat_quick_replies);
