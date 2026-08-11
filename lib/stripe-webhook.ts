/**
 * Stripe webhook idempotency + retry wrapper.
 *
 * Two complementary mechanisms to keep the /api/stripe/webhook endpoint
 * trustworthy under Stripe's at-least-once delivery semantics:
 *
 *   1. processStripeEvent(event, handler)
 *      Runs the handler for a Stripe event. If the same event.id has been
 *      successfully processed before, the handler is skipped entirely
 *      (idempotent). If the handler throws, the event is enqueued in
 *      stripe_webhook_retry_queue with exponential backoff so it will be
 *      re-tried by the cron below.
 *
 *   2. processStripeWebhookRetryQueue(handler)
 *      Walks stripe_webhook_retry_queue, picks rows whose next_retry_at
 *      has elapsed, replays them through the handler. On success the row
 *      is removed and the idempotency log is marked processed. On failure
 *      the row is rescheduled with the next backoff bucket (max 5
 *      attempts by default, then the event is parked as failed).
 *
 * The two tables these functions read/write are created by
 * migrations/004_stripe_webhook.ts.
 */

import { db } from '../db.js';
import { sql } from 'drizzle-orm';

export interface StripeEventContext {
  event: any;
  receivedAt: Date;
  /** 1 for the first delivery, 2+ for retries coming out of the queue. */
  attempt: number;
}

export type StripeEventHandler = (ctx: StripeEventContext) => Promise<void>;

export type ProcessResult =
  | { status: 'processed'; durationMs: number }
  | { status: 'duplicate'; processedAt: Date }
  | { status: 'retry'; durationMs: number; error: string; nextRetryAt: Date; attempt: number };

const RETRY_DELAYS_MS = [1000, 5000, 30_000, 120_000, 300_000]; // 1s, 5s, 30s, 2m, 5m

function nextRetryDate(attempt: number): Date {
  const idx = Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1);
  return new Date(Date.now() + RETRY_DELAYS_MS[idx]);
}

/**
 * Idempotency-guarded single-shot handler.
 *
 * Returns:
 *   - { status: 'processed' } on first-time success
 *   - { status: 'duplicate' } if event_id already had a processed_at
 *   - { status: 'retry' }     if the handler threw and the event was queued
 */
export async function processStripeEvent(
  event: any,
  handler: StripeEventHandler,
): Promise<ProcessResult> {
  const eventId: string | undefined = event?.id;
  const eventType: string | undefined = event?.type;
  if (!eventId || !eventType) {
    throw new Error('Stripe event missing id or type');
  }

  // 1. Idempotency lookup
  const lookup = await db.execute(sql`
    SELECT processed_at FROM stripe_webhook_events WHERE event_id = ${eventId}
  `);
  const existing = lookup.rows[0] as any;
  if (existing && existing.processed_at) {
    const processedAt = existing.processed_at instanceof Date
      ? existing.processed_at
      : new Date(existing.processed_at);
    console.log(`[STRIPE WEBHOOK] ${eventId} (${eventType}) already processed at ${processedAt.toISOString()}; skipping`);
    return { status: 'duplicate', processedAt };
  }

  // 2. Record the first receipt of this event_id (idempotent insert).
  await db.execute(sql`
    INSERT INTO stripe_webhook_events (event_id, event_type)
    VALUES (${eventId}, ${eventType})
    ON CONFLICT (event_id) DO NOTHING
  `);

  // 3. Run the handler
  const startTime = Date.now();
  try {
    await handler({ event, receivedAt: new Date(), attempt: 1 });
    const durationMs = Date.now() - startTime;
    await db.execute(sql`
      UPDATE stripe_webhook_events
      SET processed_at = NOW(), last_attempt_at = NOW(), last_error = NULL
      WHERE event_id = ${eventId}
    `);
    console.log(`[STRIPE WEBHOOK] ${eventId} (${eventType}) processed in ${durationMs}ms`);
    return { status: 'processed', durationMs };
  } catch (err: any) {
    const errorMsg = String(err?.message || err);
    const durationMs = Date.now() - startTime;
    const attempt = 1;
    const nextRetryAt = nextRetryDate(attempt);
    await db.execute(sql`
      UPDATE stripe_webhook_events
      SET last_attempt_at = NOW(), last_error = ${errorMsg}
      WHERE event_id = ${eventId}
    `);
    // Upsert on event_id so a retry row never gets duplicated if Stripe
    // re-deliveries interleave with our own retry attempts.
    await db.execute(sql`
      INSERT INTO stripe_webhook_retry_queue (event_id, event_type, payload, attempts, last_error, next_retry_at)
      VALUES (${eventId}, ${eventType}, ${JSON.stringify(event)}, 1, ${errorMsg}, ${nextRetryAt})
      ON CONFLICT (event_id) DO UPDATE
        SET attempts    = stripe_webhook_retry_queue.attempts + 1,
            last_error  = EXCLUDED.last_error,
            next_retry_at = EXCLUDED.next_retry_at
    `);
    console.error(`[STRIPE WEBHOOK] ${eventId} (${eventType}) failed in ${durationMs}ms: ${errorMsg}; retry at ${nextRetryAt.toISOString()}`);
    return { status: 'retry', durationMs, error: errorMsg, nextRetryAt, attempt };
  }
}

