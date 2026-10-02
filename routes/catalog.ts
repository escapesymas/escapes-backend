import { Router } from 'express';
import { db, pool } from '../db.js';
import { sql } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import sharp from 'sharp';
import { cacheSet, cacheGet } from '../lib/cache.js';
import { sanitizeLike, sanitizeString } from '../utils.js';
import { getLiveStockValue } from '../bihrService.js';
import { findCompatibleSkus } from '../lib/compat.js';
import { tyreOptions } from '../lib/tyres.js';
import { listFamilies, facets, familyTitle, compareOptionValues, familyVariants, normalizeText, type CatalogParams, type SortKey } from '../lib/catalog-query.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const catalogRouter = Router();

// Columnas necesarias para pintar una tarjeta de producto en listados. Evita
// enviar descripción HTML, atributos y compatibilidades (cientos de KB por
// producto en algunos casos: la sección de compatibles llegaba a 17 MB).
const PRODUCT_CARD_COLUMNS = `id, sku, name, price, sale_price, stock, images, category_id, status, brand, dropshipping, ondemand, family_code, variant_options`;

/** Agrupa filas de tarjeta por modelo: una tarjeta por familia con resumen de variantes. */
function groupCardsByFamily(rows: any[]): any[] {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = r.family_code || r.sku;
    (groups.get(key) || groups.set(key, []).get(key)!).push(r);
  }
  const out: any[] = [];
  for (const [code, list] of groups) {
    const eff = (r: any) => (r.sale_price && r.sale_price > 0 ? r.sale_price : r.price);
    const rep = [...list].sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || eff(a) - eff(b))[0];
    const mapped: any = mapProductToFrontend(rep);
    if (list.length > 1) {
      const options: Record<string, string[]> = {};
      for (const r of list) {
        for (const [k, v] of Object.entries((r.variant_options || {}) as Record<string, string>)) {
          (options[k] ||= []).includes(v) || options[k].push(v);
        }
      }
      for (const k of Object.keys(options)) options[k] = options[k].map((value) => ({ value })).sort(compareOptionValues).map((x) => x.value);
      const names = list.map((r) => r.name).sort();
      const freq = new Map<string, number>();
      for (const n of names) freq.set(n, (freq.get(n) || 0) + 1);
      const mostCommon = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      mapped.name = mapped.title = familyTitle(names[0], names[names.length - 1], rep.name, mostCommon);
      mapped.family = {
        code, variantCount: list.length,
        priceMin: Math.min(...list.map(eff)) / 100, priceMax: Math.max(...list.map(eff)) / 100,
        inStock: list.some((r) => r.stock > 0), options,
      };
    }
    mapped.variantOptions = rep.variant_options || null;
    out.push(mapped);
  }
  return out;
}

const OPTIMIZED_DIR = path.join(process.cwd(), 'uploads', 'optimized');

const ALLOWED_IMAGE_WIDTHS = new Set([200, 400, 800]);

const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wgARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAWAOH/2gAIAQAEAAAAFP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8A/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA//9k=',
  'base64',
);

function servePlaceholder(res: any, reason: string): void {
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=300');
  res.set('X-Image-Cache', `PLACEHOLDER:${reason}`);
  res.end(PLACEHOLDER_JPEG);
}

function sanitizeSkuForFilename(sku: string): string {
  if (!sku) return '';
  return sku.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildInClause(arr: any[]) {
  return sql.join(arr.map(v => sql`${v}`), sql`, `);
}

function isRemoteImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && !url.includes('/uploads/') && !url.includes('/api/image-proxy');
}

function cdnUrl(relativePath: string): string {
  if (!relativePath) return '';
  if (/^https?:\/\//i.test(relativePath)) return relativePath;
  return relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
}

function localImageForSku(sku: string, variant: 'desktop' | 'mobile' | 'card', idx: number): string | null {
  const safeSku = sanitizeSkuForFilename(sku);
  if (!safeSku) return null;
  const width = variant === 'mobile' ? 400 : 800;
  const fileName = `${safeSku}-${width}.webp`;
  const fullPath = path.join(OPTIMIZED_DIR, fileName);
  if (fs.existsSync(fullPath)) {
    return `/uploads/optimized/${fileName}`;
  }
  return null;
}

// Atributos que se pueden mostrar al cliente (con su etiqueta en español).
// Todo lo demás que trae el proveedor (precio de compra, stock del almacén,
// códigos internos, URLs de su API…) NO sale de la API pública.
const PUBLIC_ATTRIBUTES: Record<string, string> = {
  Talla: 'Talla',
  Color: 'Color',
  'Modelo de casco': 'Modelo',
  'Estilo de casco': 'Tipo de casco',
  Homologación: 'Homologación',
  Composición: 'Material',
  Material: 'Material',
  'Tipo de cierre': 'Cierre',
  'Estilo de pintura': 'Decoración',
  'Acabado de la pintura': 'Acabado',
  Acabado: 'Acabado',
  'Color de la lente': 'Color de la lente',
  'Interior desmontable': 'Interior desmontable',
  'Tipo de pieza de repuesto': 'Tipo de recambio',
  Posición: 'Posición',
  'Tipo de escape': 'Tipo de escape',
  Colección: 'Colección',
  Uso: 'Uso',
  Gama: 'Gama',
  // Neumáticos
  'Categoría de neumático': 'Tipo de neumático',
  'Estructura de neumático': 'Estructura',
  'Índice de carga del neumático (IC)': 'Índice de carga',
  'Índice de velocidad (CV)': 'Índice de velocidad',
  'Sin cámara o tipo de cámara': 'Montaje',
};

function rawAttributes(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return {}; } }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** Atributos visibles para el cliente: { 'Material': 'Fibra de vidrio', … } */
export function publicAttributes(raw: any, variantOptions?: Record<string, string> | null): Record<string, string> {
  const attrs = rawAttributes(raw);
  const out: Record<string, string> = {};
  for (const [key, label] of Object.entries(PUBLIC_ATTRIBUTES)) {
    const v = (variantOptions && variantOptions[key]) ?? attrs[key];
    if (v !== undefined && v !== null && String(v).trim() && !out[label]) out[label] = String(v).trim();
  }
  for (const [k, v] of Object.entries(variantOptions || {})) {
    if (!out[k] && v) out[k] = String(v);
  }
  return out;
}

