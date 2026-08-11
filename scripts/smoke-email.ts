/**
 * Smoke test for lib/email.ts and lib/email-templates.ts.
 * Run: DATABASE_URL="postgresql://adrian@/escapes_test?host=/tmp&port=5433" \
 *      npx tsx scripts/smoke-email.ts
 *
 * Exercises template rendering + queue persistence. Does NOT attempt
 * to connect to a real SMTP server (no creds in test env).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { renderEmail } from '../lib/email-templates.js';
import { makeOpenTrackingPixel, recordOpen } from '../lib/email.js';

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error('✗ FAIL:', msg);
    process.exit(1);
  } else {
    console.log('✓', msg);
  }
}

async function main() {
  // 1. order-confirmation template
  const oc = renderEmail('order-confirmation', {
    orderId: 12345,
    customerName: 'Juan Pérez',
    total: 10995,
    invoiceNumber: 'FAC-2026-001',
  });
  assert(oc.subject.includes('Pedido #12345'), 'order-confirmation subject includes orderId');
  assert(oc.subject.includes('confirmado'), 'order-confirmation subject includes "confirmado"');
  assert(oc.text.includes('109.95€'), 'order-confirmation text formats total as EUR');
  assert(oc.text.includes('Juan Pérez'), 'order-confirmation text includes customerName');
  assert(oc.html.includes('<!DOCTYPE html>'), 'order-confirmation html is wrapped');
  assert(oc.html.includes('FAC-2026-001'), 'order-confirmation html includes invoice number');
  assert(oc.html.includes('Juan'), 'order-confirmation html includes customer name');
  assert(!oc.html.includes('<script'), 'order-confirmation html has no scripts');

  // 2. order-shipped template
  const os = renderEmail('order-shipped', {
    orderId: 12345,
    customerName: 'Juan',
    trackingNumber: 'TRK123',
    trackingUrl: 'https://carrier.example.com/TRK123',
    carrier: 'GLS',
  });
  assert(os.subject.includes('camino'), 'order-shipped subject includes "camino"');
  assert(os.html.includes('TRK123'), 'order-shipped html includes tracking number');
  assert(os.html.includes('GLS'), 'order-shipped html includes carrier');
  assert(os.html.includes('https://carrier.example.com/TRK123'), 'order-shipped html includes tracking URL');

  // 3. order-cancelled template
  const cx = renderEmail('order-cancelled', { orderId: 999, reason: 'Stock' });
  assert(cx.html.includes('Stock'), 'order-cancelled html includes reason');
  assert(cx.html.includes('cancelado'), 'order-cancelled html includes "cancelado"');

  // 4. contact-reply template
  const cr = renderEmail('contact-reply', {
    subject: 'Duda sobre pedido',
    reply: 'Hola, tu pedido está en proceso.',
    originalMessage: '¿Cuándo llega mi pedido?',
  });
  assert(cr.subject.includes('Re:'), 'contact-reply subject includes "Re:"');
  assert(cr.html.includes('¿Cuándo llega mi pedido?'), 'contact-reply html includes original message');

  // 5. warranty template (all 4 statuses)
  for (const status of ['received', 'in_review', 'resolved', 'rejected'] as const) {
    const w = renderEmail('warranty', { ticketId: 42, status, notes: 'OK' });
    assert(w.subject.includes('#42'), `warranty ${status} subject includes ticketId`);
    assert(w.html.includes('OK'), `warranty ${status} html includes notes`);
  }
  const wBad = renderEmail('warranty', { ticketId: 42, status: 'received' });
  assert(!wBad.subject.includes('rechazada'), 'warranty received does not include "rechazada" in subject');

  // 6. generic template
  const g = renderEmail('generic', {
    subject: 'Recordatorio',
    body: 'Tu suscripción vence pronto.',
    cta: { label: 'Renovar', url: 'https://example.com/renovar' },
  });
  assert(g.html.includes('Renovar'), 'generic html includes CTA label');
  assert(g.html.includes('https://example.com/renovar'), 'generic html includes CTA URL');

  // 7. XSS escape behavior
  const xss = renderEmail('order-confirmation', {
    orderId: '<script>alert(1)</script>',
    customerName: '<img src=x onerror=alert(1)>',
    total: 1000,
  });
  assert(!xss.html.includes('<script>alert(1)</script>'), 'order-confirmation html escapes XSS in orderId');
  assert(!xss.html.includes('<img src=x onerror'), 'order-confirmation html escapes XSS in customerName');
  assert(xss.html.includes('&lt;script&gt;'), 'order-confirmation html contains escaped <script>');

  // 8. Unknown template throws
  let threw = false;
  try {
    // @ts-expect-error - intentional bad template name
    renderEmail('not-a-template', {});
  } catch (e: any) {
    threw = true;
    assert(e.message.includes('Unknown email template'), 'unknown template throws clear error');
  }
  assert(threw, 'unknown template throws');

  // 9. Open tracking pixel URL generation
  const MSG_ID = 'msg_test_' + Date.now();
  const pixel = await makeOpenTrackingPixel(MSG_ID, 'test@example.com');
  assert(pixel.includes('/api/email/track-open?m='), 'pixel URL contains track-open endpoint');
  assert(pixel.includes(encodeURIComponent(MSG_ID)), 'pixel URL contains messageId');
  assert(pixel.includes('width="1"'), 'pixel is 1x1');

  // 10. Open tracking record
  await recordOpen(MSG_ID);
  const row = (await db.execute(sql`
    SELECT opened_at, open_count FROM email_open_tracking WHERE message_id = ${MSG_ID}
  `)).rows[0] as any;
  assert(row?.open_count === 1, 'recordOpen increments open_count to 1');
  await recordOpen(MSG_ID);
  const row2 = (await db.execute(sql`
    SELECT open_count FROM email_open_tracking WHERE message_id = ${MSG_ID}
  `)).rows[0] as any;
  assert(row2?.open_count === 2, 'second recordOpen increments open_count to 2');

  // Cleanup
  await db.execute(sql`DELETE FROM email_open_tracking WHERE message_id = ${MSG_ID}`);

  console.log('\n✓ ALL EMAIL SMOKE TESTS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
