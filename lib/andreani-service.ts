/**
 * Servicio de sincronización de stock y gestión de sesión B2B de Andreani MHS.
 *
 * Funcionalidades:
 * 1. Consulta en tiempo real de stock físico en el almacén de Andreani mediante
 *    el endpoint B2B de compra rápida (/module/megaquickorder/actions).
 * 2. Gestión y almacenamiento seguro de la sesión (cookie PrestaShop + Cloudflare)
 *    en la tabla app_settings de la base de datos (clave 'andreani_session').
 * 3. Alertas automáticas:
 *    - Notificación Web Push a administradores cuando falten < 24h para que la cookie expire.
 *    - Correo electrónico a info@escapesymas.com con plantilla interna oficial.
 *    - Control de frecuencia (máximo 1 aviso cada 12h) para no saturar.
 */

import { pool } from '../db.js';
import { sendEmail } from './email.js';
import { renderEmail } from './email-templates.js';
import { notifySystem } from '../pushService.js';

export interface AndreaniSessionData {
  cookie: string;
  userAgent: string;
  expiresAt: string; // ISO String
  lastRemindedAt?: string | null;
  lastCheckedAt?: string | null;
  lastCheckStatus?: string | null;
}

export interface AndreaniStockItem {
  reference: string;
  name?: string;
  quantity: number;
  quantityAvailable?: number;
  inStock: boolean;
  priceTaxExc?: number;
  priceAmount?: number;
  allowOosp?: boolean;
}

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const ANDREANI_API_URL = 'https://andreanimhs.com/module/megaquickorder/actions';
const CRON_CHECK_INTERVAL_MS = 30 * 60 * 1000; // Cada 30 minutos

/**
 * Obtiene la sesión actual de Andreani desde app_settings (o fallback a variables de entorno).
 */
export async function getAndreaniSession(): Promise<AndreaniSessionData | null> {
  try {
    const res = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'andreani_session' LIMIT 1"
    );
    if (res.rows.length > 0 && res.rows[0].value) {
      const val = res.rows[0].value;
      return {
        cookie: String(val.cookie || ''),
        userAgent: String(val.userAgent || DEFAULT_UA),
        expiresAt: String(val.expiresAt || ''),
        lastRemindedAt: val.lastRemindedAt ? String(val.lastRemindedAt) : null,
        lastCheckedAt: val.lastCheckedAt ? String(val.lastCheckedAt) : null,
        lastCheckStatus: val.lastCheckStatus ? String(val.lastCheckStatus) : null,
      };
    }
  } catch (err: any) {
    console.error('[ANDREANI SERVICE] Error al leer app_settings:', err?.message || err);
  }

  // Fallback a variables de entorno si no estuviera en BD
  if (process.env.ANDREANI_COOKIE) {
    return {
      cookie: process.env.ANDREANI_COOKIE,
      userAgent: process.env.ANDREANI_USER_AGENT || DEFAULT_UA,
      expiresAt: process.env.ANDREANI_COOKIE_EXPIRES_AT || new Date(Date.now() + 10 * 86400000).toISOString(),
      lastRemindedAt: null,
    };
  }

  return null;
}

/**
 * Guarda o actualiza la sesión en app_settings de forma persistente e idempotente.
 */
