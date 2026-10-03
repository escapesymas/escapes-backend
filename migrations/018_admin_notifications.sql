-- Historial de avisos del panel: se guarda cada notificación que se envía al
-- móvil para poder consultarla en el admin aunque no llegue el push.
CREATE TABLE IF NOT EXISTS admin_notifications (
  id          SERIAL PRIMARY KEY,
  category    VARCHAR(40) NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  url         TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_created ON admin_notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_unread ON admin_notifications(id) WHERE read_at IS NULL;
