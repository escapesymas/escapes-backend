/**
 * Directorio SEO de fabricantes y marcas de recambios, escapes y equipamiento
 * (/marcas y /marcas/:marca), resolución canónica de URLs y redirección de URLs
 * antiguas de WooCommerce (/producto/mivv-...) hacia la moto o categoría adecuada.
 *
 * Excluye siempre a BIHR (nuestro proveedor mayorista, igual que lib/google-feed.ts).
 */
import type { Pool } from 'pg';
import { cacheGet, cacheSet } from './cache.js';
import { getHierarchyIndex, slugifyMoto } from './moto-seo.js';

/** Proveedores mayoristas que nunca deben exponerse como marca pública. */
export function isExcludedSupplierBrand(brand: unknown): boolean {
  const s = String(brand ?? '').trim();
  if (!s) return true;
  return /\bbihr\b/i.test(s);
}

/** Slug limpio en minúsculas con guiones («YOSHIMURA US» → «yoshimura-us», «R&G RACING» → «r-g-racing»). */
export function slugifyManufacturerBrand(text: unknown): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Versión compacta sin guiones para resolver variantes escritas sin separador («yoshimuraus» → «yoshimura-us»). */
export function compactManufacturerBrandSlug(text: unknown): string {
  return slugifyManufacturerBrand(text).replace(/-/g, '');
}

const MANUFACTURER_DISPLAY_OVERRIDES: Record<string, string> = {
  'IXIL': 'IXIL',
  'AFAM': 'AFAM',
  'RST': 'RST',
  'RFX': 'RFX',
  'NGK': 'NGK',
  'YSS': 'YSS',
  'MRA': 'MRA',
  'UFO': 'UFO',
  'PBR': 'PBR',
  'BMC': 'BMC',
  'HMF': 'HMF',
  'SHAD': 'SHAD',
  'ARAI': 'Arai',
  'SKF': 'SKF',
  'NTN': 'NTN',
  'RK': 'RK',
  'ITP': 'ITP',
  'IRC': 'IRC',
  'KMC': 'KMC',
  'JMP': 'JMP',
  'JBM': 'JBM',
  'MFW': 'MFW',
  'NOCO': 'NOCO',
  'ODI': 'ODI',
  'EPI': 'EPI',
  'AXP': 'AXP',
  'ART': 'ART',
  'B1': 'B1',
  'RAM': 'RAM',
  'STM': 'STM',
  'TNK': 'TNK',
  'HPX': 'HPX',
  'TEXA': 'TEXA',
  'SIEM': 'SIEM',
  'ZECA': 'ZECA',
  'KOSO': 'Koso',
  'SENA': 'Sena',
  'BELL': 'Bell',
  'BETA': 'Beta',
  'SCAR': 'Scar',
  'R&G RACING': 'R&G Racing',
  'HP CORSE': 'HP Corse',
  'EK CHAIN': 'EK Chain',
  'CL BRAKES': 'CL Brakes',
  'NG BRAKE DISC': 'NG Brake Disc',
  'JT SPROCKETS': 'JT Sprockets',
  'JT DRIVE CHAIN': 'JT Drive Chain',
  'V PARTS': 'V Parts',
  'V-FORCE': 'V-Force',
  'BS BATTERY': 'BS Battery',
  'SP CONNECT': 'SP Connect',
  'SEVEN MX': 'Seven MX',
  'YOSHIMURA US': 'Yoshimura US',
  'WD 40': 'WD-40',
  'MUC-OFF': 'Muc-Off',
  'PRO-PEGS': 'Pro-Pegs',
  'A-SIDER': 'A-Sider',
  'PTS OUTILLAGE': 'PTS Outillage',
  'SXP LOCK': 'SXP Lock',
  'VISION-X': 'Vision-X',
  'ACOUSTA-FIL': 'Acousta-Fil',
  'DELL ORTO': "Dell'Orto",
  'LIQUI MOLY': 'Liqui Moly',
  'HIFLOFILTRO': 'Hiflofiltro',
  'TROY LEE DESIGNS': 'Troy Lee Designs',
};

