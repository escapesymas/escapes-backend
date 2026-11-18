/**
 * Interpretación de las búsquedas que no dan resultados: motos y categorías.
 *
 * El buscador (lib/catalog-query.ts) exige que cada palabra esté en el texto del producto (nombre, marca, referencias). Pero
 * lo que más se busca sin éxito es «pieza + moto» («escape wottan s2», «lateral qjmotor ltr 125», «escape intermedio de
 * montesa cota 315r»): la moto casi nunca está en el nombre del producto, está en sus compatibilidades. Aquí, cuando una
 * búsqueda no da nada, se intenta entenderla:
 *   - ¿alguna palabra es una marca de moto (o parece serlo, con una errata) y las siguientes un modelo? → solo se miran los
 *     productos compatibles con esa moto (`products.compatibility`) y el resto de palabras se buscan entre ellos;
 *   - ¿alguna palabra es el nombre de una categoría («frenos», «plástica»)? → vale que el producto sea de esa categoría
 *     aunque la palabra no esté en su nombre.
 *
 * Las motos salen de `compat_vehicle_models` (marca, modelo tal como vienen en las compatibilidades; ~15.000 pares) y las
 * categorías de `categories` (~1.100); ambas se guardan en memoria un rato. Sin dependencias de catalog-query (que la usa a
 * ella): `interpretTerms` es pura para poder probarla.
 */
import { pool } from '../db.js';
import { ensureCompatModels, cleanModelName } from './compat.js';

/* ───────────────────────── Texto ───────────────────────── */

const norm = (s: string): string =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/g, 'n');

/** Trozos de un texto separados por símbolos y entre letras y números: «315r» → 315, r; «STORM-S (JF10)» → storm, s. */
export function pieces(text: string): string[] {
  return norm(text).replace(/\(.*?\)/g, ' ').match(/[a-z]+|[0-9]+/g) || [];
}

/** Palabras enteras de un texto sin separar letras y números, y pegadas de dos en dos: «STORM-S» → storm, s, storms. */
function words(text: string): string[] {
  const w = norm(text).replace(/\(.*?\)/g, ' ').match(/[a-z0-9]+/g) || [];
  const out = [...w];
  for (let i = 0; i + 1 < w.length; i++) out.push(w[i] + w[i + 1]);
  return out;
}

/** Distancia de edición ≤ 1 (una letra de más, de menos o cambiada). */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

/** Con 5 o más letras se perdona una errata («wotan» → wottan, «dulan» → dylan); con menos, no. */
const fuzzyEq = (a: string, b: string): boolean => a === b || (a.length >= 5 && b.length >= 5 && a[0] === b[0] && oneEditApart(a, b));

/* ───────────────────────── Motos ───────────────────────── */

interface ModelEntry {
  /** Marca tal como está en las compatibilidades (mayúsculas). */
  brand: string;
  /** Modelo tal como está en las compatibilidades. */
  model: string;
  tokens: Set<string>;
}

interface BrandEntry {
  names: Set<string>;
  models: ModelEntry[];
}

export interface VehicleDictionary {
  /** Marca normalizada («qj motor» y «qjmotor» → qjmotor) → sus nombres y modelos. */
  brands: Map<string, BrandEntry>;
}

const brandKey = (b: string): string => norm(b).replace(/[^a-z0-9]/g, '');

/** «Marcas» de las compatibilidades que en una búsqueda son otra cosa (en la tienda «universal» es un tipo de producto). */
const NOT_A_BRAND = new Set(['universal', 'universales', 'general', 'otros', 'varios']);

export function buildVehicleDictionary(rows: { brand: string; model: string }[]): VehicleDictionary {
  const brands = new Map<string, BrandEntry>();
  const seen = new Set<string>();
  for (const r of rows) {
    const brand = String(r.brand || '').trim().toUpperCase();
    const model = String(r.model || '').trim();
    const key = brandKey(brand);
    if (key.length < 3 || NOT_A_BRAND.has(key) || !model || seen.has(`${brand}|${model}`)) continue;
    seen.add(`${brand}|${model}`);
    const entry = brands.get(key) || { names: new Set<string>(), models: [] };
    entry.names.add(brand);
    entry.models.push({ brand, model, tokens: new Set([...pieces(model), ...words(model)]) });
    brands.set(key, entry);
  }
  return { brands };
}

export interface VehicleMatch {
  /** Texto para enseñar al cliente («WOTTAN», «MITT 125 RT»). */
  label: string;
  /** Contenciones JSON para `products.compatibility @>` (una por marca o por marca+modelo). */
  compat: string[];
  /** null = cualquier modelo de la marca. */
  models: string[] | null;
}

/** Como mucho tantos modelos distintos: si una palabra suelta («125») encaja con más, no es un modelo, es otra cosa. */
const MAX_MODELS = 40;
/** Peso mínimo (letras y cifras que encajan) para dar por buena una moto concreta y no solo la marca. */
const MIN_MODEL_WEIGHT = 3;

