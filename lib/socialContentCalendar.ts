/**
 * Calendario de publicaciones para TikTok: slots con hora de publicación,
 * copy e imágenes generadas por IA, y aviso al panel admin cuando toca
 * publicar. No publica solo en TikTok (no hay API pública para eso); el
 * administrador copia el contenido ya preparado y lo sube a mano.
 */
import { pool } from '../db.js';
import { generateFullContent } from './socialContentAI.js';
import { sendNotificationToAll, adminUrl } from '../pushService.js';

export interface ContentSlot {
  id: number;
  scheduled_at: string;
  format: 'video' | 'photo' | 'carousel';
  topic: string | null;
  product_sku: string | null;
  copy: string | null;
  hashtags: string | null;
  script: string | null;
  media_urls: string[];
  status: 'draft' | 'generating' | 'ready' | 'published' | 'skipped';
  error: string | null;
  notified_at: string | null;
  published_at: string | null;
}

/** Horas recomendadas para el nicho moto en España: tarde-noche entre semana,
 * media mañana el fin de semana (antes de salir a rodar). Punto de partida;
 * ajustar si se conectan analíticas reales de la cuenta. */
export const DEFAULT_SLOT_HOURS: Record<number, number[]> = {
  0: [11, 20],        // domingo
  1: [20],            // lunes
  2: [13, 21],        // martes
  3: [20],            // miércoles
  4: [13, 21],        // jueves
  5: [20, 22],        // viernes
  6: [11, 13, 20],    // sábado
};

export async function listSlots(opts: { from?: string; to?: string } = {}): Promise<ContentSlot[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.from) { params.push(opts.from); where.push(`scheduled_at >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`scheduled_at <= $${params.length}`); }
  const r = await pool.query(
    `SELECT * FROM social_content_calendar
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY scheduled_at ASC`, params);
  return r.rows;
}

export async function createSlot(input: { scheduledAt: string; format: string; topic?: string; productSku?: string }) {
  const r = await pool.query(
    `INSERT INTO social_content_calendar (scheduled_at, format, topic, product_sku)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.scheduledAt, input.format, input.topic || null, input.productSku || null]);
  return r.rows[0];
}

export async function deleteSlot(id: number) {
  await pool.query('DELETE FROM social_content_calendar WHERE id = $1', [id]);
}

export async function updateSlot(id: number, fields: Partial<Pick<ContentSlot, 'copy' | 'hashtags' | 'script' | 'status' | 'scheduled_at' | 'topic'>>) {
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(id);
  await pool.query(`UPDATE social_content_calendar SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
}

export async function markPublished(id: number) {
  await pool.query(`UPDATE social_content_calendar SET status = 'published', published_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
}

/** Genera copy + imágenes para un slot y lo deja en estado "ready". Nunca lanza: guarda el error en el slot. */
export async function generateSlotContent(id: number) {
  const { rows } = await pool.query('SELECT * FROM social_content_calendar WHERE id = $1', [id]);
  const slot = rows[0];
  if (!slot) throw new Error('Slot no encontrado');

  await pool.query(`UPDATE social_content_calendar SET status = 'generating', error = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  try {
    const { copy, mediaUrls } = await generateFullContent({ format: slot.format, topic: slot.topic, productSku: slot.product_sku });
    await pool.query(
      `UPDATE social_content_calendar
         SET copy = $1, hashtags = $2, script = $3, media_urls = $4::jsonb, status = 'ready', updated_at = NOW()
       WHERE id = $5`,
      [`${copy.hook}\n\n${copy.copy}`, copy.hashtags, copy.script, JSON.stringify(mediaUrls), id]);
  } catch (err: any) {
    console.error('[SOCIAL CONTENT] generate error:', err.message);
    await pool.query(`UPDATE social_content_calendar SET status = 'draft', error = $1, updated_at = NOW() WHERE id = $2`, [err.message, id]);
    throw err;
  }
}

/** Crea los próximos slots vacíos (en borrador) según las horas recomendadas, para N días vista. */
export async function autoScheduleUpcoming(days = 7, formats: string[] = ['video', 'photo', 'carousel']) {
  const created: any[] = [];
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    const hours = DEFAULT_SLOT_HOURS[date.getDay()] || [20];
    for (let i = 0; i < hours.length; i++) {
      const scheduledAt = new Date(date);
      scheduledAt.setHours(hours[i], 0, 0, 0);
      if (scheduledAt <= now) continue;
      const exists = await pool.query(
        `SELECT 1 FROM social_content_calendar WHERE scheduled_at = $1`, [scheduledAt.toISOString()]);
      if (exists.rows.length) continue;
      const format = formats[i % formats.length];
      created.push(await createSlot({ scheduledAt: scheduledAt.toISOString(), format }));
    }
  }
  return created;
}

/**
 * Cron: avisa al panel admin de los slots "ready" cuya hora de publicar ya
 * ha llegado (y aún no se ha avisado), y de los "draft"/"generating" que se
 * han quedado atascados cerca de su hora para que alguien los revise a mano.
 */
export async function checkDueSlots() {
  const now = new Date();
  const soon = new Date(now.getTime() + 15 * 60_000);

  const ready = await pool.query(
    `SELECT * FROM social_content_calendar
      WHERE status = 'ready' AND notified_at IS NULL AND scheduled_at <= $1`, [now.toISOString()]);
  for (const slot of ready.rows) {
    await sendNotificationToAll({
      title: `🎬 Toca publicar en TikTok · ${slot.format}`,
      body: slot.topic || 'Contenido listo para subir',
      url: adminUrl('social-content', { slot: slot.id }),
      category: 'social_content' as any,
      tag: `social-content-${slot.id}`,
      data: { slotId: slot.id },
    });
    await pool.query(`UPDATE social_content_calendar SET notified_at = NOW() WHERE id = $1`, [slot.id]);
  }

  const stuck = await pool.query(
    `SELECT * FROM social_content_calendar
      WHERE status IN ('draft', 'generating') AND notified_at IS NULL AND scheduled_at <= $1`, [soon.toISOString()]);
  for (const slot of stuck.rows) {
    await sendNotificationToAll({
      title: `⚠️ Contenido de TikTok sin preparar`,
      body: `Faltan menos de 15 min para publicar y el contenido no está listo (${slot.format}).`,
      url: adminUrl('social-content', { slot: slot.id }),
      category: 'social_content' as any,
      tag: `social-content-${slot.id}-stuck`,
      data: { slotId: slot.id },
    });
    await pool.query(`UPDATE social_content_calendar SET notified_at = NOW() WHERE id = $1`, [slot.id]);
  }
}
