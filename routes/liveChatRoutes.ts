/**
 * Chat con un asesor humano: rutas del cliente (/api/chat/…) y del panel
 * (/api/admin/chats…, /api/admin/support-settings). Lógica en lib/live-chat.ts.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { authenticateRequest } from '../utils.js';
import {
  supportStatus, getSupportSettings, saveSupportSettings, currentConversation, messagesAfter, addMessage,
  closeStaleConversations,
} from '../lib/live-chat.js';
import { notifyLiveChat, sendPushToUser, saveSubscription } from '../pushService.js';
import { sendTemplatedEmail } from '../lib/email.js';

export const liveChatRouter = Router();

const PUBLIC_URL = (process.env.PUBLIC_BASE_URL || 'https://escapesymas.com').replace(/\/$/, '');
const clean = (v: unknown, max = 2000) => String(v ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);

function customer(req: any, res: any): { user_id: number; email?: string } | null {
  const auth = authenticateRequest(req);
  if (!auth?.user_id) {
    res.status(401).json({ error: 'Inicia sesión para hablar con un asesor.' });
    return null;
  }
  return auth;
}

function admin(req: any, res: any): any | null {
  const auth = authenticateRequest(req);
  if (!auth || auth.role !== 'admin') {
    res.status(403).json({ error: 'Solo administradores' });
    return null;
  }
  return auth;
}

async function customerName(userId: number): Promise<{ name: string; email: string }> {
  const { rows } = await pool.query(`SELECT first_name, last_name, email FROM users WHERE id = $1`, [userId]);
  const u = rows[0] || {};
  return { name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || `Cliente ${userId}`, email: u.email || '' };
}

// ── Cliente ──────────────────────────────────────────────────────────────

// GET /api/chat/support-status — ¿hay alguien atendiendo ahora?
liveChatRouter.get('/chat/support-status', async (_req, res) => {
  try {
    res.json(await supportStatus());
  } catch (err: any) {
    console.error('[LIVE CHAT] status:', err.message);
    res.json({ available: false, mode: 'auto', hoursText: '', nextOpen: null, agentName: '' });
  }
});

// GET /api/chat/live?after=ID — conversación con el asesor y mensajes nuevos.
liveChatRouter.get('/chat/live', async (req: any, res: any) => {
  const auth = customer(req, res);
  if (!auth) return;
  try {
    const conv = await currentConversation(auth.user_id);
    if (!conv) return res.json({ conversation: null, messages: [] });
    // Solo cuenta como «en el chat» si tiene la ventana del chat abierta.
    if (req.query.active === '1') {
      await pool.query(`UPDATE chat_conversations SET customer_seen_at = NOW() WHERE id = $1`, [conv.id]);
    }

    // Si nadie ha contestado en 5 minutos, se le avisa una vez de que puede tardar.
    if (conv.status === 'waiting' && Date.now() - new Date(conv.created_at).getTime() > 5 * 60_000) {
      const { rows } = await pool.query(
        `SELECT 1 FROM chat_messages WHERE conversation_id = $1 AND sender = 'system' AND content LIKE 'Seguimos%' LIMIT 1`, [conv.id]);
      if (!rows.length) {
        await addMessage(conv.id, 'system',
          'Seguimos atendiendo otras consultas. Puedes cerrar esta ventana: te responderemos aquí y te avisaremos por email.');
      }
    }
    const after = parseInt(String(req.query.after || '0'), 10) || 0;
    const status = await supportStatus();
    res.json({
      conversation: { id: conv.id, status: conv.status, closedBy: conv.closed_by, agentName: status.agentName },
      messages: await messagesAfter(conv.id, after),
    });
  } catch (err: any) {
    console.error('[LIVE CHAT] live:', err.message);
    res.status(500).json({ error: 'No se pudo cargar la conversación' });
  }
});

// POST /api/chat/handoff { messages } — el cliente pide hablar con un asesor.
liveChatRouter.post('/chat/handoff', async (req: any, res: any) => {
  const auth = customer(req, res);
  if (!auth) return;
  try {
    const status = await supportStatus();
    const existing = await currentConversation(auth.user_id);
    if (existing && existing.status !== 'closed') {
      return res.json({ conversation: { id: existing.id, status: existing.status, agentName: status.agentName } });
    }
    if (!status.available) {
      return res.status(409).json({
        error: `Ahora mismo no hay asesores conectados. Horario: ${status.hoursText}.` +
          `${status.nextOpen ? ` Volvemos ${status.nextOpen}.` : ''} También puedes escribir a info@escapesymas.com.`,
      });
    }

    const { rows: [conv] } = await pool.query(
      `INSERT INTO chat_conversations (user_id) VALUES ($1) RETURNING id, status`, [auth.user_id]);
    // La conversación previa con el asistente, para que el asesor tenga el contexto.
    const transcript: any[] = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20) : [];
    for (const m of transcript) {
      const content = clean(m?.content);
      if (!content || (m?.role !== 'user' && m?.role !== 'assistant')) continue;
      await addMessage(conv.id, m.role === 'user' ? 'customer' : 'ai', content);
    }
    await addMessage(conv.id, 'system', `El cliente ha pedido hablar con un asesor. Te atenderá ${status.agentName} en breve.`);

    const who = await customerName(auth.user_id);
    const lastQuestion = [...transcript].reverse().find((m) => m?.role === 'user');
    notifyLiveChat({
      conversationId: conv.id,
      title: `💬 ${who.name} quiere hablar con un asesor`,
      body: clean(lastQuestion?.content, 160) || 'Nueva conversación en el chat de la web.',
    }).catch(() => {});
    await pool.query(`UPDATE chat_conversations SET last_push_at = NOW() WHERE id = $1`, [conv.id]);
    res.json({ conversation: { id: conv.id, status: conv.status, agentName: status.agentName } });
  } catch (err: any) {
    console.error('[LIVE CHAT] handoff:', err.message);
    res.status(500).json({ error: 'No se pudo avisar al asesor. Escríbenos a info@escapesymas.com.' });
  }
});

// POST /api/chat/live/message { content } — mensaje del cliente al asesor.
liveChatRouter.post('/chat/live/message', async (req: any, res: any) => {
  const auth = customer(req, res);
  if (!auth) return;
  const content = clean(req.body?.content, 1000);
  if (!content) return res.status(400).json({ error: 'Escribe un mensaje.' });
  try {
    const conv = await currentConversation(auth.user_id);
    if (!conv || conv.status === 'closed') return res.status(409).json({ error: 'La conversación ya está cerrada.' });
    const msg = await addMessage(conv.id, 'customer', content);

    // Aviso al móvil con cada mensaje (se agrupan en la notificación de la conversación).
    await pool.query(`UPDATE chat_conversations SET customer_seen_at = NOW(), last_push_at = NOW() WHERE id = $1`, [conv.id]);
    const who = await customerName(auth.user_id);
    notifyLiveChat({ conversationId: conv.id, title: `💬 ${who.name}`, body: content.slice(0, 160) }).catch(() => {});
    res.json({ message: msg });
  } catch (err: any) {
    console.error('[LIVE CHAT] customer message:', err.message);
    res.status(500).json({ error: 'No se pudo enviar el mensaje' });
  }
});

// POST /api/chat/live/close — el cliente termina la conversación.
liveChatRouter.post('/chat/live/close', async (req: any, res: any) => {
  const auth = customer(req, res);
  if (!auth) return;
  try {
    const conv = await currentConversation(auth.user_id);
    if (conv && conv.status !== 'closed') {
      await pool.query(`UPDATE chat_conversations SET status = 'closed', closed_at = NOW(), closed_by = 'customer' WHERE id = $1`, [conv.id]);
      await addMessage(conv.id, 'system', 'El cliente ha cerrado la conversación.');
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[LIVE CHAT] close:', err.message);
    res.status(500).json({ error: 'No se pudo cerrar la conversación' });
  }
});

// POST /api/chat/push/subscribe { subscription } — avisos de respuesta del asesor.
liveChatRouter.post('/chat/push/subscribe', async (req: any, res: any) => {
  const auth = customer(req, res);
  if (!auth) return;
  try {
    await saveSubscription(auth.user_id, req.body?.subscription);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Suscripción inválida' });
  }
});

liveChatRouter.post('/chat/push/unsubscribe', async (req: any, res: any) => {
  const auth = customer(req, res);
  if (!auth) return;
  const endpoint = String(req.body?.endpoint || '');
  if (endpoint) {
    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, auth.user_id]).catch(() => {});
  }
  res.json({ ok: true });
});

// ── Panel de administración ──────────────────────────────────────────────

// GET /api/admin/chats/summary — para el contador del menú.
liveChatRouter.get('/admin/chats/summary', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  try {
    const { rows: [r] } = await pool.query(
      `SELECT count(*) FILTER (WHERE c.status = 'waiting')::int AS waiting,
              count(*) FILTER (WHERE c.status = 'waiting' OR EXISTS (
                SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender = 'customer'
                  AND m.created_at > COALESCE(c.admin_seen_at, 'epoch')))::int AS pending,
              count(*) FILTER (WHERE c.status <> 'closed' AND EXISTS (
                SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender = 'customer'
                  AND m.created_at > COALESCE(c.admin_seen_at, 'epoch')))::int AS unread
       FROM chat_conversations c WHERE c.status <> 'closed'`);
    res.json({ ...r, status: await supportStatus() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/chats?scope=open|closed — lista de conversaciones.
liveChatRouter.get('/admin/chats', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  try {
    await closeStaleConversations();
    const closed = req.query.scope === 'closed';
    const { rows } = await pool.query(
      `SELECT c.id, c.status, c.created_at, c.updated_at, c.closed_by,
              u.id AS user_id, NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), '') AS name, u.email,
              (SELECT content FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender IN ('customer','agent')
                ORDER BY id DESC LIMIT 1) AS last_message,
              (SELECT count(*)::int FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender = 'customer'
                AND m.created_at > COALESCE(c.admin_seen_at, 'epoch')) AS unread
       FROM chat_conversations c LEFT JOIN users u ON u.id = c.user_id
       WHERE ${closed ? `c.status = 'closed'` : `c.status <> 'closed'`}
       ORDER BY ${closed ? 'c.closed_at DESC' : `(c.status = 'waiting') DESC, c.updated_at DESC`}
       LIMIT 100`);
    res.json({ conversations: rows });
  } catch (err: any) {
    console.error('[LIVE CHAT] admin list:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar las conversaciones' });
  }
});

// GET /api/admin/chats/:id?after=ID — conversación, datos del cliente y mensajes.
liveChatRouter.get('/admin/chats/:id', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { rows: [conv] } = await pool.query(
      `UPDATE chat_conversations SET admin_seen_at = NOW() WHERE id = $1
       RETURNING id, user_id, status, created_at, closed_by, customer_seen_at`, [id]);
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
    const after = parseInt(String(req.query.after || '0'), 10) || 0;
    const [messages, who, orders, garage] = await Promise.all([
      messagesAfter(id, after),
      after ? Promise.resolve(null) : customerName(conv.user_id),
      after ? Promise.resolve([]) : pool.query(
        `SELECT id, status, total, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [conv.user_id]).then((r) => r.rows),
      after ? Promise.resolve([]) : pool.query(
        `SELECT brand, model, year FROM garage WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [conv.user_id]).then((r) => r.rows).catch(() => []),
    ]);
    res.json({
      conversation: {
        ...conv,
        customerOnline: Date.now() - new Date(conv.customer_seen_at).getTime() < 45_000,
        customer: who, orders, garage,
      },
      messages,
    });
  } catch (err: any) {
    console.error('[LIVE CHAT] admin get:', err.message);
    res.status(500).json({ error: 'No se pudo cargar la conversación' });
  }
});

// POST /api/admin/chats/:id/message { content } — respuesta del asesor.
liveChatRouter.post('/admin/chats/:id/message', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const content = clean(req.body?.content, 2000);
  if (!Number.isFinite(id) || !content) return res.status(400).json({ error: 'Escribe un mensaje.' });
  try {
    const { rows: [conv] } = await pool.query(
      `UPDATE chat_conversations SET status = CASE WHEN status = 'waiting' THEN 'open' ELSE status END,
              taken_at = COALESCE(taken_at, NOW()), admin_seen_at = NOW()
       WHERE id = $1 AND status <> 'closed'
       RETURNING id, user_id, customer_seen_at, last_email_at`, [id]);
    if (!conv) return res.status(409).json({ error: 'La conversación está cerrada.' });
    const msg = await addMessage(id, 'agent', content);
    const status = await supportStatus();

    // Notificación push al cliente salvo que esté mirando el chat en ese momento.
    if (Date.now() - new Date(conv.customer_seen_at).getTime() > 8_000) {
      sendPushToUser(conv.user_id, {
        title: `${status.agentName} te ha respondido`,
        body: content.slice(0, 180),
        url: '/?chat=1',
        tag: `chat-${id}`,
      }).catch(() => {});
    }

    // Si el cliente ya no tiene el chat abierto, se le avisa por email (como mucho cada 15 min).
    const away = Date.now() - new Date(conv.customer_seen_at).getTime() > 60_000;
    const recentlyEmailed = conv.last_email_at && Date.now() - new Date(conv.last_email_at).getTime() < 15 * 60_000;
    if (away && !recentlyEmailed) {
      const who = await customerName(conv.user_id);
      if (who.email) {
        await pool.query(`UPDATE chat_conversations SET last_email_at = NOW() WHERE id = $1`, [id]);
        sendTemplatedEmail('generic', who.email, {
          subject: 'Te hemos respondido en el chat · Escapes y Más',
          body: `Hola${who.name ? ` ${who.name.split(' ')[0]}` : ''},\n\n${status.agentName} te ha respondido en el chat de la web:\n\n«${content}»\n\nPuedes continuar la conversación desde el chat de escapesymas.com (con tu sesión iniciada).`,
          cta: { label: 'Abrir el chat', url: `${PUBLIC_URL}/?chat=1` },
        }).catch((e) => console.error('[LIVE CHAT] email:', e.message));
      }
    }
    res.json({ message: msg });
  } catch (err: any) {
    console.error('[LIVE CHAT] admin message:', err.message);
    res.status(500).json({ error: 'No se pudo enviar el mensaje' });
  }
});

// POST /api/admin/chats/:id/close — el asesor cierra la conversación.
liveChatRouter.post('/admin/chats/:id/close', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE chat_conversations SET status = 'closed', closed_at = NOW(), closed_by = 'agent' WHERE id = $1 AND status <> 'closed'`, [id]);
    if (rowCount) await addMessage(id, 'system', 'El asesor ha cerrado la conversación. Si necesitas algo más, el asistente sigue disponible.');
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET/PUT /api/admin/support-settings — horario y disponibilidad.
liveChatRouter.get('/admin/support-settings', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  res.json({ settings: await getSupportSettings(), status: await supportStatus() });
});

liveChatRouter.put('/admin/support-settings', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  try {
    const settings = await saveSupportSettings(req.body || {});
    res.json({ settings, status: await supportStatus() });
  } catch (err: any) {
    console.error('[LIVE CHAT] settings:', err.message);
    res.status(500).json({ error: 'No se pudo guardar el horario' });
  }
});
