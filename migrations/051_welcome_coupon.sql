-- 051_welcome_coupon.sql
-- Cupón de bienvenida para incentivar el registro de nuevos usuarios y la primera compra.

INSERT INTO coupons (code, type, value, active, expires_at, max_uses, times_used, min_amount)
VALUES ('BIENVENIDA5', 'percent', 5, 1, NULL, 999999, 0, 0)
ON CONFLICT (code) DO UPDATE 
SET active = 1, value = 5, min_amount = 0;
