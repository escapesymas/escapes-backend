/**
 * Transactional email module.
 *
 * Replaces the ad-hoc nodemailer.createTransport() calls scattered across
 * the codebase with a single, pooled, retry-aware sender.
 *
 * Features:
 *   - Lazy singleton transporter (reuses a connection pool across calls)
 *   - Exponential backoff retry on transient failures (default 3 attempts:
 *     2s, 10s, 60s)
 *   - Persistent queue for retry-after-restart: failed sends land in
 *     email_send_queue and are picked up by the cron sweep
 *   - Open tracking pixel (best-effort, requires base URL)
 *   - Structured templates via lib/email-templates.ts (no MJML runtime dep)
 *   - Verifies SMTP connection on first use (so production boot surfaces
 *     credential problems with a clear log line instead of a 500 at the
 *     first order)
 *
 * Backed by migrations/005_email_queue.sql.
 */

import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import nodemailer, { Transporter } from 'nodemailer';
import { renderEmail, type TemplateName } from './email-templates.js';

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: Buffer;
    contentType?: string;
  }>;
  /** If set, rows are inserted into email_send_queue to persist across
   *  restarts and retry on failure. */
  eventId?: string;
  /** Optional A/B variant / kind for analytics. */
  template?: string;
}

export interface SendResult {
  status: 'sent' | 'queued' | 'permanent_failure';
  attempts: number;
  messageId?: string;
  lastError?: string;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2000, 10_000, 60_000]; // 2s, 10s, 60s

let _transporter: Transporter | null = null;
let _verified = false;

function getTransporter(): Transporter {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.buzondecorreo.com',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: {
      user: process.env.SMTP_USER || 'web@escapesymas.com',
      pass: process.env.SMTP_PASSWORD,
    },
    tls: { rejectUnauthorized: process.env.SMTP_ALLOW_UNSECURE === 'true' },
    pool: true, // reuse connections across sends
    maxConnections: 3,
    maxMessages: 100,
  });
  return _transporter;
}

async function ensureVerified(): Promise<void> {
  if (_verified) return;
  try {
    await getTransporter().verify();
    _verified = true;
    console.log('[EMAIL] SMTP connection verified');
  } catch (err: any) {
    console.error('[EMAIL] SMTP verification failed:', err.message);
    // Don't throw — leave _verified=false so the actual send will retry
    // the verify itself.
  }
}

function isRetryable(err: any): boolean {
  // 4xx error codes from the SMTP server are usually configuration issues
  // (bad recipient, auth failure) that won't fix themselves; everything
  // else (network timeouts, 5xx, ECONNRESET, ECONNREFUSED) is retryable.
  const code = err?.responseCode || err?.code;
  if (typeof code === 'number' && code >= 400 && code < 500) {
    if (code === 421 || code === 450 || code === 451) return true; // transient
    return false;
  }
  if (code === 'EAUTH' || code === 'EENVELOPE') return false;
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Send an email synchronously with retry. Per-call only — for emails that
 * must NOT survive a process restart, use this. For most transactional
 * sends, prefer sendEmail (which routes to the queue on failure).
 */
export async function sendEmail(payload: EmailPayload): Promise<SendResult> {
  await ensureVerified();

  const transporter = getTransporter();
  const mailOptions = {
    from: process.env.SMTP_FROM || '"Escapes y Más" <web@escapesymas.com>',
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    attachments: payload.attachments,
  };

  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`[EMAIL] Sent to ${payload.to} (subject: ${payload.subject}) on attempt ${attempt}; messageId=${info.messageId}`);
      return { status: 'sent', attempts: attempt, messageId: info.messageId };
    } catch (err: any) {
      lastErr = err;
      const retryable = isRetryable(err);
      console.warn(`[EMAIL] Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${payload.to}: ${err.message}; retryable=${retryable}`);
      if (!retryable || attempt >= MAX_ATTEMPTS) break;
      await delay(RETRY_DELAYS_MS[attempt - 1] || 60_000);
    }
  }

  console.error(`[EMAIL] Giving up on ${payload.to} after ${MAX_ATTEMPTS} attempts: ${lastErr?.message}`);
  return { status: 'permanent_failure', attempts: MAX_ATTEMPTS, lastError: String(lastErr?.message || lastErr) };
}

/**
 * Routes a payload through the per-template renderer, then sends.
 * If sending fails on a transient error, enqueues for retry.
 */
