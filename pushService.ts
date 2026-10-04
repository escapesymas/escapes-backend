/**
 * Avisos del panel de administración en el móvil (Web Push) y su historial.
 *
 * Cada aviso se guarda en admin_notifications (el admin lo ve en su centro de
 * notificaciones aunque el push no llegue) y se envía a las suscripciones de
 * administradores que tengan activada su categoría. Al pulsarlo, el admin abre
 * la pestaña y el pedido correspondientes (url `/?tab=…&order=…`).
 */
import webPush from 'web-push';
import { db, pool } from './db.js';
import { sql } from 'drizzle-orm';

// Claves VAPID. Las de respaldo son las que tiene ya registradas el iPhone del
// administrador; si se configuran en el entorno, habrá que volver a activar
// los avisos en cada dispositivo.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BLwPrhtaKSOg1opTzFI8erHC8kKksUfVoI7IdUHF9240M8D-vVs4ClfjRa1w-WPrMyzg1BLzNmSZHlPnsOu6nFI';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'GRBdcL4m7pQRvDkQbwkILTFalnVn8wTupTzNTxj3XL8';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:info@escapesymas.com';

webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

/** Categorías de aviso, con su texto para la pantalla de preferencias. */
export const NOTIFICATION_CATEGORIES = [
  { key: 'new_order', label: 'Pedidos pagados', description: 'Cada pedido cobrado, con importe y productos', urgent: true },
  { key: 'payment_failed', label: 'Pagos con problemas', description: 'Pagos rechazados o con importe distinto al del pedido', urgent: true },
  { key: 'refund', label: 'Reembolsos', description: 'Solicitudes de los clientes y reembolsos realizados', urgent: true },
  { key: 'dropshipping_status', label: 'Envíos con Bihr', description: 'Pedidos enviados a Bihr, enviados por Bihr e incidencias', urgent: false },
  { key: 'chat', label: 'Chat con clientes', description: 'Clientes que piden hablar con un asesor y sus mensajes', urgent: true },
  { key: 'contact', label: 'Mensajes de contacto', description: 'Consultas desde el formulario de la web', urgent: true },
  { key: 'warranty', label: 'Garantías', description: 'Nuevas solicitudes de garantía', urgent: true },
  { key: 'review', label: 'Reseñas', description: 'Opiniones nuevas de productos', urgent: false },
  { key: 'abandoned_cart', label: 'Carritos abandonados', description: 'Clientes que dejan productos sin comprar', urgent: false },
  { key: 'new_user', label: 'Clientes', description: 'Altas y bajas de cuentas', urgent: false },
  { key: 'system', label: 'Sistema', description: 'Sincronizaciones con Bihr y correos que no se han podido enviar', urgent: false },
  { key: 'daily_summary', label: 'Resumen diario', description: 'Ventas, reembolsos y pendientes del día a las 21:00', urgent: false },
] as const;

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number]['key'];
export type NotificationPreferences = Record<NotificationCategory, boolean>;

export const DEFAULT_PREFERENCES = Object.fromEntries(
  NOTIFICATION_CATEGORIES.map((c) => [c.key, true]),
) as NotificationPreferences;

/** Asegura la tabla push_subscriptions (heredada; el historial va por migración). */
export async function initPushTable() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INT,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        preferences JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb;
    `);
  } catch (err) {
    console.error('[PUSH TABLE INIT ERROR]:', err);
  }
}

initPushTable();

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** Guarda o actualiza la suscripción de un administrador. */
export async function saveSubscription(userId: number | null, sub: PushSubscriptionPayload) {
  if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('Suscripción inválida');
  }
  if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Suscripción inválida');

  await db.execute(sql`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (${userId}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})
    ON CONFLICT (endpoint)
    DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth;
  `);
}

export async function removeSubscription(endpoint: string) {
  await db.execute(sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`);
}

export async function updatePreferences(endpoint: string, prefs: Partial<NotificationPreferences>) {
  // Solo se guardan claves conocidas y valores booleanos.
  const clean: Record<string, boolean> = {};
  for (const c of NOTIFICATION_CATEGORIES) {
    if (typeof (prefs as any)?.[c.key] === 'boolean') clean[c.key] = (prefs as any)[c.key];
  }
  await db.execute(sql`
    UPDATE push_subscriptions
    SET preferences = COALESCE(preferences, '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb
    WHERE endpoint = ${endpoint};
  `);
}

export async function getSubscriptionPreferences(endpoint: string): Promise<NotificationPreferences> {
  const res = await db.execute(sql`SELECT preferences FROM push_subscriptions WHERE endpoint = ${endpoint}`);
  const row = res.rows[0] as any;
  return { ...DEFAULT_PREFERENCES, ...(row?.preferences || {}) };
}

