-- Vídeo de TikTok generado con Veo a partir de una imagen de apoyo: estado de la
-- operación de larga duración de la API (se consulta en segundo plano).
ALTER TABLE social_content_calendar
  ADD COLUMN IF NOT EXISTS video_status TEXT,            -- generating | done | error
  ADD COLUMN IF NOT EXISTS video_op TEXT,                -- nombre de la operación de Veo
  ADD COLUMN IF NOT EXISTS video_error TEXT,
  ADD COLUMN IF NOT EXISTS video_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS video_brand TEXT;              -- marca para los logos al terminar
