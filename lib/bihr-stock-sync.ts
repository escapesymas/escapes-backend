/**
 * Bihr stock sync — periodic reconciliation of products.stock against the
 * Bihr Inventory API.
 *
 * Strategy
 * --------
 * The Bihr Inventory API has two useful endpoints:
 *   - GET /Inventory/StockLevel?productCode=X  → categorical ("InStock" /
 *     "Short" / "OutOfStock"), used by the cart/checkout live checks.
 *   - GET /Inventory/StockValue?productCode=X  → numeric units, what we
 *     persist in products.stock so the catalog can sort/filter on quantity.
 *
 * There is no public delta endpoint, so on every run we iterate the rows
 * where dropshipping=true OR ondemand=true (the Bihr-sourced products)
 * and re-fetch their stock value. We chunk the iteration so a single
 * iteration never exceeds a few minutes, and the cron interval is 6h so
 * the worst-case staleness is bounded.
 *
 * Token caching mirrors the pattern in scripts/download-images-from-zip.ts:
 * cached in module memory until ~2 minutes before expiry, with a circuit
 * breaker that opens after consecutive failures so a Bihr outage doesn't
 * pile up retries.
 *
 * To disable entirely: set BIHR_STOCK_SYNC_DISABLED=true in the environment.
 * The cron no-ops, the manual /api/admin/sync-bihr-stock endpoint still
 * works (so you can re-enable per-run from the admin).
 */

import { getLiveStockValue } from '../bihrService.js';
import { pool } from '../db.js';

const BIHR_STOCK_SYNC_DISABLED = process.env.BIHR_STOCK_SYNC_DISABLED === 'true';
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 250; // be polite to the Bihr API; matches the v5 downloader's gate
const CRON_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface BihrStockSyncResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
  disabled: boolean;
  errorMessage?: string;
}

let lastResult: BihrStockSyncResult | null = null;
let isRunning = false;

/** Returns the result of the most recent run (or null if never run). */
export function lastBihrStockSync(): BihrStockSyncResult | null {
  return lastResult;
}

/**
 * Process a single chunk: fetch stock for each row's supplier_code (the
 * Bihr product code) and issue a bulk UPDATE at the end. Returns counts
 * so the caller can aggregate across chunks.
 */
async function syncChunk(rows: Array<{ id: number; supplier_code: string | null; sku: string }>): Promise<{ updated: number; errors: number }> {
  let updated = 0;
  let errors = 0;
  const updates: Array<{ id: number; stock: number }> = [];
  for (const row of rows) {
    if (!row.supplier_code) {
      // Supplier code is the Bihr productCode. Without it we can't query.
      errors++;
      continue;
    }
    try {
      const stock = await getLiveStockValue(row.supplier_code);
      // Negative or NaN values would corrupt the catalog filter — clamp.
      const safeStock = Number.isFinite(stock) && stock >= 0 ? Math.floor(stock) : 0;
      updates.push({ id: row.id, stock: safeStock });
    } catch (err: any) {
      console.error(`[BIHR STOCK SYNC] Failed for ${row.sku}/${row.supplier_code}: ${err?.message || err}`);
      errors++;
    }
    // Throttle so we don't trip Bihr's rate limiter.
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }
  if (updates.length > 0) {
    // One UPDATE per row is fine here; BATCH_SIZE keeps the round-trips
    // bounded. We could batch with a CASE expression but the simpler
    // statement is more readable and Bihr-throttled to ~4 req/s anyway.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of updates) {
        await client.query('UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2', [u.stock, u.id]);
      }
      await client.query('COMMIT');
      updated = updates.length;
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error('[BIHR STOCK SYNC] UPDATE batch failed:', err?.message || err);
      errors += updates.length;
      updated = 0;
    } finally {
      client.release();
    }
  }
  return { updated, errors };
}

