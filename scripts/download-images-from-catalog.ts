import 'dotenv/config';
import { mkdir, writeFile, readFile, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db.js';
import { getBihrToken } from '../bihrService.js';

const DEFAULT_BATCH = 50;
const DEFAULT_CONCURRENCY = 8;
const SIZES = [800, 400, 200] as const;
const OPTIMIZED_DIR = '/app/server/uploads/optimized';
const BIHR_API_BASE = process.env.BIHR_API_BASE || 'https://api.bihr.net';

interface CliOptions {
  batch: number;
  concurrency: number;
  catalogPath?: string;
  autoFetchCatalog: boolean;
}

interface ProductRow {
  id: number;
  sku: string;
  supplier_code: string;
  images: unknown;
  name: string | null;
}

interface CatalogReference {
  ProductCode?: string;
  SupplierProductCode?: string;
  DefaultPicture?: string;
}

interface ImageRecord {
  src: string;
  srcMobile: string;
  srcCardDesktop: string;
  srcCardMobile: string;
  alt: string;
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
  let catalogPath: string | undefined;
  let autoFetchCatalog = false;

  for (const arg of args) {
    if (arg.startsWith('--batch=')) {
      batch = parsePositiveInteger(arg.slice('--batch='.length), '--batch');
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = parsePositiveInteger(arg.slice('--concurrency='.length), '--concurrency');
    } else if (arg.startsWith('--catalog=')) {
      catalogPath = arg.slice('--catalog='.length);
    } else if (arg === '--fetch-catalog') {
      autoFetchCatalog = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { batch, concurrency, catalogPath, autoFetchCatalog };
}

function sanitizeSku(sku: string | null | undefined): string {
  if (!sku) return '';
  return String(sku).replace(/[^A-Za-z0-9._-]/g, '_');
}

async function loadCatalogMap(catalogPath: string): Promise<Map<string, string>> {
  console.log(`[CATALOG] Reading ${catalogPath}`);
  const raw = await readFile(catalogPath, 'utf-8');
  const catalog = JSON.parse(raw) as { References?: CatalogReference[]; Products?: CatalogReference[] };
  const references = catalog.References || catalog.Products || [];
  console.log(`[CATALOG] Total references: ${references.length}`);

  const map = new Map<string, string>();
  for (const ref of references) {
    const code = ref.ProductCode || ref.SupplierProductCode;
    if (code && ref.DefaultPicture) {
      map.set(code, ref.DefaultPicture);
    }
  }
  console.log(`[CATALOG] Map size: ${map.size} (productCode -> image URL)`);
  return map;
}

async function fetchCatalog(): Promise<string> {
  console.log('[CATALOG] Requesting Bihr catalog generation (HardPart/Full)...');
  const token = await getBihrToken();
  const startResp = await fetch(`${BIHR_API_BASE}/api/v2.1/Catalog/ZIP/JSON/HardPart/Full`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const raw = await startResp.text();
  if (!startResp.ok) {
    throw new Error(`Catalog generation request failed: HTTP ${startResp.status} ${raw.slice(0, 200)}`);
  }
  const data = JSON.parse(raw) as { TicketId?: string; DownloadId?: string; ResultCode?: string };

  let downloadId = data.DownloadId;
  if (!downloadId && data.TicketId && data.ResultCode === 'OK') {
    console.log(`[CATALOG] Waiting for ticket ${data.TicketId}...`);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await fetch(`${BIHR_API_BASE}/api/v2.1/Catalog/GenerationStatus?ticketId=${data.TicketId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!s.ok) continue;
      const sj = (await s.json()) as { RequestStatus?: string; DownloadId?: string };
      console.log(`[CATALOG] Status: ${sj.RequestStatus} (attempt ${i + 1})`);
      if (sj.RequestStatus === 'DONE' && sj.DownloadId) {
        downloadId = sj.DownloadId;
        break;
      }
      if (sj.RequestStatus === 'ERROR') throw new Error('Catalog generation failed');
    }
  }
  if (!downloadId) throw new Error('No downloadId received from Bihr');

  console.log(`[CATALOG] Downloading ZIP with id ${downloadId}...`);
  const zipPath = path.join(process.cwd(), 'uploads', `catalog-${downloadId}.zip`);
  const extractDir = path.join(process.cwd(), 'uploads', `catalog-${downloadId}`);
  await mkdir(path.dirname(zipPath), { recursive: true });

  const fileResp = await fetch(`${BIHR_API_BASE}/api/v2.1/Catalog/GeneratedFile?downloadId=${downloadId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileResp.ok) throw new Error(`Download failed: HTTP ${fileResp.status}`);
  const buf = Buffer.from(await fileResp.arrayBuffer());
  await writeFile(zipPath, buf);
  console.log(`[CATALOG] ZIP saved to ${zipPath} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);

  // Extract using system unzip
  await new Promise<void>((resolve, reject) => {
    const { exec } = require('node:child_process');
    exec(`unzip -o "${zipPath}" -d "${extractDir}"`, (err: Error | null) => {
      if (err) reject(err); else resolve();
    });
  });

  const { readdir } = await import('node:fs/promises');
  const files = await readdir(extractDir);
  const jsonFile = files.find((f) => f.endsWith('.json'));
  if (!jsonFile) throw new Error('No JSON in catalog ZIP');
  const jsonPath = path.join(extractDir, jsonFile);

  // Cleanup ZIP later (keep extracted JSON)
  unlink(zipPath).catch(() => undefined);

  return jsonPath;
}

async function downloadImage(imageUrl: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*',
    'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/2.0',
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
      OR images = '[]'::jsonb
      OR images::text = '[]'
    )
      AND sku IS NOT NULL AND sku <> ''
  `);
  return result.rows[0]?.total ?? 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`[INFO] batch=${options.batch} concurrency=${options.concurrency}`);

  let catalogPath = options.catalogPath;
  if (!catalogPath && options.autoFetchCatalog) {
    catalogPath = await fetchCatalog();
  }
  if (!catalogPath) {
    throw new Error('Either --catalog=PATH or --fetch-catalog must be provided');
  }

  const catalogMap = await loadCatalogMap(catalogPath);
  console.log(`[INFO] Catalog loaded. output=${OPTIMIZED_DIR}`);

  const totalCandidates = await countCandidates();
  const effectiveBatch = Math.min(options.batch, totalCandidates);

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

  const result = await db.execute(sql`
    SELECT id, sku, supplier_code, images, name
    FROM products
    WHERE (
      images IS NULL
      OR images = '[]'::jsonb
      OR images::text = '[]'
    )
      AND sku IS NOT NULL AND sku <> ''
    ORDER BY id
    LIMIT ${effectiveBatch}
  `);
  const products = result.rows as unknown as ProductRow[];
  console.log(`[INFO] Selected ${products.length} products (out of ${totalCandidates} candidates)`);

  let nextIndex = 0;
  let processed = 0;
  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= products.length) return;
      const product = products[index];
      try {
        const status = await processProduct(product, index + 1, products.length, catalogMap);
        if (status === 'downloaded') downloaded++;
        else skipped++;
      } catch (error) {
        errors++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${index + 1}/${products.length}] Product ${product.id}: failed - ${message}`);
      } finally {
        processed++;
        await updateImageRegenState({
          processed,
          success: downloaded,
          failed: errors,
          skipped,
          current_sku: product.sku ?? '',
        }).catch((err) => console.error('[STATE UPDATE ERROR]', err));
      }
    }
  }

  const workerCount = Math.min(options.concurrency, products.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  await updateImageRegenState({
    status: 'completed',
    processed,
    success: downloaded,
    failed: errors,
    skipped,
    current_sku: '',
  });

  console.log(
    `[DONE] totalCandidates=${totalCandidates} selected=${products.length} downloaded=${downloaded} skipped=${skipped} errors=${errors} processed=${processed}`,
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