/**
 * Descripción a mostrar: la más completa entre la columna (a veces cortada a
 * 2000 caracteres a mitad de etiqueta) y la HtmlDescription del proveedor.
 */
function bestDescription(row: any): string {
  const attrs = rawAttributes(row.attributes);
  const candidates = [row.description, attrs.HtmlDescription, attrs.Description]
    .filter((d) => typeof d === 'string' && d.trim()) as string[];
  const best = candidates.sort((a, b) => b.length - a.length)[0] || '';
  return best.replace(/<[^>]*$/, '').trim(); // etiqueta cortada al final
}

export function mapProductToFrontend(row: any) {
  const priceEur = (row.price || 0) / 100;
  const salePriceEur = row.sale_price ? row.sale_price / 100 : null;
  let images: any[] = [];
  if (row.images) {
    if (typeof row.images === 'string') {
      try { images = JSON.parse(row.images); } catch { images = []; }
    } else {
      images = row.images;
    }
  }
  
  images = (Array.isArray(images) ? images : []).map((img: any, idx: number) => {
    if (typeof img === 'string') {
      img = { src: img, alt: row.name };
    }
    if (img.srcSet && typeof img.srcSet === 'object') {
      img = {
        src: img.src,
        srcMobile: img.srcSet.mobile || img.srcSet['mobile'],
        srcCardDesktop: img.srcSet['card-desktop'] || img.srcSet.cardDesktop,
        srcCardMobile: img.srcSet['card-mobile'] || img.srcSet.cardMobile,
        alt: img.alt || row.name
      };
    }
    if (img.url && !img.src) {
      img.src = img.url;
    }
    if (img.src && !img.srcCardMobile) img.srcCardMobile = img.src;
    if (img.src && !img.srcCardDesktop) img.srcCardDesktop = img.src;
    if (img.src && !img.srcMobile) img.srcMobile = img.src;

    if (img.src && isRemoteImageUrl(img.src)) {
      const local = localImageForSku(row.sku, 'desktop', idx);
      if (local) img.src = cdnUrl(local);
      else if (/^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(img.src)) {
        img.src = `/api/image-proxy?w=800&url=${encodeURIComponent(img.src)}`;
      }
    }
    if (img.srcMobile && isRemoteImageUrl(img.srcMobile)) {
      const local = localImageForSku(row.sku, 'mobile', idx);
      if (local) img.srcMobile = cdnUrl(local);
      else if (/^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(img.srcMobile)) {
        img.srcMobile = `/api/image-proxy?w=400&url=${encodeURIComponent(img.srcMobile)}`;
      }
    }
    return img;
  });

  const slug = row.slug || row.sku || String(row.id);

  return {
    id: row.id,
    sku: row.sku,
    slug,
    name: row.name,
    title: row.name,
    description: bestDescription(row),
    price: priceEur,
    regularPrice: priceEur,
    sale_price: salePriceEur,
    salePrice: salePriceEur,
    stock: typeof row.stock === 'string' ? parseInt(row.stock, 10) : (row.stock || 0),
    inStock: (typeof row.stock === 'string' ? parseInt(row.stock, 10) : (row.stock || 0)) > 0,
    brand: row.brand || '',
    category_id: row.category_id,
    categoryId: row.category_id,
    images,
    image: images[0]?.src || '',
    compatibility: row.compatibility || [],
    attributes: publicAttributes(row.attributes, row.variant_options),
    barcode: row.barcode || '',
    weight_g: row.weight_g || null,
    category: row.category_name || '',
    categorySlug: row.category_slug || '',
    parentCategory: row.parent_category_name || '',
    parentCategorySlug: row.parent_category_slug || '',
    status: row.status || 'published',
    avg_rating: row.avg_rating ? parseFloat(row.avg_rating) : 0,
    averageRating: row.avg_rating ? parseFloat(row.avg_rating) : 0,
    review_count: row.review_count ? parseInt(row.review_count, 10) : 0,
    ratingCount: row.review_count ? parseInt(row.review_count, 10) : 0,
    dropshipping: !!row.dropshipping,
    ondemand: !!row.ondemand
  };
}

let catalogDataCache: any = null;
function getCatalogData() {
  if (catalogDataCache) return catalogDataCache;

  const candidates = [
    path.join(__dirname, '..', 'moto_catalog.json'),
    path.join(__dirname, 'moto_catalog.json'),
    path.join(process.cwd(), 'moto_catalog.json'),
    path.join(process.cwd(), 'escapes-backend', 'moto_catalog.json'),
    path.join(process.cwd(), 'server', 'moto_catalog.json'),
    '/app/server/moto_catalog.json',
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        catalogDataCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return catalogDataCache;
      }
    } catch {
      // continue
    }
  }

  catalogDataCache = { hierarchy: {}, compatibility: {} };
  return catalogDataCache;
}


function parseTitleYears(title: string): [number, number] | null {
  let match = title.match(/\b(20\d{2})[-–](20\d{2})\b/);
  if (match) return [parseInt(match[1], 10), parseInt(match[2], 10)];

  match = title.match(/\b(19\d{2}|20\d{2})[-–]\b/) || title.match(/\((\d{2})[-–]\)/);
  if (match) {
    let y = parseInt(match[1], 10);
    if (y < 100) y = 2000 + y;
    return [y, 2030];
  }

  match = title.match(/\b(\d{2})[-–](\d{2})\b/);
  if (match) {
    let y1 = parseInt(match[1], 10);
    let y2 = parseInt(match[2], 10);
    if (y1 < 100) y1 = (y1 > 70 ? 1900 : 2000) + y1;
    if (y2 < 100) y2 = (y2 > 70 ? 1900 : 2000) + y2;
    return [y1, y2];
  }

  return null;
}


