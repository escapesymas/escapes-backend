/**
 * Calendario de publicaciones para TikTok: slots con hora de publicación,
 * copy e imágenes generadas por IA, y aviso al panel admin cuando toca
 * publicar. No publica solo en TikTok (no hay API pública para eso); el
 * administrador copia el contenido ya preparado y lo sube a mano.
 */
import { pool } from '../db.js';
import { generateCopy, generateImages, productBySku, pickProduct } from './socialContentAI.js';
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

export const FORMATS = ['video', 'photo', 'carousel'];
export const STATUSES = ['draft', 'ready', 'published', 'skipped'];

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
  if (opts.from) { params.push(opts.from); where.push(`c.scheduled_at >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`c.scheduled_at <= $${params.length}`); }
  const r = await pool.query(
    `SELECT c.*, p.name AS product_name, p.brand AS product_brand, p.images->0->>'src' AS product_image
       FROM social_content_calendar c
       LEFT JOIN LATERAL (
         SELECT name, brand, images FROM products
         WHERE c.product_sku IS NOT NULL AND upper(sku) = upper(c.product_sku)
         ORDER BY (duplicate_of IS NULL) DESC LIMIT 1) p ON TRUE
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.scheduled_at ASC`, params);
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

export async function updateSlot(id: number, fields: Partial<Pick<ContentSlot, 'copy' | 'hashtags' | 'script' | 'status' | 'scheduled_at' | 'topic' | 'product_sku' | 'format'>>) {
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return;
  // Si cambia la hora, se vuelve a avisar cuando llegue.
  if ('scheduled_at' in fields) sets.push('notified_at = NULL');
  params.push(id);
  await pool.query(`UPDATE social_content_calendar SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
}

export async function markPublished(id: number) {
  await pool.query(`UPDATE social_content_calendar SET status = 'published', published_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
}

const generatingNow = new Set<number>();

/**
 * Pone el slot en "generando" y genera en segundo plano (el carrusel tarda
 * más de lo que aguanta el proxy). El panel consulta el estado hasta que
 * queda "ready" o vuelve a "draft" con el error.
 */
export async function startSlotGeneration(id: number): Promise<boolean> {
  if (generatingNow.has(id)) return true;
  const { rowCount } = await pool.query(
    `UPDATE social_content_calendar SET status = 'generating', error = NULL, updated_at = NOW()
     WHERE id = $1 AND status <> 'published'`, [id]);
  if (!rowCount) return false;
  generatingNow.add(id);
  generateSlotContent(id)
    .catch((err) => console.error('[SOCIAL CONTENT] generate error:', err.message))
    .finally(() => generatingNow.delete(id));
  return true;
}

/** Genera copy + imágenes para un slot y lo deja en estado "ready". Si falla, vuelve a "draft" con el error. */
async function generateSlotContent(id: number) {
  const { rows: [slot] } = await pool.query('SELECT * FROM social_content_calendar WHERE id = $1', [id]);
  if (!slot) return;
  try {
    // Siempre sobre un producto real: el elegido o uno de las marcas destacadas.
    let product = slot.product_sku ? await productBySku(slot.product_sku) : null;
    if (slot.product_sku && !product) throw new Error(`El producto ${slot.product_sku} no existe o no está publicado`);
    if (!product) product = await pickProduct();

    const copy = await generateCopy({ format: slot.format, topic: slot.topic, product });
    const { urls, notes } = await generateImages({ format: slot.format, topic: slot.topic, script: copy.script, product });
    await pool.query(
      `UPDATE social_content_calendar
         SET copy = $1, hashtags = $2, script = $3, media_urls = $4::jsonb, product_sku = $5,
             status = 'ready', error = $6, updated_at = NOW()
       WHERE id = $7`,
      [[copy.hook, copy.copy].filter(Boolean).join('\n\n'), copy.hashtags, copy.script, JSON.stringify(urls),
        product?.sku || null, notes.length ? notes.join(' ') : null, id]);
  } catch (err: any) {
    await pool.query(
      `UPDATE social_content_calendar SET status = 'draft', error = $1, updated_at = NOW() WHERE id = $2`,
      [`No se pudo generar: ${err.message}. Vuelve a intentarlo en unos minutos.`, id]);
    throw err;
  }
}

/** Al arrancar: lo que se quedó "generando" por un reinicio vuelve a borrador. */
export async function resetInterruptedGenerations() {
  await pool.query(
    `UPDATE social_content_calendar
       SET status = 'draft', error = 'La generación se interrumpió (reinicio del servidor). Vuelve a pulsar Generar.', updated_at = NOW()
     WHERE status = 'generating'`);
}

/** Fecha de hoy en Madrid (año, mes 0-11, día). */
function madridToday(): { y: number; m: number; d: number } {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  return { y, m: m - 1, d };
}

/** Instante UTC de "esta hora en Madrid, este día de calendario" (CET/CEST). */
function madridHourToUtc(y: number, m: number, d: number, hour: number): Date {
  let guess = new Date(Date.UTC(y, m, d, hour, 0, 0));
  const madridHour = parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(guess), 10);
  const diff = hour - madridHour;
  if (diff !== 0) guess = new Date(guess.getTime() + diff * 3600_000);
  return guess;
}

/** Crea los próximos slots vacíos (en borrador) según las horas recomendadas, para N días vista. */
export async function autoScheduleUpcoming(days = 7, formats: string[] = FORMATS) {
  const created: any[] = [];
  const now = new Date();
  const today = madridToday();
  for (let i = 0; i < days; i++) {
    // Día de calendario de Madrid (el día de la semana no depende de la zona).
    const day = new Date(Date.UTC(today.y, today.m, today.d + i, 12));
    const hours = DEFAULT_SLOT_HOURS[day.getUTCDay()] || [20];
    for (let h = 0; h < hours.length; h++) {
      const scheduledAt = madridHourToUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours[h]);
      if (scheduledAt <= now) continue;
      const exists = await pool.query(
        `SELECT 1 FROM social_content_calendar WHERE scheduled_at = $1`, [scheduledAt.toISOString()]);
      if (exists.rows.length) continue;
      const format = formats[h % formats.length];
      created.push(await createSlot({ scheduledAt: scheduledAt.toISOString(), format }));
    }
  }
  return created;
}

/**
 * Cron (cada 5 min):
 * - avisa de cada slot "ready" cuya hora de publicar ha llegado;
 * - una vez al día, a partir de las 10:00 de Madrid, un único resumen con los
 *   huecos de hoy que siguen sin preparar (en lugar de un aviso por hueco).
 */
export async function checkDueSlots() {
  const ready = await pool.query(
    `UPDATE social_content_calendar SET notified_at = NOW()
      WHERE status = 'ready' AND notified_at IS NULL AND scheduled_at <= NOW()
      RETURNING id, format, topic`);
  for (const slot of ready.rows) {
    await sendNotificationToAll({
      title: `🎬 Toca publicar en TikTok · ${slot.format}`,
      body: slot.topic || 'Contenido listo para subir',
      url: adminUrl('social-content', { slot: slot.id }),
      category: 'social_content' as any,
      tag: `social-content-${slot.id}`,
      data: { slotId: slot.id },
    });
  }

  const madridHour = parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(new Date()), 10);
  if (madridHour < 10) return;
  const t = madridToday();
  const todayKey = `${t.y}-${t.m + 1}-${t.d}`;
  // Marca el día antes de enviar (UPSERT condicional): un solo resumen al día aunque se reinicie.
  const { rowCount } = await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('social_content_digest', to_jsonb($1::text), NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value`, [todayKey]);
  if (!rowCount) return;
  const end = madridHourToUtc(t.y, t.m, t.d + 1, 0);
  const { rows: [pending] } = await pool.query(
    `SELECT count(*)::int AS n, min(id) AS first_id FROM social_content_calendar
      WHERE status IN ('draft', 'generating') AND scheduled_at > NOW() AND scheduled_at < $1`, [end.toISOString()]);
  if (!pending?.n) return;
  await sendNotificationToAll({
    title: '📝 Contenido de TikTok por preparar',
    body: pending.n === 1 ? 'Hoy hay 1 publicación sin preparar.' : `Hoy hay ${pending.n} publicaciones sin preparar.`,
    url: adminUrl('social-content', { slot: pending.first_id }),
    category: 'social_content' as any,
    tag: 'social-content-digest',
  });
}
