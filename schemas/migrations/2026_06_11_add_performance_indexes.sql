-- Migration: Add critical performance indexes
-- Date: 2026-06-11
-- Author: opencode
-- Description: Indexes based on actual query patterns in index.js
--              focused on high-impact foreign key and filter columns

BEGIN;

-- orders.user_id: used in WHERE user_id = X and JOINs (19k seq_scan vs 0 idx_scan)
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);

-- order_items.order_id: used in COGS/analytics JOINs (13k seq_scan vs 0 idx_scan)
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- order_items.product_id: used in WHERE product_id = X for product lookups
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);

-- orders.status: used in WHERE status NOT IN ('cancelled','refunded') for analytics
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- orders.created_at: used in date range queries for analytics
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

-- carts.user_id: used in WHERE user_id = X (8053 seq_scan vs 0 idx_scan)
CREATE INDEX IF NOT EXISTS idx_carts_user_id ON carts(user_id);

COMMIT;