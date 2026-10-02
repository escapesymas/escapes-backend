/**
 * Enriquece el catálogo con variantes, atributos y marcado de duplicados.
 *
 *   DATABASE_URL=... npx tsx scripts/enrich-catalog.ts <bihr-catalog.json> <dir-csv>
 *
 * Idempotente. Ver lib/catalog-enrich.ts para las reglas.
 */
import { enrichCatalog } from '../lib/catalog-enrich.js';
import { pool } from '../db.js';

const [jsonPath, csvDir] = process.argv.slice(2);
if (!jsonPath || !csvDir) {
  console.error('Uso: npx tsx scripts/enrich-catalog.ts <bihr-catalog.json> <directorio-csv>');
  process.exit(1);
}

const started = Date.now();
enrichCatalog(jsonPath, csvDir)
  .then((stats) => {
    console.log(`[ENRICH] Hecho en ${Math.round((Date.now() - started) / 1000)} s`, stats);
  })
  .catch((e) => {
    console.error('[ENRICH] Error:', e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
