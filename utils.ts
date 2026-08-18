import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

// Single source of truth for the JWT signing secret. If it isn't configured,
// or is shorter than 32 bytes, fail loudly at boot — silently falling back to
// a hardcoded string would allow anyone to forge admin tokens.
const RAW_JWT_SECRET = process.env.JWT_SECRET;
if (!RAW_JWT_SECRET || RAW_JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET is missing or shorter than 32 chars. ' +
    'Set a strong random value (e.g. `openssl rand -hex 32`) in the environment.'
  );
}
export const JWT_SECRET: string = RAW_JWT_SECRET;

export function sanitizeString(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[<>'"&]/g, '').trim();
}

export function sanitizeLike(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/['\"\\%;]/g, '').trim();
}

export function parseIntSafe(value: any): number | null {
  if (value === null || value === undefined) return null;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? null : parsed;
}

export function isLegacyPasswordHash(hash: string): boolean {
  return hash && hash.length === 64 && /^[a-f0-9]{64}$/i.test(hash);
}

export function generateJWT(user: any): string {
  const payload = {
    user_id: user.id,
    email: user.email,
    role: user.role || 'user',
    username: user.username || user.email,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyJWT(token: string): any | null {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function authenticateRequest(req: any): any | null {
  const authHeader = req.headers?.authorization;
  if (authHeader?.startsWith?.('Bearer ')) {
    const user = verifyJWT(authHeader.substring(7));
    if (user) return user;
  }

  const cookieHeader = req.headers?.cookie || '';
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((part: string) => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k] = decodeURIComponent(v.join('='));
  });
  if (cookies.eym_jwt) {
    const user = verifyJWT(cookies.eym_jwt);
    if (user) return user;
  }
  return null;
}

export function requireAuth(req: any, res: Response, next: NextFunction): void {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'No autenticado' });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: any, res: Response, next: NextFunction): void {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'No autenticado' });
    return;
  }
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Acceso restringido a administradores' });
    return;
  }
  req.user = user;
  next();
}

export function hashPasswordSHA256(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function parseAttributes(raw: any): { name: string; value: string }[] {
  if (!raw) return [];
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw).map(([name, value]) => ({
      name,
      value: String(value || ''),
    }));
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      return parsed.map(item => ({
        name: item.name || item.key || '',
        value: item.value || item.val || '',
      }));
    }
    if (typeof parsed === 'object') {
      return Object.entries(parsed).map(([name, value]) => ({
        name,
        value: String(value || ''),
      }));
    }
  } catch {}
  return [];
}

export function formatPrice(cents: number): number {
  return cents / 100;
}

export function parsePrice(euros: number): number {
  return Math.round(euros * 100);
}