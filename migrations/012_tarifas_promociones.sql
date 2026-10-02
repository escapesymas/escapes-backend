-- Tres tarifas por producto (lib/pricing.ts):
--   PVP   products.pvp        PVP recomendado de Bihr (referencia).
--   DTO1  products.price      precio habitual: PVP − descuento de la familia,
--                             con suelo de margen mínimo (pricing_rules).
--   DTO2  products.price_dto2 precio mínimo sin pérdidas (coste + IVA +
--                             comisión de pago + catalog_meta.promo_margin %),
--                             solo para promociones.
-- Una promoción activa pone sale_price (lo que paga el cliente) a DTO2, o a un
-- % de descuento sobre DTO1 sin bajar de DTO2, y marca products.promo_id para
-- poder quitarlo al terminar sin tocar las rebajas puestas a mano.
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_dto2 INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS promo_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_products_promo_id ON products (promo_id) WHERE promo_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS promotions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'category', 'brand', 'skus')),
  target TEXT,
  level TEXT NOT NULL DEFAULT 'dto2' CHECK (level IN ('dto2', 'percent')),
  percent NUMERIC(5,2),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO catalog_meta (key, value) VALUES ('promo_margin', '0') ON CONFLICT (key) DO NOTHING;

-- DTO1 se define por marca (lib/pricing.ts → suggestBrandRules, desde el admin).
-- Regla global de respaldo para marcas sin PVP o coste: −10 % con 15 % mínimo.
INSERT INTO pricing_rules (rule_type, target_id, margin_percent, discount_percent, min_margin_percent, active)
SELECT 'global', NULL, 0, 10, 15, 1 WHERE NOT EXISTS (SELECT 1 FROM pricing_rules);