/** Reconoce una marca de moto en las palabras de la búsqueda (sola o pegada con la siguiente: «qj motor»). */
function findBrand(terms: string[], dict: VehicleDictionary): { key: string; start: number; len: number } | null {
  let best: { key: string; start: number; len: number; exact: boolean } | null = null;
  for (let i = 0; i < terms.length; i++) {
    for (let len = 1; len <= 3 && i + len <= terms.length; len++) {
      const joined = terms.slice(i, i + len).map((t) => brandKey(t)).join('');
      if (joined.length < 3) continue;
      let key: string | null = dict.brands.has(joined) ? joined : null;
      let exact = !!key;
      if (!key && len === 1) {
        for (const k of dict.brands.keys()) if (fuzzyEq(joined, k)) { key = k; break; }
      }
      if (!key) continue;
      // Gana la más larga y, a igualdad, la exacta y la más a la izquierda.
      if (!best || len > best.len || (len === best.len && exact && !best.exact)) best = { key, start: i, len, exact };
    }
  }
  return best && { key: best.key, start: best.start, len: best.len };
}

/** Cuánto «explica» un modelo de lo que ha escrito el cliente: letras y cifras que encajan. */
function modelWeight(model: ModelEntry, terms: string[]): { weight: number; matched: boolean[] } {
  let weight = 0;
  const matched = terms.map((term) => {
    const t = norm(term).replace(/[^a-z0-9]/g, '');
    if (!t) return false;
    const has = (x: string) => model.tokens.has(x) || [...model.tokens].some((m) => fuzzyEq(x, m));
    if (has(t)) { weight += t.length; return true; }
    const ps = pieces(t);
    if (ps.length > 1 && ps.every(has)) { weight += ps.reduce((n, p) => n + p.length, 0); return true; }
    // Pieza suelta que encaja: suma su peso pero el término sigue sin darse por entendido.
    for (const p of ps) if (ps.length > 1 && has(p)) weight += p.length;
    return false;
  });
  return { weight, matched };
}

/**
 * Moto que describe la búsqueda: marca (con errata si hace falta) y, si encaja, modelo. `used` son los índices de las
 * palabras que ya forman parte de la moto (el resto se busca como texto del producto).
 */
export function matchVehicle(terms: string[], dict: VehicleDictionary): (VehicleMatch & { used: Set<number> }) | null {
  const found = findBrand(terms, dict);
  if (!found) return null;
  const entry = dict.brands.get(found.key)!;
  const used = new Set<number>();
  for (let i = found.start; i < found.start + found.len; i++) used.add(i);
  const brandLabel = [...entry.names].sort((a, b) => a.length - b.length)[0];

  // Modelo: las palabras que no son la marca se cotejan con cada modelo de la marca.
  const rest = terms.map((t, i) => ({ t, i })).filter(({ i }) => !used.has(i));
  let models: ModelEntry[] = [];
  let consumed = new Set<number>();
  if (rest.length) {
    const restTerms = rest.map((r) => r.t);
    let best = 0;
    const scored = entry.models.map((m) => ({ m, ...modelWeight(m, restTerms) }));
    for (const s of scored) if (s.weight > best) best = s.weight;
    if (best >= MIN_MODEL_WEIGHT) {
      const top = scored.filter((s) => s.weight === best);
      const distinct = new Set(top.map((s) => cleanModelName(s.m.model)));
      if (distinct.size <= MAX_MODELS) {
        models = top.map((s) => s.m);
        // Una palabra queda dentro de la moto si encaja con todos los modelos elegidos.
        consumed = new Set(rest.filter((_, k) => top.every((s) => s.matched[k])).map((r) => r.i));
      }
    }
  }
  consumed.forEach((i) => used.add(i));

  if (!models.length) {
    return { label: brandLabel, compat: [...entry.names].map((b) => JSON.stringify([{ brand: b }])), models: null, used };
  }
  const names = [...new Set(models.map((m) => cleanModelName(m.model).toUpperCase()))];
  const label = `${brandLabel} ${names.slice(0, 2).join(' / ')}${names.length > 2 ? '…' : ''}`;
  const compat = [...new Map(models.map((m) => [`${m.brand}|${m.model}`, JSON.stringify([{ brand: m.brand, model: m.model }])])).values()];
  return { label, compat, models: models.map((m) => m.model), used };
}

/* ───────────────────────── Categorías ───────────────────────── */

export interface CategoryDictionary {
  /** Palabra normalizada del nombre de una categoría → ids de las categorías que la llevan. */
  byWord: Map<string, number[]>;
  children: Map<number, number[]>;
  names: Map<number, string>;
}

export function buildCategoryDictionary(rows: { id: number; name: string; parent_id: number | null }[]): CategoryDictionary {
  const byWord = new Map<string, number[]>();
  const children = new Map<number, number[]>();
  const names = new Map<number, string>();
  for (const r of rows) {
    names.set(r.id, r.name);
    if (r.parent_id) children.set(r.parent_id, [...(children.get(r.parent_id) || []), r.id]);
    for (const w of new Set(norm(r.name).match(/[a-z0-9]+/g) || [])) byWord.set(w, [...(byWord.get(w) || []), r.id]);
  }
  return { byWord, children, names };
}

