import { Router } from 'express';
import { requireAdminRole } from '../lib/agent-auth.js';
import {
  listSlots, createSlot, deleteSlot, updateSlot, markPublished,
  startSlotGeneration, autoScheduleUpcoming, FORMATS, STATUSES,
} from '../lib/socialContentCalendar.js';
import { productBySku } from '../lib/socialContentAI.js';

export const socialContentRouter = Router();

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
