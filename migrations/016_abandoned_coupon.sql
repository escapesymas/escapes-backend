-- Cupón real de los recordatorios de carrito abandonado (24 h y 72 h).
-- Antes el correo prometía un descuento "aplicado" que el checkout nunca
-- aplicaba; ahora cada recordatorio crea un cupón de un solo uso en coupons.
ALTER TABLE cart_abandoned_emails ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(40);
