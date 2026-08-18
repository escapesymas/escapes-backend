import { Router } from 'express';
import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import {
  generateJWT,
  hashPasswordSHA256,
  isLegacyPasswordHash,
  parseIntSafe,
  sanitizeString,
  authenticateRequest,
} from '../utils.js';

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
authRouter.post('/auth/logout', (_req, res) => {
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
      const token = generateJWT(user);
      setAuthCookie(res, token);

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
          rank: 'Novato',
          xp: 0,
          billing: {},
          garage: [],
          cart: [],
        }
      });
    }

    return res.status(400).json({ error: 'Acción no válida' });
  } catch (err: any) {
    console.error('[AUTH POST ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});
