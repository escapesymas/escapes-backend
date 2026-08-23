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
        preferences JSONB DEFAULT '{"new_order": true, "payment_failed": true, "abandoned_cart": true, "dropshipping_status": true, "new_user": true, "daily_summary": true}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{"new_order": true, "payment_failed": true, "abandoned_cart": true, "dropshipping_status": true, "new_user": true, "daily_summary": true}'::jsonb;
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

export interface NotificationPreferences {
  new_order: boolean;
  payment_failed: boolean;
  abandoned_cart: boolean;
  dropshipping_status: boolean;
  new_user: boolean;
  daily_summary: boolean;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  new_order: true,
  payment_failed: true,
  abandoned_cart: true,
  dropshipping_status: true,
  new_user: true,
  daily_summary: true,
};

/**
 * Obtiene o actualiza las preferencias de una suscripción
 */
export async function updatePreferences(endpoint: string, prefs: Partial<NotificationPreferences>) {
  await db.execute(sql`
    UPDATE push_subscriptions
    SET preferences = COALESCE(preferences, '{}'::jsonb) || ${JSON.stringify(prefs)}::jsonb
    WHERE endpoint = ${endpoint};
  `);
}

export async function getSubscriptionPreferences(endpoint: string): Promise<NotificationPreferences> {
  const res = await db.execute(sql`SELECT preferences FROM push_subscriptions WHERE endpoint = ${endpoint}`);
  const row = res.rows[0] as any;
  if (!row || !row.preferences) return DEFAULT_PREFERENCES;
  return { ...DEFAULT_PREFERENCES, ...row.preferences };
}

/**
 * Envía una notificación push a todas las suscripciones registradas que tengan la categoría activada
 */
export async function sendNotificationToAll(payload: { title: string; body: string; url?: string; category?: keyof NotificationPreferences; data?: any }) {
  try {
    const res = await db.execute(sql`SELECT * FROM push_subscriptions`);
    const subs = res.rows as any[];

    if (!subs || subs.length === 0) {
      console.log('[PUSH] No hay suscripciones registradas para enviar notificación');
      return;
    }

    const category = payload.category;

    const notificationData = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || '/orders',
      data: payload.data || {}
    });

    const sendPromises = subs.map(async (sub) => {
      // Verificar preferencia del usuario si la categoría está definida
      if (category && sub.preferences && sub.preferences[category] === false) {
        console.log(`[PUSH] Omitiendo envío a ${sub.endpoint.slice(0, 20)}... Desactivado en preferencias (${category})`);
        return;
      }

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
 * Helpers para cada tipo de notificación
 */
export async function notifyNewOrder(order: { id: number; total: number; customerName?: string; productNames?: string }) {
  const totalFormatted = (order.total / 100).toFixed(2);
  const customer = order.customerName ? ` de ${order.customerName}` : '';
  const products = order.productNames ? ` - ${order.productNames}` : '';

  await sendNotificationToAll({
    title: `🛒 ¡Nuevo Pedido #${order.id}!`,
    body: `Importe: ${totalFormatted} €${customer}${products}`,
    url: `/orders`,
    category: 'new_order',
    data: { orderId: order.id }
  });
}

export async function notifyFailedPayment(order: { id?: number | null; reason?: string }) {
  const orderText = order.id ? ` #${order.id}` : '';
  const reasonText = order.reason ? `: ${order.reason}` : '';

  await sendNotificationToAll({
    title: `⚠️ Pago Rechazado/Fallido${orderText}`,
    body: `Un intento de pago ha sido rechazado${reasonText}`,
    url: `/orders`,
    category: 'payment_failed',
    data: { orderId: order.id, type: 'payment_failed' }
  });
}

export async function notifyAbandonedCart(cart: { id: number; customerName?: string; total: number }) {
  const totalFormatted = (cart.total / 100).toFixed(2);
  const customer = cart.customerName ? ` de ${cart.customerName}` : '';

  await sendNotificationToAll({
    title: `🛒 Carrito Abandonado${customer}`,
    body: `El cliente ha dejado un carrito pendiente por valor de ${totalFormatted} €`,
    url: `/carts`,
    category: 'abandoned_cart',
    data: { cartId: cart.id }
  });
}

export async function notifyDropshippingStatus(info: { orderId: number; status: string; trackingNumber?: string }) {
  const isShipped = info.status === 'shipped';
  const trackingText = info.trackingNumber ? ` (Tracking: ${info.trackingNumber})` : '';

  await sendNotificationToAll({
    title: isShipped ? `📦 Pedido #${info.orderId} Enviado por Bihr` : `⚠️ Incidencia Dropshipping Pedido #${info.orderId}`,
    body: isShipped ? `El proveedor ha marcado como enviado el pedido${trackingText}` : `Estado: ${info.status}`,
    url: `/orders`,
    category: 'dropshipping_status',
    data: { orderId: info.orderId }
  });
}

export async function notifyNewUser(user: { name: string; email: string }) {
  await sendNotificationToAll({
    title: `👤 ¡Nuevo Usuario Registrado!`,
    body: `${user.name} (${user.email}) se ha creado una cuenta.`,
    url: `/users`,
    category: 'new_user'
  });
}

export async function notifyDailySummary(summary: { totalSales: number; orderCount: number }) {
  const salesFormatted = (summary.totalSales / 100).toFixed(2);
  await sendNotificationToAll({
    title: `📈 Resumen Diario de Ventas`,
    body: `Ventas de hoy: ${salesFormatted} € en ${summary.orderCount} pedidos.`,
    url: `/stats`,
    category: 'daily_summary'
  });
}
