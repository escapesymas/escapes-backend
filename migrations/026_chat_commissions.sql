-- Descuentos del asesor y comisiones: comisión estimada al enviar el pedido y
-- la definitiva al crearse con los precios cobrados (50 % del margen neto).
ALTER TABLE chat_orders ADD COLUMN IF NOT EXISTS estimate_commission_cents INTEGER;
ALTER TABLE chat_orders ADD COLUMN IF NOT EXISTS commission_cents INTEGER;