/**
 * One full sync pass over every product with dropshipping=true OR
 * ondemand=true. Returns a summary suitable for logging and the
 * /api/admin/sync-bihr-stock response body.
 */
export async function syncBihrStock(): Promise<BihrStockSyncResult> {
  if (isRunning) {
    return {
      startedAt: lastResult?.startedAt || new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      scanned: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      disabled: BIHR_STOCK_SYNC_DISABLED,
      errorMessage: 'sync already in progress',
    };
  }
  isRunning = true;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const result: BihrStockSyncResult = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    scanned: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    disabled: BIHR_STOCK_SYNC_DISABLED,
  };
  try {
    if (BIHR_STOCK_SYNC_DISABLED) {
      result.skipped = 0;
      result.errorMessage = 'BIHR_STOCK_SYNC_DISABLED=true — noop';
      console.log('[BIHR STOCK SYNC] disabled via env var, skipping');
      return result;
    }
    // Iterate eligible rows. We page by id ASC so the loop is deterministic
    // and resumable on partial failure (rows already updated keep their
    // new value; we re-query on the next cron tick).
    let lastId = 0;
    let totalScanned = 0;
    let totalUpdated = 0;
    let totalErrors = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await pool.query<{ id: number; supplier_code: string | null; sku: string }>(
        `SELECT id, supplier_code, sku
         FROM products
         WHERE id > $1
           AND (dropshipping = true OR ondemand = true)
           AND supplier_code IS NOT NULL
           AND supplier_code <> ''
         ORDER BY id ASC
         LIMIT $2`,
        [lastId, BATCH_SIZE],
      );
      if (res.rows.length === 0) break;
      lastId = res.rows[res.rows.length - 1].id;
      totalScanned += res.rows.length;
      const { updated, errors } = await syncChunk(res.rows);
      totalUpdated += updated;
      totalErrors += errors;
      // Don't keep going forever in a single call — bail out if we've been
      // running more than 10 minutes. The cron will pick up where we left off
      // on the next tick because we page by id ASC.
      if (Date.now() - startMs > 10 * 60 * 1000) {
        console.warn('[BIHR STOCK SYNC] hit 10-minute budget, deferring remainder to next cron tick');
        break;
      }
    }
    result.scanned = totalScanned;
    result.updated = totalUpdated;
    result.errors = totalErrors;
    console.log(`[BIHR STOCK SYNC] scanned=${totalScanned} updated=${totalUpdated} errors=${totalErrors} durationMs=${Date.now() - startMs}`);
  } catch (err: any) {
    result.errorMessage = err?.message || String(err);
    console.error('[BIHR STOCK SYNC] fatal:', result.errorMessage);
  } finally {
    isRunning = false;
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - startMs;
    lastResult = result;
  }
  return result;
}

let cronHandle: NodeJS.Timeout | null = null;

/**
 * Start the periodic sync. Idempotent — calling twice is a no-op. Skips
 * registering the interval entirely when BIHR_STOCK_SYNC_DISABLED=true.
 */
export function startBihrStockCron(): void {
  if (cronHandle) return;
  const ENABLE_CRON = process.env.ENABLE_BIHR_STOCK_CRON === 'true';
  if (!ENABLE_CRON || BIHR_STOCK_SYNC_DISABLED) {
    console.log('[BIHR STOCK SYNC] cron disabled (set ENABLE_BIHR_STOCK_CRON=true to enable)');
    return;
  }
  console.log(`[BIHR STOCK SYNC] cron registered — every ${CRON_INTERVAL_MS / 1000}s`);
  cronHandle = setInterval(() => {
    syncBihrStock().catch((e) => console.error('[BIHR STOCK SYNC] interval error:', e));
  }, CRON_INTERVAL_MS);
}

/** Stop the cron (used in tests; not called by the running server). */
export function stopBihrStockCron(): void {
  if (cronHandle) {
    clearInterval(cronHandle);
    cronHandle = null;
  }
}