/** Fabricantes especialistas en sistemas de escape y silenciosos dentro del catálogo activo. */
export const ESCAPE_SPECIALIST_BRANDS = new Set([
  'IXIL',
  'TECNIGAS',
  'FRESCO',
  'YASUNI',
  'YOSHIMURA US',
  'PRO CIRCUIT',
  'HP CORSE',
  'HMF',
  'SCORPION',
  'POLINI',
  'MALOSSI',
  'ACOUSTA-FIL',
]);

/** Orden prioritario de marcas destacadas para el directorio y enlaces internos. */
export const FEATURED_MANUFACTURER_ORDER = [
  'IXIL',
  'YASUNI',
  'TECNIGAS',
  'YOSHIMURA US',
  'PRO CIRCUIT',
  'FRESCO',
  'POLINI',
  'MALOSSI',
  'HP CORSE',
  'BREMBO',
  'ARAI',
  'SHAD',
  'RST',
  'MICHELIN',
  'PIRELLI',
  'DUNLOP',
  'BRIDGESTONE',
  'METZELER',
  'AFAM',
  'EK CHAIN',
  'NGK',
  'HIFLOFILTRO',
  'TWIN AIR',
  'RENTHAL',
  'YSS',
  'R&G RACING',
  'TROY LEE DESIGNS',
  'ALL BALLS',
  'NG BRAKE DISC',
  'CL BRAKES',
];

