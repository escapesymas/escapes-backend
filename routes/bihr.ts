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
