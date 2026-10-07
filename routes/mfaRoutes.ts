/**
 * Verificación en dos pasos del personal (administradores y asesores).
 *
 * - Llaves de acceso (WebAuthn): Face ID, Touch ID, huella o Windows Hello.
 * - Google Authenticator (o cualquier app TOTP) como alternativa.
 * - Códigos de recuperación de un solo uso por si se pierde el móvil.
 *
 * El login con contraseña da a un admin/asesor un token «pendiente» (en
 * utils.verifyJWT se rebaja a cliente). Con ese token solo se puede completar
 * el segundo paso aquí, o configurarlo si la cuenta aún no tiene ningún
 * método. Al completarlo se emite el token completo (claim `mfa`).
 */
import { Router } from 'express';
import crypto from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { pool } from '../db.js';
import { authenticateRequest, generateJWT, STAFF_ROLES } from '../utils.js';

export const mfaRouter = Router();

const RP_ID = process.env.WEBAUTHN_RP_ID || 'escapesymas.com';
const RP_NAME = 'Escapes y Más';
const ORIGINS = (process.env.WEBAUTHN_ORIGINS || 'https://admin.escapesymas.com,https://asesores.escapesymas.com')
  .split(',').map((o) => o.trim()).filter(Boolean);
const CHALLENGE_TTL_MS = 5 * 60_000;

authenticator.options = { window: 1 }; // admite el código anterior/siguiente (relojes desfasados)

// Intentos del segundo paso: 10 fallos cada 15 min por IP.
const mfaLimiter = rateLimit({
  keyGenerator: (req: any) => ipKeyGenerator(req.clientIp || req.ip || 'unknown'),
  windowMs: 15 * 60_000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
});

// ---------------------------------------------------------------- utilidades

const encKey = () => crypto.createHash('sha256').update(`mfa:${process.env.JWT_SECRET || ''}`).digest();

function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

