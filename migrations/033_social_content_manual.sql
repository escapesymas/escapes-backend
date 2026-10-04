-- Contenido TikTok hecho a mano con el plan Google AI Pro: la IA deja escritos
-- los prompts para la app de Gemini (imagen) y Flow/Veo (vídeo), y el
-- administrador sube aquí la imagen o el vídeo final.
ALTER TABLE social_content_calendar
  ADD COLUMN IF NOT EXISTS image_prompt TEXT,
  ADD COLUMN IF NOT EXISTS video_prompt TEXT,
  ADD COLUMN IF NOT EXISTS final_media JSONB NOT NULL DEFAULT '[]'::jsonb;   -- [{url, type: image|video, name}]
