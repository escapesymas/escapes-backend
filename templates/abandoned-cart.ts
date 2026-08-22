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
    options.stage === 1 ? '¿Se te olvidó algo? Tienes productos esperándote · Escapes y Más'
    : options.stage === 2 ? `${discountPct}% de descuento para completar tu compra · Escapes y Más`
    : `Última oportunidad · ${discountPct}% de descuento · Escapes y Más`;

  const itemsHtml = (cart.cart_snapshot || []).slice(0, 6).map((item: any) => {
    let rawPrice = item.price;
    let priceNum = 0;
    if (typeof rawPrice === 'number') {
      priceNum = rawPrice;
    } else if (typeof rawPrice === 'string') {
      priceNum = parseFloat(rawPrice) || 0;
    } else if (typeof item.price_cents === 'number') {
      priceNum = item.price_cents / 100;
    }

    const qty = parseInt(item.quantity) || 1;

    // Check if priceNum was in cents rather than euros
    if (priceNum > 0 && Math.abs((priceNum * qty) - (cart.cart_total_cents / 100)) > Math.abs(((priceNum / 100) * qty) - (cart.cart_total_cents / 100)) + 0.05) {
      priceNum = priceNum / 100;
    }

    const lineTotalNum = priceNum * qty;
    const priceFormatted = priceNum.toFixed(2);
    const lineTotalFormatted = lineTotalNum.toFixed(2);
    const name = (item.title || item.name || '').replace(/[<>&"]/g, '');
    let image = item.image || item.src || '';
    if (image && !image.startsWith('http')) {
      image = `${siteUrl}${image.startsWith('/') ? '' : '/'}${image}`;
    }
    const slug = item.slug || item.id || '';
    const productUrl = `${siteUrl}/producto/${slug}`;

    return `<tr>
      <td style="padding:14px 0;border-bottom:1px solid #1e293b;vertical-align:middle;width:72px">
        ${image ? `<a href="${productUrl}"><div style="width:64px;height:64px;background:#ffffff;border-radius:8px;border:1px solid #334155;display:flex;align-items:center;justify-content:center;overflow:hidden"><img src="${image}" alt="${name}" style="max-width:58px;max-height:58px;object-fit:contain;display:block;margin:auto" /></div></a>` : ''}
      </td>
      <td style="padding:14px 12px;border-bottom:1px solid #1e293b;vertical-align:middle">
        <a href="${productUrl}" style="color:#f8fafc;text-decoration:none;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;text-transform:uppercase;line-height:1.4">${name}</a>
        <div style="color:#94a3b8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;margin-top:4px">Cantidad: ${qty}</div>
      </td>
      <td style="padding:14px 0;border-bottom:1px solid #1e293b;vertical-align:middle;text-align:right;font-family:'Courier New',Courier,monospace;font-size:14px;font-weight:700;color:#f8fafc">
        <div>${priceFormatted}€</div>
        <div style="color:#94a3b8;font-family:-apple-system,sans-serif;font-size:11px;font-weight:normal;margin-top:2px">Subtotal: ${lineTotalFormatted}€</div>
      </td>
    </tr>`;
  }).join('');

  const discountBadge =
    cart.discount_cents > 0
      ? `<div style="display:inline-block;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.4);color:#4ade80;padding:6px 14px;border-radius:6px;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:800;letter-spacing:1px;margin-bottom:16px">${discountPct}% DE DESCUENTO APLICADO</div>`
      : '';

  const urgencyBlock =
    options.stage === 3
      ? `<p style="color:#facc15;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;text-transform:uppercase;text-align:center;margin:16px 0">⚠️ Esta oferta expira en 24 horas.</p>`
      : options.stage === 2
      ? `<p style="color:#facc15;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;text-transform:uppercase;text-align:center;margin:16px 0">⚡ Tu cupón es válido por 7 días.</p>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Escapes y Más</title>
</head>
<body style="margin:0;padding:0;background:#090b10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#090b10;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#11141d;border-radius:16px;overflow:hidden;border:1px solid #1e293b;box-shadow:0 20px 40px rgba(0,0,0,0.8)">
      <!-- Header with Logo -->
      <tr><td style="padding:28px 32px 20px;text-align:center;background:#0f172a;border-bottom:1px solid #1e293b">
        <a href="${siteUrl}" style="text-decoration:none">
          <img src="${siteUrl}/logo-cabecera.svg" alt="Escapes y Más" style="height:42px;width:auto;max-width:240px;display:inline-block" />
        </a>
      </td></tr>
      <!-- Body Header -->
      <tr><td style="padding:28px 32px 16px;color:#f8fafc">
        <h2 style="margin:0 0 8px 0;font-family:'Courier New',Courier,monospace;font-size:20px;font-weight:900;text-transform:uppercase;color:#ffffff;letter-spacing:-0.5px">
          ${options.stage === 1 ? 'Has dejado productos en tu carrito' : 'Te guardamos un descuento especial'}
        </h2>
        <p style="margin:0 0 16px 0;color:#94a3b8;font-family:-apple-system,sans-serif;font-size:14px;line-height:1.6">
          ${options.stage === 1
            ? 'Hemos guardado los productos que añadiste. Vuelve cuando quieras para completar tu compra antes de que se agote el stock.'
            : `Como vemos que te interesan, te hemos preparado un <strong>${discountPct}% de descuento</strong> exclusivo por tiempo limitado.`}
        </p>
        ${discountBadge}
      </td></tr>
      <!-- Product Items List -->
      <tr><td style="padding:0 32px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          ${itemsHtml}
        </table>
      </td></tr>
      <!-- Summary / Total -->
      <tr><td style="padding:20px 32px;background:#0f172a;border-top:1px solid #1e293b">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          ${cart.discount_cents > 0 ? `<tr>
            <td style="font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase">Subtotal:</td>
            <td style="font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#94a3b8;text-align:right;text-decoration:line-through">${(cart.cart_total_cents / 100).toFixed(2)}€</td>
          </tr>
          <tr>
            <td style="font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#4ade80;text-transform:uppercase">Descuento (${discountPct}%):</td>
            <td style="font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#4ade80;text-align:right">-${(cart.discount_cents / 100).toFixed(2)}€</td>
          </tr>` : ''}
          <tr>
            <td style="font-family:'Courier New',Courier,monospace;font-size:16px;font-weight:900;color:#ffffff;text-transform:uppercase;padding-top:6px">Total:</td>
            <td style="font-family:'Courier New',Courier,monospace;font-size:22px;font-weight:900;color:#facc15;padding-top:6px;text-align:right">${totalFormatted}€</td>
          </tr>
        </table>
      </td></tr>
      ${urgencyBlock ? `<tr><td style="padding:12px 32px 0">${urgencyBlock}</td></tr>` : ''}
      <!-- CTA Button -->
      <tr><td style="padding:28px 32px 32px;text-align:center">
        <a href="${recoveryUrl}" style="display:inline-block;background:#facc15;color:#090b10;padding:15px 36px;border-radius:10px;font-family:'Courier New',Courier,monospace;font-size:15px;font-weight:900;text-decoration:none;text-transform:uppercase;letter-spacing:1px;box-shadow:0 4px 15px rgba(250,204,21,0.3)">
          RECUPERAR MI CARRITO &rarr;
        </a>
        <p style="margin:20px 0 0 0;color:#64748b;font-family:-apple-system,sans-serif;font-size:12px;line-height:1.5">
          Este enlace expira en 7 días. Si no deseas recibir más recordatorios, puedes ignorar este correo.
        </p>
      </td></tr>
    </table>
    <!-- Footer Footer -->
    <p style="color:#64748b;font-family:'Courier New',Courier,monospace;font-size:11px;margin:20px 0 0 0;text-transform:uppercase;letter-spacing:0.5px">
      Escapes y Más &middot; <a href="${siteUrl}" style="color:#facc15;text-decoration:none;font-weight:700">escapesymas.com</a>
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
