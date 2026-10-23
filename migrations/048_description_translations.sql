-- Descripciones del proveedor que llegan en inglés y su traducción (lib/description-translation.ts).
-- hash = sha1 del HTML limpio en inglés; product_ids = productos que la usan (lo refresca la pasada diaria).
CREATE TABLE IF NOT EXISTS description_translations (
  hash TEXT PRIMARY KEY,
  source_html TEXT NOT NULL,
  html_es TEXT,
  product_ids INT[] NOT NULL DEFAULT '{}',
  in_stock BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  translated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS description_translations_pending ON description_translations (in_stock DESC, created_at) WHERE html_es IS NULL;
