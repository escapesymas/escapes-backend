import { Router } from 'express';
import { requireAdminRole } from '../lib/agent-auth.js';
import { pool } from '../db.js';
import { getRealtimeData, getAnalyticsStats, getSessionDetail, getVisitorInsights, findSessionForCart, type StatsRange } from '../lib/umami-db.js';

export const analyticsRouter = Router();

const VALID_RANGES: StatsRange[] = ['today', '24h', '7d', '30d', 'all'];

/**
 * GET /api/admin/analytics/realtime
 * Retorna usuarios activos en vivo (últimos 5/15/30 min), página actual que ven
 * y el flujo de páginas vistas recientes.
 */
analyticsRouter.get('/admin/analytics/realtime', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;

  try {
    const excludeInternal = req.query.excludeInternal !== 'false';
    const data = await getRealtimeData(excludeInternal);
    res.json(data);
  } catch (err: any) {
    console.error('[ANALYTICS REALTIME ERROR]:', err);
    res.status(500).json({ error: err.message || 'Error consultando métricas en tiempo real' });
  }
});

/**
 * GET /api/admin/analytics/online-count
 * Retorna exclusivamente el conteo rápido de usuarios en línea en los últimos 5 minutos.
 * Ideal para el badge en vivo en el menú o cabecera del panel admin.
 */
analyticsRouter.get('/admin/analytics/online-count', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;

  try {
    const excludeInternal = req.query.excludeInternal !== 'false';
    const data = await getRealtimeData(excludeInternal);
    res.json({
      online5m: data.online5m,
      online15m: data.online15m,
      timestamp: data.timestamp,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error consultando usuarios en línea' });
  }
});

/**
 * GET /api/admin/analytics/stats
 * Retorna métricas completas para el periodo seleccionado (hoy, 24h, 7d, 30d, all).
 */
analyticsRouter.get('/admin/analytics/stats', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;

  try {
    const range = (req.query.range as any) || 'today';
    const excludeInternal = req.query.excludeInternal !== 'false';

    const safeRange: StatsRange = VALID_RANGES.includes(range) ? range : 'today';

    const stats = await getAnalyticsStats(safeRange, excludeInternal);
    res.json(stats);
  } catch (err: any) {
    console.error('[ANALYTICS STATS ERROR]:', err);
    res.status(500).json({ error: err.message || 'Error consultando analítica web' });
  }
});

/**
 * GET /api/admin/analytics/visitors
 * Visitantes del periodo por prioridad (carrito, pago, chat y después los de más páginas o visitas), embudo de
 * conversión, eventos, búsquedas y motos más elegidas. Con caché en memoria de 30 s.
 */
analyticsRouter.get('/admin/analytics/visitors', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;

  try {
    const range = (req.query.range as any) || 'today';
    const excludeInternal = req.query.excludeInternal !== 'false';
    const safeRange: StatsRange = VALID_RANGES.includes(range) ? range : 'today';
    res.json(await getVisitorInsights(safeRange, excludeInternal));
  } catch (err: any) {
    console.error('[ANALYTICS VISITORS ERROR]:', err);
    res.status(500).json({ error: err.message || 'Error consultando los visitantes' });
  }
});

/**
 * GET /api/admin/analytics/cart-session?cartId=964
 * Busca la visita de Umami que creó un carrito, cruzando los productos del carrito con los «añadir al carrito» de las
 * visitas (el carrito y Umami no comparten identificador). Devuelve `match: null` si no aparece (p. ej. el visitante
 * lleva un bloqueador de anuncios y Umami no lo vio).
 */
analyticsRouter.get('/admin/analytics/cart-session', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;

  const cartId = parseInt(String(req.query.cartId), 10);
  if (!Number.isInteger(cartId) || cartId <= 0) {
    return res.status(400).json({ error: 'cartId no válido' });
  }

  try {
    // La hora del carrito se guarda en UTC (zona del servidor); se pasa a ISO con «Z» para compararla con Umami.
    const cart = await pool.query(
      `SELECT items, to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_iso FROM carts WHERE id = $1`,
      [cartId]);
    if (!cart.rows.length) return res.status(404).json({ error: 'Carrito no encontrado' });

    let items: any[] = [];
    try { items = JSON.parse(cart.rows[0].items || '[]'); } catch { /* carrito con JSON dañado: sin productos */ }
    const productIds = (Array.isArray(items) ? items : []).map((i) => Number(i?.id ?? i?.product_id)).filter((n) => n > 0);

    const match = await findSessionForCart(productIds, cart.rows[0].updated_iso);
    res.json({ cartId, match });
  } catch (err: any) {
    console.error('[ANALYTICS CART SESSION ERROR]:', err);
    res.status(500).json({ error: err.message || 'Error buscando la visita del carrito' });
  }
});

/**
 * GET /api/admin/analytics/session-detail
 * Retorna el recorrido completo paso a paso (páginas vistas y eventos) de una sesión.
 */
analyticsRouter.get('/admin/analytics/session-detail', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;

  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId es obligatorio' });
  }

  try {
    const detail = await getSessionDetail(sessionId);
    if (!detail) {
      return res.status(404).json({ error: 'Sesión no encontrada' });
    }
    res.json(detail);
  } catch (err: any) {
    console.error('[ANALYTICS SESSION DETAIL ERROR]:', err);
    res.status(500).json({ error: err.message || 'Error consultando detalle de la sesión' });
  }
});
