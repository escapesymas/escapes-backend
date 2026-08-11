-- Migration: 004_stripe_webhook
-- Date: 2026-08-11
-- Purpose: Stripe webhook idempotency log + retry queue.
--
-- stripe_webhook_events:
--   Persists every event_id Stripe delivered (or attempted). When the same
--   event_id arrives again with a non-NULL processed_at, we skip the handler
--   to prevent double-order-finalization, double stock decrement and double
--   confirmation emails.
--
-- stripe_webhook_retry_queue:
--   Holds a copy of the event payload and the next_retry_at timestamp.
--   The retry cron (lib/stripe-webhook.ts processStripeWebhookRetryQueue,
--   called every 5 minutes from index.ts) walks this queue, replays the
--   event through the same handler, and either deletes the row (success)
--   or reschedules it with exponential backoff.
--
-- Stripe guarantees at-least-once delivery, so without these tables a
-- transient DB or SMTP error during the original handler would result in
-- either a duplicated order (silent failure mode) or a lost update
-- (no UI to recover it).
--
-- Safety:
--   - Uses IF NOT EXISTS for idempotency.
--   - CREATE TABLE only — no ALTER on existing tables.
--   - Indexes on event_id (PK lookup) and next_retry_at (cron sweep).

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id       TEXT        PRIMARY KEY,
  event_type     TEXT        NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at   TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processed_at
  ON stripe_webhook_events (processed_at)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS stripe_webhook_retry_queue (
  id             SERIAL      PRIMARY KEY,
  event_id       TEXT        NOT NULL UNIQUE,
  event_type     TEXT        NOT NULL,
  payload        JSONB       NOT NULL,
  attempts       INTEGER     NOT NULL DEFAULT 0,
  last_error     TEXT,
  next_retry_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_retry_queue_due
  ON stripe_webhook_retry_queue (next_retry_at);
