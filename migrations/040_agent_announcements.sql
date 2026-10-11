-- Avisos que el administrador envía a los asesores: uno por envío, con sus
-- destinatarios en agent_notifications (announcement_id) para saber quién lo ha leído.
CREATE TABLE IF NOT EXISTS agent_announcements (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT,
  created_by  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE agent_notifications ADD COLUMN IF NOT EXISTS announcement_id INTEGER REFERENCES agent_announcements(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agent_notifications_announcement_idx ON agent_notifications (announcement_id);

-- Los avisos enviados antes de existir esta tabla: uno por cada aviso guardado.
DO $$
DECLARE r RECORD; new_id INTEGER;
BEGIN
  FOR r IN SELECT id, title, body, created_at FROM agent_notifications
           WHERE category = 'announcement' AND announcement_id IS NULL ORDER BY id LOOP
    INSERT INTO agent_announcements (title, body, created_at)
    VALUES (regexp_replace(r.title, '^📢 ', ''), r.body, r.created_at) RETURNING id INTO new_id;
    UPDATE agent_notifications SET announcement_id = new_id WHERE id = r.id;
  END LOOP;
END $$;
