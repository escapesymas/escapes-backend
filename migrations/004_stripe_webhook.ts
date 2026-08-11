/**
 * Migration: 004_stripe_webhook
 * Date: 2026-08-11
 * Purpose: Stripe webhook idempotency log + retry queue tables.
 * Run:    npx tsx migrations/004_stripe_webhook.ts
 *
 * See 004_stripe_webhook.sql for the schema and rationale.
 */

import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function up(): Promise<void> {
  const sqlText = fs.readFileSync(path.join(__dirname, '004_stripe_webhook.sql'), 'utf-8');
  console.log('[MIGRATION 004] Creating stripe_webhook_events + stripe_webhook_retry_queue tables...');
  await db.execute(sql.raw(sqlText));
  console.log('[MIGRATION 004] Stripe webhook tables created successfully.');
}

up()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[MIGRATION 004] Migration failed:', err);
    process.exit(1);
  });
