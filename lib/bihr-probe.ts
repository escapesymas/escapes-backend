/**
 * Prueba un enlace de foto de Bihr desde ESTE servidor, de varias maneras, para ver qué le contesta el CDN
 * a cada una (un navegador ve la foto y el servidor recibe 404: ¿es por las cabeceras, por la sesión, por la IP?).
 * Solo admite https y los dominios de fotos de Bihr, no sigue redirecciones y no devuelve el contenido, solo
 * el código, el tipo y unas pocas cabeceras.
 */
import { REMOTE_IMAGE_HEADERS } from './remote-image.js';
import { detectImageType } from './image-sandbox.js';

const PROBE_HOSTS = new Set(['api.mybihr.com', 'cdn.mybihr.com', 'bihr.net']);
const PROBE_TIMEOUT_MS = 15_000;
const SNIFF_BYTES = 64 * 1024;
/** Cabeceras de la respuesta que ayudan a saber quién contesta (CDN, caché, redirección). */
const SHOWN_HEADERS = ['server', 'cf-ray', 'cf-cache-status', 'via', 'x-cache', 'location', 'content-length', 'content-type'] as const;

export interface ProbeResult {
  variant: string;
  status?: number;
  contentType?: string;
  /** Bytes leídos (se leen como mucho 64 KB) y si hay más. */
  bytes?: number;
  truncated?: boolean;
  isImage?: boolean;
  headers?: Record<string, string>;
  /** Primeros caracteres si la respuesta es texto (página de error), sin saltos de línea. */
  bodyStart?: string;
  error?: string;
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const BROWSER_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

const VARIANTS: { name: string; headers: Record<string, string> }[] = [
  { name: 'como lo pide ahora el servidor', headers: { ...REMOTE_IMAGE_HEADERS } },
  { name: 'como un navegador, con Referer de Bihr', headers: {
    'User-Agent': BROWSER_UA, Accept: BROWSER_ACCEPT, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    Referer: 'https://www.mybihr.com/', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'same-site',
  } },
  { name: 'como un navegador, sin Referer', headers: { 'User-Agent': BROWSER_UA, Accept: BROWSER_ACCEPT, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' } },
  { name: 'sin ninguna cabecera propia', headers: {} },
];

/** Devuelve la URL si es una foto de Bihr que se puede probar; si no, el motivo. */
export function checkProbeUrl(raw: unknown): { url: URL } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'Falta el enlace' };
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { error: 'El enlace no es válido' }; }
  if (url.protocol !== 'https:' || !PROBE_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    return { error: 'Solo se pueden probar enlaces https de fotos de Bihr (api.mybihr.com)' };
  }
  return { url };
}

async function probeOnce(url: URL, variant: string, headers: Record<string, string>): Promise<ProbeResult> {
  try {
    const r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const out: ProbeResult = { variant, status: r.status, contentType: r.headers.get('content-type') || undefined };
    const shown: Record<string, string> = {};
    for (const h of SHOWN_HEADERS) { const v = r.headers.get(h); if (v) shown[h] = v.slice(0, 200); }
    out.headers = shown;
    const chunks: Buffer[] = [];
    let total = 0;
    if (r.body) {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        total += value.length;
        if (total >= SNIFF_BYTES) { out.truncated = true; await reader.cancel().catch(() => {}); break; }
      }
    }
    const body = Buffer.concat(chunks).subarray(0, SNIFF_BYTES);
    out.bytes = body.length;
    const type = detectImageType(body);
    out.isImage = type === 'jpeg' || type === 'png' || type === 'webp' || type === 'gif';
    if (!out.isImage && /^(text|application\/(json|xml))/i.test(out.contentType || '')) {
      out.bodyStart = body.toString('utf8', 0, 160).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    }
    return out;
  } catch (err: any) {
    return { variant, error: err?.name === 'TimeoutError' ? 'sin respuesta a tiempo' : (err?.cause?.code || err?.message || String(err)) };
  }
}

export async function probeImageUrl(url: URL): Promise<{ url: string; results: ProbeResult[] }> {
  const results: ProbeResult[] = [];
  for (const v of VARIANTS) results.push(await probeOnce(url, v.name, v.headers));
  return { url: `${url.host}${url.pathname}`, results };
}
