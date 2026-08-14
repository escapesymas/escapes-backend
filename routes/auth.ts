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
  const { action, email, id } = req.query as any;

  try {
    if (action === 'get-profile') {
      if (!email && !id) return res.status(400).json({ error: 'Falta email o id' });

      const conditions = sql`WHERE 1=1`;
      if (email) {
        conditions.append(sql` AND LOWER(email) = LOWER(${email})`);
      } else if (id) {
        const safeId = parseIntSafe(id);
        if (!safeId) return res.status(400).json({ error: 'ID inválido' });
        conditions.append(sql` AND id = ${safeId}`);
      }

      const userRes = await db.execute(sql`SELECT * FROM users ${conditions}`);
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
  const body = req.body;

  try {
    if (action === 'login' || action === 'social-login') {
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
      const isSocial = !!(body.provider && body.token);

      if (!isSocial) {
        const isValid = await verifyPassword(password || '', user.password_hash);
        if (!isValid) {
          return res.status(401).json({ error: 'Contraseña incorrecta' });
        }

        if (user.password_hash && isLegacyPasswordHash(user.password_hash)) {
          const newHash = await hashPassword(password || '');
          await db.execute(sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${user.id}`);
        }
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
