-- Migration: 006_fix_instock_index
-- Date: 2026-08-14
-- Purpose: Correct the partial index for products in stock.
--          Migration 003 created `idx_products_universal_instock` using `in_stock = true`,
--          which is not used by the application queries (`AND stock > 0`).
--          This index creates a partial index using `stock > 0` matching actual queries.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_stock_gt_zero
  ON products (stock, id)
  WHERE (compatibility IS NULL OR compatibility = '[]'::jsonb OR compatibility::text = '[]')
    AND stock > 0;
