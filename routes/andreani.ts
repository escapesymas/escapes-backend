import { Router } from 'express';
import { requireAdminRole, requireAgent } from '../lib/agent-auth.js';
import {
  getAndreaniSession,
  saveAndreaniSession,
  getLiveAndreaniStock,
  checkAndNotifyCookieExpiry,
} from '../lib/andreani-service.js';

export const andreaniRouter = Router();

/**
 * GET /api/admin/andreani/status
 * Estado de la sesión de Andreani MHS: expiración, horas restantes y estado.
 */
andreaniRouter.get('/admin/andreani/status', requireAgent, async (_req: any, res: any) => {
  try {
    const session = await getAndreaniSession();
    if (!session || !session.expiresAt) {
      return res.json({
        configured: false,
        message: 'No hay sesión de Andreani MHS guardada.',
      });
    }

    const expiresTime = new Date(session.expiresAt).getTime();
    const msRemaining = expiresTime - Date.now();
    const hoursRemaining = Math.max(0, Math.round((msRemaining / (3600 * 1000)) * 10) / 10);
    const isExpiringSoon = msRemaining <= 24 * 3600 * 1000;
    const isExpired = msRemaining <= 0;

    return res.json({
      configured: true,
      expiresAt: session.expiresAt,
      hoursRemaining,
      isExpiringSoon,
      isExpired,
      lastRemindedAt: session.lastRemindedAt || null,
      lastCheckedAt: session.lastCheckedAt || null,
      lastCheckStatus: session.lastCheckStatus || 'unknown',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Error al obtener estado' });
  }
});

/**
 * POST /api/admin/andreani/session
 * Actualiza la cookie de sesión y fecha de expiración desde el panel de control.
 */
andreaniRouter.post('/admin/andreani/session', requireAdminRole, async (req: any, res: any) => {
  try {
    const { cookie, expiresAt, userAgent } = req.body;
    if (!cookie || typeof cookie !== 'string') {
      return res.status(400).json({ error: 'La cookie es obligatoria' });
    }

    // Si no se indica fecha, por defecto sumamos 10 días desde ahora
    const calculatedExpiresAt =
      expiresAt && !isNaN(new Date(expiresAt).getTime())
        ? new Date(expiresAt).toISOString()
        : new Date(Date.now() + 10 * 86400 * 1000).toISOString();

    const saved = await saveAndreaniSession({
      cookie,
      expiresAt: calculatedExpiresAt,
      userAgent,
      lastRemindedAt: null, // Resetear avisos anteriores para el nuevo ciclo
      lastCheckStatus: 'updated_manually',
      lastCheckedAt: new Date().toISOString(),
    });

    return res.json({
      success: true,
      message: 'Sesión de Andreani MHS actualizada correctamente.',
      expiresAt: saved.expiresAt,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Error al guardar sesión' });
  }
});

/**
 * GET /api/andreani/stock/:ref
 * Consulta el stock real de un producto por su referencia de fabricante o SKU.
 */
andreaniRouter.get('/andreani/stock/:ref', async (req: any, res: any) => {
  try {
    const ref = String(req.params.ref || '').trim();
    if (!ref) {
      return res.status(400).json({ error: 'Referencia requerida' });
    }

    const stock = await getLiveAndreaniStock(ref);
    if (!stock) {
      return res.status(404).json({
        found: false,
        reference: ref,
        message: 'No se encontró el producto o el servicio de stock no respondió',
      });
    }

    return res.json({
      found: true,
      reference: stock.reference,
      name: stock.name,
      stock: stock.quantity,
      inStock: stock.inStock,
      allowOosp: stock.allowOosp,
      priceNet: stock.priceTaxExc,
      pricePvp: stock.priceAmount,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Error al consultar stock' });
  }
});

/**
 * POST /api/admin/andreani/test-reminder
 * Dispara una prueba inmediata de la notificación push y el correo de recordatorio.
 */
andreaniRouter.post('/admin/andreani/test-reminder', requireAdminRole, async (_req: any, res: any) => {
  try {
    const result = await checkAndNotifyCookieExpiry(true);
    return res.json({
      success: true,
      message: 'Prueba de recordatorio enviada vía Web Push y correo a info@escapesymas.com',
      details: result,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Error al enviar recordatorio de prueba' });
  }
});
