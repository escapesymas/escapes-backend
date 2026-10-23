import { Router } from 'express';
import { pool } from '../db.js';
import { getLiveStockLevel, getLiveStockValue, checkProductsInfo, createBihrOrder } from '../bihrService.js';
import { syncBihrStock, lastBihrStockSync } from '../lib/bihr-stock-sync.js';
import { requireAdmin } from '../utils.js';
import { requireAdminRole } from '../lib/agent-auth.js';
import { syncDiscontinued, lastDiscontinuedSync } from '../lib/bihr-discontinued.js';

export const bihrRouter = Router();

// Todas las rutas de Bihr tocan la cuenta de proveedor de la tienda (stock en
// vivo, pedidos dropshipping, sincronizaciones): solo administradores.

// GET /api/bihr/stock
bihrRouter.get('/bihr/stock', requireAdmin, async (req: any, res: any) => {
  try {
    const sku = req.query.sku as string;
    if (!sku) return res.status(400).json({ error: 'Falta SKU' });
    const stock = await getLiveStockLevel(sku);
    res.json({ sku, stock });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bihr/check-stock
bihrRouter.post('/bihr/check-stock', requireAdmin, async (req: any, res: any) => {
  try {
    const { skus } = req.body;
    if (!Array.isArray(skus)) return res.status(400).json({ error: 'skus debe ser un array' });
    const items = skus.map(s => ({ ProductCode: String(s), Quantity: 1 }));
    const results = await checkProductsInfo(items);
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bihr/order
bihrRouter.post('/bihr/order', requireAdmin, async (req: any, res: any) => {
  try {
    const { orderId, items, shippingData } = req.body;
    const bihrOrder = await createBihrOrder({
      deliveryAddress: {
        firstName: shippingData?.firstName || '',
        lastName: shippingData?.lastName || '',
        street: shippingData?.address || '',
        zipCode: shippingData?.postcode || '',
        city: shippingData?.city || '',
        countryCode: shippingData?.country || 'ES',
        phoneNumber: shippingData?.phone || '',
        email: shippingData?.email || '',
      },
      items: (items || []).map((it: any) => ({
        productCode: it.sku || it.productCode,
        quantity: it.quantity || 1,
      })),
      customerOrderReference: String(orderId),
      isDropshipping: true,
    });
    res.json(bihrOrder);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sync-bihr-stock
bihrRouter.post('/admin/sync-bihr-stock', requireAdmin, async (_req: any, res: any) => {
  try {
    syncBihrStock().catch(e => console.error('[BIHR STOCK SYNC ROUTE ERROR]', e));
    return res.json({ message: 'Sincronización de stock Bihr iniciada en segundo plano' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sync-bihr-stock/status
bihrRouter.get('/admin/sync-bihr-stock/status', requireAdmin, async (_req: any, res: any) => {
  return res.json(lastBihrStockSync() || { status: 'idle' });
});

// POST /api/admin/bihr/descatalogados — oculta ya los descatalogados de Bihr sin stock (y recupera los reactivados).
bihrRouter.post('/admin/bihr/descatalogados', async (req: any, res: any) => {
  if (!(await requireAdminRole(req, res))) return;
  syncDiscontinued().catch((e) => console.error('[BIHR DESCATALOGADOS ROUTE ERROR]', e));
  return res.json({ message: 'Revisión de descatalogados iniciada en segundo plano', last: lastDiscontinuedSync() });
});

// GET /api/admin/bihr/descatalogados — resultado de la última revisión.
bihrRouter.get('/admin/bihr/descatalogados', async (req: any, res: any) => {
  if (!(await requireAdminRole(req, res))) return;
  const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n FROM products WHERE status = 'descatalogado'`);
  return res.json({ last: lastDiscontinuedSync(), hiddenNow: r?.n ?? 0 });
});

// GET /api/admin/catalog/descriptions — cómo van las descripciones del fabricante y su traducción
// (lib/bihr-descriptions.ts y lib/description-translation.ts).
bihrRouter.get('/admin/catalog/descriptions', async (req: any, res: any) => {
  if (!(await requireAdminRole(req, res))) return;
  try {
    const [products, queue, recent, last] = await Promise.all([
      pool.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE stock > 0)::int AS con_stock,
               count(*) FILTER (WHERE description_source = 'bihr')::int AS del_fabricante,
               count(*) FILTER (WHERE length(btrim(regexp_replace(coalesce(description, ''), '<[^>]*>', '', 'g'))) < 30)::int AS sin_descripcion,
               count(*) FILTER (WHERE stock > 0 AND length(btrim(regexp_replace(coalesce(description, ''), '<[^>]*>', '', 'g'))) < 30)::int AS sin_descripcion_con_stock
          FROM products WHERE status = 'published' AND duplicate_of IS NULL`),
      pool.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE html_es IS NOT NULL)::int AS traducidas,
               count(*) FILTER (WHERE html_es IS NULL AND attempts < 3)::int AS pendientes,
               count(*) FILTER (WHERE html_es IS NULL AND attempts >= 3)::int AS fallidas,
               coalesce(sum(cardinality(product_ids)) FILTER (WHERE html_es IS NOT NULL), 0)::int AS fichas_traducidas,
               coalesce(sum(cardinality(product_ids)) FILTER (WHERE html_es IS NULL), 0)::int AS fichas_pendientes,
               count(*) FILTER (WHERE translated_at > NOW() - INTERVAL '10 minutes')::int AS ultimos_10_min,
               max(translated_at) AS ultima
          FROM description_translations`),
      pool.query(`
        SELECT left(regexp_replace(source_html, '<[^>]*>', ' ', 'g'), 160) AS en,
               left(regexp_replace(html_es, '<[^>]*>', ' ', 'g'), 200) AS es, translated_at
          FROM description_translations WHERE html_es IS NOT NULL ORDER BY translated_at DESC LIMIT 3`),
      pool.query(`SELECT value FROM catalog_meta WHERE key = 'bihr_descriptions_last'`),
    ]);
    let lastRun = null;
    try { lastRun = JSON.parse(last.rows[0]?.value || 'null'); } catch { /* sin pasada */ }
    if (lastRun) delete lastRun.samples;
    return res.json({ products: products.rows[0], queue: queue.rows[0], recent: recent.rows, lastRun });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
