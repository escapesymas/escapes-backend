/**
 * Vídeos de TikTok con Veo (API de Gemini): se anima una de las imágenes de
 * apoyo de la publicación (primer fotograma) con el prompt de vídeo, en
 * vertical 9:16 y 8 segundos. La API trabaja con operaciones de larga duración:
 * se lanza la petición, se guarda el nombre de la operación y un cron la
 * consulta hasta que el vídeo está listo. Al terminar se le ponen encima los
 * logos (ffmpeg) y se añade a los archivos finales de la publicación.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import { pool } from '../db.js';
import { readImage, logoOverlayFile } from './socialPromo.js';
import { productBySku } from './socialContentAI.js';

const run = promisify(execFile);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const VIDEO_DIR = path.join(process.cwd(), 'uploads', 'social-content', 'video');
const TIMEOUT_MIN = 15;

/** Modelos ofrecidos en el panel (precio orientativo por vídeo de 8 s, con audio). */
export const VIDEO_MODELS: Record<string, string> = {
  fast: 'veo-3.1-fast-generate-preview',
  lite: 'veo-3.1-lite-generate-preview',
};

function key(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY no configurada');
  return k;
}

/** Primer fotograma en 9:16: las fotos cuadradas de producto se centran sobre blanco. */
async function firstFrame(src: string): Promise<{ data: string; mime: string }> {
  const input = await readImage(src);
  const meta = await sharp(input).metadata();
  const ratio = (meta.width || 9) / (meta.height || 16);
  const out = ratio > 0.7
    ? await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#ffffff' } })
      .composite([{ input: await sharp(input).flatten({ background: '#ffffff' }).resize({ width: 1000, height: 1000, fit: 'inside' }).png().toBuffer(), gravity: 'centre' }])
      .png().toBuffer()
    : await sharp(input).resize({ width: 1080, height: 1920, fit: 'cover', position: 'attention' }).png().toBuffer();
  return { data: out.toString('base64'), mime: 'image/png' };
}

