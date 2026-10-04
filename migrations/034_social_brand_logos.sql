-- Imágenes promocionales de TikTok: logos oficiales de cada marca (los sube el
-- administrador) y las imágenes base sin logos, para poder rehacer la
-- composición cuando se sube un logo nuevo sin volver a generar con IA.
CREATE TABLE IF NOT EXISTS brand_logos (
  brand       TEXT PRIMARY KEY,          -- en mayúsculas, como products.brand
  url         TEXT NOT NULL,             -- /uploads/social-content/brands/...png
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE social_content_calendar
  ADD COLUMN IF NOT EXISTS base_media JSONB NOT NULL DEFAULT '[]'::jsonb;
