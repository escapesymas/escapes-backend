/**
 * Andreani Catalog Import - inserts 10 test products into main products table
 * Run: npx tsx scripts/andreani-test-import.ts
 *
 * Decisions:
 * - provider_id = 'andreani' to distinguish from Bihr
 * - SKU prefix: 'AND-' to avoid collisions
 * - Pricing: price = pvp * 1.30, cost = pvp (30% margin)
 * - stock_status = 'ondemand', ondemand = true (no real stock)
 * - status = 'active' so visible on website
 */

import 'dotenv/config';
import pg from 'pg';
import { execSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
  max: 5,
});

interface AndreaniProduct {
  referencia: string;
  nombre: string;
  barcode: string;
  tarifeCode: string;
  pvpEur: number;
  family: string;
  subfamily: string;
  descripcion: string;
  image: string;
  gallery: string;
  documents: string;
  talla: string;
  alturaMm: number | null;
  recorridoMm: number | null;
  longitudMm: number | null;
}

function parseExcel(filePath: string, limit = 10): AndreaniProduct[] {
  const result = execSync(
    `python3 "${path.resolve(__dirname)}/parse_andreani_excel.py" "${filePath}" ${limit}`,
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(result.toString());
}

async function importProducts(client: pg.PoolClient, products: AndreaniProduct[]) {
  console.log(`Importing ${products.length} products into products table...`);

  const MARGIN = 1.30; // 30% margin

  for (const p of products) {
    const sku = `AND-${p.referencia}`.substring(0, 100);
    const skuMaster = sku;

    // Parse images array
    const images: { src: string; alt: string }[] = [];
    if (p.image) images.push({ src: p.image, alt: p.nombre });
    if (p.gallery) {
      p.gallery.split(',').map((u: string) => u.trim()).filter(Boolean).slice(0, 5).forEach((url: string) => {
        if (url !== p.image) images.push({ src: url, alt: p.nombre });
      });
    }

    // Build attributes JSONB
    const attrs: Record<string, unknown> = {};
    if (p.talla) attrs['Talla'] = p.talla;
    if (p.alturaMm) attrs['Altura_mm'] = p.alturaMm;
    if (p.recorridoMm) attrs['Recorrido_mm'] = p.recorridoMm;
    if (p.longitudMm) attrs['Longitud_mm'] = p.longitudMm;
    if (p.tarifeCode) attrs['TarifeCode'] = p.tarifeCode;
    if (p.documents) attrs['Documents'] = p.documents;

    // Pricing: cost = pvp, price = pvp * margin
    const cost = p.pvpEur; // cents
    const price = Math.round(p.pvpEur * MARGIN); // cents

    // Brand: use family or fallback
    const brand = p.family || 'Andreani MHS';

    // Category2: Andreani family grouping
    const category2 = 'Andreani MHS';
    const category3 = p.subfamily || p.family || '';

    const result = await client.query(`
      INSERT INTO products (
        sku, sku_master, provider_id, name, description,
        price, sale_price, cost, stock, stock_status,
        ondemand, status, brand,
        barcode, commodity_code,
        images, attributes,
        category2, category3,
        type, dropshipping,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW(), NOW())
      ON CONFLICT (sku) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        price = EXCLUDED.price,
        sale_price = EXCLUDED.sale_price,
        cost = EXCLUDED.cost,
        images = EXCLUDED.images,
        attributes = EXCLUDED.attributes,
        updated_at = NOW()
      RETURNING id, sku
    `, [
      sku,
      skuMaster,
      'andreani',
      p.nombre.substring(0, 255),
      p.descripcion ? p.descripcion.substring(0, 5000) : null,
      price,
      null, // sale_price
      cost,
      0, // stock
      'ondemand',
      true, // ondemand
      'active', // status
      brand.substring(0, 255),
      p.barcode || null,
      p.tarifeCode || null,
      JSON.stringify(images),
      JSON.stringify(attrs),
      category2,
      category3,
      'simple',
      false, // dropshipping
    ]);

    console.log(`  [${sku}] ${p.nombre.substring(0, 40)} | pvp=${p.pvpEur/100}€ → price=${(price/100).toFixed(2)}€ (+${((MARGIN-1)*100).toFixed(0)}%)`);
  }
}

async function verify(client: pg.PoolClient) {
  console.log('\n=== VERIFICATION ===');
  const count = await client.query(`SELECT count(*) FROM products WHERE provider_id = 'andreani'`);
  console.log(`Andreani products in DB: ${count.rows[0].count}`);

  const sample = await client.query(`
    SELECT sku, name, brand, price, cost, stock, stock_status, ondemand, status
    FROM products
    WHERE provider_id = 'andreani'
    ORDER BY id
    LIMIT 5
  `);

  console.log('\nSample products:');
  sample.rows.forEach((r: any) => {
    console.log(`  [${r.sku}] ${r.name.substring(0, 35)}`);
    console.log(`    price=${r.price/100}€ cost=${r.cost/100}€ stock=${r.stock} status=${r.stock_status} ondemand=${r.ondemand} site_status=${r.status}`);
  });
}

async function main() {
  const client = await pool.connect();
  try {
    const excelPath = '/tmp/andreani-capture/megatarifas-excel-1781159915299.xlsx';
    if (!fs.existsSync(excelPath)) {
      console.error('Excel not found. Run Andreani login + download first.');
      process.exit(1);
    }

    const products = parseExcel(excelPath, 10);
    console.log(`Parsed ${products.length} products.`);
    await importProducts(client, products);
    await verify(client);
    console.log('\n✅ Done! Products should now appear on the website.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
