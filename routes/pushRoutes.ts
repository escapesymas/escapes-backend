import { Router } from 'express';
import {
  getVapidPublicKey, saveSubscription, removeSubscription, sendNotificationToAll, updatePreferences,
  getSubscriptionPreferences, listNotifications, markNotificationsRead, unreadCount, NOTIFICATION_CATEGORIES,
} from '../pushService.js';
import { authenticateRequest } from '../utils.js';

export const pushRouter = Router();

/** Los avisos llevan datos de clientes y pedidos: solo para administradores. */
function requireAdmin(req: any, res: any): any | null {
  const auth = authenticateRequest(req);
  if (!auth || auth.role !== 'admin') {
    res.status(403).json({ error: 'Solo administradores' });
    return null;
  }
  return auth;
}

/** Los asesores también registran su móvil para los avisos del chat. */
function requireAdminOrAgent(req: any, res: any): any | null {
  const auth = authenticateRequest(req);
  if (!auth || (auth.role !== 'admin' && auth.role !== 'asesor')) {
    res.status(403).json({ error: 'Solo administradores y asesores' });
    return null;
  }
  return auth;
}

// GET /api/push/vapid-public-key
pushRouter.get('/push/vapid-public-key', (_req, res) => {
  return res.json({ publicKey: getVapidPublicKey() });
});

// POST /api/push/subscribe
pushRouter.post('/push/subscribe', async (req, res) => {
  const auth = requireAdminOrAgent(req, res);
  if (!auth) return;
  try {
    await saveSubscription(auth.user_id, req.body);
    return res.json({ success: true, message: 'Suscripción push guardada correctamente' });
  } catch (err: any) {
    console.error('[PUSH SUBSCRIBE ERROR]:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/push/preferences?endpoint=…  → preferencias y categorías disponibles
pushRouter.get('/push/preferences', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const endpoint = String(req.query.endpoint || '');
    const preferences = endpoint ? await getSubscriptionPreferences(endpoint) : null;
    return res.json({ preferences, categories: NOTIFICATION_CATEGORIES });
  } catch (err: any) {
    console.error('[PUSH GET PREFERENCES ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudieron leer las preferencias' });
  }
});

// POST /api/push/preferences
pushRouter.post('/push/preferences', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { endpoint, preferences } = req.body || {};
    if (!endpoint || !preferences) return res.status(400).json({ error: 'Endpoint y preferencias requeridos' });
    await updatePreferences(endpoint, preferences);
    return res.json({ success: true, message: 'Preferencias actualizadas' });
  } catch (err: any) {
    console.error('[PUSH UPDATE PREFERENCES ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudieron guardar las preferencias' });
  }
});

// POST /api/push/unsubscribe
pushRouter.post('/push/unsubscribe', async (req, res) => {
  if (!requireAdminOrAgent(req, res)) return;
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'Endpoint requerido' });
    await removeSubscription(endpoint);
    return res.json({ success: true, message: 'Suscripción eliminada' });
  } catch (err: any) {
    console.error('[PUSH UNSUBSCRIBE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo eliminar la suscripción' });
  }
});

// POST /api/push/test
pushRouter.post('/push/test', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await sendNotificationToAll({
      title: '🔔 Notificación de prueba',
      body: 'Si ves esto en el móvil, los avisos del panel funcionan.',
      category: 'system',
    });
    return res.json({ success: true, message: 'Notificación de prueba enviada' });
  } catch (err: any) {
    console.error('[PUSH TEST ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo enviar la prueba' });
  }
});

// GET /api/push/history?limit=&before=&category=&unread=1
pushRouter.get('/push/history', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const items = await listNotifications({
      limit: parseInt(String(req.query.limit || '30')) || 30,
      before: parseInt(String(req.query.before || '')) || undefined,
      category: req.query.category ? String(req.query.category) : undefined,
      unread: req.query.unread === '1',
    });
    return res.json({ items, unread: await unreadCount() });
  } catch (err: any) {
    console.error('[PUSH HISTORY ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo leer el historial' });
  }
});

// GET /api/push/unread-count
pushRouter.get('/push/unread-count', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    return res.json({ unread: await unreadCount() });
  } catch {
    return res.json({ unread: 0 });
  }
});

// POST /api/push/history/read  { ids: number[] } | { all: true }
pushRouter.post('/push/history/read', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { ids, all } = req.body || {};
    await markNotificationsRead(all ? 'all' : (Array.isArray(ids) ? ids.map((x: any) => parseInt(x)).filter(Number.isFinite) : []));
    return res.json({ success: true, unread: await unreadCount() });
  } catch (err: any) {
    console.error('[PUSH READ ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo actualizar' });
  }
});
