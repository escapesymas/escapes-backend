/**
 * Acceso de asesores y administradores al chat.
 *
 * El rol viaja en la sesión (7 días), pero a un asesor se le puede quitar el
 * rol en cualquier momento: por eso se comprueba en la base de datos (con una
 * caché de 30 s) en lugar de fiarse del token.
 */
import { pool } from '../db.js';
import { authenticateRequest } from '../utils.js';

export interface AgentAuth {
  user_id: number;
  email?: string;
  role: 'admin' | 'asesor';
  isAdmin: boolean;
}

const roleCache = new Map<number, { at: number; role: string | null }>();

export async function currentRole(userId: number): Promise<string | null> {
  const hit = roleCache.get(userId);
  if (hit && Date.now() - hit.at < 30_000) return hit.role;
  const { rows } = await pool.query(`SELECT role FROM users WHERE id = $1`, [userId]);
  const role = rows[0]?.role ?? null;
  roleCache.set(userId, { at: Date.now(), role });
  return role;
}

export function forgetRole(userId: number) {
  roleCache.delete(userId);
}

/** Asesor o administrador; si no, responde 403 y devuelve null. */
/** Sesión de personal sin el segundo paso: el panel debe pedirlo antes de nada. */
function mfaPending(auth: any, res: any): boolean {
  if (!auth?.mfa_pending) return false;
  res.status(401).json({ error: 'Falta la verificación en dos pasos', code: 'mfa_required' });
  return true;
}

export async function requireAgent(req: any, res: any): Promise<AgentAuth | null> {
  const auth = authenticateRequest(req);
  if (mfaPending(auth, res)) return null;
  if (auth?.user_id) {
    const role = await currentRole(auth.user_id).catch(() => null);
    if (role === 'admin' || role === 'asesor') {
      return { user_id: auth.user_id, email: auth.email, role, isAdmin: role === 'admin' };
    }
  }
  res.status(403).json({ error: 'Solo asesores' });
  return null;
}

/** Solo administradores (comprobado también en la base de datos). */
export async function requireAdminRole(req: any, res: any): Promise<AgentAuth | null> {
  const auth = authenticateRequest(req);
  if (mfaPending(auth, res)) return null;
  if (auth?.user_id && (await currentRole(auth.user_id).catch(() => null)) === 'admin') {
    return { user_id: auth.user_id, email: auth.email, role: 'admin', isAdmin: true };
  }
  res.status(403).json({ error: 'Solo administradores' });
  return null;
}
