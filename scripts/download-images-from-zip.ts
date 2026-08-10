import 'dotenv/config';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db.js';

const DEFAULT_BATCH = 50;
const DEFAULT_CONCURRENCY = 4;
const SIZES = [800, 400, 200] as const;
const OPTIMIZED_DIR = '/app/server/uploads/optimized';
const CSV_DIR_DEFAULT = '/app/server/uploads/catalog-csv';
const CSV_DIR_FALLBACK = '/app/server/catalog-csv';
const ZIP_BASE = 'https://static.bihr.pro/eBihr/Pictures';
const ZIP_INDEX_CACHE = '/app/server/uploads/bihr-zip-index.json'; // { brand → { totalSize, cdOffset, cdSize, files: [{name, offset, compSize}] } }

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
  originalUrl: string;
}

interface ZipEntry {
  name: string;
  offset: number;
  compSize: number;
  uncompSize: number;
}

interface BrandIndex {
  brand: string;
  totalSize: number;
  files: ZipEntry[];
}

function resolveCsvDir(): string {
  for (const dir of [CSV_DIR_DEFAULT, CSV_DIR_FALLBACK]) {
    try {
      if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.csv'))) return dir;
    } catch {}
  }
  return CSV_DIR_DEFAULT;
}

function parseArgs(args: string[]): CliOptions {
  let batch = DEFAULT_BATCH;
  let concurrency = DEFAULT_CONCURRENCY;
  let csvDir = CSV_DIR_DEFAULT;
  let loopAll = false;
  for (const arg of args) {
    if (arg.startsWith('--batch=')) batch = parseInt(arg.slice(8), 10);
    else if (arg.startsWith('--concurrency=')) concurrency = parseInt(arg.slice(14), 10);
    else if (arg.startsWith('--csv-dir=')) csvDir = arg.slice(10);
    else if (arg === '--all') loopAll = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (batch <= 0 || concurrency <= 0) throw new Error('batch and concurrency must be positive');
  return { batch, concurrency, csvDir, loopAll };
}

function sanitizeSku(sku: string | null | undefined): string {
  if (!sku) return '';
  return String(sku).replace(/[^A-Za-z0-9._-]/g, '_');
}

function brandFromCsvFilename(filename: string): string {
  // cat-extended-full-ES01-ES001-es-2026_08_09_00_15_02_<BRAND>.csv
  // The year is preceded by '-' (e.g. 'es-2026'), not '_'. Match the timestamp
  // block without requiring a leading underscore.
  const stem = filename.replace(/\.csv$/, '');
  const m = stem.match(/(?:^|[^_\d])(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(.+)$/);
  return m ? m[7] : stem;
}

// Self-log to /app/server/uploads/image-dl-v5-self.log — bypasses the parent's
// pipe tee which can drop output if the parent process restarts.
const SELF_LOG = '/app/server/uploads/image-dl-v5-self.log';
function selfLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    require('node:fs').appendFileSync(SELF_LOG, line);
  } catch {}
  // Also keep stdout for parent pipe
  console.log(msg);
}

/** Build sku → image URL map, sku → brand (for the zip), and
 *  any-key → CSV PartNumber (Bihr's internal SKU, used in zip filenames).
 *  The products table stores our internal `sku` and the human-readable
 *  `supplier_code`, neither of which match the zip filenames; only the
 *  CSV's PartNumber does. We index by all three so the downloader can
 *  resolve any product to the right zip entry. */
