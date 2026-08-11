-- Migration: 005_email_queue
-- Date: 2026-08-11
-- Purpose: Persistent email send queue + open tracking.
--
-- email_send_queue:
--   Holds email payloads that failed to send in the live process so they
--   can be retried after a restart. lib/email.ts processEmailRetryQueue
--   sweeps this table on a cron interval (1 minute by default), replays
--   each payload through sendEmail, and either deletes the row (success)
--   or reschedules it with exponential backoff. After 10 attempts the
--   row is parked (removed) and logged so an operator can intervene.
--
-- email_open_tracking:
--   One row per message_id. The open pixel at /api/email/track-open hits
--   this table and updates opened_at + open_count. The admin dashboard
--   shows unique opens in the last 24h.
--
-- Both tables use IF NOT EXISTS for idempotency.

CREATE TABLE IF NOT EXISTS email_send_queue (
  id           SERIAL      PRIMARY KEY,
  event_id     TEXT        NOT NULL UNIQUE,
  template     TEXT,
  to_addr      TEXT        NOT NULL,
  subject      TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  last_error   TEXT,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_send_queue_due
  ON email_send_queue (next_retry_at)
  WHERE attempts < 10;

CREATE TABLE IF NOT EXISTS email_open_tracking (
  message_id   TEXT        PRIMARY KEY,
  recipient    TEXT        NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at    TIMESTAMPTZ,
  open_count   INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_email_open_tracking_opened_at
  ON email_open_tracking (opened_at)
  WHERE opened_at IS NOT NULL;