/** Singular y plural de una palabra: «frenos» → freno; «freno» → frenos. */
function wordForms(term: string): string[] {
  const out = new Set([term]);
  if (term.endsWith('es') && term.length > 4) out.add(term.slice(0, -2));
  if (term.endsWith('s') && term.length > 3) out.add(term.slice(0, -1));
  if (!term.endsWith('s')) { out.add(`${term}s`); out.add(`${term}es`); }
  return [...out];
}

const MAX_CATEGORY_IDS = 600;

/** Categorías cuyo nombre lleva la palabra (y todas las de dentro): null si ninguna. */
export function categoriesForTerm(term: string, dict: CategoryDictionary): { ids: number[]; names: string[] } | null {
  const t = norm(term);
  if (t.length < 4 || /^\d+$/.test(t)) return null;
  const direct = new Set<number>();
  for (const form of wordForms(t)) for (const id of dict.byWord.get(form) || []) direct.add(id);
  if (!direct.size) return null;
  const ids = new Set<number>();
  const walk = (id: number) => {
    if (ids.has(id) || ids.size >= MAX_CATEGORY_IDS) return;
    ids.add(id);
    for (const ch of dict.children.get(id) || []) walk(ch);
  };
  direct.forEach(walk);
  return { ids: [...ids], names: [...direct].slice(0, 3).map((id) => dict.names.get(id) || '') };
}

/* ───────────────────────── Interpretación ───────────────────────── */

export interface Interpretation {
  vehicle: VehicleMatch | null;
  /** Palabras que quedan para buscar en el texto del producto (sin la moto). */
  restTerms: string[];
  /** Por palabra, las categorías en las que también vale que esté. */
  categoryTerms: Record<string, number[]>;
  categoryNames: string[];
}

/** Interpreta las palabras de una búsqueda sin resultados; null si no reconoce ni moto ni categoría. */
export function interpretTerms(terms: string[], vehicles: VehicleDictionary, categories: CategoryDictionary): Interpretation | null {
  if (!terms.length) return null;
  const vehicle = matchVehicle(terms, vehicles);
  const restTerms = terms.filter((_, i) => !vehicle || !vehicle.used.has(i));

  const categoryTerms: Record<string, number[]> = {};
  const categoryNames: string[] = [];
  for (const term of restTerms) {
    const c = categoriesForTerm(term, categories);
    if (!c) continue;
    categoryTerms[term] = c.ids;
    for (const n of c.names) if (!categoryNames.includes(n)) categoryNames.push(n);
  }
  if (!vehicle && !Object.keys(categoryTerms).length) return null;
  const { used: _used, ...vehicleOut } = (vehicle || {}) as any;
  return { vehicle: vehicle ? (vehicleOut as VehicleMatch) : null, restTerms, categoryTerms, categoryNames: categoryNames.slice(0, 3) };
}

/* ───────────────────────── Diccionarios en memoria ───────────────────────── */

const TTL_VEHICLES_MS = 60 * 60_000;
const TTL_CATEGORIES_MS = 10 * 60_000;
let vehiclesCache: { at: number; dict: Promise<VehicleDictionary> } | null = null;
let categoriesCache: { at: number; dict: Promise<CategoryDictionary> } | null = null;

async function loadVehicles(): Promise<VehicleDictionary> {
  await ensureCompatModels();
  const res = await pool.query(`SELECT DISTINCT brand, model FROM compat_vehicle_models`);
  return buildVehicleDictionary(res.rows);
}

async function loadCategories(): Promise<CategoryDictionary> {
  const res = await pool.query(`SELECT id, name, parent_id FROM categories`);
  return buildCategoryDictionary(res.rows);
}

/**
 * Interpreta una búsqueda sin resultados a partir de sus palabras (ya normalizadas por `searchTerms`). No lanza nunca:
 * si los diccionarios no están disponibles devuelve null y el buscador sigue con la corrección de erratas.
 */
export async function interpretSearch(terms: string[]): Promise<Interpretation | null> {
  try {
    if (!vehiclesCache || Date.now() - vehiclesCache.at > TTL_VEHICLES_MS) {
      const dict = loadVehicles();
      vehiclesCache = { at: Date.now(), dict };
      dict.catch(() => { vehiclesCache = null; });
    }
    if (!categoriesCache || Date.now() - categoriesCache.at > TTL_CATEGORIES_MS) {
      const dict = loadCategories();
      categoriesCache = { at: Date.now(), dict };
      dict.catch(() => { categoriesCache = null; });
    }
    const [vehicles, categories] = await Promise.all([vehiclesCache.dict, categoriesCache.dict]);
    return interpretTerms(terms, vehicles, categories);
  } catch (e: any) {
    console.warn('[SEARCH INTERPRET] No disponible:', e?.message || e);
    return null;
  }
}
