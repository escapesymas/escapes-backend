/**
 * Migration: 003_add_universal_indexes
 * Date: 2026-08-09
 * Purpose: Add PostgreSQL indexes to speed up the /api/catalog/products?universal=true
 *          query which currently takes ~27 seconds.
 *
 * Each index is a partial / GIN index that targets the dominant filter
 * columns (universal, category_id, brand, in_stock) and the full-text
 * search vector on (name, description) for the universal subset.
 *
 * Run: npx tsx migrations/003_add_universal_indexes.ts
 *
 * IMPORTANT: CREATE INDEX CONCURRENTLY cannot be run inside a transaction
 * block. This script executes each DDL statement individually so the
 * statements run in autocommit mode and the index build does not lock
 * the products table for writes.
 */

import { db } from '../db.js';
import { sql } from 'drizzle-orm';

interface IndexSpec {
  name: string;
  description: string;
  statement: string;
}

const indexes: IndexSpec[] = [
  {
    name: 'idx_products_universal_id',
    description: 'Partial index on id for universal products (lookups, COUNT, pagination).',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_id
      ON products (id) WHERE universal = true`,
  },
  {
    name: 'idx_products_universal_category',
    description: 'Composite (category_id, id) for category-filtered universal queries.',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_category
      ON products (category_id, id) WHERE universal = true`,
  },
  {
    name: 'idx_products_universal_brand',
    description: 'Composite (brand, id) for brand-filtered universal queries (NULL brand excluded).',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_brand
      ON products (brand, id) WHERE universal = true AND brand IS NOT NULL`,
  },
  {
    name: 'idx_products_universal_instock',
    description: 'Composite (in_stock, id) for in-stock-filtered universal queries.',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_instock
      ON products (in_stock, id) WHERE universal = true AND in_stock = true`,
  },
  {
    name: 'idx_products_universal_search',
    description: 'GIN full-text search index (Spanish) on name + description for universal products.',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_universal_search
      ON products USING gin(to_tsvector('spanish', coalesce(name, '') || ' ' || coalesce(description, '')))
      WHERE universal = true`,
  },
];

async function up(): Promise<void> {
  console.log(`[MIGRATION 003] Adding ${indexes.length} universal products indexes (CONCURRENTLY, no table lock)...`);

  for (const [i, idx] of indexes.entries()) {
    const step = i + 1;
    console.log(`[MIGRATION 003] (${step}/${indexes.length}) ${idx.name} - ${idx.description}`);
    try {
      // Each statement is executed individually so it runs in its own
      // implicit transaction. This is required for CREATE INDEX CONCURRENTLY.
      await db.execute(sql.raw(idx.statement));
      console.log(`[MIGRATION 003] (${step}/${indexes.length}) ${idx.name} done.`);
    } catch (error) {
      console.error(`[MIGRATION 003] (${step}/${indexes.length}) ${idx.name} failed:`, error);
      throw error;
    }
  }

  console.log('[MIGRATION 003] All indexes created successfully.');
}

up()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[MIGRATION 003] Migration failed:', err);
    process.exit(1);
  });
