/**
 * Migration: 002_multi_supplier_test
 * Test multi-supplier on a SMALL subset (first 10 products)
 * Run: npx tsx scripts/migrate-multi-supplier-test.ts
 */

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
  max: 5,
});

async function migrate() {
  const client = await pool.connect();
  
  try {
    console.log('Starting migration 002_multi_supplier_test...');
    
    // 1. Add sku_master column
    console.log('1. Adding sku_master column...');
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sku_master TEXT`);
    await client.query(`UPDATE products SET sku_master = sku WHERE sku_master IS NULL`);
    await client.query(`ALTER TABLE products ALTER COLUMN sku_master SET NOT NULL`);
    console.log('   Done.');
    
    // 2. Add slug column
    console.log('2. Adding slug column...');
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT`);
    await client.query(`UPDATE products SET slug = LOWER(REGEXP_REPLACE(sku_master, '[^a-zA-Z0-9]+', '-', 'g')) WHERE slug IS NULL`);
    // Handle duplicates
    await client.query(`
      WITH dupes AS (
        SELECT id, slug, COUNT(*) OVER (PARTITION BY slug) as cnt
        FROM products WHERE slug IS NOT NULL
      )
      UPDATE products p SET slug = p.slug || '-' || (dupes.cnt - 1)::text
      FROM dupes WHERE p.id = dupes.id AND dupes.cnt > 1
    `);
    await client.query(`ALTER TABLE products ALTER COLUMN slug SET NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(slug)`);
    console.log('   Done.');
    
    // 3. Add canonical columns
    console.log('3. Adding canonical columns...');
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS canonical_price INTEGER`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS canonical_sale_price INTEGER`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS canonical_stock INTEGER`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS canonical_stock_status VARCHAR(20)`);
    await client.query(`
      UPDATE products SET 
        canonical_price = price, 
        canonical_sale_price = sale_price, 
        canonical_stock = stock, 
        canonical_stock_status = stock_status
      WHERE canonical_price IS NULL
    `);
    console.log('   Done.');
    
    // 4. Create product_supplier_offers table
    console.log('4. Creating product_supplier_offers table...');
    await client.query(`
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
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_product ON product_supplier_offers(product_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_supplier ON product_supplier_offers(supplier)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_active ON product_supplier_offers(product_id) WHERE is_active = TRUE`);
    console.log('   Done.');
    
    // 5. Create test view
    console.log('5. Creating v_product_offers_test view...');
    await client.query(`
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
        p.canonical_price,
        p.canonical_sale_price,
        p.canonical_stock,
        p.canonical_stock_status,
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
        COALESCE(o.stock_status, p.canonical_stock_status) AS effective_stock_status,
        COALESCE(o.stock, p.canonical_stock) AS effective_stock,
        COALESCE(o.price, p.canonical_price) AS effective_price,
        COALESCE(o.sale_price, p.canonical_sale_price) AS effective_sale_price,
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
      LEFT JOIN product_supplier_offers o ON o.product_id = p.id AND o.is_active = TRUE
    `);
    console.log('   Done.');
    
    // 6. Migrate ONLY first 10 products as test
    console.log('6. Migrating first 10 products as Bihr offers (TEST)...');
    const migrated = await client.query(`
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
      ON CONFLICT (supplier, supplier_sku) DO NOTHING
      RETURNING id
    `);
    console.log(`   Migrated ${migrated.rowCount} products.`);
    
    // Verify
    console.log('\n=== VERIFICATION ===');
    const offerCount = await client.query(`SELECT count(*) FROM product_supplier_offers`);
    console.log(`Total offers in product_supplier_offers: ${offerCount.rows[0].count}`);
    
    const viewCount = await client.query(`SELECT count(*) FROM v_product_offers_test WHERE offer_rank = 1`);
    console.log(`Products with offers (rank=1): ${viewCount.rows[0].count}`);
    
    const sample = await client.query(`
      SELECT product_id, sku_master, supplier, stock_status, effective_price, is_preferred
      FROM v_product_offers_test 
      WHERE offer_rank = 1 AND product_id <= 10
      ORDER BY product_id
      LIMIT 5
    `);
    console.log('\nSample data:');
    sample.rows.forEach(r => {
      console.log(`  ID ${r.product_id}: ${r.sku_master} | ${r.supplier} | stock=${r.stock_status} | price=${r.effective_price} | preferred=${r.is_preferred}`);
    });
    
    console.log('\n✅ Migration 002_multi_supplier_test completed successfully!');
    
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(e => { console.error(e); process.exit(1); });
