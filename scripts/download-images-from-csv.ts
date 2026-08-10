import 'dotenv/config';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db.js';

const DEFAULT_BATCH = 50;
const DEFAULT_CONCURRENCY = 8;
const SIZES = [800, 400, 200] as const;
const OPTIMIZED_DIR = '/app/server/uploads/optimized';
// Primary location lives inside /app/server/uploads (the Coolify persistent
// volume). Fallback is the legacy path inside the image itself.
const CSV_DIR_DEFAULT = '/app/server/uploads/catalog-csv';
const CSV_DIR_FALLBACK = '/app/server/catalog-csv';

function resolveCsvDir(): string {
  for (const dir of [CSV_DIR_DEFAULT, CSV_DIR_FALLBACK]) {
    try {
      if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.csv'))) {
        return dir;
      }
    } catch {}
  }
  return CSV_DIR_DEFAULT;
}

interface CliOptions {
  batch: number;
  concurrency: number;
  csvDir: string;
  loopAll: boolean;
}

interface ProductRow {
  id: number;
  sku: string;
  supplier_code: string;
  images: unknown;
  name: string | null;
}

interface ImageRecord {
  src: string;
  srcMobile: string;
  srcCardDesktop: string;
  srcCardMobile: string;
  alt: string;
}

/** Minimal CSV parser that handles quoted fields containing commas/newlines. */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        result.push(current);
        current = '';
      } else current += ch;
    }
  }
  result.push(current);
  return result;
}

/** Parse a CSV that may contain multi-line quoted fields. Returns array of rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        current.push(field);
        field = '';
        if (current.some((v) => v !== '')) rows.push(current);
        current = [];
      } else {
        field += ch;
      }
    }
  }
  if (field !== '' || current.length > 0) {
    current.push(field);
    if (current.some((v) => v !== '')) rows.push(current);
  }
  return rows;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  let batch = DEFAULT_BATCH;
  let concurrency = DEFAULT_CONCURRENCY;
  let csvDir = CSV_DIR_DEFAULT;
  let loopAll = false;

  for (const arg of args) {
    if (arg.startsWith('--batch=')) {
      batch = parsePositiveInteger(arg.slice('--batch='.length), '--batch');
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = parsePositiveInteger(arg.slice('--concurrency='.length), '--concurrency');
    } else if (arg.startsWith('--csv-dir=')) {
      csvDir = arg.slice('--csv-dir='.length);
    } else if (arg === '--all') {
      loopAll = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { batch, concurrency, csvDir, loopAll };
}

function sanitizeSku(sku: string | null | undefined): string {
  if (!sku) return '';
  return String(sku).replace(/[^A-Za-z0-9._-]/g, '_');
}

async function loadCatalogMap(csvDir: string): Promise<Map<string, string>> {
  const finalDir = existsSync(csvDir) && readdirSync(csvDir).some((f) => f.endsWith('.csv'))
    ? csvDir
    : resolveCsvDir();
  console.log(`[CATALOG] Reading CSVs from ${finalDir}`);
  const files = (await readdir(finalDir)).filter((f) => f.endsWith('.csv'));
  console.log(`[CATALOG] ${files.length} CSV files`);

  const map = new Map<string, string>();
  let totalRows = 0;

  for (const file of files) {
    const text = await readFile(path.join(finalDir, file), 'utf-8');
    const rows = parseCsv(text);
    if (rows.length === 0) continue;

    const header = rows[0];
    const partIdx = header.indexOf('PartNumber');
    const picIdx = header.indexOf('Picture1');
    const supplierIdx = header.indexOf('SupplierProductCode');

    if (partIdx === -1 || picIdx === -1) continue;

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const partNumber = (r[partIdx] || '').trim();
      const picture = (r[picIdx] || '').trim();
      const supplier = supplierIdx !== -1 ? (r[supplierIdx] || '').trim() : '';

      if (partNumber && picture) {
        map.set(partNumber, picture);
      }
      if (supplier && picture && !map.has(supplier)) {
        map.set(supplier, picture);
      }
      totalRows++;
    }
  }

  console.log(`[CATALOG] Processed ${totalRows} rows. Map size: ${map.size}`);
  return map;
}

async function downloadImage(imageUrl: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*',
    'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/3.0',
  };
  const response = await fetch(imageUrl, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error('Image download returned an empty response');
  return buffer;
}

async function writeVariants(image: Buffer, safeSku: string): Promise<void> {
  const variants = await Promise.all(
    SIZES.map(async (size) => ({
      size,
      data: await sharp(image)
        .resize({ width: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85, effort: 4 })
        .toBuffer(),
    })),
  );
  await mkdir(OPTIMIZED_DIR, { recursive: true });
  await Promise.all(
    variants.map(({ size, data }) =>
      writeFile(path.join(OPTIMIZED_DIR, `${safeSku}_0_${size}.webp`), data),
    ),
  );
}

function imageRecordFor(row: ProductRow, safeSku: string, originalUrl: string): ImageRecord {
  const base = `/uploads/optimized/${safeSku}_0_`;
  return {
    src: `${base}800.webp`,
    srcMobile: `${base}400.webp`,
    srcCardDesktop: `${base}400.webp`,
    srcCardMobile: `${base}200.webp`,
    alt: row.name || row.sku,
    originalUrl,
  };
}

async function processProduct(
  row: ProductRow,
  position: number,
  total: number,
  catalogMap: Map<string, string>,
): Promise<'downloaded' | 'no-image'> {
  const safeSku = sanitizeSku(row.sku);
  if (!safeSku) throw new Error('SKU is empty after sanitization');

  const imageUrl = catalogMap.get(row.sku) || catalogMap.get(row.supplier_code);
  if (!imageUrl) {
    console.log(`[${position}/${total}] Product ${row.id}: no image in catalog`);
    return 'no-image';
  }

  const image = await downloadImage(imageUrl);
  await writeVariants(image, safeSku);

  const images = [imageRecordFor(row, safeSku, imageUrl)];
  await db.execute(sql`
    UPDATE products
    SET images = ${JSON.stringify(images)}::jsonb
    WHERE id = ${row.id}
  `);

  console.log(`[${position}/${total}] Product ${row.id}: downloaded ${safeSku}_0_800.webp`);
  return 'downloaded';
}

async function updateImageRegenState(fields: {
  status?: 'idle' | 'running' | 'completed' | 'failed';
  processed?: number;
  success?: number;
  failed?: number;
  skipped?: number;
  total?: number;
  current_sku?: string;
}): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${idx++}`);
    values.push(value);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = NOW()`);
  values.push(1);
  await pool.query(`UPDATE image_regen_state SET ${sets.join(', ')} WHERE id = $${idx}`, values);
}

async function countCandidates(): Promise<number> {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS total
    FROM products
    WHERE (
      images IS NULL
      OR images::text = '[]'
    )
      AND sku IS NOT NULL AND sku <> ''
  `);
  return result.rows[0]?.total ?? 0;
}

/** Shared cumulative counters so the live dashboard reflects session totals, not per-batch. */
interface CumulativeTotals {
  processed: number;
  downloaded: number;
  skipped: number;
  errors: number;
}

