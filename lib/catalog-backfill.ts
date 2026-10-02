/**
 * Rellenos en segundo plano tras la migración 008: search_text y family_code
 * para las filas existentes, por lotes pequeños para no bloquear la BD.
 * Idempotente: solo toca filas con la columna a NULL.
 */
import { pool } from '../db.js';

const BATCH = 5000;

export async function backfillCatalogColumns(): Promise<void> {
  const started = Date.now();
  let total = 0;
  for (;;) {
    const res = await pool.query(`
      UPDATE products p SET
        search_text = products_search_text(p.name, p.supplier_name, p.brand, p.sku,
                                           p.part_number, p.barcode, p.supplier_code, p.old_part_number),
        family_code = COALESCE(p.family_code, CASE
          WHEN p.part_number ~ '^[0-9]{10}$' THEN left(p.part_number, 7)
          WHEN p.sku ~ '^[0-9]{10}$' THEN left(p.sku, 7)
          ELSE p.sku
        END)
      WHERE p.id IN (
        SELECT id FROM products WHERE search_text IS NULL OR family_code IS NULL LIMIT ${BATCH}
      )
    `);
    total += res.rowCount || 0;
    if (!res.rowCount) break;
    // Respiro entre lotes para no acaparar el VPS.
    await new Promise((r) => setTimeout(r, 200));
  }
  if (total) console.log(`[CATALOG BACKFILL] ${total} productos actualizados en ${Date.now() - started} ms`);
}