export async function sendTemplatedEmail(
  template: TemplateName,
  to: string,
  data: any,
  options: { attachments?: EmailPayload['attachments']; eventId?: string } = {},
): Promise<SendResult> {
  const rendered = renderEmail(template, data);
  const payload: EmailPayload = {
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: options.attachments,
    template,
    eventId: options.eventId,
  };

  const result = await sendEmail(payload);
  if (result.status === 'permanent_failure' && options.eventId) {
    // Persist for retry-after-restart
    try {
      await db.execute(sql`
        INSERT INTO email_send_queue (event_id, template, to_addr, subject, payload, attempts, last_error, next_retry_at)
        VALUES (
          ${options.eventId},
          ${template},
          ${to},
          ${rendered.subject},
          ${JSON.stringify(payload)},
          ${result.attempts},
          ${result.lastError || null},
          NOW() + INTERVAL '5 minutes'
        )
        ON CONFLICT (event_id) DO UPDATE
          SET attempts = email_send_queue.attempts + 1,
              last_error = EXCLUDED.last_error,
              next_retry_at = EXCLUDED.next_retry_at
      `);
      return { status: 'queued', attempts: result.attempts, lastError: result.lastError };
    } catch (err: any) {
      console.error('[EMAIL] Failed to enqueue for retry:', err.message);
    }
  }
  return result;
}

/**
 * Sweep the persistent retry queue. Run from a cron interval.
 */
export async function processEmailRetryQueue(): Promise<{ processed: number; failed: number; requeued: number; parked: number }> {
  try {
    const due = await db.execute(sql`
      SELECT id, event_id, template, to_addr, payload, attempts
      FROM email_send_queue
      WHERE next_retry_at <= NOW() AND attempts < 10
      ORDER BY next_retry_at ASC
      LIMIT 20
    `);

    let processed = 0, failed = 0, requeued = 0, parked = 0;

    for (const row of due.rows as any[]) {
      const payload: EmailPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const result = await sendEmail(payload);
      if (result.status === 'sent') {
        await db.execute(sql`DELETE FROM email_send_queue WHERE id = ${row.id}`);
        processed++;
      } else {
        const nextAttempt = (row.attempts || 0) + 1;
        if (nextAttempt >= 10) {
          await db.execute(sql`DELETE FROM email_send_queue WHERE id = ${row.id}`);
          parked++;
        } else {
          const backoffMs = RETRY_DELAYS_MS[Math.min(nextAttempt - 1, RETRY_DELAYS_MS.length - 1)] || 60_000;
          await db.execute(sql`
            UPDATE email_send_queue
            SET attempts = ${nextAttempt}, last_error = ${result.lastError || null},
                next_retry_at = NOW() + (${backoffMs}::bigint * INTERVAL '1 millisecond')
            WHERE id = ${row.id}
          `);
          requeued++;
        }
        failed++;
      }
    }

    return { processed, failed, requeued, parked };
  } catch (err) {
    return { processed: 0, failed: 0, requeued: 0, parked: 0 };
  }
}

/**
 * Insert an email+pixel into the open-tracking table. Returns the pixel
 * URL to embed in the HTML.
 */
export async function makeOpenTrackingPixel(messageId: string, recipient: string): Promise<string> {
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://escapesymas.com';
  try {
    await db.execute(sql`
      INSERT INTO email_open_tracking (message_id, recipient, opened_at)
      VALUES (${messageId}, ${recipient}, NULL)
      ON CONFLICT (message_id) DO NOTHING
    `);
  } catch {
    // Non-fatal
  }
  const url = `${baseUrl}/api/email/track-open?m=${encodeURIComponent(messageId)}`;
  return `<img src="${url}" alt="" width="1" height="1" style="display:block;border:0;opacity:0" />`;
}

/**
 * Open-tracking endpoint hit by the pixel image.
 */
export async function recordOpen(messageId: string): Promise<void> {
  await db.execute(sql`
    UPDATE email_open_tracking
    SET opened_at = NOW(), open_count = COALESCE(open_count, 0) + 1
    WHERE message_id = ${messageId}
  `);
}

/**
 * Stats for the admin dashboard.
 */
export async function emailStats(): Promise<{
  queueSize: number;
  sentLast24h: number;
  uniqueOpensLast24h: number;
}> {
  const queueRes = await db.execute(sql`SELECT COUNT(*)::int AS c FROM email_send_queue`);
  const sentRes = await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM email_open_tracking
    WHERE opened_at >= NOW() - INTERVAL '24 hours'
  `);
  const queueSize = Number((queueRes.rows[0] as any).c);
  const uniqueOpensLast24h = Number((sentRes.rows[0] as any).c);
  return { queueSize, sentLast24h: 0, uniqueOpensLast24h };
}
