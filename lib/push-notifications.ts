import { db, sql } from '../index.js';

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: 'default' | null;
  badge?: number;
}

/**
 * Envia una notificación push a todos los dispositivos iOS registrados del administrador.
 */
export async function sendAdminPushNotification(payload: PushNotificationPayload): Promise<void> {
  try {
    const tokensRes = await db.execute(sql`SELECT token FROM admin_push_tokens`);
    if (!tokensRes.rows || tokensRes.rows.length === 0) {
      console.log('[PUSH] No hay dispositivos de administrador registrados.');
      return;
    }

    const messages = tokensRes.rows.map((row: any) => ({
      to: row.token,
      sound: payload.sound || 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      badge: payload.badge || 1,
      _displayInForeground: true
    }));

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const resData = await response.json();
    console.log('[PUSH] Resultado del envío:', JSON.stringify(resData));
  } catch (error) {
    console.error('[PUSH ERROR] Error enviando notificación push:', error);
  }
}
