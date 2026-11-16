-- 052_restock_date.sql
-- Fecha prevista de reaprovisionamiento de Bihr (forecastAvailability de su API v3 de stock): un producto sin stock
-- con fecha está «en reaprovisionamiento». La rellena lib/bihr-live-stock.ts y se borra cuando vuelve a haber stock.

ALTER TABLE products ADD COLUMN IF NOT EXISTS restock_date DATE;
