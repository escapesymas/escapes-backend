-- Migration: 002_multi_supplier_test
-- Date: 2026-06-11
-- Purpose: Test multi-supplier on a small subset BEFORE full migration
-- Safety: DOES NOT DROP any existing columns. All existing data stays intact.
-- Only creates new structures for testing.

BEGIN;

-- ================================================================
-- 1. Add sku_master column (copy of existing sku, for canonical SKU)
-- ================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku_master TEXT;
UPDATE products SET sku_master = sku WHERE sku_master IS NULL;
ALTER TABLE products ALTER COLUMN sku_master SET NOT NULL;

-- ================================================================
-- 2. Add slug column (URL-friendly, unique)
-- ================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT;
UPDATE products SET slug = LOWER(REGEXP_REPLACE(sku_master, '[^a-zA-Z0-9]+', '-', 'g')) WHERE slug IS NULL;
-- Handle duplicates by appending -N
WITH dupes AS (
  SELECT id, slug, COUNT(*) OVER (PARTITION BY slug) as cnt
  FROM products WHERE slug IS NOT NULL
)
UPDATE products p SET slug = p.slug || '-' || (dupes.cnt - 1)::text
FROM dupes WHERE p.id = dupes.id AND dupes.cnt > 1;
ALTER TABLE products ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(slug);

-- ================================================================
-- 3. Add canonical columns (populated from preferred offer later)
-- These keep existing values as fallback until we migrate fully
-- ================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS canonical_price INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS canonical_sale_price INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS canonical_stock INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS canonical_stock_status VARCHAR(20);
UPDATE products SET 
  canonical_price = price, 
  canonical_sale_price = sale_price, 
  canonical_stock = stock, 
  canonical_stock_status = stock_status
WHERE canonical_price IS NULL;

-- ================================================================
-- 4. Create product_supplier_offers table
-- ================================================================
CREATE TABLE IF NOT EXISTS product_supplier_offers (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier VARCHAR(50) NOT NULL,
  supplier_sku TEXT NOT NULL,
  cost INTEGER,
  price INTEGER NOT NULL,
  sale_price INTEGER,
  stock INTEGER NOT NULL DEFAULT 0,
  stock_status VARCHAR(20) NOT NULL DEFAULT 'out_of_stock',
  lead_time_days INTEGER DEFAULT 0,
  min_order_qty INTEGER DEFAULT 1,
  is_preferred BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  raw_data JSONB,
  last_checked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(supplier, supplier_sku)
);

CREATE INDEX IF NOT EXISTS idx_offers_product ON product_supplier_offers(product_id);
CREATE INDEX IF NOT EXISTS idx_offers_supplier ON product_supplier_offers(supplier);
CREATE INDEX IF NOT EXISTS idx_offers_active ON product_supplier_offers(product_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_offers_preferred ON product_supplier_offers(product_id) WHERE is_preferred = TRUE;

-- ================================================================
-- 5. Create catalog view for TESTING
-- Shows ONE offer per product, chosen by ranking:
-- preferred > in_stock > cheapest
-- Falls back to canonical columns if no offers exist
-- ================================================================
CREATE OR REPLACE VIEW v_product_offers_test AS
SELECT 
  p.id AS product_id,
  p.sku_master,
  COALESCE(p.name, 'Sin nombre') AS name,
  p.slug,
  p.brand,
  p.description,
  p.images,
  p.weight_g, p.length_mm, p.width_mm, p.height_mm, p.volume_cm3,
  p.category_id, p.category2_id, p.category3_id,
  p.category2, p.category3,
  p.status,
  -- Fallback to canonical (existing product data)
  p.canonical_price,
  p.canonical_sale_price,
  p.canonical_stock,
  p.canonical_stock_status,
  -- Offer data (NULL if no offers yet)
  o.id AS offer_id,
  o.supplier,
  o.supplier_sku,
  o.cost,
  o.price,
  o.sale_price,
  o.stock,
  o.stock_status,
  o.lead_time_days,
  o.is_preferred,
  o.min_order_qty,
  o.raw_data,
  o.last_checked_at,
  -- Use canonical if no offer, otherwise use offer data
  -- This makes the view work even for products without offers
  COALESCE(o.stock_status, p.canonical_stock_status) AS effective_stock_status,
  COALESCE(o.stock, p.canonical_stock) AS effective_stock,
  COALESCE(o.price, p.canonical_price) AS effective_price,
  COALESCE(o.sale_price, p.canonical_sale_price) AS effective_sale_price,
  -- Ranking: preferred first, then by stock status, then by price
  ROW_NUMBER() OVER (
    PARTITION BY p.id 
    ORDER BY 
      o.is_preferred DESC NULLS LAST,
      CASE COALESCE(o.stock_status, p.canonical_stock_status) 
        WHEN 'in_stock' THEN 1 
        WHEN 'ondemand' THEN 2 
        ELSE 3 
      END,
      COALESCE(o.price, p.canonical_price) ASC NULLS LAST
  ) AS offer_rank
FROM products p
LEFT JOIN product_supplier_offers o ON o.product_id = p.id AND o.is_active = TRUE;

-- ================================================================
-- 6. Migrate ONLY the first 10 products to test (Bihr offers)
-- This tests the full flow without affecting production data
-- ================================================================
INSERT INTO product_supplier_offers (product_id, supplier, supplier_sku, cost, price, sale_price, stock, stock_status, is_preferred, is_active, raw_data, last_checked_at)
SELECT 
  id,
  'bihr',
  sku_master,
  cost,
  price,
  sale_price,
  stock,
  CASE 
    WHEN stock > 0 THEN 'in_stock' 
    WHEN ondemand = TRUE THEN 'ondemand' 
    ELSE 'out_of_stock' 
  END,
  TRUE,
  TRUE,
  jsonb_build_object(
    'barcode', barcode,
    'supplier_code', supplier_code,
    'commodity_code', commodity_code,
    'attributes', attributes,
    'compatibility', compatibility
  ),
  updated_at
FROM products
WHERE id <= 10
ON CONFLICT (supplier, supplier_sku) DO NOTHING;

-- ================================================================
-- 7. Record migration
-- ================================================================
INSERT INTO migrations (id, name) VALUES (2, '002_multi_supplier_test')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, executed_at = NOW();

COMMIT;

-- Verification queries
SELECT 'Migration 002 completed' AS status;
SELECT count(*) AS bihr_offers_migrated FROM product_supplier_offers WHERE supplier = 'bihr';
SELECT count(*) AS products_with_slugs FROM products WHERE slug IS NOT NULL;
SELECT product_id, supplier, supplier_sku, is_preferred, stock_status, price FROM product_supplier_offers LIMIT 5;
SELECT product_id, sku_master, name, slug, offer_rank, supplier, effective_stock_status, effective_price 
FROM v_product_offers_test 
WHERE offer_rank = 1 
ORDER BY product_id 
LIMIT 10;