/** Enlace del panel: pestaña y, si hay, pedido a abrir. */
export function adminUrl(tab: string, params: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  return `/?${q.toString()}`;
}

export interface AdminNotification {
  title: string;
  body: string;
  url?: string;
  category?: NotificationCategory;
  data?: Record<string, unknown>;
  /** Agrupa avisos del mismo asunto en el móvil (el nuevo sustituye al anterior). */
  tag?: string;
}

/**
 * Guarda el aviso en el historial y lo envía a los móviles de los
 * administradores que tengan su categoría activada. Nunca lanza.
 */
export async function sendNotificationToAll(payload: AdminNotification) {
  const category: NotificationCategory = payload.category || 'system';
  const url = payload.url || adminUrl('notifications');
  let historyId: number | null = null;
  try {
    const ins = await pool.query(
      `INSERT INTO admin_notifications (category, title, body, url, data) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [category, payload.title.slice(0, 200), payload.body.slice(0, 1000), url, JSON.stringify(payload.data || {})]);
    historyId = ins.rows[0]?.id ?? null;
  } catch (err: any) {
    console.error('[PUSH HISTORY ERROR]:', err.message);
  }

  try {
    // Solo suscripciones de administradores.
    const res = await pool.query(
      `SELECT s.endpoint, s.p256dh, s.auth, s.preferences
         FROM push_subscriptions s JOIN users u ON u.id = s.user_id
        WHERE u.role = 'admin'`);
    if (!res.rows.length) return;

    const unread = await unreadCount().catch(() => 0);
    const meta = NOTIFICATION_CATEGORIES.find((c) => c.key === category);
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url,
      tag: payload.tag || `${category}-${historyId ?? Date.now()}`,
      category,
      badgeCount: unread,
      data: { ...(payload.data || {}), notificationId: historyId },
    });

    await Promise.all(res.rows.map(async (sub: any) => {
      if (sub.preferences && sub.preferences[category] === false) return;
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { TTL: 24 * 3600, urgency: meta?.urgent ? 'high' : 'normal' },
        );
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log(`[PUSH] Suscripción caducada eliminada: ${sub.endpoint.slice(0, 40)}…`);
          await removeSubscription(sub.endpoint);
        } else {
          console.error('[PUSH SEND ERROR]:', err.statusCode || '', err.body || err.message);
        }
      }
    }));
  } catch (err: any) {
    console.error('[PUSH BROADCAST ERROR]:', err.message);
  }
}

/**
 * Notificación a los dispositivos de un cliente (p. ej. «te hemos respondido en
 * el chat»). No pasa por el historial del panel. Nunca lanza.
 */
export async function sendPushToUser(userId: number, payload: { title: string; body: string; url: string; tag?: string }) {
  try {
    const res = await pool.query(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [userId]);
    const body = JSON.stringify({ ...payload, icon: '/icon-192.png' });
    await Promise.all(res.rows.map(async (sub: any) => {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { TTL: 24 * 3600, urgency: 'high' },
        );
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(sub.endpoint);
        else console.error('[PUSH USER ERROR]:', err.statusCode || '', err.body || err.message);
      }
    }));
    return res.rows.length;
  } catch (err: any) {
    console.error('[PUSH USER ERROR]:', err.message);
    return 0;
  }
}

// ── Historial ────────────────────────────────────────────────────────────

export async function unreadCount(): Promise<number> {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM admin_notifications WHERE read_at IS NULL');
  return r.rows[0]?.n || 0;
}

export async function listNotifications(opts: { limit?: number; before?: number; category?: string; unread?: boolean } = {}) {
  const limit = Math.min(Math.max(opts.limit || 30, 1), 100);
  const where: string[] = [];
  const params: any[] = [];
  if (opts.before) { params.push(opts.before); where.push(`id < $${params.length}`); }
  if (opts.category) { params.push(opts.category); where.push(`category = $${params.length}`); }
  if (opts.unread) where.push('read_at IS NULL');
  params.push(limit);
  const r = await pool.query(
    `SELECT id, category, title, body, url, data, created_at, read_at FROM admin_notifications
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`, params);
  return r.rows;
}

export async function markNotificationsRead(ids: number[] | 'all') {
  if (ids === 'all') {
    await pool.query('UPDATE admin_notifications SET read_at = NOW() WHERE read_at IS NULL');
  } else if (ids.length) {
    await pool.query('UPDATE admin_notifications SET read_at = NOW() WHERE id = ANY($1) AND read_at IS NULL', [ids]);
  }
}

/** Borra avisos de más de 90 días (lo llama el resumen diario). */
export async function pruneNotifications() {
  await pool.query(`DELETE FROM admin_notifications WHERE created_at < NOW() - INTERVAL '90 days'`);
}

// ── Avisos concretos ─────────────────────────────────────────────────────

const eur = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);

export async function notifyNewOrder(order: { id: number; total: number; customerName?: string; productNames?: string }) {
  const customer = order.customerName ? ` · ${order.customerName}` : '';
  await sendNotificationToAll({
    title: `🛒 Nuevo pedido #${order.id} · ${eur(order.total)}`,
    body: `${order.productNames || 'Pedido pagado'}${customer}`,
    url: adminUrl('orders', { order: order.id }),
    category: 'new_order',
    tag: `order-${order.id}`,
    data: { orderId: order.id },
  });
}

