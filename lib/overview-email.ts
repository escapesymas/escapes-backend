/**
 * Informes de la Vista general por correo: diario (ayer), semanal (la semana de lunes a domingo que acaba de pasar) y mensual
 * (el mes anterior). Cada correo lleva los indicadores clave comparados, el análisis de la IA (opcional) y el PDF completo adjunto.
 *
 * La configuración (destinatarios, qué informes, con qué se comparan) vive en `app_settings` y se edita en Ajustes › Informes.
 * Un trabajo mira cada 5 minutos si toca enviar algo; cada informe se marca como enviado ANTES de mandarlo (UPSERT condicional),
 * así que no se duplica aunque se reinicie el servidor a esa hora. Apagado de emergencia: OVERVIEW_EMAIL_DISABLED=true.
 */
import { pool } from '../db.js';
import { sendEmail } from './email.js';
import { BRAND_URL, C, FONT, MONO, escapeHtml } from './email-templates.js';
import { generateOverviewAiReport } from './overview-ai.js';
import { GROUP_TITLES, deltaOf, fmtDateTime, fmtValue, type Delta } from './overview-format.js';
import { buildOverviewPdf } from './overview-pdf.js';
import { COMPARISON_MODES, addDays, madridToday, rangeText, type ComparisonMode } from './overview-period.js';
import { getOverviewReport, type Kpi, type OverviewReport } from './overview-report.js';

export type ReportKind = 'daily' | 'weekly' | 'monthly';
export const REPORT_KINDS: ReportKind[] = ['daily', 'weekly', 'monthly'];

export interface ScheduleConfig { enabled: boolean; compare: ComparisonMode }
export interface OverviewEmailConfig {
  recipients: string[];
  /** Incluir el análisis redactado por la IA (cuesta unos céntimos por informe). */
  includeAi: boolean;
  daily: ScheduleConfig;
  weekly: ScheduleConfig;
  monthly: ScheduleConfig;
}

export const DEFAULT_CONFIG: OverviewEmailConfig = {
  recipients: ['info@escapesymas.com'],
  includeAi: true,
  daily: { enabled: false, compare: 'prev' },
  weekly: { enabled: true, compare: 'prev' },
  monthly: { enabled: true, compare: 'prev' },
};

export const KIND_NAMES: Record<ReportKind, string> = { daily: 'diario', weekly: 'semanal', monthly: 'mensual' };
export const MAX_RECIPIENTS = 5;
/** Hora (de Madrid) a partir de la cual se envía. */
export const SEND_HOUR = 8;

const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']{2,}$/;

/** Config segura a partir de lo que llegue (del panel o de la base de datos): correos válidos, sin repetir y como mucho 5. */
export function sanitizeConfig(input: unknown): OverviewEmailConfig {
  const src: any = input && typeof input === 'object' ? input : {};
  const list: unknown[] = Array.isArray(src.recipients) ? src.recipients : typeof src.recipients === 'string' ? src.recipients.split(/[\s,;]+/) : DEFAULT_CONFIG.recipients;
  const recipients = [...new Set(list.map((r) => String(r).trim().toLowerCase()).filter((r) => r.length <= 120 && EMAIL_RE.test(r)))].slice(0, MAX_RECIPIENTS);
  const schedule = (key: ReportKind): ScheduleConfig => ({
    enabled: typeof src[key]?.enabled === 'boolean' ? src[key].enabled : DEFAULT_CONFIG[key].enabled,
    compare: COMPARISON_MODES.includes(src[key]?.compare) ? src[key].compare : DEFAULT_CONFIG[key].compare,
  });
  return {
    recipients,
    includeAi: typeof src.includeAi === 'boolean' ? src.includeAi : DEFAULT_CONFIG.includeAi,
    daily: schedule('daily'), weekly: schedule('weekly'), monthly: schedule('monthly'),
  };
}

/* ───────────────────────── Cuándo toca enviar ───────────────────────── */

export interface Due {
  kind: ReportKind;
  /** Identifica este envío para no repetirlo (el día, el lunes de la semana o el 1 del mes en que toca enviar). */
  key: string;
  period: { preset: string; from?: string; to?: string; compare: ComparisonMode };
}

/** Fecha, día de la semana (1 = lunes … 7 = domingo), día del mes y hora en Madrid. */
export function madridParts(now: Date): { date: string; weekday: number; day: number; hour: number } {
  const date = madridToday(now);
  const hour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(now), 10) % 24;
  const wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short' }).format(now);
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd) + 1;
  return { date, weekday, day: Number(date.slice(8)), hour };
}

