import { Router } from 'express';
import { requireAdminRole } from '../lib/agent-auth.js';
import { generateOverviewAiReport } from '../lib/overview-ai.js';
import { buildOverviewPdf } from '../lib/overview-pdf.js';
import { getOverviewReport } from '../lib/overview-report.js';

/**
 * Vista general del panel: informe completo de KPIs por periodo, informe redactado por la IA y PDF.
 * Solo administradores (con la verificación en dos pasos hecha: lo comprueba `requireAdminRole`).
 */
export const overviewRouter = Router();

const pick = (req: any) => {
  const src = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  return { preset: src.preset, from: src.from, to: src.to, excludeInternal: src.excludeInternal !== false && src.excludeInternal !== 'false' };
};

// GET /api/admin/overview/report?preset=today|yesterday|7d|30d|month|prev_month|year|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
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
    const key = `${report.period.from}|${report.period.to}|${excludeInternal}`;
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