export async function saveAndreaniSession(
  data: Partial<AndreaniSessionData> & { cookie: string; expiresAt: string }
): Promise<AndreaniSessionData> {
  const current = (await getAndreaniSession()) || {
    cookie: '',
    userAgent: DEFAULT_UA,
    expiresAt: '',
  };

  const updated: AndreaniSessionData = {
    cookie: data.cookie.trim(),
    userAgent: (data.userAgent || current.userAgent || DEFAULT_UA).trim(),
    expiresAt: data.expiresAt.trim(),
    lastRemindedAt: data.lastRemindedAt !== undefined ? data.lastRemindedAt : current.lastRemindedAt,
    lastCheckedAt: data.lastCheckedAt !== undefined ? data.lastCheckedAt : current.lastCheckedAt,
    lastCheckStatus: data.lastCheckStatus !== undefined ? data.lastCheckStatus : current.lastCheckStatus,
  };

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('andreani_session', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = NOW()`,
    [JSON.stringify(updated)]
  );

  return updated;
}

/**
 * Consulta el stock real de una referencia en el endpoint B2B de Andreani MHS.
 */
export async function getLiveAndreaniStock(reference: string): Promise<AndreaniStockItem | null> {
  const cleanRef = reference.replace(/^AND-/, '').trim();
  if (!cleanRef) return null;

  const session = await getAndreaniSession();
  if (!session || !session.cookie) {
    console.warn('[ANDREANI SERVICE] No hay cookie de sesión configurada para Andreani MHS');
    return null;
  }

  try {
    const bodyParams = new URLSearchParams({
      ajax: '1',
      action: 'search',
      search: cleanRef,
    });

    const res = await fetch(ANDREANI_API_URL, {
      method: 'POST',
      headers: {
        'User-Agent': session.userAgent || DEFAULT_UA,
        'Cookie': session.cookie,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://andreanimhs.com',
        'Referer': 'https://andreanimhs.com/module/megaquickorder/form',
      },
      body: bodyParams.toString(),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[ANDREANI SERVICE] Petición fallida para ${cleanRef}: HTTP ${res.status}`);
      return null;
    }

    const data: any = await res.json();
    if (!data || !data.result || !Array.isArray(data.list) || data.list.length === 0) {
      return null;
    }

    // Buscamos coincidencia exacta de referencia (o la primera si solo hay 1)
    const exact =
      data.list.find((item: any) => String(item.reference).trim().toUpperCase() === cleanRef.toUpperCase()) ||
      data.list[0];

    const qty = Number(exact.quantity || 0);
    const item: AndreaniStockItem = {
      reference: exact.reference,
      name: exact.name,
      quantity: qty,
      quantityAvailable: Number(exact.quantity_available ?? qty),
      inStock: qty > 0,
      priceTaxExc: exact.price_tax_exc ? Number(exact.price_tax_exc) : undefined,
      priceAmount: exact.price_amount ? Number(exact.price_amount) : undefined,
      allowOosp: exact.allow_oosp === 1 || exact.allow_oosp === '1',
    };

    // Actualizamos el stock en la base de datos de forma asíncrona
    pool.query(
      `UPDATE products
       SET stock = $1, updated_at = NOW()
       WHERE provider_id = 'andreani' AND (part_number = $2 OR sku = $3)`,
      [qty, exact.reference, `AND-${exact.reference}`]
    ).catch(() => {});

    return item;
  } catch (err: any) {
    console.error(`[ANDREANI SERVICE] Error al consultar stock de ${cleanRef}:`, err?.message || err);
    return null;
  }
}

/**
 * Comprueba si la cookie está a menos de 24 horas de caducar y, de ser así,
 * envía notificación push y correo electrónico a info@escapesymas.com.
 */
