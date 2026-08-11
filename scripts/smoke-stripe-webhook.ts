/**
 * Smoke test for lib/stripe-webhook.ts.
 * Run: DATABASE_URL="postgresql://adrian@/escapes_test?host=/tmp&port=5433" \
 *      npx tsx scripts/smoke-stripe-webhook.ts
 */

import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  processStripeEvent,
  processStripeWebhookRetryQueue,
  stripeWebhookStats,
} from '../lib/stripe-webhook.js';

const TEST_EVENT_ID = 'evt_smoke_test_' + Date.now();
const TEST_EVENT_TYPE = 'payment_intent.succeeded';

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error('✗ FAIL:', msg);
    process.exit(1);
  } else {
    console.log('✓', msg);
  }
}

async function main() {
  // Clean slate
  await db.execute(sql`DELETE FROM stripe_webhook_events WHERE event_id = ${TEST_EVENT_ID}`);
  await db.execute(sql`DELETE FROM stripe_webhook_retry_queue WHERE event_id = ${TEST_EVENT_ID}`);

  // 1. First run should succeed
  let handlerCalls = 0;
  const handler = async (ctx: any) => {
    handlerCalls++;
    console.log(`  handler called (attempt=${ctx.attempt})`);
  };

  const event = { id: TEST_EVENT_ID, type: TEST_EVENT_TYPE, data: { object: { id: 'pi_test' } } };
  const r1 = await processStripeEvent(event, handler);
  assert(r1.status === 'processed', 'first delivery → processed');
  assert(handlerCalls === 1, 'handler invoked exactly once');

  // 2. Second delivery of the same event_id should be skipped
  const r2 = await processStripeEvent(event, handler);
  assert(r2.status === 'duplicate', 'duplicate delivery → duplicate');
  assert(handlerCalls === 1, 'handler not invoked on duplicate');

  // 3. Failing handler should enqueue a retry
  const FAULT_ID = 'evt_smoke_fault_' + Date.now();
  const failingEvent = { id: FAULT_ID, type: TEST_EVENT_TYPE, data: { object: { id: 'pi_fail' } } };
  let failCalls = 0;
  const failHandler = async (_ctx: any) => {
    failCalls++;
    throw new Error('simulated SMTP failure');
  };
  const r3 = await processStripeEvent(failingEvent, failHandler);
  assert(r3.status === 'retry', 'failing handler → retry');
  assert(r3.error === 'simulated SMTP failure', 'error message captured');
  assert(typeof r3.nextRetryAt === 'object', 'nextRetryAt returned');

  const queueRow = (await db.execute(sql`
    SELECT attempts, last_error FROM stripe_webhook_retry_queue WHERE event_id = ${FAULT_ID}
  `)).rows[0] as any;
  assert(queueRow?.attempts === 1, 'retry queue row created with attempts=1');
  assert(queueRow?.last_error === 'simulated SMTP failure', 'last_error persisted');

  // 4. Force next_retry_at to NOW so the cron sweep picks it up
  await db.execute(sql`UPDATE stripe_webhook_retry_queue SET next_retry_at = NOW() WHERE event_id = ${FAULT_ID}`);

  // 5. Handler that succeeds on retry → cron should remove the row.
  // The wrapper passes attempt = row.attempts + 1, so a row with attempts=1
  // is replayed with attempt=2 (the second delivery overall).
  const retryHandler = async (ctx: any) => {
    console.log(`  retry handler invoked with attempt=${ctx.attempt}`);
  };

  const sweep1 = await processStripeWebhookRetryQueue(retryHandler, { maxAttempts: 5, batchSize: 10 });
  console.log('  sweep1:', sweep1);
  assert(sweep1.processed === 1, 'first sweep processed (handler succeeded on attempt 2)');

  const stillQueued = (await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM stripe_webhook_retry_queue WHERE event_id = ${FAULT_ID}
  `)).rows[0] as any;
  assert(Number(stillQueued.c) === 0, 'retry queue row removed after success');

  // 5b. Failing retry path: a handler that keeps failing should be rescheduled
  // until maxAttempts, then parked.
  const PERSIST_ID = 'evt_smoke_persist_' + Date.now();
  const persistEvent = { id: PERSIST_ID, type: TEST_EVENT_TYPE, data: { object: { id: 'pi_persist' } } };
  await processStripeEvent(persistEvent, async () => { throw new Error('persistent failure'); });
  await db.execute(sql`UPDATE stripe_webhook_retry_queue SET next_retry_at = NOW(), attempts = 0 WHERE event_id = ${PERSIST_ID}`);

  const alwaysFailHandler = async () => { throw new Error('persistent failure'); };
  for (let i = 0; i < 5; i++) {
    await db.execute(sql`UPDATE stripe_webhook_retry_queue SET next_retry_at = NOW() WHERE event_id = ${PERSIST_ID}`);
    const r = await processStripeWebhookRetryQueue(alwaysFailHandler, { maxAttempts: 5, batchSize: 10 });
    console.log(`  persist sweep ${i + 1}:`, r);
  }
  const persistFinal = (await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM stripe_webhook_retry_queue WHERE event_id = ${PERSIST_ID}
  `)).rows[0] as any;
  assert(Number(persistFinal.c) === 0, 'persist row parked + removed after maxAttempts');
  await db.execute(sql`DELETE FROM stripe_webhook_events WHERE event_id = ${PERSIST_ID}`);

  // 6. Stats endpoint
  const stats = await stripeWebhookStats();
  console.log('  stats:', stats);
  assert(stats.totalEvents >= 2, 'stats.totalEvents >= 2');
  assert(stats.processedEvents >= 2, 'stats.processedEvents >= 2');

  // 7. maxAttempts enforcement: a row that keeps failing should be parked
  const PARK_ID = 'evt_smoke_park_' + Date.now();
  const parkEvent = { id: PARK_ID, type: 'payment_intent.payment_failed', data: { object: { id: 'pi_park' } } };
  await processStripeEvent(parkEvent, async () => { throw new Error('permanent boom'); });
  await db.execute(sql`UPDATE stripe_webhook_retry_queue SET next_retry_at = NOW(), attempts = 4 WHERE event_id = ${PARK_ID}`);

  const parkHandler = async () => { throw new Error('permanent boom'); };
  const sweep3 = await processStripeWebhookRetryQueue(parkHandler, { maxAttempts: 5, batchSize: 10 });
  console.log('  sweep3 (park):', sweep3);
  assert(sweep3.failed === 1, 'fifth attempt (attempt=5) marked as failed');

  const parkedRow = (await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM stripe_webhook_retry_queue WHERE event_id = ${PARK_ID}
  `)).rows[0] as any;
  assert(Number(parkedRow.c) === 0, 'parked row removed from retry queue');

  // Cleanup
  await db.execute(sql`DELETE FROM stripe_webhook_events WHERE event_id IN (${TEST_EVENT_ID}, ${FAULT_ID}, ${PARK_ID})`);

  console.log('\n✓ ALL SMOKE TESTS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
