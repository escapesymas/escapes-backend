import { Router } from 'express';
import { getVapidPublicKey, saveSubscription, removeSubscription, sendNotificationToAll } from '../pushService.js';
import { authenticateRequest } from '../utils.js';

export const pushRouter = Router();

// GET /api/push/vapid-public-key
pushRouter.get('/push/vapid-public-key', (_req, res) => {
  return res.json({ publicKey: getVapidPublicKey() });
});

// POST /api/push/subscribe
pushRouter.post('/push/subscribe', async (req, res) => {
  try {
    const auth = authenticateRequest(req);
    const userId = auth ? auth.user_id : null;
    const subscription = req.body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Suscripción inválida' });
    }

    await saveSubscription(userId, subscription);
    return res.json({ success: true, message: 'Suscripción push guardada correctamente' });
  } catch (err: any) {
    console.error('[PUSH SUBSCRIBE ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/push/unsubscribe
pushRouter.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Endpoint requerido' });

    await removeSubscription(endpoint);
    return res.json({ success: true, message: 'Suscripción eliminada' });
  } catch (err: any) {
    console.error('[PUSH UNSUBSCRIBE ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/push/test (Ruta de prueba)
pushRouter.post('/push/test', async (req, res) => {
  try {
    const auth = authenticateRequest(req);
    if (!auth || auth.role !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores pueden enviar notificaciones de prueba' });
    }

    const { title, body } = req.body;

    await sendNotificationToAll({
      title: title || '🔔 Notificación de prueba - Escapes y Más',
      body: body || 'Si estás viendo esto en tu iPhone, ¡las notificaciones push funcionan perfectamente!',
      url: '/orders'
    });

    return res.json({ success: true, message: 'Notificación de prueba enviada' });
  } catch (err: any) {
    console.error('[PUSH TEST ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});
