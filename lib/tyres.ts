/**
 * Neumáticos, cámaras y mousses: medida normalizada y opciones del buscador.
 *
 * Cada producto guarda en products.attributes.Medida la lista de medidas que
 * le sirven (un neumático, una; una cámara, varias), con formato canónico:
 *   120/70 ZR17 → '120/70-17'      3.00-18   → '3.00-18'
 *   AT23X7-10   → '23x7-10'        MU85B16   → 'MU85-16'
 *   Cámara 2.75/3.00-19            → ['2.75-19', '3.00-19']
 * El catálogo filtra por `attrs={"Medida":["120/70-17"]}`. Los neumáticos
 * conservan además Ancho/Perfil/Llanta/Posición para la ficha.
 */
import { pool } from '../db.js';
import type { CsvInfo } from './catalog-enrich.js';

export const TYRE_ROOT_SLUG = 'neumaticos';

export type SizedKind = 'tyre' | 'tube' | 'mousse';
/** attributes.TipoMedida: separa neumáticos, cámaras y mousses de una misma medida. */
export const KIND_LABEL: Record<SizedKind, string> = { tyre: 'Neumático', tube: 'Cámara', mousse: 'Mousse' };
/** Subcategorías de Neumáticos sin buscador por medida. */
const NO_FINDER = /accesorio|valvula|fondo/i;
const kindOfSlug = (slug: string, name: string): SizedKind | null => {
  const s = `${slug} ${name}`;
  if (/camara|cámara/i.test(s)) return 'tube';
  if (/mousse/i.test(s)) return 'mousse';
  if (NO_FINDER.test(s)) return null;
  return 'tyre';
};
/** Fondos de llanta y similares que viven en Cámaras pero no tienen medida de neumático. */
const NOT_SIZED = /fondo|rim tape|cinta|gel|herramienta|v[aá]lvula suelta/i;

export interface TyreSize { Ancho: string; Perfil?: string; Llanta: string }

const num = (s: string) => s.replace(',', '.');
export const sizeLabel = (z: TyreSize) => (z.Perfil ? `${z.Ancho}/${z.Perfil}-${z.Llanta}` : `${z.Ancho}-${z.Llanta}`);
export function parseLabel(label: string): TyreSize | null {
  const m = label.match(/^(.+?)(?:\/(\d+))?-([\d.]+)$/);
  return m ? { Ancho: m[1], ...(m[2] ? { Perfil: m[2] } : {}), Llanta: m[3] } : null;
}