/** Formatea el nombre del fabricante de forma natural para H1, migas de pan y metadatos. */
export function formatManufacturerBrandDisplay(rawBrand: string): string {
  const clean = String(rawBrand || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  const upper = clean.toUpperCase();
  if (MANUFACTURER_DISPLAY_OVERRIDES[upper]) return MANUFACTURER_DISPLAY_OVERRIDES[upper];
  return upper
    .split(' ')
    .map((word) => {
      if (word.length <= 2 && /^[A-Z0-9&]+$/.test(word)) return word;
      return word
        .split('-')
        .map((part) => (part ? part[0] + part.slice(1).toLowerCase() : ''))
        .join('-');
    })
    .join(' ');
}

export interface BrandCategorySummary {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  parentName: string | null;
  parentSlug: string | null;
  count: number;
  /** Ruta pública en /universales para entrelazado interno SEO. */
  catalogHref: string;
}

export interface ManufacturerBrandEntry {
  /** Valor exacto de la columna `brand` en PostgreSQL (p. ej. «YOSHIMURA US»). */
  brand: string;
  /** Nombre formateado para mostrar al cliente (p. ej. «Yoshimura US»). */
  name: string;
  /** Slug canónico de la URL (p. ej. «yoshimura-us»). */
  slug: string;
  /** Referencias totales publicadas con precio > 0. */
  productCount: number;
  /** Modelos agrupados por familia (`family_code` o `sku`). */
  modelCount: number;
  /** Referencias con stock disponible inmediato. */
  inStockCount: number;
  /** Referencias dentro de categorías de escapes (1007, 1000048, 1030). */
  escapeCount: number;
  /** Si es fabricante especialista de escapes/silenciosos. */
  isEscapeSpecialist: boolean;
  /** Si figura entre las marcas destacadas de primer nivel. */
  isFeatured: boolean;
  /** Principales categorías en las que trabaja esta marca. */
  topCategories: BrandCategorySummary[];
}

export interface ManufacturerBrandsDirectory {
  totalBrands: number;
  totalProducts: number;
  totalInStock: number;
  brands: ManufacturerBrandEntry[];
  escapeBrands: ManufacturerBrandEntry[];
  featuredBrands: ManufacturerBrandEntry[];
}

interface InternalDirectoryCache {
  expiresAt: number;
  directory: ManufacturerBrandsDirectory;
  bySlug: Map<string, ManufacturerBrandEntry>;
  byCompact: Map<string, ManufacturerBrandEntry>;
}

const REDIS_DIR_KEY = 'cache:brand-seo:dir:v1';
const MEMORY_TTL_MS = 20 * 60_000;
const REDIS_TTL_SEC = 1800;

let memoryCache: InternalDirectoryCache | null = null;
let inflightBuild: Promise<InternalDirectoryCache> | null = null;

function indexDirectory(directory: ManufacturerBrandsDirectory): InternalDirectoryCache {
  const bySlug = new Map<string, ManufacturerBrandEntry>();
  const byCompact = new Map<string, ManufacturerBrandEntry>();
  for (const entry of directory.brands) {
    bySlug.set(entry.slug, entry);
    const compact = compactManufacturerBrandSlug(entry.slug);
    if (compact && !byCompact.has(compact)) byCompact.set(compact, entry);
  }
  return {
    expiresAt: Date.now() + MEMORY_TTL_MS,
    directory,
    bySlug,
    byCompact,
  };
}

async function buildDirectoryFromDb(pool: Pool): Promise<ManufacturerBrandsDirectory> {
  const [brandsRes, catsRes] = await Promise.all([
    pool.query<{
      brand: string;
      product_count: number;
      model_count: number;
      in_stock_count: number;
      escape_count: number;
    }>(`
      SELECT trim(brand) AS brand,
             count(*)::int AS product_count,
             count(DISTINCT COALESCE(NULLIF(family_code, ''), sku))::int AS model_count,
             count(*) FILTER (WHERE stock > 0)::int AS in_stock_count,
             count(*) FILTER (WHERE category_id IN (1007, 1000048, 1030))::int AS escape_count
        FROM products
       WHERE status = 'published'
         AND price > 0
         AND brand IS NOT NULL
         AND trim(brand) <> ''
       GROUP BY trim(brand)
    `),
    pool.query<{
      brand: string;
      cat_id: number;
      cat_name: string;
      cat_slug: string;
      parent_id: number | null;
      parent_name: string | null;
      parent_slug: string | null;
      cnt: number;
    }>(`
      SELECT trim(p.brand) AS brand,
             c.id AS cat_id,
             c.name AS cat_name,
             c.slug AS cat_slug,
             c.parent_id AS parent_id,
             pc.name AS parent_name,
             pc.slug AS parent_slug,
             count(*)::int AS cnt
        FROM products p
        JOIN categories c ON c.id = COALESCE(p.category2_id, p.category_id)
        LEFT JOIN categories pc ON pc.id = c.parent_id AND pc.slug NOT LIKE 'old-%'
       WHERE p.status = 'published'
         AND p.price > 0
         AND p.brand IS NOT NULL
         AND trim(p.brand) <> ''
         AND c.slug NOT LIKE 'old-%'
         AND c.id NOT IN (1011, 634)
         AND COALESCE(c.parent_id, 0) NOT IN (1011, 634)
         AND c.slug NOT ILIKE '%promocional%'
       GROUP BY trim(p.brand), c.id, c.name, c.slug, c.parent_id, pc.name, pc.slug
       ORDER BY trim(p.brand), cnt DESC
    `),
  ]);

  const catsByBrand = new Map<string, BrandCategorySummary[]>();
  for (const r of catsRes.rows) {
    if (isExcludedSupplierBrand(r.brand)) continue;
    const list = catsByBrand.get(r.brand) || [];
    if (list.length >= 8) continue;
    const catalogHref = r.parent_slug
      ? `/universales/${r.parent_slug}/${r.cat_slug}`
      : `/universales/${r.cat_slug}`;
    list.push({
      id: r.cat_id,
      name: r.cat_name,
      slug: r.cat_slug,
      parentId: r.parent_id && r.parent_id > 0 ? r.parent_id : null,
      parentName: r.parent_name || null,
      parentSlug: r.parent_slug || null,
      count: r.cnt,
      catalogHref,
    });
    catsByBrand.set(r.brand, list);
  }

  const featuredRank = new Map<string, number>(
    FEATURED_MANUFACTURER_ORDER.map((b, idx) => [b.toUpperCase(), idx]),
  );

  const bySlugDedup = new Map<string, ManufacturerBrandEntry>();
  let totalProducts = 0;
  let totalInStock = 0;

  for (const row of brandsRes.rows) {
    const rawBrand = String(row.brand || '').trim();
    if (!rawBrand || isExcludedSupplierBrand(rawBrand)) continue;
    const slug = slugifyManufacturerBrand(rawBrand);
    if (!slug) continue;

    const upper = rawBrand.toUpperCase();
    const isEscapeSpecialist = ESCAPE_SPECIALIST_BRANDS.has(upper) || row.escape_count >= 15;
    const isFeatured = featuredRank.has(upper);

    totalProducts += row.product_count;
    totalInStock += row.in_stock_count;

    const existing = bySlugDedup.get(slug);
    if (existing) {
      existing.productCount += row.product_count;
      existing.modelCount += row.model_count;
      existing.inStockCount += row.in_stock_count;
      existing.escapeCount += row.escape_count;
      if (isEscapeSpecialist) existing.isEscapeSpecialist = true;
      if (isFeatured) existing.isFeatured = true;
      continue;
    }

    bySlugDedup.set(slug, {
      brand: rawBrand,
      name: formatManufacturerBrandDisplay(rawBrand),
      slug,
      productCount: row.product_count,
      modelCount: row.model_count,
      inStockCount: row.in_stock_count,
      escapeCount: row.escape_count,
      isEscapeSpecialist,
      isFeatured,
      topCategories: catsByBrand.get(rawBrand) || [],
    });
  }

  const brands = [...bySlugDedup.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const escapeBrands = brands
    .filter((b) => b.isEscapeSpecialist && b.escapeCount > 0)
    .sort((a, b) => {
      const ra = featuredRank.get(a.brand.toUpperCase()) ?? 999;
      const rb = featuredRank.get(b.brand.toUpperCase()) ?? 999;
      return ra - rb || b.escapeCount - a.escapeCount || b.inStockCount - a.inStockCount;
    });

  const featuredBrands = brands
    .filter((b) => b.isFeatured)
    .sort((a, b) => {
      const ra = featuredRank.get(a.brand.toUpperCase()) ?? 999;
      const rb = featuredRank.get(b.brand.toUpperCase()) ?? 999;
      return ra - rb;
    });

  return {
    totalBrands: brands.length,
    totalProducts,
    totalInStock,
    brands,
    escapeBrands,
    featuredBrands,
  };
}

async function getInternalCache(pool: Pool): Promise<InternalDirectoryCache> {
  if (memoryCache && memoryCache.expiresAt > Date.now()) return memoryCache;
  if (inflightBuild) return inflightBuild;

  inflightBuild = (async () => {
    try {
      const fromRedis = await cacheGet<ManufacturerBrandsDirectory>(REDIS_DIR_KEY);
      if (fromRedis && Array.isArray(fromRedis.brands) && fromRedis.brands.length > 0) {
        const indexed = indexDirectory(fromRedis);
        memoryCache = indexed;
        return indexed;
      }
      const built = await buildDirectoryFromDb(pool);
      await cacheSet(REDIS_DIR_KEY, built, REDIS_TTL_SEC);
      const indexed = indexDirectory(built);
      memoryCache = indexed;
      return indexed;
    } finally {
      inflightBuild = null;
    }
  })();

  return inflightBuild;
}

/** Devuelve el directorio completo de marcas activas (sin BIHR). */
export async function getManufacturerBrandsDirectory(pool: Pool): Promise<ManufacturerBrandsDirectory> {
  const cache = await getInternalCache(pool);
  return cache.directory;
}

export interface ResolvedManufacturerBrand {
  entry: ManufacturerBrandEntry;
  needsRedirect: boolean;
  canonicalPath: string;
}

/**
 * Resuelve un slug de marca recibido en `/marcas/:brandSlug`.
 * Devuelve `null` si no existe o si es BIHR, y marca `needsRedirect: true`
 * cuando llega con mayúsculas, espacios o sin guiones («IXIL», «yoshimuraus»).
 */
export async function resolveManufacturerBrandSlug(
  pool: Pool,
  rawParam: string,
): Promise<ResolvedManufacturerBrand | null> {
  const trimmed = String(rawParam || '').trim();
  if (!trimmed || isExcludedSupplierBrand(trimmed)) return null;

  const normalized = slugifyManufacturerBrand(trimmed);
  if (!normalized || isExcludedSupplierBrand(normalized)) return null;

  const cache = await getInternalCache(pool);
  const exact = cache.bySlug.get(normalized);
  if (exact) {
    return {
      entry: exact,
      needsRedirect: trimmed !== exact.slug,
      canonicalPath: `/marcas/${exact.slug}`,
    };
  }

  const compact = compactManufacturerBrandSlug(trimmed);
  const byCompact = compact ? cache.byCompact.get(compact) : undefined;
  if (byCompact) {
    return {
      entry: byCompact,
      needsRedirect: true,
      canonicalPath: `/marcas/${byCompact.slug}`,
    };
  }

  return null;
}

const LEGACY_EXHAUST_URL_RE =
  /(^|-)(mivv|akrapovic|arrow|leovince|leo-vince|termignoni|sc-project|yoshimura|scorpion|remus|devil|ixil|yasuni|tecnigas|fresco|full-system|slip-on|silencioso|silenciador|colector|tubo-no-kat)(-|$)/i;

/**
 * Rescata URLs descriptivas antiguas de WooCommerce detectadas como 404 en Search Console
 * (p. ej. `/producto/mivv-slip-on-dakar-st-steel-aprilia-tuareg-660-2022-25` → `/escapes/aprilia/tuareg-660`).
 *
 * Solo actúa sobre slugs descriptivos largos (>= 4 palabras separadas por guiones) que contienen
 * términos inequívocos de escapes antiguos; cualquier SKU inexistente normal sigue devolviendo 404.
 */
export function resolveLegacyProductRedirect(rawSlug: string): string | null {
  const clean = slugifyMoto(rawSlug);
  if (!clean) return null;
  const tokens = clean.split('-').filter(Boolean);
  if (tokens.length < 4) return null;
  if (!LEGACY_EXHAUST_URL_RE.test(clean)) return null;

  const index = getHierarchyIndex();
  const padded = `-${clean}-`;

  // Buscar la marca de moto con el slug más específico presente en la URL antigua.
  let matchedBrand = null as (typeof index.brands)[number] | null;
  for (const brandNode of index.brands) {
    if (brandNode.slug.length < 3 && brandNode.slug !== 'kt') continue;
    if (padded.includes(`-${brandNode.slug}-`)) {
      if (!matchedBrand || brandNode.slug.length > matchedBrand.slug.length) {
        matchedBrand = brandNode;
      }
    }
  }

  if (!matchedBrand) {
    return '/escapes';
  }

  // Tomar la porción posterior a la marca en el slug antiguo para localizar el modelo.
  const brandMarker = `-${matchedBrand.slug}-`;
  const afterIdx = padded.lastIndexOf(brandMarker);
  const tail = afterIdx >= 0 ? padded.slice(afterIdx + brandMarker.length) : padded;

  let matchedModel = null as (typeof matchedBrand.models)[number] | null;
  let bestScore = 0;

  for (const modelNode of matchedBrand.models) {
    if (!modelNode.slug || modelNode.slug.length < 2) continue;
    if (tail.includes(`${modelNode.slug}-`)) {
      const score = modelNode.slug.length + 100;
      if (score > bestScore) {
        bestScore = score;
        matchedModel = modelNode;
      }
      continue;
    }
    const cleanModelSlug = slugifyMoto(modelNode.cleanName);
    if (cleanModelSlug && cleanModelSlug.length >= 3 && tail.includes(`${cleanModelSlug}-`)) {
      const score = cleanModelSlug.length;
      if (score > bestScore) {
        bestScore = score;
        matchedModel = modelNode;
      }
    }
  }

  if (matchedModel) {
    return `/escapes/${matchedBrand.slug}/${matchedModel.slug}`;
  }
  return `/escapes/${matchedBrand.slug}`;
}
