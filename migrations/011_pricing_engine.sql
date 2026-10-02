-- Motor de precios (lib/pricing.ts).
--   pvp           PVP recomendado de Bihr, IVA incluido (céntimos). Lo trae el
--                 catálogo HardPart/RiderGear; el coste real (precio neto de
--                 cliente) lo trae el catálogo Prices.
--   price_manual  el precio se fijó a mano en el admin: el motor no lo toca.
-- Reglas: precio = máx(PVP × (1 − descuento), suelo de margen mínimo), donde el
-- suelo cubre coste, IVA y comisión de pago con el margen neto pedido. Se busca
-- regla de marca, luego de categoría raíz, luego global; sin reglas: PVP con
-- suelo del 15 %. El cálculo automático tras cada importación se activa con
-- catalog_meta.pricing_auto = 'on' (por defecto 'off': solo a mano).
ALTER TABLE products ADD COLUMN IF NOT EXISTS pvp INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_manual BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS min_margin_percent NUMERIC(5,2) NOT NULL DEFAULT 15;

CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO catalog_meta (key, value) VALUES ('pricing_auto', 'off') ON CONFLICT (key) DO NOTHING;
