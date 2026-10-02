import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import { repriceProducts, pricingAuto } from './lib/pricing.js';
import { refreshCompatModels } from './lib/compat.js';
import { enrichCatalog } from './lib/catalog-enrich.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function updateCatalogSyncState(state: any) {
  try {
    fs.writeFileSync('/tmp/catalog_sync_state.json', JSON.stringify({
      ...state,
      updatedAt: new Date().toISOString()
    }));
  } catch (e) {
    console.error('[BIHR SERVICE]: Error writing catalog sync state file:', e);
  }
}

// ================================================================
// CONFIGURACIÓN DE BIHR
// ================================================================
const BIHR_API_BASE = process.env.BIHR_API_BASE || 'https://api.bihr.net';
const BIHR_USERNAME = process.env.BIHR_USERNAME || 'info@escapesymas.com';
const BIHR_MACKEY = process.env.BIHR_MACKEY;

// Estado de caché del token
let cachedToken: string | null = null;
let tokenExpiryTime: number = 0; // Timestamp en ms

interface BihrTokenResponse {
  access_token: string;
  expires_in: number; // en segundos
  token_type: string;
}

/**
 * Obtiene y gestiona el Token de Autenticación de Bihr con caché de 30 mins
 */
export async function getBihrToken(): Promise<string> {
  const currentTime = Date.now();
  
  // Si el token sigue siendo válido (con un margen de seguridad de 2 minutos)
  if (cachedToken && currentTime < tokenExpiryTime - 120000) {
    return cachedToken;
  }

  console.log('[BIHR SERVICE]: Solicitando nuevo token de acceso a Bihr...');

  try {
    const formData = new URLSearchParams();
    formData.append('UserName', BIHR_USERNAME);
    formData.append('PassWord', BIHR_MACKEY);

    const response = await fetch(`${BIHR_API_BASE}/api/v2.1/Authentication/Token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error de autenticación Bihr (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as BihrTokenResponse;
    cachedToken = data.access_token;
    // Expira en 30 minutos (expires_in suele ser 1800 segundos)
    tokenExpiryTime = currentTime + (data.expires_in * 1000);
    
    console.log('[BIHR SERVICE]: Token obtenido correctamente.');
    return cachedToken;
  } catch (error) {
    console.error('[BIHR SERVICE ERROR]: Error al autenticar con Bihr:', error);
    throw error;
  }
}

// ================================================================
// MÓDULO DE INVENTARIO Y STOCK EN VIVO
// ================================================================

export interface ProductStockInfo {
  productCode: string;
  inStock: boolean;
  stockValue?: number;
  status: 'InStock' | 'Short' | 'OutOfStock';
}

/**
 * Consulta el nivel de stock en vivo para un producto (InStock, Short, OutOfStock)
 */
export async function getLiveStockLevel(productCode: string): Promise<'InStock' | 'Short' | 'OutOfStock'> {
  try {
    const token = await getBihrToken();
    if (token === 'mock_bihr_bearer_token') {
      return 'InStock'; // Mock en desarrollo
    }

    const response = await fetch(`${BIHR_API_BASE}/api/v2.1/Inventory/StockLevel?productCode=${encodeURIComponent(productCode)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const status = await response.json();
    return status as 'InStock' | 'Short' | 'OutOfStock';
  } catch (error) {
    console.error(`[BIHR SERVICE]: Error al consultar StockLevel para ${productCode}:`, error);
    return 'OutOfStock'; // Fallback seguro
  }
}

/**
 * Consulta el stock exacto (unidades numéricas) en vivo para un producto
 */
export async function getLiveStockValue(productCode: string): Promise<number> {
  try {
    const token = await getBihrToken();

    const response = await fetch(`${BIHR_API_BASE}/api/v2.1/Inventory/StockValue?productCode=${encodeURIComponent(productCode)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const value = await response.json();
    return Number(value);
  } catch (error) {
    console.error(`[BIHR SERVICE]: Error al consultar StockValue para ${productCode}:`, error);
    return 0; // Fallback seguro
  }
}

/**
 * Comprueba disponibilidad en vivo de múltiples referencias (ideal para checkout/carrito)
 */
export async function checkProductsInfo(items: Array<{ ProductCode?: string; ProductId?: string; Quantity: number }>) {
  try {
    const token = await getBihrToken();

    const payload = items.map(item => ({
      ProductId: item.ProductId || item.ProductCode || '',
      Quantity: item.Quantity
    }));

    const response = await fetch(`${BIHR_API_BASE}/api/v2.1/Inventory/ProductsInfo`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('[BIHR SERVICE]: Error en checkProductsInfo:', error);
    return items.map(item => ({ productCode: item.ProductCode || item.ProductId, available: false }));
  }
}

// ================================================================
// MÓDULO DE DROPSHIPPING / CREACIÓN DE PEDIDOS
// ================================================================

export interface BihrOrderRequest {
  deliveryAddress: {
    firstName: string;
    lastName: string;
    companyName?: string;
    street: string;
    zipCode: string;
    city: string;
    countryCode: string; // Ejemplo: 'ES'
    phoneNumber: string;
    email: string;
  };
  items: Array<{
    productCode: string;
    quantity: number;
  }>;
  customerOrderReference: string; // Tu identificador de pedido en PostgreSQL
  isDropshipping: boolean;
}

/**
 * Crea un pedido de dropshipping directamente en Bihr
 */
export async function createBihrOrder(orderData: BihrOrderRequest) {
  try {
    const token = await getBihrToken();

    const response = await fetch(`${BIHR_API_BASE}/api/v2.1/Order/Creation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        DeliveryAddress: {
          FirstName: orderData.deliveryAddress.firstName,
          LastName: orderData.deliveryAddress.lastName,
          CompanyName: orderData.deliveryAddress.companyName || '',
          Street: orderData.deliveryAddress.street,
          ZipCode: orderData.deliveryAddress.zipCode,
          City: orderData.deliveryAddress.city,
          CountryCode: orderData.deliveryAddress.countryCode,
          PhoneNumber: orderData.deliveryAddress.phoneNumber,
          Email: orderData.deliveryAddress.email
        },
        Items: orderData.items.map(item => ({
          ProductCode: item.productCode,
          Quantity: item.quantity
        })),
        CustomerOrderReference: orderData.customerOrderReference,
        ShippingType: orderData.isDropshipping ? 'Dropshipping' : 'Standard'
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Error en Bihr Order (${response.status}): ${errBody}`);
    }

    return await response.json(); // Retorna el ticketId
  } catch (error) {
    console.error('[BIHR SERVICE]: Error al emitir pedido en Bihr:', error);
    throw error;
  }
}

/**
 * Consulta el estado y tracking de un pedido en Bihr usando su ticketId o referencia
 */
export async function getBihrOrderStatus(ticketId: string) {
  try {
    const token = await getBihrToken();

    const response = await fetch(`${BIHR_API_BASE}/api/v2.1/Order/Status?ticketId=${encodeURIComponent(ticketId)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Error en Bihr Order Status (${response.status}): ${errBody}`);
    }

    return await response.json();
  } catch (error) {
    console.error('[BIHR SERVICE]: Error al consultar pedido en Bihr:', error);
    throw error;
  }
}

// ================================================================
// MÓDULO DE DE DESCARGA Y SINCRONIZACIÓN DEL CATÁLOGO
// ================================================================

/**
 * Lógica para solicitar la generación asíncrona, descargar e importar el catálogo
 */
/** Último catálogo JSON de Bihr descargado (lo usa el enriquecimiento manual). */
export const LATEST_CATALOG_JSON = process.env.BIHR_LATEST_CATALOG_JSON || '/app/server/uploads/bihr-catalog-latest.json';

export async function syncBihrCatalog(catalogType: 'HardPart' | 'RiderGear' | 'Prices' = 'HardPart'): Promise<boolean> {
  const token = await getBihrToken();
  const startTime = new Date().toISOString();

  updateCatalogSyncState({
    status: 'generating',
    catalogType,
    startTime
  });

  try {
    console.log(`[BIHR SERVICE]: Solicitando generación de catálogo ${catalogType}...`);
    const response = await fetch(`${BIHR_API_BASE}/api/v2.1/Catalog/ZIP/JSON/${catalogType}/Full`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    const rawBody = await response.text();
    console.log(`[BIHR SERVICE]: HTTP ${response.status}: ${rawBody.substring(0, 300)}`);

    if (response.status === 200) {
      console.log('[BIHR SERVICE]: Catálogo ya estaba generado. Descargando...');
      let downloadData;
      try { downloadData = JSON.parse(rawBody); } catch { downloadData = {}; }
      const downloadId = downloadData.downloadId || downloadData.DownloadId;
      if (downloadId) {
        await downloadAndProcessCatalog(downloadId, catalogType, startTime);
        return true;
      }
    } else {
      let requestData;
      try { requestData = JSON.parse(rawBody); } catch { requestData = {}; }
      const ticketId = requestData.ticketId || requestData.TicketId || requestData.TicketID;
      const resultCode = requestData.ResultCode || requestData.resultCode;

      if (resultCode === 'OK' && ticketId) {
        console.log(`[BIHR SERVICE]: Petición aceptada. TicketID: ${ticketId}. Esperando generación...`);

        updateCatalogSyncState({
          status: 'waiting_generation',
          catalogType,
          startTime,
          ticketId
        });

        let attempts = 0;
        const maxAttempts = 20;

        while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 30000));
          attempts++;

          console.log(`[BIHR SERVICE]: Comprobando estado ticket ${ticketId} (intento ${attempts})...`);
          const statusRes = await fetch(`${BIHR_API_BASE}/api/v2.1/Catalog/GenerationStatus?ticketId=${ticketId}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/json'
            }
          });

          if (!statusRes.ok) continue;

          const statusData = await statusRes.json();
          const requestStatus = statusData.requestStatus || statusData.RequestStatus || statusData.status;
          const downloadId = statusData.downloadId || statusData.DownloadId;
          console.log(`[BIHR SERVICE]: Estado generación: ${requestStatus}`);

          if (requestStatus === 'DONE' && downloadId) {
            console.log(`[BIHR SERVICE]: Catálogo listo. Descargando con downloadId: ${downloadId}`);
            await downloadAndProcessCatalog(downloadId, catalogType, startTime);
            return true;
          } else if (requestStatus === 'ERROR') {
            throw new Error('La generación de catálogo en los servidores de Bihr falló.');
          }
        }

        throw new Error('Tiempo de espera agotado para la generación del catálogo.');
      } else {
        throw new Error(`Respuesta inesperada de Bihr: HTTP ${response.status}, body: ${rawBody.substring(0, 200)}`);
      }
    }

    return false;
  } catch (error: any) {
    console.error(`[BIHR SERVICE ERROR]: Falló la sincronización de catálogo ${catalogType}:`, error);
    updateCatalogSyncState({
      status: 'failed',
      catalogType,
      startTime,
      endTime: new Date().toISOString(),
      error: error.message || String(error)
    });
    return false;
  }
}

