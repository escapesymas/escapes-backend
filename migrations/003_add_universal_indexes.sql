-- Migration: 003_add_universal_indexes
-- Date: 2026-08-09
-- Purpose: Add PostgreSQL indexes to speed up the /api/catalog/products?universal=true
--          query which currently takes ~12-27 seconds.
-- Notes about the schema:
--   - The `universal` query parameter is NOT a column. It is computed in WHERE as:
--       (compatibility IS NULL OR compatibility = '[]'::jsonb OR compatibility::text = '[]')
--   - DB columns are snake_case (parent_id, category_id, in_stock, etc).
--   - All partial indexes below use the SAME predicate the application uses so
--     the planner can use them for universal queries.
-- Safety: Uses CREATE INDEX CONCURRENTLY so the index build does NOT lock the table
--         for writes. Each index is created with IF NOT EXISTS for idempotency.
--         CREATE INDEX CONCURRENTLY cannot be run inside a transaction block.

-- ================================================================
-- Index 1: idx_products_universal_id
-- ================================================================
-- Partial index on products.id, restricted to universal products only.
-- Speeds up:
--   - SELECT * FROM products WHERE (compatibility IS NULL OR ... = '[]')
--   - Pagination (ORDER BY id LIMIT/OFFSET) on universal products
--   - Any planner decision that needs to estimate the universal subset size

-- ================================================================
-- Index 2: idx_products_universal_category
-- ================================================================
-- Composite (category_id, id) index, restricted to universal products.
-- Speeds up:
--   - SELECT * FROM products WHERE compatibility IS NULL OR ... AND category_id = X
--   - Recursive category-subtree scans when filtering universal products

-- ================================================================
-- Index 3: idx_products_universal_brand
-- ================================================================
-- Composite (brand, id) index, restricted to universal products with a
-- non-null brand.
-- Speeds up:
--   - SELECT * FROM products WHERE compatibility IS NULL OR ... AND LOWER(brand) = LOWER(?)

-- ================================================================
-- Index 4: idx_products_universal_instock
-- ================================================================
-- Composite (in_stock, id) index, restricted to universal products that
-- are currently in stock.
-- Speeds up:
--   - SELECT * FROM products WHERE compatibility IS NULL OR ... AND in_stock = true

-- ================================================================
-- Index 5: idx_products_universal_search
-- ================================================================
-- GIN index on a Spanish full-text search vector built from
-- coalesce(name, '') || ' ' || coalesce(description, ''), restricted
-- to universal products.
-- Speeds up:
--   - Spanish full-text search on the universal catalog
-- Note: coalesce() is used because both name and description can be NULL.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_id
  ON products (id)
  WHERE (compatibility IS NULL OR compatibility = '[]'::jsonb OR compatibility::text = '[]');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_category
  ON products (category_id, id)
  WHERE (compatibility IS NULL OR compatibility = '[]'::jsonb OR compatibility::text = '[]');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_brand
  ON products (brand, id)
  WHERE (compatibility IS NULL OR compatibility = '[]'::jsonb OR compatibility::text = '[]')
    AND brand IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_instock
  ON products (in_stock, id)
  WHERE (compatibility IS NULL OR compatibility = '[]'::jsonb OR compatibility::text = '[]')
    AND in_stock = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_search
  ON products USING gin(to_tsvector('spanish', coalesce(name, '') || ' ' || coalesce(description, '')))
  WHERE (compatibility IS NULL OR compatibility = '[]'::jsonb OR compatibility::text = '[]');