function decrypt(blob: string): string {
  const [iv, tag, data] = blob.split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const normCode = (s: string) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newRecoveryCodes(): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => {
    const b = crypto.randomBytes(8);
    const raw = Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

const challenges = new Map<string, { challenge: string; exp: number }>();
const putChallenge = (key: string, challenge: string) => challenges.set(key, { challenge, exp: Date.now() + CHALLENGE_TTL_MS });
function takeChallenge(key: string): string | null {
  const c = challenges.get(key);
  challenges.delete(key);
  return c && c.exp > Date.now() ? c.challenge : null;
}

/** Métodos configurados de una cuenta. */
export async function getMfaMethods(userId: number): Promise<{ passkeys: number; totp: boolean; recoveryLeft: number }> {
  const [{ rows: [pk] }, { rows: [m] }] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM staff_passkeys WHERE user_id = $1`, [userId]),
    pool.query(`SELECT totp_enabled, jsonb_array_length(recovery_hashes) AS rec FROM staff_mfa WHERE user_id = $1`, [userId]),
  ]);
  return { passkeys: pk?.n || 0, totp: !!m?.totp_enabled, recoveryLeft: m?.rec || 0 };
}

const hasAnyMethod = (m: { passkeys: number; totp: boolean }) => m.passkeys > 0 || m.totp;

interface Staff { userId: number; email: string; pending: boolean; user: any }

/**
 * Personal autenticado (token pendiente o completo). El rol se comprueba en la
 * base de datos: un token de cliente nunca llega aquí.
 */
async function staff(req: any, res: any, opts: { allowPending: boolean }): Promise<Staff | null> {
  const auth = authenticateRequest(req);
  if (!auth?.user_id) { res.status(401).json({ error: 'No autenticado' }); return null; }
  const { rows: [user] } = await pool.query(`SELECT * FROM users WHERE id = $1`, [auth.user_id]);
  if (!user || !STAFF_ROLES.has(user.role)) { res.status(403).json({ error: 'Solo para el personal' }); return null; }
  const pending = !!auth.mfa_pending;
  if (pending && !opts.allowPending) {
    res.status(401).json({ error: 'Falta la verificación en dos pasos', code: 'mfa_required' });
    return null;
  }
  return { userId: user.id, email: user.email, pending, user };
}

/**
 * Configurar métodos: con sesión completa siempre; con sesión pendiente solo
 * si la cuenta aún no tiene ninguno (primera configuración tras el login).
 */
async function canEnroll(s: Staff, res: any): Promise<boolean> {
  if (!s.pending) return true;
  if (hasAnyMethod(await getMfaMethods(s.userId))) {
    res.status(401).json({ error: 'Completa primero la verificación en dos pasos', code: 'mfa_required' });
    return false;
  }
  return true;
}

/** Token completo + códigos de recuperación si aún no tiene. */
async function complete(s: Staff): Promise<{ token: string; recoveryCodes?: string[] }> {
  const token = generateJWT(s.user, { mfa: true });
  const { rows: [m] } = await pool.query(`SELECT jsonb_array_length(recovery_hashes) AS n FROM staff_mfa WHERE user_id = $1`, [s.userId]);
  if (m?.n) return { token };
  const codes = newRecoveryCodes();
  await pool.query(
    `INSERT INTO staff_mfa (user_id, recovery_hashes, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET recovery_hashes = EXCLUDED.recovery_hashes, updated_at = NOW()`,
    [s.userId, JSON.stringify(codes.map((c) => sha256(normCode(c))))]);
  return { token, recoveryCodes: codes };
}

// ---------------------------------------------------------------- estado

// GET /api/mfa/status
mfaRouter.get('/mfa/status', async (req, res) => {
  const s = await staff(req, res, { allowPending: true });
  if (!s) return;
  const methods = await getMfaMethods(s.userId);
  const { rows: passkeys } = await pool.query(
    `SELECT id, name, created_at, last_used_at FROM staff_passkeys WHERE user_id = $1 ORDER BY id`, [s.userId]);
  res.json({ pending: s.pending, setupRequired: !hasAnyMethod(methods), methods, passkeys: s.pending ? [] : passkeys });
});

// ---------------------------------------------------------------- llaves de acceso

// POST /api/mfa/passkey/register-options
mfaRouter.post('/mfa/passkey/register-options', async (req, res) => {
  const s = await staff(req, res, { allowPending: true });
  if (!s || !(await canEnroll(s, res))) return;
  const { rows: existing } = await pool.query(`SELECT credential_id, transports FROM staff_passkeys WHERE user_id = $1`, [s.userId]);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: s.email,
    userDisplayName: [s.user.first_name, s.user.last_name].filter(Boolean).join(' ') || s.email,
    userID: new TextEncoder().encode(`eym-${s.userId}`),
    attestationType: 'none',
    excludeCredentials: existing.map((c: any) => ({ id: c.credential_id, transports: c.transports || [] })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  putChallenge(`reg:${s.userId}`, options.challenge);
  res.json(options);
});

// POST /api/mfa/passkey/register-verify  { response, name? }
mfaRouter.post('/mfa/passkey/register-verify', mfaLimiter, async (req, res) => {
  const s = await staff(req, res, { allowPending: true });
  if (!s || !(await canEnroll(s, res))) return;
  const expectedChallenge = takeChallenge(`reg:${s.userId}`);
  if (!expectedChallenge) return res.status(400).json({ error: 'La solicitud ha caducado; vuelve a intentarlo' });
  try {
    const v = await verifyRegistrationResponse({
      response: req.body?.response, expectedChallenge, expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: true,
    });
    if (!v.verified) return res.status(400).json({ error: 'No se pudo verificar la llave de acceso' });
    const c = v.registrationInfo.credential;
    const name = String(req.body?.name || '').trim().slice(0, 60) || 'Llave de acceso';
    await pool.query(
      `INSERT INTO staff_passkeys (user_id, credential_id, public_key, counter, transports, name)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [s.userId, c.id, Buffer.from(c.publicKey).toString('base64url'), c.counter, JSON.stringify(c.transports || []), name]);
    res.json(await complete(s));
  } catch (err: any) {
    console.warn('[MFA] registro de llave:', err.message);
    res.status(400).json({ error: 'No se pudo registrar la llave de acceso' });
  }
});

