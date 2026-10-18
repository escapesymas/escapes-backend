-- Enfoque de cada publicación de TikTok (consejo, pregunta, para tu moto, guía de compra o promo directa).
-- NULL = lo elige el generador al crear el contenido, rotando para no repetir siempre la promo.
ALTER TABLE social_content_calendar ADD COLUMN IF NOT EXISTS angle TEXT;