async function loadCatalogMap(csvDir: string): Promise<{
  urlMap: Map<string, { url: string; brand: string }>;
  skuMap: Map<string, { brand: string }>;
  partMap: Map<string, { brand: string; partNumber: string }>;
}> {
  const finalDir = existsSync(csvDir) && readdirSync(csvDir).some((f) => f.endsWith('.csv'))
    ? csvDir : resolveCsvDir();
  console.log(`[CATALOG] Reading CSVs from ${finalDir}`);
  const files = (await readdir(finalDir)).filter((f) => f.endsWith('.csv'));
  console.log(`[CATALOG] ${files.length} CSV files`);

  const urlMap = new Map<string, { url: string; brand: string }>();
  const skuMap = new Map<string, { brand: string }>();
  const partMap = new Map<string, { brand: string; partNumber: string }>();

  // Simple per-line parser that handles quoted fields with commas/newlines.
  const parseCsv = (text: string): string[][] => {
    const rows: string[][] = [];
    let current: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else field += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { current.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          current.push(field); field = '';
          if (current.some((v) => v !== '')) rows.push(current);
          current = [];
        } else field += ch;
      }
    }
    if (field !== '' || current.length > 0) {
      current.push(field);
      if (current.some((v) => v !== '')) rows.push(current);
    }
    return rows;
  };

  for (const file of files) {
    const brand = brandFromCsvFilename(file);
    const text = await (await import('node:fs/promises')).readFile(path.join(finalDir, file), 'utf-8');
    const rows = parseCsv(text);
    if (rows.length < 2) continue;
    const header = rows[0];
    const partIdx = header.indexOf('PartNumber');
    const picIdx = header.indexOf('Picture1');
    const supIdx = header.indexOf('SupplierProductCode');
    const oldIdx = header.indexOf('OldPartNumber');
    if (partIdx === -1 || picIdx === -1) continue;

    let rowsAdded = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const part = (r[partIdx] || '').trim();
      const pic = (r[picIdx] || '').trim();
      const sup = supIdx !== -1 ? (r[supIdx] || '').trim() : '';
      const old = oldIdx !== -1 ? (r[oldIdx] || '').trim() : '';
      if (part && pic && !urlMap.has(part)) {
        urlMap.set(part, { url: pic, brand });
        skuMap.set(part, { brand });
        partMap.set(part, { brand, partNumber: part });
        rowsAdded++;
      }
      // Index by every alias we know about so product lookup (by sku or
      // supplier_code) resolves to the CSV's PartNumber (zip filename stem).
      for (const alias of [sup, old]) {
        if (alias && pic && !urlMap.has(alias)) {
          urlMap.set(alias, { url: pic, brand });
        }
        if (alias) {
          skuMap.set(alias, { brand });
          partMap.set(alias, { brand, partNumber: part });
        }
      }
    }
  }

  console.log(`[CATALOG] urlMap size: ${urlMap.size}, skuMap size: ${skuMap.size}, partMap size: ${partMap.size}`);
  return { urlMap, skuMap, partMap };
}

