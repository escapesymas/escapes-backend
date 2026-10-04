-- Importe de un pedido que corresponde al asesor: solo los productos que él
-- preparó (si el cliente lo añadió a su carrito, el resto no cuenta), sin envío.
ALTER TABLE chat_orders ADD COLUMN IF NOT EXISTS attributed_cents INTEGER;
