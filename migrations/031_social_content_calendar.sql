-- Calendario de contenido para redes sociales (TikTok y similares): cada fila
-- es una publicación programada con su copy e imágenes generadas por IA.
CREATE TABLE IF NOT EXISTS social_content_calendar (
  id            SERIAL PRIMARY KEY,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  format        VARCHAR(20) NOT NULL DEFAULT 'video', -- video | photo | carousel
  topic         TEXT,
  product_sku   TEXT,
  copy          TEXT,
  hashtags      TEXT,
  script        TEXT,              -- guion/voz en off para vídeo
  media_urls    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft | generating | ready | published | skipped
  error         TEXT,
  notified_at   TIMESTAMPTZ,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_content_scheduled ON social_content_calendar(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_social_content_status ON social_content_calendar(status);
