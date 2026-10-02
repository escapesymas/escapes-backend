/**
 * Rellena la medida normalizada de los neumáticos (Ancho/Perfil/Llanta/Posición).
 *
 *   DATABASE_URL=... npx tsx scripts/tyre-attributes.ts [dir-csv]
 *
 * Idempotente. Con el directorio de CSV de Bihr añade también índices de carga
 * y velocidad, estructura y TL/TT. Ver lib/tyres.ts.
 */
import { loadCsvIndex } from '../lib/catalog-enrich.js';
import { applyTyreAttributes } from '../lib/tyres.js';
import { pool } from '../db.js';

const [csvDir] = process.argv.slice(2);
const csv = csvDir ? loadCsvIndex(csvDir) : undefined;
applyTyreAttributes(csv)
  .then((r) => console.log(`[TYRES] ${r.sized}/${r.tyres} con medida, ${r.updated} actualizados`))
  .catch((e) => { console.error('[TYRES] Error:', e); process.exitCode = 1; })
  .finally(() => pool.end());