export async function notifyFailedPayment(order: { id?: number | null; reason?: string }) {
  await sendNotificationToAll({
    title: `⚠️ Pago fallido${order.id ? ` · pedido #${order.id}` : ''}`,
    body: order.reason ? `Motivo: ${order.reason}` : 'Un intento de pago ha sido rechazado.',
    url: order.id ? adminUrl('orders', { order: order.id }) : adminUrl('orders'),
    category: 'payment_failed',
    tag: order.id ? `order-${order.id}-payment` : undefined,
    data: { orderId: order.id ?? null },
  });
}

export async function notifyAmountMismatch(info: { orderId: number; charged: number; expected: number }) {
  await sendNotificationToAll({
    title: `🚨 Importe distinto · pedido #${info.orderId}`,
    body: `Stripe cobró ${eur(info.charged)} y el pedido es de ${eur(info.expected)}. Revisa el pedido antes de enviarlo.`,
    url: adminUrl('orders', { order: info.orderId }),
    category: 'payment_failed',
    data: { orderId: info.orderId },
  });
}

export async function notifyRefundRequest(info: { orderId: number; amount: number; reason: string; customerName?: string; scope: 'full' | 'partial' }) {
  await sendNotificationToAll({
    title: `↩️ Solicitud de reembolso · pedido #${info.orderId}`,
    body: `${eur(info.amount)} (${info.scope === 'full' ? 'pedido completo' : 'algunos productos'}) · ${info.reason}${info.customerName ? ` · ${info.customerName}` : ''}`,
    url: adminUrl('orders', { order: info.orderId }),
    category: 'refund',
    tag: `order-${info.orderId}-refund`,
    data: { orderId: info.orderId },
  });
}

export async function notifyRefunded(info: { orderId: number; amount: number; full: boolean }) {
  await sendNotificationToAll({
    title: `💸 Reembolso de ${eur(info.amount)} · pedido #${info.orderId}`,
    body: info.full ? 'Pedido reembolsado por completo.' : 'Reembolso parcial realizado.',
    url: adminUrl('orders', { order: info.orderId }),
    category: 'refund',
    tag: `order-${info.orderId}-refund`,
    data: { orderId: info.orderId },
  });
}

export async function notifyAbandonedCart(cart: { id: number; customerName?: string; total: number }) {
  // La web avisa tras 10 min de inactividad y al cerrar sesión: como mucho un
  // aviso por carrito cada 12 horas para no saturar el móvil.
  const cartKey = `${cart.id}:${cart.customerName || ''}`;
  try {
    const recent = await pool.query(
      `SELECT 1 FROM admin_notifications WHERE category = 'abandoned_cart' AND data->>'cartKey' = $1
         AND created_at > NOW() - INTERVAL '12 hours' LIMIT 1`, [cartKey]);
    if (recent.rows.length) return;
  } catch { /* sin historial: se avisa igualmente */ }
  await sendNotificationToAll({
    title: `🛒 Carrito abandonado · ${eur(cart.total)}`,
    body: `${cart.customerName || 'Un cliente'} ha dejado productos sin comprar.`,
    url: adminUrl('carts'),
    category: 'abandoned_cart',
    tag: `cart-${cart.id}`,
    data: { cartId: cart.id, cartKey },
  });
}

export async function notifyDropshippingStatus(info: { orderId: number; status: string; trackingNumber?: string }) {
  const titles: Record<string, string> = {
    pending_bihr: `📤 Pedido #${info.orderId} enviado a Bihr`,
    shipped: `📦 Bihr ha enviado el pedido #${info.orderId}`,
    cancelled: `⚠️ Bihr ha cancelado el pedido #${info.orderId}`,
  };
  const bodies: Record<string, string> = {
    pending_bihr: 'Esperando a que Bihr lo prepare y envíe.',
    shipped: info.trackingNumber ? `Seguimiento: ${info.trackingNumber}. El cliente ya tiene el correo.` : 'Ya está en camino.',
    cancelled: 'Revisa el pedido: hay que buscar alternativa o reembolsar.',
  };
  await sendNotificationToAll({
    title: titles[info.status] || `⚠️ Incidencia Bihr · pedido #${info.orderId}`,
    body: bodies[info.status] || `Estado: ${info.status}`,
    url: adminUrl('orders', { order: info.orderId }),
    category: 'dropshipping_status',
    tag: `order-${info.orderId}-bihr`,
    data: { orderId: info.orderId },
  });
}

