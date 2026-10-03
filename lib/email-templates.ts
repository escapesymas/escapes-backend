/**
 * Plantillas de correo.
 *
 * Cada plantilla es una función tipada que recibe sus datos y devuelve
 * { subject, text, html } para el módulo de envío (lib/email.ts).
 *
 * Diseño: el mismo que la web en tema claro — fondo #f8fafc, tarjeta blanca
 * con borde #e2e8f0, titulares en monoespaciada mayúscula, acento amarillo y
 * botones amarillos con texto oscuro. El logo es un PNG (Gmail y Outlook no
 * muestran SVG). Todo el HTML va con estilos en línea y maquetado con tablas
 * para que se vea igual en Gmail, Outlook, Apple Mail y apps móviles.
 *
 * Plantillas:
 *   - verify-email          confirmación de email al registrarse
 *   - order-confirmation    pedido pagado (con líneas y factura adjunta)
 *   - order-shipped         pedido enviado con seguimiento
 *   - order-cancelled       pedido cancelado
 *   - order-note            nota del equipo sobre un pedido
 *   - payment-link          pedido manual pendiente de pago
 *   - warranty-received     acuse de una solicitud de garantía
 *   - warranty              cambio de estado de una garantía
 *   - contact-reply         respuesta a una consulta
 *   - generic               texto libre con botón opcional
 *   - internal              avisos internos (contacto, garantías)
 *   - refund-request-received / refund-processed / refund-rejected  reembolsos
 * El carrito abandonado está en templates/abandoned-cart.ts y usa estas piezas.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export const BRAND = 'Escapes y Más';
export const BRAND_URL = (process.env.PUBLIC_BASE_URL || 'https://escapesymas.com').replace(/\/$/, '');
const SUPPORT_EMAIL = 'info@escapesymas.com';

/** Colores del tema claro de la web (src/app/globals.css). */
export const C = {
  page: '#f8fafc',
  card: '#ffffff',
  border: '#e2e8f0',
  soft: '#f1f5f9',
  text: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  accent: '#eab308',
  accentText: '#a16207',
  ok: '#15803d',
  okBg: '#f0fdf4',
  okBorder: '#bbf7d0',
};

export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const MONO = "'Courier New',Courier,ui-monospace,monospace";

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Importe en céntimos con formato español: 1.234,50 €. */
export function eur(cents: number | string): string {
  const n = (typeof cents === 'string' ? parseFloat(cents) : cents) || 0;
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n / 100);
}

/** URL absoluta para imágenes y enlaces que vienen como ruta relativa. */
export function absUrl(u: string | undefined | null): string {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return `${BRAND_URL}${u.startsWith('/') ? '' : '/'}${u}`;
}

/**
 * Número de pedido visible, el mismo que muestra la web en "Mi cuenta":
 * MMYYYYDD + id con 6 cifras. Usa la fecha de creación del pedido; sin ella
 * el número cambiaría según el día en que se envía el correo.
 */
export function formatOrderNumber(orderId: number | string | null | undefined, dateInput?: Date | string | null): string {
  if (orderId === null || orderId === undefined || orderId === '') return '';
  const strId = String(orderId).trim();
  if (/^\d{14}$/.test(strId)) return strId;

  const cleanId = strId.replace(/\D/g, '');
  const idNum = parseInt(cleanId || '0', 10);
  const paddedId = String(idNum).padStart(6, '0');

  const d = dateInput ? new Date(dateInput) : new Date();
  const validDate = isNaN(d.getTime()) ? new Date() : d;

  const mm = String(validDate.getMonth() + 1).padStart(2, '0');
  const yyyy = String(validDate.getFullYear());
  const dd = String(validDate.getDate()).padStart(2, '0');

  return `${mm}${yyyy}${dd}${paddedId}`;
}

// ── Piezas de maquetación ────────────────────────────────────────────────

/**
 * Estructura común: barra de acento, logo, contenido y pie.
 * `preheader` es el texto que los clientes muestran junto al asunto.
 */
