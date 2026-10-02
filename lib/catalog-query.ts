/**
 * Consulta del catálogo: búsqueda, filtros, facetas y agrupación por modelo.
 *
 * Listado y facetas comparten buildConditions(), así los recuentos que ve el
 * cliente en cada filtro corresponden siempre a los resultados.
 *
 * Búsqueda (sin dependencias externas):
 *   - texto normalizado en products.search_text (minúsculas, sin tildes;
 *     incluye nombre en español, nombre del proveedor, marca, SKU, nº de pieza,
 *     EAN) con índice trigram;
 *   - cada palabra de la consulta debe aparecer (AND), aceptando plural/singular
 *     y sinónimos español↔inglés del proveedor (cadena ↔ chain…);
 *   - si no hay resultados, segunda pasada tolerante a erratas
 *     (word_similarity de pg_trgm).
 */
import { pool } from '../db.js';

export type SortKey = 'relevance' | 'price_asc' | 'price_desc' | 'name_asc' | 'newest';

export interface CatalogParams {
  search?: string;
  categoryId?: number | null;
  categorySlug?: string;
  brands?: string[];
  minPriceCents?: number | null;
  maxPriceCents?: number | null;
  inStock?: boolean;
  attrs?: Record<string, string[]>;
  universal?: boolean;
}

// Palabra en español → términos que aparecen en los nombres del proveedor.
// Las claves y valores ya van en minúsculas y sin tildes.
const SYNONYMS: Record<string, string[]> = {
  cadena: ['chain'],
  corona: ['sprocket', 'rr sproc', 'sproc'],
  pinon: ['sprocket', 'fr sproc', 'sproc'],
  'kit de arrastre': ['chain kit'],
  'kit arrastre': ['chain kit'],
  transmision: ['chain kit', 'chain'],
  pastilla: ['brake pad', 'pad'],
  freno: ['brake'],
  disco: ['disc'],
  pinza: ['caliper'],
  latiguillo: ['brake line', 'hose'],
  maneta: ['lever'],
  bomba: ['master cylinder', 'pump'],
  casco: ['helmet', 'helmt'],
  visera: ['peak', 'visor'],
  pantalla: ['shield', 'visor'],
  guante: ['glove'],
  chaqueta: ['jacket'],
  cazadora: ['jacket'],
  pantalon: ['pant', 'trouser'],
  bota: ['boot'],
  mono: ['suit'],
  camiseta: ['jersey', 't-shirt', 'tee'],
  sudadera: ['hoodie', 'sweat'],
  gafa: ['goggle', 'glasses'],
  protector: ['protector', 'guard'],
  espaldera: ['back protector'],
  rodillera: ['knee'],
  maleta: ['case', 'top case', 'pannier'],
  bolsa: ['bag'],
  mochila: ['backpack', 'bag'],
  escape: ['exhaust', 'silencer', 'muffler', 'slip on', 'slip-on'],
  silencioso: ['silencer', 'muffler'],
  filtro: ['filter'],
  aceite: ['oil'],
  neumatico: ['tyre', 'tire'],
  rueda: ['wheel', 'tyre'],
  camara: ['tube', 'inner tube'],
  bujia: ['spark plug', 'plug'],
  bateria: ['battery'],
  cargador: ['charger'],
  espejo: ['mirror'],
  retrovisor: ['mirror'],
  manillar: ['handlebar'],
  puno: ['grip'],
  intermitente: ['indicator', 'turn signal', 'blinker'],
  faro: ['headlight', 'light'],
  piloto: ['tail light', 'light'],
  embrague: ['clutch'],
  amortiguador: ['shock'],
  horquilla: ['fork'],
  reten: ['seal'],
  rodamiento: ['bearing'],
  junta: ['gasket'],
  carburador: ['carburetor', 'carb'],
  piston: ['piston'],
  cilindro: ['cylinder'],
  correa: ['belt'],
  variador: ['variator'],
  cable: ['cable'],
  cubrecarter: ['skid plate', 'engine guard'],
  defensa: ['crash bar', 'guard'],
  estribera: ['footpeg', 'peg'],
  caballete: ['stand'],
  funda: ['cover'],
  candado: ['lock'],
  antirrobo: ['lock', 'disc lock'],
  intercomunicador: ['intercom', 'communication'],
  herramienta: ['tool'],
  limpiador: ['cleaner'],
  grasa: ['grease'],
  lubricante: ['lube', 'lubricant'],
};

