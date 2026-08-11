/**
 * Migration: 005_email_queue
 * Date: 2026-08-11
 * Purpose: Persistent email send queue + open tracking tables.
 * Run:    npx tsx migrations/005_email_queue.ts
 *
 * See 005_email_queue.sql for the schema and rationale.
 */

import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function up(): Promise<void> {
  const sqlText = fs.readFileSync(path.join(__dirname, '005_email_queue.sql'), 'utf-8');
  console.log('[MIGRATION 005] Creating email_send_queue + email_open_tracking tables...');
  await db.execute(sql.raw(sqlText));
  console.log('[MIGRATION 005] Email queue tables created successfully.');
}

up()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[MIGRATION 005] Migration failed:', err);
    process.exit(1);
  });
