/**
 * Compatibilidad producto ↔ moto resuelta en PostgreSQL.
 *
 * Sustituye a los índices en memoria que se construían recorriendo la columna
 * `products.compatibility` entera (~8 M de entradas con el catálogo actual):
 * ocupaban más de 1 GB de RAM y la primera consulta tardaba ~40 s.
 *
 * Funcionamiento:
 *   1. `compat_vehicle_models` (vista materializada, ~60 k filas) guarda los
 *      tríos distintos (marca, año, modelo) tal y como vienen de Bihr, p. ej.
 *      ('HONDA', '2008', 'CBR 600 RR (PC40)').
 *   2. Con la moto elegida en el selector se buscan en esa vista los modelos
 *      cuyo nombre normalizado coincide (misma regla que antes: cleanModelName).
 *   3. Se consultan los productos con `compatibility @> [{brand, year, model}]`,
 *      que usa el índice GIN existente (idx_products_compatibility_gin_native).
 */
import { pool } from '../db.js';

const MV = 'compat_vehicle_models';
const MAX_MODELS = 25;

export function cleanModelName(m: unknown): string {
  return String(m || '')
    .replace(/\(.*\)/g, '')
    .replace(/\b(neo\s+sports\s+cafe|black\s+edition|special\s+edition|exclusive|tech\s+max|iron\s+max|black\s+max|white\s+max|lux\s+max|bronze\s+max|moto\s+cage|night\s+fluo)\b/gi, '')
    .replace(/\b(abs|cbs|dx|sx|sp|se|rr|r|i|ie|fi|euro\s*\d)\b/gi, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

let ensuring: Promise<void> | null = null;
let ready = false;

/** Crea la vista si no existe. La primera vez tarda (~20-60 s): no bloquea el arranque. */
export function ensureCompatModels(): Promise<void> {
  if (ready) return Promise.resolve();
  if (!ensuring) {
    ensuring = (async () => {
      const exists = await pool.query<{ reg: string | null }>(`SELECT to_regclass($1) AS reg`, [MV]);
      if (exists.rows[0]?.reg) {
        ready = true;
        return;
      }
      await pool.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${MV} AS
        SELECT DISTINCT upper(e->>'brand') AS brand, (e->>'year') AS year, e->>'model' AS model
        FROM products p
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.compatibility) = 'array' THEN p.compatibility ELSE '[]'::jsonb END
        ) e
        WHERE p.status = 'published' AND e->>'brand' IS NOT NULL AND e->>'model' IS NOT NULL
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_cvm_brand_year ON ${MV} (brand, year)`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cvm_unique ON ${MV} (brand, year, model)`);
      ready = true;
    })().catch((e) => {
      ensuring = null;
      throw e;
    });
  }
  return ensuring;
}

/** Recalcula la vista tras cambios de catálogo (sync de Bihr, importaciones). */
export async function refreshCompatModels(): Promise<void> {
  await ensureCompatModels();
  await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${MV}`);
}

/**
 * SKUs compatibles con la moto (marca obligatoria; modelo y año opcionales).
 * Devuelve [] mientras la vista todavía se está creando.
 */
export async function findCompatibleSkus(brand: string, model?: string, year?: string, limit = 500): Promise<string[]> {
  const b = String(brand || '').trim().toUpperCase();
  if (!b || !model) return [];
  try {
    await ensureCompatModels();
  } catch (e) {
    console.error('[COMPAT] No se pudo crear la vista de modelos:', e);
    return [];
  }

  const y = year && year !== 'General' ? String(year).trim() : '';
  const wanted = cleanModelName(model);
  const rawNoDigits = wanted.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  const wantedNoDigits = rawNoDigits.replace(/[^a-z]/g, '').length >= 4 ? rawNoDigits : '';

  const modelsRes = y
    ? await pool.query(`SELECT DISTINCT model, year FROM ${MV} WHERE brand = $1 AND year = $2`, [b, y])
    : await pool.query(`SELECT DISTINCT model, year FROM ${MV} WHERE brand = $1`, [b]);

  const matches = modelsRes.rows.filter((r: any) => {
    const c = cleanModelName(r.model);
    return c === wanted || (wantedNoDigits && wantedNoDigits !== wanted && c === wantedNoDigits);
  }).slice(0, y ? MAX_MODELS : MAX_MODELS * 4);
  if (matches.length === 0) return [];

  // Una condición @> por modelo (y por año solo si se pide uno): el planner las combina con un BitmapOr
  // sobre el índice GIN. Sin año basta una por modelo distinto: con una por cada año, la Kawasaki Z 1000 SX
  // (57 variantes) tardaba minutos y varias a la vez dejaban Postgres al 580 % de CPU (9/11/2026).
  const targets = y ? matches : [...new Map(matches.map((r: any) => [r.model, r])).values()];
  const params: string[] = [];
  const conds = targets.map((r: any) => {
    const item: Record<string, unknown> = { brand: b, model: r.model };
    if (y) {
      const yearNum = Number(r.year);
      if (Number.isFinite(yearNum)) item.year = yearNum;
    }
    params.push(JSON.stringify([item]));
    return `compatibility @> $${params.length}::jsonb`;
  });
  params.push(String(limit));

  // Tope de tiempo: si una consulta se pone mal, se corta a los 10 s en vez de seguir quemando CPU cuando
  // la petición que la lanzó ya se ha rendido.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '10s'`);
    const res = await client.query(
      `SELECT sku FROM products WHERE status = 'published' AND (${conds.join(' OR ')}) LIMIT $${params.length}::int`,
      params
    );
    await client.query('COMMIT');
    return res.rows.map((r: any) => r.sku).filter(Boolean);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
