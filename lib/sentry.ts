import * as Sentry from '@sentry/node';

/**
 * Sentry is initialized lazily and only when SENTRY_DSN is set. This keeps
 * the production boot path free of side effects when no DSN is configured
 * (local dev, staging without observability) and lets us add the import
 * unconditionally — the init() guard makes it a no-op.
 *
 * What we capture:
 *   - Unhandled promise rejections and uncaught exceptions (process.on hooks)
 *   - Express request handlers that throw or respond with 5xx (via captureError)
 *   - Manual Sentry.captureException calls from places that already swallow errors
 *
 * What we do NOT capture:
 *   - 4xx client errors (those are user/input problems, not bugs)
 *   - Image-downloader expected failures (404 zips, unsupported image format)
 *   - Bihr rate-limit 429s
 *
 * To enable: set SENTRY_DSN in the environment. The container's release tag
 * (SOURCE_COMMIT) is attached so each alert tells you which commit introduced
 * a regression.
 */
let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Silent: it's perfectly fine to run without Sentry (local dev).
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SOURCE_COMMIT || undefined,
    // We have a lot of expected downstream noise (Bihr 429s, image 404s).
    // Drop transactions for known-noisy paths and keep errors at 100% — we
    // want every 5xx to land in Sentry.
    tracesSampleRate: 0,
    ignoreErrors: [
      // Bihr rate limiting
      'Bihr API rate limit',
      // Image downloader expected failures
      'unsupported image format',
      'Input buffer contains unsupported image format',
      'BRAND-FAIL',
      'Range fetch failed',
      'inflate failed',
    ],
    beforeSend(event) {
      // Strip the request body — it often contains JWTs or admin keys and we
      // don't want those leaking into a third-party service.
      if (event.request?.data) {
        event.request.data = '[REDACTED]';
      }
      return event;
    },
  });
  initialized = true;
  // Hook global error sinks so we don't silently lose crashes during
  // background work (cron-like bootstraps, image regen child process, etc.).
  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    Sentry.captureException(err);
    // Don't exit — let the process supervisor (Docker) decide. The Coolify
    // healthcheck will catch true unrecoverable states.
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });
}

/** Mark whether Sentry is wired in — useful for health endpoints and tests. */
export function isSentryEnabled(): boolean {
  return initialized;
}

/** Convenience wrapper so call sites don't import @sentry/node directly. */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  if (context) {
    Sentry.withScope((scope) => {
      for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
      Sentry.captureException(err);
    });
  } else {
    Sentry.captureException(err);
  }
}

/** Express error-handler middleware. Mount AFTER all routes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sentryErrorHandler(): (err: any, _req: any, res: any, next: any) => void {
  return (err, _req, res, next) => {
    if (!initialized) {
      // No Sentry configured — just delegate so Express's default handler
      // can still send a 500 to the client.
      return next(err);
    }
    // Only capture server errors, not client errors that happen to throw.
    const status = Number(err?.status) || 500;
    if (status >= 500) {
      Sentry.captureException(err);
    }
    next(err);
  };
}