// GET /api/vehicles
catalogRouter.get('/vehicles', async (req, res) => {
  const { action, brand, model, year } = req.query as any;
  try {
    const redisKey = `cache:vehicles:v6:${action || ''}:${brand || ''}:${model || ''}:${year || ''}`;
    const cached = await cacheGet<any>(redisKey);
    if (cached) return res.json(cached);

    const catalog = getCatalogData();
    const hierarchy = catalog?.hierarchy || {};

    let responseData: any = [];
    if (action === 'brands') {
      responseData = Object.keys(hierarchy).sort();
    } else if (action === 'models') {
      responseData = Object.keys(hierarchy[brand] || {}).sort();
    } else if (action === 'years') {
      responseData = Object.keys(hierarchy[brand]?.[model] || {}).sort((a: any, b: any) => b - a);
    } else if (action === 'compatible-skus') {
      const skusSet = new Set<string>();

      // 1. SKUs compatibles según products.compatibility (consulta indexada, ver lib/compat.ts)
      if (brand && model) {
        try {
          (await findCompatibleSkus(brand, model, year)).forEach((sku) => skusSet.add(sku));
        } catch (e) {
          console.error('Error fetching DB compatibility:', e);
        }
      }

      // 2. SKUs desde moto_catalog.json (jerarquía y mapeo de compatibilidad en memoria)
      const matchedBrandKey = brand ? (Object.keys(hierarchy).find(k => k.toLowerCase() === brand.toLowerCase()) || brand.toUpperCase()) : '';
      if (matchedBrandKey && hierarchy[matchedBrandKey]) {
        const compatibilityMap = catalog?.compatibility || {};
        let codes: string[] = [];

        if (model) {
          const matchedModelKey = Object.keys(hierarchy[matchedBrandKey] || {}).find(k => k.toLowerCase() === model.toLowerCase()) || model;
          if (year && year !== 'General' && year !== '') {
            codes = hierarchy[matchedBrandKey][matchedModelKey]?.[year] || hierarchy[matchedBrandKey][model]?.[year] || [];
          } else if (hierarchy[matchedBrandKey][matchedModelKey]) {
            Object.values(hierarchy[matchedBrandKey][matchedModelKey]).forEach((cList: any) => {
              if (Array.isArray(cList)) codes.push(...cList);
            });
          }
        } else {
          Object.values(hierarchy[matchedBrandKey]).forEach((modelsObj: any) => {
            if (modelsObj) {
              Object.values(modelsObj).forEach((cList: any) => {
                if (Array.isArray(cList)) codes.push(...cList);
              });
            }
          });
        }

        codes.forEach(code => {
          const vehicleSkus = compatibilityMap[code] || [];
          vehicleSkus.forEach((sku: string) => skusSet.add(sku));
          skusSet.add(code);
        });
      }

      // 3. SKUs desde bihr_compatibility_cache.json (compatibilidades sincronizadas en memoria)
      const cacheFile = path.join(process.cwd(), 'bihr_compatibility_cache.json');
      if (fs.existsSync(cacheFile)) {
        try {
          const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
          const bLower = (brand || '').toLowerCase();
          const mLower = (model || '').toLowerCase();
          const yStr = year ? String(year) : '';

          for (const [sku, list] of Object.entries(cacheData)) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
              if (!item.brand) continue;
              const matchBrand = bLower && (item.brand.toLowerCase().includes(bLower) || bLower.includes(item.brand.toLowerCase()));
              const matchModel = !mLower || (item.model && (item.model.toLowerCase().includes(mLower) || mLower.includes(item.model.toLowerCase())));
              const matchYear = !yStr || (item.year && String(item.year) === yStr);

              if (matchBrand && matchModel && matchYear) {
                skusSet.add(sku);
                break;
              }
            }
          }
        } catch (e) {}
      }

      responseData = Array.from(skusSet);
    } else if (action === 'compatible-products') {
      const prodRedisKey = `compat:prod:v8:${(brand||'').toLowerCase()}:${(model||'').toLowerCase()}:${year||''}`;
      const cachedProducts = await cacheGet<any[]>(prodRedisKey);
      if (cachedProducts) {
        return res.json(cachedProducts);
      }

      const skusSet = new Set<string>();

      // 1. SKUs compatibles según products.compatibility (consulta indexada, ver lib/compat.ts)
      if (brand && model) {
        try {
          (await findCompatibleSkus(brand, model, year)).forEach((sku) => skusSet.add(sku));
        } catch (e) {
          console.error('Error fetching DB compatibility:', e);
        }
      }

      // 2. SKUs desde moto_catalog.json
      const matchedBrandKey = brand ? (Object.keys(hierarchy).find(k => k.toLowerCase() === brand.toLowerCase()) || brand.toUpperCase()) : '';
      if (matchedBrandKey && hierarchy[matchedBrandKey]) {
        const compatibilityMap = catalog?.compatibility || {};
        let codes: string[] = [];

        if (model) {
          const matchedModelKey = Object.keys(hierarchy[matchedBrandKey] || {}).find(k => k.toLowerCase() === model.toLowerCase()) || model;
          if (year && year !== 'General' && year !== '') {
            codes = hierarchy[matchedBrandKey][matchedModelKey]?.[year] || hierarchy[matchedBrandKey][model]?.[year] || [];
          } else if (hierarchy[matchedBrandKey][matchedModelKey]) {
            Object.values(hierarchy[matchedBrandKey][matchedModelKey]).forEach((cList: any) => {
              if (Array.isArray(cList)) codes.push(...cList);
            });
          }
        } else {
          Object.values(hierarchy[matchedBrandKey]).forEach((modelsObj: any) => {
            if (modelsObj) {
              Object.values(modelsObj).forEach((cList: any) => {
                if (Array.isArray(cList)) codes.push(...cList);
              });
            }
          });
        }

        codes.forEach(code => {
          const vehicleSkus = compatibilityMap[code] || [];
          vehicleSkus.forEach((sku: string) => skusSet.add(sku));
          skusSet.add(code);
        });
      }

      // 3. SKUs desde bihr_compatibility_cache.json
      const cacheFile = path.join(process.cwd(), 'bihr_compatibility_cache.json');
      if (fs.existsSync(cacheFile)) {
        try {
          const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
          const bLower = (brand || '').toLowerCase();
          const mLower = (model || '').toLowerCase();
          const yStr = year ? String(year) : '';

          for (const [sku, list] of Object.entries(cacheData)) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
              if (!item.brand) continue;
              const matchBrand = bLower && (item.brand.toLowerCase().includes(bLower) || bLower.includes(item.brand.toLowerCase()));
              const matchModel = !mLower || (item.model && (item.model.toLowerCase().includes(mLower) || mLower.includes(item.model.toLowerCase())));
              const matchYear = !yStr || (item.year && String(item.year) === yStr);

              if (matchBrand && matchModel && matchYear) {
                skusSet.add(sku);
                break;
              }
            }
          }
        } catch (e) {}
      }

      const skusList = Array.from(skusSet).slice(0, 500);
      if (skusList.length === 0) {
        await cacheSet(prodRedisKey, [], 600);
        return res.json([]);
      }

      const productsRes = await pool.query(
        `SELECT ${PRODUCT_CARD_COLUMNS} FROM products WHERE status = 'published' AND price > 0 AND sku = ANY($1) ORDER BY price ASC`,
        [skusList]
      );
      const products = groupCardsByFamily(productsRes.rows);
      await cacheSet(prodRedisKey, products, 600);
      return res.json(products);
    } else {
      responseData = Object.keys(hierarchy).sort();
    }

    await cacheSet(redisKey, responseData, 3600);
    res.json(responseData);
  } catch (err: any) {
    console.error('[VEHICLES ROUTE ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/catalog/sitemap-skus
catalogRouter.get('/catalog/sitemap-skus', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit as string) || 5000));
    const offset = (page - 1) * limit;

    const result = await db.execute(sql`
      SELECT sku, updated_at FROM products WHERE status = 'published' ORDER BY id ASC LIMIT ${limit} OFFSET ${offset}
    `);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/search/suggestions
