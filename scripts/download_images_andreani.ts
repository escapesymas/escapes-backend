// Descarga imágenes de productos Andreani, las convierte a 4 variantes WebP y las guarda
// en server/uploads/optimized/{sku-sanitizado}-{variant}.webp.
// Actualiza products.images con la nueva estructura {src, srcMobile, srcCardDesktop, srcCardMobile}.
// Reanudable: si las 4 variantes ya existen y Content-Length remoto no sugiere cambio, skip.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import sharp from 'sharp';

const OPTIMIZED_DIR = path.resolve(process.cwd(), 'uploads', 'optimized');
fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });

const VARIANTS = [
  { suffix: 'desktop', width: 800, quality: 80 },
  { suffix: 'mobile', width: 400, quality: 80 },
  { suffix: 'card-desktop', width: 400, quality: 80 },
  { suffix: 'card-mobile', width: 300, quality: 80 },
] as const;

const sanitizeSku = (sku: string) => sku.replace(/[^A-Za-z0-9._-]/g, '_');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: { limit?: number; dryRun: boolean; force: boolean; sku?: string } = { dryRun: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit') opts.limit = parseInt(args[++i], 10);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--sku=')) opts.sku = a.slice(6);
  }
  return opts;
}

async function fetchImage(url: string): Promise<{ ok: true; buffer: Buffer; contentType: string; size: number } | { ok: false; error: string; size: number }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'escapesymas/1.0 (+image-sync)' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, size: 0 };
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return { ok: false, error: `not image, got ${contentType}`, size: 0 };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, error: 'empty body', size: 0 };
    return { ok: true, buffer: buf, contentType, size: buf.length };
  } catch (e: any) {
    return { ok: false, error: e.message || 'fetch failed', size: 0 };
  }
}

async function headImageSize(url: string): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'escapesymas/1.0' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const cl = res.headers.get('content-length');
    return cl ? parseInt(cl, 10) : null;
  } catch { return null; }
}

function allVariantsExist(safeSku: string): { exists: boolean; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const v of VARIANTS) {
    files[v.suffix] = path.join(OPTIMIZED_DIR, `${safeSku}-${v.suffix}.webp`);
  }
  const exists = VARIANTS.every(v => fs.existsSync(files[v.suffix]));
  return { exists, files };
}

async function processOne(url: string, safeSku: string, idx: number = 0): Promise<{ ok: boolean; error?: string; wrote: string[] }> {
  const wrote: string[] = [];
  const fetchRes = await fetchImage(url);
  if (!fetchRes.ok) return { ok: false, error: fetchRes.error, wrote: [] };
  const { buffer } = fetchRes;

  for (const v of VARIANTS) {
    const suffix = idx === 0 ? v.suffix : `${v.suffix}-${idx + 1}`;
    const outPath = path.join(OPTIMIZED_DIR, `${safeSku}-${suffix}.webp`);
    const tmpPath = outPath + '.tmp';
    try {
      await sharp(buffer)
        .rotate()
        .resize({ width: v.width, withoutEnlargement: true })
        .webp({ quality: v.quality, effort: 4 })
        .toFile(tmpPath);
      fs.renameSync(tmpPath, outPath);
      wrote.push(outPath);
    } catch (e: any) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return { ok: false, error: `sharp ${v.suffix}: ${e.message}`, wrote };
    }
  }
  return { ok: true, wrote };
}

interface ProductRow { id: number; sku: string; name: string; images: any[]; }

