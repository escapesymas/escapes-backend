-- Precio de promoción en su propio campo: sale_price (DTO1) ya no se pisa.
--   price        PVP de Bihr
--   sale_price   DTO1, precio habitual
--   promo_price  precio de la promoción activa (DTO2 o DTO1 − %), NULL si no hay
-- Lo que paga el cliente: promo_price, si no sale_price, si no price.
ALTER TABLE products ADD COLUMN IF NOT EXISTS promo_price INTEGER;
-- Promociones ya aplicadas con el esquema anterior (sale_price = promoción).
UPDATE products SET promo_price = sale_price, sale_price = price_dto1
WHERE promo_id IS NOT NULL AND promo_price IS NULL;
