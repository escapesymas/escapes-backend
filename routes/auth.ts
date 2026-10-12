import { Router } from 'express';
import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { sendTemplatedEmail } from '../lib/email.js';
import { formatOrderNumber } from '../lib/email-templates.js';
import {
  generateJWT,
  hashPasswordSHA256,
  isLegacyPasswordHash,
  parseIntSafe,
  sanitizeString,
  authenticateRequest,
  STAFF_ROLES,
} from '../utils.js';
import { getMfaMethods } from './mfaRoutes.js';

// ── Verificación del email en el registro ─────────────────────────────────
const SITE_URL = process.env.PUBLIC_BASE_URL || 'https://escapesymas.com';
const VERIFY_TTL_HOURS = 24;
const VERIFY_RESEND_SECONDS = 60;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Genera un enlace nuevo (el anterior deja de valer) y lo envía por correo. */
async function sendVerificationEmail(user: { id: number; email: string; first_name?: string; username?: string }) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.execute(sql`
    UPDATE users SET email_verify_token_hash = ${sha256(token)},
                     email_verify_expires = NOW() + (${VERIFY_TTL_HOURS} || ' hours')::interval,
                     email_verify_sent_at = NOW()
    WHERE id = ${user.id}`);
  const url = `${SITE_URL}/verificar-email?token=${token}`;
  const result = await sendTemplatedEmail('verify-email', user.email, { name: user.first_name || user.username || '', url });
  if (result.status !== 'sent') console.error(`[AUTH] No se pudo enviar la verificación a ${user.email}: ${result.lastError || result.status}`);
  return result.status === 'sent';
}

// ── Cambio de email desde «Mi perfil» ─────────────────────────────────────
// El email nuevo queda en pending_email hasta que el cliente abre el enlace
// que le llega a esa dirección; mientras, sigue entrando con el anterior.
const EMAIL_CHANGE_RESEND_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN = 8;
// Avatar: una foto subida por /api/upload/avatar o uno de los emojis del perfil.
const AVATAR_URL_RE = /^(?:\/uploads\/avatar-[\w-]+\.(?:webp|png|jpe?g)|emoji:.{1,16})$/u;

async function sendEmailChangeEmail(user: { id: number; email: string; first_name?: string; username?: string }, newEmail: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.execute(sql`
    UPDATE users SET pending_email = ${newEmail},
                     email_change_token_hash = ${sha256(token)},
                     email_change_expires = NOW() + (${VERIFY_TTL_HOURS} || ' hours')::interval,
                     email_change_sent_at = NOW()
    WHERE id = ${user.id}`);
  const name = user.first_name || user.username || '';
  const url = `${SITE_URL}/confirmar-email?token=${token}`;
  // En segundo plano: con reintentos el envío puede tardar más de un minuto.
  sendTemplatedEmail('confirm-email-change', newEmail, { name, url, newEmail })
    .then((r) => { if (r.status !== 'sent') console.error(`[AUTH] No se pudo enviar el cambio de email a ${newEmail}: ${r.lastError || r.status}`); })
    .catch((e) => console.error('[AUTH EMAIL CHANGE ERROR]:', e.message));
  // Aviso al email actual: si no lo ha pedido el cliente, se entera a tiempo.
  sendTemplatedEmail('generic', user.email, {
    subject: 'Han pedido cambiar el email de tu cuenta',
    body: `Hola${name ? ` ${name}` : ''},\n\nHemos recibido una petición para cambiar el email de tu cuenta de Escapes y Más a ${newEmail}. El cambio no se aplicará hasta que se confirme desde esa dirección.\n\nSi no lo has pedido tú, entra en tu perfil, cancela el cambio y cambia tu contraseña.`,
    cta: { label: 'Ir a mi perfil', url: `${SITE_URL}/perfil` },
  }).catch((e) => console.error('[AUTH EMAIL CHANGE NOTICE ERROR]:', e.message));
}