/** Lanza la generación del vídeo de una publicación. */
export async function startVideo(id: number, opts: { sourceUrl: string; prompt: string; model: string }) {
  const model = VIDEO_MODELS[opts.model] || VIDEO_MODELS.fast;
  const { rows: [slot] } = await pool.query(
    `UPDATE social_content_calendar SET video_status = 'generating', video_error = NULL, video_op = NULL, video_started_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND (video_status IS DISTINCT FROM 'generating' OR video_started_at < NOW() - INTERVAL '${TIMEOUT_MIN} minutes')
     RETURNING product_sku`, [id]);
  if (!slot) throw new Error('Ya se está generando un vídeo para esta publicación');
  try {
    const frame = await firstFrame(opts.sourceUrl);
    const prompt = `${opts.prompt}\nSin texto en pantalla, sin subtítulos y sin añadir logotipos: el producto debe mantener exactamente su forma, colores y marcas.`;
    const res = await fetch(`${GEMINI_BASE}/models/${model}:predictLongRunning?key=${key()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt, image: { bytesBase64Encoded: frame.data, mimeType: frame.mime } }],
        parameters: { aspectRatio: '9:16', durationSeconds: 8 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.name) throw new Error(data?.error?.message || `Veo respondió ${res.status}`);
    const brand = slot.product_sku ? (await productBySku(slot.product_sku))?.brand || null : null;
    await pool.query(`UPDATE social_content_calendar SET video_op = $2, video_brand = $3 WHERE id = $1`, [id, data.name, brand]);
  } catch (err: any) {
    await pool.query(`UPDATE social_content_calendar SET video_status = 'error', video_error = $2 WHERE id = $1`,
      [id, friendlyError(err.message)]);
    throw err;
  }
}

function friendlyError(msg: string): string {
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(msg)) return 'Sin cuota de Veo en la cuenta de Gemini (revisa la facturación o espera al mes que viene).';
  return `No se pudo generar el vídeo: ${String(msg).slice(0, 300)}`;
}

/** Pone los logos encima del vídeo (1080x1920). Si ffmpeg falla, se queda el vídeo sin logos. */
async function overlayLogos(rawFile: string, brand: string | null): Promise<{ file: string; logos: boolean }> {
  const { file: overlay } = await logoOverlayFile(brand);
  const out = rawFile.replace(/\.mp4$/, '-logos.mp4');
  try {
    await run('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', rawFile, '-i', overlay,
      '-filter_complex', '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v];[v][1:v]overlay=0:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', out,
    ], { timeout: 180_000 });
    return { file: out, logos: true };
  } catch (err: any) {
    console.warn('[SOCIAL VIDEO] ffmpeg:', err.message);
    return { file: rawFile, logos: false };
  } finally {
    fs.unlink(overlay, () => {});
  }
}

let polling = false;

/** Cron: consulta las operaciones de Veo pendientes y guarda los vídeos terminados. */
export async function pollVideos() {
  if (polling) return; // la descarga + ffmpeg puede durar más que el intervalo
  polling = true;
  try { await pollVideosOnce(); } finally { polling = false; }
}

async function pollVideosOnce() {
  const { rows } = await pool.query(
    `SELECT id, video_op, video_brand, video_started_at FROM social_content_calendar
     WHERE video_status = 'generating' AND video_op IS NOT NULL ORDER BY video_started_at LIMIT 5`);
  for (const slot of rows) {
    try {
      const res = await fetch(`${GEMINI_BASE}/${slot.video_op}?key=${key()}`, { signal: AbortSignal.timeout(30_000) });
      const op: any = await res.json().catch(() => ({}));
      if (!op.done) {
        if (Date.now() - new Date(slot.video_started_at).getTime() > TIMEOUT_MIN * 60_000) {
          await pool.query(`UPDATE social_content_calendar SET video_status = 'error', video_error = 'Veo tardó demasiado; vuelve a intentarlo.' WHERE id = $1`, [slot.id]);
        }
        continue;
      }
      if (op.error) throw new Error(op.error.message || 'Veo devolvió un error');
      const resp = op.response?.generateVideoResponse || op.response || {};
      const uri = resp.generatedSamples?.[0]?.video?.uri;
      if (!uri) {
        const reason = (resp.raiMediaFilteredReasons || []).join(' ');
        throw new Error(reason ? `Veo lo bloqueó por sus filtros: ${reason}` : 'Veo no devolvió vídeo');
      }
      const video = await fetch(uri, { headers: { 'x-goog-api-key': key() }, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!video.ok) throw new Error(`No se pudo descargar el vídeo (${video.status})`);
      await fs.promises.mkdir(VIDEO_DIR, { recursive: true });
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const raw = path.join(VIDEO_DIR, name);
      await fs.promises.writeFile(raw, Buffer.from(await video.arrayBuffer()));
      const { file, logos } = await overlayLogos(raw, slot.video_brand);
      const rel = (f: string) => `/uploads/social-content/video/${path.basename(f)}`;
      const item = { url: rel(file), type: 'video', name: 'Vídeo Veo', ...(logos && { original: rel(raw) }) };
      await pool.query(
        `UPDATE social_content_calendar
           SET final_media = final_media || $2::jsonb, video_status = 'done', video_op = NULL,
               status = CASE WHEN status IN ('draft', 'skipped') THEN 'ready' ELSE status END, updated_at = NOW()
         WHERE id = $1`, [slot.id, JSON.stringify([item])]);
    } catch (err: any) {
      console.error('[SOCIAL VIDEO] slot', slot.id, err.message);
      await pool.query(`UPDATE social_content_calendar SET video_status = 'error', video_op = NULL, video_error = $2 WHERE id = $1`,
        [slot.id, friendlyError(err.message)]);
    }
  }
}
