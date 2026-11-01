import { Router } from 'express';
import { requireAdminRole } from '../lib/agent-auth.js';
import { getRealtimeData, getAnalyticsStats } from '../lib/umami-db.js';

export const analyticsRouter = Router();

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

    const validRanges = ['today', '24h', '7d', '30d', 'all'];
    const safeRange = validRanges.includes(range) ? range : 'today';

    const stats = await getAnalyticsStats(safeRange, excludeInternal);
    res.json(stats);
  } catch (err: any) {
    console.error('[ANALYTICS STATS ERROR]:', err);
    res.status(500).json({ error: err.message || 'Error consultando analítica web' });
  }
});
