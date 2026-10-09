/**
 * TikTok Events API: envía la compra desde el servidor (además del píxel del
 * navegador) para que TikTok la cuente aunque el navegador bloquee el píxel.
 *
 * - Solo se envía si el comprador aceptó las cookies de marketing (lo indica
 *   la web en /api/orders/finalize).
 * - Email y teléfono van cifrados con SHA-256, nunca en claro.
 * - event_id = order_<id>, el mismo que usa el píxel: TikTok descarta el duplicado.
 *
 * Variables: TIKTOK_EVENTS_TOKEN (sin ella no se envía nada) y TIKTOK_PIXEL_ID.
 */
import crypto from 'crypto';

const PIXEL_ID = process.env.TIKTOK_PIXEL_ID || 'DB4IV33C77U89E740R6G';
const TOKEN = process.env.TIKTOK_EVENTS_TOKEN || '';
const ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const SITE = 'https://escapesymas.com';

export const TIKTOK_EVENTS_ENABLED = Boolean(TOKEN);

/** Pedidos ya enviados en este proceso (finalize puede llamarse varias veces). */
const sent = new Set<string>();

export interface TikTokBrowserContext {
  marketing?: boolean;
  ttp?: string;
  ttclid?: string;
  url?: string;
}

export interface TikTokPurchase {
  orderId: number;
  totalCents: number;
  email?: string | null;
  phone?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  items: { id: number; name: string; quantity: number; priceCents: number }[];
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Teléfono en formato internacional (+34…) como pide TikTok. */
export function normalizePhone(phone?: string | null): string {
  if (!phone) return '';
  let p = String(phone).replace(/[^\d+]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  if (/^[6789]\d{8}$/.test(p)) p = `+34${p}`;
  return /^\+\d{8,15}$/.test(p) ? p : '';
}

/** Valida lo que manda el navegador: solo valores cortos y la URL de la tienda. */
export function parseBrowserContext(raw: unknown): TikTokBrowserContext {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const url = str(r.url, 500);
  return {
    marketing: r.marketing === true,
    ttp: str(r.ttp, 200),
    ttclid: str(r.ttclid, 300),
    url: url.startsWith(`${SITE}/`) || url === SITE ? url : '',
  };
}

export async function sendTikTokPurchase(order: TikTokPurchase, ctx: TikTokBrowserContext): Promise<void> {
  if (!TIKTOK_EVENTS_ENABLED || !ctx.marketing) return;
  const eventId = `order_${order.orderId}`;
  if (sent.has(eventId)) return;
  sent.add(eventId);

  const user: Record<string, string> = {};
  if (order.email) user.email = sha256(order.email.trim().toLowerCase());
  const phone = normalizePhone(order.phone);
  if (phone) user.phone = sha256(phone);
  if (order.ip) user.ip = order.ip;
  if (order.userAgent) user.user_agent = order.userAgent.slice(0, 500);
  if (ctx.ttp) user.ttp = ctx.ttp;
  if (ctx.ttclid) user.ttclid = ctx.ttclid;

  const body = {
    event_source: 'web',
    event_source_id: PIXEL_ID,
    data: [{
      event: 'CompletePayment',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      user,
      page: { url: ctx.url || `${SITE}/checkout/success` },
      properties: {
        currency: 'EUR',
        value: Math.round(order.totalCents) / 100,
        content_type: 'product',
        contents: order.items.map((it) => ({
          content_id: String(it.id),
          content_name: it.name,
          quantity: it.quantity,
          price: Math.round(it.priceCents) / 100,
        })),
      },
    }],
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Access-Token': TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.code !== 0) {
      sent.delete(eventId);
      console.warn(`[TIKTOK EVENTS] Pedido ${order.orderId}: ${res.status} ${json.code ?? ''} ${json.message ?? ''}`);
    } else {
      console.log(`[TIKTOK EVENTS] Compra del pedido ${order.orderId} enviada`);
    }
  } catch (err: any) {
    sent.delete(eventId);
    console.warn(`[TIKTOK EVENTS] Pedido ${order.orderId}: ${err?.message || err}`);
  }
}
