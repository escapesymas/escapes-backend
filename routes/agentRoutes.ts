/**
 * Asesores del chat: invitaciones por email, alta desde el enlace y gestión
 * (lista, quitar el rol). El panel de asesores es el mismo panel de
 * administración servido en asesores.escapesymas.com con solo el chat.
 */
import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { generateJWT, hashPasswordSHA256 } from '../utils.js';
import { requireAdminRole, forgetRole } from '../lib/agent-auth.js';
import { agentNameFor, setAgentOnline, addMessage } from '../lib/live-chat.js';
import { sendTemplatedEmail } from '../lib/email.js';

export const agentRouter = Router();

const ASESORES_URL = (process.env.ASESORES_URL || 'https://asesores.escapesymas.com').replace(/\/$/, '');
const INVITE_DAYS = 7;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const clean = (v: unknown, max = 120) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

async function verifyPassword(password: string, storedHash: string | null): Promise<boolean> {
  if (!storedHash) return false;
  if (storedHash.startsWith('$2')) return bcrypt.compare(password, storedHash);
  return hashPasswordSHA256(password).toLowerCase() === storedHash.toLowerCase();
}

/** Invitación vigente (sin aceptar, cancelar ni caducar) a partir del token del enlace. */
async function validInvitation(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows: [inv] } = await pool.query(
    `SELECT * FROM agent_invitations WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [sha256(token)]);
  return inv || null;
}

// ── Administración ───────────────────────────────────────────────────────

// GET /api/admin/agents — asesores (y administradores) e invitaciones pendientes.
agentRouter.get('/admin/agents', async (req: any, res: any) => {
  if (!(await requireAdminRole(req, res))) return;
  try {
    const [{ rows: agents }, { rows: invitations }] = await Promise.all([
      pool.query(
        `SELECT u.id, u.email, u.role, NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), '') AS full_name,
                COALESCE(a.online, FALSE) AS online, a.updated_at AS status_at,
                (SELECT count(*)::int FROM chat_conversations c WHERE c.agent_user_id = u.id AND c.status <> 'closed') AS open_chats
         FROM users u LEFT JOIN chat_agents a ON a.user_id = u.id
         WHERE u.role IN ('asesor', 'admin') ORDER BY (u.role = 'admin') DESC, u.first_name, u.email`),
      pool.query(
        `SELECT id, email, name, created_at, expires_at FROM agent_invitations
         WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC`),
    ]);
    for (const a of agents) a.chat_name = await agentNameFor(a.id);
    res.json({ agents, invitations });
  } catch (err: any) {
    console.error('[AGENTS] list:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar los asesores' });
  }
});

// POST /api/admin/agents/invite { email, name } — envía la invitación por email.
agentRouter.post('/admin/agents/invite', async (req: any, res: any) => {
  const auth = await requireAdminRole(req, res);
  if (!auth) return;
  const email = clean(req.body?.email, 200).toLowerCase();
  const name = clean(req.body?.name, 80);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email no válido' });
  try {
    const { rows: [existing] } = await pool.query(`SELECT role FROM users WHERE lower(email) = $1`, [email]);
    if (existing?.role === 'admin') return res.status(400).json({ error: 'Esa cuenta ya es de administrador' });
    if (existing?.role === 'asesor') return res.status(400).json({ error: 'Esa cuenta ya es de asesor' });

    // Una sola invitación vigente por email: la nueva sustituye a las anteriores.
    await pool.query(`UPDATE agent_invitations SET revoked_at = NOW() WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [email]);
    const token = crypto.randomBytes(32).toString('hex');
    const { rows: [inv] } = await pool.query(
      `INSERT INTO agent_invitations (email, name, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval) RETURNING id, email, name, created_at, expires_at`,
      [email, name || null, sha256(token), auth.user_id, String(INVITE_DAYS)]);
    const inviter = await agentNameFor(auth.user_id);
    const sent = await sendTemplatedEmail('generic', email, {
      subject: 'Te invitamos al panel de asesores de Escapes y Más',
      body: `Hola${name ? ` ${name}` : ''},\n\n${inviter} te ha invitado a atender el chat de escapesymas.com como asesor.\n\n` +
        `Desde el panel de asesores podrás responder a los clientes, enviarles productos, preparar pedidos con descuento y ver tus comisiones.\n\n` +
        (existing ? 'Ya tienes cuenta en la tienda: entra con tu email y contraseña para aceptar.\n\n' : 'Crea tu contraseña desde el enlace para empezar.\n\n') +
        `El enlace caduca en ${INVITE_DAYS} días.`,
      cta: { label: existing ? 'Aceptar la invitación' : 'Crear mi acceso', url: `${ASESORES_URL}/?invitacion=${token}` },
    });
    res.json({ invitation: inv, emailStatus: sent.status });
  } catch (err: any) {
    console.error('[AGENTS] invite:', err.message);
    res.status(500).json({ error: 'No se pudo enviar la invitación' });
  }
});

