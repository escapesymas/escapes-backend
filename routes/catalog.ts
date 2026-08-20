import { Router } from 'express';
import { db, pool } from '../db.js';
import { sql } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { cacheSet, cacheGet } from '../lib/cache.js';
import { sanitizeLike, sanitizeString } from '../utils.js';
import { getLiveStockValue } from '../bihrService.js';

export const catalogRouter = Router();

const OPTIMIZED_DIR = path.join(process.cwd(), 'uploads', 'optimized');

const FILTER_ATTR_KEYS = new Set([
  'Marca del vehículo',
  'Modelo del vehículo',
  'Cilindrada',
  'Año',
  'Homologación',
  'Material',
  'Posición',
  'Color',
  'Tipo de escape',
  'Acabado'
]);

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
    description: row.description || '',
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
    attributes: row.attributes || {},
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

function cleanModelName(m: any): string {
  return String(m || '')
    .replace(/\(.*\)/g, '')
    .replace(/\b(abs|cbs|dx|sx|sp|se|rr|r|i|ie|fi|euro\s*\d)\b/gi, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
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

// Índice en memoria para la columna compatibility JSONB y rangos de título en PostgreSQL
let dbCompatibilityIndex: Map<string, Set<string>> | null = null;
let lastIndexBuildTime = 0;
let isBuildingIndex = false;

async function getDbCompatibilityIndex(): Promise<Map<string, Set<string>>> {
  const now = Date.now();
  if (dbCompatibilityIndex && (now - lastIndexBuildTime < 30 * 60 * 1000)) {
    return dbCompatibilityIndex;
  }
  if (isBuildingIndex && dbCompatibilityIndex) {
    return dbCompatibilityIndex;
  }

  isBuildingIndex = true;
  const newIndex = new Map<string, Set<string>>();

  try {
    const res = await db.execute(sql`
      SELECT sku, compatibility FROM products 
      WHERE status = 'published' AND compatibility IS NOT NULL AND compatibility != '[]'
    `);

    for (const row of res.rows as any[]) {
      if (!row.sku || !row.compatibility) continue;

      let list: any[] = [];
      if (typeof row.compatibility === 'string') {
        try { list = JSON.parse(row.compatibility); } catch {}
      } else if (Array.isArray(row.compatibility)) {
        list = row.compatibility;
      }

      for (const item of list) {
        if (!item.brand || !item.model) continue;
        const b = String(item.brand).trim().toLowerCase();
        const mClean = cleanModelName(item.model);
        const mRaw = String(item.model).replace(/\(.*\)/g, '').trim().toLowerCase();
        const y = item.year ? String(item.year).trim() : '';

        if (y) {
          const k1 = `${b}::${mClean}::${y}`;
          if (!newIndex.has(k1)) newIndex.set(k1, new Set());
          newIndex.get(k1)!.add(row.sku);

          if (mRaw !== mClean) {
            const k1raw = `${b}::${mRaw}::${y}`;
            if (!newIndex.has(k1raw)) newIndex.set(k1raw, new Set());
            newIndex.get(k1raw)!.add(row.sku);
          }
        }
        const k2 = `${b}::${mClean}`;
        if (!newIndex.has(k2)) newIndex.set(k2, new Set());
        newIndex.get(k2)!.add(row.sku);
      }
    }

    dbCompatibilityIndex = newIndex;
    lastIndexBuildTime = now;
  } catch (e) {
    console.error('[COMPATIBILITY INDEX BUILD ERROR]:', e);
  } finally {
    isBuildingIndex = false;
  }

  return dbCompatibilityIndex || newIndex;
}

// GET /api/vehicles
catalogRouter.get('/vehicles', async (req, res) => {
  const { action, brand, model, year } = req.query as any;
  try {
    const redisKey = `cache:vehicles:v5:${action || ''}:${brand || ''}:${model || ''}:${year || ''}`;
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

      // 1. SKUs desde el índice en memoria de productos en PostgreSQL (coincidencia exacta por marca, modelo y año)
      if (brand && model) {
        try {
          const indexMap = await getDbCompatibilityIndex();
          const bLower = (brand || '').trim().toLowerCase();
          const mLower = cleanModelName(model);
          const mClean = mLower.replace(/\d+/g, '').trim(); // ej: 'pcx'
          const yStr = year ? String(year).trim() : '';

          const keysToTry: string[] = [];
          if (yStr) {
            keysToTry.push(`${bLower}::${mLower}::${yStr}`);
            if (mClean && mClean !== mLower) keysToTry.push(`${bLower}::${mClean}::${yStr}`);
          } else {
            keysToTry.push(`${bLower}::${mLower}`);
            if (mClean && mClean !== mLower) keysToTry.push(`${bLower}::${mClean}`);
          }

          for (const key of keysToTry) {
            const matchedSkus = indexMap.get(key);
            if (matchedSkus) {
              matchedSkus.forEach((sku) => skusSet.add(sku));
            }
          }
        } catch (e) {
          console.error('Error fetching indexed DB compatibility:', e);
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

    } else if (action === 'compatible-products') {
      const prodRedisKey = `compat:prod:v5:${(brand||'').toLowerCase()}:${(model||'').toLowerCase()}:${year||''}`;
      const cachedProducts = await cacheGet<any[]>(prodRedisKey);
      if (cachedProducts) {
        return res.json(cachedProducts);
      }

      const skusSet = new Set<string>();

      // 1. SKUs desde el índice en memoria de productos en PostgreSQL
      if (brand && model) {
        try {
          const indexMap = await getDbCompatibilityIndex();
          const bLower = (brand || '').trim().toLowerCase();
          const mLower = cleanModelName(model);
          const mClean = mLower.replace(/\d+/g, '').trim();
          const yStr = year ? String(year).trim() : '';

          const keysToTry: string[] = [];
          if (yStr) {
            keysToTry.push(`${bLower}::${mLower}::${yStr}`);
            if (mClean && mClean !== mLower) keysToTry.push(`${bLower}::${mClean}::${yStr}`);
          } else {
            keysToTry.push(`${bLower}::${mLower}`);
            if (mClean && mClean !== mLower) keysToTry.push(`${bLower}::${mClean}`);
          }

          for (const key of keysToTry) {
            const matchedSkus = indexMap.get(key);
            if (matchedSkus) {
              matchedSkus.forEach((sku) => skusSet.add(sku));
            }
          }
        } catch (e) {
          console.error('Error fetching indexed DB compatibility:', e);
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
        `SELECT * FROM products WHERE status = 'published' AND price > 0 AND sku = ANY($1) ORDER BY price ASC`,
        [skusList]
      );
      const products = productsRes.rows.map(mapProductToFrontend);
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
    const q = sanitizeString(String(req.query.q || ''));
    if (!q || q.length < 2) return res.json({ suggestions: [], products: [] });

    const searchPattern = `%${sanitizeLike(q)}%`;
    const productsRes = await db.execute(sql`
      SELECT id, sku, name, brand, price, sale_price, stock, images
      FROM products
      WHERE status = 'published' AND (LOWER(name) LIKE LOWER(${searchPattern}) ESCAPE '\\' OR LOWER(sku) LIKE LOWER(${searchPattern}) ESCAPE '\\')
      ORDER BY stock DESC, id ASC
      LIMIT 8
    `);

    const products = productsRes.rows.map(mapProductToFrontend);
    res.json({ suggestions: [], products });
  } catch (err: any) {
    console.error('[SEARCH SUGGESTIONS ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/catalog/products
catalogRouter.get('/catalog/products', async (req, res) => {
  try {
    const { search, category_id, category_slug, page = '1', per_page = '20', universal, brand, min_price, max_price, in_stock, attrs } = req.query as any;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(Math.max(1, parseInt(per_page, 10) || 20), 50);
    const offset = (pageNum - 1) * perPage;

    const queryStr = JSON.stringify(req.query);
    const redisKey = queryStr.length > 200
      ? `cache:products:${crypto.createHash('sha256').update(queryStr).digest('hex')}`
      : `cache:products:${queryStr}`;

    const cached = await cacheGet<{ products: any[]; total: number; totalPages: number }>(redisKey);
    if (cached) {
      res.setHeader('Access-Control-Expose-Headers', 'X-WP-Total, X-WP-TotalPages');
      res.setHeader('X-WP-Total', cached.total.toString());
      res.setHeader('X-WP-TotalPages', cached.totalPages.toString());
      return res.json(cached.products);
    }

    const conditions = sql`WHERE status IN ('published', 'active') AND name NOT LIKE 'Aplicaciones:%' AND name NOT LIKE 'Applications:%' AND sku NOT LIKE 'Aplicaciones:%' AND sku NOT LIKE 'Applications:%'`;

    if (search) {
      const searchPattern = `%${sanitizeLike(search)}%`;
      conditions.append(sql`
        AND (
          LOWER(name) LIKE LOWER(${searchPattern}) ESCAPE '\\'
          OR LOWER(sku) LIKE LOWER(${searchPattern}) ESCAPE '\\'
          OR LOWER(supplier_code) LIKE LOWER(${searchPattern}) ESCAPE '\\'
        )`);
    }

    if (brand) {
      const brandList = String(brand).split(',').map((b) => b.trim()).filter(Boolean);
      if (brandList.length === 1) {
        conditions.append(sql` AND LOWER(brand) = LOWER(${brandList[0]})`);
      } else if (brandList.length > 1) {
        const orChain = brandList
          .map((b) => sql`LOWER(brand) = LOWER(${b})`)
          .reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc} OR ${frag}`));
        conditions.append(sql` AND (${orChain})`);
      }
    }

    if (min_price) {
      const mp = parseInt(min_price, 10);
      if (!isNaN(mp)) conditions.append(sql` AND price >= ${mp * 100}`);
    }
    if (max_price) {
      const mp = parseInt(max_price, 10);
      if (!isNaN(mp)) conditions.append(sql` AND price <= ${mp * 100}`);
    }
    if (in_stock === 'true' || in_stock === '1') {
      conditions.append(sql` AND stock > 0`);
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
    } else if (category_slug) {
      const slugLower = String(category_slug).toLowerCase();
      conditions.append(sql`
        AND category_id IN (
          SELECT id FROM categories
          WHERE LOWER(slug) LIKE ${'%' + slugLower + '%'}
             OR LOWER(name) LIKE ${'%' + slugLower + '%'}
             OR parent_id IN (
               SELECT id FROM categories
               WHERE LOWER(slug) LIKE ${'%' + slugLower + '%'}
                  OR LOWER(name) LIKE ${'%' + slugLower + '%'}
             )
        )`);
    }

    const countRes = await db.execute(sql`SELECT count(*) as total FROM products ${conditions}`);
    const total = Number(countRes.rows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / perPage));

    const productsRes = await db.execute(sql`
      SELECT p.*
      FROM products p
      ${conditions}
      ORDER BY p.stock DESC, p.id DESC
      LIMIT ${perPage} OFFSET ${offset}
    `);

    const products = productsRes.rows.map(mapProductToFrontend);
    const resultData = { products, total, totalPages };

    await cacheSet(redisKey, resultData, 60);

    res.setHeader('Access-Control-Expose-Headers', 'X-WP-Total, X-WP-TotalPages');
    res.setHeader('X-WP-Total', total.toString());
    res.setHeader('X-WP-TotalPages', totalPages.toString());
    return res.json(products);
  } catch (err: any) {
    console.error('[CATALOG PRODUCTS ROUTE ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/catalog/filters
catalogRouter.get('/catalog/filters', async (req, res) => {
  try {
    const { universal, search, category_id } = req.query as any;
    const cacheKey = `filters:${universal}:${search}:${category_id}`;
    const redisKey = `cache:filters:${cacheKey}`;
    const cached = await cacheGet<any>(redisKey);
    if (cached) return res.json(cached);

    const conditions = sql`WHERE status = 'published'`;

    if (search) {
      const searchPattern = `%${sanitizeLike(search)}%`;
      conditions.append(sql` AND (LOWER(name) LIKE LOWER(${searchPattern}) ESCAPE '\\' OR LOWER(sku) LIKE LOWER(${searchPattern}) ESCAPE '\\')`);
    }

    if (category_id) {
      const catId = parseInt(category_id, 10);
      if (!isNaN(catId)) {
        conditions.append(sql` AND category_id IN (
          SELECT id FROM categories
          WHERE id = ${catId}
             OR parent_id = ${catId}
             OR parent_id IN (SELECT id FROM categories WHERE parent_id = ${catId})
        )`);
      }
    }

    const attrKeysArr = Array.from(FILTER_ATTR_KEYS);

    const [brandsRes, priceRes, attrsRes] = await Promise.all([
      db.execute(sql`SELECT DISTINCT brand FROM products ${conditions} AND brand IS NOT NULL AND brand != '' ORDER BY brand`),
      db.execute(sql`SELECT MIN(price) as min_p, MAX(price) as max_p FROM products ${conditions}`),
      db.execute(sql`
        SELECT att.key, JSON_AGG(DISTINCT att.value) AS values
        FROM products p, jsonb_each_text(p.attributes) AS att(key, value)
        ${conditions}
          AND att.value IS NOT NULL AND att.value != ''
          AND att.key IN (${buildInClause(attrKeysArr)})
        GROUP BY att.key
        ORDER BY att.key
      `)
    ]);

    const brands = brandsRes.rows.map((r: any) => r.brand).filter(Boolean);
    const priceMinRow: any = priceRes.rows[0] || {};
    const priceMin = priceMinRow.min_p ? Math.round(Number(priceMinRow.min_p) / 100) : 0;
    const priceMax = priceMinRow.max_p ? Math.round(Number(priceMinRow.max_p) / 100) : 1000;

    const attributes: Record<string, string[]> = {};
    for (const row of attrsRes.rows) {
      const r: any = row;
      attributes[r.key] = r.values;
    }

    const result = { brands, price_min: priceMin, price_max: priceMax, attributes };
    await cacheSet(redisKey, result, 600);
    res.json(result);

  } catch (err: any) {
    console.error('[FILTERS ERROR]:', err);
    res.status(500).json({ error: err.message });
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
             COALESCE(rs.review_count, 0) AS review_count
      FROM products p
      LEFT JOIN product_rating_stats rs ON rs.product_id = p.id
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
             COALESCE(rs.review_count, 0) AS review_count
      FROM products p
      LEFT JOIN product_rating_stats rs ON rs.product_id = p.id
      WHERE (p.sku = ${slugStr} OR p.sku = ${skuStr} ${validId !== null ? sql`OR p.id = ${validId}` : sql``}) AND p.status = 'published'
      LIMIT 1
    `);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json(mapProductToFrontend(result.rows[0]));
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
