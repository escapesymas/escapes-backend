-- Descripciones montadas con los datos del producto cuando el fabricante no da ninguna (lib/attribute-descriptions.ts).
-- facts = los datos que se le pasan a la IA (lo único que puede usar); html = la descripción ya validada.
CREATE TABLE IF NOT EXISTS attribute_descriptions (
  product_id INT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  facts JSONB NOT NULL,
  facts_hash TEXT NOT NULL,
  html TEXT,
  in_stock BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS attribute_descriptions_pending ON attribute_descriptions (in_stock DESC, product_id) WHERE html IS NULL;
