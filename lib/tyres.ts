/**
 * Neumáticos: medida normalizada (Ancho / Perfil / Llanta) y opciones del
 * buscador por medida y tipo.
 *
 * La medida se guarda en products.attributes para que el filtro genérico
 * `attrs` del catálogo sirva tal cual:
 *   120/70 ZR17 → { Ancho: '120', Perfil: '70', Llanta: '17' }
 *   3.00-18     → { Ancho: '3.00', Llanta: '18' }         (sin perfil)
 *   AT23X7-10   → { Ancho: '23x7', Llanta: '10' }         (ATV)
 *   MU85B16     → { Ancho: 'MU85', Llanta: '16' }         (alfanumérica)
 */
import { pool } from '../db.js';
import type { CsvInfo } from './catalog-enrich.js';

export const TYRE_ROOT_SLUG = 'neumaticos';
/** Subcategorías de Neumáticos que no son neumáticos (no llevan buscador). */
const NOT_TYRES = /camara|mousse|accesorio|valvula|fondo/i;

/** SQL: el producto está en Neumáticos y no en Cámaras/Mousses/Accesorios ($1 = tipos, $2 = excluidas). */
const IS_TYRE = `(category_id = ANY($1) OR category2_id = ANY($1) OR category3_id = ANY($1))
  AND NOT (COALESCE(category_id, 0) = ANY($2) OR COALESCE(category2_id, 0) = ANY($2) OR COALESCE(category3_id, 0) = ANY($2))`;

export interface TyreSize { Ancho: string; Perfil?: string; Llanta: string }

const num = (s: string) => s.replace(',', '.');