async function runBatch(
  options: CliOptions,
  catalogMap: Map<string, string>,
  effectiveBatch: number,
  totals: CumulativeTotals,
): Promise<{ processed: number; downloaded: number; skipped: number; errors: number }> {
  const result = await db.execute(sql`
    SELECT id, sku, supplier_code, images, name
    FROM products
    WHERE (
      images IS NULL
      OR images::text = '[]'
    )
      AND sku IS NOT NULL AND sku <> ''
    ORDER BY id
    LIMIT ${effectiveBatch}
  `);
  const products = result.rows as unknown as ProductRow[];
  if (products.length === 0) return { processed: 0, downloaded: 0, skipped: 0, errors: 0 };

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= products.length) return;
      const product = products[index];
      let resultStatus: 'downloaded' | 'no-image' | 'failed' = 'failed';
      try {
        const status = await processProduct(product, index + 1, products.length, catalogMap);
        resultStatus = status;
        if (status === 'downloaded') totals.downloaded++;
        else totals.skipped++;
      } catch (error) {
        totals.errors++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${index + 1}/${products.length}] Product ${product.id}: failed - ${message}`);
      } finally {
        totals.processed++;
        await updateImageRegenState({
          processed: totals.processed,
          success: totals.downloaded,
          failed: totals.errors,
          skipped: totals.skipped,
          current_sku: product.sku ?? '',
        }).catch((err) => console.error('[STATE UPDATE ERROR]', err));
      }
    }
  }

  const workerCount = Math.min(options.concurrency, products.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    processed: totals.processed,
    downloaded: totals.downloaded,
    skipped: totals.skipped,
    errors: totals.errors,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `[INFO] batch=${options.batch} concurrency=${options.concurrency} csvDir=${options.csvDir} loopAll=${options.loopAll}`,
  );

  const catalogMap = await loadCatalogMap(options.csvDir);
  console.log(`[INFO] Catalog loaded. output=${OPTIMIZED_DIR}`);

  const totalCandidates = await countCandidates();
  let effectiveBatch = Math.min(options.batch, totalCandidates);

  await updateImageRegenState({
    status: 'running',
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    total: totalCandidates,
    current_sku: '',
  });

  if (effectiveBatch === 0) {
    console.log('[DONE] No products with missing images found.');
    await updateImageRegenState({ status: 'completed' });
    return;
  }

  // Cumulative counters shared with runBatch() so the live state row reflects
  // session totals (not just the current batch). Reset to 0 here so the
  // dashboard shows clean numbers from the first batch onward.
  const totals: CumulativeTotals = { processed: 0, downloaded: 0, skipped: 0, errors: 0 };
  let batchNum = 1;

  while (true) {
    const { processed, downloaded, skipped, errors } = await runBatch(
      options,
      catalogMap,
      effectiveBatch,
      totals,
    );

    console.log(
      `[BATCH ${batchNum} DONE] processed=${processed} downloaded=${downloaded} skipped=${skipped} errors=${errors}`,
    );

    if (!options.loopAll) break;

    const remaining = await countCandidates();
    console.log(`[LOOP] remaining=${remaining}`);
    if (remaining === 0) break;
    effectiveBatch = Math.min(options.batch, remaining);
    await updateImageRegenState({ status: 'running', total: remaining });
    batchNum++;
  }

  await updateImageRegenState({
    status: 'completed',
    processed: totals.processed,
    success: totals.downloaded,
    failed: totals.errors,
    skipped: totals.skipped,
    current_sku: '',
  });
  console.log(
    `[ALL DONE] batches=${batchNum} processed=${totals.processed} downloaded=${totals.downloaded} skipped=${totals.skipped} errors=${totals.errors}`,
  );
}

main()
  .catch((error) => {
    console.error('[FATAL]', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });