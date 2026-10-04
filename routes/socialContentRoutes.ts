import { Router } from 'express';
import { authenticateRequest } from '../utils.js';
import {
  listSlots, createSlot, deleteSlot, updateSlot, markPublished,
  generateSlotContent, autoScheduleUpcoming,
} from '../lib/socialContentCalendar.js';

export const socialContentRouter = Router();

function requireAdmin(req: any, res: any): any | null {
  const auth = authenticateRequest(req);
  if (!auth || auth.role !== 'admin') {
    res.status(403).json({ error: 'Solo administradores' });
    return null;
  }
  return auth;
}

// GET /api/social-content?from=&to=
socialContentRouter.get('/social-content', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const items = await listSlots({ from: req.query.from as string, to: req.query.to as string });
    return res.json({ items });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT LIST ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo leer el calendario' });
  }
});

// POST /api/social-content  { scheduledAt, format, topic?, productSku? }
socialContentRouter.post('/social-content', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { scheduledAt, format, topic, productSku } = req.body || {};
    if (!scheduledAt || !format) return res.status(400).json({ error: 'scheduledAt y format son obligatorios' });
    const slot = await createSlot({ scheduledAt, format, topic, productSku });
    return res.json({ slot });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT CREATE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo crear el slot' });
  }
});

// POST /api/social-content/auto-schedule  { days?, formats? }
socialContentRouter.post('/social-content/auto-schedule', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { days, formats } = req.body || {};
    const created = await autoScheduleUpcoming(days || 7, formats);
    return res.json({ created });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT AUTO SCHEDULE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo generar el calendario' });
  }
});

// POST /api/social-content/:id/generate
socialContentRouter.post('/social-content/:id/generate', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await generateSlotContent(parseInt(req.params.id));
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT GENERATE ERROR]:', err.message);
    return res.status(500).json({ error: err.message || 'No se pudo generar el contenido' });
  }
});

// PATCH /api/social-content/:id  { copy?, hashtags?, script?, status?, scheduledAt?, topic? }
socialContentRouter.patch('/social-content/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { copy, hashtags, script, status, scheduledAt, topic } = req.body || {};
    await updateSlot(parseInt(req.params.id), {
      ...(copy !== undefined && { copy }),
      ...(hashtags !== undefined && { hashtags }),
      ...(script !== undefined && { script }),
      ...(status !== undefined && { status }),
      ...(scheduledAt !== undefined && { scheduled_at: scheduledAt }),
      ...(topic !== undefined && { topic }),
    });
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT UPDATE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo actualizar el slot' });
  }
});

// POST /api/social-content/:id/published
socialContentRouter.post('/social-content/:id/published', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await markPublished(parseInt(req.params.id));
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT PUBLISHED ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo marcar como publicado' });
  }
});

// DELETE /api/social-content/:id
socialContentRouter.delete('/social-content/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await deleteSlot(parseInt(req.params.id));
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[SOCIAL CONTENT DELETE ERROR]:', err.message);
    return res.status(500).json({ error: 'No se pudo borrar el slot' });
  }
});
