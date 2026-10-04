-- Chat con asesor (2): asesor que atiende, mensajes enriquecidos y pedidos
-- preparados desde el chat con registro de quién los creó (para comisiones).

-- Quién atiende cada conversación (habrá varios asesores).
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS agent_user_id INTEGER;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS agent_name TEXT;

-- Tipos de mensaje: text · product (tarjeta de producto) · image · order (pedido con botón de pago).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS payload JSONB;

-- Pedidos que prepara un asesor. El cliente los paga en el checkout de la web
-- (/checkout?propuesta=token), donde pone su dirección y se calculan envío e IVA.
CREATE TABLE IF NOT EXISTS chat_orders (
  id              SERIAL PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  conversation_id INTEGER REFERENCES chat_conversations(id) ON DELETE SET NULL,
  user_id         INTEGER NOT NULL,          -- cliente
  agent_user_id   INTEGER,                   -- asesor que lo preparó
  agent_name      TEXT,
  items           JSONB NOT NULL,            -- [{ id, quantity }]
  note            TEXT,
  estimate_cents  INTEGER,                   -- importe estimado al enviarlo (sin envío ni impuestos de destino)
  order_id        INTEGER,                   -- último pedido creado con esta propuesta
  status          TEXT NOT NULL DEFAULT 'sent', -- sent · ordered · cancelled
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_orders_agent_idx ON chat_orders (agent_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_orders_order_idx ON chat_orders (order_id);

-- Origen del pedido: quién lo creó y por qué canal.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_channel TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS chat_order_id INTEGER;
CREATE INDEX IF NOT EXISTS orders_created_by_idx ON orders (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
