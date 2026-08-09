-- Migration: 003_add_universal_indexes
-- Date: 2026-08-09
-- Purpose: Add PostgreSQL indexes to speed up the /api/catalog/products?universal=true
--          query which currently takes ~27 seconds. Without these indexes, Postgres
--          performs sequential scans on the products table for every universal-filtered
--          request, which is the dominant factor in the response time.
-- Safety: Uses CREATE INDEX CONCURRENTLY so the index build does NOT lock the table
--         for writes. Each index is created with IF NOT EXISTS for idempotency.
--         IMPORTANT: CREATE INDEX CONCURRENTLY cannot be run inside a transaction
--         block, so each statement must be executed individually. Do NOT wrap
--         this file in BEGIN/COMMIT.

-- ================================================================
-- Index 1: idx_products_universal_id
-- ================================================================
-- Partial index on products.id, restricted to universal products only.
-- The partial predicate keeps the index small (only universal rows are
-- indexed), so lookups and range scans are fast.
-- Speeds up:
--   - SELECT * FROM products WHERE universal = true
--   - COUNT(*) queries that filter by universal = true
--   - Pagination (ORDER BY id LIMIT/OFFSET) on universal products
--   - Any planner decision that needs to estimate the universal subset size

-- ================================================================
-- Index 2: idx_products_universal_category
-- ================================================================
-- Composite (category_id, id) index, restricted to universal products.
-- Including id as the second key column lets Postgres skip a separate
-- sort when the query is filtered by category_id and ordered by id.
-- Speeds up:
--   - SELECT * FROM products WHERE universal = true AND category_id = X ORDER BY id
--   - Recursive category-subtree scans when universal = true
--   - Faceted counts grouped by category on the universal catalog

-- ================================================================
-- Index 3: idx_products_universal_brand
-- ================================================================
-- Composite (brand, id) index, restricted to universal products with a
-- non-null brand. The brand IS NOT NULL predicate prevents NULL entries
-- from polluting the index and keeps it compact.
-- Speeds up:
--   - SELECT * FROM products WHERE universal = true AND LOWER(brand) = LOWER(?)
--   - Brand-faceted listings on the universal catalog
--   - Brand aggregation queries on universal products

-- ================================================================
-- Index 4: idx_products_universal_instock
-- ================================================================
-- Composite (in_stock, id) index, restricted to universal products that
-- are currently in stock. The double predicate (universal = true AND
-- in_stock = true) makes this index very small and extremely fast for
-- "show me only available universal products" lookups.
-- Speeds up:
--   - SELECT * FROM products WHERE universal = true AND in_stock = true
--   - "In stock" filter on the universal catalog
--   - Inventory-aware front-page queries

-- ================================================================
-- Index 5: idx_products_universal_search
-- ================================================================
-- GIN index on a Spanish full-text search vector built from
-- coalesce(name, '') || ' ' || coalesce(description, ''), restricted
-- to universal products. GIN is the right access method for
-- tsvector @@ tsquery lookups; it replaces a sequential scan with an
-- inverted index over lexemes.
-- Speeds up:
--   - SELECT * FROM products WHERE universal = true
--       AND to_tsvector('spanish', coalesce(name,'') || ' ' || coalesce(description,''))
--           @@ plainto_tsquery('spanish', ?)
--   - Spanish full-text search on the universal catalog
--   - Search suggestions / autocomplete on universal products
-- Note: coalesce() is used because both name and description can be NULL.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_id
  ON products (id) WHERE universal = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_category
  ON products (category_id, id) WHERE universal = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_brand
  ON products (brand, id) WHERE universal = true AND brand IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_instock
  ON products (in_stock, id) WHERE universal = true AND in_stock = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_search
  ON products USING gin(to_tsvector('spanish', coalesce(name, '') || ' ' || coalesce(description, '')))
  WHERE universal = true;
