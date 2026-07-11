// Script de migración: renombra archivos {id}-{variant}.webp → {sku}-{variant}.webp
// Genera mapping de BD, aplica fs.rename, dry-run por defecto.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const OPTIMIZED_DIR = path.resolve(process.cwd(), 'uploads', 'optimized');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : Infinity;
})();

interface FileEntry { oldName: string; newName: string; id: number; sku: string; }

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Listar todos los archivos en disco
  const files = fs.readdirSync(OPTIMIZED_DIR).filter(f => f.endsWith('.webp'));
  console.log(`[INFO] Files on disk: ${files.length}`);

  // Extraer IDs únicos
  const ids = [...new Set(files.map(f => parseInt(f.split('-')[0], 10)).filter(n => !isNaN(n)))];
  console.log(`[INFO] Unique IDs: ${ids.length}`);

  // Consultar SKUs de la BD para esos IDs
  const idChunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 1000) idChunks.push(ids.slice(i, i + 1000));
  const idToSku = new Map<number, string>();
  for (const chunk of idChunks) {
    const r = await client.query(`SELECT id, sku FROM products WHERE id = ANY($1::int[])`, [chunk]);
    for (const row of r.rows) {
      if (row.sku) idToSku.set(row.id, row.sku);
    }
  }
  console.log(`[INFO] Mapped ID→SKU: ${idToSku.size}/${ids.length}`);

  // Sanitizar SKU y construir mapeo
  const sanitizeSku = (sku: string) => sku.replace(/[^A-Za-z0-9._-]/g, '_');

  const renames: FileEntry[] = [];
  const collisions = new Map<string, string[]>(); // newName → oldNames
  const missingSku: string[] = [];

  let processed = 0;
  for (const file of files) {
    if (processed >= LIMIT) break;
    processed++;

    const m = file.match(/^(\d+)-(.+)\.webp$/);
    if (!m) continue;
    const [, idStr, variant] = m;
    const id = parseInt(idStr, 10);

    const sku = idToSku.get(id);
    if (!sku) { missingSku.push(file); continue; }

    const safeSku = sanitizeSku(sku);
    const newName = `${safeSku}-${variant}.webp`;

    if (newName !== file) {
      const existing = collisions.get(newName) || [];
      existing.push(file);
      collisions.set(newName, existing);
      renames.push({ oldName: file, newName, id, sku });
    }
  }

  console.log(`[INFO] Renames needed: ${renames.length}`);
  console.log(`[INFO] Missing SKU in DB: ${missingSku.length}`);
  if (missingSku.length > 0) {
    console.log(`[WARN] First 5 missing: ${missingSku.slice(0, 5).join(', ')}`);
  }

  // Detectar colisiones: mismo newName desde distintos oldName
  const realCollisions = [...collisions.entries()].filter(([, olds]) => olds.length > 1);
  if (realCollisions.length > 0) {
    console.log(`[ERROR] Collisions detected: ${realCollisions.length}`);
    for (const [newName, olds] of realCollisions.slice(0, 10)) {
      console.log(`  ${newName} ← ${olds.join(', ')}`);
    }
    console.log(`[ERROR] Aborting to prevent data loss. Resolve collisions first.`);
    await client.end();
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] Would rename ${renames.length} files. Sample (first 10):`);
    for (const r of renames.slice(0, 10)) {
      console.log(`  ${r.oldName} → ${r.newName}`);
    }
    console.log(`\nRun with --apply to perform the rename.`);
  } else {
    let ok = 0, fail = 0;
    for (const r of renames) {
      const oldPath = path.join(OPTIMIZED_DIR, r.oldName);
      const newPath = path.join(OPTIMIZED_DIR, r.newName);
      if (fs.existsSync(newPath)) {
        console.log(`[SKIP] Target already exists: ${r.newName}`);
        continue;
      }
      try {
        fs.renameSync(oldPath, newPath);
        ok++;
      } catch (e: any) {
        console.log(`[FAIL] ${r.oldName}: ${e.message}`);
        fail++;
      }
    }
    console.log(`\n[RESULT] OK: ${ok}, FAIL: ${fail}, TOTAL: ${renames.length}`);
  }

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