catalogRouter.get('/search/suggestions', async (req, res) => {
  try {
    const q = String(req.query.q || '').slice(0, 120).trim();
    if (q.length < 2) return res.json({ suggestions: [], products: [] });
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 6, 1), 10);

    const cacheKey = `cache:suggest:v2:${normalizeText(q)}:${limit}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) return res.json(cached);

    // Mismo motor que el catálogo: sinónimos, plurales, erratas y un resultado por modelo.
    const { rows } = await listFamilies({ search: q }, 'relevance', 1, limit);
    const reps = rows.length
      ? (await pool.query(`SELECT ${PRODUCT_CARD_COLUMNS} FROM products WHERE id = ANY($1)`, [rows.map((r) => r.rep_id)])).rows
      : [];
    const byId = new Map(reps.map((r: any) => [r.id, r]));
    const products = rows.map((f) => {
      const row: any = byId.get(f.rep_id);
      if (!row) return null;
      const m: any = mapProductToFrontend(row);
      if (f.n > 1) m.name = m.title = familyTitle(f.nmin, f.nmax, row.name, f.nmode);
      return m;
    }).filter(Boolean);

    // Marcas que coinciden con lo escrito, como sugerencia rápida.
    const brands = await pool.query(
      `SELECT DISTINCT brand FROM products WHERE status = 'published' AND brand ILIKE $1 ORDER BY brand LIMIT 3`,
      [`${q.replace(/[\\%_]/g, '')}%`]
    );
    const result = { suggestions: brands.rows.map((r: any) => r.brand), products };
    await cacheSet(cacheKey, result, 300);
    res.json(result);
  } catch (err: any) {
    console.error('[SEARCH SUGGESTIONS ERROR]:', err);
    res.status(500).json({ error: 'Error en las sugerencias' });
  }
});

// Parámetros comunes de listado y facetas.
function parseCatalogParams(query: any): CatalogParams {
  const int = (v: any) => {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  let attrs: Record<string, string[]> = {};
  const rawAttrs = typeof query.attrs === 'string' ? query.attrs : '';
  if (rawAttrs && rawAttrs.length <= 1000) {
    try {
      const parsed = JSON.parse(rawAttrs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed).slice(0, 8)) {
          const list = (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter(Boolean).slice(0, 20);
          if (list.length) attrs[String(k).slice(0, 60)] = list;
        }
      }
    } catch { attrs = {}; }
  }
  const brands = String(query.brand || query.brands || '').split(',').map((b) => b.trim()).filter(Boolean).slice(0, 30);
  const minEur = int(query.min_price);
  const maxEur = int(query.max_price);
  return {
    search: query.search ? String(query.search).slice(0, 120) : (query.q ? String(query.q).slice(0, 120) : undefined),
    categoryId: int(query.category_id),
    categorySlug: !query.category_id && query.category_slug ? String(query.category_slug).slice(0, 120) : undefined,
    brands,
    minPriceCents: minEur != null ? minEur * 100 : null,
    maxPriceCents: maxEur != null ? maxEur * 100 : null,
    inStock: query.in_stock === 'true' || query.in_stock === '1',
    attrs,
    // 'universal=true' lo envía el frontend desde siempre pero nunca se aplicó:
    // /universales muestra todo el catálogo. Solo se filtra con universal=only.
    universal: query.universal === 'only',
  };
}

function cacheKeyFor(prefix: string, query: any): string {
  const s = JSON.stringify(Object.keys(query).sort().map((k) => [k, query[k]]));
  return `${prefix}:${crypto.createHash('sha256').update(s).digest('hex')}`;
}

// GET /api/catalog/products
// Lista MODELOS (una tarjeta por modelo con sus variantes) salvo group=0.
catalogRouter.get('/catalog/products', async (req, res) => {
  try {
    const query = req.query as any;
    const pageNum = Math.max(1, parseInt(query.page, 10) || 1);
    const perPage = Math.min(Math.max(1, parseInt(query.per_page, 10) || 20), 48);
    const sortParam = String(query.sort || '');
    const sort: SortKey = (['relevance', 'price_asc', 'price_desc', 'name_asc', 'newest'] as SortKey[])
      .includes(sortParam as SortKey) ? (sortParam as SortKey) : (query.search || query.q ? 'relevance' : 'relevance');

    const redisKey = cacheKeyFor('cache:products:v4', query);
    type Payload = { products: any[]; total: number; refs?: number; totalPages: number; fuzzy: boolean; corrected?: string | null };
    const cached = await cacheGet<Payload>(redisKey);
    const send = (data: Payload) => {
      res.setHeader('Access-Control-Expose-Headers', 'X-WP-Total, X-WP-TotalPages, X-Total-Refs, X-Search-Fuzzy, X-Search-Corrected');
      res.setHeader('X-Total-Refs', String(data.refs ?? data.total));
      if (data.corrected) res.setHeader('X-Search-Corrected', encodeURIComponent(data.corrected));
      res.setHeader('X-WP-Total', String(data.total));
      res.setHeader('X-WP-TotalPages', String(data.totalPages));
      res.setHeader('X-Search-Fuzzy', data.fuzzy ? '1' : '0');
      return res.json(data.products);
    };
    if (cached) return send(cached);

    const params = parseCatalogParams(query);
    const { rows, total, refs, fuzzy, corrected } = await listFamilies(params, sort, pageNum, perPage);

    const repIds = rows.map((r) => r.rep_id);
    const repRes = repIds.length
      ? await pool.query(`SELECT ${PRODUCT_CARD_COLUMNS} FROM products WHERE id = ANY($1)`, [repIds])
      : { rows: [] as any[] };
    const byId = new Map(repRes.rows.map((r: any) => [r.id, r]));

    const products = rows.map((f) => {
      const row: any = byId.get(f.rep_id);
      if (!row) return null;
      const mapped: any = mapProductToFrontend(row);
      const options: Record<string, string[]> = {};
      for (const [k, vals] of Object.entries(f.opts || {})) {
        options[k] = [...(vals as string[])].map((value) => ({ value })).sort(compareOptionValues).map((x) => x.value);
      }
      const title = f.n > 1 ? familyTitle(f.nmin, f.nmax, row.name, f.nmode) : row.name;
      mapped.title = title;
      mapped.name = title;
      mapped.variantOptions = row.variant_options || null;
      mapped.family = {
        code: f.family_code,
        variantCount: f.n,
        priceMin: Number(f.pmin) / 100,
        priceMax: Number(f.pmax) / 100,
        inStock: f.any_stock,
        options,
      };
      return mapped;
    }).filter(Boolean);

    const data = { products, total, refs, totalPages: Math.max(1, Math.ceil(total / perPage)), fuzzy, corrected };
    await cacheSet(redisKey, data, 60);
    return send(data);
  } catch (err: any) {
    console.error('[CATALOG PRODUCTS ROUTE ERROR]:', err);
    return res.status(500).json({ error: 'Error al cargar el catálogo' });
  }
});

// GET /api/catalog/filters
// Mismos parámetros que /catalog/products; recuentos por modelo.
// GET /api/catalog/tyres/options — buscador de neumáticos por medida y tipo.
catalogRouter.get('/catalog/tyres/options', async (req, res) => {
  try {
    const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 20) : '') || undefined;
    const categoryId = parseInt(String(req.query.category_id || ''), 10);
    const posicion = str(req.query.posicion);
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await tyreOptions({
      categoryId: Number.isFinite(categoryId) && categoryId > 0 ? categoryId : null,
      ancho: str(req.query.ancho),
      perfil: str(req.query.perfil),
      llanta: str(req.query.llanta),
      posicion: posicion === 'Delantero' || posicion === 'Trasero' ? posicion : undefined,
    }));
  } catch (err: any) {
    console.error('[TYRE OPTIONS ERROR]:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar las medidas' });
  }
});

catalogRouter.get('/catalog/filters', async (req, res) => {
  try {
    const query = req.query as any;
    const redisKey = cacheKeyFor('cache:filters:v2', query);
    const cached = await cacheGet<any>(redisKey);
    if (cached) return res.json(cached);

    const f = await facets(parseCatalogParams(query));
    const attributes: Record<string, string[]> = {};
    const attributeCounts: Record<string, { value: string; count: number }[]> = {};
    for (const [k, list] of Object.entries(f.attributes)) {
      if (list.length < 2 && !(parseCatalogParams(query).attrs || {})[k]) continue; // un solo valor no filtra nada
      attributes[k] = list.map((x) => x.value);
      attributeCounts[k] = list;
    }
    const result = {
      brands: f.brands.map((b) => b.value),
      brand_counts: f.brands,
      price_min: Math.floor(f.priceMinCents / 100),
      price_max: Math.ceil(f.priceMaxCents / 100) || 1000,
      attributes,
      attribute_counts: attributeCounts,
      fuzzy: f.fuzzy,
    };
    await cacheSet(redisKey, result, 300);
    res.json(result);
  } catch (err: any) {
    console.error('[FILTERS ERROR]:', err);
    res.status(500).json({ error: 'Error al cargar los filtros' });
  }
});

// GET /api/catalog/product/:id
catalogRouter.get('/catalog/product/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    const result = await db.execute(sql`
      SELECT p.*,
             COALESCE(rs.avg_rating, 0) AS avg_rating,
             COALESCE(rs.review_count, 0) AS review_count,
             c.name AS category_name, c.slug AS category_slug,
             pc.name AS parent_category_name, pc.slug AS parent_category_slug
      FROM products p
      LEFT JOIN product_rating_stats rs ON rs.product_id = p.id
      LEFT JOIN categories c ON c.id = COALESCE(p.category3_id, p.category2_id, p.category_id)
      LEFT JOIN categories pc ON pc.id = c.parent_id
      WHERE p.id = ${id} AND p.status = 'published'
    `);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json(mapProductToFrontend(result.rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/:id/image
catalogRouter.get('/products/:id(\\d+)/image', async (req: any, res: any) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isFinite(productId) || productId <= 0) {
      return servePlaceholder(res, 'bad-id');
    }

    const wRaw = parseInt(String(req.query.w || '800'), 10);
    const w: 200 | 400 | 800 = (ALLOWED_IMAGE_WIDTHS.has(wRaw) ? wRaw : 800) as 200 | 400 | 800;

    const nRaw = parseInt(String(req.query.n || '1'), 10);
    const n = Math.max(1, Math.min(6, Number.isFinite(nRaw) ? nRaw : 1));

    const skuRes = await db.execute(sql`SELECT sku, images FROM products WHERE id = ${productId} LIMIT 1`);
    if (skuRes.rows.length === 0) return servePlaceholder(res, 'no-product');
    const sku = (skuRes.rows[0] as any).sku;
    const safeSku = sanitizeSkuForFilename(sku);
    if (safeSku) {
      const localPath = path.join(OPTIMIZED_DIR, `${safeSku}-${w}.webp`);
      if (fs.existsSync(localPath)) {
        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('X-Image-Cache', 'HIT');
        return fs.createReadStream(localPath).pipe(res);
      }
    }

    const imgs: any[] = (() => {
      let parsed: any[] = [];
      try {
        parsed = typeof (skuRes.rows[0] as any).images === 'string'
          ? JSON.parse((skuRes.rows[0] as any).images)
          : ((skuRes.rows[0] as any).images || []);
      } catch {}
      return Array.isArray(parsed) ? parsed : [];
    })();

    const picked = imgs[n - 1];
    const remoteUrl: string | undefined = picked && (typeof picked === 'string' ? picked : picked.src || picked.url);
    if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) {
      return servePlaceholder(res, 'no-remote-url');
    }

    let upstream: Response;
    try {
      upstream = await fetch(remoteUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; EscapesYMas/1.0; +https://escapesymas.com)',
          'Accept': 'image/jpeg,image/png,image/webp,image/*',
        },
      });
    } catch (err: any) {
      console.warn(`[product-image] upstream fetch failed for product ${productId} url=${remoteUrl}: ${err?.message || err}`);
      return servePlaceholder(res, 'fetch-error');
    }
    if (!upstream.ok) {
      console.warn(`[product-image] upstream ${upstream.status} for product ${productId}`);
      return servePlaceholder(res, `upstream-${upstream.status}`);
    }

    const ab = await upstream.arrayBuffer();
    if (ab.byteLength > 15 * 1024 * 1024) {
      console.warn(`[product-image] upstream too large (${ab.byteLength}B) for product ${productId}`);
      return servePlaceholder(res, 'upstream-too-large');
    }
    const original = Buffer.from(ab);

    let optimized: Buffer;
    try {
      optimized = await sharp(original)
        .resize({ width: w, withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
    } catch (sharpErr: any) {
      console.error(`[product-image] sharp error for product ${productId}: ${sharpErr?.message || sharpErr}`);
      return servePlaceholder(res, 'sharp-error');
    }

    if (safeSku) {
      const localPath = path.join(OPTIMIZED_DIR, `${safeSku}-${w}.webp`);
      fs.promises.writeFile(localPath, optimized).catch(() => {});
    }

    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Image-Cache', 'MISS');
    return res.end(optimized);
  } catch (err: any) {
    console.error('[product-image] unexpected error:', err?.message || err);
    return servePlaceholder(res, 'internal-error');
  }
});

// GET /api/catalog/frequently-bought-together/:productId
const fbCache = new Map<string, { data: any[]; expiresAt: number }>();
const FB_TTL_MS = 5 * 60 * 1000;

catalogRouter.get('/catalog/frequently-bought-together/:productId', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) return res.json([]);

    const cached = fbCache.get(String(productId));
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached.data);
    }

    const result = await db.execute(sql`
      WITH related AS (
        SELECT oi2.product_id AS related_id, COUNT(*) AS co_count
        FROM order_items oi1
        JOIN order_items oi2 ON oi1.order_id = oi2.order_id
        WHERE oi1.product_id = ${productId} AND oi2.product_id != ${productId}
        GROUP BY oi2.product_id
        ORDER BY co_count DESC
        LIMIT 6
      )
      SELECT p.id, p.sku, p.name, p.brand, p.price, p.sale_price, p.stock, p.images,
             r.co_count
      FROM related r
      JOIN products p ON p.id = r.related_id
      WHERE p.status = 'published' AND p.stock > 0
      ORDER BY r.co_count DESC
      LIMIT 6
    `);

    const items = (result.rows as any[]).map((row) => {
      let imgs: any[] = [];
      try {
        imgs = typeof row.images === 'string' ? JSON.parse(row.images) : (row.images || []);
      } catch {}
      let firstImage: string = imgs[0]?.src || imgs[0]?.url || '';
      if (firstImage && /^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(firstImage)) {
        firstImage = `/api/image-proxy?w=400&url=${encodeURIComponent(firstImage)}`;
      }
      return {
        id: row.id,
        sku: row.sku,
        name: row.name,
        brand: row.brand,
        price: row.price,
        sale_price: row.sale_price,
        stock: row.stock,
        image: firstImage,
        co_count: row.co_count,
      };
    });

    fbCache.set(String(productId), { data: items, expiresAt: Date.now() + FB_TTL_MS });
    res.json(items);
  } catch (err: any) {
    console.error('[FREQ BOUGHT ERROR]:', err);
    res.json([]);
  }
});

// GET /api/catalog/product-by-slug/:slug
catalogRouter.get('/catalog/product-by-slug/:slug', async (req, res) => {
  try {
    const slugStr = String(req.params.slug || '');
    const skuStr = slugStr.replace(/-/g, '');
    const rawId = parseInt(slugStr, 10);
    const validId = (!isNaN(rawId) && rawId >= 1 && rawId <= 2147483647 && String(rawId) === slugStr) ? rawId : null;

    const result = await db.execute(sql`
      SELECT p.*,
             COALESCE(rs.avg_rating, 0) AS avg_rating,
             COALESCE(rs.review_count, 0) AS review_count,
             c.name AS category_name, c.slug AS category_slug,
             pc.name AS parent_category_name, pc.slug AS parent_category_slug
      FROM products p
      LEFT JOIN product_rating_stats rs ON rs.product_id = p.id
      LEFT JOIN categories c ON c.id = COALESCE(p.category3_id, p.category2_id, p.category_id)
      LEFT JOIN categories pc ON pc.id = c.parent_id
      WHERE (p.sku = ${slugStr} OR p.sku = ${skuStr} ${validId !== null ? sql`OR p.id = ${validId}` : sql``})
        AND p.status IN ('published', 'duplicate')
      -- La referencia manda sobre el id: '9587' es la ref. de un guante y a la vez
      -- el id interno de un kit de cadena; ambos publicados.
      ORDER BY (p.sku = ${slugStr}) DESC, (p.sku = ${skuStr}) DESC, (p.status = 'published') DESC
      LIMIT 1
    `);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    const row: any = result.rows[0];

    // Ficha duplicada (importación antigua): indicar la canónica para redirigir (301).
    if (row.status === 'duplicate' && row.duplicate_of) {
      const canon = await pool.query(`SELECT sku FROM products WHERE id = $1 AND status = 'published'`, [row.duplicate_of]);
      if (canon.rows.length) return res.json({ redirectTo: canon.rows[0].sku });
      return res.status(404).json({ error: 'No encontrado' });
    }

    const product: any = mapProductToFrontend(row);
    product.variantOptions = row.variant_options || null;
    // Ruta completa de categorías (raíz → hoja) para el breadcrumb.
    const leafId = row.category3_id || row.category2_id || row.category_id;
    if (leafId) {
      const path = await pool.query(`
        WITH RECURSIVE up AS (
          SELECT id, name, slug, parent_id, 0 AS depth FROM categories WHERE id = $1
          UNION ALL SELECT c.id, c.name, c.slug, c.parent_id, up.depth + 1
          FROM categories c JOIN up ON c.id = up.parent_id WHERE up.depth < 6
        ) SELECT name, slug FROM up ORDER BY depth DESC`, [leafId]);
      // Productos aún en el árbol antiguo (p. ej. la 1 "Cascos" por defecto):
      // mejor solo "Catálogo" que una categoría engañosa.
      product.categoryPath = path.rows.some((c: any) => String(c.slug || '').startsWith('old-')) ? [] : path.rows;
    } else {
      product.categoryPath = [];
    }
    product.family = null;
    if (row.family_code) {
      const variants = await familyVariants(row.family_code);
      if (variants.length > 1) {
        const mappedVariants = variants.map((v: any) => {
          const m: any = mapProductToFrontend(v);
          return {
            id: m.id, sku: m.sku, slug: m.slug, name: m.name,
            price: m.price, salePrice: m.salePrice, stock: m.stock, inStock: m.inStock,
            image: m.image, options: v.variant_options || {},
          };
        });
        const axes: Record<string, string[]> = {};
        for (const v of mappedVariants) {
          for (const [k, val] of Object.entries(v.options as Record<string, string>)) {
            (axes[k] ||= []).includes(val) || axes[k].push(val);
          }
        }
        for (const k of Object.keys(axes)) {
          axes[k] = axes[k].map((value) => ({ value })).sort(compareOptionValues).map((x) => x.value);
          if (axes[k].length < 2) delete axes[k];
        }
        // Variante sin foto: usar la de una hermana (mismo color si es posible).
        if (!product.image) {
          const color = row.variant_options?.Color;
          const withImage = variants.filter((v: any) => v.id !== row.id && mapProductToFrontend(v).image);
          const donor = withImage.find((v: any) => v.variant_options?.Color === color) || withImage[0];
          if (donor) {
            const d: any = mapProductToFrontend(donor);
            product.images = d.images;
            product.image = d.image;
          }
        }
        const names = variants.map((v: any) => v.name).sort();
        const freq = new Map<string, number>();
        for (const n of names) freq.set(n, (freq.get(n) || 0) + 1);
        const mostCommon = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        product.family = {
          code: row.family_code,
          title: familyTitle(names[0], names[names.length - 1], row.name, mostCommon),
          axes,
          variants: mappedVariants,
        };
      }
    }
    res.json(product);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/catalog/product/:id/refresh-stock
catalogRouter.post('/catalog/product/:id/refresh-stock', async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (isNaN(productId)) return res.status(400).json({ error: 'ID de producto inválido' });

    const result = await db.execute(sql`
      SELECT id, sku, supplier_code, stock, dropshipping, ondemand, updated_at 
      FROM products 
      WHERE id = ${productId} AND status = 'published'
      LIMIT 1
    `);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });

    const product = result.rows[0] as any;
    const currentStock = typeof product.stock === 'string' ? parseInt(product.stock, 10) : (product.stock || 0);

    // Si no es dropshipping ni ondemand, retornamos el stock actual de inmediato
    if (!product.dropshipping && !product.ondemand) {
      return res.json({ stock: currentStock, inStock: currentStock > 0 });
    }

    const supplierCode = String(product.supplier_code || product.sku || '');
    if (!supplierCode) {
      return res.json({ stock: currentStock, inStock: currentStock > 0 });
    }

    // Throttle de 15 minutos: si se actualizó hace poco, no llamamos a la API de Bihr
    const quinceMinutos = 15 * 60 * 1000;
    const necesitaActualizacion = !product.updated_at || (Date.now() - new Date(product.updated_at).getTime() > quinceMinutos);

    if (!necesitaActualizacion) {
      return res.json({ stock: currentStock, inStock: currentStock > 0 });
    }

    // Llamamos a la API externa de Bihr para obtener el stock real numérico
    const stock = await getLiveStockValue(supplierCode);
    const safeStock = Number.isFinite(stock) && stock >= 0 ? Math.floor(stock) : 0;
    const inStock = safeStock > 0;

    // Actualizamos la base de datos
    await db.execute(sql`
      UPDATE products 
      SET stock = ${safeStock}, updated_at = NOW() 
      WHERE id = ${product.id}
    `);

    console.log(`[LIVE STOCK REFRESH] Updated stock for ${product.sku} to ${safeStock} (inStock: ${inStock})`);
    return res.json({ stock: safeStock, inStock });
  } catch (err: any) {
    console.error('[LIVE STOCK REFRESH ERROR]:', err);
    // En caso de error de la API (ej: 429), devolvemos el stock cacheado para no romper la UI
    try {
      const fallback = await db.execute(sql`SELECT stock FROM products WHERE id = ${parseInt(req.params.id, 10)}`);
      if (fallback.rows.length > 0) {
        const fRow = fallback.rows[0] as any;
        const fStock = typeof fRow?.stock === 'string' ? parseInt(fRow.stock, 10) : (Number(fRow?.stock) || 0);
        return res.json({ stock: fStock, inStock: fStock > 0 });
      }
    } catch {}
    res.status(500).json({ error: err.message });
  }
});

// GET /api/catalog/product-by-sku/:sku/variants
catalogRouter.get('/catalog/product-by-sku/:sku/variants', async (req, res) => {
  try {
    const sku = req.params.sku;
    const productRes = await db.execute(sql`SELECT * FROM products WHERE sku = ${sku}`);
    if (productRes.rows.length === 0) return res.json([]);
    
    const product = productRes.rows[0];
    let parentSku = '';
    
    if (product.attributes) {
      let attrs: any = {};
      try {
        attrs = typeof product.attributes === 'string' ? JSON.parse(product.attributes) : product.attributes;
      } catch (e) {}
      parentSku = attrs.parent_sku || '';
    }
    
    if (parentSku) {
      const variantsRes = await db.execute(sql`
        SELECT * FROM products 
        WHERE attributes->>'parent_sku' = ${parentSku} 
          AND status = 'published'
        ORDER BY price ASC
      `);
      return res.json(variantsRes.rows.map(mapProductToFrontend));
    }
    
    const baseName = (product as any).name?.split(',')[0].trim() || '';
    if (baseName.length > 8) {
      const variantsRes = await db.execute(sql`
        SELECT * FROM products 
        WHERE name LIKE ${baseName + '%'} 
          AND status = 'published'
        ORDER BY price ASC
        LIMIT 100
      `);
      return res.json(variantsRes.rows.map(mapProductToFrontend));
    }
    
    return res.json([mapProductToFrontend(product)]);
  } catch (err: any) {
    console.error('[VARIANTS ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/catalog/product-compatibility/:id
catalogRouter.get('/catalog/product-compatibility/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.json([]);
    
    const productRes = await db.execute(sql`SELECT compatibility FROM products WHERE id = ${id}`);
    if (productRes.rows.length === 0) return res.json([]);
    
    const row = productRes.rows[0];
    let compatibility: any[] = [];
    try {
      if (row.compatibility) {
        compatibility = typeof row.compatibility === 'string' ? JSON.parse(row.compatibility) : row.compatibility;
      }
    } catch (e) {}
    
    return res.json(compatibility);
  } catch (err: any) {
    console.error('[COMPATIBILITY ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/catalog/stock-check
catalogRouter.get('/catalog/stock-check', async (req, res) => {
  try {
    const { ids } = req.query as any;
    if (!ids) return res.status(400).json({ error: 'Falta ids' });
    const idsList = ids.split(',').map((id: string) => parseInt(id, 10)).filter((id: number) => !isNaN(id) && id > 0);
    if (idsList.length === 0) return res.json({ checks: [] });

    const result = await db.execute(sql`
      SELECT id, sku, name, stock
      FROM products
      WHERE id IN (${buildInClause(idsList)})
    `);

    const checks = (result.rows as any[]).map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      stock: typeof row.stock === 'string' ? parseInt(row.stock, 10) : (row.stock || 0),
      available: (typeof row.stock === 'string' ? parseInt(row.stock, 10) : (row.stock || 0)) > 0,
    }));

    return res.json({ checks });
  } catch (err: any) {
    console.error('[STOCK CHECK ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET & POST /api/catalog/products-by-skus
catalogRouter.all('/catalog/products-by-skus', async (req, res) => {
  try {
    const rawSkus = req.method === 'POST' ? (req.body?.skus || req.query?.skus) : req.query?.skus;
    const rawIds = req.method === 'POST' ? (req.body?.ids || req.query?.ids) : req.query?.ids;
    const category_id = req.method === 'POST' ? (req.body?.category_id || req.query?.category_id) : req.query?.category_id;

    const conditions = sql`WHERE status = 'published'`;

    if (rawIds) {
      const idsList = (Array.isArray(rawIds) ? rawIds : String(rawIds).split(','))
        .map((id: any) => parseInt(String(id), 10))
        .filter((id: number) => !isNaN(id));
      if (idsList.length === 0) return res.json([]);
      conditions.append(sql` AND id IN (${buildInClause(idsList)})`);
    } else if (rawSkus) {
      const skusList = (Array.isArray(rawSkus) ? rawSkus : String(rawSkus).split(','))
        .map((s: any) => sanitizeString(String(s).trim()))
        .filter(Boolean);
      if (skusList.length === 0) return res.json([]);
      conditions.append(sql` AND sku IN (${buildInClause(skusList)})`);
    } else {
      return res.json([]);
    }

    if (category_id) {
      const catId = parseInt(category_id, 10);
      if (!isNaN(catId)) {
        const parentId = Math.floor(catId / 100);
        conditions.append(sql`
          AND (
            category_id = ${catId}
            OR category_id IN (
              SELECT id FROM categories
              WHERE parent_id = ${catId}
                 OR parent_id IN (SELECT id FROM categories WHERE parent_id = ${catId})
            )
            OR category_id = ${parentId}
          )`);
      }
    }

    const productsRes = await db.execute(sql`
      SELECT * FROM products
      ${conditions}
      ORDER BY price ASC
    `);
    const products = productsRes.rows.map(mapProductToFrontend);
    return res.json(products);
  } catch (err: any) {
    console.error('[PRODUCTS BY SKUS ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});
