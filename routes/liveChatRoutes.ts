/**
 * Chat con un asesor humano: rutas del cliente (/api/chat/…) y del panel
 * (/api/admin/chats…, /api/admin/support-settings). Lógica en lib/live-chat.ts.
 */
import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import sharp from 'sharp';
import { pool } from '../db.js';
import { authenticateRequest } from '../utils.js';
import {
  supportStatus, getSupportSettings, saveSupportSettings, currentConversation, messagesAfter, addMessage,
  closeStaleConversations, agentNameFor, setAgentName, welcomeText, DEFAULT_WELCOME, type ChatMessageKind,
} from '../lib/live-chat.js';
import { quoteOrder } from '../lib/order-pricing.js';
import { formatOrderNumber } from '../lib/email-templates.js';
import { searchTerms } from '../lib/catalog-query.js';
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
      conversation: { id: conv.id, status: conv.status, closedBy: conv.closed_by, agentName: conv.agent_name || status.agentName },
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
    await addMessage(conv.id, 'system', 'Has pedido hablar con un asesor. Te atenderemos en breve.');

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

// GET /api/chat/proposal/:token — productos del pedido preparado por el asesor (para el checkout).
liveChatRouter.get('/chat/proposal/:token', async (req: any, res: any) => {
  const token = String(req.params.token || '');
  if (!/^[0-9a-f-]{36}$/i.test(token)) return res.status(404).json({ error: 'Pedido no encontrado' });
  try {
    const { rows: [co] } = await pool.query(
      `SELECT co.id, co.items, co.agent_name, co.status, co.order_id, o.status AS order_status
       FROM chat_orders co LEFT JOIN orders o ON o.id = co.order_id WHERE co.token = $1`, [token]);
    if (!co || co.status === 'cancelled') return res.status(404).json({ error: 'Este pedido ya no está disponible' });
    if (co.order_id && PAID_STATUSES.includes(co.order_status)) return res.status(409).json({ error: 'Este pedido ya está pagado' });
    const items = (await Promise.all((co.items || []).map(async (i: any) => {
      const card = await productCard(parseInt(i.id, 10));
      return card ? { ...card, quantity: Math.max(1, Math.min(99, parseInt(i.quantity, 10) || 1)) } : null;
    }))).filter(Boolean);
    if (!items.length) return res.status(409).json({ error: 'Los productos de este pedido ya no están disponibles' });
    res.json({ agentName: co.agent_name, items });
  } catch (err: any) {
    console.error('[LIVE CHAT] proposal:', err.message);
    res.status(500).json({ error: 'No se pudo cargar el pedido' });
  }
});

/**
 * Al crear el pedido en el checkout con una propuesta del chat: queda ligado al
 * asesor que la preparó (comisiones) y se avisa en la conversación. Nunca lanza.
 */
export async function linkChatOrder(token: string, orderId: number, userId: number | null) {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(token) || !userId) return;
    const { rows: [co] } = await pool.query(
      `UPDATE chat_orders SET order_id = $2, status = 'ordered', updated_at = NOW()
       WHERE token = $1 AND user_id = $3 AND status <> 'cancelled'
       RETURNING id, conversation_id, agent_user_id`, [token, orderId, userId]);
    if (!co) return;
    const { rows: [o] } = await pool.query(
      `UPDATE orders SET created_by_user_id = $2, sales_channel = 'chat', chat_order_id = $3 WHERE id = $1
       RETURNING total, created_at`, [orderId, co.agent_user_id, co.id]);
    if (co.conversation_id) {
      const num = formatOrderNumber(orderId, o?.created_at);
      await addMessage(co.conversation_id, 'system', `🧾 Pedido ${num} creado (${((o?.total || 0) / 100).toFixed(2).replace('.', ',')} €), pendiente de pago.`);
      notifyLiveChat({ conversationId: co.conversation_id, title: `🧾 Pedido ${num} creado desde el chat`, body: 'El cliente está en la pasarela de pago.' }).catch(() => {});
    }
  } catch (err: any) {
    console.error('[LIVE CHAT] link order:', err.message);
  }
}