/** Copia de los datos personales del cliente (derecho de acceso del RGPD). */
async function exportUserData(userId: number) {
  const parse = (v: any, fallback: any) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback); } catch { return fallback; } };
  const rows = async (q: any) => (await db.execute(q)).rows as any[];
  const euros = (cents: any) => (Number(cents) || 0) / 100;

  const [user] = await rows(sql`SELECT * FROM users WHERE id = ${userId}`);
  if (!user) return null;
  const billing = parse(user.billing, {}) || {};
  const { addresses, ...billingRest } = billing;

  const orders = await rows(sql`SELECT * FROM orders WHERE user_id = ${userId} ORDER BY created_at DESC`);
  const orderIds = orders.map((o) => o.id);
  const items = orderIds.length ? await rows(sql`
    SELECT oi.order_id, oi.quantity, oi.price, p.name AS product_name
    FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY oi.id`) : [];

  const conversations = await rows(sql`
    SELECT id, status, agent_name, created_at, closed_at, rating, rating_comment
    FROM chat_conversations WHERE user_id = ${userId} ORDER BY created_at`);
  const convIds = conversations.map((c) => c.id);
  const messages = convIds.length ? await rows(sql`
    SELECT conversation_id, sender, kind, content, created_at FROM chat_messages
    WHERE conversation_id IN (${sql.join(convIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY id`) : [];

  return {
    generado: new Date().toISOString(),
    responsable: 'Escapes y Más (escapesymas.com) · info@escapesymas.com',
    ley_aplicable: 'Reglamento General de Protección de Datos (RGPD) y LOPDGDD (España)',
    perfil: {
      nombre_usuario: user.username,
      email: user.email,
      email_pendiente_de_confirmar: user.pending_email || null,
      nombre: user.first_name || '',
      apellidos: user.last_name || '',
      telefono: billing.phone || '',
      avatar: user.avatar_url || '',
      rango: user.rank || 'Novato',
      experiencia_xp: user.xp || 0,
      cuenta_creada: user.created_at,
      email_confirmado: user.email_verified_at,
    },
    datos_de_facturacion: billingRest,
    direcciones_guardadas: Array.isArray(addresses) ? addresses : [],
    motos_garaje: parse(user.garage, []) || [],
    motos_registradas: await rows(sql`SELECT brand AS marca, model AS modelo, year AS anio, created_at AS fecha FROM garage WHERE user_id = ${userId} ORDER BY id`),
    carrito: parse(user.cart, []) || [],
    pedidos: orders.map((o) => ({
      numero: formatOrderNumber(o.id, o.created_at),
      fecha: o.created_at,
      estado: o.status,
      subtotal_eur: euros(o.subtotal),
      descuento_eur: euros(o.discount_amount),
      cupon: o.promo_code || null,
      envio_eur: euros(o.shipping_cost),
      impuestos_eur: euros(o.tax_amount),
      total_eur: euros(o.total),
      reembolsado_eur: euros(o.refunded_amount),
      metodo_de_pago: o.payment_method || null,
      pagado: o.paid_at,
      datos_de_envio: parse(o.shipping_data, {}),
      transportista: o.carrier || null,
      seguimiento: o.tracking_number || null,
      productos: items.filter((i) => i.order_id === o.id).map((i) => ({
        producto: i.product_name || 'Producto eliminado',
        cantidad: i.quantity,
        precio_unidad_eur: euros(i.price),
      })),
    })),
    solicitudes_de_reembolso: await rows(sql`
      SELECT order_id AS pedido, scope AS alcance, items AS productos, amount_cents / 100.0 AS importe_eur,
             reason_code AS motivo, reason AS explicacion, status AS estado, admin_note AS respuesta,
             refunded_cents / 100.0 AS reembolsado_eur, created_at AS fecha, resolved_at AS resuelta
      FROM refund_requests WHERE user_id = ${userId} ORDER BY id`),
    resenas: await rows(sql`
      SELECT p.name AS producto, r.rating AS puntuacion, r.title AS titulo, r.content AS texto,
             r.status AS estado, r.created_at AS fecha
      FROM product_reviews r LEFT JOIN products p ON p.id = r.product_id
      WHERE r.user_id = ${userId} ORDER BY r.id`),
    avisos_de_stock: await rows(sql`
      SELECT p.name AS producto, s.created_at AS fecha, s.notified AS avisado
      FROM stock_notifications s LEFT JOIN products p ON p.id = s.product_id
      WHERE LOWER(s.email) = LOWER(${user.email}) ORDER BY s.id`),
    chat_con_asesores: conversations.map((c) => ({
      fecha: c.created_at,
      cerrada: c.closed_at,
      estado: c.status,
      asesor: c.agent_name || null,
      valoracion: c.rating,
      comentario_valoracion: c.rating_comment || null,
      mensajes: messages.filter((m) => m.conversation_id === c.id).map((m) => ({
        de: m.sender, tipo: m.kind || 'text', texto: m.content, fecha: m.created_at,
      })),
    })),
    chat_con_el_asistente: (await rows(sql`
      SELECT messages, created_at, updated_at FROM ai_chat_sessions WHERE user_id = ${userId} ORDER BY id`))
      .map((s) => ({ inicio: s.created_at, ultimo_mensaje: s.updated_at, mensajes: parse(s.messages, []) })),
    foro: {
      temas: await rows(sql`SELECT title AS titulo, content AS texto, created_at AS fecha FROM forum_posts WHERE user_id = ${userId} ORDER BY id`),
      respuestas: await rows(sql`SELECT content AS texto, created_at AS fecha FROM forum_replies WHERE user_id = ${userId} ORDER BY id`),
    },
    dispositivos_con_notificaciones: Number((await rows(sql`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = ${userId}`))[0]?.n || 0),
  };
}

/** Datos del usuario que se devuelven al iniciar sesión. */
function sessionUser(user: any) {
  const parse = (v: any, fallback: any) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback); } catch { return fallback; } };
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    pendingEmail: user.pending_email || '',
    firstName: user.first_name || '',
    lastName: user.last_name || '',
    avatarUrl: user.avatar_url || '',
    role: user.role || 'customer',
    rank: user.rank || 'Novato',
    xp: user.xp || 0,
    billing: parse(user.billing, {}) || {},
    garage: parse(user.garage, []) || [],
    cart: parse(user.cart, []) || [],
  };
}

export const authRouter = Router();

function clearAuthCookie(res: any): void {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('eym_jwt', {
    httpOnly: true,
    secure: isProd,
    // Lax: escapesymas.com y api.escapesymas.com son el mismo sitio; otras webs no pueden usar la sesión (CSRF).
    sameSite: 'lax',
    path: '/',
  });
}

function setAuthCookie(res: any, token: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('eym_jwt', token, {
    httpOnly: true,
    secure: isProd,
    // Lax: escapesymas.com y api.escapesymas.com son el mismo sitio; otras webs no pueden usar la sesión (CSRF).
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    return bcrypt.compare(password, storedHash);
  }
  if (isLegacyPasswordHash(storedHash)) {
    return hashPasswordSHA256(password).toLowerCase() === storedHash.toLowerCase();
  }
  return storedHash === password;
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

// POST /api/auth/logout
authRouter.post('/auth/logout', async (req, res) => {
  try {
    const auth = authenticateRequest(req);
    const body = req.body || {};
    const { sessionToken, userId: bodyUserId } = body;
    const targetUserId = (auth && auth.user_id) || (bodyUserId ? parseInt(bodyUserId) : null);

    let cartItems: any[] = [];
    let customerName = 'Usuario';
    let entityId = 0;

    if (targetUserId) {
      const userRes = await db.execute(sql`SELECT id, first_name, last_name, username, email, cart FROM users WHERE id = ${targetUserId}`);
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0] as any;
        entityId = user.id;
        customerName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.email;
        try {
          if (user.cart) {
            cartItems = typeof user.cart === 'string' ? JSON.parse(user.cart) : user.cart;
          }
        } catch (e) {}
      }
    }

    // Si no hay items en user.cart, buscar en la tabla carts
    if ((!cartItems || cartItems.length === 0) && (sessionToken || targetUserId)) {
      const cartRes = await db.execute(sql`
        SELECT items FROM carts 
        WHERE (user_id = ${targetUserId || -1} OR session_token = ${sessionToken || ''}) 
        AND is_deleted = 0
        ORDER BY updated_at DESC LIMIT 1
      `);
      if (cartRes.rows.length > 0 && cartRes.rows[0].items) {
        const row = cartRes.rows[0] as any;
        try {
          cartItems = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
        } catch (e) {}
      }
    }

    if (Array.isArray(cartItems) && cartItems.length > 0) {
      let totalCents = 0;
      for (const item of cartItems) {
        const price = parseFloat(item.price || item.unit_price || 0);
        const qty = parseInt(item.quantity || 1);
        totalCents += Math.round(price * qty * 100);
      }

      const { notifyAbandonedCart } = await import('../pushService.js');
      await notifyAbandonedCart({
        id: entityId,
        customerName,
        total: totalCents
      });
    }
  } catch (err) {
    console.error('[LOGOUT PUSH ERROR]:', err);
  }

  clearAuthCookie(res);
  res.json({ success: true });
});

// GET /api/auth
authRouter.get('/auth', async (req, res) => {
  const { action } = req.query as any;

  try {
    if (action === 'get-profile') {
      // Auth required. Admin can target any user by passing `?id=N`. Otherwise
      // the caller's own profile is returned. Previously the endpoint accepted
      // an arbitrary `?email=` from anyone — full PII leak. Audit 2026-08-15,
      // finding #25.
      const auth = authenticateRequest(req);
      if (!auth) return res.status(401).json({ error: 'No autenticado' });
      const requestedId = parseIntSafe(req.query?.id as any);
      const targetId = (auth.role === 'admin' && requestedId) ? requestedId : auth.user_id;
      if (!targetId) return res.status(400).json({ error: 'ID inválido' });

      const userRes = await db.execute(sql`SELECT * FROM users WHERE id = ${targetId}`);
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const user = userRes.rows[0] as any;
      let billing = { address_1: '', city: '', postcode: '', phone: '' };
      try {
        if (user.billing) {
          billing = typeof user.billing === 'string' ? JSON.parse(user.billing) : user.billing;
        }
      } catch (e) {}

      let garage: any[] = [];
      try {
        if (user.garage) {
          garage = typeof user.garage === 'string' ? JSON.parse(user.garage) : user.garage;
        }
      } catch (e) {}

      let cart: any[] = [];
      try {
        if (user.cart) {
          cart = typeof user.cart === 'string' ? JSON.parse(user.cart) : user.cart;
        }
      } catch (e) {}

      return res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        pendingEmail: user.pending_email || '',
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        avatarUrl: user.avatar_url || '',
        role: user.role || 'customer',
        rank: user.rank || 'Novato',
        xp: user.xp || 0,
        billing,
        garage,
        cart
      });
    } else if (action === 'export-data') {
      // Siempre los datos del usuario de la sesión, nunca los de otro id.
      const auth = authenticateRequest(req);
      if (!auth) return res.status(401).json({ error: 'No autenticado' });
      const data = await exportUserData(auth.user_id);
      if (!data) return res.status(404).json({ error: 'Usuario no encontrado' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(data);
    } else if (action === 'search-users') {
      const { q } = req.query as any;
      if (!q) return res.json([]);

      const userRes = await db.execute(sql`
        SELECT id, username, first_name, last_name, avatar_url FROM users
        WHERE LOWER(username) LIKE ${'%' + q.toLowerCase() + '%'}
           OR LOWER(email) LIKE ${'%' + q.toLowerCase() + '%'}
           OR LOWER(first_name) LIKE ${'%' + q.toLowerCase() + '%'}
           OR LOWER(last_name) LIKE ${'%' + q.toLowerCase() + '%'}
        LIMIT 5
      `);

      const list = userRes.rows.map((row: any) => ({
        id: row.id,
        name: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : row.username,
        avatar: row.avatar_url || ''
      }));

      return res.json(list);
    }

    return res.status(400).json({ error: 'Acción no válida' });
  } catch (err: any) {
    console.error('[AUTH GET PROFILE ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth
authRouter.post('/auth', async (req, res) => {
  const { action } = req.query as any;
  const body = req.body || {};

  try {
    if (action === 'get-profile') {
      const auth = authenticateRequest(req);
      if (!auth) return res.status(401).json({ error: 'No autenticado' });
      const requestedId = parseIntSafe(body?.id || body?.userId || req.query?.id);
      const targetId = (auth.role === 'admin' && requestedId) ? requestedId : auth.user_id;
      if (!targetId) return res.status(400).json({ error: 'ID inválido' });

      const userRes = await db.execute(sql`SELECT * FROM users WHERE id = ${targetId}`);
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const user = userRes.rows[0] as any;
      let billing = { address_1: '', city: '', postcode: '', phone: '' };
      try {
        if (user.billing) {
          billing = typeof user.billing === 'string' ? JSON.parse(user.billing) : user.billing;
        }
      } catch (e) {}

      let garage: any[] = [];
      try {
        if (user.garage) {
          garage = typeof user.garage === 'string' ? JSON.parse(user.garage) : user.garage;
        }
      } catch (e) {}

      let cart: any[] = [];
      try {
        if (user.cart) {
          cart = typeof user.cart === 'string' ? JSON.parse(user.cart) : user.cart;
        }
      } catch (e) {}

      return res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        pendingEmail: user.pending_email || '',
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        avatarUrl: user.avatar_url || '',
        role: user.role || 'customer',
        rank: user.rank || 'Novato',
        xp: user.xp || 0,
        billing,
        garage,
        cart
      });
    }

    if (action === 'update-profile') {
      // Auth required; the body's userId is now IGNORED unless caller is admin.
      const auth = authenticateRequest(req);
      if (!auth) return res.status(401).json({ error: 'No autenticado' });
      const requestedId = parseIntSafe(body.userId || body.id);
      const targetUserId = (auth.role === 'admin' && requestedId) ? requestedId : auth.user_id;
      if (!targetUserId) return res.status(400).json({ error: 'Falta userId' });

      const { username, firstName, lastName, email, billing, garage, avatarUrl } = body;

      const userRes = await db.execute(sql`SELECT * FROM users WHERE id = ${targetUserId}`);
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
      const user = userRes.rows[0] as any;

      if (username && username.trim().toLowerCase() !== user.username.toLowerCase()) {
        const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_.]/gi, '');
        if (cleanUsername.length < 3) {
          return res.status(400).json({ error: 'El nombre de usuario (@username) debe tener al menos 3 caracteres.' });
        }
        const existUsernameRes = await db.execute(sql`
          SELECT id FROM users WHERE LOWER(username) = LOWER(${cleanUsername}) AND id != ${targetUserId}
        `);
        if (existUsernameRes.rows.length > 0) {
          return res.status(400).json({ error: `El nombre de usuario (@${cleanUsername}) ya está reservado por otro piloto.` });
        }
      }
      const newEmail = typeof email === 'string' ? email.trim() : '';
      const emailChanged = Boolean(newEmail) && newEmail.toLowerCase() !== String(user.email).toLowerCase();
      // Un administrador que corrige el email de otro cliente lo aplica directamente;
      // el propio cliente tiene que confirmarlo desde la dirección nueva.
      const confirmEmail = emailChanged && !(auth.role === 'admin' && targetUserId !== auth.user_id);
      if (emailChanged) {
        if (!EMAIL_RE.test(newEmail)) return res.status(400).json({ error: 'El email no es válido.' });
        const existRes = await db.execute(sql`
          SELECT id FROM users WHERE LOWER(email) = LOWER(${newEmail}) AND id != ${targetUserId}
        `);
        if (existRes.rows.length > 0) {
          return res.status(400).json({ error: 'El correo electrónico ya está registrado por otro usuario' });
        }
        const sentAt = user.email_change_sent_at ? new Date(user.email_change_sent_at).getTime() : 0;
        if (confirmEmail && Date.now() - sentAt < EMAIL_CHANGE_RESEND_SECONDS * 1000) {
          return res.status(429).json({ error: 'Te acabamos de enviar un enlace de confirmación. Espera un minuto para pedir otro.' });
        }
      }
      if (avatarUrl !== undefined && avatarUrl !== '' && !AVATAR_URL_RE.test(String(avatarUrl))) {
        return res.status(400).json({ error: 'Avatar no válido.' });
      }

      const billingJson = billing !== undefined
        ? (typeof billing === 'string' ? billing : JSON.stringify(billing))
        : (user.billing ? (typeof user.billing === 'string' ? user.billing : JSON.stringify(user.billing)) : null);
      const garageJson = garage !== undefined
        ? (typeof garage === 'string' ? garage : JSON.stringify(garage))
        : (user.garage ? (typeof user.garage === 'string' ? user.garage : JSON.stringify(user.garage)) : null);
      const cleanUsernameToSave = username ? username.trim().toLowerCase().replace(/[^a-z0-9_.]/gi, '') : null;

      await db.execute(sql`
        UPDATE users SET
          username = COALESCE(${cleanUsernameToSave || null}, username),
          first_name = COALESCE(${firstName || null}, first_name),
          last_name = COALESCE(${lastName || null}, last_name),
          email = COALESCE(${emailChanged && !confirmEmail ? newEmail : null}, email),
          billing = ${billingJson}::jsonb,
          garage = ${garageJson}::jsonb,
          avatar_url = COALESCE(${avatarUrl || null}, avatar_url)
        WHERE id = ${targetUserId}
      `);

      if (confirmEmail) {
        await sendEmailChangeEmail(user, newEmail);
        return res.json({ success: true, pendingEmail: newEmail });
      }
      return res.json({ success: true });
    }

    if (action === 'cancel-email-change') {
      const auth = authenticateRequest(req);
      if (!auth) return res.status(401).json({ error: 'No autenticado' });
      await db.execute(sql`
        UPDATE users SET pending_email = NULL, email_change_token_hash = NULL, email_change_expires = NULL
        WHERE id = ${auth.user_id}`);
      return res.json({ success: true });
    }

    if (action === 'confirm-email-change') {
      const token = String(body.token || '');
      if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Enlace no válido.', code: 'invalid_token' });
      const found = await db.execute(sql`
        SELECT id, pending_email FROM users
        WHERE email_change_token_hash = ${sha256(token)} AND email_change_expires > NOW() AND pending_email IS NOT NULL`);
      if (found.rows.length === 0) {
        return res.status(400).json({ error: 'El enlace no es válido o ha caducado. Vuelve a cambiar el email desde «Mi perfil».', code: 'invalid_token' });
      }
      const pending = found.rows[0] as any;
      const taken = await db.execute(sql`
        SELECT id FROM users WHERE LOWER(email) = LOWER(${pending.pending_email}) AND id != ${pending.id}`);
      if (taken.rows.length > 0) {
        await db.execute(sql`
          UPDATE users SET pending_email = NULL, email_change_token_hash = NULL, email_change_expires = NULL
          WHERE id = ${pending.id}`);
        return res.status(400).json({ error: 'Ese email ya lo usa otra cuenta.', code: 'email_taken' });
      }
      const updated = await db.execute(sql`
        UPDATE users SET email = pending_email, pending_email = NULL,
                         email_change_token_hash = NULL, email_change_expires = NULL,
                         email_verified = TRUE, email_verified_at = NOW()
        WHERE id = ${pending.id}
        RETURNING *`);
      const user = updated.rows[0] as any;
      // El token de sesión lleva el email (avisos de pedidos y del carrito): si
      // quien abre el enlace es el propio cliente con la sesión abierta, se renueva.
      const auth = authenticateRequest(req);
      if (auth && auth.user_id === user.id && !STAFF_ROLES.has(user.role)) {
        setAuthCookie(res, generateJWT(user));
      }
      return res.json({ success: true, email: user.email });
    }

    if (action === 'change-password') {
      const auth = authenticateRequest(req);
      if (!auth) return res.status(401).json({ error: 'No autenticado' });
      const { currentPassword, newPassword } = body;
      const requestedId = parseIntSafe(body.userId || body.id);
      const targetId = (auth.role === 'admin' && requestedId) ? requestedId : auth.user_id;
      if (!targetId || !currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
      }
      if (String(newPassword).length < PASSWORD_MIN) {
        return res.status(400).json({ error: `La nueva contraseña debe tener al menos ${PASSWORD_MIN} caracteres.` });
      }

      const userRes = await db.execute(sql`SELECT * FROM users WHERE id = ${targetId}`);
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

      const user = userRes.rows[0] as any;
      const isValid = await verifyPassword(currentPassword, user.password_hash);
      if (!isValid) return res.status(400).json({ error: 'La contraseña actual es incorrecta' });

      const newHash = await hashPassword(newPassword);
      await db.execute(sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${user.id}`);
      return res.json({ success: true });
    }

    if (action === 'delete-account') {
      const auth = authenticateRequest(req);
      if (!auth) return res.status(401).json({ error: 'No autenticado' });
      const requestedId = parseIntSafe(body.userId || body.id);
      const targetId = (auth.role === 'admin' && requestedId) ? requestedId : auth.user_id;
      if (!targetId) return res.status(400).json({ error: 'Falta userId' });

      // Si el cliente está eliminando su propia cuenta desde el frontend (no un admin borrándolo)
      const isSelfDeletion = auth.role !== 'admin' || auth.user_id === targetId;
      let deletedUserData: any = null;

      try {
        const uRes = await db.execute(sql`SELECT first_name, last_name, username, email FROM users WHERE id = ${targetId}`);
        if (uRes.rows.length > 0) deletedUserData = uRes.rows[0];
      } catch (e) {}

      try {
        await db.execute(sql`DELETE FROM users WHERE id = ${targetId}`);
      } catch (err) {
        await db.execute(sql`
          UPDATE users SET
            username = ${`eliminado_${targetId}`},
            email = ${`eliminado_${targetId}@escapesymas.com`},
            first_name = 'Usuario',
            last_name = 'Eliminado',
            password_hash = '',
            avatar_url = '',
            billing = null,
            garage = null,
            cart = null,
            role = 'customer'
          WHERE id = ${targetId}
        `);
      }

      // Notificar al admin vía Push si es una eliminación de cuenta solicitada por el usuario
      if (isSelfDeletion && deletedUserData) {
        try {
          const { sendNotificationToAll } = await import('../pushService.js');
          const clientName = [deletedUserData.first_name, deletedUserData.last_name].filter(Boolean).join(' ') || deletedUserData.username || deletedUserData.email;
          await sendNotificationToAll({
            title: `🗑️ Cuenta Eliminada por el Cliente`,
            body: `${clientName} (${deletedUserData.email}) ha solicitado y eliminado su cuenta.`,
            url: `/users`,
            category: 'new_user' // Usar categoría de usuarios para la preferencia
          });
        } catch (pushErr: any) {
          console.error('[DELETE ACCOUNT PUSH ERROR]:', pushErr.message);
        }
      }

      clearAuthCookie(res);
      return res.json({ success: true });
    }

    if (action === 'save-cart') {
      const auth = authenticateRequest(req);
      if (!auth) return res.status(401).json({ error: 'No autenticado' });
      const { cart } = body;
      const requestedId = parseIntSafe(body.userId);
      const targetId = (auth.role === 'admin' && requestedId) ? requestedId : auth.user_id;
      if (!targetId) return res.status(400).json({ error: 'Falta userId' });
      await db.execute(sql`
        UPDATE users SET cart = ${cart ? JSON.stringify(cart) : null}::jsonb
        WHERE id = ${targetId}
      `);
      return res.json({ success: true });
    }

    if (action === 'inactivity-notification') {
      try {
        const auth = authenticateRequest(req);
        const { sessionToken } = body;

        let cartItems: any[] = [];
        let customerName = 'Invitado';
        let entityId = 0;

        // 1. Intentar obtener usuario registrado
        const targetUserId = auth ? auth.user_id : null;
        if (targetUserId) {
          const userRes = await db.execute(sql`SELECT id, first_name, last_name, username, email, cart FROM users WHERE id = ${targetUserId}`);
          if (userRes.rows.length > 0) {
            const user = userRes.rows[0] as any;
            entityId = user.id;
            customerName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.email;
            try {
              if (user.cart) {
                cartItems = typeof user.cart === 'string' ? JSON.parse(user.cart) : user.cart;
              }
            } catch (e) {}
          }
        }

        // 2. Si no hay items en user.cart o es invitado, consultar la tabla carts
        if ((!cartItems || cartItems.length === 0) && sessionToken) {
          // La tabla carts no guarda el nombre ni el email: se sacan del usuario, si lo hay.
          const cartRes = await db.execute(sql`
            SELECT c.items, u.email AS user_email, u.first_name AS user_first_name, u.last_name AS user_last_name
            FROM carts c LEFT JOIN users u ON u.id = c.user_id
            WHERE c.session_token = ${sessionToken} AND c.is_deleted = 0`);
          if (cartRes.rows.length > 0) {
            const row = cartRes.rows[0] as any;
            if (row.items) {
              cartItems = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
            }
            if (customerName === 'Invitado') {
              const nameFromCart = [row.user_first_name, row.user_last_name].filter(Boolean).join(' ');
              customerName = nameFromCart || row.user_email || 'Invitado';
            }
          }
        }

        if (Array.isArray(cartItems) && cartItems.length > 0) {
          let totalCents = 0;
          for (const item of cartItems) {
            const price = parseFloat(item.price || item.unit_price || 0);
            const qty = parseInt(item.quantity || 1);
            totalCents += Math.round(price * qty * 100);
          }

          const { notifyAbandonedCart } = await import('../pushService.js');
          await notifyAbandonedCart({
            id: entityId,
            customerName,
            total: totalCents
          });
        }
      } catch (err: any) {
        console.error('[INACTIVITY PUSH ERROR]:', err);
      }
      return res.json({ success: true, message: 'Notificación de inactividad enviada' });
    }

    if (action === 'social-login') {
      // Social login was never wired up to a real OAuth provider. The previous
      // implementation accepted any `provider`+`token` pair and issued a JWT
      // without verifying the password — anyone could log in as any user.
      // Reject the endpoint until a proper provider integration exists.
      return res.status(501).json({
        error: 'Inicio de sesión social no implementado',
      });
    }

    if (action === 'login') {
      const { username, password } = body;
      if (!username) return res.status(400).json({ error: 'Falta email o usuario' });

      const userRes = await db.execute(sql`
        SELECT * FROM users
        WHERE LOWER(email) = LOWER(${username}) OR LOWER(username) = LOWER(${username})
      `);

      // Mismo mensaje si no existe o si la contraseña no es: no revela qué cuentas existen.
      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: 'Email o contraseña incorrectos' });
      }

      const user = userRes.rows[0] as any;

      const isValid = await verifyPassword(password || '', user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: 'Email o contraseña incorrectos' });
      }

      if (user.password_hash && isLegacyPasswordHash(user.password_hash)) {
        const newHash = await hashPassword(password || '');
        await db.execute(sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${user.id}`);
      }

      if (user.email_verified === false) {
        return res.status(403).json({
          error: 'Confirma tu email para entrar: te enviamos un enlace al registrarte. Si no lo encuentras, pide otro.',
          code: 'email_not_verified',
          email: user.email,
        });
      }

      const token = generateJWT(user);
      setAuthCookie(res, token);

      let billing = {};
      try { billing = typeof user.billing === 'string' ? JSON.parse(user.billing) : user.billing; } catch {}
      let garage: any[] = [];
      try { garage = typeof user.garage === 'string' ? JSON.parse(user.garage) : user.garage; } catch {}
      let cart: any[] = [];
      try { cart = typeof user.cart === 'string' ? JSON.parse(user.cart) : user.cart; } catch {}

      // Personal: el panel pide ahora el segundo paso (o configurarlo si aún no tiene).
      let mfa: any = undefined;
      if (STAFF_ROLES.has(user.role)) {
        const methods = await getMfaMethods(user.id);
        mfa = { required: true, setupRequired: !(methods.passkeys > 0 || methods.totp), methods };
      }

      return res.json({
        token,
        ...(mfa && { mfa }),
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.first_name || '',
          lastName: user.last_name || '',
          avatarUrl: user.avatar_url || '',
          role: user.role || 'customer',
          rank: user.rank || 'Novato',
          xp: user.xp || 0,
          billing,
          garage,
          cart,
        }
      });
    }

    if (action === 'register') {
      const { email, password, username, firstName, lastName } = body;
      if (!email || !password) return res.status(400).json({ error: 'Falta email o contraseña' });
      if (String(password).length < PASSWORD_MIN) {
        return res.status(400).json({ error: `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.` });
      }

      const existing = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${email})`);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'El email ya está registrado' });
      }

      const passHash = await hashPassword(password);
      const userNick = username || email.split('@')[0];

      const inserted = await db.execute(sql`
        INSERT INTO users (email, username, password_hash, first_name, last_name, role)
        VALUES (${email}, ${userNick}, ${passHash}, ${firstName || ''}, ${lastName || ''}, 'customer')
        RETURNING *
      `);

      const user = inserted.rows[0] as any;
      // Sin sesión hasta confirmar el email (ver action === 'verify-email'). El
      // envío va en segundo plano: con reintentos puede tardar más de un minuto.
      const emailSent = true;
      sendVerificationEmail(user).catch((e) => console.error('[AUTH REGISTER VERIFY EMAIL ERROR]:', e.message));

      // Disparar Notificación Push para el Admin sobre nuevo usuario
      try {
        const { notifyNewUser } = await import('../pushService.js');
        const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;
        await notifyNewUser({
          name,
          email: user.email
        });
      } catch (pushErr: any) {
        console.error('[AUTH REGISTER PUSH ERROR]:', pushErr.message);
      }

      return res.json({ verificationRequired: true, email: user.email, emailSent });
    }

    if (action === 'verify-email') {
      const token = String(body.token || '');
      if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Enlace no válido.', code: 'invalid_token' });
      const found = await db.execute(sql`
        UPDATE users SET email_verified = TRUE, email_verified_at = NOW(),
                         email_verify_token_hash = NULL, email_verify_expires = NULL
        WHERE email_verify_token_hash = ${sha256(token)} AND email_verify_expires > NOW()
        RETURNING *`);
      if (found.rows.length === 0) {
        return res.status(400).json({ error: 'El enlace no es válido o ha caducado. Pide uno nuevo desde «Acceder».', code: 'invalid_token' });
      }
      const user = found.rows[0] as any;
      const jwt = generateJWT(user);
      setAuthCookie(res, jwt);
      return res.json({ token: jwt, user: sessionUser(user) });
    }

    if (action === 'resend-verification') {
      // Respuesta siempre igual: no revela si el email está registrado.
      const email = String(body.email || '').trim();
      if (email) {
        const r = await db.execute(sql`
          SELECT id, email, first_name, username FROM users
          WHERE LOWER(email) = LOWER(${email}) AND email_verified = FALSE
            AND (email_verify_sent_at IS NULL OR email_verify_sent_at < NOW() - (${VERIFY_RESEND_SECONDS} || ' seconds')::interval)`);
        if (r.rows.length) sendVerificationEmail(r.rows[0] as any).catch((e) => console.error('[AUTH RESEND ERROR]:', e.message));
      }
      return res.json({ success: true, message: 'Si la cuenta existe y está pendiente de confirmar, te hemos enviado un enlace nuevo.' });
    }

    return res.status(400).json({ error: 'Acción no válida' });
  } catch (err: any) {
    console.error('[AUTH POST ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});
