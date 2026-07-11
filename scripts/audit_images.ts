// Auditoría: detecta imágenes Bihr cuyos tamaños {200,400,600,800} faltan en disco.
// Genera CSV con (sku, idx, url, sizes_faltantes) para descarga posterior.
//
// Uso: tsx server/scripts/audit_images.ts

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const OPTIMIZED_DIR = path.resolve(process.cwd(), 'uploads', 'optimized');
const SIZES = [200, 400, 600, 800] as const;
const FORMAT = 'webp' as const;
const CSV_PATH = path.resolve(process.cwd(), 'scripts', 'missing_images.csv');

function sanitizeSku(sku: string | null | undefined): string {
  if (!sku) return '';
  return String(sku).replace(/[^A-Za-z0-9._-]/g, '_');
}

function fileExistsNonEmpty(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

interface MissingRow {
  sku: string;
  idx: number;
  url: string;
  sizesFaltantes: number[];
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  if (!fs.existsSync(OPTIMIZED_DIR)) fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });

  console.log(`[INFO] OPTIMIZED_DIR=${OPTIMIZED_DIR}`);
  console.log(`[INFO] CSV_PATH=${CSV_PATH}`);

  const totalR = await client.query<{ c: string }>(`
    SELECT count(*)::text AS c
    FROM products
    WHERE status = 'published'
      AND images::text LIKE '%mybihr.com%'
      AND sku IS NOT NULL AND sku != ''
  `);
  const totalProductos = parseInt(totalR.rows[0].c, 10);
  console.log(`[INFO] Productos publicados con imágenes remotas: ${totalProductos}`);

  let totalEsperadas = 0;
  let totalExistentes = 0;
  const faltantesPorSize: Record<number, number> = { 200: 0, 400: 0, 600: 0, 800: 0 };
  const missingRows: MissingRow[] = [];

  const BATCH = 500;
  let offset = 0;
  const t0 = Date.now();

  while (true) {
    const r = await client.query<{ id: number; sku: string; images: any }>(`
      SELECT id, sku, images
      FROM products
      WHERE status = 'published'
        AND images::text LIKE '%mybihr.com%'
        AND sku IS NOT NULL AND sku != ''
      ORDER BY id
      LIMIT $1 OFFSET $2
    `, [BATCH, offset]);

    if (r.rows.length === 0) break;

    for (const row of r.rows) {
      const skuSafe = sanitizeSku(row.sku);
      if (!skuSafe) continue;

      let imgs: Array<{ src?: string; url?: string }> = [];
      try {
        imgs = typeof row.images === 'string' ? JSON.parse(row.images) : (row.images || []);
      } catch {
        continue;
      }

      for (let i = 0; i < imgs.length; i++) {
        const src = imgs[i]?.src || imgs[i]?.url;
        if (!src || !/^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(src)) continue;

        totalEsperadas += SIZES.length;

        const missing: number[] = [];
        for (const size of SIZES) {
          const fp = path.join(OPTIMIZED_DIR, `${skuSafe}_${i}_${size}.${FORMAT}`);
          if (fileExistsNonEmpty(fp)) {
            totalExistentes++;
          } else {
            missing.push(size);
            faltantesPorSize[size]++;
          }
        }

        if (missing.length > 0) {
          missingRows.push({
            sku: skuSafe,
            idx: i,
            url: src,
            sizesFaltantes: missing,
          });
        }
      }
    }

    offset += r.rows.length;

    if (offset % 5000 === 0 || r.rows.length < BATCH) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[PROGRESS] scanned=${offset}/${totalProductos} expected=${totalEsperadas} existing=${totalExistentes} missing_groups=${missingRows.length} elapsed=${elapsed}s`);
    }

    if (r.rows.length < BATCH) break;
  }

  console.log('\n=== AUDIT REPORT ===');
  console.log(`total_productos:           ${totalProductos}`);
  console.log(`total_imagenes_esperadas:  ${totalEsperadas}`);
  console.log(`total_imagenes_existentes: ${totalExistentes}`);
  console.log(`total_imagenes_faltantes:  ${totalEsperadas - totalExistentes}`);
  console.log(`total_faltan_200:          ${faltantesPorSize[200]}`);
  console.log(`total_faltan_400:          ${faltantesPorSize[400]}`);
  console.log(`total_faltan_600:          ${faltantesPorSize[600]}`);
  console.log(`total_faltan_800:          ${faltantesPorSize[800]}`);
  console.log(`grupos_con_faltantes:      ${missingRows.length}`);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`elapsed:                   ${elapsed}s`);

  const csvHeader = 'sku,idx,url,sizes_faltantes\n';
  const csvBody = missingRows
    .map(r => `${r.sku},${r.idx},${JSON.stringify(r.url).slice(1, -1)},${r.sizesFaltantes.join(';')}`)
    .join('\n');
  fs.writeFileSync(CSV_PATH, csvHeader + csvBody + (missingRows.length > 0 ? '\n' : ''));
  console.log(`\n[INFO] CSV escrito en ${CSV_PATH} (${missingRows.length} filas)`);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });