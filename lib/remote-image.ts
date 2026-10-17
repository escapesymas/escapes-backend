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

export async function fetchRemoteImage(url: string, timeoutMs: number): Promise<{ data: Buffer; mime: string }> {
  const r = await fetch(url, { headers: REMOTE_IMAGE_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`No se pudo descargar la imagen (${r.status})`);
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > REMOTE_IMAGE_MAX_BYTES) throw new Error('Imagen demasiado grande');
  return { data, mime: r.headers.get('content-type') || 'image/jpeg' };
}