// POST /api/admin/agents/invitations/:id/cancel
agentRouter.post('/admin/agents/invitations/:id/cancel', async (req: any, res: any) => {
  if (!(await requireAdminRole(req, res))) return;
  await pool.query(`UPDATE agent_invitations SET revoked_at = NOW() WHERE id = $1 AND accepted_at IS NULL`, [parseInt(req.params.id, 10) || 0]);
  res.json({ ok: true });
});

// POST /api/admin/agents/:userId/revoke — deja de ser asesor; sus chats abiertos vuelven a la cola.
agentRouter.post('/admin/agents/:userId/revoke', async (req: any, res: any) => {
  if (!(await requireAdminRole(req, res))) return;
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { rowCount } = await pool.query(`UPDATE users SET role = 'customer' WHERE id = $1 AND role = 'asesor'`, [userId]);
    if (!rowCount) return res.status(400).json({ error: 'Esa cuenta no es de asesor' });
    forgetRole(userId);
    await setAgentOnline(userId, false);
    const { rows } = await pool.query(
      `UPDATE chat_conversations SET agent_user_id = NULL, agent_name = NULL, status = 'waiting'
       WHERE agent_user_id = $1 AND status <> 'closed' RETURNING id`, [userId]);
    for (const r of rows) await addMessage(r.id, 'system', 'Te atenderá otro asesor en breve.');
    res.json({ ok: true, reassigned: rows.length });
  } catch (err: any) {
    console.error('[AGENTS] revoke:', err.message);
    res.status(500).json({ error: 'No se pudo quitar el rol' });
  }
});

// ── Alta del asesor desde el enlace ──────────────────────────────────────

// GET /api/agent-invitations/:token — datos de la invitación para el formulario.
agentRouter.get('/agent-invitations/:token', async (req: any, res: any) => {
  try {
    const inv = await validInvitation(String(req.params.token || ''));
    if (!inv) return res.status(404).json({ error: 'La invitación no es válida o ha caducado. Pide una nueva.' });
    const { rows: [user] } = await pool.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [inv.email]);
    res.json({ email: inv.email, name: inv.name, existingAccount: !!user });
  } catch (err: any) {
    console.error('[AGENTS] invitation:', err.message);
    res.status(500).json({ error: 'No se pudo cargar la invitación' });
  }
});

// POST /api/agent-invitations/:token/accept { password, firstName, lastName } — crea la cuenta
// de asesor (o da el rol a la cuenta existente, comprobando su contraseña) y abre sesión.
agentRouter.post('/agent-invitations/:token/accept', async (req: any, res: any) => {
  const password = String(req.body?.password || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await validInvitation(String(req.params.token || ''));
    if (!inv) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'La invitación no es válida o ha caducado. Pide una nueva.' });
    }
    const { rows: [existing] } = await client.query(`SELECT * FROM users WHERE lower(email) = lower($1) FOR UPDATE`, [inv.email]);
    let user: any;
    if (existing) {
      // Cuenta ya registrada: se comprueba que es suya antes de darle el rol.
      if (!(await verifyPassword(password, existing.password_hash))) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Contraseña incorrecta. Usa la de tu cuenta de la tienda.' });
      }
      const role = existing.role === 'admin' ? 'admin' : 'asesor';
      user = (await client.query(
        `UPDATE users SET role = $2, email_verified = TRUE WHERE id = $1 RETURNING *`, [existing.id, role])).rows[0];
    } else {
      if (password.length < 8) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
      }
      const firstName = clean(req.body?.firstName, 60) || clean(inv.name, 60);
      const lastName = clean(req.body?.lastName, 80);
      const base = inv.email.split('@')[0].replace(/[^a-z0-9._-]/gi, '').slice(0, 30) || 'asesor';
      const { rows: taken } = await client.query(`SELECT 1 FROM users WHERE lower(username) = lower($1)`, [base]);
      const username = taken.length ? `${base}-${crypto.randomBytes(2).toString('hex')}` : base;
      user = (await client.query(
        `INSERT INTO users (email, username, password_hash, first_name, last_name, role, email_verified, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, 'asesor', TRUE, NOW()) RETURNING *`,
        [inv.email, username, await bcrypt.hash(password, 10), firstName, lastName])).rows[0];
    }
    await client.query(`UPDATE agent_invitations SET accepted_at = NOW(), accepted_user_id = $2 WHERE id = $1`, [inv.id, user.id]);
    await client.query(
      `INSERT INTO chat_agents (user_id, online) VALUES ($1, FALSE) ON CONFLICT (user_id) DO NOTHING`, [user.id]);
    await client.query('COMMIT');
    forgetRole(user.id);
    res.json({
      token: generateJWT(user),
      user: { id: user.id, email: user.email, firstName: user.first_name || '', lastName: user.last_name || '', role: user.role },
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[AGENTS] accept:', err.message);
    res.status(500).json({ error: 'No se pudo completar el alta' });
  } finally {
    client.release();
  }
});
