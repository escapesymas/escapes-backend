import { execSync, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { chromium } = require('../../escapes-admin/node_modules/playwright');

const CACHE_FILE = path.join(process.cwd(), 'bihr_prod_sync_cache.json');
const VPS_SSH = 'root@212.227.134.161';
const DB_CONTAINER = 'hk6mt4abfh8ijg2vak6utvz2';

function runPsqlQuery(sqlQuery: string): string {
  const cmd = `ssh -o StrictHostKeyChecking=no ${VPS_SSH} "docker exec -i ${DB_CONTAINER} psql -U escapes -d escapes_db -t -A"`;
  return execSync(cmd, { input: sqlQuery, encoding: 'utf-8' }).trim();
}

async function runSync() {
  console.log('🚀 Iniciando Sincronizador de Compatibilidades Bihr para Producción...');

  let cache: Record<string, any[]> = {};
  if (fs.existsSync(CACHE_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      console.log(`📦 Caché local cargado: ${Object.keys(cache).length} SKUs procesados previamente.`);
    } catch (e) {}
  }

  console.log('🔍 Obteniendo SKUs pendientes en PostgreSQL producción...');
  const pendingSkusRaw = runPsqlQuery("SELECT sku FROM products WHERE (compatibility IS NULL OR compatibility = '[]'::jsonb) AND sku IS NOT NULL AND sku != ''");
  const pendingSkus = pendingSkusRaw.split('\n').map(s => s.trim()).filter(Boolean).filter(sku => cache[sku] === undefined);

  console.log(`📊 Total SKUs pendientes de compatibilidad: ${pendingSkus.length}`);

  if (pendingSkus.length === 0) {
    console.log('✅ ¡Todos los SKUs ya tienen compatibilidades cargadas!');
    process.exit(0);
  }

  console.log('🌐 Iniciando navegador Chromium Playwright...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  console.log('🔐 Conectando con mybihr.com para pasar protección Cloudflare...');
  await page.goto('https://www.mybihr.com/es/es/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  let processedCount = 0;
  const BATCH_SIZE = 20;

  for (let i = 0; i < pendingSkus.length; i += BATCH_SIZE) {
    const batch = pendingSkus.slice(i, i + BATCH_SIZE);

    try {
      const resultsMap = await page.evaluate(async (skusToFetch) => {
        const fetchResults: Record<string, any> = {};
        await Promise.all(skusToFetch.map(async (skuToFetch) => {
          try {
            const url = `https://api.mybihr.com/occ/v2/bihrES/products/compatibleVehicles?productCode=${encodeURIComponent(skuToFetch)}&page=0&sortDirection=asc&pageSize=200000&searchValue=&sortColumn=0&lang=es&curr=EUR`;
            const r = await fetch(url, { headers: { 'accept': 'application/json, text/plain, */*' } });
            fetchResults[skuToFetch] = r.ok ? await r.json() : null;
          } catch(e) {
            fetchResults[skuToFetch] = null;
          }
        }));
        return fetchResults;
      }, batch);

      for (const sku of batch) {
        const json = resultsMap[sku];
        if (json && json.results) {
          const vehicles = (json.results || []).map((v: any) => ({
            brand: v.brand,
            model: v.model,
            year: v.years,
            displacement: v.displacement || v.cc,
            version: v.version,
            code: v.vehicleCode
          }));

          cache[sku] = vehicles;

          if (vehicles.length > 0) {
            const jsonStr = JSON.stringify(vehicles).replace(/'/g, "''");
            const updateSql = `UPDATE products SET compatibility = '${jsonStr}'::jsonb WHERE sku = '${sku}';`;
            runPsqlQuery(updateSql);
            console.log(`  [+] SKU ${sku}: ${vehicles.length} vehículos asignados en PostgreSQL.`);
          }
        } else {
          cache[sku] = [];
        }
      }
    } catch (err: any) {
      console.error(`  [-] Error procesando lote: ${err.message}`);
    }

    processedCount += batch.length;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

    if (processedCount % 50 === 0 || i + BATCH_SIZE >= pendingSkus.length) {
      console.log(`📈 Progreso: ${processedCount} / ${pendingSkus.length} SKUs analizados.`);
    }

    await page.waitForTimeout(200);
  }

  await browser.close();
  console.log('🎉 ¡Sincronización masiva de compatibilidades completada!');
  process.exit(0);
}

runSync().catch(err => {
  console.error('💥 Error crítico:', err);
  process.exit(1);
});
