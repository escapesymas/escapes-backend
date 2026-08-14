/**
 * Migration: 006_fix_instock_index
 * Date: 2026-08-14
 * Purpose: Index on (stock, id) WHERE stock > 0 for universal catalog queries.
 * Run:    npx tsx migrations/006_fix_instock_index.ts
 */

import { pool } from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function up(): Promise<void> {
  const sqlText = fs.readFileSync(path.join(__dirname, '006_fix_instock_index.sql'), 'utf-8');
  console.log('[MIGRATION 006] Creating idx_products_universal_stock_gt_zero index...');
  const client = await pool.connect();
  try {
    await client.query(sqlText);
    console.log('[MIGRATION 006] Index created successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

up()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[MIGRATION 006] Migration failed:', err);
    process.exit(1);
  });
