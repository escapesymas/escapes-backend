import webPush from 'web-push';
import { db } from './db.js';
import { sql } from 'drizzle-orm';

// Claves VAPID configuradas
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BLwPrhtaKSOg1opTzFI8erHC8kKksUfVoI7IdUHF9240M8D-vVs4ClfjRa1w-WPrMyzg1BLzNmSZHlPnsOu6nFI';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'GRBdcL4m7pQRvDkQbwkILTFalnVn8wTupTzNTxj3XL8';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:info@escapesymas.com';

webPush.setVapidDetails(
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

/**
 * Asegura la existencia de la tabla push_subscriptions en PostgreSQL
 */
export async function initPushTable() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INT,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
  } catch (err) {
    console.error('[PUSH TABLE INIT ERROR]:', err);
  }
}

// Inicializar la tabla al cargar el módulo
initPushTable();

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Guarda o actualiza una suscripción push en la DB
 */
export async function saveSubscription(userId: number | null, sub: PushSubscriptionPayload) {
  if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('Suscripción inválida');
  }

  await db.execute(sql`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (${userId}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})
    ON CONFLICT (endpoint) 
    DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth;
  `);
}

/**
 * Elimina una suscripción push
 */
export async function removeSubscription(endpoint: string) {
  await db.execute(sql`
    DELETE FROM push_subscriptions WHERE endpoint = ${endpoint};
  `);
}

/**
 * Envía una notificación push a todas las suscripciones registradas
 */
export async function sendNotificationToAll(payload: { title: string; body: string; url?: string; data?: any }) {
  try {
    const res = await db.execute(sql`SELECT * FROM push_subscriptions`);
    const subs = res.rows as any[];

    if (!subs || subs.length === 0) {
      console.log('[PUSH] No hay suscripciones registradas para enviar notificación');
      return;
    }

    const notificationData = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || '/orders',
      data: payload.data || {}
    });

    const sendPromises = subs.map(async (sub) => {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      };

      try {
        await webPush.sendNotification(pushSub, notificationData);
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // Suscripción caducada o inactiva -> eliminar
          console.log(`[PUSH] Eliminando suscripción caducada: ${sub.endpoint.slice(0, 30)}...`);
          await removeSubscription(sub.endpoint);
        } else {
          console.error('[PUSH SEND ERROR]:', err);
        }
      }
    });

    await Promise.all(sendPromises);
  } catch (err) {
    console.error('[PUSH BROADCAST ERROR]:', err);
  }
}

/**
 * Helper específico para nuevo pedido
 */
export async function notifyNewOrder(order: { id: number; total: number; customerName?: string; productNames?: string }) {
  const totalFormatted = (order.total / 100).toFixed(2);
  const customer = order.customerName ? ` de ${order.customerName}` : '';
  const products = order.productNames ? ` - ${order.productNames}` : '';

  await sendNotificationToAll({
    title: `🛒 ¡Nuevo Pedido #${order.id}!`,
    body: `Importe: ${totalFormatted} €${customer}${products}`,
    url: `/orders`,
    data: { orderId: order.id }
  });
}
