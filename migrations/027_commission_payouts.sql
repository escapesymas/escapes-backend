-- Pagos de comisiones a los asesores. Cada pago agrupa comisiones disponibles
-- (pedido pagado hace más de 30 días y no devuelto) y queda registrado con el
-- método y la referencia (transferencia, Stripe…).
CREATE TABLE IF NOT EXISTS commission_payouts (
  id              SERIAL PRIMARY KEY,
  agent_user_id   INTEGER NOT NULL,
  agent_name      TEXT,
  amount_cents    INTEGER NOT NULL,
  method          TEXT NOT NULL DEFAULT 'transferencia',
  reference       TEXT,
  note            TEXT,
  created_by      INTEGER,
  paid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS commission_payouts_agent_idx ON commission_payouts (agent_user_id, paid_at DESC);

ALTER TABLE chat_orders ADD COLUMN IF NOT EXISTS payout_id INTEGER REFERENCES commission_payouts(id) ON DELETE SET NULL;
