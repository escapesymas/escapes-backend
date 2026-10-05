import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { requireAdminRole } from '../lib/agent-auth.js';
import {
  listSlots, createSlot, deleteSlot, updateSlot, markPublished,
  startSlotGeneration, autoScheduleUpcoming, addFinalMedia, removeFinalMedia, recomposeSlot, promoForUpload,
  FORMATS, STATUSES,
} from '../lib/socialContentCalendar.js';
import { saveBrandLogo } from '../lib/socialPromo.js';
import { startVideo, VIDEO_MODELS } from '../lib/socialVideo.js';
import { pool } from '../db.js';
import { productBySku } from '../lib/socialContentAI.js';

export const socialContentRouter = Router();

// Imagen o vídeo final hecho con la app de Gemini / Flow (vídeos de móvil: hasta 300 MB).
const FINAL_DIR = path.join(process.cwd(), 'uploads', 'social-content', 'final');
const FINAL_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
};
const finalUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(FINAL_DIR, { recursive: true }); cb(null, FINAL_DIR); },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${FINAL_TYPES[file.mimetype] || 'bin'}`),
  }),
  limits: { fileSize: 300 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, !!FINAL_TYPES[file.mimetype]),
});

const parseId = (v: any) => { const n = parseInt(String(v), 10); return Number.isFinite(n) && n > 0 ? n : null; };
const validDate = (v: any) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const text = (v: any, max: number) => (v == null ? null : String(v).slice(0, max));

// GET /api/social-content?from=&to=
socialContentRouter.get('/social-content', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  try {
    const from = validDate(req.query.from) ? String(req.query.from) : undefined;
    const to = validDate(req.query.to) ? String(req.query.to) : undefined;
    const items = await listSlots({ from, to });
    return res.json({ items });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT LIST ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo leer el calendario' });
  }
});

// POST /api/social-content  { scheduledAt, format, topic?, productSku? }
socialContentRouter.post('/social-content', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  try {
    const { scheduledAt, format, topic, productSku } = req.body || {};
    if (!validDate(scheduledAt) || !FORMATS.includes(format)) {
      return res.status(400).json({ error: 'Indica una fecha válida y el formato (vídeo, foto o carrusel)' });
    }
    if (productSku && !(await productBySku(String(productSku)))) {
      return res.status(400).json({ error: 'Ese producto no existe o no está publicado' });
    }
    const slot = await createSlot({ scheduledAt, format, topic: text(topic, 500) || undefined, productSku: text(productSku, 80) || undefined });
    return res.json({ slot });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT CREATE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo crear la publicación' });
  }
});

// POST /api/social-content/auto-schedule  { days?, formats? }
socialContentRouter.post('/social-content/auto-schedule', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  try {
    const { days, formats } = req.body || {};
    const n = Math.max(1, Math.min(31, parseInt(days, 10) || 7));
    const f = Array.isArray(formats) ? formats.filter((x: any) => FORMATS.includes(x)) : [];
    const created = await autoScheduleUpcoming(n, f.length ? f : undefined);
    return res.json({ created });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT AUTO SCHEDULE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo generar el calendario' });
  }
});

// POST /api/social-content/:id/generate — arranca la generación en segundo plano (202).
socialContentRouter.post('/social-content/:id/generate', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    if (!(await startSlotGeneration(id))) return res.status(404).json({ error: 'Publicación no encontrada o ya publicada' });
    return res.status(202).json({ status: 'generating' });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT GENERATE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo empezar a generar' });
  }
});

// PATCH /api/social-content/:id  { copy?, hashtags?, script?, status?, scheduledAt?, topic?, productSku?, format? }
socialContentRouter.patch('/social-content/:id', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { copy, hashtags, script, status, scheduledAt, topic, productSku, format } = req.body || {};
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'Estado no válido' });
    if (scheduledAt !== undefined && !validDate(scheduledAt)) return res.status(400).json({ error: 'Fecha no válida' });
    if (format !== undefined && !FORMATS.includes(format)) return res.status(400).json({ error: 'Formato no válido' });
    if (productSku && !(await productBySku(String(productSku)))) {
      return res.status(400).json({ error: 'Ese producto no existe o no está publicado' });
    }
    await updateSlot(id, {
      ...(copy !== undefined && { copy: text(copy, 4000) }),
      ...(hashtags !== undefined && { hashtags: text(hashtags, 1000) }),
      ...(script !== undefined && { script: text(script, 6000) }),
      ...(status !== undefined && { status }),
      ...(scheduledAt !== undefined && { scheduled_at: scheduledAt }),
      ...(topic !== undefined && { topic: text(topic, 500) || null }),
      ...(productSku !== undefined && { product_sku: text(productSku, 80) || null }),
      ...(format !== undefined && { format }),
    } as any);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT UPDATE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo guardar' });
  }
});

// POST /api/social-content/:id/final  (multipart, campo "file") — imagen o vídeo final.
socialContentRouter.post('/social-content/:id/final', async (req, res, next) => {
  if (!(await requireAdminRole(req, res))) return;
  next();
}, (req, res, next) => {
  finalUpload.single('file')(req, res, (err: any) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo pasa de 300 MB' : 'No se pudo subir el archivo' });
    next();
  });
}, async (req: any, res) => {
  const id = parseId(req.params.id);
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Sube una imagen (JPG, PNG, WEBP, HEIC) o un vídeo (MP4, MOV, WEBM)' });
  if (!id) { fs.unlink(file.path, () => {}); return res.status(400).json({ error: 'ID inválido' }); }
  try {
    const original = `/uploads/social-content/final/${file.filename}`;
    const type = (file.mimetype.startsWith('video/') ? 'video' : 'image') as 'image' | 'video';
    // Las imágenes llevan los logos de escapesymas.com y de la marca (los vídeos tal cual).
    const url = type === 'image' ? await promoForUpload(id, original) : original;
    const item = { url, type, name: String(file.originalname || file.filename).slice(0, 120), ...(url !== original && { original }) };
    if (!(await addFinalMedia(id, item))) { fs.unlink(file.path, () => {}); return res.status(404).json({ error: 'Publicación no encontrada' }); }
    return res.json({ item });
  } catch (err: any) {
    fs.unlink(file.path, () => {});
    console.error('[SOCIAL CONTENT FINAL ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo guardar el archivo' });
  }
});

// DELETE /api/social-content/:id/final?url=/uploads/social-content/final/...
socialContentRouter.delete('/social-content/:id/final', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  const id = parseId(req.params.id);
  const url = String(req.query.url || '');
  const m = url.match(/^\/uploads\/social-content\/(final|promo|video)\/([\w.-]+)$/);
  if (!id || !m) return res.status(400).json({ error: 'Datos inválidos' });
  try {
    const files = await removeFinalMedia(id, url);
    for (const f of files || []) {
      const local = path.join(process.cwd(), f.replace(/^\/+/, ''));
      if (local.startsWith(path.join(process.cwd(), 'uploads', 'social-content'))) fs.unlink(local, () => {});
    }
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT FINAL DELETE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo quitar el archivo' });
  }
});

// POST /api/social-content/:id/video  { sourceUrl, prompt, model: fast|lite } — vídeo de 8 s con Veo.
socialContentRouter.post('/social-content/:id/video', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  const id = parseId(req.params.id);
  const { sourceUrl, prompt, model } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  if (!VIDEO_MODELS[model]) return res.status(400).json({ error: 'Modelo no válido' });
  const text = String(prompt || '').trim().slice(0, 2000);
  if (text.length < 10) return res.status(400).json({ error: 'Escribe el prompt del vídeo' });
  try {
    // Solo imágenes de la propia publicación (o la foto del producto).
    const { rows: [slot] } = await pool.query(
      `SELECT c.base_media, c.media_urls, c.final_media, p.images->0->>'src' AS product_image
       FROM social_content_calendar c
       LEFT JOIN LATERAL (SELECT images FROM products WHERE upper(sku) = upper(c.product_sku) LIMIT 1) p ON TRUE
       WHERE c.id = $1`, [id]);
    if (!slot) return res.status(404).json({ error: 'Publicación no encontrada' });
    const allowed = new Set<string>([
      ...(slot.base_media || []), ...(slot.media_urls || []), slot.product_image,
      ...(slot.final_media || []).filter((m: any) => m.type === 'image').flatMap((m: any) => [m.url, m.original]),
    ].filter(Boolean));
    if (!allowed.has(String(sourceUrl))) return res.status(400).json({ error: 'Elige una de las imágenes de la publicación' });
    await startVideo(id, { sourceUrl: String(sourceUrl), prompt: text, model });
    return res.status(202).json({ status: 'generating' });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT VIDEO ERROR]:', err.message);
    return res.status(400).json({ error: err.message || 'No se pudo empezar el vídeo' });
  }
});

// POST /api/social-content/:id/recompose — vuelve a poner los logos (sin IA).
socialContentRouter.post('/social-content/:id/recompose', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    const r = await recomposeSlot(id);
    if (!r) return res.status(404).json({ error: 'Publicación no encontrada' });
    return res.json(r);
  } catch (err: any) {
    console.error('[SOCIAL CONTENT RECOMPOSE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudieron poner los logos' });
  }
});

// ---------------------------------------------------------------- logos de marcas

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)),
});

// GET /api/social-content/brand-logos — logos subidos y marcas que los necesitan.
socialContentRouter.get('/social-content/brand-logos', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  try {
    const { rows: logos } = await pool.query(`SELECT brand, url, updated_at FROM brand_logos ORDER BY brand`);
    const { rows: used } = await pool.query(
      `SELECT DISTINCT upper(p.brand) AS brand FROM social_content_calendar c
       JOIN products p ON upper(p.sku) = upper(c.product_sku) WHERE p.brand IS NOT NULL AND p.brand <> ''`);
    // Las marcas de las publicaciones del calendario y las que ya tienen logo.
    const brands = Array.from(new Set([...used.map((u: any) => u.brand), ...logos.map((l: any) => l.brand)])).sort();
    return res.json({ brands: brands.map((b) => ({ brand: b, url: logos.find((l: any) => l.brand === b)?.url || null })) });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT LOGOS ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudieron leer los logos' });
  }
});

// POST /api/social-content/brand-logos  (multipart: brand, file)
socialContentRouter.post('/social-content/brand-logos', async (req, res, next) => {
  if (!(await requireAdminRole(req, res))) return;
  next();
}, (req, res, next) => {
  logoUpload.single('file')(req, res, (err: any) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El logo pasa de 5 MB' : 'No se pudo subir el logo' });
    next();
  });
}, async (req: any, res) => {
  const brand = String(req.body?.brand || '').trim().slice(0, 60);
  if (!brand) return res.status(400).json({ error: 'Indica la marca' });
  if (!req.file) return res.status(400).json({ error: 'Sube el logo en PNG (mejor con fondo transparente), SVG, JPG o WEBP' });
  try {
    const url = await saveBrandLogo(brand, req.file.buffer);
    return res.json({ brand: brand.toUpperCase(), url });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT LOGO SAVE ERROR]:', err.message);
    return res.status(400).json({ error: 'No se pudo leer la imagen del logo' });
  }
});

// DELETE /api/social-content/brand-logos/:brand
socialContentRouter.delete('/social-content/brand-logos/:brand', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  try {
    const { rows: [r] } = await pool.query(`DELETE FROM brand_logos WHERE brand = upper($1) RETURNING url`, [String(req.params.brand).slice(0, 60)]);
    if (r?.url && /^\/uploads\/social-content\/brands\/[\w.-]+$/.test(r.url)) fs.unlink(path.join(process.cwd(), r.url.slice(1)), () => {});
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT LOGO DELETE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo borrar el logo' });
  }
});

// POST /api/social-content/:id/published
socialContentRouter.post('/social-content/:id/published', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    await markPublished(id);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT PUBLISHED ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo marcar como publicado' });
  }
});

// DELETE /api/social-content/:id
socialContentRouter.delete('/social-content/:id', async (req, res) => {
  if (!(await requireAdminRole(req, res))) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    await deleteSlot(id);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT DELETE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo borrar' });
  }
});
