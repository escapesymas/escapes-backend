import { pool } from '../db.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../escapes-admin/node_modules/playwright');

const CACHE_FILE = path.join(process.cwd(), 'bihr_compatibility_cache.json');
const CONCURRENCY = 6;

interface VehicleResult {
  brand: string;
  model: string;
  year: number;
  displacement?: string;
  version?: string;
  vehicleCode?: string;
}

async function runSync() {
  console.log('🚀 Iniciando sincronización robusta con auto-renovación de sesión...');

  let compatCache: Record<string, VehicleResult[]> = {};
  if (fs.existsSync(CACHE_FILE)) {
    try {
      compatCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      console.log(`📦 Caché cargado: ${Object.keys(compatCache).length} SKUs ya guardados.`);
    } catch (err) {}
  }

  const skuSet = new Set<string>();
  try {
    const dbRes = await pool.query("SELECT sku, compatibility FROM products WHERE sku IS NOT NULL AND sku != ''");
    dbRes.rows.forEach(r => {
      skuSet.add(r.sku);
      if (r.compatibility && r.compatibility !== '[]' && compatCache[r.sku] === undefined) {
        try {
          const list = typeof r.compatibility === 'string' ? JSON.parse(r.compatibility) : r.compatibility;
          if (Array.isArray(list) && list.length > 0) {
            compatCache[r.sku] = list;
          }
        } catch (e) {}
      }
    });
  } catch (err) {}

  const catalogPath = path.join(process.cwd(), 'scripts', 'bihr-catalog.json');
  if (fs.existsSync(catalogPath)) {
    try {
      const cat = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
      const catSkus = (cat.Products || []).map((p: any) => p.NewPartNumber || p.ProductCode).filter(Boolean);
      catSkus.forEach((s: string) => skuSet.add(s));
    } catch (err) {}
  }

  const allSkus = Array.from(skuSet);
  const pendingSkus = allSkus.filter(sku => compatCache[sku] === undefined);

  console.log(`📊 Total SKUs: ${allSkus.length} | Pendientes por consultar: ${pendingSkus.length}`);

  if (pendingSkus.length === 0) {
    console.log('✅ ¡Todos los SKUs ya han sido procesados!');
    process.exit(0);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  let page = await context.newPage();

  const refreshSession = async () => {
    console.log('🔄 Renovando token de sesión Cloudflare en mybihr.com...');
    try {
      await page.goto('https://www.mybihr.com/es/es/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    } catch (e) {}
  };

  await refreshSession();

  const startTime = Date.now();
  let processedCount = 0;
  let withVehiclesCount = 0;
  let consecutive403Count = 0;

  const fetchVehiclesForSku = async (sku: string): Promise<{ sku: string; vehicles: VehicleResult[]; ok: boolean }> => {
    try {
      const pageSize = 100;
      let currentPage = 0;
      let totalPages = 1;
      const vehicles: VehicleResult[] = [];

      while (currentPage < totalPages) {
        const url = `https://api.mybihr.com/occ/v2/bihrES/products/compatibleVehicles?productCode=${sku}&page=${currentPage}&sortDirection=asc&pageSize=${pageSize}&searchValue=&sortColumn=0&lang=es&curr=EUR`;
        const response = await context.request.get(url);

        if (response.status() === 403) {
          return { sku, vehicles: [], ok: false };
        }
        if (!response.ok()) break;

        const data = await response.json();
        const results = data.results || [];
        totalPages = data.pagination?.totalPages || 1;

        for (const item of results) {
          vehicles.push({
            brand: item.brand,
            model: item.model,
            year: parseInt(item.years) || item.years,
            displacement: item.displacement,
            version: item.version,
            vehicleCode: item.vehicleCode,
          });
        }
        currentPage++;
      }
      return { sku, vehicles, ok: true };
    } catch {
      return { sku, vehicles: [], ok: false };
    }
  };

  for (let i = 0; i < pendingSkus.length; i += CONCURRENCY) {
    const batch = pendingSkus.slice(i, i + CONCURRENCY);

    let batchResults = await Promise.all(batch.map(fetchVehiclesForSku));
    const failedSession = batchResults.some(r => !r.ok);

    if (failedSession) {
      consecutive403Count++;
      if (consecutive403Count >= 2) {
        await refreshSession();
        consecutive403Count = 0;
        // Reintentar lote actual
        batchResults = await Promise.all(batch.map(fetchVehiclesForSku));
      }
    } else {
      consecutive403Count = 0;
    }

    for (const res of batchResults) {
      compatCache[res.sku] = res.vehicles;
      processedCount++;
      if (res.vehicles.length > 0) {
        withVehiclesCount++;
        try {
          await pool.query(
            `UPDATE products SET compatibility = $1::jsonb WHERE sku = $2`,
            [JSON.stringify(res.vehicles), res.sku]
          );
        } catch {}
      }
    }

    const elapsedSec = (Date.now() - startTime) / 1000;
    const rate = processedCount / (elapsedSec || 0.1);
    const remainingSec = Math.round((pendingSkus.length - processedCount) / rate);
    const remMin = Math.round(remainingSec / 60);

    if (processedCount % 30 === 0 || i + CONCURRENCY >= pendingSkus.length) {
      console.log(`📊 [${processedCount}/${pendingSkus.length}] (${Math.round((processedCount / pendingSkus.length) * 100)}%) | Vel: ${rate.toFixed(1)} SKU/s | Est: ~${remMin} min | Con motos: ${withVehiclesCount}`);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(compatCache, null, 2), 'utf-8');
    }

    // Cada 1.000 SKUs refrescar sesión preventivamente
    if (processedCount % 1000 === 0) {
      await refreshSession();
    }
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(compatCache, null, 2), 'utf-8');
  await browser.close();

  console.log('🎉 Sincronización completada con éxito.');
  process.exit(0);
}

runSync().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
