// Lee server/scripts/missing_images.csv y descarga SOLO los tamaños faltantes.
// Patrón archivo: {SKU}_{idx}_{size}.webp en server/uploads/optimized/
// Concurrencia: 6 workers, batch: 100 filas CSV por iteración.
//
// Uso: tsx server/scripts/download_missing_sizes.ts

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const OPTIMIZED_DIR = path.resolve(process.cwd(), 'uploads', 'optimized');
const FORMAT = 'webp' as const;
const CSV_PATH = path.resolve(process.cwd(), 'scripts', 'missing_images.csv');
const CONCURRENCY = 6;
const BATCH = 100;

if (!fs.existsSync(OPTIMIZED_DIR)) fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });

interface Row {
  sku: string;
  idx: number;
  url: string;
  sizes: number[];
}

function parseCsv(): Row[] {
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length <= 1) return [];
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = parseCsvLine(line);
    if (parts.length < 4) continue;
    const sku = parts[0];
    const idx = parseInt(parts[1], 10);
    const url = parts[2];
    const sizes = parts[3].split(';').filter(Boolean).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    if (!sku || isNaN(idx) || !url || sizes.length === 0) continue;
    rows.push({ sku, idx, url, sizes });
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inQuote) { inQuote = true; continue; }
    if (ch === '"' && inQuote) { inQuote = false; continue; }
    if (ch === ',' && !inQuote) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
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

async function processRow(row: Row): Promise<{ generated: number; skipped: number; errors: number; fetchFailed: boolean }> {
  let generated = 0;
  let skipped = 0;
  let errors = 0;

  const sizesNeeded = row.sizes.filter(s => {
    const fp = path.join(OPTIMIZED_DIR, `${row.sku}_${row.idx}_${s}.${FORMAT}`);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.size > 0) return false;
    } catch {}
    return true;
  });

  if (sizesNeeded.length === 0) {
    return { generated: 0, skipped: row.sizes.length, errors: 0, fetchFailed: false };
  }

  const buf = await downloadBuffer(row.url);
  if (!buf) {
    return { generated: 0, skipped: 0, errors: 0, fetchFailed: true };
  }

  for (const size of sizesNeeded) {
    const fp = path.join(OPTIMIZED_DIR, `${row.sku}_${row.idx}_${size}.${FORMAT}`);
    try {
      const out = await sharp(buf)
        .resize({ width: size, withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
      fs.writeFileSync(fp, out);
      generated++;
    } catch (e: any) {
      errors++;
      console.error(`  [SHARP-ERR] ${row.sku}_${row.idx}_${size}: ${e.message}`);
    }
  }

  const sizesSkipped = row.sizes.length - sizesNeeded.length;
  skipped += sizesSkipped;
  return { generated, skipped, errors, fetchFailed: false };
}

async function main() {
  console.log(`[INFO] CSV_PATH=${CSV_PATH}`);
  console.log(`[INFO] OPTIMIZED_DIR=${OPTIMIZED_DIR}`);
  console.log(`[INFO] CONCURRENCY=${CONCURRENCY} BATCH=${BATCH}`);

  const rows = parseCsv();
  console.log(`[INFO] Filas CSV a procesar: ${rows.length}`);

  if (rows.length === 0) {
    console.log('[DONE] Nada que procesar.');
    return;
  }

  let processed = 0;
  let totalGenerated = 0;
  let totalSkipped = 0;
  let totalFetchFailed = 0;
  let totalSharpErrors = 0;
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    for (let j = 0; j < slice.length; j += CONCURRENCY) {
      const chunk = slice.slice(j, j + CONCURRENCY);
      const results = await Promise.allSettled(chunk.map(row => processRow(row)));
      for (let k = 0; k < results.length; k++) {
        const r = results[k];
        if (r.status === 'fulfilled') {
          totalGenerated += r.value.generated;
          totalSkipped += r.value.skipped;
          if (r.value.fetchFailed) totalFetchFailed++;
          totalSharpErrors += r.value.errors;
        } else {
          totalSharpErrors++;
          console.error(`[ERR] ${chunk[k].sku}_${chunk[k].idx}: ${r.reason?.message ?? r.reason}`);
        }
        processed++;
      }
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const rate = processed / Math.max(1, (Date.now() - t0) / 1000);
    const eta = (rows.length - processed) / Math.max(0.0001, rate);
    console.log(`[PROGRESS] processed=${processed}/${rows.length} generated_files=${totalGenerated} skipped_existing=${totalSkipped} fetch_failed=${totalFetchFailed} sharp_errors=${totalSharpErrors} rate=${rate.toFixed(2)}/s ETA=${eta.toFixed(0)}s elapsed=${elapsed}s`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== DONE ===`);
  console.log(`processed_rows:    ${processed}`);
  console.log(`generated_files:   ${totalGenerated}`);
  console.log(`skipped_existing:  ${totalSkipped}`);
  console.log(`fetch_failed:      ${totalFetchFailed}`);
  console.log(`sharp_errors:      ${totalSharpErrors}`);
  console.log(`elapsed:           ${elapsed}s`);
}

main().catch(e => { console.error(e); process.exit(1); });