/** Read index from disk cache, or build it. */
async function loadBrandIndex(brand: string): Promise<BrandIndex> {
  let cache: Record<string, BrandIndex> = {};
  if (existsSync(ZIP_INDEX_CACHE)) {
    try {
      cache = JSON.parse(await (await import('node:fs/promises')).readFile(ZIP_INDEX_CACHE, 'utf-8'));
    } catch {}
  }
  if (cache[brand] && cache[brand].files.length > 0) {
    return cache[brand];
  }

  console.log(`[ZIP] Building index for brand ${brand}...`);
  const zipUrl = `${ZIP_BASE}/${encodeURIComponent(brand)}-pictures.zip`;
  // First fetch the last 64KB to find EOCD
  const tailResp = await fetch(zipUrl, {
    headers: {
      'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
      Range: 'bytes=-65536',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!tailResp.ok && tailResp.status !== 206) {
    throw new Error(`Failed to fetch zip tail for ${brand}: HTTP ${tailResp.status}`);
  }
  const tail = Buffer.from(await tailResp.arrayBuffer());
  const eocdIdx = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdIdx < 0) throw new Error(`EOCD not found in tail of ${brand} zip`);
  // EOCD: 4 sig + 2 disk + 2 cd_disk + 2 entries_disk + 2 entries_total + 4 cd_size + 4 cd_offset + 2 comment_len
  const cdEntries = tail.readUInt16LE(eocdIdx + 10);
  const cdSize = tail.readUInt32LE(eocdIdx + 12);
  const cdOffset = tail.readUInt32LE(eocdIdx + 16);
  // Total size = cdOffset + cdSize (assuming no zip64)
  const totalSize = cdOffset + cdSize;

  // Fetch the central directory
  const cdResp = await fetch(zipUrl, {
    headers: {
      'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
      Range: `bytes=${cdOffset}-${totalSize - 1}`,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!cdResp.ok && cdResp.status !== 206) {
    throw new Error(`Failed to fetch central directory: HTTP ${cdResp.status}`);
  }
  const cd = Buffer.from(await cdResp.arrayBuffer());

  const files: ZipEntry[] = [];
  let i = 0;
  while (i < cd.length - 46 && files.length < cdEntries) {
    if (cd.readUInt32LE(i) !== 0x02014b50) {
      // Find next PK\x01\x02
      const next = cd.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i + 1);
      if (next < 0) break;
      i = next;
      continue;
    }
    const compSize = cd.readUInt32LE(i + 20);
    const uncompSize = cd.readUInt32LE(i + 24);
    const fnameLen = cd.readUInt16LE(i + 28);
    const extraLen = cd.readUInt16LE(i + 30);
    const commentLen = cd.readUInt16LE(i + 32);
    const localOffset = cd.readUInt32LE(i + 42);
    const name = cd.toString('utf-8', i + 46, i + 46 + fnameLen);
    files.push({ name, offset: localOffset, compSize, uncompSize });
    i += 46 + fnameLen + extraLen + commentLen;
  }

  cache[brand] = { brand, totalSize, files };
  await writeFile(ZIP_INDEX_CACHE, JSON.stringify(cache));
  console.log(`[ZIP] Brand ${brand}: ${files.length} files indexed`);
  return cache[brand];
}

async function fetchImageFromZip(brand: string, sku: string, index: BrandIndex): Promise<Buffer | null> {
  // Find <sku>-N.jpg files (prefer -1)
  const matches = index.files.filter((f) => f.name.startsWith(`${sku}-`) && f.name.endsWith('.jpg'));
  if (matches.length === 0) return null;
  // Sort to prefer -1, then -2, etc.
  matches.sort((a, b) => {
    const aNum = parseInt(a.name.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
    const bNum = parseInt(b.name.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
    return aNum - bNum;
  });
  const entry = matches[0];

  const zipUrl = `${ZIP_BASE}/${encodeURIComponent(brand)}-pictures.zip`;
  // Fetch local file header (30 bytes) + filename + extra + compressed data
  // Start 50 bytes before the local offset to handle header variations
  const startByte = Math.max(0, entry.offset - 50);
  const endByte = entry.offset + 30 + 256 + entry.compSize; // 256 = max filename+extra
  const rangeResp = await fetch(zipUrl, {
    headers: {
      'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
      Range: `bytes=${startByte}-${endByte}`,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!rangeResp.ok && rangeResp.status !== 206) {
    throw new Error(`Range fetch failed: HTTP ${rangeResp.status}`);
  }
  const buf = Buffer.from(await rangeResp.arrayBuffer());
  if (rangeResp.status !== 206) {
    throw new Error(`Range request ignored: got HTTP ${rangeResp.status} (expected 206 Partial Content). Response size=${buf.length}, expected=${endByte - startByte + 1}`);
  }
  // Local file header should be at offset (entry.offset - startByte) since we asked for that range.
  const expectedLfhOffset = entry.offset - startByte;
  const PK_0304 = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let lfhIdx = buf.indexOf(PK_0304, expectedLfhOffset);
  if (lfhIdx < 0) {
    // Fall back to anywhere in buffer (server may have shifted us)
    lfhIdx = buf.indexOf(PK_0304);
  }
  if (lfhIdx < 0) throw new Error('Local file header not found in response');
  // LFH: 4 sig + 2 ver + 2 flags + 2 compression + 2 mod_time + 2 mod_date + 4 crc + 4 comp + 4 uncomp + 2 fname_len + 2 extra_len = 30
  const method = buf.readUInt16LE(lfhIdx + 8);     // 0=stored, 8=deflate
  const fnameLen = buf.readUInt16LE(lfhIdx + 26);
  const extraLen = buf.readUInt16LE(lfhIdx + 28);
  const actualCompSize = buf.readUInt32LE(lfhIdx + 18);
  const actualUncompSize = buf.readUInt32LE(lfhIdx + 22);
  const dataStart = lfhIdx + 30 + fnameLen + extraLen;

  // For method=0 (stored) the data is uncompressed, so actualCompSize == actualUncompSize
  // and we just return the bytes directly.
  if (method === 0) {
    if (buf.length >= dataStart + actualCompSize) {
      return buf.subarray(dataStart, dataStart + actualCompSize);
    }
    // Re-fetch exact bytes
    const newResp = await fetch(zipUrl, {
      headers: {
        'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
        Range: `bytes=${entry.offset + 30 + fnameLen + extraLen}-${entry.offset + 30 + fnameLen + extraLen + actualCompSize - 1}`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!newResp.ok && newResp.status !== 206) throw new Error(`Re-fetch failed: HTTP ${newResp.status}`);
    return Buffer.from(await newResp.arrayBuffer());
  }

  // method=8 (deflate) — raw deflate in zip, so use inflateRawSync (NOT inflateSync
  // which expects the 2-byte zlib header + adler32 checksum).
  if (buf.length < dataStart + actualCompSize) {
    const newEnd = entry.offset + 30 + fnameLen + extraLen + actualCompSize - 1;
    const newResp = await fetch(zipUrl, {
      headers: {
        'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
        Range: `bytes=${entry.offset + 30 + fnameLen + extraLen}-${newEnd}`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!newResp.ok && newResp.status !== 206) throw new Error(`Re-fetch failed: HTTP ${newResp.status}`);
    const compressed = Buffer.from(await newResp.arrayBuffer());
    return zlib.inflateRawSync(compressed);
  }
  const compressed = buf.subarray(dataStart, dataStart + actualCompSize);
  try {
    return zlib.inflateRawSync(compressed);
  } catch (inflateErr: any) {
    const detail = {
      brand,
      sku,
      method,
      actualCompSize,
      actualUncompSize,
      bufLen: buf.length,
      dataStart,
      first16: compressed.subarray(0, Math.min(16, compressed.length)).toString('hex'),
      last16: compressed.subarray(Math.max(0, compressed.length - 16)).toString('hex'),
      status: rangeResp.status,
    };
    selfLog(`INFLATE FAIL: ${JSON.stringify(detail)}`);
    throw new Error(`inflate failed (${inflateErr.message}): ${JSON.stringify(detail)}`);
  }
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

// Brands whose zip returned 404 (or otherwise unreachable) — once a brand is
// known-bad, we skip the fetch and mark every product of that brand with a
// placeholder so the loop doesn't re-pick them. Persisted to disk so we don't
// re-fetch across restarts.
const FAILED_BRANDS_FILE = '/app/server/uploads/bihr-failed-brands.json';
const failedBrands: Set<string> = new Set();

async function loadFailedBrands(): Promise<void> {
  try {
    if (existsSync(FAILED_BRANDS_FILE)) {
      const raw = await (await import('node:fs/promises')).readFile(FAILED_BRANDS_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const b of list) failedBrands.add(b);
      }
    }
  } catch {}
}

async function saveFailedBrands(): Promise<void> {
  try {
    const arr: string[] = [];
    failedBrands.forEach((b) => arr.push(b));
    arr.sort();
    await (await import('node:fs/promises')).writeFile(
      FAILED_BRANDS_FILE,
      JSON.stringify(arr),
    );
  } catch {}
}

async function processProduct(
  row: ProductRow,
  position: number,
  total: number,
  skuMap: Map<string, { brand: string }>,
  partMap: Map<string, { brand: string; partNumber: string }>,
): Promise<'downloaded' | 'no-image'> {
  const safeSku = sanitizeSku(row.sku);
  if (!safeSku) throw new Error('SKU empty');
  const entry = skuMap.get(row.sku) || skuMap.get(row.supplier_code);
  if (!entry) {
    console.log(`[${position}/${total}] Product ${row.id}: no brand mapping`);
    // Mark with a placeholder so this product isn't re-picked on next iteration.
    await db.execute(sql`
      UPDATE products
      SET images = ${JSON.stringify([{ src: '', originalUrl: 'no-image:no-brand-mapping', alt: row.name || row.sku || '' }])}::jsonb
      WHERE id = ${row.id}
    `);
    return 'no-image';
  }
  // Look up the CSV's PartNumber — that's the stem used in the zip filenames,
  // not the product's internal sku or supplier_code.
  const partEntry = partMap.get(row.sku) || partMap.get(row.supplier_code);
  const partNumber = partEntry?.partNumber || row.supplier_code || row.sku;
  if (failedBrands.has(entry.brand)) {
    console.log(`[${position}/${total}] Product ${row.id}: skip brand ${entry.brand} (known bad)`);
    await db.execute(sql`
      UPDATE products
      SET images = ${JSON.stringify([{ src: '', originalUrl: `no-image:brand-${entry.brand}-no-zip`, alt: row.name || row.sku || '' }])}::jsonb
      WHERE id = ${row.id}
    `);
    return 'no-image';
  }
  let index: BrandIndex;
  try {
    index = await loadBrandIndex(entry.brand);
  } catch (err: any) {
    // Remember the brand as failed (write to disk) so we don't re-fetch
    // its (likely 404) zip for every product of that brand.
    failedBrands.add(entry.brand);
    await saveFailedBrands();
    selfLog(`BRAND-FAIL ${entry.brand}: ${err?.message || err}`);
    console.error(`[${position}/${total}] Product ${row.id}: brand ${entry.brand} marked as failed - ${err?.message || err}`);
    await db.execute(sql`
      UPDATE products
      SET images = ${JSON.stringify([{ src: '', originalUrl: `no-image:brand-${entry.brand}-no-zip`, alt: row.name || row.sku || '' }])}::jsonb
      WHERE id = ${row.id}
    `);
    return 'no-image';
  }
  const image = await fetchImageFromZip(entry.brand, partNumber, index);
  if (!image) {
    console.log(`[${position}/${total}] Product ${row.id}: not in ${entry.brand} zip`);
    await db.execute(sql`
      UPDATE products
      SET images = ${JSON.stringify([{ src: '', originalUrl: `no-image:not-in-${entry.brand}-zip`, alt: row.name || row.sku || '' }])}::jsonb
      WHERE id = ${row.id}
    `);
    return 'no-image';
  }
  await writeVariants(image, safeSku);
  const images = [imageRecordFor(row, safeSku, `zip:${entry.brand}`)];
  await db.execute(sql`
    UPDATE products
    SET images = ${JSON.stringify(images)}::jsonb
    WHERE id = ${row.id}
  `);
  console.log(`[${position}/${total}] Product ${row.id}: downloaded ${safeSku}_0_800.webp`);
  return 'downloaded';
}

interface CumulativeTotals {
  processed: number;
  downloaded: number;
  skipped: number;
  errors: number;
}

async function updateImageRegenState(fields: Record<string, unknown>): Promise<void> {
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
    SELECT COUNT(*)::int AS total FROM products
    WHERE (images IS NULL OR images::text = '[]') AND sku IS NOT NULL AND sku <> ''
  `);
  return result.rows[0]?.total ?? 0;
}

async function runBatch(
  options: CliOptions,
  skuMap: Map<string, { brand: string }>,
  partMap: Map<string, { brand: string; partNumber: string }>,
  effectiveBatch: number,
  totals: CumulativeTotals,
): Promise<CumulativeTotals> {
  const result = await db.execute(sql`
    SELECT id, sku, supplier_code, images, name FROM products
    WHERE (images IS NULL OR images::text = '[]') AND sku IS NOT NULL AND sku <> ''
    ORDER BY id LIMIT ${effectiveBatch}
  `);
  const products = result.rows as unknown as ProductRow[];
  if (products.length === 0) return totals;

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= products.length) return;
      const product = products[index];
      try {
        const status = await processProduct(product, index + 1, products.length, skuMap, partMap);
        if (status === 'downloaded') totals.downloaded++;
        else totals.skipped++;
      } catch (error) {
        totals.errors++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${index + 1}/${products.length}] Product ${product.id}: failed - ${message}`);
        selfLog(`FAIL ${product.id} sku=${product.sku}: ${message}`);
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
  return totals;
}

async function main(): Promise<void> {
  selfLog('=== main() start ===');
  const options = parseArgs(process.argv.slice(2));
  selfLog(`[INFO] batch=${options.batch} concurrency=${options.concurrency} csvDir=${options.csvDir}`);
  await loadFailedBrands();
  selfLog(`[INFO] failedBrands=${failedBrands.size} (cached)`);
  const { skuMap, partMap } = await loadCatalogMap(options.csvDir);
  const totalCandidates = await countCandidates();
  selfLog(`[INFO] totalCandidates=${totalCandidates} skuMapSize=${skuMap.size} partMapSize=${partMap.size}`);
  let effectiveBatch = Math.min(options.batch, totalCandidates);
  await updateImageRegenState({
    status: 'running',
    processed: 0, success: 0, failed: 0, skipped: 0,
    total: totalCandidates, current_sku: '',
  });
  if (effectiveBatch === 0) {
    selfLog('[DONE] No products with missing images found.');
    await updateImageRegenState({ status: 'completed' });
    return;
  }
  const totals: CumulativeTotals = { processed: 0, downloaded: 0, skipped: 0, errors: 0 };
  let batchNum = 1;
  while (true) {
    totals.processed = 0; totals.downloaded = 0; totals.skipped = 0; totals.errors = 0;
    await runBatch(options, skuMap, partMap, effectiveBatch, totals);
    selfLog(`[BATCH ${batchNum}] downloaded=${totals.downloaded} skipped=${totals.skipped} errors=${totals.errors}`);
    if (!options.loopAll) break;
    const remaining = await countCandidates();
    selfLog(`[LOOP] remaining=${remaining}`);
    if (remaining === 0) break;
    effectiveBatch = Math.min(options.batch, remaining);
    batchNum++;
  }
  await updateImageRegenState({ status: 'completed', current_sku: '' });
  selfLog(`[ALL DONE] batches=${batchNum}`);
}

main()
  .catch((error) => {
    console.error('[FATAL]', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });