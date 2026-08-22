/**
 * Stripe Webhook Business Logic Service.
 *
 * Implements signature validation and event handling for:
 *   - checkout.session.completed / payment_intent.succeeded
 *   - payment_intent.payment_failed
 *   - charge.refunded
 *
 * Guarantees:
 *   - Signature verification using STRIPE_WEBHOOK_SECRET / STRIPE_TEST_WEBHOOK_SECRET
 *   - Idempotency via processStripeEvent + order status checks
 *   - Atomic PostgreSQL transactions for order status, stock adjustments, and payment metadata
 *   - Confirmation emails, invoice PDF generation, cache busting, and server tracking
 */

import Stripe from 'stripe';
import { pool, db } from '../db.js';
import { sql } from 'drizzle-orm';
import { processStripeEvent } from './stripe-webhook.js';
import { sendTemplatedEmail, sendEmail } from './email.js';
import { cacheBust } from './cache.js';
import fs from 'fs';

// Initialize Stripe clients
const stripeLiveKey = process.env.STRIPE_SECRET_KEY;
const stripeLive = new Stripe(stripeLiveKey || 'sk_missing_set_env', {
  apiVersion: '2024-11-20.acacia' as any,
});

const stripeTestKey = process.env.STRIPE_TEST_SECRET_KEY;
const stripeTest = stripeTestKey
  ? new Stripe(stripeTestKey, { apiVersion: '2024-11-20.acacia' as any })
  : stripeLive;

/**
 * Construct and verify Stripe webhook event from raw payload buffer and signature header.
 */
export function constructStripeEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
  if (!signature) {
    throw new Error('Falta la cabecera stripe-signature');
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const testWebhookSecret = process.env.STRIPE_TEST_WEBHOOK_SECRET;

  if (!webhookSecret && !testWebhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET no está configurada en las variables de entorno');
  }

  let event: Stripe.Event | undefined;
  let lastError: Error | undefined;

  if (testWebhookSecret) {
    try {
      event = stripeTest.webhooks.constructEvent(rawBody, signature, testWebhookSecret);
    } catch (e: any) {
      lastError = e;
    }
  }

  if (!event && webhookSecret) {
    try {
      event = stripeLive.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (e: any) {
      lastError = e;
    }
  }

  if (!event) {
    throw new Error(`Error de verificación de firma: ${lastError?.message || 'Firma de Stripe inválida'}`);
  }

  return event;
}

/**
 * Helper to generate or load PDF invoice for an order.
 */
async function getOrCreateInvoice(orderId: number): Promise<any> {
  const existingInv = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${orderId}`);
  if (existingInv.rows.length > 0) {
    return existingInv.rows[0];
  }

  const orderRes = await db.execute(sql`SELECT * FROM orders WHERE id = ${orderId}`);
  const order = orderRes.rows[0] as any;
  if (!order) throw new Error(`Pedido #${orderId} no encontrado al generar factura`);

  const year = new Date().getFullYear();
  const countRes = await db.execute(sql`SELECT COUNT(*) as cnt FROM invoices WHERE issued_at >= date_trunc('year', NOW())`);
  const cntVal = countRes?.rows?.[0] ? Number((countRes.rows[0] as any).cnt || (countRes.rows[0] as any).count || 0) : 0;
  const seqNum = String(cntVal + 1).padStart(6, '0');
  const invoiceNumber = `EYMAS-${year}-${seqNum}`;

  const itemsRes = await db.execute(sql`
    SELECT oi.*, p.name as product_name
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ${orderId}
  `);
  const items = itemsRes.rows as any[];

  let calculatedCostTotal = 0;
  for (const item of items) {
    const pCostRes = await db.execute(sql`SELECT cost FROM products WHERE id = ${item.product_id}`);
    const costVal = pCostRes.rows[0] ? (pCostRes.rows[0] as any).cost || 0 : 0;
    calculatedCostTotal += costVal * (item.quantity || 1);
  }

  if (calculatedCostTotal > 0 && (!order.cost_total || order.cost_total === 0)) {
    await db.execute(sql`UPDATE orders SET cost_total = ${calculatedCostTotal} WHERE id = ${orderId}`);
  }

  const subtotal = order.subtotal || order.total || 0;
  const taxAmount = Math.round((order.total || 0) * 21 / 121);
  const invIns = await db.execute(sql`
    INSERT INTO invoices (order_id, invoice_number, subtotal, tax_amount, shipping_cost, discount_amount, total)
    VALUES (${orderId}, ${invoiceNumber}, ${subtotal}, ${taxAmount}, ${order.shipping_cost || 0}, ${order.discount_amount || 0}, ${order.total || 0})
    RETURNING *
  `);

  return invIns?.rows?.[0] || { invoice_number: invoiceNumber };
}

/**
 * Core event processing dispatcher wrapped by idempotency framework.
 */
export async function handleStripeWebhookEvent(event: Stripe.Event): Promise<{ status: string }> {
  const result = await processStripeEvent(event, async (ctx) => {
    const evt = ctx.event as Stripe.Event;

    switch (evt.type) {
      case 'checkout.session.completed':
      case 'payment_intent.succeeded': {
        await handlePaymentSuccess(evt);
        break;
      }
      case 'payment_intent.payment_failed': {
        await handlePaymentFailure(evt);
        break;
      }
      case 'charge.refunded': {
        await handleChargeRefunded(evt);
        break;
      }
      default: {
        console.log(`[STRIPE WEBHOOK] Evento no controlado ignorado: ${evt.type}`);
        break;
      }
    }
  });

  return { status: result.status };
}

/**
 * Process successful payment (checkout.session.completed / payment_intent.succeeded)
 */
async function handlePaymentSuccess(evt: Stripe.Event): Promise<void> {
  const obj = evt.data.object as any;
  
  // Extract orderId from metadata or client_reference_id
  const rawOrderId = obj.metadata?.orderId || obj.metadata?.order_id || obj.client_reference_id;
  let orderId: number | null = rawOrderId ? parseInt(String(rawOrderId), 10) : null;

  const paymentIntentId = evt.type === 'checkout.session.completed' 
    ? (typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id || obj.id)
    : obj.id;

  const stripeChargeId = obj.latest_charge 
    ? (typeof obj.latest_charge === 'string' ? obj.latest_charge : obj.latest_charge.id)
    : (evt.type === 'checkout.session.completed' ? null : obj.id);

  const paymentMethod = obj.payment_method_types?.[0] || obj.payment_method?.type || 'stripe';

  // Fallback order lookup by payment_id if orderId was not in metadata
  if (!orderId && paymentIntentId) {
    const lookupRes = await db.execute(sql`SELECT id FROM orders WHERE payment_id = ${paymentIntentId}`);
    if (lookupRes.rows.length > 0) {
      orderId = (lookupRes.rows[0] as any).id;
    }
  }

  if (!orderId || isNaN(orderId)) {
    console.warn(`[STRIPE WEBHOOK] No se pudo determinar el order_id para el evento ${evt.id} (${evt.type})`);
    return;
  }

  // 1. Order-level idempotency check: check current status
  const existingOrderRes = await db.execute(sql`SELECT id, status, shipping_data, total FROM orders WHERE id = ${orderId}`);
  const existingOrder = existingOrderRes.rows[0] as any;

  if (!existingOrder) {
    console.warn(`[STRIPE WEBHOOK] Pedido #${orderId} no existe en la base de datos.`);
    return;
  }

  // AMOUNT RECONCILIATION: refuse to mark the order paid if the amount
  // Stripe charged does not match the order total. Protects against tampered
  // PaymentIntents and partial captures. See audit 2026-08-15, finding #2.
  const expectedCents = Number(existingOrder.total) || 0;
  const chargedCents = Number(obj.amount_received ?? obj.amount) || 0;
  if (expectedCents > 0 && chargedCents !== expectedCents) {
    console.warn(
      `[STRIPE WEBHOOK SECURITY] Pedido #${orderId} importe ${chargedCents} != esperado ${expectedCents}. ` +
      `Marcando como 'payment_amount_mismatch' y NO aceptando el pago.`
    );
    await db.execute(sql`UPDATE orders SET status = 'payment_amount_mismatch', last_payment_error = ${`Charged ${chargedCents} cents vs expected ${expectedCents}`} WHERE id = ${orderId}`);
    return;
  }

  if (existingOrder.status === 'paid' || existingOrder.status === 'processing') {
    console.log(`[STRIPE WEBHOOK] Pedido #${orderId} ya se encuentra en estado '${existingOrder.status}'. Omitiendo duplicado.`);
    return;
  }

  // 2. PostgreSQL Atomic Transaction for DB updates
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update order status, payment metadata and paid_at timestamp
    await client.query(
      `UPDATE orders
       SET status = 'paid',
           payment_id = $1,
           stripe_charge_id = $2,
           payment_method = $3,
           paid_at = NOW(),
           last_payment_error = NULL
       WHERE id = $4 AND status IN ('pending', 'payment_failed')`,
      [paymentIntentId, stripeChargeId, paymentMethod, orderId]
    );

    // Fetch order items and decrement actual stock
    const itemsRes = await client.query(
      `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId]
    );

    for (const item of itemsRes.rows) {
      const pId = parseInt(item.product_id, 10);
      const qty = parseInt(item.quantity, 10);
      if (pId && qty > 0) {
        await client.query(
          `UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2`,
          [qty, pId]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[STRIPE WEBHOOK] Transacción SQL completada: Pedido #${orderId} actualizado a 'paid' y stock descontado.`);
  } catch (dbErr: any) {
    await client.query('ROLLBACK');
    console.error(`[STRIPE WEBHOOK ERROR] Error en la transacción SQL para pedido #${orderId}:`, dbErr);
    throw dbErr;
  } finally {
    client.release();
  }

  // 3. Post-transaction triggers: Invoice, Email, Cache Busting, Tracking
  let invoiceRecord: any = null;
  try {
    invoiceRecord = await getOrCreateInvoice(orderId);
    console.log(`[STRIPE WEBHOOK] Factura generada para el pedido #${orderId}: ${invoiceRecord.invoice_number}`);
  } catch (invErr: any) {
    console.error(`[STRIPE WEBHOOK] Error generando factura para pedido #${orderId}:`, invErr.message);
  }

  // Bust cache for catalog & filters
  await cacheBust('cache:products').catch(e => console.error('[CACHE BUST ERROR]', e));
  await cacheBust('cache:filters').catch(e => console.error('[CACHE BUST ERROR]', e));

  // Determine customer email & name
  let customerEmail: string | null = obj.receipt_email || obj.customer_details?.email || obj.shipping?.email || obj.metadata?.customer_email || null;
  let customerName = '';

  if (existingOrder.shipping_data) {
    try {
      const sd = typeof existingOrder.shipping_data === 'string' ? JSON.parse(existingOrder.shipping_data) : existingOrder.shipping_data;
      if (!customerEmail) customerEmail = sd?.email || null;
      customerName = [sd?.firstName, sd?.lastName].filter(Boolean).join(' ');
    } catch {}
  }

  // Send confirmation email
  if (customerEmail) {
    try {
      const attachments: any[] = [];
      if (invoiceRecord && invoiceRecord.pdf_path && fs.existsSync(invoiceRecord.pdf_path)) {
        attachments.push({
          filename: `${invoiceRecord.invoice_number}.pdf`,
          path: invoiceRecord.pdf_path,
          contentType: 'application/pdf',
        });
      }

      await sendTemplatedEmail(
        'order-confirmation',
        customerEmail,
        {
          orderId,
          customerName,
          total: existingOrder.total || 0,
          invoiceNumber: invoiceRecord?.invoice_number,
        },
        { attachments, eventId: evt.id }
      );
      console.log(`[STRIPE WEBHOOK] Correo de confirmación enviado a ${customerEmail} para pedido #${orderId}`);
    } catch (emailErr: any) {
      console.error(`[STRIPE WEBHOOK] Error enviando correo para pedido #${orderId}:`, emailErr.message);
    }
  } else {
    console.warn(`[STRIPE WEBHOOK] No se encontró email del cliente para el pedido #${orderId}`);
  }

  // Server-side tracking (Meta CAPI / GA4)
  try {
    const { sendServerSideEvent } = await import('./server-tracking.js');
    const itemsForTrack = await db.execute(sql`
      SELECT oi.product_id, oi.price, oi.quantity, p.sku, p.name, p.brand
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ${orderId}
    `);
    const totalCents = parseInt(existingOrder.total) || 0;
    const items = (itemsForTrack.rows as any[]).map((it) => ({
      id: it.product_id?.toString(),
      sku: it.sku,
      name: it.name,
      brand: it.brand,
      price: parseFloat((parseInt(it.price) / 100).toFixed(2)),
      quantity: parseInt(it.quantity) || 1,
    }));

    await sendServerSideEvent({
      eventName: 'purchase',
      eventId: evt.id,
      userEmail: customerEmail || undefined,
      payload: {
        currency: 'EUR',
        value: totalCents / 100,
        items,
        content_ids: items.map(i => i.id),
        content_type: 'product',
        num_items: items.length,
        transaction_id: paymentIntentId,
      },
    });
  } catch (trackErr: any) {
    console.error(`[STRIPE WEBHOOK] Tracking server-side falló para pedido #${orderId}:`, trackErr.message);
  }

  // 4. Send iOS Admin Push Notification for new paid order
  try {
    const { sendAdminPushNotification } = await import('./push-notifications.js');
    const totalEur = ((existingOrder.total || 0) / 100).toFixed(2);
    await sendAdminPushNotification({
      title: `🛒 ¡Nuevo Pedido: ${totalEur} €!`,
      body: customerName ? `${customerName} ha realizado el pedido #${orderId}` : `Pedido #${orderId} completado con éxito.`,
      data: { orderId, type: 'new_order' },
      sound: 'default'
    });
  } catch (pushErr: any) {
    console.error(`[STRIPE WEBHOOK] Error enviando notificación push admin para pedido #${orderId}:`, pushErr.message);
  }
}

/**
 * Process failed payment (payment_intent.payment_failed)
 */
async function handlePaymentFailure(evt: Stripe.Event): Promise<void> {
  const paymentIntent = evt.data.object as any;
  const rawOrderId = paymentIntent.metadata?.orderId || paymentIntent.metadata?.order_id;
  let orderId: number | null = rawOrderId ? parseInt(String(rawOrderId), 10) : null;

  if (!orderId && paymentIntent.id) {
    const lookupRes = await db.execute(sql`SELECT id FROM orders WHERE payment_id = ${paymentIntent.id}`);
    if (lookupRes.rows.length > 0) {
      orderId = (lookupRes.rows[0] as any).id;
    }
  }

  if (!orderId || isNaN(orderId)) {
    console.warn(`[STRIPE WEBHOOK] Fallo de pago sin orderId en el evento ${evt.id}`);
    return;
  }

  const errorMessage = paymentIntent.last_payment_error?.message || paymentIntent.cancellation_reason || 'El pago fue rechazado por el emisor';

  await db.execute(sql`
    UPDATE orders
    SET status = 'payment_failed',
        last_payment_error = ${errorMessage}
    WHERE id = ${orderId} AND status IN ('pending', 'payment_failed')
  `);

  console.log(`[STRIPE WEBHOOK] Pedido #${orderId} actualizado a 'payment_failed'. Motivo: ${errorMessage}`);
}

/**
 * Process refund (charge.refunded)
 */
async function handleChargeRefunded(evt: Stripe.Event): Promise<void> {
  const charge = evt.data.object as Stripe.Charge;
  const chargeId = charge.id;
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  const rawOrderId = charge.metadata?.orderId || charge.metadata?.order_id;

  let orderId: number | null = rawOrderId ? parseInt(String(rawOrderId), 10) : null;

  if (!orderId) {
    const lookupRes = await db.execute(sql`
      SELECT id FROM orders WHERE stripe_charge_id = ${chargeId} OR payment_id = ${paymentIntentId || ''}
    `);
    if (lookupRes.rows.length > 0) {
      orderId = (lookupRes.rows[0] as any).id;
    }
  }

  if (!orderId || isNaN(orderId)) {
    console.warn(`[STRIPE WEBHOOK] Evento charge.refunded sin pedido asociado (${chargeId})`);
    return;
  }

  const isFullRefund = charge.amount_refunded >= charge.amount;
  const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update order status to refunded / partially_refunded
    await client.query(
      `UPDATE orders SET status = $1 WHERE id = $2`,
      [newStatus, orderId]
    );

    // Re-stock refunded items into inventory if full refund
    if (isFullRefund) {
      const itemsRes = await client.query(
        `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
        [orderId]
      );

      for (const item of itemsRes.rows) {
        const pId = parseInt(item.product_id, 10);
        const qty = parseInt(item.quantity, 10);
        if (pId && qty > 0) {
          await client.query(
            `UPDATE products SET stock = stock + $1 WHERE id = $2`,
            [qty, pId]
          );
        }
      }
      console.log(`[STRIPE WEBHOOK] Unidades del pedido #${orderId} devueltas al inventario.`);
    }

    await client.query('COMMIT');
    console.log(`[STRIPE WEBHOOK] Pedido #${orderId} marcado como '${newStatus}'.`);
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error(`[STRIPE WEBHOOK ERROR] Error al procesar reembolso del pedido #${orderId}:`, err);
    throw err;
  } finally {
    client.release();
  }

  await cacheBust('cache:products').catch(e => console.error('[CACHE BUST ERROR]', e));
  await cacheBust('cache:filters').catch(e => console.error('[CACHE BUST ERROR]', e));
}
