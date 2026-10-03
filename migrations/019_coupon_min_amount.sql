-- Importe mínimo de compra por cupón (céntimos, sobre el total de productos con
-- IVA antes de descuentos). 0 = sin mínimo.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS min_amount INTEGER NOT NULL DEFAULT 0;
