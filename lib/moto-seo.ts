/**
 * Directorio SEO de motos (marca → modelo), resolución canónica de URLs
 * (/escapes/:marca/:modelo) y clasificación de escapes frente a otros recambios
 * compatibles.
 *
 * Evita páginas vacías en Google: el sitemap y el listado público marcan solo
 * los modelos que tienen al menos un producto publicado compatible.
 */
import type { Pool } from 'pg';
import { getCatalogData } from './moto-catalog.js';
import { cleanModelName, ensureCompatModels } from './compat.js';
import { cacheGet, cacheSet } from './cache.js';

export const PROMO_CATEGORY_IDS = new Set([1011, 634, 1072, 1073, 1102, 1103, 1000090, 1000091, 1000092, 1000093]);
export const ESCAPE_CATEGORY_IDS = new Set([1007, 1000048, 1030]);
const NON_ESCAPE_ROOT_IDS = new Set([1001, 1003, 1005, 1009, 1010, 1014]);

const BRAND_DISPLAY_OVERRIDES: Record<string, string> = {
  'BMW': 'BMW',
  'KTM': 'KTM',
  'SYM': 'SYM',
  'MBK': 'MBK',
  'SWM': 'SWM',
  'PGO': 'PGO',
  'BSA': 'BSA',
  'DKW': 'DKW',
  'MZ': 'MZ',
  'NSU': 'NSU',
  'LML': 'LML',
  'ATK': 'ATK',
  'CPI': 'CPI',
  'TGB': 'TGB',
  'UM': 'UM',
  'CFMOTO': 'CFMoto',
  'CF MOTO': 'CFMoto',
  'HARLEY DAVIDSON': 'Harley-Davidson',
  'HARLEY-DAVIDSON': 'Harley-Davidson',
  'MV AGUSTA': 'MV Agusta',
  'TM RACING': 'TM Racing',
  'CAN AM': 'Can-Am',
  'CAN-AM': 'Can-Am',
  'SKI-DOO': 'Ski-Doo',
  'GAS GAS': 'Gas Gas',
  'GASGAS': 'GasGas',
  'KYMCO': 'Kymco',
  'QJ MOTOR': 'QJ Motor',
};

export const POPULAR_MOTO_BRANDS_ORDER = [
  'YAMAHA', 'HONDA', 'KAWASAKI', 'BMW', 'KTM', 'SUZUKI',
  'DUCATI', 'TRIUMPH', 'APRILIA', 'PIAGGIO', 'HARLEY DAVIDSON',
  'HUSQVARNA', 'KYMCO', 'SYM', 'BETA', 'GAS GAS', 'SHERCO', 'PEUGEOT',
];

const FEATURED_MODEL_CANDIDATES: [string, string][] = [
  ['YAMAHA', 'MT-07'],
  ['KAWASAKI', 'Z 900'],
  ['YAMAHA', 'MT-09'],
  ['HONDA', 'CB 650 R'],
  ['YAMAHA', 'T-MAX 530'],
  ['YAMAHA', 'T-MAX 560'],
  ['HONDA', 'PCX 125'],
  ['HONDA', 'CBR 650 R'],
  ['KAWASAKI', 'Z 800'],
  ['KAWASAKI', 'Z 750'],
  ['BMW', 'R 1250 GS'],
  ['KTM', '125 DUKE'],
  ['KTM', '390 DUKE'],
  ['APRILIA', 'SR 50'],
  ['PIAGGIO', 'ZIP 50 2T'],
  ['HONDA', 'FORZA 125'],
  ['YAMAHA', 'X-MAX 125'],
  ['YAMAHA', 'YZF-R6'],
  ['YAMAHA', 'TENERE 700'],
  ['YAMAHA', 'TRACER 900'],
  ['KTM', '125 SX'],
  ['KTM', '300 EXC'],
  ['SUZUKI', 'GSX-R 600'],
  ['HONDA', 'SH 125'],
];