const METRIC = /(?<![\d.,])(\d{2,3}|\d[.,]\d{2})\s*\/\s*(\d{2,3})\s*(?:-|Z?R|B|\s)\s*(?:R\s*)?(\d{1,2}(?:[.,]5)?)(?!\d|\s*(?:mm|"|''))/i;
const IMPERIAL = /\b(\d{1,2}[.,]\d{2})\s*(?:-|B|R|\s)\s*(\d{1,2})\b/i;
const ATV = /(?:\bAT|(?<![\d.,]))(\d{2})\s*[xX]\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:-|R|\s)?\s*(\d{1,2})\b/;
const ALPHA = /\b(M[A-Z]\d{2})\s*(?:-|B|\s)?\s*(\d{2})\b/;

/** ATV/jardín: diámetro 10-35" × ancho 5-14" (descarta equivalencias como "(20x2.75)"). */
const atvSize = (d: string, w: string, l: string): TyreSize | null =>
  +d >= 10 && +d <= 35 && parseFloat(num(w)) >= 5 && parseFloat(num(w)) <= 14
    ? { Ancho: `${d}x${String(parseFloat(num(w)))}`, Llanta: l } : null;

/** Medida de un neumático (la primera que aparece en el texto). */
export function parseTyreSize(text: string | null | undefined): TyreSize | null {
  const s = String(text || '');
  let m = s.match(ATV);
  const atv = m && atvSize(m[1], m[2], m[3]);
  if (atv) return atv;
  m = s.match(METRIC);
  if (m) return { Ancho: num(m[1]), Perfil: m[2], Llanta: num(m[3]) };
  m = s.match(ALPHA);
  if (m) return { Ancho: m[1].toUpperCase(), Llanta: m[2] };
  m = s.match(IMPERIAL);
  if (m) return { Ancho: num(m[1]), Llanta: m[2] };
  return null;
}

/**
 * Todas las medidas de un texto (cámaras y mousses). Entiende listas y rangos:
 *   "2.75/3.00-19", "140/80-17, 150/60-17", "120/130/70-12",
 *   "110, 120/90-19", "80-90/100-12", "4.00-10 , 4.50-10", "22X11.00-9".
 */
export function parseAllSizes(text: string | null | undefined): TyreSize[] {
  let s = ` ${String(text || '')} `;
  const out: TyreSize[] = [];
  const take = (re: RegExp, fn: (m: RegExpExecArray) => (TyreSize | null)[]) => {
    s = s.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const sizes = fn(m).filter((z): z is TyreSize => !!z);
      out.push(...sizes);
      return sizes.length ? ' '.repeat(String(args[0]).length) : String(args[0]);
    });
  };
  // ATV con dos anchos: 16X6.50/7.50-8
  take(/(?:\bAT|(?<![\d.,]))(\d{2})\s*[xX]\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*\/\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*-\s*(\d{1,2})\b/g,
    (m) => [atvSize(m[1], m[2], m[4]), atvSize(m[1], m[3], m[4])]);
  // ATV: 22X11.00-9
  take(/(?:\bAT|(?<![\d.,]))(\d{2})\s*[xX]\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:-|R|\s)?\s*(\d{1,2})\b(?![.,/]\d)/g,
    (m) => [atvSize(m[1], m[2], m[3])]);
  // Rango en pulgadas: 2.75/3.00-19
  take(/(?<![\d.,])(\d[.,]\d{2})\s*\/\s*(\d[.,]\d{2})\s*-\s*(\d{1,2})\b/g,
    (m) => [{ Ancho: num(m[1]), Llanta: m[3] }, { Ancho: num(m[2]), Llanta: m[3] }]);
  // Métrica con dos anchos: 120/130/70-12, "110, 120/90-19", 80-90/100-12. El primer
  // ancho no puede seguir a un guion (en "140/80-17, 150/60-17" el 17 es la llanta).
  const two = (m: RegExpExecArray) => [m[1], m[2]].filter((w) => +w >= 50)
    .map((w) => ({ Ancho: w, Perfil: m[3], Llanta: num(m[4]) }));
  take(/(?<![\d.,/-])(\d{2,3})\s*\/\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*-\s*(\d{1,2})\b/g, two);
  take(/(?<![\d.,/-])(\d{2,3})\s*,\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*-\s*(\d{1,2})\b/g, two);
  take(/(?<![\d.,/-])(\d{2,3})\s*-\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*-\s*(\d{1,2})\b/g, two);
  // Métrica: 120/70-17, 120/70 ZR17
  take(/(?<![\d.,/])(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:-|Z?R|B|\s)\s*(?:R\s*)?(\d{1,2}(?:[.,]5)?)(?!\d|\s*(?:mm|"|''|[.,]\d))/gi,
    (m) => [{ Ancho: m[1], Perfil: m[2], Llanta: num(m[3]) }]);
  take(/\b(M[A-Z]\d{2})\s*(?:-|B|\s)?\s*(\d{2})\b/g, (m) => [{ Ancho: m[1].toUpperCase(), Llanta: m[2] }]);
  // Pulgadas sueltas: 4.00-10
  take(/(?<![\d.,/])(\d[.,]\d{2})\s*(?:-|B|R|\s)\s*(\d{1,2})\b/g, (m) => [{ Ancho: num(m[1]), Llanta: m[2] }]);
  const seen = new Set<string>();
  return out.filter((z) => !seen.has(sizeLabel(z)) && !!seen.add(sizeLabel(z)));
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

interface SizedCategories {
  rootId: number | null;
  /** id de categoría → tipo de producto con medida (null = sin buscador) */
  kinds: Map<number, SizedKind | null>;
  /** Tipos de neumático (subcategorías de primer nivel) */
  types: { id: number; name: string; slug: string }[];
}

export async function sizedCategories(): Promise<SizedCategories> {
  const r = await pool.query(`
    WITH RECURSIVE t AS (
      SELECT id, name, slug, parent_id, 0 AS depth, NULL::text AS branch FROM categories WHERE slug = $1
      UNION ALL
      SELECT c.id, c.name, c.slug, c.parent_id, t.depth + 1, COALESCE(t.branch, c.slug || ' ' || c.name)
      FROM categories c JOIN t ON c.parent_id = t.id
    ) SELECT id, name, slug, depth, branch FROM t`, [TYRE_ROOT_SLUG]);
  const rows = r.rows as { id: number; name: string; slug: string; depth: number; branch: string | null }[];
  const kinds = new Map<number, SizedKind | null>();
  for (const x of rows) {
    // La rama (subcategoría de primer nivel) decide; también su propio nombre.
    const own = kindOfSlug(x.slug, x.name);
    const branch = x.branch ? kindOfSlug(x.branch, '') : 'tyre';
    kinds.set(x.id, x.depth === 0 ? 'tyre' : branch === 'tyre' ? own : branch);
  }
  return {
    rootId: rows.find((x) => x.depth === 0)?.id ?? null,
    kinds,
    types: rows.filter((x) => x.depth === 1 && kinds.get(x.id) === 'tyre').map(({ id, name, slug }) => ({ id, name, slug })),
  };
}

/** Tipo de un producto según sus categorías: la más específica que no sea la raíz manda. */
function productKind(cats: (number | null)[], c: SizedCategories): SizedKind | null {
  let kind: SizedKind | null | undefined;
  for (const id of cats) {
    if (id == null || id === c.rootId || !c.kinds.has(id)) continue;
    kind = c.kinds.get(id) ?? null;
  }
  return kind === undefined ? (cats.includes(c.rootId) ? 'tyre' : null) : kind;
}

/**
 * Guarda la medida (y en neumáticos Ancho/Perfil/Llanta/Posición e índices).
 * Idempotente: solo escribe las filas que cambian.
 */
export async function applyTyreAttributes(csvIndex?: Map<string, CsvInfo>): Promise<{ tyres: number; tubes: number; sized: number; updated: number }> {
  const cats = await sizedCategories();
  const allIds = [...cats.kinds.keys()];
  if (!allIds.length) return { tyres: 0, tubes: 0, sized: 0, updated: 0 };
  const res = await pool.query(`
    SELECT id, name, supplier_name, part_number, attributes, category_id, category2_id, category3_id
    FROM products
    WHERE status IN ('published', 'duplicate', 'draft')
      AND ((category_id = ANY($1) OR category2_id = ANY($1) OR category3_id = ANY($1))
           OR (jsonb_typeof(attributes) = 'object' AND attributes ? 'Medida'))`, [allIds]);

  const idsOut: number[] = [];
  const patches: string[] = [];
  let sized = 0, tyres = 0, tubes = 0;
  for (const row of res.rows as any[]) {
    const attrs = row.attributes && typeof row.attributes === 'object' ? row.attributes : {};
    const kind = productKind([row.category_id, row.category2_id, row.category3_id], cats);
    const next: Record<string, unknown> = { Medida: null, Ancho: null, Perfil: null, Llanta: null, TipoMedida: kind ? KIND_LABEL[kind] : null };

    if (kind === 'tyre') {
      tyres++;
      const csv = row.part_number ? csvIndex?.get(row.part_number)?.attrs : undefined;
      const merged = { ...attrs, ...(csv || {}) };
      const size = parseTyreSize(row.name) || parseTyreSize(row.supplier_name) || sizeFromCsv(merged);
      if (size) {
        sized++;
        Object.assign(next, { Medida: [sizeLabel(size)], Ancho: size.Ancho, Perfil: size.Perfil ?? null, Llanta: size.Llanta });
      }
      next['Posición'] = tyrePosition(`${row.name} ${row.supplier_name || ''}`, merged['Posición']) ?? attrs['Posición'] ?? null;
      if (csv) {
        for (const k of ['Estructura de neumático', 'Índice de carga del neumático (IC)', 'Índice de velocidad (CV)', 'Sin cámara o tipo de cámara', 'Categoría de neumático']) {
          if (csv[k]) next[k] = csv[k];
        }
      }
    } else if (kind === 'tube' || kind === 'mousse') {
      tubes++;
      if (!NOT_SIZED.test(row.name || '')) {
        let sizes = parseAllSizes(row.name);
        if (!sizes.length) sizes = parseAllSizes(row.supplier_name);
        if (sizes.length) { sized++; next.Medida = sizes.map(sizeLabel); }
      }
    }

    const changed = Object.entries(next).some(([k, v]) => JSON.stringify(attrs[k] ?? null) !== JSON.stringify(v));
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
            - 'Medida' - 'Ancho' - 'Perfil' - 'Llanta' - 'TipoMedida' || v.patch::jsonb),
          updated_at = NOW()
      FROM unnest($1::int[], $2::text[]) AS v(id, patch)
      WHERE p.id = v.id`, [idsOut.slice(i, i + 1000), patches.slice(i, i + 1000)]);
    updated += r.rowCount || 0;
  }
  invalidateTyreCache();
  return { tyres, tubes, sized, updated };
}

interface SizedRow { kind: SizedKind; sizes: TyreSize[]; pos: string | null; cats: number[]; fam: string }
let rowsCache: { rows: SizedRow[]; cats: SizedCategories; at: number } | null = null;

async function sizedRows() {
  if (rowsCache && Date.now() - rowsCache.at < 600_000) return rowsCache;
  const cats = await sizedCategories();
  const r = await pool.query(`
    SELECT attributes->'Medida' AS medida, attributes->>'Posición' AS pos,
           array_remove(ARRAY[category_id, category2_id, category3_id], NULL) AS cats,
           COALESCE(family_code, sku) AS fam
    FROM products
    WHERE status = 'published' AND jsonb_typeof(attributes) = 'object' AND attributes ? 'Medida'`);
  const rows: SizedRow[] = [];
  for (const x of r.rows as any[]) {
    const kind = productKind(x.cats, cats);
    if (!kind) continue;
    const labels: string[] = Array.isArray(x.medida) ? x.medida : [x.medida];
    const sizes = labels.map((l) => parseLabel(String(l))).filter((z): z is TyreSize => !!z);
    if (sizes.length) rows.push({ kind, sizes, pos: x.pos, cats: x.cats, fam: x.fam });
  }
  rowsCache = { rows, cats, at: Date.now() };
  return rowsCache;
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
 * Con varias medidas por producto, todos los filtros se aplican a la misma medida.
 */
export async function tyreOptions(f: TyreFilter) {
  const { rows: all, cats } = await sizedRows();
  const kind: SizedKind = (f.categoryId && f.categoryId !== cats.rootId && cats.kinds.get(f.categoryId)) || 'tyre';
  const rows = all.filter((r) => r.kind === kind);
  type Skip = 'categoryId' | 'ancho' | 'perfil' | 'llanta' | 'posicion' | null;

  const sizeOk = (z: TyreSize, skip: Skip) =>
    (skip === 'ancho' || !f.ancho || z.Ancho === f.ancho) &&
    (skip === 'perfil' || !f.perfil || z.Perfil === f.perfil) &&
    (skip === 'llanta' || !f.llanta || z.Llanta === f.llanta);
  const rowOk = (r: SizedRow, skip: Skip) =>
    (skip === 'categoryId' || !f.categoryId || f.categoryId === cats.rootId || r.cats.includes(f.categoryId)) &&
    (skip === 'posicion' || kind !== 'tyre' || posMatches(r.pos, f.posicion || ''));

  const facet = (skip: Skip, pick: (z: TyreSize) => string | undefined) => {
    const m = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!rowOk(r, skip)) continue;
      for (const z of r.sizes) {
        const v = pick(z);
        if (!v || !sizeOk(z, skip)) continue;
        (m.get(v) || m.set(v, new Set()).get(v)!).add(r.fam);
      }
    }
    return [...m].map(([value, s]) => ({ value, count: s.size })).sort((x, y) => sizeOrder(x.value, y.value));
  };
  const matches = (r: SizedRow, skip: Skip) => rowOk(r, skip) && r.sizes.some((z) => sizeOk(z, skip));

  const posCounts = { Delantero: new Set<string>(), Trasero: new Set<string>() };
  if (kind === 'tyre') {
    for (const r of rows) {
      if (!r.pos || !matches(r, 'posicion')) continue;
      if (posMatches(r.pos, 'Delantero')) posCounts.Delantero.add(r.fam);
      if (posMatches(r.pos, 'Trasero')) posCounts.Trasero.add(r.fam);
    }
  }
  const typeCounts = kind !== 'tyre' ? [] : cats.types.map((t) => {
    const s = new Set<string>();
    for (const r of rows) if (r.cats.includes(t.id) && matches(r, 'categoryId')) s.add(r.fam);
    return { ...t, count: s.size };
  });
  const matching = new Set<string>();
  for (const r of rows) if (matches(r, null)) matching.add(r.fam);

  // Atajos: las medidas con más modelos (sin tener en cuenta lo elegido en la medida).
  const combos = new Map<string, Set<string>>();
  if (!f.perfil && !f.llanta) {
    for (const r of rows) {
      if (!rowOk(r, null)) continue;
      for (const z of r.sizes) {
        if (f.ancho && z.Ancho !== f.ancho) continue;
        const k = sizeLabel(z);
        (combos.get(k) || combos.set(k, new Set()).get(k)!).add(r.fam);
      }
    }
  }
  const popular = [...combos].sort((a, b) => b[1].size - a[1].size).slice(0, 8).map(([label]) => {
    const z = parseLabel(label)!;
    return { label, ancho: z.Ancho, perfil: z.Perfil || null, llanta: z.Llanta };
  });

  return {
    kind,
    ancho: facet('ancho', (z) => z.Ancho),
    perfil: facet('perfil', (z) => z.Perfil),
    llanta: facet('llanta', (z) => z.Llanta),
    posicion: kind === 'tyre' ? [
      { value: 'Delantero', count: posCounts.Delantero.size },
      { value: 'Trasero', count: posCounts.Trasero.size },
    ] : [],
    tipos: typeCounts,
    popular,
    total: matching.size,
  };
}

export function invalidateTyreCache() { rowsCache = null; }
