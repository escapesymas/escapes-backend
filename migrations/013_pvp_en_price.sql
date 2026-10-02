-- Las tarifas se reparten así (lib/pricing.ts):
--   price       = PVP de Bihr (se respeta siempre; es el precio tachado)
--   sale_price  = DTO1 (precio habitual con descuento) o, durante una
--                 promoción, DTO2 / DTO1 − %
--   price_dto1  = DTO1 guardado, para volver a él cuando termina la promoción
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_dto1 INTEGER;
