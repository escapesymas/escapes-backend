-- Solicitudes de reembolso que hace el cliente desde "Mi cuenta".
-- El equipo las aprueba (reembolso por Stripe) o las rechaza desde el admin.
CREATE TABLE IF NOT EXISTS refund_requests (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id       INTEGER,
  scope         VARCHAR(10) NOT NULL CHECK (scope IN ('full', 'partial')),
  -- [{ itemId, productId, name, quantity, priceCents }]
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Importe estimado en céntimos (proporcional a lo que se pagó por esas líneas)
  amount_cents  INTEGER NOT NULL,
  reason_code   VARCHAR(40) NOT NULL,
  reason        TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'refunded', 'rejected')),
  admin_note    TEXT,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refund_requests_order ON refund_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_pending ON refund_requests(status) WHERE status = 'pending';