/**
 * Walks the retry queue and replays every due event through `handler`.
 *
 * Wired into a 5-minute setInterval from index.ts.
 */
export async function processStripeWebhookRetryQueue(
  handler: StripeEventHandler,
  options: { maxAttempts?: number; batchSize?: number } = {},
): Promise<{ processed: number; failed: number; requeued: number }> {
  const maxAttempts = options.maxAttempts ?? 5;
  const batchSize = options.batchSize ?? 10;

  const due = await db.execute(sql`
    SELECT id, event_id, event_type, payload, attempts
    FROM stripe_webhook_retry_queue
    WHERE next_retry_at <= NOW() AND attempts < ${maxAttempts}
    ORDER BY next_retry_at ASC
    LIMIT ${batchSize}
  `);

  let processed = 0;
  let failed = 0;
  let requeued = 0;

  for (const row of due.rows as any[]) {
    const event = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const attempt = row.attempts + 1;
    try {
      await handler({ event, receivedAt: new Date(), attempt });
      await db.execute(sql`DELETE FROM stripe_webhook_retry_queue WHERE id = ${row.id}`);
      await db.execute(sql`
        UPDATE stripe_webhook_events
        SET processed_at = NOW(), last_attempt_at = NOW(), last_error = NULL
        WHERE event_id = ${row.event_id}
      `);
      processed++;
      console.log(`[STRIPE WEBHOOK RETRY] ${row.event_id} (${row.event_type}) succeeded on attempt ${attempt}`);
    } catch (err: any) {
      const errorMsg = String(err?.message || err);
      if (attempt >= maxAttempts) {
        await db.execute(sql`
          UPDATE stripe_webhook_events
          SET last_attempt_at = NOW(), last_error = ${errorMsg}
          WHERE event_id = ${row.event_id}
        `);
        await db.execute(sql`DELETE FROM stripe_webhook_retry_queue WHERE id = ${row.id}`);
        failed++;
        console.error(`[STRIPE WEBHOOK RETRY] ${row.event_id} permanently failed after ${attempt} attempts: ${errorMsg}`);
      } else {
        const nextRetryAt = nextRetryDate(attempt);
        await db.execute(sql`
          UPDATE stripe_webhook_retry_queue
          SET attempts = ${attempt}, last_error = ${errorMsg}, next_retry_at = ${nextRetryAt}
          WHERE id = ${row.id}
        `);
        requeued++;
        console.warn(`[STRIPE WEBHOOK RETRY] ${row.event_id} attempt ${attempt} failed: ${errorMsg}; retry at ${nextRetryAt.toISOString()}`);
      }
    }
  }

  return { processed, failed, requeued };
}

/**
 * Convenience: snapshot for admin dashboards / debugging.
 */
export async function stripeWebhookStats(): Promise<{
  totalEvents: number;
  processedEvents: number;
  pendingEvents: number;
  retryQueueSize: number;
  oldestPendingAge: string | null;
}> {
  const totalRes = await db.execute(sql`SELECT COUNT(*)::int AS c FROM stripe_webhook_events`);
  const processedRes = await db.execute(sql`SELECT COUNT(*)::int AS c FROM stripe_webhook_events WHERE processed_at IS NOT NULL`);
  const retryRes = await db.execute(sql`SELECT COUNT(*)::int AS c FROM stripe_webhook_retry_queue`);
  const oldestRes = await db.execute(sql`
    SELECT NOW() - MIN(received_at) AS age
    FROM stripe_webhook_events
    WHERE processed_at IS NULL
  `);
  const totalEvents = Number((totalRes.rows[0] as any).c);
  const processedEvents = Number((processedRes.rows[0] as any).c);
  const retryQueueSize = Number((retryRes.rows[0] as any).c);
  const oldestPendingAge = (oldestRes.rows[0] as any)?.age || null;
  return {
    totalEvents,
    processedEvents,
    pendingEvents: totalEvents - processedEvents,
    retryQueueSize,
    oldestPendingAge: oldestPendingAge ? String(oldestPendingAge) : null,
  };
}