export async function checkAndNotifyCookieExpiry(force = false): Promise<{
  isExpiringSoon: boolean;
  hoursRemaining: number;
  notified: boolean;
  expiresAt: string | null;
}> {
  const session = await getAndreaniSession();
  if (!session || !session.expiresAt) {
    return { isExpiringSoon: false, hoursRemaining: 9999, notified: false, expiresAt: null };
  }

  const expiresTime = new Date(session.expiresAt).getTime();
  if (isNaN(expiresTime)) {
    return { isExpiringSoon: false, hoursRemaining: 9999, notified: false, expiresAt: null };
  }

  const now = Date.now();
  const msRemaining = expiresTime - now;
  const hoursRemaining = Math.max(0, Math.round((msRemaining / (3600 * 1000)) * 10) / 10);
  const isExpiringSoon = msRemaining <= 24 * 3600 * 1000; // Menos de 24 horas

  if (!isExpiringSoon && !force) {
    return { isExpiringSoon, hoursRemaining, notified: false, expiresAt: session.expiresAt };
  }

  // Comprobar si ya se avisó en las últimas 12 horas para no saturar
  const lastRemindedTime = session.lastRemindedAt ? new Date(session.lastRemindedAt).getTime() : 0;
  const hoursSinceLastReminder = (now - lastRemindedTime) / (3600 * 1000);
  if (!force && hoursSinceLastReminder < 12) {
    return { isExpiringSoon, hoursRemaining, notified: false, expiresAt: session.expiresAt };
  }

  const fechaFormateada = new Date(expiresTime).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const title = `⚠️ Sesión de Andreani por expirar (${hoursRemaining}h)`;
  const body = `La cookie de sesión de Andreani MHS expira el ${fechaFormateada}. Inicia sesión en el navegador para mantener sincronizados los stocks.`;

  // 1. Notificación Web Push a administradores
  await notifySystem(
    title,
    body,
    { supplier: 'andreani', hoursRemaining, expiresAt: session.expiresAt },
    'sync'
  ).catch((e) => console.error('[ANDREANI NOTIFY] Error en push:', e?.message || e));

  // 2. Correo electrónico a info@escapesymas.com
  const rendered = renderEmail('internal', {
    subject: `⚠️ Recordatorio: Renovar sesión de Andreani MHS (expira en ${hoursRemaining}h)`,
    title: 'Renovación de sesión Andreani MHS',
    facts: [
      ['Proveedor', 'Andreani MHS B2B'],
      ['Tiempo restante', `${hoursRemaining} horas`],
      ['Fecha estimada de expiración', `${fechaFormateada} (Madrid)`],
      ['Impacto', 'Consulta de stock en tiempo real y precios distribuidores'],
    ],
    message:
      'La cookie de sesión de Andreani MHS caducará en menos de 24 horas.\n\n' +
      'Para renovarla:\n' +
      '1. Abre la web de Andreani MHS en el navegador donde tengas sesión iniciada (o inicia sesión con info@escapesymas.com).\n' +
      '2. La sesión se refrescará automáticamente con otros 10 días de validez.\n\n' +
      'Puedes comprobar el estado o actualizar la cookie en cualquier momento desde el Master Panel.',
  });

  await sendEmail({
    to: 'info@escapesymas.com',
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  }).catch((e) => console.error('[ANDREANI NOTIFY] Error al enviar email:', e?.message || e));

  // Actualizar lastRemindedAt en BD
  await pool.query(
    `UPDATE app_settings
     SET value = jsonb_set(value, '{lastRemindedAt}', $1::jsonb),
         updated_at = NOW()
     WHERE key = 'andreani_session'`,
    [JSON.stringify(new Date().toISOString())]
  );

  console.log(`[ANDREANI SERVICE] Recordatorio de expiración enviado (restan ${hoursRemaining}h)`);
  return { isExpiringSoon, hoursRemaining, notified: true, expiresAt: session.expiresAt };
}

let cronHandle: NodeJS.Timeout | null = null;

/**
 * Arranca el cron en segundo plano que revisa la expiración cada 30 minutos.
 */
export function startAndreaniStockCron(): void {
  if (cronHandle) return;

  // Comprobación inicial a los 10 segundos de arrancar
  setTimeout(() => {
    checkAndNotifyCookieExpiry().catch((e) =>
      console.error('[ANDREANI CRON] Error en comprobación inicial:', e)
    );
  }, 10_000);

  cronHandle = setInterval(() => {
    checkAndNotifyCookieExpiry().catch((e) =>
      console.error('[ANDREANI CRON] Error en intervalo:', e)
    );
  }, CRON_CHECK_INTERVAL_MS);

  console.log('[ANDREANI CRON] Cron de sesión y stock registrado (cada 30 min)');
}

export function stopAndreaniStockCron(): void {
  if (cronHandle) {
    clearInterval(cronHandle);
    cronHandle = null;
  }
}
