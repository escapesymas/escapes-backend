import {
  BRAND, C, button, eur, fallbackLink, greeting, heading, highlight, itemsTable, note, p, shell, totalsTable,
  type EmailItem,
} from '../lib/email-templates.js';

interface AbandonedCartRow {
  id: number;
  user_email: string;
  cart_snapshot: any[];
  cart_total_cents: number;
  discount_cents: number;
  emails_sent: number;
  last_activity_at: Date;
  recovery_token: string;
}

/** Validez del cupón de cada recordatorio, en horas (se muestra en el correo). */
export const ABANDONED_COUPON_HOURS: Record<2 | 3, number> = { 2: 7 * 24, 3: 48 };

/**
 * Recordatorio de carrito abandonado (1 h, 24 h y 72 h).
 *
 * Los recordatorios 2 y 3 llevan un cupón real de un solo uso (`couponCode`),
 * creado en la tabla coupons: se aplica solo al volver al carrito desde el
 * enlace y también se puede escribir a mano en el checkout.
 */
export function renderAbandonedCartEmail(
  cart: AbandonedCartRow,
  options: {
    siteUrl: string;
    locale?: string;
    stage: 1 | 2 | 3;
    couponCode?: string | null;
    discountPct?: number;
    customerName?: string;
    /** Enlace alternativo (el envío manual desde el admin usa el carrito de sesión). */
    recoveryUrl?: string;
  }
): { subject: string; html: string; text: string } {
  const siteUrl = options.siteUrl.replace(/\/$/, '');
  const recoveryUrl = options.recoveryUrl || `${siteUrl}/checkout?recover=${cart.recovery_token}`;
  const coupon = options.stage > 1 && options.couponCode ? options.couponCode : null;
  const pct = coupon ? (options.discountPct || 0) : 0;
  const hours = options.stage === 3 ? ABANDONED_COUPON_HOURS[3] : ABANDONED_COUPON_HOURS[2];
  const validity = hours >= 48 && hours % 24 === 0 ? `${hours / 24} días` : `${hours} horas`;

  const subject =
    !coupon ? `¿Se te olvidó algo? Tu carrito te espera · ${BRAND}`
    : options.stage === 2 ? `Un ${pct}% de descuento para completar tu compra · ${BRAND}`
    : `Última oportunidad: ${pct}% de descuento en tu carrito · ${BRAND}`;

  const snapshot = Array.isArray(cart.cart_snapshot) ? cart.cart_snapshot : [];
  const items: EmailItem[] = snapshot.slice(0, 6).map((item: any) => {
    let priceNum = 0;
    if (typeof item.price === 'number') priceNum = item.price;
    else if (typeof item.price === 'string') priceNum = parseFloat(item.price) || 0;
    else if (typeof item.price_cents === 'number') priceNum = item.price_cents / 100;
    const qty = parseInt(item.quantity) || 1;
    // El snapshot guarda unas veces euros y otras céntimos: se elige la lectura
    // que cuadra con el total del carrito.
    if (priceNum > 0 && Math.abs((priceNum * qty) - (cart.cart_total_cents / 100)) > Math.abs(((priceNum / 100) * qty) - (cart.cart_total_cents / 100)) + 0.05) {
      priceNum = priceNum / 100;
    }
    const slug = item.slug || item.id || '';
    return {
      name: String(item.title || item.name || 'Producto'),
      quantity: qty,
      priceCents: Math.round(priceNum * 100),
      image: item.image || item.src || '',
      url: slug ? `${siteUrl}/producto/${slug}` : '',
    };
  });
  const more = snapshot.length - items.length;

  const intro = !coupon
    ? 'Hemos guardado los productos que añadiste. Vuelve cuando quieras para completar tu compra antes de que se agoten.'
    : options.stage === 2
      ? `Como vemos que te interesan, te regalamos un <strong style="color:${C.text}">${pct}% de descuento</strong> para completar tu compra.`
      : `Tu carrito sigue esperándote y tu descuento del <strong style="color:${C.text}">${pct}%</strong> está a punto de caducar.`;

  const html = shell(`
    ${heading(!coupon ? 'Has dejado productos en tu carrito' : options.stage === 2 ? 'Te guardamos un descuento' : 'Última oportunidad')}
    ${greeting(options.customerName)}
    ${p(intro)}
    ${coupon ? highlight(`Tu cupón · ${pct}% de descuento`, coupon) : ''}
    ${itemsTable(items)}
    ${more > 0 ? note(`Y ${more} producto${more === 1 ? '' : 's'} más en tu carrito.`) : ''}
    ${totalsTable([], { label: 'Total del carrito', value: eur(cart.cart_total_cents) })}
    ${button(recoveryUrl, coupon ? 'Usar mi descuento' : 'Recuperar mi carrito')}
    ${coupon ? note(`El cupón se aplica solo al volver a tu carrito con este botón (o escríbelo en el checkout). Válido ${validity}, un solo uso. No se acumula sobre productos que ya están en promoción.`) : ''}
    ${fallbackLink(recoveryUrl)}
    ${note('Si no quieres recibir más recordatorios, ignora este correo: no te enviaremos más de tres.')}
  `, coupon ? `Cupón ${coupon}: ${pct}% de descuento en tu carrito.` : 'Hemos guardado los productos de tu carrito.');

  const text = `Hola${options.customerName ? ` ${options.customerName}` : ''},

${!coupon ? 'Has dejado productos en tu carrito en Escapes y Más.' : `Te regalamos un ${pct}% de descuento para completar tu compra. Tu cupón: ${coupon} (válido ${validity}, un solo uso).`}

${items.map((i) => `- ${i.quantity} × ${i.name}: ${eur(i.priceCents * i.quantity)}`).join('\n')}
Total del carrito: ${eur(cart.cart_total_cents)}

Recupera tu carrito aquí: ${recoveryUrl}

El equipo de ${BRAND}
${siteUrl}`;

  return { subject, html, text };
}