/** Slug limpio en minúsculas con guiones («HARLEY DAVIDSON» → «harley-davidson», «Z 900» → «z-900»). */
export function slugifyMoto(text: unknown): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Versión sin guiones para resolver variantes humanas («z900» → «z-900», «mt07» → «mt-07»). */
export function compactSlug(text: unknown): string {
  return slugifyMoto(text).replace(/-/g, '');
}

/** Tokens ordenados alfabéticamente para resolver orden invertido («duke-125» → «125-duke»). */
export function sortedTokenSlug(text: unknown): string {
  const s = slugifyMoto(text);
  if (!s) return '';
  return s.split('-').filter(Boolean).sort().join('-');
}

/** Nombre legible de la marca para títulos SEO («YAMAHA» → «Yamaha», «BMW» → «BMW»). */
export function formatBrandDisplay(brand: string): string {
  const clean = String(brand || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  const upper = clean.toUpperCase();
  if (BRAND_DISPLAY_OVERRIDES[upper]) return BRAND_DISPLAY_OVERRIDES[upper];
  return upper
    .split(' ')
    .map((w) => (w.length <= 2 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(' ');
}

export interface ModelHierarchyNode {
  brand: string;
  brandName: string;
  brandSlug: string;
  model: string;
  slug: string;
  compact: string;
  sortedTokens: string;
  cleanName: string;
  years: string[];
  yearFrom: number | null;
  yearTo: number | null;
  vehicleCodes: string[];
}

export interface BrandHierarchyNode {
  brand: string;
  name: string;
  slug: string;
  compact: string;
  yearFrom: number | null;
  yearTo: number | null;
  models: ModelHierarchyNode[];
  modelsBySlug: Map<string, ModelHierarchyNode>;
  modelsByCompact: Map<string, ModelHierarchyNode>;
  modelsBySortedTokens: Map<string, ModelHierarchyNode>;
  modelsByClean: Map<string, ModelHierarchyNode>;
}

export interface HierarchyIndex {
  brands: BrandHierarchyNode[];
  brandsBySlug: Map<string, BrandHierarchyNode>;
  brandsByCompact: Map<string, BrandHierarchyNode>;
}

let hierarchyIndexCache: HierarchyIndex | null = null;

/** Índice en memoria del catálogo de motos para resolver rutas en O(1). */
export function getHierarchyIndex(): HierarchyIndex {
  if (hierarchyIndexCache) return hierarchyIndexCache;
  const catalog = getCatalogData();
  const hierarchy = catalog?.hierarchy || {};

  const brands: BrandHierarchyNode[] = [];
  const brandsBySlug = new Map<string, BrandHierarchyNode>();
  const brandsByCompact = new Map<string, BrandHierarchyNode>();

  for (const rawBrand of Object.keys(hierarchy).sort()) {
    const brandSlug = slugifyMoto(rawBrand);
    if (!brandSlug) continue;
    const brandName = formatBrandDisplay(rawBrand);
    const brandCompact = compactSlug(rawBrand);

    const modelsMap = new Map<string, { rawModel: string; yearsSet: Set<string>; codesSet: Set<string> }>();
    const rawModelsObj = hierarchy[rawBrand] || {};
    for (const [rawModel, yearsObj] of Object.entries<any>(rawModelsObj)) {
      const mSlug = slugifyMoto(rawModel);
      if (!mSlug) continue;
      const canonicalModel = rawModel.trim().replace(/\s+/g, ' ');
      let entry = modelsMap.get(mSlug);
      if (!entry) {
        entry = { rawModel: canonicalModel, yearsSet: new Set(), codesSet: new Set() };
        modelsMap.set(mSlug, entry);
      }
      if (yearsObj && typeof yearsObj === 'object') {
        for (const [yr, codes] of Object.entries<any>(yearsObj)) {
          if (/^\d{4}$/.test(yr)) entry.yearsSet.add(yr);
          if (Array.isArray(codes)) {
            for (const c of codes) if (c) entry.codesSet.add(String(c));
          }
        }
      }
    }

    const models: ModelHierarchyNode[] = [];
    const modelsBySlug = new Map<string, ModelHierarchyNode>();
    const modelsByCompact = new Map<string, ModelHierarchyNode>();
    const modelsBySortedTokens = new Map<string, ModelHierarchyNode>();
    const modelsByClean = new Map<string, ModelHierarchyNode>();
    let brandYearFrom: number | null = null;
    let brandYearTo: number | null = null;

    for (const [mSlug, data] of modelsMap.entries()) {
      const years = [...data.yearsSet].sort((a, b) => Number(b) - Number(a));
      const numYears = years.map(Number).filter((n) => Number.isFinite(n));
      const yearFrom = numYears.length ? Math.min(...numYears) : null;
      const yearTo = numYears.length ? Math.max(...numYears) : null;
      if (yearFrom !== null && (brandYearFrom === null || yearFrom < brandYearFrom)) brandYearFrom = yearFrom;
      if (yearTo !== null && (brandYearTo === null || yearTo > brandYearTo)) brandYearTo = yearTo;

      const node: ModelHierarchyNode = {
        brand: rawBrand,
        brandName,
        brandSlug,
        model: data.rawModel,
        slug: mSlug,
        compact: mSlug.replace(/-/g, ''),
        sortedTokens: sortedTokenSlug(mSlug),
        cleanName: cleanModelName(data.rawModel),
        years,
        yearFrom,
        yearTo,
        vehicleCodes: [...data.codesSet],
      };
      models.push(node);
      modelsBySlug.set(mSlug, node);
      if (!modelsByCompact.has(node.compact)) modelsByCompact.set(node.compact, node);
      if (node.sortedTokens && !modelsBySortedTokens.has(node.sortedTokens)) {
        modelsBySortedTokens.set(node.sortedTokens, node);
      }
      if (node.cleanName && !modelsByClean.has(node.cleanName)) {
        modelsByClean.set(node.cleanName, node);
      }
    }

    models.sort((a, b) => a.model.localeCompare(b.model, 'es'));

    const brandNode: BrandHierarchyNode = {
      brand: rawBrand,
      name: brandName,
      slug: brandSlug,
      compact: brandCompact,
      yearFrom: brandYearFrom,
      yearTo: brandYearTo,
      models,
      modelsBySlug,
      modelsByCompact,
      modelsBySortedTokens,
      modelsByClean,
    };
    brands.push(brandNode);
    if (!brandsBySlug.has(brandSlug)) brandsBySlug.set(brandSlug, brandNode);
    if (!brandsByCompact.has(brandCompact)) brandsByCompact.set(brandCompact, brandNode);
  }

  hierarchyIndexCache = { brands, brandsBySlug, brandsByCompact };
  return hierarchyIndexCache;
}

export interface ResolvedBrand {
  node: BrandHierarchyNode;
  canonicalPath: string;
  needsRedirect: boolean;
}

export interface ResolvedModel {
  brandNode: BrandHierarchyNode;
  modelNode: ModelHierarchyNode;
  canonicalPath: string;
  needsRedirect: boolean;
}

/** Resuelve el slug de una marca e indica si hay que redirigir (308) al canónico. */
export function resolveBrandSlug(rawBrandParam: string): ResolvedBrand | null {
  const raw = decodeURIComponent(String(rawBrandParam || '')).trim();
  if (!raw) return null;
  const idx = getHierarchyIndex();
  const normalized = slugifyMoto(raw);
  const node = idx.brandsBySlug.get(normalized) || idx.brandsByCompact.get(compactSlug(raw));
  if (!node) return null;
  return {
    node,
    canonicalPath: `/escapes/${node.slug}`,
    needsRedirect: raw !== node.slug,
  };
}

/** Limpia códigos entre paréntesis y ediciones cosméticas conservando letras de modelo (R, RR, F, SX). */
export function stripCosmeticEditions(text: unknown): string {
  return String(text ?? '')
    .replace(/\(.*\)/g, ' ')
    .replace(/\b(neo\s+sports\s+cafe|black\s+edition|special\s+edition|exclusive|tech\s+max|iron\s+max|black\s+max|white\s+max|lux\s+max|bronze\s+max|moto\s+cage|night\s+fluo)\b/gi, ' ')
    .replace(/\b(abs|cbs|euro\s*\d)\b/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Resuelve marca + modelo (exacto, sin guiones, orden invertido o limpio de edición). */
export function resolveModelSlug(rawBrandParam: string, rawModelParam: string): ResolvedModel | null {
  const resolvedBrand = resolveBrandSlug(rawBrandParam);
  if (!resolvedBrand) return null;
  const rawM = decodeURIComponent(String(rawModelParam || '')).trim();
  if (!rawM) return null;

  const b = resolvedBrand.node;
  const normM = slugifyMoto(rawM);
  const compM = compactSlug(rawM);
  const sortedM = sortedTokenSlug(rawM);
  const strippedSlug = slugifyMoto(stripCosmeticEditions(rawM.replace(/-/g, ' ')));
  const cleanedM = cleanModelName(rawM.replace(/-/g, ' '));
  const cleanedSlug = slugifyMoto(cleanedM);

  const modelNode =
    b.modelsBySlug.get(normM) ||
    b.modelsByCompact.get(compM) ||
    (sortedM ? b.modelsBySortedTokens.get(sortedM) : undefined) ||
    (strippedSlug ? b.modelsBySlug.get(strippedSlug) || b.modelsByCompact.get(strippedSlug.replace(/-/g, '')) : undefined) ||
    (cleanedSlug ? b.modelsBySlug.get(cleanedSlug) || b.modelsByCompact.get(cleanedSlug.replace(/-/g, '')) : undefined) ||
    (cleanedM ? b.modelsByClean.get(cleanedM) : undefined);

  if (!modelNode) return null;

  const rawB = decodeURIComponent(String(rawBrandParam || '')).trim();
  return {
    brandNode: b,
    modelNode,
    canonicalPath: `/escapes/${b.slug}/${modelNode.slug}`,
    needsRedirect: rawB !== b.slug || rawM !== modelNode.slug,
  };
}

const INTAKE_RE = /colector(?:es)?\s+de\s+admisi[oó]n/i;
const ESCAPE_NAME_RE = /\b(escape|escapes|silencioso|silenciosos|silenciador|silenciadores|colector|colectores|db[- ]?killer|supresor\s+de\s+catalizador)\b/i;
const ACCESSORY_LEAD_RE = /^(junta|juntas|juego\s+de\s+juntas|kit\s+de\s+juntas|muelle|muelles|juego\s+de\s+muelles|tornillo|tornillos|tuerca|tuercas|abrazadera|abrazaderas|fibra|lana|protector|protectores|tap[oó]n|tapones|silentblock|casquillo|casquillos|pasta|masilla|cinta|remache|remaches|soporte|soportes|brida|bridas)\b/i;
const ACCESSORY_ESCAPE_RE = /\b(junta|juntas|muelle|muelles|casquillo|casquillos|fibra|lana|tap[oó]n|masilla|pasta|protector\s+t[eé]rmico|protector\s+de\s+escape)\b/i;
const PRIMARY_ESCAPE_RE = /\b(escape\s+completo|escapes\s+completos|silencioso|silenciosos|silenciador|silenciadores|l[ií]nea\s+completa|tubo\s+de\s+escape|colector|colectores|supresor\s+de\s+catalizador|^escape\b)/i;

/** ¿El producto pertenece a escapes / silenciosos / accesorios de escape? */
export function isEscapeProduct(
  p: { categoryId?: number | null; category_id?: number | null; name?: string | null },
  rootCategoryId?: number | null,
): boolean {
  const catId = Number(p.categoryId ?? p.category_id ?? 0);
  const name = String(p.name || '').trim();
  if (INTAKE_RE.test(name)) return false;
  if (ESCAPE_CATEGORY_IDS.has(catId) || rootCategoryId === 1007) return true;
  if (rootCategoryId && NON_ESCAPE_ROOT_IDS.has(rootCategoryId)) return false;
  return ESCAPE_NAME_RE.test(name);
}

/**
 * ¿Es un escape principal (escape completo, silencioso, colector o supresor) y
 * no un consumible pequeño (junta, muelle, casquillo, fibra)?
 */
export function isPrimaryEscape(
  p: { categoryId?: number | null; category_id?: number | null; name?: string | null },
  rootCategoryId?: number | null,
): boolean {
  if (!isEscapeProduct(p, rootCategoryId)) return false;
  const name = String(p.name || '').trim();
  if (ACCESSORY_LEAD_RE.test(name) || ACCESSORY_ESCAPE_RE.test(name)) return false;
  const catId = Number(p.categoryId ?? p.category_id ?? 0);
  if (catId === 1030 || catId === 1000048) {
    return PRIMARY_ESCAPE_RE.test(name);
  }
  return catId === 1007 || rootCategoryId === 1007 || PRIMARY_ESCAPE_RE.test(name);
}

export interface CategorySummaryChip {
  id: number;
  name: string;
  slug: string;
  count: number;
}

export function buildRootCategoryMap(
  categoriesRows: { id: number; name: string; slug: string; parent_id: number | null }[],
): Map<number, { id: number; name: string; slug: string }> {
  const byId = new Map<number, { id: number; name: string; slug: string; parent_id: number | null }>();
  for (const c of categoriesRows) byId.set(Number(c.id), c);

  const rootMap = new Map<number, { id: number; name: string; slug: string }>();
  for (const c of categoriesRows) {
    let cur: { id: number; name: string; slug: string; parent_id: number | null } | undefined = c;
    let guard = 0;
    while (cur && cur.parent_id && byId.has(Number(cur.parent_id)) && guard < 8) {
      const parent = byId.get(Number(cur.parent_id))!;
      if (parent.id === 1 || parent.id === 2) break;
      cur = parent;
      guard++;
    }
    if (cur) rootMap.set(Number(c.id), { id: Number(cur.id), name: cur.name, slug: cur.slug });
  }
  return rootMap;
}

function effectiveCardPrice(p: any): number {
  if (p.family?.priceMin != null && p.family.priceMin > 0) return Number(p.family.priceMin);
  if (p.salePrice != null && p.salePrice > 0 && p.salePrice < p.price) return Number(p.salePrice);
  return Number(p.price) || 0;
}

function cardInStock(p: any): number {
  if (p.family && typeof p.family.inStock === 'boolean') return p.family.inStock ? 1 : 0;
  return p.inStock || Number(p.stock) > 0 ? 1 : 0;
}

function sortCardsForConversion(a: any, b: any): number {
  const stockDiff = cardInStock(b) - cardInStock(a);
  if (stockDiff !== 0) return stockDiff;
  return effectiveCardPrice(a) - effectiveCardPrice(b);
}

/**
 * Clasifica y ordena las tarjetas compatibles con una moto:
 *  1. Escapes completos, silenciosos y colectores (en stock primero).
 *  2. Juntas, muelles y accesorios de escape.
 *  3. Resto de recambios compatibles con su categoría raíz resuelta.
 */
export function classifyMotoProducts(
  cards: any[],
  rootCategoryById: Map<number, { id: number; name: string; slug: string }>,
) {
  const primaryEscapes: any[] = [];
  const escapeAccessories: any[] = [];
  const otherProducts: any[] = [];
  const catCounts = new Map<number, CategorySummaryChip>();

  for (const p of cards) {
    const catId = Number(p.categoryId ?? p.category_id ?? 0);
    if (PROMO_CATEGORY_IDS.has(catId)) continue;
    const root = rootCategoryById.get(catId);
    if (root && (PROMO_CATEGORY_IDS.has(root.id) || /promocional/i.test(root.slug))) continue;

    const isEsc = isEscapeProduct(p, root?.id);
    const assignedRoot = isEsc
      ? { id: 1007, name: 'Escapes', slug: 'escapes' }
      : (root || { id: 9999, name: 'Otros recambios', slug: 'otros' });

    const enriched = {
      ...p,
      isCompatible: true,
      rootCategoryId: assignedRoot.id,
      rootCategoryName: assignedRoot.name,
      rootCategorySlug: assignedRoot.slug,
    };

    const chip = catCounts.get(assignedRoot.id) || {
      id: assignedRoot.id,
      name: assignedRoot.name,
      slug: assignedRoot.slug,
      count: 0,
    };
    chip.count++;
    catCounts.set(assignedRoot.id, chip);

    if (isEsc) {
      if (isPrimaryEscape(p, root?.id)) primaryEscapes.push(enriched);
      else escapeAccessories.push(enriched);
    } else {
      otherProducts.push(enriched);
    }
  }

  primaryEscapes.sort(sortCardsForConversion);
  escapeAccessories.sort(sortCardsForConversion);
  otherProducts.sort(sortCardsForConversion);

  const escapes = [...primaryEscapes, ...escapeAccessories];
  const allProducts = [...escapes, ...otherProducts];
  const categories = [...catCounts.values()].sort((a, b) => {
    if (a.id === 1007) return -1;
    if (b.id === 1007) return 1;
    return b.count - a.count || a.name.localeCompare(b.name, 'es');
  });

  return {
    primaryEscapes,
    escapeAccessories,
    escapes,
    otherProducts,
    allProducts,
    categories,
  };
}

export interface MotoSeoModelEntry {
  model: string;
  slug: string;
  years: string[];
  yearFrom: number | null;
  yearTo: number | null;
  hasProducts: boolean;
  escapeCount: number;
}

export interface MotoSeoBrandEntry {
  brand: string;
  name: string;
  slug: string;
  yearFrom: number | null;
  yearTo: number | null;
  modelCount: number;
  activeModelCount: number;
  escapeModelCount: number;
  escapeProductCount: number;
  isPopular: boolean;
}

export interface MotoSeoFeaturedModel {
  brand: string;
  brandName: string;
  brandSlug: string;
  model: string;
  modelSlug: string;
  yearFrom: number | null;
  yearTo: number | null;
  escapeCount: number;
}

export interface MotoSeoDirectory {
  generatedAt: string;
  totalActiveBrands: number;
  totalActiveModels: number;
  totalEscapeModels: number;
  totalEscapeProducts: number;
  brands: MotoSeoBrandEntry[];
  modelsByBrandSlug: Record<string, MotoSeoModelEntry[]>;
  featuredModels: MotoSeoFeaturedModel[];
  topEscapeBrands: { brand: string; count: number }[];
}

let directoryMemCache: { expiresAt: number; data: MotoSeoDirectory } | null = null;
let directoryInFlight: Promise<MotoSeoDirectory> | null = null;

/**
 * Construye el directorio SEO completo cruzando el catálogo de motos en memoria
 * con los productos publicados y los escapes compatibles en PostgreSQL.
 */
export async function getMotoSeoDirectory(dbPool: Pool): Promise<MotoSeoDirectory> {
  if (directoryMemCache && directoryMemCache.expiresAt > Date.now()) {
    return directoryMemCache.data;
  }
  if (directoryInFlight) return directoryInFlight;

  directoryInFlight = (async () => {
    const redisKey = 'cache:moto-seo:dir:v2';
    const cached = await cacheGet<MotoSeoDirectory>(redisKey);
    if (cached && cached.brands && cached.modelsByBrandSlug) {
      directoryMemCache = { expiresAt: Date.now() + 15 * 60_000, data: cached };
      return cached;
    }

    const idx = getHierarchyIndex();
    const catalog = getCatalogData();
    const compatibilityMap: Record<string, string[]> = catalog?.compatibility || {};

    // 1. Todos los SKUs publicados con precio > 0 (~100k SKUs cortos, ~80 ms).
    const pubRes = await dbPool.query<{ sku: string }>(
      `SELECT sku FROM products WHERE status = 'published' AND price > 0 AND sku IS NOT NULL`
    );
    const publishedSkus = new Set<string>(pubRes.rows.map((r) => r.sku));

    // 2. Escapes publicados con su marca y compatibilidades JSONB (~1.5k filas, ~150 ms).
    const escRes = await dbPool.query<{ sku: string; brand: string | null; compatibility: any; name: string; category_id: number | null }>(
      `SELECT sku, brand, compatibility, name, category_id
         FROM products
        WHERE status = 'published' AND price > 0
          AND (category_id IN (1007, 1000048, 1030) OR name ~* '\\m(escape|escapes|silencioso|silenciosos|silenciador|silenciadores|colector|colectores)\\M')
          AND name !~* 'colector(es)?\\s+de\\s+admisi'`
    );

    const escapeSkus = new Set<string>();
    const escapeBrandCounts = new Map<string, number>();
    const escapeSkusByBrandCleanModel = new Map<string, Set<string>>();
    const escapeSkusByMotoBrand = new Map<string, Set<string>>();

    for (const row of escRes.rows) {
      if (!row.sku) continue;
      escapeSkus.add(row.sku);
      const pBrand = String(row.brand || '').trim();
      if (pBrand && !/^bihr$/i.test(pBrand)) {
        escapeBrandCounts.set(pBrand, (escapeBrandCounts.get(pBrand) || 0) + 1);
      }
      const compatList = Array.isArray(row.compatibility) ? row.compatibility : [];
      for (const item of compatList) {
        if (!item || typeof item !== 'object') continue;
        const mBrand = String(item.brand || '').trim().toUpperCase();
        const mClean = cleanModelName(item.model);
        if (!mBrand || !mClean) continue;
        const key = `${mBrand}|${mClean}`;
        let set = escapeSkusByBrandCleanModel.get(key);
        if (!set) {
          set = new Set();
          escapeSkusByBrandCleanModel.set(key, set);
        }
        set.add(row.sku);

        let bSet = escapeSkusByMotoBrand.get(mBrand);
        if (!bSet) {
          bSet = new Set();
          escapeSkusByMotoBrand.set(mBrand, bSet);
        }
        bSet.add(row.sku);
      }
    }

    // 3. Modelos presentes en compat_vehicle_models (~61k filas, ~50 ms).
    const compatCleanModels = new Set<string>();
    try {
      let cvmRes: { rows: { brand: string; model: string }[] };
      try {
        cvmRes = await dbPool.query<{ brand: string; model: string }>(
          `SELECT DISTINCT brand, model FROM compat_vehicle_models`
        );
      } catch {
        await ensureCompatModels();
        cvmRes = await dbPool.query<{ brand: string; model: string }>(
          `SELECT DISTINCT brand, model FROM compat_vehicle_models`
        );
      }
      for (const r of cvmRes.rows) {
        const cl = cleanModelName(r.model);
        if (r.brand && cl) compatCleanModels.add(`${r.brand.toUpperCase()}|${cl}`);
      }
    } catch {
      // Si la vista materializada aún no está lista, usamos moto_catalog.json + escapes.
    }

    const popularRank = new Map(POPULAR_MOTO_BRANDS_ORDER.map((b, i) => [b, i]));
    const brands: MotoSeoBrandEntry[] = [];
    const modelsByBrandSlug: Record<string, MotoSeoModelEntry[]> = {};
    let totalActiveModels = 0;
    let totalEscapeModels = 0;

    for (const bNode of idx.brands) {
      const modelEntries: MotoSeoModelEntry[] = [];
      let activeModelCount = 0;
      let escapeModelCount = 0;
      const brandEscapeSkus = new Set<string>(escapeSkusByMotoBrand.get(bNode.brand.toUpperCase()) || []);

      for (const mNode of bNode.models) {
        let hasJsonProduct = false;
        const modelEscSkus = new Set<string>();

        for (const code of mNode.vehicleCodes) {
          if (publishedSkus.has(code)) hasJsonProduct = true;
          if (escapeSkus.has(code)) {
            modelEscSkus.add(code);
            brandEscapeSkus.add(code);
          }
          const mapped = compatibilityMap[code];
          if (Array.isArray(mapped)) {
            for (const sku of mapped) {
              if (!hasJsonProduct && publishedSkus.has(sku)) hasJsonProduct = true;
              if (escapeSkus.has(sku)) {
                modelEscSkus.add(sku);
                brandEscapeSkus.add(sku);
              }
            }
          }
        }

        const cleanKey = `${bNode.brand.toUpperCase()}|${mNode.cleanName}`;
        const rawNoDigits = mNode.cleanName.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
        const cleanNoDigits = rawNoDigits.replace(/[^a-z]/g, '').length >= 4 ? rawNoDigits : '';
        const altCleanKey = cleanNoDigits && cleanNoDigits !== mNode.cleanName
          ? `${bNode.brand.toUpperCase()}|${cleanNoDigits}`
          : '';

        const dbEscSet = escapeSkusByBrandCleanModel.get(cleanKey);
        if (dbEscSet) dbEscSet.forEach((s) => modelEscSkus.add(s));
        else if (altCleanKey) {
          escapeSkusByBrandCleanModel.get(altCleanKey)?.forEach((s) => modelEscSkus.add(s));
        }

        const hasCompatDb = compatCleanModels.has(cleanKey) || (altCleanKey ? compatCleanModels.has(altCleanKey) : false);
        const escapeCount = modelEscSkus.size;
        const hasProducts = hasJsonProduct || hasCompatDb || escapeCount > 0;

        if (hasProducts) {
          activeModelCount++;
          totalActiveModels++;
        }
        if (escapeCount > 0) {
          escapeModelCount++;
          totalEscapeModels++;
        }

        modelEntries.push({
          model: mNode.model,
          slug: mNode.slug,
          years: mNode.years,
          yearFrom: mNode.yearFrom,
          yearTo: mNode.yearTo,
          hasProducts,
          escapeCount,
        });
      }

      // Modelos con escapes primero, luego con recambios, luego orden alfabético.
      modelEntries.sort((a, b) =>
        Number(b.escapeCount > 0) - Number(a.escapeCount > 0) ||
        b.escapeCount - a.escapeCount ||
        Number(b.hasProducts) - Number(a.hasProducts) ||
        a.model.localeCompare(b.model, 'es')
      );

      modelsByBrandSlug[bNode.slug] = modelEntries;
      brands.push({
        brand: bNode.brand,
        name: bNode.name,
        slug: bNode.slug,
        yearFrom: bNode.yearFrom,
        yearTo: bNode.yearTo,
        modelCount: bNode.models.length,
        activeModelCount,
        escapeModelCount,
        escapeProductCount: brandEscapeSkus.size,
        isPopular: popularRank.has(bNode.brand.toUpperCase()),
      });
    }

    brands.sort((a, b) => {
      const ra = popularRank.get(a.brand.toUpperCase());
      const rb = popularRank.get(b.brand.toUpperCase());
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return b.escapeModelCount - a.escapeModelCount || b.activeModelCount - a.activeModelCount || a.name.localeCompare(b.name, 'es');
    });

    const featuredModels: MotoSeoFeaturedModel[] = [];
    for (const [bRaw, mRaw] of FEATURED_MODEL_CANDIDATES) {
      const resolved = resolveModelSlug(slugifyMoto(bRaw), slugifyMoto(mRaw));
      if (!resolved) continue;
      const list = modelsByBrandSlug[resolved.brandNode.slug] || [];
      const entry = list.find((e) => e.slug === resolved.modelNode.slug);
      if (!entry || !entry.hasProducts) continue;
      featuredModels.push({
        brand: resolved.brandNode.brand,
        brandName: resolved.brandNode.name,
        brandSlug: resolved.brandNode.slug,
        model: entry.model,
        modelSlug: entry.slug,
        yearFrom: entry.yearFrom,
        yearTo: entry.yearTo,
        escapeCount: entry.escapeCount,
      });
    }

    const topEscapeBrands = [...escapeBrandCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([brand, count]) => ({ brand, count }));

    const directory: MotoSeoDirectory = {
      generatedAt: new Date().toISOString(),
      totalActiveBrands: brands.filter((b) => b.activeModelCount > 0).length,
      totalActiveModels,
      totalEscapeModels,
      totalEscapeProducts: escapeSkus.size,
      brands,
      modelsByBrandSlug,
      featuredModels,
      topEscapeBrands,
    };

    directoryMemCache = { expiresAt: Date.now() + 30 * 60_000, data: directory };
    await cacheSet(redisKey, directory, 3600);
    return directory;
  })().finally(() => {
    directoryInFlight = null;
  });

  return directoryInFlight;
}