/** Pedido del chat pagado: aviso en la conversación y al panel. Nunca lanza. */
export async function chatOrderPaid(orderId: number) {
  try {
    const { rows: [o] } = await pool.query(
      `SELECT o.total, o.created_at, co.conversation_id FROM orders o JOIN chat_orders co ON co.id = o.chat_order_id
       WHERE o.id = $1`, [orderId]);
    if (!o?.conversation_id) return;
    const num = formatOrderNumber(orderId, o.created_at);
    await addMessage(o.conversation_id, 'system', `✅ Pedido ${num} pagado. ¡Gracias por tu compra!`);
    notifyLiveChat({ conversationId: o.conversation_id, title: `✅ Pedido ${num} pagado (chat)`, body: `${(Number(o.total) / 100).toFixed(2).replace('.', ',')} €` }).catch(() => {});
  } catch (err: any) {
    console.error('[LIVE CHAT] order paid:', err.message);
  }
}

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
      `SELECT c.id, c.status, c.created_at, c.updated_at, c.closed_by, c.agent_name,
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
       RETURNING id, user_id, status, created_at, closed_by, customer_seen_at, agent_user_id, agent_name`, [id]);
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

// ── Mensajes del asesor ──────────────────────────────────────────────────

const ORDER_STATUS_ES: Record<string, string> = {
  pending: 'pendiente de pago', pending_payment: 'pendiente de pago', payment_failed: 'pago fallido',
  payment_amount_mismatch: 'en revisión', paid: 'pagado', processing: 'en preparación', shipped: 'enviado',
  delivered: 'entregado', completed: 'completado', cancelled: 'cancelado', refunded: 'reembolsado',
  partially_refunded: 'reembolso parcial',
};
const PAID_STATUSES = ['paid', 'processing', 'shipped', 'delivered', 'completed', 'partially_refunded'];

/**
 * Asigna la conversación al asesor si aún no la atiende nadie y envía la
 * bienvenida con su nombre. Devuelve la bienvenida (si se ha enviado).
 */
async function ensureTaken(conversationId: number, adminUserId: number) {
  const name = await agentNameFor(adminUserId);
  const { rows: [conv] } = await pool.query(
    `UPDATE chat_conversations SET agent_user_id = $2, agent_name = $3, status = 'open', taken_at = COALESCE(taken_at, NOW())
     WHERE id = $1 AND status <> 'closed' AND agent_user_id IS NULL
     RETURNING id, user_id`, [conversationId, adminUserId, name]);
  if (!conv) return null;
  const settings = await getSupportSettings();
  const who = await customerName(conv.user_id);
  const firstName = who.name.includes('@') ? '' : who.name.split(' ')[0];
  return addMessage(conversationId, 'agent', welcomeText(settings.welcomeTemplate || DEFAULT_WELCOME, firstName, name));
}

/** Avisa al cliente de un mensaje del asesor: push si no está mirando y email si se ha ido. */
async function notifyCustomer(conv: any, agentName: string, preview: string) {
  const sinceSeen = Date.now() - new Date(conv.customer_seen_at).getTime();
  if (sinceSeen > 8_000) {
    sendPushToUser(conv.user_id, {
      title: `${agentName} te ha respondido`, body: preview.slice(0, 180), url: '/?chat=1', tag: `chat-${conv.id}`,
    }).catch(() => {});
  }
  const recentlyEmailed = conv.last_email_at && Date.now() - new Date(conv.last_email_at).getTime() < 15 * 60_000;
  if (sinceSeen > 60_000 && !recentlyEmailed) {
    const who = await customerName(conv.user_id);
    if (!who.email) return;
    await pool.query(`UPDATE chat_conversations SET last_email_at = NOW() WHERE id = $1`, [conv.id]);
    sendTemplatedEmail('generic', who.email, {
      subject: 'Te hemos respondido en el chat · Escapes y Más',
      body: `Hola${who.name && !who.name.includes('@') ? ` ${who.name.split(' ')[0]}` : ''},\n\n${agentName} te ha respondido en el chat de la web:\n\n«${preview}»\n\nPuedes continuar la conversación desde el chat de escapesymas.com (con tu sesión iniciada).`,
      cta: { label: 'Abrir el chat', url: `${PUBLIC_URL}/?chat=1` },
    }).catch((e) => console.error('[LIVE CHAT] email:', e.message));
  }
}

/** Mensaje del asesor de cualquier tipo (texto, producto, imagen o pedido). */
async function agentSend(
  conversationId: number, adminUserId: number, kind: ChatMessageKind, content: string, payload: any, preview: string,
) {
  const welcome = await ensureTaken(conversationId, adminUserId);
  const { rows: [conv] } = await pool.query(
    `UPDATE chat_conversations SET admin_seen_at = NOW() WHERE id = $1 AND status <> 'closed'
     RETURNING id, user_id, agent_name, customer_seen_at, last_email_at`, [conversationId]);
  if (!conv) return null;
  const msg = await addMessage(conversationId, 'agent', content, kind, payload);
  const agentName = conv.agent_name || await agentNameFor(adminUserId);
  notifyCustomer(conv, agentName, preview).catch(() => {});
  return { messages: welcome ? [welcome, msg] : [msg] };
}

/** Tarjeta de producto con el precio que paga el cliente (céntimos). */
async function productCard(productId: number) {
  const { rows: [p] } = await pool.query(
    `SELECT id, sku, name, brand, price, sale_price, promo_price, stock, images->0->>'src' AS image
     FROM products WHERE id = $1 AND status = 'published' AND price > 0`, [productId]);
  if (!p) return null;
  const price = Number(p.price);
  const eff = Number(p.promo_price) > 0 ? Number(p.promo_price)
    : Math.min(price, Number(p.sale_price) > 0 ? Number(p.sale_price) : price);
  return {
    id: p.id, sku: p.sku, name: p.name, brand: p.brand || '', price, sale_price: eff < price ? eff : null,
    stock: Number(p.stock) || 0, image: p.image || null, slug: p.sku, in_stock: Number(p.stock) > 0,
  };
}

const parseId = (v: unknown) => { const n = parseInt(String(v), 10); return Number.isFinite(n) && n > 0 ? n : null; };

// POST /api/admin/chats/:id/take — atender: se asigna al asesor y se envía la bienvenida.
liveChatRouter.post('/admin/chats/:id/take', async (req: any, res: any) => {
  const auth = admin(req, res);
  const id = parseId(req.params.id);
  if (!auth || !id) return auth && res.status(400).json({ error: 'ID inválido' });
  try {
    const welcome = await ensureTaken(id, auth.user_id);
    if (welcome) {
      const { rows: [conv] } = await pool.query(
        `SELECT id, user_id, agent_name, customer_seen_at, last_email_at FROM chat_conversations WHERE id = $1`, [id]);
      notifyCustomer(conv, conv.agent_name, welcome.content).catch(() => {});
    }
    res.json({ messages: welcome ? [welcome] : [] });
  } catch (err: any) {
    console.error('[LIVE CHAT] take:', err.message);
    res.status(500).json({ error: 'No se pudo atender la conversación' });
  }
});

// POST /api/admin/chats/:id/message { content } — respuesta del asesor.
liveChatRouter.post('/admin/chats/:id/message', async (req: any, res: any) => {
  const auth = admin(req, res);
  if (!auth) return;
  const id = parseId(req.params.id);
  const content = clean(req.body?.content, 2000);
  if (!id || !content) return res.status(400).json({ error: 'Escribe un mensaje.' });
  try {
    const out = await agentSend(id, auth.user_id, 'text', content, null, content);
    if (!out) return res.status(409).json({ error: 'La conversación está cerrada.' });
    res.json(out);
  } catch (err: any) {
    console.error('[LIVE CHAT] admin message:', err.message);
    res.status(500).json({ error: 'No se pudo enviar el mensaje' });
  }
});

// POST /api/admin/chats/:id/product { productId } — tarjeta de producto.
liveChatRouter.post('/admin/chats/:id/product', async (req: any, res: any) => {
  const auth = admin(req, res);
  if (!auth) return;
  const id = parseId(req.params.id);
  const productId = parseId(req.body?.productId);
  if (!id || !productId) return res.status(400).json({ error: 'Falta el producto' });
  try {
    const card = await productCard(productId);
    if (!card) return res.status(404).json({ error: 'Producto no disponible' });
    const out = await agentSend(id, auth.user_id, 'product', card.name, card, `Te ha enviado un producto: ${card.name}`);
    if (!out) return res.status(409).json({ error: 'La conversación está cerrada.' });
    res.json(out);
  } catch (err: any) {
    console.error('[LIVE CHAT] product:', err.message);
    res.status(500).json({ error: 'No se pudo enviar el producto' });
  }
});

// POST /api/admin/chats/:id/image (multipart «image») — foto de la galería o pegada.
const CHAT_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'chat');
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif|heic|heif|avif)$/.test(file.mimetype)),
});
liveChatRouter.post('/admin/chats/:id/image', (req: any, res: any, next: any) => {
  if (!admin(req, res)) return;
  next();
}, imageUpload.single('image'), async (req: any, res: any) => {
  const auth = authenticateRequest(req);
  const id = parseId(req.params.id);
  if (!id || !req.file) return res.status(400).json({ error: 'Falta la imagen (JPG, PNG, WEBP o GIF de hasta 12 MB)' });
  try {
    // Se recodifica siempre (quita metadatos como la ubicación y evita ficheros que no sean imagen).
    const image = sharp(req.file.buffer, { failOn: 'error' }).rotate();
    const out = await image.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    await fs.promises.mkdir(CHAT_UPLOAD_DIR, { recursive: true });
    const name = `${crypto.randomUUID()}.webp`;
    await fs.promises.writeFile(path.join(CHAT_UPLOAD_DIR, name), out.data);
    const payload = { url: `/uploads/chat/${name}`, width: out.info.width, height: out.info.height };
    const caption = clean(req.body?.caption, 300);
    const sent = await agentSend(id, auth.user_id, 'image', caption, payload, caption ? `📷 ${caption}` : 'Te ha enviado una imagen');
    if (!sent) return res.status(409).json({ error: 'La conversación está cerrada.' });
    res.json(sent);
  } catch (err: any) {
    console.error('[LIVE CHAT] image:', err.message);
    res.status(400).json({ error: 'No se pudo procesar la imagen' });
  }
});

// GET /api/admin/chat-products?q= — buscador de productos para enviar o añadir al pedido.
liveChatRouter.get('/admin/chat-products', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  const q = clean(req.query.q, 120);
  const terms = searchTerms(q).filter((t) => !t.includes(' ')).slice(0, 6);
  if (!terms.length) return res.json({ products: [] });
  try {
    const conds = terms.map((_, i) => `p.search_text LIKE $${i + 1}`).join(' AND ');
    const { rows } = await pool.query(
      `SELECT p.id FROM products p WHERE p.status = 'published' AND p.price > 0 AND ${conds}
       ORDER BY (upper(p.sku) = upper($${terms.length + 1})) DESC, (p.stock > 0) DESC, p.name LIMIT 20`,
      [...terms.map((t) => `%${t}%`), q]);
    const products = (await Promise.all(rows.map((r: any) => productCard(r.id)))).filter(Boolean);
    res.json({ products });
  } catch (err: any) {
    console.error('[LIVE CHAT] products:', err.message);
    res.status(500).json({ error: 'No se pudo buscar' });
  }
});

// GET /api/admin/chats/:id/cart — carrito actual del cliente.
liveChatRouter.get('/admin/chats/:id/cart', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { rows: [conv] } = await pool.query(`SELECT user_id FROM chat_conversations WHERE id = $1`, [id]);
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
    const { rows: [cart] } = await pool.query(
      `SELECT items, updated_at FROM carts WHERE user_id = $1 AND COALESCE(is_deleted, 0) = 0
       ORDER BY updated_at DESC LIMIT 1`, [conv.user_id]);
    let raw: any[] = [];
    try { raw = JSON.parse(cart?.items || '[]'); } catch { raw = []; }
    const items = (await Promise.all(raw.slice(0, 50).map(async (it: any) => {
      const card = await productCard(parseInt(it.id, 10));
      const quantity = Math.max(1, Math.min(99, parseInt(it.quantity, 10) || 1));
      return card ? { ...card, quantity } : { id: it.id, name: it.title || it.name || 'Producto', quantity, unavailable: true };
    })));
    res.json({ items, updatedAt: cart?.updated_at || null });
  } catch (err: any) {
    console.error('[LIVE CHAT] cart:', err.message);
    res.status(500).json({ error: 'No se pudo cargar el carrito' });
  }
});

// POST /api/admin/chats/:id/order { items: [{id, quantity}], note } — pedido con botón de pago.
liveChatRouter.post('/admin/chats/:id/order', async (req: any, res: any) => {
  const auth = admin(req, res);
  if (!auth) return;
  const id = parseId(req.params.id);
  const rawItems: any[] = Array.isArray(req.body?.items) ? req.body.items.slice(0, 30) : [];
  const items = rawItems
    .map((i) => ({ id: parseId(i?.id), quantity: Math.max(1, Math.min(99, parseInt(i?.quantity, 10) || 1)) }))
    .filter((i): i is { id: number; quantity: number } => !!i.id);
  if (!id || !items.length) return res.status(400).json({ error: 'Añade al menos un producto' });
  try {
    const { rows: [conv] } = await pool.query(`SELECT id, user_id, status FROM chat_conversations WHERE id = $1`, [id]);
    if (!conv || conv.status === 'closed') return res.status(409).json({ error: 'La conversación está cerrada.' });
    const cards = await Promise.all(items.map((i) => productCard(i.id)));
    if (cards.some((c) => !c)) return res.status(400).json({ error: 'Algún producto ya no está disponible' });

    // Importe orientativo (Península); el definitivo sale en el checkout con su dirección.
    const quote = await quoteOrder({ cart: items, country: 'ES', postcode: '28001' });
    const token = crypto.randomUUID();
    const agentName = await agentNameFor(auth.user_id);
    const note = clean(req.body?.note, 500);
    const { rows: [co] } = await pool.query(
      `INSERT INTO chat_orders (token, conversation_id, user_id, agent_user_id, agent_name, items, note, estimate_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [token, id, conv.user_id, auth.user_id, agentName, JSON.stringify(items), note || null, quote.totalCents]);
    const payload = {
      chatOrderId: co.id,
      url: `${PUBLIC_URL}/checkout?propuesta=${token}`,
      lines: items.map((i, k) => ({
        id: i.id, quantity: i.quantity, name: cards[k]!.name, image: cards[k]!.image,
        unit: cards[k]!.sale_price ?? cards[k]!.price,
      })),
      subtotal: quote.subtotalCents, discount: quote.discountCents, shipping: quote.shippingCents,
      tax: quote.taxCents, total: quote.totalCents, note: note || null,
    };
    const n = items.reduce((a, i) => a + i.quantity, 0);
    const out = await agentSend(id, auth.user_id, 'order', note || `Pedido preparado por ${agentName}`, payload,
      `Te ha preparado un pedido (${n} producto${n === 1 ? '' : 's'}). Pulsa para revisar el envío y pagar.`);
    res.json({ ...out, chatOrderId: co.id });
  } catch (err: any) {
    console.error('[LIVE CHAT] order:', err.message);
    res.status(500).json({ error: 'No se pudo preparar el pedido' });
  }
});

// GET /api/admin/chat-orders?month=YYYY-MM — pedidos del chat por asesor (comisiones).
liveChatRouter.get('/admin/chat-orders', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
  try {
    const { rows } = await pool.query(
      `SELECT co.id, co.created_at, co.agent_user_id, co.agent_name, co.user_id, co.conversation_id,
              co.estimate_cents, co.order_id, o.status AS order_status, o.total AS order_total, o.paid_at, o.created_at AS order_created_at,
              NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), '') AS customer_name, u.email AS customer_email
       FROM chat_orders co
       LEFT JOIN orders o ON o.id = co.order_id
       LEFT JOIN users u ON u.id = co.user_id
       WHERE co.created_at >= ($1 || '-01')::date AND co.created_at < (($1 || '-01')::date + INTERVAL '1 month')
       ORDER BY co.created_at DESC`, [month]);
    const orders = rows.map((r: any) => ({
      ...r,
      order_number: r.order_id ? formatOrderNumber(r.order_id, r.order_created_at) : null,
      status_label: !r.order_id ? 'enviado al cliente' : (ORDER_STATUS_ES[r.order_status] || r.order_status),
      paid: !!r.order_id && PAID_STATUSES.includes(r.order_status),
    }));
    const byAgent = new Map<string, any>();
    for (const o of orders) {
      const key = String(o.agent_user_id ?? 'sin');
      const a = byAgent.get(key) || { agent_user_id: o.agent_user_id, agent_name: o.agent_name, sent: 0, ordered: 0, paid: 0, paid_cents: 0 };
      a.sent++;
      if (o.order_id) a.ordered++;
      if (o.paid) { a.paid++; a.paid_cents += Number(o.order_total) || 0; }
      byAgent.set(key, a);
    }
    res.json({ month, orders, agents: [...byAgent.values()] });
  } catch (err: any) {
    console.error('[LIVE CHAT] chat-orders:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar las ventas del chat' });
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
  const auth = admin(req, res);
  if (!auth) return;
  const settings = await getSupportSettings();
  res.json({
    settings: { ...settings, welcomeTemplate: settings.welcomeTemplate || DEFAULT_WELCOME },
    status: await supportStatus(),
    myAgentName: await agentNameFor(auth.user_id),
  });
});

liveChatRouter.put('/admin/support-settings', async (req: any, res: any) => {
  if (!admin(req, res)) return;
  try {
    const auth = authenticateRequest(req);
    if (typeof req.body?.myAgentName === 'string') await setAgentName(auth.user_id, req.body.myAgentName);
    const settings = await saveSupportSettings(req.body || {});
    res.json({ settings, status: await supportStatus(), myAgentName: await agentNameFor(auth.user_id) });
  } catch (err: any) {
    console.error('[LIVE CHAT] settings:', err.message);
    res.status(500).json({ error: 'No se pudo guardar el horario' });
  }
});