// POST /api/mfa/passkey/auth-options — segundo paso con la llave de acceso.
mfaRouter.post('/mfa/passkey/auth-options', async (req, res) => {
  const s = await staff(req, res, { allowPending: true });
  if (!s) return;
  const { rows } = await pool.query(`SELECT credential_id, transports FROM staff_passkeys WHERE user_id = $1`, [s.userId]);
  if (!rows.length) return res.status(400).json({ error: 'Esta cuenta no tiene llaves de acceso' });
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: rows.map((c: any) => ({ id: c.credential_id, transports: c.transports || [] })),
    userVerification: 'required',
  });
  putChallenge(`auth:${s.userId}`, options.challenge);
  res.json(options);
});

// POST /api/mfa/passkey/auth-verify  { response }
mfaRouter.post('/mfa/passkey/auth-verify', mfaLimiter, async (req, res) => {
  const s = await staff(req, res, { allowPending: true });
  if (!s) return;
  const expectedChallenge = takeChallenge(`auth:${s.userId}`);
  if (!expectedChallenge) return res.status(400).json({ error: 'La solicitud ha caducado; vuelve a intentarlo' });
  const credId = String(req.body?.response?.id || '');
  const { rows: [pk] } = await pool.query(`SELECT * FROM staff_passkeys WHERE user_id = $1 AND credential_id = $2`, [s.userId, credId]);
  if (!pk) return res.status(400).json({ error: 'Llave de acceso no reconocida' });
  try {
    const v = await verifyAuthenticationResponse({
      response: req.body.response, expectedChallenge, expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: true,
      credential: { id: pk.credential_id, publicKey: new Uint8Array(Buffer.from(pk.public_key, 'base64url')), counter: Number(pk.counter), transports: pk.transports || [] },
    });
    if (!v.verified) return res.status(400).json({ error: 'No se pudo verificar la llave de acceso' });
    await pool.query(`UPDATE staff_passkeys SET counter = $2, last_used_at = NOW() WHERE id = $1`, [pk.id, v.authenticationInfo.newCounter]);
    res.json(await complete(s));
  } catch (err: any) {
    console.warn('[MFA] llave de acceso:', err.message);
    res.status(400).json({ error: 'No se pudo verificar la llave de acceso' });
  }
});

// DELETE /api/mfa/passkey/:id — quitar una llave (sesión completa y que quede otro método).
mfaRouter.delete('/mfa/passkey/:id', async (req, res) => {
  const s = await staff(req, res, { allowPending: false });
  if (!s) return;
  const m = await getMfaMethods(s.userId);
  if (m.passkeys + (m.totp ? 1 : 0) <= 1) return res.status(400).json({ error: 'Es tu único método: añade otro antes de quitarlo' });
  await pool.query(`DELETE FROM staff_passkeys WHERE id = $1 AND user_id = $2`, [parseInt(req.params.id, 10) || 0, s.userId]);
  res.json({ success: true });
});

// ---------------------------------------------------------------- Google Authenticator

// POST /api/mfa/totp/setup — QR para escanear (aún no se activa).
mfaRouter.post('/mfa/totp/setup', async (req, res) => {
  const s = await staff(req, res, { allowPending: true });
  if (!s || !(await canEnroll(s, res))) return;
  const secret = authenticator.generateSecret();
  await pool.query(
    `INSERT INTO staff_mfa (user_id, totp_secret_enc, totp_enabled, updated_at) VALUES ($1, $2, false, NOW())
     ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = EXCLUDED.totp_secret_enc,
       totp_enabled = CASE WHEN staff_mfa.totp_enabled THEN true ELSE false END, updated_at = NOW()
     WHERE NOT staff_mfa.totp_enabled`,
    [s.userId, encrypt(secret)]);
  const { rows: [m] } = await pool.query(`SELECT totp_enabled FROM staff_mfa WHERE user_id = $1`, [s.userId]);
  if (m?.totp_enabled) return res.status(400).json({ error: 'Google Authenticator ya está activado' });
  const otpauth = authenticator.keyuri(s.email, RP_NAME, secret);
  res.json({ qr: await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }), secret });
});

