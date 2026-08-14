import { Router } from 'express';
import { getLiveStockLevel, getLiveStockValue, checkProductsInfo, createBihrOrder } from '../bihrService.js';
import { syncBihrStock, lastBihrStockSync } from '../lib/bihr-stock-sync.js';

export const bihrRouter = Router();

// GET /api/bihr/stock
bihrRouter.get('/bihr/stock', async (req: any, res: any) => {
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
bihrRouter.post('/bihr/check-stock', async (req: any, res: any) => {
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
bihrRouter.post('/bihr/order', async (req: any, res: any) => {
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
bihrRouter.post('/admin/sync-bihr-stock', async (_req: any, res: any) => {
  try {
    syncBihrStock().catch(e => console.error('[BIHR STOCK SYNC ROUTE ERROR]', e));
    return res.json({ message: 'Sincronización de stock Bihr iniciada en segundo plano' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sync-bihr-stock/status
bihrRouter.get('/admin/sync-bihr-stock/status', async (_req: any, res: any) => {
  return res.json(lastBihrStockSync() || { status: 'idle' });
});
