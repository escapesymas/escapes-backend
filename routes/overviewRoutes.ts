import { Router } from 'express';
import { requireAdminRole } from '../lib/agent-auth.js';
import { generateOverviewAiReport } from '../lib/overview-ai.js';
import {
  KIND_NAMES, MAX_RECIPIENTS, REPORT_KINDS, SEND_HOUR, loadConfig, loadLastSent, loadLog, nextSendDate, sanitizeConfig, saveConfig, sendOverviewReport, type Due, type ReportKind,
} from '../lib/overview-email.js';
import { buildOverviewPdf } from '../lib/overview-pdf.js';
import { addDays, madridToday } from '../lib/overview-period.js';
import { getOverviewReport } from '../lib/overview-report.js';

/**
 * Vista general del panel: informe completo de KPIs por periodo, informe redactado por la IA y PDF.
 * Solo administradores (con la verificación en dos pasos hecha: lo comprueba `requireAdminRole`).
 */
export const overviewRouter = Router();

const pick = (req: any) => {
  const src = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  return { preset: src.preset, from: src.from, to: src.to, compare: src.compare, excludeInternal: src.excludeInternal !== false && src.excludeInternal !== 'false' };
};

// GET /api/admin/overview/report?preset=today|yesterday|7d|30d|month|prev_month|year|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&compare=prev|yoy
overviewRouter.get('/admin/overview/report', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;
  try {
    const { excludeInternal, ...period } = pick(req);
    res.json(await getOverviewReport(period, excludeInternal));
  } catch (err: any) {
    console.error('[OVERVIEW REPORT ERROR]:', err);
    res.status(500).json({ error: 'No se pudo calcular el informe' });
  }
});

// El informe de la IA cuesta dinero y tarda: como mucho 6 por administrador cada 10 minutos, y el mismo periodo se reparte desde caché.
const aiHits = new Map<number, number[]>();
const aiCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof generateOverviewAiReport>> & { generatedAt: string } }>();
const AI_WINDOW_MS = 10 * 60_000;
const AI_MAX = 6;
const AI_CACHE_MS = 10 * 60_000;

// POST /api/admin/overview/ai-report   { preset, from?, to?, force? }
overviewRouter.post('/admin/overview/ai-report', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;
  try {
    const { excludeInternal, ...period } = pick(req);
    const report = await getOverviewReport(period, excludeInternal);
    const key = `${report.period.from}|${report.period.to}|${report.period.compare}|${excludeInternal}`;
    const cached = aiCache.get(key);
    if (cached && Date.now() - cached.at < AI_CACHE_MS && req.body?.force !== true) {
      return res.json({ ...cached.value, cached: true, period: report.period });
    }
    const now = Date.now();
    const recent = (aiHits.get(admin.user_id) || []).filter((t) => now - t < AI_WINDOW_MS);
    if (recent.length >= AI_MAX) {
      return res.status(429).json({ error: 'Has generado muchos informes seguidos. Espera unos minutos.' });
    }
    aiHits.set(admin.user_id, [...recent, now]);

    const started = Date.now();
    const result = await generateOverviewAiReport(report);
    const value = { ...result, generatedAt: new Date().toISOString() };
    aiCache.set(key, { at: Date.now(), value });
    console.log(`[overview-ai] user=${admin.user_id} periodo=${report.period.from}..${report.period.to} intentos=${result.attempts} tokens=${result.tokens} ms=${Date.now() - started}`);
    return res.json({ ...value, cached: false, period: report.period });
  } catch (err: any) {
    console.error('[OVERVIEW AI ERROR]:', err?.message || err);
    return res.status(502).json({ error: 'No se pudo generar el informe con la IA. Inténtalo de nuevo en un momento.' });
  }
});

// POST /api/admin/overview/pdf   { preset, from?, to?, aiText? }  → application/pdf
overviewRouter.post('/admin/overview/pdf', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;
  try {
    const { excludeInternal, ...period } = pick(req);
    const report = await getOverviewReport(period, excludeInternal);
    const aiText = typeof req.body?.aiText === 'string' ? req.body.aiText.slice(0, 20_000) : undefined;
    const pdf = await buildOverviewPdf(report, aiText);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': `attachment; filename="informe-escapesymas-${report.period.from}_${report.period.to}.pdf"`,
      'Cache-Control': 'no-store',
    });
    return res.send(pdf);
  } catch (err: any) {
    console.error('[OVERVIEW PDF ERROR]:', err);
    return res.status(500).json({ error: 'No se pudo generar el PDF' });
  }
});

