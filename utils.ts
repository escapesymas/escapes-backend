import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'escapes-y-mas-default-secret-change-in-production';

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