export function normalizeText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ñ/g, 'n');
}

/** Formas alternativas de una palabra: singular, sinónimos. */
function termVariants(term: string): string[] {
  const out = new Set<string>([term]);
  const singulars: string[] = [];
  if (term.length > 4 && term.endsWith('es')) singulars.push(term.slice(0, -2));
  if (term.length > 3 && term.endsWith('s')) singulars.push(term.slice(0, -1));
  for (const s of singulars) out.add(s);
  for (const base of [term, ...singulars]) {
    for (const syn of SYNONYMS[base] || []) out.add(syn);
  }
  return [...out].filter((v) => v.length >= 2);
}

export function searchTerms(search: string): string[] {
  const q = normalizeText(search)
    .replace(/[^a-z0-9.\-/ ]+/g, ' ')
    // "10w-40" / "10w.40" → "10w40" (search_text guarda ambas formas)
    .replace(/([a-z0-9])[-./]([a-z0-9])/g, '$1$2')
    .trim();
  if (!q) return [];
  // Frases compuestas con sinónimo propio ("kit de arrastre") como un solo término.
  const terms: string[] = [];
  let rest = ` ${q} `;
  for (const phrase of Object.keys(SYNONYMS).filter((k) => k.includes(' '))) {
    if (rest.includes(` ${phrase} `)) {
      terms.push(phrase);
      rest = rest.replace(` ${phrase} `, ' ');
    }
  }
  const stop = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'para', 'con', 'y', 'en', 'a', 'un', 'una']);
  for (const w of rest.split(/\s+/)) if (w && !stop.has(w) && w.length >= 2) terms.push(w);
  return terms.slice(0, 8);
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

class Sql {
  parts: string[] = [];
  params: unknown[] = [];
  add(fragment: string, ...values: unknown[]): this {
    // Los marcadores ? se sustituyen por $n en orden.
    let i = 0;
    this.parts.push(fragment.replace(/\?/g, () => {
      this.params.push(values[i++]);
      return `$${this.params.length}`;
    }));
    return this;
  }
  get text(): string {
    return this.parts.join(' ');
  }
}

export type Exclude = 'brand' | 'price' | { attr: string } | null;

/** Umbral de similitud para la búsqueda tolerante a erratas (pg_trgm, 0-1). */
const FUZZY_THRESHOLD = 0.4;