export function shell(content: string, preheader = ''): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${BRAND}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};color:${C.text};-webkit-text-size-adjust:100%">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${escapeHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>` : ''}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${C.page}" style="background:${C.page}">
    <tr><td align="center" style="padding:32px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.border};border-radius:12px;overflow:hidden">
        <tr><td height="4" bgcolor="${C.accent}" style="height:4px;line-height:4px;font-size:0;background:${C.accent}">&nbsp;</td></tr>
        <tr><td align="center" style="padding:26px 32px 22px;border-bottom:1px solid ${C.border}">
          <a href="${BRAND_URL}" style="text-decoration:none"><img src="${BRAND_URL}/email/logo.png" width="220" alt="${BRAND}" style="display:block;width:220px;max-width:100%;height:auto;border:0"></a>
        </td></tr>
        <tr><td style="padding:32px 32px 28px;font-size:15px;line-height:1.6;color:${C.body}">
          ${content}
        </td></tr>
        <tr><td align="center" bgcolor="${C.page}" style="padding:20px 32px;background:${C.page};border-top:1px solid ${C.border};font-family:${MONO};font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:${C.muted}">
          <a href="${BRAND_URL}" style="color:${C.text};text-decoration:none;font-weight:700">escapesymas.com</a>
          &nbsp;&middot;&nbsp; <a href="${BRAND_URL}/perfil" style="color:${C.muted};text-decoration:none">Mi cuenta</a>
          &nbsp;&middot;&nbsp; <a href="mailto:${SUPPORT_EMAIL}" style="color:${C.muted};text-decoration:none">Soporte</a>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:${C.muted};font-family:${FONT}">¿Dudas? Responde a este correo o escríbenos a <a href="mailto:${SUPPORT_EMAIL}" style="color:${C.muted}">${SUPPORT_EMAIL}</a>.</p>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Titular en el estilo de la web: monoespaciada, mayúsculas y negrita. */
export function heading(text: string): string {
  return `<h1 style="margin:0 0 16px;font-family:${MONO};font-size:22px;line-height:1.25;font-weight:700;letter-spacing:-0.3px;text-transform:uppercase;color:${C.text}">${escapeHtml(text)}</h1>`;
}

export function p(html: string, style = ''): string {
  return `<p style="margin:0 0 14px;line-height:1.6;color:${C.body};${style}">${html}</p>`;
}

export function greeting(name?: string): string {
  return p(`Hola${name ? ` <strong style="color:${C.text}">${escapeHtml(name)}</strong>` : ''},`);
}

/**
 * Botón "a prueba de clientes de correo": el fondo va en la celda y el relleno
 * como borde del enlace, así toda la superficie es clicable también en Outlook,
 * webmails y apps móviles (con padding solo era clicable el texto).
 */
export function button(url: string, label: string): string {
  const href = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:26px auto">
      <tr><td align="center" bgcolor="${C.accent}" style="background:${C.accent};border-radius:8px">
        <a href="${href}" target="_blank" rel="noopener" style="display:inline-block;background:${C.accent};border:solid ${C.accent};border-width:14px 28px;border-radius:8px;color:${C.text};font-family:${MONO};font-size:15px;font-weight:700;letter-spacing:1px;line-height:20px;text-transform:uppercase;text-decoration:none">${escapeHtml(label)}</a>
      </td></tr>
    </table>`;
}

/** Recuadro gris claro; `accent` añade la franja amarilla a la izquierda. */
export function panel(html: string, accent = false): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:18px 0">
      <tr><td bgcolor="${C.page}" style="background:${C.page};border:1px solid ${C.border};${accent ? `border-left:4px solid ${C.accent};` : ''}border-radius:8px;padding:16px 18px;color:${C.body};line-height:1.6">${html}</td></tr>
    </table>`;
}

/** Dato destacado (código de seguimiento, cupón…). */
export function highlight(label: string, value: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:18px 0">
      <tr><td align="center" bgcolor="${C.page}" style="background:${C.page};border:1px dashed ${C.accent};border-radius:8px;padding:16px">
        <div style="font-family:${MONO};font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${C.muted}">${escapeHtml(label)}</div>
        <div style="margin-top:6px;font-family:${MONO};font-size:22px;font-weight:700;letter-spacing:1px;color:${C.text}">${escapeHtml(value)}</div>
      </td></tr>
    </table>`;
}

/** Texto pequeño y gris para notas al pie del contenido. */
export function note(html: string): string {
  return `<p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:${C.muted}">${html}</p>`;
}