// POST /api/mfa/totp/enable  { code }
mfaRouter.post('/mfa/totp/enable', mfaLimiter, async (req, res) => {
  const s = await staff(req, res, { allowPending: true });
  if (!s || !(await canEnroll(s, res))) return;
  const { rows: [m] } = await pool.query(`SELECT totp_secret_enc, totp_enabled FROM staff_mfa WHERE user_id = $1`, [s.userId]);
  if (!m?.totp_secret_enc || m.totp_enabled) return res.status(400).json({ error: 'Vuelve a generar el código QR' });
  if (!authenticator.check(String(req.body?.code || '').replace(/\s/g, ''), decrypt(m.totp_secret_enc))) {
    return res.status(400).json({ error: 'Código incorrecto' });
  }
  await pool.query(`UPDATE staff_mfa SET totp_enabled = true, updated_at = NOW() WHERE user_id = $1`, [s.userId]);
  res.json(await complete(s));
});

// POST /api/mfa/totp/verify  { code } — segundo paso con Google Authenticator.
mfaRouter.post('/mfa/totp/verify', mfaLimiter, async (req, res) => {
  const s = await staff(req, res, { allowPending: true });
  if (!s) return;
  const { rows: [m] } = await pool.query(`SELECT totp_secret_enc, totp_enabled FROM staff_mfa WHERE user_id = $1`, [s.userId]);
  if (!m?.totp_enabled) return res.status(400).json({ error: 'Esta cuenta no usa Google Authenticator' });
  if (!authenticator.check(String(req.body?.code || '').replace(/\s/g, ''), decrypt(m.totp_secret_enc))) {
    return res.status(400).json({ error: 'Código incorrecto' });
  }
  res.json(await complete(s));
});

// POST /api/mfa/totp/disable — sesión completa y que quede otro método.
mfaRouter.post('/mfa/totp/disable', async (req, res) => {
  const s = await staff(req, res, { allowPending: false });
  if (!s) return;
  const m = await getMfaMethods(s.userId);
  if (!m.passkeys) return res.status(400).json({ error: 'Es tu único método: añade una llave de acceso antes de quitarlo' });
  await pool.query(`UPDATE staff_mfa SET totp_enabled = false, totp_secret_enc = NULL, updated_at = NOW() WHERE user_id = $1`, [s.userId]);
  res.json({ success: true });
});

// ---------------------------------------------------------------- códigos de recuperación

// POST /api/mfa/recovery/verify  { code } — entrar sin el móvil (el código se gasta).
mfaRouter.post('/mfa/recovery/verify', mfaLimiter, async (req, res) => {
  const s = await staff(req, res, { allowPending: true });
  if (!s) return;
  const hash = sha256(normCode(req.body?.code));
  const { rowCount } = await pool.query(
    `UPDATE staff_mfa SET recovery_hashes = recovery_hashes - $2, updated_at = NOW()
     WHERE user_id = $1 AND recovery_hashes ? $2`, [s.userId, hash]);
  if (!rowCount) return res.status(400).json({ error: 'Código de recuperación incorrecto o ya usado' });
  res.json(await complete(s));
});

// POST /api/mfa/recovery/regenerate — códigos nuevos (los anteriores dejan de valer).
mfaRouter.post('/mfa/recovery/regenerate', async (req, res) => {
  const s = await staff(req, res, { allowPending: false });
  if (!s) return;
  const codes = newRecoveryCodes();
  await pool.query(
    `INSERT INTO staff_mfa (user_id, recovery_hashes, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET recovery_hashes = EXCLUDED.recovery_hashes, updated_at = NOW()`,
    [s.userId, JSON.stringify(codes.map((c) => sha256(normCode(c))))]);
  res.json({ recoveryCodes: codes });
});