/** Ejecuta una consulta; en modo tolerante baja el umbral de pg_trgm solo para ella. */
async function q(text: string, values: unknown[], fuzzy = false) {
  if (!fuzzy) return pool.query(text, values);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = ${FUZZY_THRESHOLD}`);
    await client.query(`SET LOCAL pg_trgm.similarity_threshold = ${FUZZY_THRESHOLD}`);
    const res = await client.query(text, values);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * "casco arai talla m" → busca "casco arai" filtrando Talla = M (las tallas
 * no aparecen en el nombre del modelo).
 */
export function withSizeFromSearch(params: CatalogParams): CatalogParams {
  if (!params.search) return params;
  const m = params.search.match(/\btalla\s+([a-z0-9]{1,4}(?:\/[a-z0-9]{1,4})?)\b/i);
  if (!m) return params;
  const size = m[1].toUpperCase();
  const rest = params.search.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  const attrs = { ...(params.attrs || {}) };
  attrs.Talla = Array.from(new Set([...(attrs.Talla || []), size]));
  return { ...params, search: rest || undefined, attrs };
}

/**
 * Condiciones WHERE sobre products p. `fuzzy` activa la tolerancia a erratas.
 * `exclude` omite un filtro (para calcular su propia faceta).
 */
export function buildConditions(params: CatalogParams, opts: { fuzzy?: boolean; exclude?: Exclude } = {}): Sql {
  const q = new Sql();
  q.add(`p.status = 'published' AND p.price > 0`);

  const terms = params.search ? searchTerms(params.search) : [];
  for (const term of terms) {
    const variants = termVariants(term);
    if (opts.fuzzy) {
      const ors = variants.map(() => `(? <% p.search_text)`).join(' OR ');
      q.add(`AND (${ors})`, ...variants);
    } else {
      const ors = variants.map(() => `p.search_text LIKE ? ESCAPE '\\'`).join(' OR ');
      q.add(`AND (${ors})`, ...variants.map((v) => `%${likeEscape(v)}%`));
    }
  }

  if (params.categoryId) {
    q.add(`AND (p.category_id = ANY(?) OR p.category2_id = ANY(?) OR p.category3_id = ANY(?))`,
      '{CAT}', '{CAT}', '{CAT}');
  } else if (params.categorySlug) {
    q.add(`AND p.category_id IN (
      WITH RECURSIVE c AS (
        SELECT id FROM categories WHERE LOWER(slug) = ? OR LOWER(name) = ?
        UNION ALL SELECT ch.id FROM categories ch JOIN c ON ch.parent_id = c.id
      ) SELECT id FROM c)`, params.categorySlug.toLowerCase(), params.categorySlug.toLowerCase());
  }

  if (params.universal) {
    q.add(`AND (p.compatibility IS NULL OR p.compatibility = '[]'::jsonb)`);
  }

  if (opts.exclude !== 'brand' && params.brands?.length) {
    q.add(`AND LOWER(p.brand) = ANY(?)`, params.brands.map((b) => b.toLowerCase()));
  }

  const eff = `COALESCE(NULLIF(p.sale_price, 0), p.price)`;
  if (opts.exclude !== 'price') {
    if (params.minPriceCents != null) q.add(`AND ${eff} >= ?`, params.minPriceCents);
    if (params.maxPriceCents != null) q.add(`AND ${eff} <= ?`, params.maxPriceCents);
  }

  if (params.inStock) q.add(`AND p.stock > 0`);

  for (const [key, values] of Object.entries(params.attrs || {})) {
    if (!values.length) continue;
    if (opts.exclude && typeof opts.exclude === 'object' && opts.exclude.attr === key) continue;
    q.add(`AND (p.variant_options ->> ? = ANY(?) OR p.attributes ->> ? = ANY(?))`, key, values, key, values);
  }
  return q;
}

/** Ids de la categoría y todos sus descendientes (cacheado en memoria 10 min). */
const catCache = new Map<number, { ids: number[]; at: number }>();
export async function categoryTree(id: number): Promise<number[]> {
  const hit = catCache.get(id);
  if (hit && Date.now() - hit.at < 600_000) return hit.ids;
  const res = await pool.query(`
    WITH RECURSIVE c AS (
      SELECT id FROM categories WHERE id = $1
      UNION ALL SELECT ch.id FROM categories ch JOIN c ON ch.parent_id = c.id
    ) SELECT id FROM c`, [id]);
  const ids = res.rows.map((r: any) => r.id);
  catCache.set(id, { ids, at: Date.now() });
  return ids;
}

async function resolve(params: CatalogParams, q: Sql): Promise<{ text: string; values: unknown[] }> {
  const tree = params.categoryId ? await categoryTree(params.categoryId) : [];
  return { text: q.text, values: q.params.map((v) => (v === '{CAT}' ? tree : v)) };
}

const ORDER: Record<SortKey, string> = {
  relevance: 'f.score DESC, f.any_stock DESC, f.newest DESC',
  price_asc: 'f.pmin ASC, f.family_code',
  price_desc: 'f.pmax DESC, f.family_code',
  name_asc: 'f.nmin ASC, f.family_code',
  newest: 'f.newest DESC, f.family_code',
};

export interface FamilyRow {
  family_code: string;
  n: number;
  pmin: number;
  pmax: number;
  any_stock: boolean;
  nmin: string;
  nmax: string;
  nmode?: string;
  rep_id: number;
  opts: Record<string, string[]> | null;
}

/** Nombre común de un modelo: prefijo compartido por todas sus variantes. */
export function familyTitle(nmin: string, nmax: string, fallback: string, mostCommon?: string): string {
  if (!nmin || !nmax || nmin === nmax) return fallback;
  const reference = (mostCommon || fallback || '').replace(/\s+/g, ' ').trim();
  let i = 0;
  while (i < nmin.length && i < nmax.length && nmin[i] === nmax[i]) i++;
  let prefix = nmin.slice(0, i);
  // Cortar en límite de palabra y quitar separadores y "Talla"/"talla EU" colgando.
  prefix = prefix.replace(/\S*$/, '').replace(/[\s,\-–/(]+$/, '').replace(/\b(talla|size)(\s+eu)?$/i, '').trim();
  // Si los nombres difieren pronto (doble espacio, palabra cambiada de sitio)
  // el prefijo común se queda en "Casco modular": mejor el nombre más repetido.
  if (prefix.length < 8 || prefix.length < reference.length * 0.6) return reference || fallback;
  return prefix;
}

/**
 * Corrige palabras sin resultados usando el vocabulario del catálogo
 * (catalog_words). Devuelve la consulta corregida o null si no hay cambios.
 */
export async function correctSearch(search: string): Promise<string | null> {
  const terms = searchTerms(search);
  if (!terms.length) return null;
  let changed = false;
  const out: string[] = [];
  for (const term of terms) {
    if (term.length < 4 || /\d/.test(term) || term.includes(' ')) { out.push(term); continue; }
    try {
      const exists = await pool.query('SELECT 1 FROM catalog_words WHERE word = $1 OR word = $2 LIMIT 1', [term, term.replace(/e?s$/, '')]);
      if (exists.rows.length) { out.push(term); continue; }
      // Solo palabras de longitud parecida y bastante similares: así "motul"
      // (marca que no está en el catálogo) no se convierte en "mot".
      const best = await q(
        `SELECT word FROM catalog_words
         WHERE word % $1 AND similarity(word, $1) >= 0.5 AND abs(length(word) - length($1)) <= 2 AND length(word) >= 4
         ORDER BY similarity(word, $1) DESC, freq DESC LIMIT 1`, [term], true);
      if (best.rows.length) { out.push(best.rows[0].word); changed = true; } else out.push(term);
    } catch {
      return null; // vocabulario aún no creado
    }
  }
  return changed ? out.join(' ') : null;
}

export async function listFamilies(rawParams: CatalogParams, sort: SortKey, page: number, perPage: number) {
  const params = withSizeFromSearch(rawParams);
  const run = async (fuzzy: boolean) => {
    const cond = await resolve(params, buildConditions(params, { fuzzy }));
    const terms = params.search ? searchTerms(params.search) : [];
    const values: unknown[] = [...cond.values];
    const ph = (v: unknown) => { values.push(v); return `$${values.length}`; };
    // Relevancia por palabra: nombre que empieza por ella (3) > palabra dentro
    // del nombre (2) > dentro del nombre (1) > solo en marca/referencias (0,5).
    const nameNorm = `lower(immutable_unaccent(p.name))`;
    const termScores = terms.map((term) => {
      const cases = termVariants(term).map((v) => {
        const e = likeEscape(v);
        return `CASE WHEN ${nameNorm} LIKE ${ph(`${e}%`)} THEN 3
                     WHEN ${nameNorm} LIKE ${ph(`% ${e}%`)} THEN 2
                     WHEN ${nameNorm} LIKE ${ph(`%${e}%`)} THEN 1
                     ELSE 0.5 END`;
      });
      // + parecido de la palabra con el nombre (ayuda con erratas: "pastilas").
      return `(${cases.length > 1 ? `GREATEST(${cases.join(', ')})` : cases[0]} + word_similarity(${ph(term)}, ${nameNorm}))`;
    });
    const scoreExpr = terms.length
      ? `(${termScores.join(' + ')}) + word_similarity(${ph(normalizeText(params.search!))}, p.search_text)`
      : '0';
    const order = ORDER[sort === 'relevance' && !terms.length ? 'relevance' : sort] || ORDER.relevance;
    const offset = (page - 1) * perPage;
    const sqlText = `
      WITH base AS (
        SELECT p.id, COALESCE(p.family_code, p.sku) AS family_code, p.name, p.stock, p.created_at,
               p.variant_options, COALESCE(NULLIF(p.sale_price, 0), p.price) AS eff, ${scoreExpr} AS score
        FROM products p
        WHERE ${cond.text}
      ),
      f AS (
        SELECT family_code, count(*)::int AS n, min(eff) AS pmin, max(eff) AS pmax,
               bool_or(stock > 0) AS any_stock, max(created_at) AS newest,
               min(name) AS nmin, max(name) AS nmax, max(score) AS score,
               mode() WITHIN GROUP (ORDER BY name) AS nmode,
               (array_agg(id ORDER BY (stock > 0) DESC, eff ASC, id))[1] AS rep_id
        FROM base GROUP BY family_code
      ),
      page AS (
        SELECT f.*, count(*) OVER()::int AS total, sum(f.n) OVER()::int AS refs FROM f
        ORDER BY ${order}
        LIMIT ${perPage} OFFSET ${offset}
      )
      SELECT page.*,
             (SELECT jsonb_object_agg(k, vals) FROM (
                SELECT k, jsonb_agg(DISTINCT v ORDER BY v) AS vals
                FROM base b, jsonb_each_text(COALESCE(b.variant_options, '{}'::jsonb)) AS e(k, v)
                WHERE b.family_code = page.family_code
                GROUP BY k) o) AS opts
      FROM page`;
    return q(sqlText, values, fuzzy);
  };

  let res = await run(false);
  let fuzzy = false;
  let corrected: string | null = null;
  if (res.rows.length === 0 && params.search) {
    // 1) ¿Errata? Probar con la consulta corregida por el vocabulario del catálogo.
    corrected = await correctSearch(params.search);
    if (corrected) {
      const retry = await listFamilies({ ...rawParams, search: corrected }, sort, page, perPage);
      if (retry.total > 0) return { ...retry, corrected };
    }
    // 2) Búsqueda tolerante por similitud.
    res = await run(true);
    fuzzy = true;
  }
  const total = res.rows[0]?.total || 0;
  // Referencias (cada talla/color) además de modelos (tarjetas).
  const refs = res.rows[0]?.refs || 0;
  return { rows: res.rows as (FamilyRow & { total: number })[], total, refs, fuzzy, corrected: null as string | null };
}

/** Facetas: marcas, rango de precio y atributos, con recuento por modelo. */
export async function facets(rawParams: CatalogParams) {
  let params = withSizeFromSearch(rawParams);
  const hasExact = async (p: CatalogParams) => {
    const c = await resolve(p, buildConditions(p));
    const r = await q(`SELECT 1 FROM products p WHERE ${c.text} LIMIT 1`, c.values);
    return r.rows.length > 0;
  };
  // Mismo criterio que listFamilies: exacta → corregida → tolerante.
  let fuzzy = false;
  if (params.search && !(await hasExact(params))) {
    const corrected = await correctSearch(params.search);
    if (corrected && (await hasExact({ ...params, search: corrected }))) params = { ...params, search: corrected };
    else fuzzy = true;
  }

  const brandsQ = await resolve(params, buildConditions(params, { fuzzy, exclude: 'brand' }));
  const priceQ = await resolve(params, buildConditions(params, { fuzzy, exclude: 'price' }));
  const allQ = await resolve(params, buildConditions(params, { fuzzy }));

  const [brands, price, attrs] = await Promise.all([
    q(`SELECT p.brand AS value, count(DISTINCT COALESCE(p.family_code, p.sku))::int AS count
                FROM products p WHERE ${brandsQ.text} AND p.brand IS NOT NULL AND p.brand <> ''
                GROUP BY p.brand ORDER BY count DESC, p.brand LIMIT 200`, brandsQ.values, fuzzy),
    q(`SELECT min(COALESCE(NULLIF(p.sale_price, 0), p.price)) AS min,
                       max(COALESCE(NULLIF(p.sale_price, 0), p.price)) AS max
                FROM products p WHERE ${priceQ.text}`, priceQ.values, fuzzy),
    q(`SELECT e.k AS key, e.v AS value, count(DISTINCT COALESCE(p.family_code, p.sku))::int AS count
                FROM products p, jsonb_each_text(COALESCE(p.variant_options, '{}'::jsonb)) AS e(k, v)
                WHERE ${allQ.text}
                GROUP BY e.k, e.v`, allQ.values, fuzzy),
  ]);

  // Para cada eje ya filtrado, sus valores se calculan sin ese filtro (así se
  // pueden marcar varios valores del mismo eje).
  const attrMap: Record<string, { value: string; count: number }[]> = {};
  for (const r of attrs.rows as any[]) (attrMap[r.key] ||= []).push({ value: r.value, count: r.count });
  for (const key of Object.keys(params.attrs || {})) {
    const qq = await resolve(params, buildConditions(params, { fuzzy, exclude: { attr: key } }));
    const r = await q(
      `SELECT p.variant_options ->> $${qq.values.length + 1} AS value, count(DISTINCT COALESCE(p.family_code, p.sku))::int AS count
       FROM products p WHERE ${qq.text} AND p.variant_options ? $${qq.values.length + 1}
       GROUP BY 1`, [...qq.values, key], fuzzy);
    attrMap[key] = r.rows.map((x: any) => ({ value: x.value, count: x.count }));
  }
  for (const list of Object.values(attrMap)) list.sort(compareOptionValues);

  return {
    brands: brands.rows as { value: string; count: number }[],
    priceMinCents: Number(price.rows[0]?.min || 0),
    priceMaxCents: Number(price.rows[0]?.max || 0),
    attributes: attrMap,
    fuzzy,
  };
}

const SIZE_ORDER = ['XXXS', '3XS', 'XXS', '2XS', 'XS', 'XS/S', 'S', 'S/M', 'M', 'M/L', 'L', 'L/XL', 'XL', 'XL/2XL', 'XL/XXL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];

/** Clave de orden: tallas de letra, luego numéricas (38, 10/L…), luego infantiles (Y…), luego el resto. */
function optionSortKey(value: string): [number, number, string] {
  const v = value.toUpperCase().trim();
  const letter = SIZE_ORDER.indexOf(v);
  if (letter >= 0) return [0, letter, v];
  const num = v.match(/^(\d+(?:[.,]\d+)?)/);
  if (num) return [1, parseFloat(num[1].replace(',', '.')), v];
  const youth = v.match(/^Y(.+)$/);
  if (youth) {
    const i = SIZE_ORDER.indexOf(youth[1]);
    return [2, i >= 0 ? i : 99, v];
  }
  return [3, 0, v];
}

/** Orden natural de tallas (XS < S < M…), números y el resto alfabético. */
export function compareOptionValues(a: { value: string }, b: { value: string }): number {
  const ka = optionSortKey(a.value);
  const kb = optionSortKey(b.value);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2], 'es');
}

/** Variantes de un modelo (para la ficha de producto). */
export async function familyVariants(familyCode: string) {
  const res = await pool.query(
    `SELECT id, sku, name, price, sale_price, stock, variant_options, images
     FROM products WHERE family_code = $1 AND status = 'published' AND price > 0
     ORDER BY id LIMIT 300`, [familyCode]);
  return res.rows;
}
