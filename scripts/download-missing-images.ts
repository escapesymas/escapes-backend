import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
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
  dryRun: boolean;
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
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--batch=')) {
      batch = parsePositiveInteger(arg.slice('--batch='.length), '--batch');
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = parsePositiveInteger(arg.slice('--concurrency='.length), '--concurrency');
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { batch, concurrency, dryRun };
}

// Matches the sanitizer used by localImageForSku in index.ts.
function sanitizeSku(sku: string | null | undefined): string {
  if (!sku) return '';
  return String(sku).replace(/[^A-Za-z0-9._-]/g, '_');
}

function imageUrlFromPayload(payload: unknown): string | null {
  if (typeof payload === 'string') return payload.trim() || null;
  if (!payload || typeof payload !== 'object') return null;

  const value = payload as Record<string, unknown>;
  for (const key of ['url', 'imageUrl', 'imageURL', 'src']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return value[key].trim();
    }
  }

  return null;
}

async function getImageUrl(supplierCode: string, token: string): Promise<string> {
  const endpoint = new URL(
    `/api/v2.1/Products/Image/${encodeURIComponent(supplierCode)}`,
    BIHR_API_BASE,
  );
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/plain',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Bihr image lookup failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  let imageUrl: string | null;

  if (contentType.includes('application/json')) {
    imageUrl = imageUrlFromPayload(await response.json());
  } else {
    imageUrl = imageUrlFromPayload(await response.text());
  }

  if (!imageUrl) {
    throw new Error('Bihr image lookup returned no image URL');
  }

  return new URL(imageUrl, BIHR_API_BASE).toString();
}

async function downloadImage(imageUrl: string, token: string): Promise<Buffer> {
  const url = new URL(imageUrl);
  const apiOrigin = new URL(BIHR_API_BASE).origin;
  const headers: Record<string, string> = {
    Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*',
    'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/1.0',
  };

  // Do not forward Bihr credentials to an unrelated image host.
  if (url.origin === apiOrigin) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Image download failed with HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error('Image download returned an empty response');
  }

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

function imageRecordFor(row: ProductRow, safeSku: string): ImageRecord {
  const base = `/uploads/optimized/${safeSku}_0_`;
  return {
    src: `${base}800.webp`,
    srcMobile: `${base}400.webp`,
    srcCardDesktop: `${base}400.webp`,
    srcCardMobile: `${base}200.webp`,
    alt: row.name || row.sku,
  };
}

async function processProduct(
  row: ProductRow,
  position: number,
  total: number,
  dryRun: boolean,
  getToken: () => Promise<string>,
): Promise<'downloaded' | 'dry-run'> {
  const safeSku = sanitizeSku(row.sku);
  if (!safeSku) throw new Error('SKU is empty after sanitization');

  const mainFilename = `${safeSku}_0_800.webp`;
  if (dryRun) {
    console.log(`[${position}/${total}] Product ${row.id}: would download ${mainFilename}`);
    return 'dry-run';
  }

  const token = await getToken();
  const imageUrl = await getImageUrl(row.supplier_code, token);
  const image = await downloadImage(imageUrl, token);
  await writeVariants(image, safeSku);

  const images = [imageRecordFor(row, safeSku)];
  await db.execute(sql`
    UPDATE products
    SET images = ${JSON.stringify(images)}::jsonb
    WHERE id = ${row.id}
  `);

  console.log(`[${position}/${total}] Product ${row.id}: downloaded ${mainFilename}`);
  return 'downloaded';
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `[INFO] batch=${options.batch} concurrency=${options.concurrency} dryRun=${options.dryRun}`,
  );
  if (!options.dryRun) console.log(`[INFO] output=${OPTIMIZED_DIR}`);

  const result = await db.execute(sql`
    SELECT id, sku, supplier_code, images, name
    FROM products
    WHERE (
      images IS NULL
      OR images = '[]'::jsonb
      OR images::text = '[]'
    )
      AND sku IS NOT NULL
      AND sku <> ''
      AND supplier_code IS NOT NULL
      AND supplier_code <> ''
    ORDER BY id
    LIMIT ${options.batch}
  `);
  const products = result.rows as unknown as ProductRow[];

  if (products.length === 0) {
    console.log('[DONE] No products with missing images found.');
    return;
  }

  let nextIndex = 0;
  let downloaded = 0;
  let errors = 0;
  let tokenPromise: Promise<string> | null = null;
  const getToken = (): Promise<string> => {
    tokenPromise ??= getBihrToken().catch((error) => {
      tokenPromise = null;
      throw error;
    });
    return tokenPromise;
  };

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= products.length) return;

      const product = products[index];
      try {
        const status = await processProduct(
          product,
          index + 1,
          products.length,
          options.dryRun,
          getToken,
        );
        if (status === 'downloaded') downloaded++;
      } catch (error) {
        errors++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${index + 1}/${products.length}] Product ${product.id}: failed - ${message}`);
      }
    }
  }

  const workerCount = Math.min(options.concurrency, products.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  console.log(
    `[DONE] selected=${products.length} downloaded=${downloaded} errors=${errors} dryRun=${options.dryRun}`,
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
