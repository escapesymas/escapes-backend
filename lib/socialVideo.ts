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

/**
 * Modelos ofrecidos en el panel. Veo (Gemini, se paga con los créditos de
 * Google Cloud; 8 s con sonido) y Hailuo (MiniMax, entra en su plan; 6 s sin
 * sonido, en 1080p).
 */
export const VIDEO_MODELS: Record<string, string> = {
  fast: 'veo-3.1-fast-generate-preview',
  lite: 'veo-3.1-lite-generate-preview',
  hailuo: 'MiniMax-Hailuo-2.3',
  'hailuo-fast': 'MiniMax-Hailuo-2.3-Fast',
};
const isMinimax = (model: string) => model.startsWith('MiniMax-');
const MINIMAX_BASE = 'https://api.minimax.io/v1';

function minimaxKey(): string {
  const k = process.env.MINIMAX_API_KEY;
  if (!k) throw new Error('MINIMAX_API_KEY no configurada');
  return k;
}

/** Lanza el vídeo en MiniMax (Hailuo) a partir del primer fotograma; devuelve el id de la tarea. */
async function startMinimaxVideo(model: string, prompt: string, frame: { data: string; mime: string }): Promise<string> {
  const res = await fetch(`${MINIMAX_BASE}/video_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${minimaxKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, prompt: prompt.slice(0, 2000), first_frame_image: `data:${frame.mime};base64,${frame.data}`,
      duration: 6, resolution: '1080P', prompt_optimizer: true,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data: any = await res.json().catch(() => ({}));
  const code = data?.base_resp?.status_code;
  if (!res.ok || code !== 0 || !data?.task_id) throw new Error(data?.base_resp?.status_msg || `MiniMax respondió ${res.status}`);
  return data.task_id;
}

/** Estado de una tarea de MiniMax: null si sigue en curso, la URL de descarga si terminó. */
async function pollMinimaxVideo(taskId: string): Promise<string | null> {
  const r = await fetch(`${MINIMAX_BASE}/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${minimaxKey()}` }, signal: AbortSignal.timeout(30_000),
  });
  const d: any = await r.json().catch(() => ({}));
  if (d?.status === 'Fail') throw new Error(d?.base_resp?.status_msg || 'MiniMax no pudo generar el vídeo');
  if (d?.status !== 'Success' || !d?.file_id) return null;
  const f = await fetch(`${MINIMAX_BASE}/files/retrieve?file_id=${encodeURIComponent(d.file_id)}`, {
    headers: { Authorization: `Bearer ${minimaxKey()}` }, signal: AbortSignal.timeout(30_000),
  });
  const fd: any = await f.json().catch(() => ({}));
  const url = fd?.file?.download_url;
  if (!url) throw new Error('MiniMax no devolvió el enlace del vídeo');
  return url;
}

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
    const brand = slot.product_sku ? (await productBySku(slot.product_sku))?.brand || null : null;
    if (isMinimax(model)) {
      const taskId = await startMinimaxVideo(model, prompt, frame);
      await pool.query(`UPDATE social_content_calendar SET video_op = $2, video_brand = $3 WHERE id = $1`, [id, `minimax:${taskId}`, brand]);
      return;
    }
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
    await pool.query(`UPDATE social_content_calendar SET video_op = $2, video_brand = $3 WHERE id = $1`, [id, data.name, brand]);
  } catch (err: any) {
    await pool.query(`UPDATE social_content_calendar SET video_status = 'error', video_error = $2 WHERE id = $1`,
      [id, friendlyError(err.message)]);
    throw err;
  }
}

function friendlyError(msg: string): string {
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(msg)) return 'Sin cuota de Veo en la cuenta de Gemini (revisa la facturación o espera al mes que viene).';
  if (/insufficient balance|balance|usage limit|2056/i.test(msg)) return 'Sin saldo o límite alcanzado en el plan de MiniMax.';
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

/**
 * Vuelve a poner los logos sobre un vídeo ya generado, a partir de su original
 * sin logos (p. ej. tras subir el logo de la marca). Devuelve la nueva ruta o null.
 */
export async function reoverlayVideo(originalUrl: string, brand: string | null): Promise<string | null> {
  const m = originalUrl.match(/^\/uploads\/social-content\/video\/([\w.-]+\.mp4)$/);
  if (!m) return null;
  const raw = path.join(VIDEO_DIR, m[1]);
  if (!fs.existsSync(raw)) return null;
  // Copia con nombre nuevo para que el navegador no muestre el vídeo anterior en caché.
  const copy = path.join(VIDEO_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
  await fs.promises.copyFile(raw, copy);
  const { file, logos } = await overlayLogos(copy, brand);
  fs.unlink(copy, () => {});
  return logos ? `/uploads/social-content/video/${path.basename(file)}` : null;
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
      let downloadUrl: string | null = null;
      let downloadHeaders: Record<string, string> = {};
      if (String(slot.video_op).startsWith('minimax:')) {
        downloadUrl = await pollMinimaxVideo(String(slot.video_op).slice(8));
        if (!downloadUrl) {
          if (Date.now() - new Date(slot.video_started_at).getTime() > TIMEOUT_MIN * 60_000) {
            await pool.query(`UPDATE social_content_calendar SET video_status = 'error', video_error = 'MiniMax tardó demasiado; vuelve a intentarlo.' WHERE id = $1`, [slot.id]);
          }
          continue;
        }
      } else {
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
        downloadUrl = uri;
        downloadHeaders = { 'x-goog-api-key': key() };
      }
      const video = await fetch(downloadUrl!, { headers: downloadHeaders, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!video.ok) throw new Error(`No se pudo descargar el vídeo (${video.status})`);
      await fs.promises.mkdir(VIDEO_DIR, { recursive: true });
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const raw = path.join(VIDEO_DIR, name);
      await fs.promises.writeFile(raw, Buffer.from(await video.arrayBuffer()));
      const { file, logos } = await overlayLogos(raw, slot.video_brand);
      const rel = (f: string) => `/uploads/social-content/video/${path.basename(f)}`;
      const engine = String(slot.video_op).startsWith('minimax:') ? 'Vídeo Hailuo' : 'Vídeo Veo';
      const item = { url: rel(file), type: 'video', name: engine, ...(logos && { original: rel(raw) }) };
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
