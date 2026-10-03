/**
 * Rellenos en segundo plano del catálogo, por lotes cortos (cada lote es su
 * propia transacción: nunca se bloquean filas de productos durante minutos).
 *
 *   1. search_text / family_code a NULL (filas nuevas sin trigger, migración 008).
 *   2. Recalcular search_text de todo el catálogo cuando cambia la función
 *      products_search_text (SEARCH_TEXT_VERSION), recorriendo por rangos de id.
 */
import { pool } from '../db.js';

const BATCH = 2000;
/** Subir este número cuando cambie products_search_text() en una migración. */
const SEARCH_TEXT_VERSION = '3';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// search_extra (categoría y modelos compatibles) se calcula en la misma sentencia.
const EXTRA = `products_search_extra(p.category_id, p.compatibility)`;
const RECOMPUTE = `
  search_extra = ${EXTRA},
  search_text = products_search_text(p.name, p.supplier_name, p.brand, p.sku,
                                     p.part_number, p.barcode, p.supplier_code, p.old_part_number, ${EXTRA}),
  family_code = COALESCE(p.family_code, CASE
    WHEN p.part_number ~ '^[0-9]{10}$' THEN left(p.part_number, 7)
    WHEN p.sku ~ '^[0-9]{10}$' THEN left(p.sku, 7)
    ELSE p.sku
  END)`;

export async function backfillCatalogColumns(): Promise<void> {
  const started = Date.now();
  let total = 0;

  // 1) Filas con columnas sin rellenar.
  for (;;) {
    const res = await pool.query(`
      UPDATE products p SET ${RECOMPUTE}
      WHERE p.id IN (SELECT id FROM products WHERE search_text IS NULL OR family_code IS NULL LIMIT ${BATCH})
    `);
    total += res.rowCount || 0;
    if (!res.rowCount) break;
    await pause(200);
  }

  // 2) Recalcular todo si la versión del texto de búsqueda ha cambiado.
  const meta = await pool.query(`SELECT value FROM catalog_meta WHERE key = 'search_text_version'`).catch(() => null);
  if (meta && meta.rows[0]?.value !== SEARCH_TEXT_VERSION) {
    const { rows: [range] } = await pool.query('SELECT min(id) AS lo, max(id) AS hi FROM products');
    for (let from = Number(range.lo) || 0; from <= (Number(range.hi) || 0); from += BATCH) {
      const res = await pool.query(
        `UPDATE products p SET ${RECOMPUTE}
         WHERE p.id >= $1 AND p.id < $2
           -- solo las filas cuyo texto cambia (no reescribir lo ya actualizado)
           AND p.search_text IS DISTINCT FROM products_search_text(p.name, p.supplier_name, p.brand, p.sku,
                 p.part_number, p.barcode, p.supplier_code, p.old_part_number, ${EXTRA})`,
        [from, from + BATCH]);
      total += res.rowCount || 0;
      await pause(100);
    }
    await pool.query(
      `INSERT INTO catalog_meta (key, value) VALUES ('search_text_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [SEARCH_TEXT_VERSION]);
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY catalog_words').catch(() => {});
  }

  if (total) console.log(`[CATALOG BACKFILL] ${total} productos actualizados en ${Date.now() - started} ms`);
}
