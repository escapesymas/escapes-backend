/**
 * Herramientas del chat con asesor (migración 029): transferir o devolver a
 * la cola, respuestas rápidas, resumen y sugerencia de la IA, ficha del cliente
 * con notas internas, fotos del cliente, valoración, «escribiendo…»,
 * estadísticas por asesor y dos tareas automáticas: cierre por inactividad y
 * recordatorio del pedido preparado que no se ha pagado.
 */
import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { pool } from '../db.js';
import { requireAgent, requireAdminRole } from '../lib/agent-auth.js';
import { addMessage, agentNameFor, currentConversation } from '../lib/live-chat.js';
import { notifyLiveChat, sendPushToUser, sendNotificationToAll } from '../pushService.js';
import { sendTemplatedEmail } from '../lib/email.js';
import { minimaxClient, CHAT_MODEL } from '../chatbot/minimax.js';
import { formatOrderNumber } from '../lib/email-templates.js';
import {
  agentFor, customer, customerName, parseId, clean, PAID_STATUSES, CHAT_UPLOAD_DIR, imageUpload,
} from './liveChatRoutes.js';

export const chatToolsRouter = Router();

const PUBLIC_URL = (process.env.PUBLIC_BASE_URL || 'https://escapesymas.com').replace(/\/$/, '');
const eur = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

/** Guarda una imagen del chat recodificada a WebP (sin metadatos como la ubicación). */
async function saveChatImage(buffer: Buffer) {
  const out = await sharp(buffer, { failOn: 'error' }).rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
  await fs.promises.mkdir(CHAT_UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomUUID()}.webp`;
  await fs.promises.writeFile(path.join(CHAT_UPLOAD_DIR, name), out.data);
  return { url: `/uploads/chat/${name}`, width: out.info.width, height: out.info.height };
}

// ── Cliente ──────────────────────────────────────────────────────────────

// POST /api/chat/live/typing — el cliente está escribiendo.
chatToolsRouter.post('/chat/live/typing', async (req: any, res: any) => {
  const auth = customer(req, res);
  if (!auth) return;
  await pool.query(
    `UPDATE chat_conversations SET customer_typing_at = NOW() WHERE user_id = $1 AND status <> 'closed'`, [auth.user_id]).catch(() => {});
  res.json({ ok: true });
});

// POST /api/chat/live/image (multipart «image», «caption») — foto del cliente (su moto, la pieza…).
chatToolsRouter.post('/chat/live/image', (req: any, res: any, next: any) => {
  const auth = customer(req, res);
  if (!auth) return;
  req.customerAuth = auth;
  next();
}, imageUpload.single('image'), async (req: any, res: any) => {
  if (!req.file) return res.status(400).json({ error: 'Falta la imagen (JPG, PNG, WEBP o GIF de hasta 12 MB)' });
  try {
    const conv = await currentConversation(req.customerAuth.user_id);
    if (!conv || conv.status === 'closed') return res.status(409).json({ error: 'La conversación ya está cerrada.' });
    const payload = await saveChatImage(req.file.buffer);
    const caption = clean(req.body?.caption, 300);
    const msg = await addMessage(conv.id, 'customer', caption, 'image', payload);
    await pool.query(`UPDATE chat_conversations SET customer_seen_at = NOW(), inactivity_warned_at = NULL WHERE id = $1`, [conv.id]);
    const who = await customerName(req.customerAuth.user_id);
    notifyLiveChat({ conversationId: conv.id, title: `📷 ${who.name}`, body: caption || 'Te ha enviado una foto', agentUserId: conv.agent_user_id }).catch(() => {});
    res.json({ message: msg });
  } catch (err: any) {
    console.error('[CHAT TOOLS] customer image:', err.message);
    res.status(400).json({ error: 'No se pudo enviar la imagen' });
  }
});

// POST /api/chat/live/rate { rating 1-5, comment } — valoración al cerrar la conversación.
chatToolsRouter.post('/chat/live/rate', async (req: any, res: any) => {
  const auth = customer(req, res);
  if (!auth) return;
  const rating = parseInt(req.body?.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Valoración no válida' });
  const comment = clean(req.body?.comment, 1000) || null;
  try {
    const conv = await currentConversation(auth.user_id);
    if (!conv || conv.status !== 'closed') return res.status(409).json({ error: 'No hay ninguna conversación que valorar' });
    const { rows: [r] } = await pool.query(
      `UPDATE chat_conversations SET rating = $2, rating_comment = $3, rated_at = NOW()
       WHERE id = $1 AND rating IS NULL RETURNING agent_name`, [conv.id, rating, comment]);
    if (r && rating <= 2) {
      const who = await customerName(auth.user_id);
      sendNotificationToAll({
        title: `⭐ ${rating}/5 en el chat de ${who.name}`,
        body: `${r.agent_name ? `Atendió ${r.agent_name}. ` : ''}${comment || 'Sin comentario.'}`.slice(0, 200),
        url: `/?tab=chat&chat=${conv.id}`, category: 'chat',
      }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[CHAT TOOLS] rate:', err.message);
    res.status(500).json({ error: 'No se pudo guardar la valoración' });
  }
});

// ── Asesor: escribiendo, transferir ──────────────────────────────────────

// POST /api/admin/chats/:id/typing — el asesor está escribiendo.
chatToolsRouter.post('/admin/chats/:id/typing', async (req: any, res: any) => {
  const id = parseId(req.params.id);
  if (!id || !(await agentFor(req, res, id))) return;
  await pool.query(`UPDATE chat_conversations SET agent_typing_at = NOW() WHERE id = $1`, [id]).catch(() => {});
  res.json({ ok: true });
});

// GET /api/admin/chat-agents-available — a quién se puede transferir.
chatToolsRouter.get('/admin/chat-agents-available', async (req: any, res: any) => {
  const auth = await requireAgent(req, res);
  if (!auth) return;
  const { rows } = await pool.query(
    `SELECT u.id, u.role, COALESCE(a.online, FALSE) AS online, COALESCE(a.paused, FALSE) AS paused,
            (SELECT count(*)::int FROM chat_conversations c WHERE c.agent_user_id = u.id AND c.status <> 'closed') AS open_chats
     FROM users u LEFT JOIN chat_agents a ON a.user_id = u.id
     WHERE u.role IN ('admin', 'asesor') AND u.id <> $1 ORDER BY a.online DESC NULLS LAST`, [auth.user_id]);
  for (const r of rows) {
    r.name = await agentNameFor(r.id);
    // Un asesor solo atiende un chat a la vez; los administradores, los que quieran.
    r.available = r.online && !r.paused && (r.role === 'admin' || r.open_chats === 0);
  }
  res.json({ agents: rows });
});

// POST /api/admin/chats/:id/transfer { toUserId | null } — pasar a otro asesor o devolver a la cola.
chatToolsRouter.post('/admin/chats/:id/transfer', async (req: any, res: any) => {
  const id = parseId(req.params.id);
  const auth = id ? await agentFor(req, res, id) : null;
  if (!id || !auth) return id ? undefined : res.status(400).json({ error: 'ID inválido' });
  const toUserId = req.body?.toUserId ? parseId(req.body.toUserId) : null;
  try {
    const { rows: [conv] } = await pool.query(`SELECT id, user_id, status FROM chat_conversations WHERE id = $1`, [id]);
    if (!conv || conv.status === 'closed') return res.status(409).json({ error: 'La conversación está cerrada.' });
    if (!toUserId) {
      await pool.query(
        `UPDATE chat_conversations SET agent_user_id = NULL, agent_name = NULL, status = 'waiting', inactivity_warned_at = NULL WHERE id = $1`, [id]);
      await addMessage(id, 'system', 'Te pasamos con otro asesor: enseguida te atienden.');
      const who = await customerName(conv.user_id);
      notifyLiveChat({ conversationId: id, title: `🔁 ${who.name} vuelve a la cola`, body: 'Conversación devuelta por otro asesor.' }).catch(() => {});
      return res.json({ ok: true });
    }
    const { rows: [target] } = await pool.query(
      `SELECT u.id, u.role, (SELECT count(*)::int FROM chat_conversations c WHERE c.agent_user_id = u.id AND c.status <> 'closed' AND c.id <> $2) AS open_chats
       FROM users u WHERE u.id = $1 AND u.role IN ('admin', 'asesor')`, [toUserId, id]);
    if (!target) return res.status(400).json({ error: 'Ese usuario no es asesor' });
    if (target.role === 'asesor' && target.open_chats > 0) return res.status(409).json({ error: 'Ese asesor ya está atendiendo otro chat' });
    const name = await agentNameFor(toUserId);
    await pool.query(
      `UPDATE chat_conversations SET agent_user_id = $2, agent_name = $3, status = 'open', inactivity_warned_at = NULL WHERE id = $1`, [id, toUserId, name]);
    await addMessage(id, 'system', `Te atiende ahora ${name}.`);
    const who = await customerName(conv.user_id);
    notifyLiveChat({ conversationId: id, title: `🔁 Te han pasado el chat de ${who.name}`, body: `De ${await agentNameFor(auth.user_id)}`, agentUserId: toUserId }).catch(() => {});
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[CHAT TOOLS] transfer:', err.message);
    res.status(500).json({ error: 'No se pudo transferir' });
  }
});

// ── Respuestas rápidas ───────────────────────────────────────────────────

// GET /api/admin/quick-replies — las del equipo y las propias.
chatToolsRouter.get('/admin/quick-replies', async (req: any, res: any) => {
  const auth = await requireAgent(req, res);
  if (!auth) return;
  const { rows } = await pool.query(
    `SELECT id, title, body, owner_user_id FROM chat_quick_replies
     WHERE owner_user_id IS NULL OR owner_user_id = $1 ORDER BY (owner_user_id IS NULL) DESC, title`, [auth.user_id]);
  res.json({ replies: rows.map((r: any) => ({ ...r, global: r.owner_user_id == null, editable: r.owner_user_id === auth.user_id || (r.owner_user_id == null && auth.isAdmin) })) });
});

// POST /api/admin/quick-replies { title, body, global } — «global» (para todos) solo administradores.
chatToolsRouter.post('/admin/quick-replies', async (req: any, res: any) => {
  const auth = await requireAgent(req, res);
  if (!auth) return;
  const title = clean(req.body?.title, 60);
  const body = clean(req.body?.body, 2000);
  if (!title || !body) return res.status(400).json({ error: 'Pon un título y el texto' });
  const owner = req.body?.global && auth.isAdmin ? null : auth.user_id;
  const { rows: [r] } = await pool.query(
    `INSERT INTO chat_quick_replies (owner_user_id, title, body) VALUES ($1, $2, $3) RETURNING id, title, body, owner_user_id`, [owner, title, body]);
  res.json({ reply: r });
});

async function canEditReply(id: number, auth: { user_id: number; isAdmin: boolean }) {
  const { rows: [r] } = await pool.query(`SELECT owner_user_id FROM chat_quick_replies WHERE id = $1`, [id]);
  return !!r && (r.owner_user_id === auth.user_id || (r.owner_user_id == null && auth.isAdmin));
}

chatToolsRouter.put('/admin/quick-replies/:id', async (req: any, res: any) => {
  const auth = await requireAgent(req, res);
  if (!auth) return;
  const id = parseId(req.params.id);
  if (!id || !(await canEditReply(id, auth))) return res.status(403).json({ error: 'No puedes editar esta respuesta' });
  const title = clean(req.body?.title, 60);
  const body = clean(req.body?.body, 2000);
  if (!title || !body) return res.status(400).json({ error: 'Pon un título y el texto' });
  await pool.query(`UPDATE chat_quick_replies SET title = $2, body = $3 WHERE id = $1`, [id, title, body]);
  res.json({ ok: true });
});

chatToolsRouter.delete('/admin/quick-replies/:id', async (req: any, res: any) => {
  const auth = await requireAgent(req, res);
  if (!auth) return;
  const id = parseId(req.params.id);
  if (!id || !(await canEditReply(id, auth))) return res.status(403).json({ error: 'No puedes borrar esta respuesta' });
  await pool.query(`DELETE FROM chat_quick_replies WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// ── IA: resumen y sugerencia de respuesta ───────────────────────────────

async function transcript(conversationId: number): Promise<string> {
  const { rows } = await pool.query(
    `SELECT sender, kind, content FROM chat_messages WHERE conversation_id = $1 AND sender <> 'system' ORDER BY id DESC LIMIT 40`,
    [conversationId]);
  const who: Record<string, string> = { customer: 'Cliente', ai: 'Asistente IA', agent: 'Asesor' };
  return rows.reverse().map((m: any) => {
    const extra = m.kind === 'image' ? ' [foto]' : m.kind === 'product' ? ' [tarjeta de producto]' : m.kind === 'order' ? ' [pedido con botón de pago]' : '';
    return `${who[m.sender] || m.sender}: ${m.content || ''}${extra}`;
  }).join('\n');
}

async function askAI(system: string, user: string, maxTokens = 500): Promise<string> {
  const r: any = await minimaxClient.chat.completions.create({
    model: CHAT_MODEL, max_tokens: maxTokens, temperature: 0.3,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    reasoning_split: true,
  } as any);
  return String(r.choices?.[0]?.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]+/g, '')
    .trim();
}

const summarizing = new Set<number>();

/**
 * Resumen para el asesor de lo hablado (sobre todo con la IA). Se guarda con el
 * último mensaje incluido para rehacerlo solo si hay mensajes nuevos.
 */
export async function generateSummary(conversationId: number): Promise<string | null> {
  if (summarizing.has(conversationId)) return null;
  summarizing.add(conversationId);
  try {
    const { rows: [last] } = await pool.query(
      `SELECT max(id)::bigint AS id FROM chat_messages WHERE conversation_id = $1 AND sender <> 'system'`, [conversationId]);
    const text = await transcript(conversationId);
    if (!text || !last?.id) return null;
    const summary = await askAI(
      'Eres el ayudante de los asesores de Escapes y Más, tienda de recambios de moto. Resume la conversación para el asesor que va a atender al cliente: en 3 líneas cortas, qué quiere el cliente, su moto (marca, modelo y año) si se sabe y qué le ha ofrecido o respondido ya el asistente o el asesor. Español, sin títulos ni markdown, máximo 60 palabras.',
      text, 400);
    if (summary) {
      await pool.query(`UPDATE chat_conversations SET summary = $2, summary_msg_id = $3 WHERE id = $1`,
        [conversationId, summary.slice(0, 1000), last.id]);
    }
    return summary || null;
  } catch (err: any) {
    console.error('[CHAT TOOLS] summary:', err.message);
    return null;
  } finally {
    summarizing.delete(conversationId);
  }
}

/** Al abrir una conversación: resumen nuevo si no lo tiene o hay mensajes después del último resumen. */
export async function ensureFreshSummary(conversationId: number) {
  const { rows: [c] } = await pool.query(
    `SELECT c.summary_msg_id,
            (SELECT max(id) FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender <> 'system') AS last_id
     FROM chat_conversations c WHERE c.id = $1`, [conversationId]);
  if (c?.last_id && (!c.summary_msg_id || Number(c.last_id) > Number(c.summary_msg_id))) {
    generateSummary(conversationId).catch(() => {});
  }
}

/**
 * Notas internas que la IA apunta en la ficha del cliente al cerrarse una
 * conversación: lo útil para la próxima vez (moto, preferencias, qué quería o
 * compró, pendientes). Sin datos sensibles y sin repetir las que ya hay.
 */
async function generateCustomerNotes(conversationId: number) {
  const { rows: [conv] } = await pool.query(
    `UPDATE chat_conversations SET notes_ai_at = NOW() WHERE id = $1 AND notes_ai_at IS NULL RETURNING user_id`, [conversationId]);
  if (!conv) return;
  const text = await transcript(conversationId);
  if (!text.includes('Cliente:')) return;
  const { rows: existing } = await pool.query(
    `SELECT body FROM customer_notes WHERE customer_user_id = $1 ORDER BY created_at DESC LIMIT 30`, [conv.user_id]);
  const answer = await askAI(
    'Eres el ayudante de los asesores de Escapes y Más, tienda de recambios de moto. A partir del chat, apunta hasta 3 notas internas ' +
    'útiles para futuras atenciones de este cliente: su moto (marca, modelo y año), preferencias (marcas, presupuesto, uso), qué quería o compró ' +
    'y lo que quedó pendiente o se le prometió. Una nota por línea, que empiece por «- », de 20 palabras como mucho. ' +
    'No apuntes datos sensibles (teléfonos, direcciones, emails, datos de pago, salud) ni saludos o cortesías. ' +
    'No repitas lo que ya dicen las notas existentes. Si no hay nada útil, responde solo: NINGUNA.',
    `Notas existentes:\n${existing.map((n: any) => `- ${n.body}`).join('\n') || '(ninguna)'}\n\nChat:\n${text}`, 500);
  if (!answer || /^\s*NINGUNA/i.test(answer)) return;
  const notes = answer.split('\n')
    .map((l) => l.replace(/^\s*[-•*\d.)]+\s*/, '').trim())
    .filter((l) => l.length >= 4 && !/^NINGUNA/i.test(l))
    .slice(0, 3);
  for (const body of notes) {
    await pool.query(
      `INSERT INTO customer_notes (customer_user_id, author_user_id, author_name, body, source, conversation_id)
       VALUES ($1, NULL, 'IA', $2, 'ia', $3)`, [conv.user_id, body.slice(0, 500), conversationId]);
  }
}

/** Conversaciones cerradas (por quien sea) en los últimos 2 días sin notas de la IA. */
async function customerNotesJob() {
  const { rows } = await pool.query(
    `SELECT id FROM chat_conversations
     WHERE status = 'closed' AND notes_ai_at IS NULL AND closed_at > NOW() - INTERVAL '2 days'
     ORDER BY closed_at LIMIT 5`);
  for (const r of rows) await generateCustomerNotes(r.id);
}

// POST /api/admin/chats/:id/summary — (re)genera el resumen.
chatToolsRouter.post('/admin/chats/:id/summary', async (req: any, res: any) => {
  const id = parseId(req.params.id);
  if (!id || !(await agentFor(req, res, id))) return;
  const summary = await generateSummary(id);
  if (!summary) return res.status(502).json({ error: 'No se pudo generar el resumen' });
  res.json({ summary });
});

// POST /api/admin/chats/:id/suggest — propuesta de respuesta para el asesor (no se envía sola).
chatToolsRouter.post('/admin/chats/:id/suggest', async (req: any, res: any) => {
  const id = parseId(req.params.id);
  const auth = id ? await agentFor(req, res, id) : null;
  if (!id || !auth) return;
  try {
    const text = await transcript(id);
    const name = await agentNameFor(auth.user_id);
    const suggestion = await askAI(
      `Eres ${name}, asesor de Escapes y Más (escapesymas.com), tienda online española de recambios y accesorios de moto. ` +
      'Propón la siguiente respuesta del asesor al cliente: breve (1-3 frases), cercana y profesional, en español de España, sin markdown. ' +
      'No inventes precios, stock ni plazos; si hacen falta datos, pídeselos al cliente. Datos fijos: envío 19,99 € (gratis desde 200 €), ' +
      'preparación en 24-72 h hábiles, devolución en 14 días, garantía de 3 años.',
      `Conversación:\n${text}\n\nEscribe solo la respuesta del asesor.`, 500);
    if (!suggestion) return res.status(502).json({ error: 'No se pudo sugerir una respuesta' });
    res.json({ suggestion });
  } catch (err: any) {
    console.error('[CHAT TOOLS] suggest:', err.message);
    res.status(502).json({ error: 'No se pudo sugerir una respuesta' });
  }
});

// ── Ficha del cliente y notas internas ───────────────────────────────────

// GET /api/admin/chats/:id/profile — conversaciones anteriores, pedidos y notas del cliente.
chatToolsRouter.get('/admin/chats/:id/profile', async (req: any, res: any) => {
  const id = parseId(req.params.id);
  if (!id || !(await agentFor(req, res, id))) return;
  try {
    const { rows: [conv] } = await pool.query(`SELECT user_id FROM chat_conversations WHERE id = $1`, [id]);
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
    const uid = conv.user_id;
    const [user, conversations, orders, notes] = await Promise.all([
      pool.query(`SELECT id, email, first_name, last_name, created_at FROM users WHERE id = $1`, [uid]).then((r) => r.rows[0]),
      pool.query(
        `SELECT c.id, c.created_at, c.status, c.agent_name, c.rating, c.offline,
                (SELECT content FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender = 'customer' ORDER BY id LIMIT 1) AS first_message
         FROM chat_conversations c WHERE c.user_id = $1 AND c.id <> $2 ORDER BY c.created_at DESC LIMIT 20`, [uid, id]).then((r) => r.rows),
      pool.query(`SELECT id, status, total, created_at, sales_channel FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [uid])
        .then((r) => r.rows.map((o: any) => ({ ...o, number: formatOrderNumber(o.id, o.created_at) }))),
      pool.query(`SELECT id, author_user_id, author_name, body, source, created_at FROM customer_notes WHERE customer_user_id = $1 ORDER BY created_at DESC LIMIT 100`, [uid])
        .then((r) => r.rows),
    ]);
    const spent = orders.filter((o: any) => PAID_STATUSES.includes(o.status)).reduce((a: number, o: any) => a + Number(o.total || 0), 0);
    res.json({ user, conversations, orders, notes, spentCents: spent });
  } catch (err: any) {
    console.error('[CHAT TOOLS] profile:', err.message);
    res.status(500).json({ error: 'No se pudo cargar la ficha' });
  }
});

// POST /api/admin/chats/:id/notes { body } — nota interna sobre el cliente.
chatToolsRouter.post('/admin/chats/:id/notes', async (req: any, res: any) => {
  const id = parseId(req.params.id);
  const auth = id ? await agentFor(req, res, id) : null;
  if (!id || !auth) return;
  const body = clean(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'Escribe la nota' });
  const { rows: [conv] } = await pool.query(`SELECT user_id FROM chat_conversations WHERE id = $1`, [id]);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
  const { rows: [note] } = await pool.query(
    `INSERT INTO customer_notes (customer_user_id, author_user_id, author_name, body) VALUES ($1, $2, $3, $4)
     RETURNING id, author_user_id, author_name, body, created_at`, [conv.user_id, auth.user_id, await agentNameFor(auth.user_id), body]);
  res.json({ note });
});

// DELETE /api/admin/chats/:id/notes/:noteId — la borra su autor o un administrador.
chatToolsRouter.delete('/admin/chats/:id/notes/:noteId', async (req: any, res: any) => {
  const id = parseId(req.params.id);
  const auth = id ? await agentFor(req, res, id) : null;
  if (!id || !auth) return;
  const { rowCount } = await pool.query(
    `DELETE FROM customer_notes WHERE id = $1 AND ($2 OR author_user_id = $3 OR source = 'ia')`, [parseId(req.params.noteId) || 0, auth.isAdmin, auth.user_id]);
  if (!rowCount) return res.status(403).json({ error: 'No puedes borrar esta nota' });
  res.json({ ok: true });
});

// ── Estadísticas por asesor (administradores) ────────────────────────────

// GET /api/admin/chat-stats?month=YYYY-MM
chatToolsRouter.get('/admin/chat-stats', async (req: any, res: any) => {
  if (!(await requireAdminRole(req, res))) return;
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
  try {
    const { rows } = await pool.query(
      `WITH conv AS (
         SELECT c.id, c.agent_user_id, c.created_at, c.first_response_at, c.rating
         FROM chat_conversations c
         WHERE c.agent_user_id IS NOT NULL
           AND c.created_at >= ($1 || '-01')::date AND c.created_at < (($1 || '-01')::date + INTERVAL '1 month')),
       sales AS (
         SELECT co.conversation_id, SUM(COALESCE(co.attributed_cents, 0))::int AS revenue, SUM(COALESCE(co.commission_cents, 0))::int AS commission
         FROM chat_orders co JOIN orders o ON o.id = co.order_id
         WHERE o.status = ANY($2::text[]) GROUP BY co.conversation_id)
       SELECT conv.agent_user_id,
              count(*)::int AS attended,
              round(avg(extract(epoch FROM conv.first_response_at - conv.created_at)) FILTER (WHERE conv.first_response_at IS NOT NULL))::int AS avg_first_response_s,
              round(avg(conv.rating)::numeric, 2) AS avg_rating,
              count(conv.rating)::int AS ratings,
              count(s.conversation_id)::int AS converted,
              COALESCE(sum(s.revenue), 0)::int AS revenue,
              COALESCE(sum(s.commission), 0)::int AS commission
       FROM conv LEFT JOIN sales s ON s.conversation_id = conv.id
       GROUP BY conv.agent_user_id ORDER BY attended DESC`,
      [month, PAID_STATUSES]);
    for (const r of rows) {
      r.agent_name = await agentNameFor(r.agent_user_id);
      r.conversion = r.attended ? r.converted / r.attended : 0;
      r.avg_ticket = r.converted ? Math.round(r.revenue / r.converted) : 0;
    }
    const { rows: [w] } = await pool.query(
      `SELECT count(*) FILTER (WHERE agent_user_id IS NULL AND status = 'waiting')::int AS waiting_now,
              count(*) FILTER (WHERE offline)::int AS offline_messages
       FROM chat_conversations WHERE created_at >= ($1 || '-01')::date AND created_at < (($1 || '-01')::date + INTERVAL '1 month')`, [month]);
    res.json({ month, agents: rows, ...w });
  } catch (err: any) {
    console.error('[CHAT TOOLS] stats:', err.message);
    res.status(500).json({ error: 'No se pudieron calcular las estadísticas' });
  }
});

// ── Tareas automáticas ───────────────────────────────────────────────────

const INACTIVITY_WARN_MIN = 10;
const INACTIVITY_CLOSE_MIN = 5;

/**
 * Cierre por inactividad: si el cliente no contesta al asesor en 10 minutos,
 * «¿Sigues ahí?» (con notificación); si sigue sin contestar 5 minutos más, se
 * cierra y el asesor queda libre para el siguiente. No aplica a los mensajes
 * dejados fuera de horario (el cliente puede volver horas después).
 */
async function inactivityJob() {
  const { rows } = await pool.query(
    `SELECT c.id, c.user_id, c.agent_name, c.inactivity_warned_at, c.customer_typing_at,
            (SELECT max(created_at) FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender = 'customer') AS last_customer,
            (SELECT max(created_at) FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender = 'agent') AS last_agent
     FROM chat_conversations c
     WHERE c.status = 'open' AND c.agent_user_id IS NOT NULL AND NOT c.offline`);
  const now = Date.now();
  for (const c of rows) {
    const lastAgent = c.last_agent ? new Date(c.last_agent).getTime() : 0;
    const lastCustomer = c.last_customer ? new Date(c.last_customer).getTime() : 0;
    const typing = c.customer_typing_at && now - new Date(c.customer_typing_at).getTime() < 30_000;
    if (!lastAgent || lastCustomer > lastAgent || typing) continue; // le toca al asesor, o el cliente está escribiendo
    if (!c.inactivity_warned_at && now - lastAgent > INACTIVITY_WARN_MIN * 60_000) {
      const { rowCount } = await pool.query(
        `UPDATE chat_conversations SET inactivity_warned_at = NOW() WHERE id = $1 AND inactivity_warned_at IS NULL`, [c.id]);
      if (!rowCount) continue;
      await addMessage(c.id, 'system', `¿Sigues ahí? Si no respondes en ${INACTIVITY_CLOSE_MIN} minutos cerraremos la conversación (podrás volver a escribirnos cuando quieras).`);
      sendPushToUser(c.user_id, { title: `${c.agent_name || 'Tu asesor'}: ¿sigues ahí?`, body: 'Responde para seguir con tu consulta.', url: '/?chat=1', tag: `chat-${c.id}` }).catch(() => {});
    } else if (c.inactivity_warned_at && now - new Date(c.inactivity_warned_at).getTime() > INACTIVITY_CLOSE_MIN * 60_000) {
      const { rowCount } = await pool.query(
        `UPDATE chat_conversations SET status = 'closed', closed_at = NOW(), closed_by = 'inactivity' WHERE id = $1 AND status = 'open'`, [c.id]);
      if (rowCount) await addMessage(c.id, 'system', 'Hemos cerrado la conversación por inactividad. Si necesitas algo más, escríbenos de nuevo.');
    }
  }
}

/**
 * Recordatorio del pedido preparado en el chat que sigue sin pagar a las 24 h:
 * notificación y email al cliente con el botón de pago, mensaje en la
 * conversación y aviso al asesor. Una sola vez por pedido.
 */
async function unpaidOrdersJob() {
  const { rows } = await pool.query(
    `UPDATE chat_orders co SET reminder_sent_at = NOW()
     FROM chat_orders x LEFT JOIN orders o ON o.id = x.order_id
     WHERE co.id = x.id AND co.reminder_sent_at IS NULL AND co.status <> 'cancelled'
       AND co.created_at < NOW() - INTERVAL '24 hours' AND co.created_at > NOW() - INTERVAL '7 days'
       AND (x.order_id IS NULL OR o.status IN ('pending', 'pending_payment', 'payment_failed'))
     RETURNING co.id, co.user_id, co.conversation_id, co.agent_user_id, co.agent_name, co.token, co.estimate_cents`);
  for (const co of rows) {
    const url = `${PUBLIC_URL}/checkout?propuesta=${co.token}`;
    const total = co.estimate_cents ? ` (${eur(co.estimate_cents)} aprox.)` : '';
    const agent = co.agent_name || 'tu asesor';
    sendPushToUser(co.user_id, {
      title: 'Tu pedido te espera',
      body: `El pedido que te preparó ${agent}${total} sigue disponible. Pulsa para revisar el envío y pagar.`,
      url: `/checkout?propuesta=${co.token}`, tag: `pedido-${co.id}`,
    }).catch(() => {});
    const who = await customerName(co.user_id);
    if (who.email) {
      sendTemplatedEmail('generic', who.email, {
        subject: 'Tu pedido te espera · Escapes y Más',
        body: `Hola${who.name && !who.name.includes('@') ? ` ${who.name.split(' ')[0]}` : ''},\n\n${agent} te preparó un pedido${total} en el chat de escapesymas.com y todavía no lo has completado.\n\nSigue disponible: revisa los datos de envío y págalo cuando quieras desde el botón.`,
        cta: { label: 'Ir al envío y pago', url },
      }).catch((e) => console.error('[CHAT TOOLS] reminder email:', e.message));
    }
    if (co.conversation_id) {
      const { rows: [c] } = await pool.query(`SELECT status FROM chat_conversations WHERE id = $1`, [co.conversation_id]);
      if (c && c.status !== 'closed') await addMessage(co.conversation_id, 'system', 'Te recordamos que tu pedido preparado sigue pendiente de pago.');
      notifyLiveChat({
        conversationId: co.conversation_id, title: `⏰ ${who.name} no ha pagado el pedido`,
        body: `Le hemos enviado un recordatorio${total}.`, agentUserId: co.agent_user_id,
      }).catch(() => {});
    }
  }
}

let started = false;
/** Arranca las tareas automáticas del chat (una vez por proceso). */
export function startChatJobs() {
  if (started) return;
  started = true;
  const run = (name: string, fn: () => Promise<void>) => fn().catch((err) => console.error(`[CHAT JOBS] ${name}:`, err.message));
  setInterval(() => run('inactividad', inactivityJob), 60_000);
  setInterval(() => run('pedidos sin pagar', unpaidOrdersJob), 10 * 60_000);
  setInterval(() => run('notas de la IA', customerNotesJob), 60_000);
  setTimeout(() => run('pedidos sin pagar', unpaidOrdersJob), 60_000);
}
