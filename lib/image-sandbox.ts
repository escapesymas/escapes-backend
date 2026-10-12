/**
 * Cliente del procesador de imágenes aislado (sandbox/): las fotos que suben
 * clientes y asesores, y las de los proveedores, se abren allí y no en este
 * proceso, que tiene la base de datos y las claves. Un archivo preparado para
 * explotar un fallo de las librerías de imagen se encontraría un contenedor
 * sin red, sin secretos y de solo lectura.
 *
 * Aquí nunca se decodifica la imagen: solo se mira su firma (primeros bytes)
 * antes de enviarla y que lo que vuelve sea un WebP.
 */
import http from 'node:http';
import path from 'node:path';

const SOCKET = process.env.IMAGE_SANDBOX_SOCKET || path.join(process.cwd(), 'uploads', '.imgsock', 'imagenes.sock');
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

export type ImageType = 'jpeg' | 'png' | 'webp' | 'gif' | 'heif';

/** La imagen no es válida o no es de un formato admitido (error del cliente). */
export class ImageRejected extends Error {}
/** El procesador no responde o está saturado: reintentar más tarde. */
export class ImageSandboxUnavailable extends Error {}

/** Formato real según los primeros bytes, no según lo que diga quien lo sube. */
export function detectImageType(b: Buffer): ImageType | null {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (/^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  if (b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis)$/.test(b.toString('latin1', 8, 12))) return 'heif';
  return null;
}

export const IMAGE_MIME: Record<ImageType, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heif: 'image/heif',
};

export interface ImageJob {
  /** Ancho máximo (o exacto con ajuste 'cover'). */
  width: number;
  /** Alto: con 'cover' se recorta a ancho × alto; con 'inside', caja máxima. */
  height?: number;
  fit: 'cover' | 'inside';
  quality: number;
  /** Formatos de entrada que se aceptan para este uso. */
  formats: ImageType[];
}

/** Gira según EXIF, redimensiona y devuelve WebP sin metadatos (ubicación, cámara…). */
export function processImage(input: Buffer, job: ImageJob): Promise<{ data: Buffer; width: number; height: number }> {
  const type = detectImageType(input);
  if (!type || !job.formats.includes(type)) return Promise.reject(new ImageRejected('Formato de imagen no admitido'));

  const q = new URLSearchParams({
    ancho: String(job.width),
    ajuste: job.fit,
    calidad: String(job.quality),
    formatos: job.formats.join(','),
  });
  if (job.height) q.set('alto', String(job.height));

  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: SOCKET,
      method: 'POST',
      path: `/procesar?${q}`,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': input.length },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_OUTPUT) req.destroy(new ImageSandboxUnavailable('Respuesta del procesador demasiado grande'));
        else chunks.push(c);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode === 200) {
          const width = Number(res.headers['x-ancho']);
          const height = Number(res.headers['x-alto']);
          if (detectImageType(body) !== 'webp' || !width || !height) {
            return reject(new ImageSandboxUnavailable('El procesador devolvió algo que no es un WebP'));
          }
          return resolve({ data: body, width, height });
        }
        if (res.statusCode === 422 || res.statusCode === 413) return reject(new ImageRejected('Imagen no válida'));
        reject(new ImageSandboxUnavailable(`Procesador de imágenes: HTTP ${res.statusCode}`));
      });
      res.on('error', (e) => reject(new ImageSandboxUnavailable(e.message)));
    });
    req.on('timeout', () => req.destroy(new ImageSandboxUnavailable('El procesador de imágenes no responde')));
    req.on('error', (e) => reject(e instanceof ImageSandboxUnavailable ? e : new ImageSandboxUnavailable(e.message)));
    req.end(input);
  });
}
