-- Versión de Instagram de cada publicación: imágenes en 4:5 (1080x1350) y
-- texto adaptado (más largo, con «enlace en la bio» y más hashtags).
ALTER TABLE social_content_calendar
  ADD COLUMN IF NOT EXISTS ig_media JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ig_copy TEXT,
  ADD COLUMN IF NOT EXISTS ig_hashtags TEXT,
  ADD COLUMN IF NOT EXISTS ig_status TEXT,          -- generating | ready | error
  ADD COLUMN IF NOT EXISTS ig_error TEXT;