// ─────────────────────────── Informes programados por correo ───────────────────────────

const emailState = async () => {
  const [config, last, log] = await Promise.all([loadConfig(), loadLastSent(), loadLog()]);
  const now = new Date();
  return {
    config, log, sendHour: SEND_HOUR, maxRecipients: MAX_RECIPIENTS,
    next: Object.fromEntries(REPORT_KINDS.map((k) => [k, nextSendDate(k, now, last[k])])),
  };
};

// GET /api/admin/overview/email-config → configuración, próximos envíos y últimos envíos
overviewRouter.get('/admin/overview/email-config', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;
  try {
    res.json({ ...(await emailState()), adminEmail: admin.email || null });
  } catch (err: any) {
    console.error('[OVERVIEW EMAIL CONFIG ERROR]:', err);
    res.status(500).json({ error: 'No se pudo leer la configuración' });
  }
});

// PUT /api/admin/overview/email-config   { recipients, includeAi, daily|weekly|monthly: { enabled, compare } }
overviewRouter.put('/admin/overview/email-config', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;
  try {
    const cfg = sanitizeConfig(req.body);
    const sent = Array.isArray(req.body?.recipients) ? req.body.recipients.length : String(req.body?.recipients || '').split(/[\s,;]+/).filter(Boolean).length;
    if (sent > cfg.recipients.length) {
      return res.status(400).json({ error: `Hay correos incorrectos o repetidos (como mucho ${MAX_RECIPIENTS}). Revisa la lista de destinatarios.` });
    }
    if (!cfg.recipients.length && REPORT_KINDS.some((k) => cfg[k].enabled)) {
      return res.status(400).json({ error: 'Añade al menos un correo de destino para los informes activados.' });
    }
    await saveConfig(cfg);
    console.log(`[overview-email] configuración guardada por user=${admin.user_id}: ${cfg.recipients.length} destinatario(s), ${REPORT_KINDS.filter((k) => cfg[k].enabled).map((k) => KIND_NAMES[k]).join('+') || 'nada activado'}`);
    return res.json(await emailState());
  } catch (err: any) {
    console.error('[OVERVIEW EMAIL SAVE ERROR]:', err);
    return res.status(500).json({ error: 'No se pudo guardar la configuración' });
  }
});

// Pruebas: solo al correo del administrador que las pide, y como mucho 4 cada 10 minutos.
const testHits = new Map<number, number[]>();

// POST /api/admin/overview/email-test   { kind: 'daily'|'weekly'|'monthly' }  → envía un informe «[PRUEBA]» al correo de quien lo pide
overviewRouter.post('/admin/overview/email-test', async (req: any, res: any) => {
  const admin = await requireAdminRole(req, res);
  if (!admin) return;
  const kind = String(req.body?.kind) as ReportKind;
  if (!REPORT_KINDS.includes(kind)) return res.status(400).json({ error: 'Tipo de informe no válido' });
  if (!admin.email) return res.status(400).json({ error: 'Tu cuenta no tiene correo al que enviar la prueba' });
  const now = Date.now();
  const recent = (testHits.get(admin.user_id) || []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 4) return res.status(429).json({ error: 'Has pedido muchas pruebas seguidas. Espera unos minutos.' });
  testHits.set(admin.user_id, [...recent, now]);
  try {
    const cfg = await loadConfig();
    const today = madridToday();
    const sinceMonday = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7; // días desde el lunes
    const monday = addDays(today, -sinceMonday);
    const first = `${today.slice(0, 7)}-01`;
    const lastOfPrev = addDays(first, -1);
    const period: Due['period'] = kind === 'daily'
      ? { preset: 'custom', from: addDays(today, -1), to: addDays(today, -1), compare: cfg.daily.compare }
      : kind === 'weekly'
        ? { preset: 'custom', from: addDays(monday, -7), to: addDays(monday, -1), compare: cfg.weekly.compare }
        : { preset: 'custom', from: `${lastOfPrev.slice(0, 7)}-01`, to: lastOfPrev, compare: cfg.monthly.compare };
    const entry = await sendOverviewReport({ kind, key: `prueba-${now}`, period }, { to: [admin.email], includeAi: cfg.includeAi, test: true });
    return res.json({ ok: true, to: admin.email, subject: entry.subject, ai: entry.ai });
  } catch (err: any) {
    console.error('[OVERVIEW EMAIL TEST ERROR]:', err?.message || err);
    return res.status(502).json({ error: 'No se pudo enviar la prueba. Inténtalo de nuevo en un momento.' });
  }
});
