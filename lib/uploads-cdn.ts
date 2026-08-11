/**
 * CDN URL rewriter for locally-served product images.
 *
 * Strategy: dual-write. The image downloader continues to write WebPs to
 * `/uploads/optimized/...` on local disk, and this helper rewrites those
 * paths to the Bunny CDN pull-zone URL when the operator has configured
 * the environment. If the env vars are absent (dev, staging, or pre-CDN),
 * the helper returns the local path unchanged, so existing local serving
 * via `app.use('/uploads', ...)` keeps working without modification.
 *
 * To enable:
 *   1. Create a Bunny CDN Storage Zone + Pull Zone that points at it.
 *      (https://bunny.net/ → Storage → Add Storage Zone; CDN → Add Pull Zone,
 *       set the pull zone's "Origin URL" to your Storage Zone FTP endpoint.)
 *   2. Sync `/uploads/` into the Storage Zone. Easiest: use rclone with the
 *      Bunny Storage FTP/SFTP endpoint, or `bunnycdn-storage-cli`:
 *          rclone sync /app/server/uploads storage-bunny:/escapes-uploads
 *      Schedule via cron or systemd timer (e.g. every 5 minutes).
 *   3. Set the env vars:
 *          BUNNY_STORAGE_ZONE=escapes-uploads
 *          BUNNY_PULL_ZONE_HOSTNAME=escapes.b-cdn.net
 *          BUNNY_API_KEY=your-storage-zone-password   (only needed for uploads)
 *      BUNNY_API_KEY is NOT required for read serving — it's only needed
 *      when this helper is extended to also push new uploads.
 *
 * Cutover is instant once the Storage Zone is populated: change the env
 * vars and the next request returns CDN URLs.
 *
 * Why Bunny over Cloudflare:
 *   - Cheaper at this volume (Bunny charges per GB served, no egress fees
 *     on EU storage zones — ~$0.01/GB vs Cloudflare's $0.05/GB+ on Images).
 *   - Pull-zone model means no code-side migration: configure once, every
 *     existing /uploads path is mirrored automatically by the Bunny edge.
 *   - Includes free origin shield, hot-link protection, and a token-based
 *     access system if we ever need to lock down URLs.
 *
 * Cloudflare Images is more feature-rich (variants, signed URLs) but we
 * already produce variants server-side via Sharp, so we don't pay for the
 * image transformation service.
 */

const PULL_ZONE_HOSTNAME = (process.env.BUNNY_PULL_ZONE_HOSTNAME || '').replace(/\/+$/, '');

export function cdnUrl(localPath: string | null | undefined): string {
  if (!localPath) return localPath || '';
  // Only rewrite absolute paths that point at our own uploads directory.
  // Anything else (full URLs, /api/image-proxy, placeholders, data URIs) is
  // returned untouched — those still need to go through the backend.
  if (typeof localPath !== 'string') return String(localPath);
  if (!localPath.startsWith('/uploads/')) return localPath;
  // Fallback: no CDN configured yet — keep serving from local disk via
  // `app.use('/uploads', express.static(...))`.
  if (!PULL_ZONE_HOSTNAME) return localPath;
  return `https://${PULL_ZONE_HOSTNAME}${localPath}`;
}

/**
 * True when the helper will rewrite paths to the CDN. Useful for log
 * banners on boot and for the reindex/admin endpoints that want to know
 * whether the cache layer is active.
 */
export function isCdnEnabled(): boolean {
  return Boolean(PULL_ZONE_HOSTNAME);
}

/**
 * For startup logging so the operator can see at a glance whether the CDN
 * is active and what hostname to expect.
 */
export function cdnBanner(): string {
  if (!PULL_ZONE_HOSTNAME) {
    return '[CDN] disabled — BUNNY_PULL_ZONE_HOSTNAME not set, serving /uploads from local disk';
  }
  return `[CDN] enabled — rewriting /uploads/** to https://${PULL_ZONE_HOSTNAME}/**`;
}