/** Enlace de respaldo por si el botón no se puede pulsar. */
export function fallbackLink(url: string): string {
  return note(`Si el botón no funciona, copia este enlace en el navegador:<br><a href="${escapeHtml(url)}" style="color:${C.accentText};word-break:break-all">${escapeHtml(url)}</a>`);
}

export interface EmailItem {
  name: string;
  quantity: number;
  /** Precio unitario en céntimos. */
  priceCents: number;
  image?: string;
  url?: string;
}

/** Tabla de productos con miniatura, cantidad e importe. */
export function itemsTable(items: EmailItem[]): string {
  const rows = items.map((it) => {
    const img = absUrl(it.image);
    const url = it.url ? absUrl(it.url) : '';
    const name = escapeHtml(it.name || 'Producto');
    const nameHtml = url ? `<a href="${escapeHtml(url)}" style="color:${C.text};text-decoration:none">${name}</a>` : name;
    const thumb = img
      ? `<img src="${escapeHtml(img)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:contain;border:1px solid ${C.border};border-radius:6px;background:#ffffff">`
      : '';
    return `<tr>
        <td width="64" style="padding:12px 0;border-bottom:1px solid ${C.border};vertical-align:middle">${url && thumb ? `<a href="${escapeHtml(url)}">${thumb}</a>` : thumb}</td>
        <td style="padding:12px 10px;border-bottom:1px solid ${C.border};vertical-align:middle;font-size:14px;line-height:1.4;font-weight:600;color:${C.text}">
          ${nameHtml}
          <div style="margin-top:3px;font-size:12px;font-weight:400;color:${C.muted}">${it.quantity} × ${eur(it.priceCents)}</div>
        </td>
        <td align="right" style="padding:12px 0;border-bottom:1px solid ${C.border};vertical-align:middle;white-space:nowrap;font-family:${MONO};font-size:14px;font-weight:700;color:${C.text}">${eur(it.priceCents * it.quantity)}</td>
      </tr>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 4px;border-top:1px solid ${C.border}">${rows}</table>`;
}

/** Filas de resumen (subtotal, descuento, envío) y total destacado. */
export function totalsTable(lines: Array<{ label: string; value: string; color?: string; strike?: boolean }>, total: { label: string; value: string }): string {
  const rows = lines.map((l) => `<tr>
      <td style="padding:4px 0;font-size:13px;color:${l.color || C.muted}">${escapeHtml(l.label)}</td>
      <td align="right" style="padding:4px 0;font-size:13px;color:${l.color || C.muted};${l.strike ? 'text-decoration:line-through;' : ''}white-space:nowrap">${escapeHtml(l.value)}</td>
    </tr>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 6px">
      ${rows}
      <tr>
        <td style="padding:10px 0 0;font-family:${MONO};font-size:15px;font-weight:700;text-transform:uppercase;color:${C.text}">${escapeHtml(total.label)}</td>
        <td align="right" style="padding:10px 0 0;font-family:${MONO};font-size:20px;font-weight:700;color:${C.text};white-space:nowrap">${escapeHtml(total.value)}</td>
      </tr>
    </table>`;
}

/** Tabla clave/valor sencilla (datos de un pedido o de una solicitud). */
export function factsTable(rows: Array<[string, string]>): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:12px 0;border-collapse:collapse">
      ${rows.map(([k, v]) => `<tr>
        <td style="padding:7px 12px 7px 0;border-bottom:1px solid ${C.soft};font-size:13px;color:${C.muted};white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>
        <td style="padding:7px 0;border-bottom:1px solid ${C.soft};font-size:14px;color:${C.text};vertical-align:top">${escapeHtml(v)}</td>
      </tr>`).join('')}
    </table>`;
}

const signature = `\n\nEl equipo de ${BRAND}\n${BRAND_URL}`;

// ── Plantillas ───────────────────────────────────────────────────────────

export interface VerifyEmailData {
  name?: string;
  url: string;
}

export function verifyEmail(d: VerifyEmailData): RenderedEmail {
  const subject = `Confirma tu email en ${BRAND}`;
  const text = `Hola${d.name ? ` ${d.name}` : ''},

Gracias por registrarte en ${BRAND}. Para activar tu cuenta, confirma tu email abriendo este enlace:

${d.url}

El enlace caduca en 24 horas. Si no has creado tú esta cuenta, ignora este mensaje.${signature}`;
  const html = shell(`
    ${heading('Confirma tu email')}
    ${greeting(d.name)}
    ${p(`Gracias por registrarte en ${BRAND}. Pulsa el botón para activar tu cuenta:`)}
    ${button(d.url, 'Confirmar mi email')}
    ${fallbackLink(d.url)}
    ${note('El enlace caduca en 24 horas. Si no has creado tú esta cuenta, ignora este mensaje.')}
  `, 'Activa tu cuenta con un clic. El enlace caduca en 24 horas.');
  return { subject, text, html };
}

export interface OrderConfirmationData {
  orderId: number | string;
  orderDate?: Date | string | null;
  customerName?: string;
  /** Total en céntimos. */
  total: number | string;
  subtotal?: number | string;
  discount?: number | string;
  shipping?: number | string;
  invoiceNumber?: string;
  items?: EmailItem[];
}

export function orderConfirmation(d: OrderConfirmationData): RenderedEmail {
  const num = formatOrderNumber(d.orderId, d.orderDate);
  const total = eur(d.total);
  const subject = `Pedido #${num} confirmado · ${BRAND}`;
  const items = d.items || [];
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Tu pedido #${num} por ${total} se ha confirmado correctamente.
${items.length ? `\n${items.map((i) => `- ${i.quantity} × ${i.name}: ${eur(i.priceCents * i.quantity)}`).join('\n')}\n` : ''}${d.invoiceNumber ? `\nFactura: ${d.invoiceNumber} (adjunta en este correo).\n` : ''}
Te enviaremos otro correo con el código de seguimiento cuando el pedido salga del almacén.

Puedes consultar el estado en ${BRAND_URL}/perfil${signature}`;

  const lines: Array<{ label: string; value: string; color?: string }> = [];
  if (d.subtotal != null && Number(d.subtotal) > 0) lines.push({ label: 'Subtotal', value: eur(d.subtotal) });
  if (d.discount != null && Number(d.discount) > 0) lines.push({ label: 'Descuento', value: `−${eur(d.discount)}`, color: C.ok });
  if (d.shipping != null) lines.push({ label: 'Envío', value: Number(d.shipping) > 0 ? eur(d.shipping) : 'Gratis' });

  const html = shell(`
    ${heading('¡Pedido confirmado!')}
    ${greeting(d.customerName)}
    ${p(`Gracias por tu compra. Tu pedido <strong style="color:${C.text}">#${escapeHtml(num)}</strong> se ha confirmado y ya lo estamos preparando.`)}
    ${items.length ? itemsTable(items) : ''}
    ${totalsTable(lines, { label: 'Total', value: total })}
    ${d.invoiceNumber ? panel(`Factura <strong style="color:${C.text}">${escapeHtml(d.invoiceNumber)}</strong> adjunta en este correo.`) : ''}
    ${p('Te enviaremos otro correo con el código de seguimiento cuando el pedido salga del almacén.')}
    ${button(`${BRAND_URL}/perfil`, 'Ver mi pedido')}
  `, `Pedido #${num} · ${total}. Ya lo estamos preparando.`);
  return { subject, text, html };
}

export interface OrderShippedData {
  orderId: number | string;
  orderDate?: Date | string | null;
  customerName?: string;
  trackingNumber: string;
  trackingUrl: string;
  carrier?: string;
}

export function orderShipped(d: OrderShippedData): RenderedEmail {
  const num = formatOrderNumber(d.orderId, d.orderDate);
  const subject = `Tu pedido #${num} está en camino · ${BRAND}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Tu pedido #${num} ha salido de nuestro almacén${d.carrier ? ` con ${d.carrier}` : ''}.

Número de seguimiento: ${d.trackingNumber}
Sigue tu envío: ${d.trackingUrl}${signature}`;

  const html = shell(`
    ${heading('¡Tu pedido está en camino!')}
    ${greeting(d.customerName)}
    ${p(`Tu pedido <strong style="color:${C.text}">#${escapeHtml(num)}</strong> ha salido de nuestro almacén${d.carrier ? ` con <strong style="color:${C.text}">${escapeHtml(d.carrier)}</strong>` : ''}.`)}
    ${highlight('Número de seguimiento', d.trackingNumber)}
    ${button(d.trackingUrl, 'Seguir mi envío')}
    ${note('El seguimiento puede tardar unas horas en mostrar el primer movimiento.')}
  `, `Seguimiento ${d.trackingNumber}`);
  return { subject, text, html };
}

export interface OrderCancelledData {
  orderId: number | string;
  orderDate?: Date | string | null;
  customerName?: string;
  reason?: string;
}

export function orderCancelled(d: OrderCancelledData): RenderedEmail {
  const num = formatOrderNumber(d.orderId, d.orderDate);
  const subject = `Tu pedido #${num} ha sido cancelado · ${BRAND}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Tu pedido #${num} ha sido cancelado.${d.reason ? `\n\nMotivo: ${d.reason}` : ''}

Si es un error o necesitas ayuda, responde a este correo.${signature}`;

  const html = shell(`
    ${heading('Pedido cancelado')}
    ${greeting(d.customerName)}
    ${p(`Tu pedido <strong style="color:${C.text}">#${escapeHtml(num)}</strong> ha sido cancelado.`)}
    ${d.reason ? panel(`<strong style="color:${C.text}">Motivo:</strong> ${escapeHtml(d.reason)}`, true) : ''}
    ${p('Si es un error o necesitas ayuda, responde a este correo y lo revisamos.')}
  `);
  return { subject, text, html };
}

export interface OrderNoteData {
  orderId: number | string;
  orderDate?: Date | string | null;
  customerName?: string;
  note: string;
}

export function orderNote(d: OrderNoteData): RenderedEmail {
  const num = formatOrderNumber(d.orderId, d.orderDate);
  const subject = `Actualización de tu pedido #${num} · ${BRAND}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Hay una actualización sobre tu pedido #${num}:

${d.note}${signature}`;
  const html = shell(`
    ${heading('Novedades de tu pedido')}
    ${greeting(d.customerName)}
    ${p(`Hay una actualización sobre tu pedido <strong style="color:${C.text}">#${escapeHtml(num)}</strong>:`)}
    ${panel(escapeHtml(d.note).replace(/\n/g, '<br>'), true)}
    ${button(`${BRAND_URL}/perfil`, 'Ver mi pedido')}
  `, d.note.slice(0, 90));
  return { subject, text, html };
}

export interface PaymentLinkData {
  orderId: number | string;
  orderDate?: Date | string | null;
  customerName?: string;
  url: string;
  /** Total en céntimos. */
  total?: number | string;
  items?: EmailItem[];
}

export function paymentLink(d: PaymentLinkData): RenderedEmail {
  const num = formatOrderNumber(d.orderId, d.orderDate);
  const items = d.items || [];
  const subject = `Completa el pago de tu pedido #${num} · ${BRAND}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Hemos preparado tu pedido #${num}${d.total ? ` por ${eur(d.total)}` : ''}. Para que lo enviemos, completa el pago en este enlace seguro:

${d.url}${signature}`;
  const html = shell(`
    ${heading('Tu pedido está listo')}
    ${greeting(d.customerName)}
    ${p(`Hemos preparado tu pedido <strong style="color:${C.text}">#${escapeHtml(num)}</strong>. Para que lo enviemos, completa el pago en nuestra pasarela segura.`)}
    ${items.length ? itemsTable(items) : ''}
    ${d.total ? totalsTable([], { label: 'Total', value: eur(d.total) }) : ''}
    ${button(d.url, 'Pagar mi pedido')}
    ${fallbackLink(d.url)}
    ${note('Pago con tarjeta, Bizum o Klarna a través de Stripe.')}
  `, `Pedido #${num}${d.total ? ` · ${eur(d.total)}` : ''}. Completa el pago para que lo enviemos.`);
  return { subject, text, html };
}

export interface WarrantyReceivedData {
  customerName?: string;
  invoiceNumber: string;
  products?: Array<{ name: string; issue?: string }>;
}

export function warrantyReceived(d: WarrantyReceivedData): RenderedEmail {
  const subject = `Hemos recibido tu solicitud de garantía · ${BRAND}`;
  const products = d.products || [];
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Hemos recibido tu solicitud de garantía de la factura ${d.invoiceNumber}.
${products.length ? `\n${products.map((x) => `- ${x.name}${x.issue ? `: ${x.issue}` : ''}`).join('\n')}\n` : ''}
Nuestro equipo la revisará y te contestará lo antes posible. Si tienes más información o fotos, responde a este correo.${signature}`;
  const html = shell(`
    ${heading('Solicitud de garantía recibida')}
    ${greeting(d.customerName)}
    ${p(`Hemos recibido tu solicitud de garantía de la factura <strong style="color:${C.text}">${escapeHtml(d.invoiceNumber)}</strong>.`)}
    ${products.length ? factsTable(products.map((x) => [x.name, x.issue || ''] as [string, string])) : ''}
    ${p('Nuestro equipo la revisará y te contestará lo antes posible. Si tienes más información o fotos, responde a este correo.')}
  `);
  return { subject, text, html };
}

export interface WarrantyData {
  customerName?: string;
  ticketId: number | string;
  status: 'received' | 'in_review' | 'resolved' | 'rejected';
  notes?: string;
}

export function warranty(d: WarrantyData): RenderedEmail {
  const statusLabel: Record<WarrantyData['status'], string> = {
    received: 'recibida',
    in_review: 'en revisión',
    resolved: 'resuelta',
    rejected: 'rechazada',
  };
  const subject = `Garantía #${d.ticketId}: ${statusLabel[d.status]} · ${BRAND}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Tu solicitud de garantía #${d.ticketId} ha cambiado de estado: ${statusLabel[d.status]}.${d.notes ? `\n\nNotas: ${d.notes}` : ''}

Si necesitas más información, responde a este correo indicando el número de solicitud.${signature}`;

  const html = shell(`
    ${heading(`Garantía #${d.ticketId}`)}
    ${greeting(d.customerName)}
    ${p(`Tu solicitud de garantía <strong style="color:${C.text}">#${escapeHtml(d.ticketId)}</strong> ha cambiado de estado: <strong style="color:${C.text}">${statusLabel[d.status]}</strong>.`)}
    ${d.notes ? panel(escapeHtml(d.notes).replace(/\n/g, '<br>'), true) : ''}
    ${p('Si necesitas más información, responde a este correo indicando el número de solicitud.')}
  `);
  return { subject, text, html };
}

export interface ContactReplyData {
  customerName?: string;
  subject: string;
  reply: string;
  originalMessage?: string;
}

export function contactReply(d: ContactReplyData): RenderedEmail {
  const subject = `Re: ${d.subject}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

${d.reply}
${d.originalMessage ? `\n--\nTu mensaje original:\n${d.originalMessage}\n--\n` : ''}${signature}`;

  const html = shell(`
    ${heading(`Re: ${d.subject}`)}
    ${greeting(d.customerName)}
    <div style="line-height:1.6;color:${C.body}">${escapeHtml(d.reply).replace(/\n/g, '<br>')}</div>
    ${d.originalMessage ? panel(`<div style="font-size:12px;color:${C.muted};margin-bottom:6px">Tu mensaje original:</div><div style="color:${C.muted}">${escapeHtml(d.originalMessage).replace(/\n/g, '<br>')}</div>`) : ''}
  `);
  return { subject, text, html };
}

export interface RefundLineData {
  name: string;
  quantity: number;
}

export interface RefundRequestReceivedData {
  orderId: number | string;
  orderDate?: Date | string | null;
  customerName?: string;
  scope: 'full' | 'partial';
  items: RefundLineData[];
  /** Importe estimado en céntimos. */
  amount: number;
  reasonLabel: string;
  reason: string;
}

export function refundRequestReceived(d: RefundRequestReceivedData): RenderedEmail {
  const num = formatOrderNumber(d.orderId, d.orderDate);
  const what = d.scope === 'full' ? 'del pedido completo' : 'de algunos productos';
  const subject = `Hemos recibido tu solicitud de reembolso · Pedido #${num}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Hemos recibido tu solicitud de reembolso ${what} del pedido #${num}.

${d.items.map((i) => `- ${i.quantity} × ${i.name}`).join('\n')}
Importe estimado: ${eur(d.amount)}
Motivo: ${d.reasonLabel}
${d.reason}

La revisaremos y te responderemos en un plazo máximo de 3 días laborables. Si hay que devolver el producto, te indicaremos cómo hacerlo.${signature}`;
  const html = shell(`
    ${heading('Solicitud de reembolso recibida')}
    ${greeting(d.customerName)}
    ${p(`Hemos recibido tu solicitud de reembolso ${what} del pedido <strong style="color:${C.text}">#${escapeHtml(num)}</strong>.`)}
    ${factsTable([
      ...d.items.map((i) => [i.name, `${i.quantity} ud.`] as [string, string]),
      ['Importe estimado', eur(d.amount)],
      ['Motivo', d.reasonLabel],
    ])}
    ${panel(escapeHtml(d.reason).replace(/\n/g, '<br>'), true)}
    ${p('La revisaremos y te responderemos en un plazo máximo de 3 días laborables. Si hay que devolver el producto, te indicaremos cómo hacerlo.')}
  `, `Solicitud de reembolso del pedido #${num} recibida.`);
  return { subject, text, html };
}

export interface RefundProcessedData {
  orderId: number | string;
  orderDate?: Date | string | null;
  customerName?: string;
  /** Importe reembolsado en céntimos. */
  amount: number;
  full: boolean;
  note?: string | null;
}

export function refundProcessed(d: RefundProcessedData): RenderedEmail {
  const num = formatOrderNumber(d.orderId, d.orderDate);
  const subject = `Reembolso de ${eur(d.amount)} realizado · Pedido #${num}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Hemos realizado un reembolso de ${eur(d.amount)} ${d.full ? 'por el total de tu pedido' : 'de parte de tu pedido'} #${num}.${d.note ? `\n\n${d.note}` : ''}

El dinero vuelve al mismo medio de pago que usaste. Según tu banco puede tardar entre 5 y 10 días hábiles en aparecer.${signature}`;
  const html = shell(`
    ${heading('Reembolso realizado')}
    ${greeting(d.customerName)}
    ${p(`Hemos realizado un reembolso ${d.full ? 'por el total de tu pedido' : 'de parte de tu pedido'} <strong style="color:${C.text}">#${escapeHtml(num)}</strong>.`)}
    ${highlight('Importe reembolsado', eur(d.amount))}
    ${d.note ? panel(escapeHtml(d.note).replace(/\n/g, '<br>'), true) : ''}
    ${p('El dinero vuelve al mismo medio de pago que usaste. Según tu banco puede tardar entre 5 y 10 días hábiles en aparecer.')}
  `, `Te hemos devuelto ${eur(d.amount)}.`);
  return { subject, text, html };
}

export interface RefundRejectedData {
  orderId: number | string;
  orderDate?: Date | string | null;
  customerName?: string;
  note: string;
}

export function refundRejected(d: RefundRejectedData): RenderedEmail {
  const num = formatOrderNumber(d.orderId, d.orderDate);
  const subject = `Sobre tu solicitud de reembolso · Pedido #${num}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Hemos revisado tu solicitud de reembolso del pedido #${num} y no podemos aceptarla:

${d.note}

Si no estás de acuerdo o quieres darnos más información, responde a este correo.${signature}`;
  const html = shell(`
    ${heading('Solicitud de reembolso revisada')}
    ${greeting(d.customerName)}
    ${p(`Hemos revisado tu solicitud de reembolso del pedido <strong style="color:${C.text}">#${escapeHtml(num)}</strong> y no podemos aceptarla:`)}
    ${panel(escapeHtml(d.note).replace(/\n/g, '<br>'), true)}
    ${p('Si no estás de acuerdo o quieres darnos más información, responde a este correo.')}
  `);
  return { subject, text, html };
}

export interface GenericData {
  subject: string;
  body: string;
  cta?: { label: string; url: string };
}

export function generic(d: GenericData): RenderedEmail {
  const text = `${d.body}\n${d.cta ? `\n${d.cta.label}: ${d.cta.url}\n` : ''}${signature}`;
  const html = shell(`
    <div style="line-height:1.6;color:${C.body}">${escapeHtml(d.body).replace(/\n/g, '<br>')}</div>
    ${d.cta ? button(d.cta.url, d.cta.label) : ''}
  `);
  return { subject: d.subject, text, html };
}

export interface InternalData {
  subject: string;
  title: string;
  facts: Array<[string, string]>;
  /** Mensaje libre del cliente; se escapa y respeta saltos de línea. */
  message?: string;
  table?: { head: [string, string]; rows: Array<[string, string]> };
}

/** Aviso para el equipo (formulario de contacto, garantías…). */
export function internal(d: InternalData): RenderedEmail {
  const text = `${d.title}\n\n${d.facts.map(([k, v]) => `${k}: ${v}`).join('\n')}${d.table ? `\n\n${d.table.head.join(' | ')}\n${d.table.rows.map((r) => r.join(' | ')).join('\n')}` : ''}${d.message ? `\n\n${d.message}` : ''}`;
  const html = shell(`
    ${heading(d.title)}
    ${factsTable(d.facts)}
    ${d.table ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:12px 0;border:1px solid ${C.border};border-collapse:collapse">
      <tr>${d.table.head.map((h) => `<td bgcolor="${C.page}" style="padding:8px 10px;background:${C.page};border:1px solid ${C.border};font-family:${MONO};font-size:11px;font-weight:700;text-transform:uppercase;color:${C.muted}">${escapeHtml(h)}</td>`).join('')}</tr>
      ${d.table.rows.map((r) => `<tr>${r.map((c) => `<td style="padding:8px 10px;border:1px solid ${C.border};font-size:14px;color:${C.text};vertical-align:top">${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}
    </table>` : ''}
    ${d.message ? panel(escapeHtml(d.message).replace(/\n/g, '<br>'), true) : ''}
  `);
  return { subject: d.subject, text, html };
}

type TemplateMap = {
  'verify-email': VerifyEmailData;
  'order-confirmation': OrderConfirmationData;
  'order-shipped': OrderShippedData;
  'order-cancelled': OrderCancelledData;
  'order-note': OrderNoteData;
  'payment-link': PaymentLinkData;
  'warranty-received': WarrantyReceivedData;
  'warranty': WarrantyData;
  'contact-reply': ContactReplyData;
  'generic': GenericData;
  'internal': InternalData;
  'refund-request-received': RefundRequestReceivedData;
  'refund-processed': RefundProcessedData;
  'refund-rejected': RefundRejectedData;
};

export type TemplateName = keyof TemplateMap;

/**
 * Renderiza una plantilla por nombre. Lanza un error si no existe.
 */
export function renderEmail<K extends keyof TemplateMap>(template: K, data: TemplateMap[K]): RenderedEmail {
  switch (template) {
    case 'verify-email':        return verifyEmail(data as any);
    case 'order-confirmation':  return orderConfirmation(data as any);
    case 'order-shipped':       return orderShipped(data as any);
    case 'order-cancelled':     return orderCancelled(data as any);
    case 'order-note':          return orderNote(data as any);
    case 'payment-link':        return paymentLink(data as any);
    case 'warranty-received':   return warrantyReceived(data as any);
    case 'warranty':            return warranty(data as any);
    case 'contact-reply':       return contactReply(data as any);
    case 'generic':             return generic(data as any);
    case 'internal':            return internal(data as any);
    case 'refund-request-received': return refundRequestReceived(data as any);
    case 'refund-processed':    return refundProcessed(data as any);
    case 'refund-rejected':     return refundRejected(data as any);
    default: {
      const unknown = (template as string) || 'unknown';
      throw new Error(`Unknown email template: ${unknown}`);
    }
  }
}