/**
 * Informes que tocan ahora y todavía no se han enviado. Se envían a partir de las 8:00 de Madrid; si ese día el servidor
 * estaba parado, el semanal y el mensual aún salen al día siguiente (el diario no: un informe de «ayer» tarde es de antier).
 */
export function dueReports(now: Date, cfg: OverviewEmailConfig, last: Record<ReportKind, string | null>): Due[] {
  const { date, weekday, day, hour } = madridParts(now);
  if (hour < SEND_HOUR) return [];
  const out: Due[] = [];

  if (cfg.daily.enabled && last.daily !== date) {
    const y = addDays(date, -1);
    out.push({ kind: 'daily', key: date, period: { preset: 'custom', from: y, to: y, compare: cfg.daily.compare } });
  }

  const monday = weekday === 1 ? date : weekday === 2 ? addDays(date, -1) : null;
  if (cfg.weekly.enabled && monday && last.weekly !== monday) {
    out.push({ kind: 'weekly', key: monday, period: { preset: 'custom', from: addDays(monday, -7), to: addDays(monday, -1), compare: cfg.weekly.compare } });
  }

  const first = day === 1 ? date : day === 2 ? addDays(date, -1) : null;
  if (cfg.monthly.enabled && first && last.monthly !== first) {
    const lastDay = addDays(first, -1);
    out.push({ kind: 'monthly', key: first, period: { preset: 'custom', from: `${lastDay.slice(0, 7)}-01`, to: lastDay, compare: cfg.monthly.compare } });
  }
  return out;
}

/** Próximo día de envío (YYYY-MM-DD) de cada informe, para enseñarlo en el panel. */
export function nextSendDate(kind: ReportKind, now: Date, lastKey: string | null): string {
  const { date, weekday, day, hour } = madridParts(now);
  const todayStillOpen = (key: string) => hour < SEND_HOUR && lastKey !== key; // hoy aún no es la hora y no se ha enviado
  if (kind === 'daily') return todayStillOpen(date) ? date : addDays(date, 1);
  if (kind === 'weekly') {
    if (weekday === 1 && todayStillOpen(date)) return date;
    return addDays(date, 8 - weekday); // el lunes siguiente
  }
  if (day === 1 && todayStillOpen(date)) return date;
  const [y, m] = date.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/* ───────────────────────── Configuración y estado en la base de datos ───────────────────────── */

const CONFIG_KEY = 'overview_email';
const LOG_KEY = 'overview_email_log';
const lastKey = (kind: ReportKind) => `overview_email_last_${kind}`;

export async function loadConfig(): Promise<OverviewEmailConfig> {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [CONFIG_KEY]);
  return rows[0] ? sanitizeConfig(rows[0].value) : DEFAULT_CONFIG;
}

export async function saveConfig(cfg: OverviewEmailConfig): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [CONFIG_KEY, JSON.stringify(cfg)]);
}

export async function loadLastSent(): Promise<Record<ReportKind, string | null>> {
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [REPORT_KINDS.map(lastKey)]);
  const out: Record<ReportKind, string | null> = { daily: null, weekly: null, monthly: null };
  for (const k of REPORT_KINDS) out[k] = typeof rows.find((r: any) => r.key === lastKey(k))?.value === 'string' ? rows.find((r: any) => r.key === lastKey(k)).value : null;
  return out;
}