/**
 * Descarga el archivo ZIP generado, lo extrae e importa a PostgreSQL
 */
async function downloadAndProcessCatalog(downloadId: string, catalogType: string, startTime: string) {
  const token = await getBihrToken();
  const zipPath = path.join(process.cwd(), 'uploads', `catalog-${downloadId}.zip`);
  const extractDir = path.join(process.cwd(), 'uploads', `catalog-${downloadId}`);

  console.log(`[BIHR SERVICE]: Descargando catálogo ZIP a: ${zipPath}`);
  
  updateCatalogSyncState({
    status: 'downloading',
    catalogType,
    startTime
  });
  
  // Realizar descarga
  const res = await fetch(`${BIHR_API_BASE}/api/v2.1/Catalog/GeneratedFile?downloadId=${downloadId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!res.ok) {
    throw new Error(`No se pudo descargar el archivo de catálogo. HTTP ${res.status}`);
  }

  const fileStream = fs.createWriteStream(zipPath);
  const reader = res.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
    }
  }
  fileStream.end();
  
  console.log('[BIHR SERVICE]: Descarga completada. Extrayendo ZIP...');
  
  updateCatalogSyncState({
    status: 'extracting',
    catalogType,
    startTime
  });

  // Asegurar que existe directorio destino
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
  }

  // Extraer el archivo ZIP usando el comando unzip nativo de Linux
  return new Promise<void>((resolve, reject) => {
    exec(`unzip -o "${zipPath}" -d "${extractDir}"`, (error, stdout, stderr) => {
      if (error) {
        console.error('[BIHR SERVICE ERROR]: Fallo al extraer con unzip de Linux:', error);
        reject(error);
        return;
      }
      
      console.log('[BIHR SERVICE]: Extracción exitosa. Procesando catálogo JSON...');
      
      // Buscar archivos JSON extraídos
      const files = fs.readdirSync(extractDir);
      const jsonFile = files.find(file => file.endsWith('.json'));
      
      if (!jsonFile) {
        reject(new Error('No se encontró ningún archivo JSON dentro del catálogo ZIP descargado.'));
        return;
      }

      const jsonFilePath = path.join(extractDir, jsonFile);
      console.log(`[BIHR SERVICE]: Procesando catálogo desde: ${jsonFilePath}`);
      
      // Limpieza programada de temporales en background
      resolve(processCatalogJson(jsonFilePath, catalogType, startTime).then(() => {
        // Copia del último catálogo para poder relanzar el enriquecimiento
        // desde el admin (POST /api/admin/catalog/enrich).
        // (el de precios no: no tiene referencias y lo dejaría sin datos).
        if (catalogType !== 'Prices') try {
          fs.mkdirSync(path.dirname(LATEST_CATALOG_JSON), { recursive: true });
          fs.copyFileSync(jsonFilePath, LATEST_CATALOG_JSON);
        } catch (e) {
          console.error('[BIHR SERVICE WARNING]: No se pudo guardar la copia del catálogo:', e);
        }
        try {
          fs.unlinkSync(zipPath);
          fs.rmSync(extractDir, { recursive: true, force: true });
          console.log('[BIHR SERVICE]: Limpieza de archivos temporales de descarga realizada.');
        } catch (e) {
          console.error('[BIHR SERVICE WARNING]: Error limpiando archivos temporales:', e);
        }
      }));
    });
  });
}

/**
 * Analiza el JSON importado e inserta/actualiza los productos en PostgreSQL
 */
const BATCH_SIZE = 100;

/**
 * Catálogo "Prices": el precio neto de cliente (DealerPriceHT) es el coste real.
 * El catálogo general solo trae el PVP y un "precio base distribuidor" que es el
 * PVP sin IVA (con él como coste el margen salía a cero).
 */
async function processPricesCatalog(catalog: any, catalogType: string, startTime: string) {
  const rows: any[] = catalog.Prices || [];
  const parts: string[] = []; const codes: string[] = []; const costs: number[] = [];
  for (const r of rows) {
    const net = Number(r.DealerPriceHT);
    if (!(net > 0)) continue;
    parts.push(String(r.NewPartNumber || '')); codes.push(String(r.ProductId || '')); costs.push(Math.round(net * 100));
  }
  let updated = 0;
  for (let i = 0; i < costs.length; i += 5000) {
    const r = await pool.query(`
      UPDATE products p SET cost = v.cost, updated_at = NOW()
      FROM unnest($1::text[], $2::text[], $3::int[]) AS v(part, code, cost)
      WHERE (p.part_number = v.part OR (p.part_number IS NULL AND p.sku = v.code))
        AND p.cost IS DISTINCT FROM v.cost`,
      [parts.slice(i, i + 5000), codes.slice(i, i + 5000), costs.slice(i, i + 5000)]);
    updated += r.rowCount || 0;
  }
  console.log(`[BIHR SERVICE]: Catálogo de precios: ${costs.length} precios netos, ${updated} costes actualizados.`);
  if (await pricingAuto()) {
    const stats = await repriceProducts();
    console.log(`[BIHR SERVICE]: Precios recalculados: ${stats.changed} cambios (precio medio ${stats.avgOld} → ${stats.avgNew} €).`);
  } else {
    console.log('[BIHR SERVICE]: Recálculo automático de precios desactivado (admin → Márgenes).');
  }
  updateCatalogSyncState({ status: 'completed', catalogType, startTime, endTime: new Date().toISOString(), inserted: 0, updated });
}

async function processCatalogJson(filePath: string, catalogType: string, startTime: string) {
  const rawData = fs.readFileSync(filePath, 'utf-8');
  const catalog = JSON.parse(rawData);
  if (catalogType === 'Prices' || (Array.isArray(catalog.Prices) && !catalog.References && !catalog.Products)) {
    return processPricesCatalog(catalog, catalogType, startTime);
  }
  
  const references = catalog.References || catalog.Products || [];
  console.log(`[BIHR SERVICE]: Total de referencias encontradas en catálogo de Bihr: ${references.length}`);

  updateCatalogSyncState({
    status: 'importing',
    catalogType,
    startTime,
    currentBatch: 0,
    totalBatches: Math.ceil(references.length / BATCH_SIZE),
    totalProcessed: 0,
    totalItems: references.length,
    inserted: 0,
    updated: 0
  });

  console.log('[BIHR SERVICE]: Comenzando upsert masivo en PostgreSQL...');
  
  // Cargar reglas de precios una vez al inicio del catálogo
  const rulesClient = await pool.connect();
  let pricingRules: any[] = [];
  try {
    const rulesRes = await rulesClient.query("SELECT * FROM pricing_rules WHERE active = 1");
    pricingRules = rulesRes.rows || [];
    console.log(`[BIHR SERVICE]: Se cargaron ${pricingRules.length} reglas de márgenes activas.`);
  } catch (err) {
    console.error('[BIHR SERVICE]: Error al cargar reglas de márgenes, se usarán valores por defecto:', err);
  } finally {
    rulesClient.release();
  }

  const totalBatches = Math.ceil(references.length / BATCH_SIZE);
  let totalInserted = 0;
  let totalUpdated = 0;

  for (let i = 0; i < references.length; i += BATCH_SIZE) {
    const batch = references.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    
    console.log(`[BIHR SERVICE]: Procesando lote ${batchNum}/${totalBatches} (${batch.length} productos)...`);
    
    updateCatalogSyncState({
      status: 'importing',
      catalogType,
      startTime,
      currentBatch: batchNum,
      totalBatches,
      totalProcessed: Math.min(i + BATCH_SIZE, references.length),
      totalItems: references.length,
      inserted: totalInserted,
      updated: totalUpdated
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      for (const ref of batch) {
        const sku = ref.ProductCode || ref.SupplierProductCode || ref.PartNumber || '';
        const name = ref.ProductName || ref.Description || ref.Designation || 'Sin nombre';
        const brand = ref.Brand || '';
        const supplierCode = ref.SupplierProductCode || '';
        const oldPartNumber = ref.OldPartNumber || '';
        // Número de pieza de Bihr: agrupa variantes (lib/catalog-enrich.ts).
        const partNumber = ref.NewPartNumber ? String(ref.NewPartNumber) : null;

        // PVP (IVA incluido). El coste real llega con el catálogo "Prices"
        // (processPricesCatalog); aquí solo se usa para dar de alta productos
        // nuevos, que quedan a PVP hasta que se conozca su coste.
        let price = 0;
        if (ref.RetailPriceIncludingTax) {
          price = Math.round(parseFloat(ref.RetailPriceIncludingTax) * 100);
        } else if (ref.RetailPriceExcludingTax) {
          price = Math.round(parseFloat(ref.RetailPriceExcludingTax) * 121);
        }
        if (price === 0) continue;
        const cost = 0;

        const barcode = ref.BarCode || '';
        const stockVal = ref.StockValue ? parseInt(ref.StockValue) : 0;
        const description = ref.Description || ref.HtmlDescription || '';

        // Mapeo de categorías Bihr a IDs de categorías locales
        const categoryMap: Record<string, number> = {
          'RIDER GEAR': 9,
          'HARD PARTS': 1,
          'PROTECTION': 9,
          'TYRES': 7,
          'OILS': 6,
          'LIQUIDS & LUBRICANTS': 6,
          'ACCESSORIES': 10,
          'VEHICLE PARTS & ACCESSORIES': 1,
          'TOOLING & WS': 7,
          'OTHER PRODUCTS & SERVICES': 10
        };
        const categoryId = categoryMap[ref.Category1?.toUpperCase()] || 1;

        // Mapeo de subcategorías Bihr a IDs de subcategorías locales
        const subcategoryMap: Record<string, number> = {
          'HELMET FULL FACE': 801,
          'HELMET FLIP UP': 802,
          'HELMET OPEN FACE': 803,
          'APPAREL JACKET': 901,
          'APPAREL SUIT': 902,
          'APPAREL GLOVES': 903,
          'FOOTWEAR BOOTS': 904,
          'BAG&PACK TRAVEL': 1001,
          'BAGS & PACKS': 1001,
          'COMMUNICATION & TECH': 1003,
          'ACCESSORIES': 1004,
          'ACC. ACCESS.': 1004,
          'ACC. ELECTRIC': 404,
          'ACC. ELECTRONIC': 401,
          'MAINTENANCE & CARE': 601,
          'MNT&CARE CLEAN&CARE': 601
        };
        const category2Id = subcategoryMap[ref.Category3?.toUpperCase()] || subcategoryMap[ref.Category2?.toUpperCase()] || null;

        // Campos físicos
        const weightG = ref['Weight (g)'] ? parseInt(ref['Weight (g)']) : null;
        const lengthMm = ref['Length (mm)'] ? parseInt(ref['Length (mm)']) : null;
        const widthMm = ref['Width (mm)'] ? parseInt(ref['Width (mm)']) : null;
        const heightMm = ref['Height (mm)'] ? parseInt(ref['Height (mm)']) : null;
        const volumeCm3 = ref['Volume (cm³)'] ? parseInt(ref['Volume (cm³)']) : null;

        // Logística
        const dropshipping = ref.DropShipping === '1' || ref.DropShipping === true;
        const ondemand = ref.OnDemand === '1' || ref.OnDemand === true;
        const deliveryPlant = ref.DeliveryPlant || '';
        const commodityCode = ref.CommodityCode || '';

        // Atributos para filtros
        const FILTER_ATTR_KEYS = [
          'Talla', 'Color', 'V-Color', 'V-Talla', 'V-Tamaño',
          'Estilo de casco', 'Tipo de cierre', 'Modelo de casco',
          'Estilo de pintura', 'Acabado de la pintura',
          'Composición', 'Homologación', 'Colección',
          'Tipo de pieza de repuesto'
        ];
        const attrs: Record<string, string> = {};
        for (const key of FILTER_ATTR_KEYS) {
          if (ref[key] !== undefined && ref[key] !== null && ref[key] !== '') {
            attrs[key] = String(ref[key]);
          }
        }
        const attributesJson = JSON.stringify(attrs);

        const result = await client.query(`
          INSERT INTO products (
            sku, name, brand, supplier_code, old_part_number,
            cost, price, stock, barcode, description,
            category_id, category2, category3, category2_id,
            weight_g, length_mm, width_mm, height_mm, volume_cm3,
            dropshipping, ondemand, delivery_plant, commodity_code,
            attributes, part_number, pvp, status, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18, $19,
            $20, $21, $22, $23,
            $24::jsonb, $25, $7, 'published', NOW(), NOW()
          )
          -- Las categorías solo se fijan al crear el producto: el mapa fijo de
          -- abajo es muy grueso (por defecto la 1) y pisaba las asignadas por
          -- el enriquecimiento o a mano en el admin.
          ON CONFLICT (sku) DO UPDATE SET
            name = EXCLUDED.name,
            brand = EXCLUDED.brand,
            supplier_code = EXCLUDED.supplier_code,
            old_part_number = EXCLUDED.old_part_number,
            -- Coste (catálogo Prices) y precio (lib/pricing.ts) no se pisan aquí.
            pvp = EXCLUDED.pvp,
            stock = EXCLUDED.stock,
            barcode = EXCLUDED.barcode,
            description = EXCLUDED.description,
            weight_g = EXCLUDED.weight_g,
            length_mm = EXCLUDED.length_mm,
            width_mm = EXCLUDED.width_mm,
            height_mm = EXCLUDED.height_mm,
            volume_cm3 = EXCLUDED.volume_cm3,
            dropshipping = EXCLUDED.dropshipping,
            ondemand = EXCLUDED.ondemand,
            delivery_plant = EXCLUDED.delivery_plant,
            commodity_code = EXCLUDED.commodity_code,
            attributes = (CASE WHEN jsonb_typeof(products.attributes) = 'object' THEN products.attributes ELSE '{}'::jsonb END) || EXCLUDED.attributes,
            part_number = COALESCE(EXCLUDED.part_number, products.part_number),
            updated_at = NOW()
          RETURNING id, (xmax = 0) AS inserted
        `, [
          sku, name, brand, supplierCode, oldPartNumber,
          cost, price, stockVal, barcode, description,
          categoryId, ref.Category2 || '', ref.Category3 || '', category2Id,
          weightG, lengthMm, widthMm, heightMm, volumeCm3,
          dropshipping, ondemand, deliveryPlant, commodityCode,
          attributesJson, partNumber
        ]);

        if (result.rows[0]?.inserted) {
          totalInserted++;
        } else {
          totalUpdated++;
        }
      }
      
      await client.query('COMMIT');
      console.log(`[BIHR SERVICE]: Lote ${batchNum} completado.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[BIHR SERVICE ERROR]: Error en lote ${batchNum}:`, err);
    } finally {
      client.release();
    }
  }
  
  console.log(`[BIHR SERVICE]: Importación completada. Nuevos: ${totalInserted}, Actualizados: ${totalUpdated}`);

  // Variantes, atributos del CSV y duplicados (idempotente).
  try {
    const csvDir = [process.env.CATALOG_CSV_DIR, '/app/server/uploads/catalog-csv', '/app/server/catalog-csv']
      .find((d) => d && fs.existsSync(d)) || '';
    const stats = await enrichCatalog(filePath, csvDir);
    console.log('[BIHR SERVICE]: Enriquecimiento del catálogo:', stats);
  } catch (e) {
    console.error('[BIHR SERVICE] Error enriqueciendo el catálogo:', e);
  }

  // Las compatibilidades pueden haber cambiado: recalcular la tabla de modelos.
  refreshCompatModels().catch(e => console.error('[BIHR SERVICE] Error refrescando compat_vehicle_models:', e));

  // Costes reales (y recálculo de precios si está activado) con el catálogo de precios.
  setTimeout(() => {
    syncBihrCatalog('Prices').catch((e) => console.error('[BIHR SERVICE] Error con el catálogo de precios:', e));
  }, 5000);
  
  updateCatalogSyncState({
    status: 'completed',
    catalogType,
    startTime,
    endTime: new Date().toISOString(),
    inserted: totalInserted,
    updated: totalUpdated
  });
}
