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

export function renderAbandonedCartEmail(
  cart: AbandonedCartRow,
  options: { siteUrl: string; locale?: string; stage: 1 | 2 | 3 }
): { subject: string; html: string; text: string } {
  const locale = options.locale || 'es-ES';
  const siteUrl = options.siteUrl.replace(/\/$/, '');
  const recoveryUrl = `${siteUrl}/checkout?recover=${cart.recovery_token}`;
  const discountPct = cart.discount_cents > 0 ? Math.round((cart.discount_cents / cart.cart_total_cents) * 100) : 0;
  const totalCents = Math.max(0, cart.cart_total_cents - cart.discount_cents);
  const totalFormatted = (totalCents / 100).toFixed(2);

  const subject =
    options.stage === 1 ? '¿Se te olvidó algo? Tienes productos esperándote'
    : options.stage === 2 ? `${discountPct}% de descuento para completar tu compra`
    : `Última oportunidad · ${discountPct}% de descuento`;

  const itemsHtml = (cart.cart_snapshot || []).slice(0, 6).map((item: any) => {
    const cents = typeof item.price === 'number' ? item.price : parseInt(item.price) || 0;
    const qty = parseInt(item.quantity) || 1;
    const lineTotal = ((cents * qty) / 100).toFixed(2);
    const price = (cents / 100).toFixed(2);
    const name = (item.name || '').replace(/[<>&"]/g, '');
    const image = item.image || item.src || '';
    const slug = item.slug || item.id || '';
    const productUrl = `${siteUrl}/producto/${slug}`;
    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #1e293b;vertical-align:top">
        ${image ? `<img src="${image}" alt="${name}" style="width:64px;height:64px;object-fit:contain;background:#0a0a0b;border-radius:6px;display:block;margin-right:12px" />` : ''}
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #1e293b;vertical-align:top">
        <a href="${productUrl}" style="color:#f1f5f9;text-decoration:none;font-family:sans-serif;font-size:14px;font-weight:600">${name}</a>
        <div style="color:#888;font-family:sans-serif;font-size:12px;margin-top:4px">Cantidad: ${qty}</div>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #1e293b;vertical-align:top;text-align:right;font-family:sans-serif;font-size:14px;color:#f1f5f9">
        <div>${price}€</div>
        <div style="color:#888;font-size:11px">Subtotal: ${lineTotal}€</div>
      </td>
    </tr>`;
  }).join('');

  const discountBadge =
    cart.discount_cents > 0
      ? `<div style="display:inline-block;background:#16a34a;color:white;padding:6px 12px;border-radius:4px;font-family:sans-serif;font-size:13px;font-weight:bold;margin-bottom:16px">${discountPct}% DE DESCUENTO APLICADO</div>`
      : '';

  const urgencyBlock =
    options.stage === 3
      ? `<p style="color:#fbbf24;font-family:sans-serif;font-size:14px;text-align:center;margin:16px 0">Esta oferta expira en 24 horas.</p>`
      : options.stage === 2
      ? `<p style="color:#fbbf24;font-family:sans-serif;font-size:14px;text-align:center;margin:16px 0">Tu cupón es válido por 7 días.</p>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a0a0b;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#121315;border-radius:8px;overflow:hidden;border:1px solid #1e293b">
      <tr><td style="padding:32px 32px 16px;text-align:center;background:#121315">
        <h1 style="margin:0;color:#facc15;font-family:monospace;font-size:24px;text-transform:uppercase">Escapes y Más</h1>
      </td></tr>
      <tr><td style="padding:16px 32px;color:#f1f5f9">
        <h2 style="margin:0 0 8px 0;font-family:sans-serif;font-size:22px;font-weight:600">
          ${options.stage === 1 ? 'Has dejado productos en tu carrito' : 'Te guardamos un descuento especial'}
        </h2>
        <p style="margin:0 0 16px 0;color:#cbd5e1;font-family:sans-serif;font-size:14px;line-height:1.5">
          ${options.stage === 1
            ? 'Hemos guardado los productos que añadiste. Vuelve cuando quieras para completar tu compra.'
            : `Como vemos que te interesan, te hemos guardado un <strong>${discountPct}% de descuento</strong> por tiempo limitado.`}
        </p>
        ${discountBadge}
      </td></tr>
      <tr><td style="padding:0 32px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          ${itemsHtml}
        </table>
      </td></tr>
      <tr><td style="padding:24px 32px;border-top:1px solid #1e293b">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          ${cart.discount_cents > 0 ? `<tr>
            <td style="font-family:sans-serif;font-size:14px;color:#888">Subtotal:</td>
            <td style="font-family:sans-serif;font-size:14px;color:#888;text-align:right;text-decoration:line-through">${(cart.cart_total_cents / 100).toFixed(2)}€</td>
          </tr>
          <tr>
            <td style="font-family:sans-serif;font-size:14px;color:#16a34a">Descuento (${discountPct}%):</td>
            <td style="font-family:sans-serif;font-size:14px;color:#16a34a;text-align:right">-${(cart.discount_cents / 100).toFixed(2)}€</td>
          </tr>` : ''}
          <tr>
            <td style="font-family:sans-serif;font-size:18px;font-weight:bold;color:#facc15;padding-top:8px">Total:</td>
            <td style="font-family:sans-serif;font-size:18px;font-weight:bold;color:#facc15;padding-top:8px;text-align:right">${totalFormatted}€</td>
          </tr>
        </table>
      </td></tr>
      ${urgencyBlock ? `<tr><td style="padding:0 32px">${urgencyBlock}</td></tr>` : ''}
      <tr><td style="padding:24px 32px 32px;text-align:center">
        <a href="${recoveryUrl}" style="display:inline-block;background:#facc15;color:#0a0a0b;padding:14px 32px;border-radius:6px;font-family:sans-serif;font-size:16px;font-weight:bold;text-decoration:none;text-transform:uppercase;letter-spacing:0.5px">
          Recuperar mi carrito
        </a>
        <p style="margin:24px 0 0 0;color:#888;font-family:sans-serif;font-size:12px;line-height:1.5">
          Este enlace expira en 7 días. Si no quieres recibir más recordatorios, ignora este email.
        </p>
      </td></tr>
    </table>
    <p style="color:#666;font-family:sans-serif;font-size:11px;margin:16px 0 0 0">
      Escapes y Más · <a href="${siteUrl}" style="color:#facc15;text-decoration:none">escapesymas.com</a>
    </p>
  </td></tr>
</table>
</body>
</html>`;

  const text = `Hola,\n\n${
    options.stage === 1
      ? 'Has dejado productos en tu carrito en Escapes y Más.'
      : `Te hemos guardado un ${discountPct}% de descuento.`
  }\n\nRecupera tu carrito aquí: ${recoveryUrl}\n\nGracias,\nEscapes y Más`;

  return { subject, html, text };
}
