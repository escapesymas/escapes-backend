// Script de descarga+optimización masiva de imágenes.
// Patrón de archivo: {SKU}_{idx}_{size}.{format}
// Sizes: 200, 400, 600, 800
// Format: webp (futuro: avif)
//
// Descarga de api.mybihr.com + sharp resize + persiste en /home/.../server/uploads/optimized/
// Skip si ya existe en disco.
// Concurrencia: 8 workers
// Uso: tsx download_images_local.ts [--limit N] [--offset N] [--batch N] [--concurrency N]

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { Client } from 'pg';

const OPTIMIZED_DIR = path.resolve(process.cwd(), 'uploads', 'optimized');
if (!fs.existsSync(OPTIMIZED_DIR)) fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });

const SIZES = [200, 400, 600, 800] as const;
const FORMAT = 'webp' as const;

const args = process.argv.slice(2);
const opt = (name: string, def?: number): number | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = parseInt(args[i + 1], 10);
  return isNaN(v) ? def : v;
};

const LIMIT = opt('limit');
const OFFSET = opt('offset', 0) ?? 0;
const BATCH = opt('batch', 200) ?? 200;
const CONCURRENCY = opt('concurrency', 8) ?? 8;

function sanitizeSku(sku: string | null | undefined): string {
  if (!sku) return '';
  return String(sku).replace(/[^A-Za-z0-9._-]/g, '_');
}

async function downloadBuffer(url: string): Promise<Buffer | null> {
  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EscapesYMas/1.0; +https://escapesymas.com)',
        'Accept': 'image/jpeg,image/png,image/webp,image/*',
      },
    });
    if (!upstream.ok) return null;
    const ab = await upstream.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

async function optimizeToSizes(input: Buffer, skuSafe: string, idx: number): Promise<{ size: number; bytes: number }[]> {
  const results: { size: number; bytes: number }[] = [];
  for (const size of SIZES) {
    const filename = `${skuSafe}_${idx}_${size}.${FORMAT}`;
    const filepath = path.join(OPTIMIZED_DIR, filename);
    if (fs.existsSync(filepath)) {
      try {
        const st = fs.statSync(filepath);
        if (st.size > 0) {
          results.push({ size, bytes: st.size });
          continue;
        }
      } catch {}
    }
    try {
      const out = await sharp(input)
        .resize({ width: size, withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
      fs.writeFileSync(filepath, out);
      results.push({ size, bytes: out.length });
    } catch (e: any) {
      console.error(`  [SHARP-ERR] ${skuSafe}_${idx}_${size}: ${e.message}`);
    }
  }
  return results;
}

interface ProductRow {
  id: number;
  sku: string;
  images: any;
}

async function processProduct(client: Client, row: ProductRow): Promise<{ downloaded: number; cached: number }> {
  const skuSafe = sanitizeSku(row.sku);
  if (!skuSafe) return { downloaded: 0, cached: 0 };

  let imgs: Array<{ src?: string; url?: string }> = [];
  try {
    imgs = typeof row.images === 'string' ? JSON.parse(row.images) : (row.images || []);
  } catch {
    return { downloaded: 0, cached: 0 };
  }

  let downloaded = 0;
  let cached = 0;

  for (let i = 0; i < imgs.length; i++) {
    const src = imgs[i]?.src || imgs[i]?.url;
    if (!src || !/^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(src)) continue;

    const firstPath = path.join(OPTIMIZED_DIR, `${skuSafe}_${i}_${SIZES[0]}.${FORMAT}`);
    if (fs.existsSync(firstPath)) {
      cached++;
      continue;
    }

    const buf = await downloadBuffer(src);
    if (!buf) continue;

    await optimizeToSizes(buf, skuSafe, i);
    downloaded++;
  }

  return { downloaded, cached };
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`[INFO] Concurrency=${CONCURRENCY} Batch=${BATCH} Limit=${LIMIT ?? '∞'} Offset=${OFFSET}`);
  console.log(`[INFO] OPTIMIZED_DIR=${OPTIMIZED_DIR}`);

  const totalR = await client.query(`SELECT count(*) as c FROM products WHERE status = 'published' AND images::text LIKE '%mybihr.com%'`);
  console.log(`[INFO] Productos con imágenes remotas: ${totalR.rows[0].c}`);

  let offset = OFFSET;
  let processed = 0;
  let totalDownloaded = 0;
  let totalCached = 0;
  let totalErrors = 0;
  const t0 = Date.now();

  while (true) {
    if (LIMIT && processed >= LIMIT) break;

    const r = await client.query<ProductRow>(`
      SELECT id, sku, images
      FROM products
      WHERE status = 'published'
        AND images::text LIKE '%mybihr.com%'
        AND sku IS NOT NULL AND sku != ''
      ORDER BY id
      LIMIT $1 OFFSET $2
    `, [BATCH, offset]);

    if (r.rows.length === 0) break;

    for (let i = 0; i < r.rows.length; i += CONCURRENCY) {
      const slice = r.rows.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(slice.map(row => processProduct(client, row)));
      for (let j = 0; j < results.length; j++) {
        const res = results[j];
        if (res.status === 'fulfilled') {
          totalDownloaded += res.value.downloaded;
          totalCached += res.value.cached;
        } else {
          totalErrors++;
          console.error(`[ERR] product ${slice[j].id}: ${res.reason?.message}`);
        }
        processed++;
      }
    }

    const elapsed = (Date.now() - t0) / 1000;
    const rate = processed / elapsed;
    const eta = (totalR.rows[0].c - processed) / rate;
    console.log(`[PROGRESS] processed=${processed}/${totalR.rows[0].c} downloaded=${totalDownloaded} cached=${totalCached} errors=${totalErrors} rate=${rate.toFixed(1)}/s ETA=${eta.toFixed(0)}s`);

    offset += BATCH;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[DONE] processed=${processed} downloaded=${totalDownloaded} cached=${totalCached} errors=${totalErrors} elapsed=${elapsed}s`);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });