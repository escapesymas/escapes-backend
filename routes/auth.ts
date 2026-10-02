import { Router } from 'express';
import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { sendTemplatedEmail } from '../lib/email.js';
import {
  generateJWT,
  hashPasswordSHA256,
  isLegacyPasswordHash,
  parseIntSafe,
  sanitizeString,
  authenticateRequest,
} from '../utils.js';

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

/** Datos del usuario que se devuelven al iniciar sesión. */
function sessionUser(user: any) {
  const parse = (v: any, fallback: any) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback); } catch { return fallback; } };
  return {
    id: user.id,
    username: user.username,
    email: user.email,
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
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  });
}

function setAuthCookie(res: any, token: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('eym_jwt', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
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
      if (email && email.toLowerCase() !== user.email.toLowerCase()) {
        const existRes = await db.execute(sql`
          SELECT id FROM users WHERE LOWER(email) = LOWER(${email}) AND id != ${targetUserId}
        `);
        if (existRes.rows.length > 0) {
          return res.status(400).json({ error: 'El correo electrónico ya está registrado por otro usuario' });
        }
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
          email = COALESCE(${email || null}, email),
          billing = ${billingJson}::jsonb,
          garage = ${garageJson}::jsonb,
          avatar_url = COALESCE(${avatarUrl || null}, avatar_url)
        WHERE id = ${targetUserId}
      `);

      return res.json({ success: true });
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
          const cartRes = await db.execute(sql`SELECT items, user_email, user_first_name, user_last_name FROM carts WHERE session_token = ${sessionToken} AND is_deleted = 0`);
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

      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: 'Usuario no encontrado' });
      }

      const user = userRes.rows[0] as any;

      const isValid = await verifyPassword(password || '', user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: 'Contraseña incorrecta' });
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

      return res.json({
        token,
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
