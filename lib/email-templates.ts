/**
 * Email templates.
 *
 * Each template is a typed function that takes a structured data object and
 * returns { subject, text, html } for the email module to send.
 *
 * We intentionally do NOT use MJML as a runtime dependency — the bundled
 * HTML below is responsive across major clients (Gmail, Outlook, Apple Mail)
 * and is small enough to maintain inline. To change a template's visual
 * design, edit the HTML here.
 *
 * Available templates:
 *   - order-confirmation
 *   - order-shipped
 *   - order-cancelled
 *   - contact-reply
 *   - warranty-received
 *   - warranty-resolved
 *   - generic
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const BRAND = 'Escapes y Más';
const BRAND_URL = 'https://escapesymas.com';
const BRAND_COLOR = '#FF6B00';

function shell(content: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${BRAND}</title>
</head>
<body style="margin:0;padding:0;background:#f7f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#222">
  <div style="max-width:600px;margin:0 auto;background:#fff;padding:24px;border:1px solid #e5e7eb">
    <div style="text-align:center;border-bottom:1px solid #f0f0f0;padding-bottom:16px;margin-bottom:16px">
      <a href="${BRAND_URL}" style="color:${BRAND_COLOR};font-size:22px;font-weight:700;text-decoration:none">${BRAND}</a>
    </div>
    ${content}
    <div style="border-top:1px solid #f0f0f0;margin-top:24px;padding-top:16px;text-align:center;color:#888;font-size:12px">
      <a href="${BRAND_URL}" style="color:#888;text-decoration:none">${BRAND_URL.replace('https://', '')}</a>
      &middot; <a href="${BRAND_URL}/cuenta" style="color:#888;text-decoration:none">Mi cuenta</a>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(cents: number | string): number {
  return (typeof cents === 'string' ? parseInt(cents) : cents) / 100;
}

export interface OrderConfirmationData {
  orderId: number | string;
  customerName?: string;
  total: number | string;
  invoiceNumber?: string;
  trackingUrl?: string;
}

export function orderConfirmation(d: OrderConfirmationData): RenderedEmail {
  const total = money(d.total).toFixed(2);
  const subject = `Pedido #${d.orderId} confirmado · ${BRAND}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Tu pedido #${d.orderId} por ${total}€ ha sido confirmado correctamente.
${d.invoiceNumber ? `Factura: ${d.invoiceNumber} (adjunta en este email).` : ''}

En los próximos días recibirás un email con el código de seguimiento cuando tu pedido salga de nuestro almacén.

Gracias por confiar en ${BRAND}.

El equipo de ${BRAND}.`;

  const html = shell(`
    <h2 style="color:${BRAND_COLOR};margin:0 0 8px">¡Pedido confirmado!</h2>
    <p>Hola${d.customerName ? ` <strong>${escapeHtml(d.customerName)}</strong>` : ''},</p>
    <p>Tu pedido <strong>#${escapeHtml(String(d.orderId))}</strong> por <strong style="color:${BRAND_COLOR}">${total}€</strong> ha sido confirmado correctamente.</p>
    ${d.invoiceNumber ? `<p>Factura: <strong>${escapeHtml(d.invoiceNumber)}</strong> (adjunta en este email).</p>` : ''}
    <p>En los próximos días recibirás un email con el código de seguimiento cuando tu pedido salga de nuestro almacén.</p>
    <p style="margin-top:24px">Gracias por confiar en nosotros.</p>
  `);
  return { subject, text, html };
}

export interface OrderShippedData {
  orderId: number | string;
  customerName?: string;
  trackingNumber: string;
  trackingUrl: string;
  carrier?: string;
}

export function orderShipped(d: OrderShippedData): RenderedEmail {
  const subject = `Tu pedido #${d.orderId} está en camino · ${BRAND}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Tu pedido #${d.orderId} ha salido de nuestro almacén${d.carrier ? ` con ${d.carrier}` : ''}.

Número de seguimiento: ${d.trackingNumber}
Sigue tu envío: ${d.trackingUrl}

Gracias por confiar en ${BRAND}.

El equipo de ${BRAND}.`;

  const html = shell(`
    <h2 style="color:${BRAND_COLOR};margin:0 0 8px">¡Tu pedido está en camino!</h2>
    <p>Hola${d.customerName ? ` <strong>${escapeHtml(d.customerName)}</strong>` : ''},</p>
    <p>Tu pedido <strong>#${escapeHtml(String(d.orderId))}</strong> ha salido de nuestro almacén${d.carrier ? ` con <strong>${escapeHtml(d.carrier)}</strong>` : ''}.</p>
    <table style="margin:16px 0;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#666">Seguimiento:</td><td><strong>${escapeHtml(d.trackingNumber)}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Carrier:</td><td>${escapeHtml(d.carrier || '—')}</td></tr>
    </table>
    <p style="margin:24px 0">
      <a href="${escapeHtml(d.trackingUrl)}" style="display:inline-block;background:${BRAND_COLOR};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Seguir mi envío</a>
    </p>
  `);
  return { subject, text, html };
}

export interface OrderCancelledData {
  orderId: number | string;
  customerName?: string;
  reason?: string;
}

export function orderCancelled(d: OrderCancelledData): RenderedEmail {
  const subject = `Tu pedido #${d.orderId} ha sido cancelado · ${BRAND}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Tu pedido #${d.orderId} ha sido cancelado.${d.reason ? `\n\nMotivo: ${d.reason}` : ''}

Si esto es un error o necesitas ayuda, responde a este email.

El equipo de ${BRAND}.`;

  const html = shell(`
    <h2 style="color:#666;margin:0 0 8px">Pedido cancelado</h2>
    <p>Hola${d.customerName ? ` <strong>${escapeHtml(d.customerName)}</strong>` : ''},</p>
    <p>Tu pedido <strong>#${escapeHtml(String(d.orderId))}</strong> ha sido cancelado.</p>
    ${d.reason ? `<p style="color:#666">Motivo: ${escapeHtml(d.reason)}</p>` : ''}
    <p>Si esto es un error o necesitas ayuda, responde a este email.</p>
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

${d.originalMessage ? `\n--\nTu mensaje original:\n${d.originalMessage}\n--` : ''}

El equipo de ${BRAND}.`;

  const html = shell(`
    <h2 style="color:${BRAND_COLOR};margin:0 0 8px">Re: ${escapeHtml(d.subject)}</h2>
    <p>Hola${d.customerName ? ` <strong>${escapeHtml(d.customerName)}</strong>` : ''},</p>
    <div style="white-space:pre-wrap;line-height:1.6">${escapeHtml(d.reply)}</div>
    ${d.originalMessage ? `
      <div style="margin-top:24px;padding:12px;background:#f7f7f8;border-left:3px solid #ddd">
        <small style="color:#666">Tu mensaje original:</small>
        <div style="white-space:pre-wrap;margin-top:8px;color:#666">${escapeHtml(d.originalMessage)}</div>
      </div>
    ` : ''}
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
  const subject = `Garantía #${d.ticketId} — ${statusLabel[d.status]} · ${BRAND}`;
  const text = `Hola${d.customerName ? ` ${d.customerName}` : ''},

Tu solicitud de garantía #${d.ticketId} ha cambiado de estado: ${statusLabel[d.status]}.${d.notes ? `\n\nNotas: ${d.notes}` : ''}

Si necesitas más información, responde a este email indicando el número de ticket.

El equipo de ${BRAND}.`;

  const html = shell(`
    <h2 style="color:${BRAND_COLOR};margin:0 0 8px">Garantía #${escapeHtml(String(d.ticketId))}</h2>
    <p>Hola${d.customerName ? ` <strong>${escapeHtml(d.customerName)}</strong>` : ''},</p>
    <p>Tu solicitud de garantía <strong>#${escapeHtml(String(d.ticketId))}</strong> ha cambiado de estado: <strong>${statusLabel[d.status]}</strong>.</p>
    ${d.notes ? `<div style="margin-top:16px;padding:12px;background:#fff7e6;border-left:3px solid ${BRAND_COLOR}">${escapeHtml(d.notes)}</div>` : ''}
    <p style="margin-top:24px">Si necesitas más información, responde a este email indicando el número de ticket.</p>
  `);
  return { subject, text, html };
}

export interface GenericData {
  subject: string;
  body: string;
  cta?: { label: string; url: string };
}

export function generic(d: GenericData): RenderedEmail {
  const text = `${d.body}\n${d.cta ? `\n${d.cta.label}: ${d.cta.url}\n` : ''}\nEl equipo de ${BRAND}.`;
  const html = shell(`
    <div style="white-space:pre-wrap;line-height:1.6">${escapeHtml(d.body).replace(/\n/g, '<br>')}</div>
    ${d.cta ? `
      <p style="margin:24px 0">
        <a href="${escapeHtml(d.cta.url)}" style="display:inline-block;background:${BRAND_COLOR};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(d.cta.label)}</a>
      </p>
    ` : ''}
  `);
  return { subject: d.subject, text, html };
}

type TemplateMap = {
  'order-confirmation': OrderConfirmationData;
  'order-shipped': OrderShippedData;
  'order-cancelled': OrderCancelledData;
  'contact-reply': ContactReplyData;
  'warranty': WarrantyData;
  'generic': GenericData;
};

export type TemplateName = keyof TemplateMap;

/**
 * Render a template by name. Throws if the template is unknown.
 */
export function renderEmail<K extends keyof TemplateMap>(template: K, data: TemplateMap[K]): RenderedEmail {
  switch (template) {
    case 'order-confirmation': return orderConfirmation(data as any);
    case 'order-shipped':       return orderShipped(data as any);
    case 'order-cancelled':     return orderCancelled(data as any);
    case 'contact-reply':       return contactReply(data as any);
    case 'warranty':            return warranty(data as any);
    case 'generic':             return generic(data as any);
    default: {
      const unknown = (template as string) || 'unknown';
      throw new Error(`Unknown email template: ${unknown}`);
    }
  }
}
