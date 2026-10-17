/**
 * Descarga desde el servidor de fotos remotas del catálogo (CDN de Bihr, detrás
 * de Cloudflare). Se manda la misma cabecera que /api/image-proxy: sin ella el
 * CDN puede contestar 403 al «node» por defecto aunque la foto exista.
 */
export const REMOTE_IMAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; EscapesYMas/1.0; +https://escapesymas.com)',
  'Accept': 'image/jpeg,image/png,image/webp,image/*',
};

export const REMOTE_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/**
 * `allowRedirect` (opcional): si se pasa, las redirecciones se siguen a mano y solo
 * a las URL que acepte; sin él se mantiene el comportamiento normal de fetch.
 */
export async function fetchRemoteImage(
  url: string,
  timeoutMs: number,
  opts: { allowRedirect?: (to: URL) => boolean } = {},
): Promise<{ data: Buffer; mime: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  let r: Response;
  for (let hop = 0; ; hop++) {
    r = await fetch(current, { headers: REMOTE_IMAGE_HEADERS, signal, redirect: opts.allowRedirect ? 'manual' : 'follow' });
    if (!opts.allowRedirect || !REDIRECT_STATUS.has(r.status)) break;
    r.body?.cancel().catch(() => {});
    const location = r.headers.get('location');
    if (!location || hop >= MAX_REDIRECTS) throw new Error(`No se pudo descargar la imagen (redirección ${r.status})`);
    const next = new URL(location, current);
    if (!opts.allowRedirect(next)) throw new Error(`No se pudo descargar la imagen (redirección a ${next.host} no permitida)`);
    current = next.toString();
  }
  if (!r.ok) throw new Error(`No se pudo descargar la imagen (${r.status})`);
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > REMOTE_IMAGE_MAX_BYTES) throw new Error('Imagen demasiado grande');
  return { data, mime: r.headers.get('content-type') || 'image/jpeg' };
}