const METRIC = /(?<![\d.,])(\d{2,3}|\d[.,]\d{2})\s*\/\s*(\d{2,3})\s*(?:-|Z?R|B|\s)\s*(?:R\s*)?(\d{1,2}(?:[.,]5)?)(?!\d|\s*(?:mm|"|''))/i;
const IMPERIAL = /\b(\d{1,2}[.,]\d{2})\s*(?:-|B|R|\s)\s*(\d{1,2})\b/i;
const ATV = /(?:\bAT|(?<![\d.,(]))(\d{2})\s*[xX]\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:-|R|\s)?\s*(\d{1,2})\b/;
const ALPHA = /\b(M[A-Z]\d{2})\s*(?:-|B|\s)?\s*(\d{2})\b/;

export function parseTyreSize(text: string | null | undefined): TyreSize | null {
  const s = String(text || '');
  let m = s.match(ATV);
  // ATV: diámetro 16-35" × ancho 5-14" (descarta equivalencias como "(20x2.75)").
  if (m && +m[1] >= 16 && +m[1] <= 35 && parseFloat(num(m[2])) >= 5 && parseFloat(num(m[2])) <= 14) {
    return { Ancho: `${m[1]}x${String(parseFloat(num(m[2])))}`, Llanta: m[3] };
  }
  m = s.match(METRIC);
  if (m) return { Ancho: num(m[1]), Perfil: m[2], Llanta: num(m[3]) };
  m = s.match(ALPHA);
  if (m) return { Ancho: m[1].toUpperCase(), Llanta: m[2] };
  m = s.match(IMPERIAL);
  if (m) return { Ancho: num(m[1]), Llanta: m[2] };
  return null;
}

/** Medida a partir de las columnas del CSV de Bihr (respaldo si el nombre no la trae). */
function sizeFromCsv(attrs: Record<string, string> | undefined): TyreSize | null {
  if (!attrs) return null;
  const first = (v?: string) => (v || '').split('&')[0].trim();
  const ancho = num(first(attrs['Anchura del neumático']));
  const llanta = num(first(attrs['Diámetro de la llanta']));
  if (!ancho || !llanta) return null;
  const perfil = first(attrs['Altura del neumático (perfil)']);
  return { Ancho: ancho, Llanta: llanta, ...(perfil ? { Perfil: perfil } : {}) };
}

export function tyrePosition(text: string, csvValue?: string): string | null {
  const v = (csvValue || '').trim();
  if (/delantero\s*\/\s*trasero/i.test(v)) return 'Delantero/trasero';
  if (/^delantero/i.test(v)) return 'Delantero';
  if (/^trasero/i.test(v)) return 'Trasero';
  if (/\bfront\b|\(F\)|delantero/i.test(text)) return 'Delantero';
  if (/\brear\b|\(R\)|trasero/i.test(text)) return 'Trasero';
  return null;
}

/** Ids de las categorías que son neumáticos (raíz + tipos), sin cámaras ni accesorios. */
export async function tyreCategories(): Promise<{ rootId: number | null; ids: number[]; excluded: number[]; types: { id: number; name: string; slug: string }[] }> {
  const r = await pool.query(`
    WITH RECURSIVE t AS (
      SELECT id, name, slug, parent_id, 0 AS depth, true AS tyre FROM categories WHERE slug = $1
      UNION ALL
      SELECT c.id, c.name, c.slug, c.parent_id, t.depth + 1, t.tyre AND c.slug !~* $2 AND c.name !~* $2
      FROM categories c JOIN t ON c.parent_id = t.id
    ) SELECT id, name, slug, depth, tyre FROM t`, [TYRE_ROOT_SLUG, NOT_TYRES.source]);
  const rows = r.rows as { id: number; name: string; slug: string; depth: number; tyre: boolean }[];
  return {
    rootId: rows.find((x) => x.depth === 0)?.id ?? null,
    ids: rows.filter((x) => x.tyre).map((x) => x.id),
    excluded: rows.filter((x) => !x.tyre).map((x) => x.id),
    types: rows.filter((x) => x.depth === 1 && x.tyre).map(({ id, name, slug }) => ({ id, name, slug })),
  };
}

/**
 * Guarda Ancho/Perfil/Llanta/Posición en los neumáticos. Idempotente: solo
 * escribe las filas que cambian.
 */
export async function applyTyreAttributes(csvIndex?: Map<string, CsvInfo>): Promise<{ tyres: number; sized: number; updated: number }> {
  const { ids, excluded } = await tyreCategories();
  if (!ids.length) return { tyres: 0, sized: 0, updated: 0 };
  // Lo que ya no es neumático (p. ej. movido a Cámaras) pierde la medida.
  await pool.query(`
    UPDATE products SET attributes = attributes - 'Ancho' - 'Perfil' - 'Llanta', updated_at = NOW()
    WHERE jsonb_typeof(attributes) = 'object' AND attributes ? 'Ancho' AND NOT (${IS_TYRE})`, [ids, excluded]);
  const res = await pool.query(`
    SELECT id, name, supplier_name, part_number, attributes
    FROM products
    WHERE status IN ('published', 'duplicate', 'draft') AND ${IS_TYRE}`, [ids, excluded]);

  const idsOut: number[] = [];
  const patches: string[] = [];
  let sized = 0;
  for (const row of res.rows as any[]) {
    const attrs = row.attributes && typeof row.attributes === 'object' ? row.attributes : {};
    const csv = row.part_number ? csvIndex?.get(row.part_number)?.attrs : undefined;
    const merged = { ...attrs, ...(csv || {}) };
    const size = parseTyreSize(row.name) || parseTyreSize(row.supplier_name) || sizeFromCsv(merged);
    if (size) sized++;
    const next: Record<string, string | null> = {
      Ancho: size?.Ancho ?? null,
      Perfil: size?.Perfil ?? null,
      Llanta: size?.Llanta ?? null,
      Posición: tyrePosition(`${row.name} ${row.supplier_name || ''}`, merged['Posición']) ?? attrs['Posición'] ?? null,
    };
    if (csv) {
      for (const k of ['Estructura de neumático', 'Índice de carga del neumático (IC)', 'Índice de velocidad (CV)', 'Sin cámara o tipo de cámara', 'Categoría de neumático']) {
        if (csv[k]) next[k] = csv[k];
      }
    }
    const changed = Object.entries(next).some(([k, v]) => (attrs[k] ?? null) !== v);
    if (!changed) continue;
    idsOut.push(row.id);
    patches.push(JSON.stringify(next));
  }

  let updated = 0;
  for (let i = 0; i < idsOut.length; i += 1000) {
    const r = await pool.query(`
      UPDATE products p
      SET attributes = jsonb_strip_nulls(
            (CASE WHEN jsonb_typeof(p.attributes) = 'object' THEN p.attributes ELSE '{}'::jsonb END)
            - 'Ancho' - 'Perfil' - 'Llanta' || v.patch::jsonb),
          updated_at = NOW()
      FROM unnest($1::int[], $2::text[]) AS v(id, patch)
      WHERE p.id = v.id`, [idsOut.slice(i, i + 1000), patches.slice(i, i + 1000)]);
    updated += r.rowCount || 0;
  }
  return { tyres: res.rows.length, sized, updated };
}

interface TyreRow { a: string | null; p: string | null; l: string | null; pos: string | null; types: number[]; fam: string; stock: boolean }
let tyreRowsCache: { rows: TyreRow[]; types: { id: number; name: string; slug: string }[]; at: number } | null = null;

async function tyreRows() {
  if (tyreRowsCache && Date.now() - tyreRowsCache.at < 600_000) return tyreRowsCache;
  const { ids, excluded, types } = await tyreCategories();
  const r = await pool.query(`
    SELECT attributes->>'Ancho' AS a, attributes->>'Perfil' AS p, attributes->>'Llanta' AS l,
           attributes->>'Posición' AS pos,
           array_remove(ARRAY[category_id, category2_id, category3_id], NULL) AS types,
           COALESCE(family_code, sku) AS fam, stock > 0 AS stock
    FROM products
    WHERE status = 'published' AND ${IS_TYRE}`, [ids, excluded]);
  tyreRowsCache = { rows: r.rows as TyreRow[], types, at: Date.now() };
  return tyreRowsCache;
}

export interface TyreFilter { categoryId?: number | null; ancho?: string; perfil?: string; llanta?: string; posicion?: string }

const posMatches = (pos: string | null, wanted: string) =>
  !wanted || pos === wanted || pos === 'Delantero/trasero';

const sizeOrder = (a: string, b: string) => {
  const na = parseFloat(a.replace(/^[A-Z]+/i, '')), nb = parseFloat(b.replace(/^[A-Z]+/i, ''));
  return (Number.isNaN(na) ? 1e9 : na) - (Number.isNaN(nb) ? 1e9 : nb) || a.localeCompare(b);
};

/**
 * Opciones del buscador. Cada lista se calcula con el resto de filtros pero
 * sin el suyo, así el cliente puede cambiar un valor sin vaciar los demás.
 */
export async function tyreOptions(f: TyreFilter) {
  const { rows, types } = await tyreRows();
  const keep = (r: TyreRow, skip: keyof TyreFilter | 'type') =>
    (skip === 'categoryId' || !f.categoryId || r.types.includes(f.categoryId)) &&
    (skip === 'ancho' || !f.ancho || r.a === f.ancho) &&
    (skip === 'perfil' || !f.perfil || r.p === f.perfil) &&
    (skip === 'llanta' || !f.llanta || r.l === f.llanta) &&
    (skip === 'posicion' || posMatches(r.pos, f.posicion || ''));

  const facet = (skip: keyof TyreFilter, pick: (r: TyreRow) => string | null) => {
    const m = new Map<string, Set<string>>();
    for (const r of rows) {
      const v = pick(r);
      if (!v || !keep(r, skip)) continue;
      (m.get(v) || m.set(v, new Set()).get(v)!).add(r.fam);
    }
    return [...m].map(([value, s]) => ({ value, count: s.size })).sort((x, y) => sizeOrder(x.value, y.value));
  };

  const posCounts = { Delantero: new Set<string>(), Trasero: new Set<string>() };
  for (const r of rows) {
    if (!keep(r, 'posicion')) continue;
    if (posMatches(r.pos, 'Delantero') && r.pos) posCounts.Delantero.add(r.fam);
    if (posMatches(r.pos, 'Trasero') && r.pos) posCounts.Trasero.add(r.fam);
  }
  const typeCounts = types.map((t) => {
    const s = new Set<string>();
    for (const r of rows) if (r.types.includes(t.id) && keep(r, 'categoryId')) s.add(r.fam);
    return { ...t, count: s.size };
  });
  const matching = new Set<string>();
  for (const r of rows) if (keep(r, 'type')) matching.add(r.fam);

  // Medidas más vendidas/ofertadas para atajos: las combinaciones con más modelos.
  const combos = new Map<string, number>();
  for (const r of rows) {
    if (!r.a || !r.l || !keep(r, 'ancho') || f.perfil || f.llanta) continue;
    const k = r.p ? `${r.a}/${r.p}-${r.l}` : `${r.a}-${r.l}`;
    combos.set(k, (combos.get(k) || 0) + 1);
  }
  const popular = [...combos].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label]) => {
    const m = label.match(/^(.+?)(?:\/(\d+))?-(.+)$/)!;
    return { label, ancho: m[1], perfil: m[2] || null, llanta: m[3] };
  });

  return {
    ancho: facet('ancho', (r) => r.a),
    perfil: facet('perfil', (r) => r.p),
    llanta: facet('llanta', (r) => r.l),
    posicion: [
      { value: 'Delantero', count: posCounts.Delantero.size },
      { value: 'Trasero', count: posCounts.Trasero.size },
    ],
    tipos: typeCounts,
    popular,
    total: matching.size,
  };
}

export function invalidateTyreCache() { tyreRowsCache = null; }
