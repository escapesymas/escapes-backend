/**
 * Catálogo de motos (marca → modelo → año → códigos de vehículo de Bihr) y
 * recambios compatibles con una moto.
 *
 * Lo usan el selector de la web (/api/vehicles en routes/catalog.ts) y los
 * avisos de piezas nuevas para la moto (lib/moto-alerts.ts): así el correo
 * enseña exactamente lo mismo que la web.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findCompatibleSkus } from './compat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let catalogDataCache: any = null;

/** moto_catalog.json (Bihr) con las motos añadidas a mano fusionadas. */
export function getCatalogData() {
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
        mergeExtraMotos(catalogDataCache, path.join(path.dirname(p), 'moto_catalog_extra.json'));
        return catalogDataCache;
      }
    } catch {
      // continue
    }
  }

  catalogDataCache = { hierarchy: {}, compatibility: {} };
  return catalogDataCache;
}

/**
 * Motos añadidas a mano (moto_catalog_extra.json) que Bihr aún no tiene, p. ej.
 * Cyclone: así el cliente puede elegirlas en el selector y guardarlas en su garaje.
 * Solo añade marcas, modelos y años que falten; nunca pisa los datos de Bihr.
 */
function mergeExtraMotos(catalog: any, file: string) {
  try {
    if (!fs.existsSync(file)) return;
    const extra = JSON.parse(fs.readFileSync(file, 'utf-8'))?.hierarchy || {};
    catalog.hierarchy ||= {};
    for (const [brand, models] of Object.entries<any>(extra)) {
      const b = (catalog.hierarchy[brand] ||= {});
      for (const [model, years] of Object.entries<any>(models)) {
        const m = (b[model] ||= {});
        for (const [year, codes] of Object.entries<any>(years)) m[year] ||= codes;
      }
    }
  } catch (e: any) {
    console.warn('[CATALOG] moto_catalog_extra.json no válido:', e.message);
  }
}

/**
 * Moto del selector a partir de su texto («HONDA PCX 125 (2022)», como se
 * guarda en el garaje), con la marca y el modelo tal como están en el catálogo.
 * null si la marca o el modelo no existen.
 */
export function parseBikeLabel(label: string): { brand: string; model: string; year: string } | null {
  const hierarchy = getCatalogData()?.hierarchy || {};
  let text = String(label || '').trim().replace(/\s+/g, ' ');
  let year = '';
  const ym = text.match(/\((\d{4})\)\s*$/) || text.match(/\s(\d{4})$/);
  if (ym) {
    year = ym[1];
    text = text.slice(0, ym.index).trim();
  }
  const upper = text.toUpperCase();
  // La marca más larga que encaje («HARLEY DAVIDSON» antes que «HARLEY»).
  const brand = Object.keys(hierarchy)
    .filter((b) => upper === b.toUpperCase() || upper.startsWith(b.toUpperCase() + ' '))
    .sort((a, b) => b.length - a.length)[0];
  if (!brand) return null;
  const rest = text.slice(brand.length).trim().toLowerCase();
  const model = Object.keys(hierarchy[brand] || {}).find((m) => m.toLowerCase() === rest);
  if (!model) return null;
  return { brand, model, year: year && hierarchy[brand][model]?.[year] ? year : '' };
}

/** Texto de la moto como lo guarda el selector de la web. */
export function bikeLabel(brand: string, model: string, year?: string): string {
  return `${brand} ${model}${year ? ` (${year})` : ''}`;
}

/**
 * SKUs compatibles con la moto (marca obligatoria; modelo y año opcionales),
 * juntando las tres fuentes de compatibilidad.
 */
export async function compatibleSkus(brand: string, model?: string, year?: string): Promise<string[]> {
  const catalog = getCatalogData();
  const hierarchy = catalog?.hierarchy || {};
  const skusSet = new Set<string>();

  // 1. SKUs compatibles según products.compatibility (consulta indexada, ver lib/compat.ts)
  if (brand && model) {
    try {
      (await findCompatibleSkus(brand, model, year, 3000)).forEach((sku) => skusSet.add(sku));
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
      const normModel = model.trim().replace(/\s+/g, ' ').toLowerCase();
      const matchedModelKeys = Object.keys(hierarchy[matchedBrandKey] || {}).filter(
        (k) => k.trim().replace(/\s+/g, ' ').toLowerCase() === normModel
      );
      const keysToUse = matchedModelKeys.length > 0 ? matchedModelKeys : [model];
      for (const mk of keysToUse) {
        if (year && year !== 'General' && year !== '') {
          const yrCodes = hierarchy[matchedBrandKey][mk]?.[year] || [];
          if (Array.isArray(yrCodes)) codes.push(...yrCodes);
        } else if (hierarchy[matchedBrandKey][mk]) {
          Object.values(hierarchy[matchedBrandKey][mk]).forEach((cList: any) => {
            if (Array.isArray(cList)) codes.push(...cList);
          });
        }
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
  const cacheData = getBihrCompatCache();
  if (cacheData) {
    const bLower = (brand || '').toLowerCase();
    const mLower = (model || '').toLowerCase();
    const yStr = year ? String(year) : '';

    for (const [sku, list] of Object.entries(cacheData)) {
      if (!Array.isArray(list)) continue;
      for (const item of list as any[]) {
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
  }

  return Array.from(skusSet);
}

let bihrCompatCache: Record<string, any[]> | null | undefined = undefined;
function getBihrCompatCache(): Record<string, any[]> | null {
  if (bihrCompatCache !== undefined) return bihrCompatCache;
  const candidates = [
    path.join(__dirname, '..', 'bihr_compatibility_cache.json'),
    path.join(process.cwd(), 'bihr_compatibility_cache.json'),
    path.join(process.cwd(), 'escapes-backend', 'bihr_compatibility_cache.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        bihrCompatCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return bihrCompatCache!;
      }
    } catch {
      // continue
    }
  }
  bihrCompatCache = null;
  return null;
}
