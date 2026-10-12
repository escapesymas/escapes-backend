/**
 * Avisos de piezas nuevas para la moto (lib/moto-alerts.ts):
 *   POST /api/moto-alerts               botón «Avísame cuando haya piezas para mi moto»
 *   GET|POST /api/moto-alerts/baja      baja desde el enlace del correo (pide confirmar:
 *                                       los antivirus del correo abren los enlaces solos)
 *   GET|PUT /api/moto-alerts/prefs      avisos de las motos del garaje (perfil del cliente)
 *   GET /api/admin/moto-alerts          resumen para el admin
 *   POST /api/admin/moto-alerts/run     pasada manual
 */
import express, { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { pool } from '../db.js';
import { authenticateRequest } from '../utils.js';
import { requireAdminRole } from '../lib/agent-auth.js';
import { BRAND, BRAND_URL, C, MONO, FONT, escapeHtml } from '../lib/email-templates.js';
import { parseBikeLabel, bikeLabel } from '../lib/moto-catalog.js';
import {
  createMotoAlert, sendAlertConfirmation, unsubscribeMotoAlert, garageAlertsEnabled, setGarageAlertsEnabled,
  runMotoAlerts, normEmail,
} from '../lib/moto-alerts.js';

export const motoAlertRouter = Router();

// Ruta pública que escribe en la BD y manda un correo: límite propio.
const alertLimiter = rateLimit({
  keyGenerator: (req: any) => ipKeyGenerator(req.clientIp || req.ip || 'unknown'),
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados avisos seguidos. Espera unos minutos.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

motoAlertRouter.post('/moto-alerts', alertLimiter, async (req: any, res) => {
  try {
    const moto = parseBikeLabel(String(req.body?.bike || ''));
    if (!moto) return res.status(400).json({ error: 'No encontramos esa moto. Elígela otra vez en el selector.' });

    // Con sesión, el correo de la cuenta; sin sesión, el que escribe el cliente.
    const auth = authenticateRequest(req);
    let email = normEmail(req.body?.email);
    let userId: number | null = null;
    if (auth?.user_id) {
      const { rows: [u] } = await pool.query(`SELECT id, email FROM users WHERE id = $1`, [auth.user_id]);
      if (u) { userId = u.id; if (!email) email = normEmail(u.email); }
    }
    if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Correo electrónico no válido' });

    const alert = await createMotoAlert({ ...moto, email, userId, source: 'boton' });
    if (alert.created) {
      sendAlertConfirmation(email, moto, alert.token).catch((e) => console.error('[MOTO ALERTS] Confirmación:', e.message));
    }
    res.json({ success: true, email, bike: bikeLabel(moto.brand, moto.model, moto.year), already: !alert.created });
  } catch (e: any) {
    console.error('[MOTO ALERTS] Alta:', e.message);
    res.status(500).json({ error: 'No se pudo guardar el aviso' });
  }
});

/** Página sencilla con el estilo de los correos. */
function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${BRAND}</title><meta name="robots" content="noindex"></head>
<body style="margin:0;background:${C.page};font-family:${FONT};color:${C.body}">
<div style="max-width:520px;margin:40px auto;padding:0 16px">
<div style="background:${C.card};border:1px solid ${C.border};border-top:4px solid ${C.accent};border-radius:12px;padding:28px 24px">
<h1 style="margin:0 0 14px;font-family:${MONO};font-size:20px;text-transform:uppercase;color:${C.text}">${escapeHtml(title)}</h1>
${body}
<p style="margin:22px 0 0"><a href="${BRAND_URL}" style="color:${C.text};font-weight:700">Volver a escapesymas.com</a></p>
</div></div></body></html>`;
}

const btn = `display:inline-block;margin-top:8px;padding:12px 22px;background:${C.accent};color:${C.text};border:0;border-radius:8px;font-family:${MONO};font-size:14px;font-weight:700;text-transform:uppercase;cursor:pointer`;

motoAlertRouter.get('/moto-alerts/baja', async (req, res) => {
  const token = String(req.query.token || '');
  const all = req.query.todas === '1';
  const { rows: [a] } = await pool.query(`SELECT brand, model, year FROM moto_alerts WHERE token = $1`, [token]).catch(() => ({ rows: [] as any[] }));
  if (!a) return res.status(404).send(page('Enlace no válido', '<p>Este enlace de baja no existe o ha caducado.</p>'));
  const what = all ? 'ningún aviso de piezas nuevas' : `más avisos de piezas para tu <strong>${escapeHtml(bikeLabel(a.brand, a.model, a.year))}</strong>`;
  res.send(page('Darme de baja', `<p>¿Seguro que no quieres recibir ${what}?</p>
<form method="post" action="/api/moto-alerts/baja"><input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="todas" value="${all ? '1' : ''}"><button type="submit" style="${btn}">Sí, darme de baja</button></form>`));
});

motoAlertRouter.post('/moto-alerts/baja', alertLimiter, express.urlencoded({ extended: false }), async (req: any, res) => {
  const all = req.body?.todas === '1';
  const r = await unsubscribeMotoAlert(String(req.body?.token || ''), all).catch(() => ({ ok: false } as { ok: boolean; label?: string }));
  if (!r.ok) return res.status(404).send(page('Enlace no válido', '<p>Este enlace de baja no existe o ha caducado.</p>'));
  res.send(page('Hecho', all
    ? '<p>No te enviaremos más avisos de piezas nuevas. Si cambias de idea, actívalos en tu perfil o con el botón «Avísame» de la web.</p>'
    : `<p>No te enviaremos más avisos para tu <strong>${escapeHtml(r.label || '')}</strong>.</p>`));
});

motoAlertRouter.get('/moto-alerts/prefs', async (req: any, res) => {
  const auth = authenticateRequest(req);
  if (!auth?.email) return res.status(401).json({ error: 'Inicia sesión' });
  res.json({ garageAlerts: await garageAlertsEnabled(auth.email) });
});

motoAlertRouter.put('/moto-alerts/prefs', async (req: any, res) => {
  const auth = authenticateRequest(req);
  if (!auth?.email) return res.status(401).json({ error: 'Inicia sesión' });
  await setGarageAlertsEnabled(auth.email, !!req.body?.garageAlerts);
  res.json({ garageAlerts: !!req.body?.garageAlerts });
});

motoAlertRouter.get('/admin/moto-alerts', async (req: any, res) => {
  if (!(await requireAdminRole(req, res))) return;
  const { rows } = await pool.query(
    `SELECT brand, model, year, source, COUNT(*)::int AS clientes, MAX(last_sent_at) AS ultimo_envio
     FROM moto_alerts WHERE unsubscribed_at IS NULL GROUP BY 1, 2, 3, 4 ORDER BY clientes DESC, brand, model LIMIT 200`);
  const { rows: [t] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE unsubscribed_at IS NULL)::int AS activos,
            COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS bajas,
            (SELECT COUNT(*)::int FROM moto_alert_optout) AS bajas_totales
     FROM moto_alerts`);
  res.json({ totals: t, motos: rows });
});

motoAlertRouter.post('/admin/moto-alerts/run', async (req: any, res) => {
  if (!(await requireAdminRole(req, res))) return;
  res.json(await runMotoAlerts('admin'));
});
