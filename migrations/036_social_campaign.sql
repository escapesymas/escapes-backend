-- Publicaciones «de marca» (sin producto): p. ej. promocionar el chat con
-- asesores. Cada diapositiva lleva título y texto compuestos por el servidor
-- sobre una escena generada por IA.
ALTER TABLE social_content_calendar
  ADD COLUMN IF NOT EXISTS campaign BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS slides JSONB NOT NULL DEFAULT '[]'::jsonb;   -- [{title, text, scene}]