/** Marca el envío como hecho antes de mandarlo; false si otro proceso (o un reinicio anterior) ya lo había marcado. */
async function claim(kind: ReportKind, key: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, to_jsonb($2::text), NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value`, [lastKey(kind), key]);
  return !!rowCount;
}

/** Deshace la marca (el envío falló y se reintentará); `previous` es lo que había antes. */
async function release(kind: ReportKind, previous: string | null): Promise<void> {
  if (previous) await pool.query(`UPDATE app_settings SET value = to_jsonb($2::text), updated_at = NOW() WHERE key = $1`, [lastKey(kind), previous]);
  else await pool.query(`DELETE FROM app_settings WHERE key = $1`, [lastKey(kind)]);
}

export interface LogEntry { kind: ReportKind; at: string; ok: boolean; test: boolean; subject: string; to: string; ai: boolean; error?: string }

export async function loadLog(): Promise<LogEntry[]> {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [LOG_KEY]);
  return Array.isArray(rows[0]?.value) ? rows[0].value : [];
}

async function appendLog(entry: LogEntry): Promise<void> {
  const log = [entry, ...(await loadLog())].slice(0, 12);
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [LOG_KEY, JSON.stringify(log)]);
}

/* ───────────────────────── El correo ───────────────────────── */

/** Markdown sencillo de la IA (títulos «##», listas, negritas) a HTML de correo. Todo el texto se escapa antes. */
export function markdownToHtml(md: string): string {
  const inline = (t: string) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, `<strong style="color:${C.text}">$1</strong>`);
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) {
      close();
      out.push(`<h3 style="margin:22px 0 6px;font-family:${MONO};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.accentText}">${inline(h[1])}</h3>`);
      continue;
    }
    const li = /^(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const want = li[1] ? 'ol' : 'ul';
      if (list !== want) { close(); out.push(`<${want} style="margin:6px 0 10px;padding-left:22px;color:${C.body}">`); list = want; }
      out.push(`<li style="margin:0 0 6px;line-height:1.55">${inline(li[2])}</li>`);
      continue;
    }
    close();
    out.push(`<p style="margin:0 0 10px;line-height:1.6;color:${C.body}">${inline(line)}</p>`);
  }
  close();
  return out.join('\n');
}

const deltaColor = (d: Delta) => (d.sentiment === 'good' ? C.ok : d.sentiment === 'bad' ? '#b91c1c' : C.muted);
const arrow = (d: Delta) => (d.dir === 'up' || d.dir === 'new' ? '▲ ' : d.dir === 'down' ? '▼ ' : '');

function kpiCell(k: Kpi): string {
  const d = deltaOf(k);
  const delta = k.noPrev ? 'sin datos de comparación' : d.dir === 'none' ? 'foto del momento' : `${arrow(d)}${d.text}`;
  const color = k.noPrev || d.dir === 'none' ? C.muted : deltaColor(d);
  return `<td width="25%" valign="top" style="padding:4px">
      <div style="border:1px solid ${C.border};border-radius:8px;padding:10px 10px 9px;background:${C.card}">
        <div style="font-family:${MONO};font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:${C.muted};line-height:1.35;min-height:24px">${escapeHtml(k.label)}</div>
        <div style="margin-top:4px;font-family:${MONO};font-size:17px;font-weight:700;color:${C.text}">${escapeHtml(fmtValue(k.value, k.unit))}</div>
        <div style="margin-top:3px;font-size:11px;font-weight:700;color:${color}">${escapeHtml(delta)}</div>
      </div></td>`;
}

export interface RenderedReportEmail { subject: string; html: string; text: string }

export function renderReportEmail(opts: { report: OverviewReport; kind: ReportKind; aiText?: string | null; aiError?: string | null; test?: boolean }): RenderedReportEmail {
  const { report, kind, aiText, aiError, test } = opts;
  const p = report.period;
  const byId = new Map(report.kpis.map((k) => [k.id, k]));
  const headline = report.headline.map((id) => byId.get(id)).filter((k): k is Kpi => !!k);
  const sales = byId.get('sales_revenue');
  const salesDelta = sales ? deltaOf(sales) : null;
  const when = p.from === p.to ? p.label.replace(/^Del /, '') : `${rangeText(p.from, p.to)}`;
  const subject = `${test ? '[PRUEBA] ' : ''}Informe ${KIND_NAMES[kind]} · ${when}${sales ? ` · ventas ${fmtValue(sales.value, 'eur')}${salesDelta?.text && salesDelta.dir !== 'none' && !sales.noPrev ? ` (${salesDelta.text})` : ''}` : ''}`;

  const rows: string[] = [];
  for (let i = 0; i < headline.length; i += 4) rows.push(`<tr>${headline.slice(i, i + 4).map(kpiCell).join('')}</tr>`);

  const funnel = report.funnel.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:6px 0 4px">${report.funnel.map((s) => `
        <tr><td style="padding:3px 0;font-size:13px;color:${C.body}">${escapeHtml(s.label)}</td>
            <td align="right" style="padding:3px 0;font-family:${MONO};font-size:13px;font-weight:700;color:${C.text}">${fmtValue(s.current, 'int')}</td>
            <td align="right" width="150" style="padding:3px 0 3px 10px;font-size:11px;color:${C.muted}">${s.previous == null ? 'sin datos' : `antes ${fmtValue(s.previous, 'int')}`}</td></tr>`).join('')}
      </table>` : '';

  const carts = report.carts.active;
  const adminUrl = `${(process.env.ADMIN_PUBLIC_URL || 'https://admin.escapesymas.com').replace(/\/$/, '')}/?tab=stats`;
  const warnings = report.warnings.map((w) => `<p style="margin:0 0 8px;font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 10px">${escapeHtml(w)}</p>`).join('');

  const body = `
    ${test ? `<p style="margin:0 0 16px;font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 10px"><strong>Esto es una prueba</strong> enviada a mano desde Ajustes › Informes. Los informes de verdad llegan solos a la hora programada.</p>` : ''}
    <div style="font-family:${MONO};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${C.accentText}">Informe ${KIND_NAMES[kind]}</div>
    <h1 style="margin:4px 0 4px;font-family:${MONO};font-size:22px;line-height:1.25;text-transform:uppercase;color:${C.text}">${escapeHtml(p.label)}</h1>
    <div style="font-size:12px;color:${C.muted};margin-bottom:16px">${escapeHtml(rangeText(p.from, p.to))} · comparado con ${escapeHtml(p.prevLabel.toLowerCase())} (${escapeHtml(rangeText(p.prevFrom, p.prevTo))})</div>
    ${warnings}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 -4px">${rows.join('')}</table>
    ${funnel ? `<h3 style="margin:22px 0 4px;font-family:${MONO};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.accentText}">Del visitante al pedido</h3>${funnel}` : ''}
    <p style="margin:14px 0 0;font-size:13px;color:${C.body}">Carritos activos ahora: <strong style="color:${C.text}">${carts.count}</strong> por <strong style="color:${C.text}">${escapeHtml(fmtValue(carts.value, 'eur'))}</strong>${carts.stale ? ` (${carts.stale} sin tocar desde hace más de 24 h)` : ''}.</p>
    ${aiText ? `<div style="margin-top:24px;border-top:1px solid ${C.border};padding-top:6px"><div style="font-family:${MONO};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${C.muted};margin-top:14px">Análisis con IA</div>${markdownToHtml(aiText)}<p style="margin:8px 0 0;font-size:11px;color:${C.muted}">Texto generado por inteligencia artificial a partir de los datos del informe: revisa las cifras importantes antes de decidir.</p></div>` : ''}
    ${aiError ? `<p style="margin:18px 0 0;font-size:12px;color:#92400e">No se pudo redactar el análisis con IA esta vez (${escapeHtml(aiError)}). El resto del informe va completo.</p>` : ''}
    <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:26px auto 6px"><tr><td align="center" bgcolor="${C.accent}" style="background:${C.accent};border-radius:8px">
      <a href="${escapeHtml(adminUrl)}" style="display:inline-block;padding:12px 24px;color:${C.text};font-family:${MONO};font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;text-decoration:none">Abrir la Vista general</a>
    </td></tr></table>
    <p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:${C.muted}">Va adjunto el informe completo en PDF, con todos los indicadores (${Object.values(GROUP_TITLES).join(', ').toLowerCase()}). Cuándo llega este correo, a quién y con qué se compara se cambia en el panel: Ajustes › Informes.</p>`;

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};color:${C.text};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(subject)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="${C.page}"><tr><td align="center" style="padding:24px 10px">
  <table role="presentation" cellpadding="0" cellspacing="0" width="680" style="width:100%;max-width:680px;background:${C.card};border:1px solid ${C.border};border-radius:12px;overflow:hidden">
    <tr><td height="4" bgcolor="${C.accent}" style="height:4px;line-height:4px;font-size:0;background:${C.accent}">&nbsp;</td></tr>
    <tr><td style="padding:26px 28px 24px;font-size:14px;line-height:1.6;color:${C.body}">${body}</td></tr>
    <tr><td align="center" bgcolor="${C.page}" style="padding:16px 24px;background:${C.page};border-top:1px solid ${C.border};font-family:${MONO};font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:${C.muted}">
      <a href="${BRAND_URL}" style="color:${C.text};text-decoration:none;font-weight:700">escapesymas.com</a> &nbsp;·&nbsp; informe automático &nbsp;·&nbsp; ${escapeHtml(fmtDateTime(report.generatedAt))}
    </td></tr>
  </table></td></tr></table></body></html>`;

  const lines = [
    `${test ? '[PRUEBA] ' : ''}INFORME ${KIND_NAMES[kind].toUpperCase()} · ${p.label}`,
    `${rangeText(p.from, p.to)} · comparado con ${p.prevLabel.toLowerCase()} (${rangeText(p.prevFrom, p.prevTo)})`,
    '',
    ...headline.map((k) => {
      const d = deltaOf(k);
      return `- ${k.label}: ${fmtValue(k.value, k.unit)}${k.noPrev ? ' (sin datos de comparación)' : d.text ? ` (${d.text})` : ''}`;
    }),
    '',
    `Carritos activos ahora: ${carts.count} por ${fmtValue(carts.value, 'eur')}.`,
    ...(aiText ? ['', 'ANÁLISIS CON IA', aiText.replace(/^#+\s*/gm, '').replace(/\*\*/g, '')] : []),
    '',
    `Informe completo en el PDF adjunto. Vista general: ${adminUrl}`,
  ];
  return { subject, html, text: lines.join('\n') };
}

/* ───────────────────────── Envío ───────────────────────── */

export interface SendOptions { to: string[]; includeAi: boolean; test?: boolean }

/** Calcula el informe, redacta el análisis (si toca), genera el PDF y lo envía. Lanza error si el correo no sale. */
export async function sendOverviewReport(due: Due, opts: SendOptions): Promise<LogEntry> {
  const report = await getOverviewReport(due.period, true);
  let aiText: string | null = null;
  let aiError: string | null = null;
  if (opts.includeAi) {
    try { aiText = (await generateOverviewAiReport(report)).text; } catch (e: any) { aiError = String(e?.message || e).slice(0, 80); console.warn('[overview-email] IA no disponible:', aiError); }
  }
  const pdf = await buildOverviewPdf(report, aiText || undefined);
  const mail = renderReportEmail({ report, kind: due.kind, aiText, aiError, test: opts.test });
  const entry: LogEntry = { kind: due.kind, at: new Date().toISOString(), ok: true, test: !!opts.test, subject: mail.subject, to: opts.to.join(', '), ai: !!aiText };
  const result = await sendEmail({
    to: opts.to.join(', '),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: [{ filename: `informe-escapesymas-${report.period.from}_${report.period.to}.pdf`, content: pdf, contentType: 'application/pdf' }],
    fromName: 'Informes · Escapes y Más',
    template: 'overview-report',
  });
  if (result.status !== 'sent') {
    entry.ok = false;
    entry.error = result.lastError || result.status;
    await appendLog(entry).catch(() => {});
    throw new Error(entry.error);
  }
  await appendLog(entry).catch(() => {});
  return entry;
}

const failures = new Map<string, number>();
const MAX_FAILURES = 3;

/** Una pasada del trabajo: envía lo que toque y todavía no se haya enviado. */
export async function overviewEmailTick(now: Date = new Date()): Promise<void> {
  if (process.env.OVERVIEW_EMAIL_DISABLED === 'true') return;
  const cfg = await loadConfig();
  if (!cfg.recipients.length) return;
  const last = await loadLastSent();
  for (const due of dueReports(now, cfg, last)) {
    const id = `${due.kind}:${due.key}`;
    if ((failures.get(id) || 0) >= MAX_FAILURES) continue;
    if (!(await claim(due.kind, due.key))) continue;
    try {
      const entry = await sendOverviewReport(due, { to: cfg.recipients, includeAi: cfg.includeAi });
      console.log(`[overview-email] enviado ${due.kind} ${due.key} a ${entry.to} (IA: ${entry.ai ? 'sí' : 'no'})`);
    } catch (e: any) {
      const n = (failures.get(id) || 0) + 1;
      failures.set(id, n);
      console.error(`[overview-email] falló ${id} (intento ${n}/${MAX_FAILURES}):`, e?.message || e);
      if (n < MAX_FAILURES) await release(due.kind, last[due.kind]).catch(() => {});
      else {
        import('../pushService.js').then(({ notifySystem }) => notifySystem(
          '📭 Informe programado no enviado',
          `El informe ${KIND_NAMES[due.kind]} no ha podido salir tras ${MAX_FAILURES} intentos: ${String(e?.message || e).slice(0, 100)}`,
          {}, 'notifications',
        )).catch(() => {});
      }
    }
  }
}

let started = false;

/** Arranca el trabajo (una pasada a los 90 s del arranque y luego cada 5 minutos). */
export function startOverviewEmailJob(): void {
  if (started) return;
  started = true;
  const run = () => overviewEmailTick().catch((e) => console.error('[overview-email] error en la pasada:', e?.message || e));
  setTimeout(run, 90_000);
  setInterval(run, 5 * 60_000);
}