function extractUrls(images: any[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const img of images) {
    if (!img) continue;
    const u = typeof img === 'string' ? img : (img.src || img.url);
    if (u && typeof u === 'string' && u.startsWith('http') && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

function buildLocalImages(safeSku: string, alt: string, urls: string[]): any[] {
  return urls.map((_u, idx) => {
    const main = idx === 0;
    const suffix = main ? '' : `-${idx + 1}`;
    return {
      src: `/uploads/optimized/${safeSku}-desktop${suffix}.webp`,
      srcMobile: `/uploads/optimized/${safeSku}-mobile${suffix}.webp`,
      srcCardDesktop: `/uploads/optimized/${safeSku}-card-desktop${suffix}.webp`,
      srcCardMobile: `/uploads/optimized/${safeSku}-card-mobile${suffix}.webp`,
      alt,
      providerId: 'andreani',
    };
  });
}

async function main() {
  const opts = parseArgs();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let where = `provider_id = 'andreani' AND images::text LIKE '%andreanimhs.com%'`;
  const params: any[] = [];
  if (opts.sku) {
    params.push(opts.sku);
    where += ` AND sku = $${params.length}`;
  }
  if (opts.limit) {
    params.push(opts.limit);
    where += ` ORDER BY id LIMIT $${params.length}`;
  } else {
    where += ` ORDER BY id`;
  }

  const r = await client.query(`SELECT id, sku, name, images FROM products WHERE ${where}`, params);
  console.log(`[INFO] Found ${r.rows.length} products to process`);
  if (r.rows.length === 0) { await client.end(); return; }

  let downloaded = 0, skipped = 0, failed = 0, updated = 0;
  let idx = 0;
  for (const row of r.rows as ProductRow[]) {
    idx++;
    const safeSku = sanitizeSku(row.sku);
    if (!safeSku) { console.log(`[${idx}/${r.rows.length}] id=${row.id} sku='${row.sku}' SKIP empty sku`); continue; }

    const urls = extractUrls(row.images || []);
    if (urls.length === 0) { console.log(`[${idx}/${r.rows.length}] id=${row.id} sku=${row.sku} SKIP no urls`); continue; }

    // Verificar si ya tiene todas las variantes para todas las urls
    let allExist = true;
    for (let i = 0; i < urls.length; i++) {
      const s = i === 0 ? safeSku : `${safeSku}`;
      const variants = VARIANTS.map(v => i === 0 ? v.suffix : `${v.suffix}-${i + 1}`);
      if (!variants.every(suf => fs.existsSync(path.join(OPTIMIZED_DIR, `${safeSku}-${suf}.webp`)))) {
        allExist = false;
        break;
      }
    }

    if (allExist && !opts.force) {
      // Verificar tamaño remoto para la primera url
      const remoteSize = await headImageSize(urls[0]);
      if (remoteSize !== null) {
        const localPath = path.join(OPTIMIZED_DIR, `${safeSku}-desktop.webp`);
        const localSize = fs.statSync(localPath).size;
        // Margen: si local > 50% del remoto, probablemente ya descargado
        if (localSize > remoteSize * 0.3) {
          console.log(`[${idx}/${r.rows.length}] id=${row.id} sku=${row.sku} SKIP exists (local=${localSize}, remote=${remoteSize})`);
          skipped++;
          continue;
        }
      } else {
        console.log(`[${idx}/${r.rows.length}] id=${row.id} sku=${row.sku} SKIP exists (no HEAD response)`);
        skipped++;
        continue;
      }
    }

    if (opts.dryRun) {
      console.log(`[${idx}/${r.rows.length}] id=${row.id} sku=${row.sku} WOULD download ${urls.length} urls`);
      continue;
    }

    let productOk = true;
    for (let i = 0; i < urls.length; i++) {
      const r2 = await processOne(urls[i], safeSku, i);
      if (!r2.ok) {
        console.log(`[${idx}/${r.rows.length}] id=${row.id} sku=${row.sku} FAIL url[${i}]: ${r2.error}`);
        productOk = false;
        failed++;
        break;
      }
      downloaded++;
    }

    if (productOk) {
      const newImages = buildLocalImages(safeSku, row.name, urls);
      try {
        await client.query(`UPDATE products SET images = $1::jsonb WHERE id = $2`, [JSON.stringify(newImages), row.id]);
        updated++;
        console.log(`[${idx}/${r.rows.length}] id=${row.id} sku=${row.sku} OK (${urls.length} urls, ${newImages.length} entries)`);
      } catch (e: any) {
        console.log(`[${idx}/${r.rows.length}] id=${row.id} sku=${row.sku} FAIL update: ${e.message}`);
        failed++;
      }
    }
  }

  console.log(`\n[SUMMARY] downloaded=${downloaded} skipped=${skipped} failed=${failed} updated=${updated} total=${r.rows.length}`);
  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
