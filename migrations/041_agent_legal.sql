-- Constancia de que cada asesor ha recibido y aceptado la información sobre
-- protección de datos y el compromiso de confidencialidad (versión, huella del
-- texto aceptado, fecha, IP y navegador) y de cuándo se le envió la copia.
CREATE TABLE IF NOT EXISTS agent_legal_acceptances (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  version     TEXT NOT NULL,
  doc_hash    TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip          TEXT,
  user_agent  TEXT,
  emailed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_legal_acceptances_user_idx ON agent_legal_acceptances (user_id, accepted_at DESC);