export async function notifyNewUser(user: { name: string; email: string }) {
  await sendNotificationToAll({
    title: '👤 Nuevo cliente registrado',
    body: `${user.name} (${user.email})`,
    url: adminUrl('users'),
    category: 'new_user',
  });
}

/**
 * Aviso del chat con asesor. Los administradores reciben todos (historial y
 * móvil); de los asesores, el que atiende la conversación o, si nadie la
 * atiende aún, los que están conectados.
 */
export async function notifyLiveChat(info: { conversationId: number; title: string; body: string; agentUserId?: number | null }) {
  const url = adminUrl('chat', { chat: info.conversationId });
  await sendNotificationToAll({
    title: info.title,
    body: info.body,
    url,
    category: 'chat',
    tag: `chat-${info.conversationId}`,
    data: { conversationId: info.conversationId },
  });
  try {
    const { rows } = info.agentUserId
      ? await pool.query(`SELECT id FROM users WHERE id = $1 AND role = 'asesor'`, [info.agentUserId])
      // Conversación nueva: a los asesores conectados y libres (un chat a la vez).
      : await pool.query(
        `SELECT u.id FROM users u JOIN chat_agents a ON a.user_id = u.id
         WHERE u.role = 'asesor' AND a.online AND NOT a.paused
           AND NOT EXISTS (SELECT 1 FROM chat_conversations c WHERE c.agent_user_id = u.id AND c.status <> 'closed')`);
    await Promise.all(rows.map((r: any) => sendPushToUser(r.id, {
      title: info.title, body: info.body, url, tag: `chat-${info.conversationId}`,
    })));
  } catch (err: any) {
    console.error('[PUSH CHAT AGENTS ERROR]:', err.message);
  }
}

export async function notifyContact(msg: { name: string; email: string; subject?: string; message: string }) {
  await sendNotificationToAll({
    title: `✉️ Consulta de ${msg.name}`,
    body: `${msg.subject ? `${msg.subject}: ` : ''}${msg.message.slice(0, 160)}`,
    url: adminUrl('notifications'),
    category: 'contact',
    data: { email: msg.email },
  });
}

export async function notifyWarranty(w: { buyerName: string; invoiceNumber: string; products: number }) {
  await sendNotificationToAll({
    title: `🛠️ Solicitud de garantía · ${w.invoiceNumber}`,
    body: `${w.buyerName} · ${w.products} producto${w.products === 1 ? '' : 's'}. Detalles en garantiasydevoluciones@.`,
    url: adminUrl('notifications'),
    category: 'warranty',
  });
}

export async function notifyReview(r: { productName: string; rating: number; title?: string | null }) {
  await sendNotificationToAll({
    title: `⭐ Reseña nueva · ${'★'.repeat(Math.max(1, Math.min(5, r.rating)))}`,
    body: `${r.productName}${r.title ? ` · «${r.title}»` : ''}`,
    url: adminUrl('reviews'),
    category: 'review',
  });
}

export async function notifySystem(title: string, body: string, data: Record<string, unknown> = {}, tab = 'sync') {
  await sendNotificationToAll({ title, body, url: adminUrl(tab), category: 'system', data });
}

export async function notifyDailySummary(s: {
  sales: number; orders: number; refunds: number; pendingRefunds: number; abandoned: number; newUsers: number;
}) {
  const parts = [
    `${s.orders} pedido${s.orders === 1 ? '' : 's'} · ${eur(s.sales)}`,
    s.refunds > 0 ? `reembolsos ${eur(s.refunds)}` : '',
    s.pendingRefunds > 0 ? `${s.pendingRefunds} reembolso${s.pendingRefunds === 1 ? '' : 's'} por revisar` : '',
    s.abandoned > 0 ? `${s.abandoned} carrito${s.abandoned === 1 ? '' : 's'} abandonado${s.abandoned === 1 ? '' : 's'}` : '',
    s.newUsers > 0 ? `${s.newUsers} cliente${s.newUsers === 1 ? '' : 's'} nuevo${s.newUsers === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  await sendNotificationToAll({
    title: '📈 Resumen del día',
    body: parts.join(' · '),
    url: adminUrl('stats'),
    category: 'daily_summary',
    tag: 'daily-summary',
  });
}
