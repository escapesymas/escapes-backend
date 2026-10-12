-- Avisos de piezas nuevas para una moto (lib/moto-alerts.ts).
--   source 'boton':  el cliente pulsó «Avísame cuando haya piezas para mi moto».
--   source 'garaje': una moto guardada en el garaje de un cliente registrado
--                    (se sincroniza sola con users.garage en cada pasada).
-- moto_alert_seen guarda los SKU ya conocidos de cada aviso: al crearlo se
-- marcan los que ya había, así solo se avisa de lo nuevo (productos nuevos o
-- compatibilidades nuevas en productos que ya existían).
CREATE TABLE IF NOT EXISTS moto_alerts (
  id               SERIAL PRIMARY KEY,
  email            TEXT NOT NULL,
  user_id          INTEGER,
  brand            TEXT NOT NULL,
  model            TEXT NOT NULL,
  year             TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT 'boton',
  token            TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at     TIMESTAMPTZ,
  unsubscribed_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS moto_alerts_unique_idx ON moto_alerts (lower(email), brand, model, year);

CREATE TABLE IF NOT EXISTS moto_alert_seen (
  alert_id  INTEGER NOT NULL REFERENCES moto_alerts(id) ON DELETE CASCADE,
  sku       TEXT NOT NULL,
  PRIMARY KEY (alert_id, sku)
);

-- Clientes que no quieren ningún aviso de piezas nuevas (baja de todo).
CREATE TABLE IF NOT EXISTS moto_alert_optout (
  email       TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
