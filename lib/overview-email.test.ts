import { describe, it, expect, vi, beforeEach } from 'vitest';

// Base de datos en memoria: solo las consultas que hace el módulo sobre app_settings.
const store = new Map<string, any>();
const query = vi.fn(async (text: string, params: any[] = []) => {
  const t = text.replace(/\s+/g, ' ');
  if (/INSERT INTO app_settings .* to_jsonb\(\$2::text\)/.test(t)) {
    const [key, value] = params;
    if (store.get(key) === value) return { rowCount: 0, rows: [] };
    store.set(key, value);
    return { rowCount: 1, rows: [] };
  }
  if (/INSERT INTO app_settings .* \$2::jsonb/.test(t)) { store.set(params[0], JSON.parse(params[1])); return { rowCount: 1, rows: [] }; }
  if (/UPDATE app_settings SET value = to_jsonb/.test(t)) { store.set(params[0], params[1]); return { rowCount: 1, rows: [] }; }
  if (/DELETE FROM app_settings/.test(t)) { store.delete(params[0]); return { rowCount: 1, rows: [] }; }
  if (/key = ANY/.test(t)) return { rows: (params[0] as string[]).filter((k) => store.has(k)).map((k) => ({ key: k, value: store.get(k) })) };
  if (/WHERE key = \$1/.test(t)) return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
  throw new Error('consulta no esperada: ' + t);
});
vi.mock('../db.js', () => ({ pool: { query: (...a: any[]) => (query as any)(...a) } }));

const sendEmail = vi.fn();
vi.mock('./email.js', () => ({ sendEmail: (...a: any[]) => sendEmail(...a) }));

const generate = vi.fn();
vi.mock('./overview-ai.js', () => ({ generateOverviewAiReport: (...a: any[]) => generate(...a) }));

const { makeReport } = await import('./overview-fixture.js');
const getReport = vi.fn(async () => makeReport());
vi.mock('./overview-report.js', async (orig) => ({ ...(await orig<any>()), getOverviewReport: (...a: any[]) => (getReport as any)(...a) }));

const mod = await import('./overview-email.js');
const { DEFAULT_CONFIG, dueReports, loadConfig, markdownToHtml, nextSendDate, overviewEmailTick, renderReportEmail, sanitizeConfig, sendOverviewReport } = mod;

const NONE = { daily: null, weekly: null, monthly: null };
// Lunes 23/11/2026 a las 08:05 en Madrid (07:05 UTC) y a las 07:30 (06:30 UTC)
const MON_8 = new Date('2026-11-23T07:05:00Z');
const MON_7 = new Date('2026-11-23T06:30:00Z');

describe('configuración', () => {
  it('sin nada guardado: semanal y mensual a info@, diario apagado', () => {
    expect(DEFAULT_CONFIG.recipients).toEqual(['info@escapesymas.com']);
    expect([DEFAULT_CONFIG.daily.enabled, DEFAULT_CONFIG.weekly.enabled, DEFAULT_CONFIG.monthly.enabled]).toEqual([false, true, true]);
  });

  it('limpia destinatarios: minúsculas, sin repetir, solo correos válidos y como mucho 5', () => {
    const c = sanitizeConfig({ recipients: ['  A@B.com ', 'a@b.com', 'no-es-correo', 'x@y', 'c@d.es', 'e@f.es', 'g@h.es', 'i@j.es', 'k@l.es'] });
    expect(c.recipients).toEqual(['a@b.com', 'c@d.es', 'e@f.es', 'g@h.es', 'i@j.es']);
  });

  it('acepta los destinatarios como texto separado por comas, espacios o punto y coma', () => {
    expect(sanitizeConfig({ recipients: 'a@b.com, c@d.es;e@f.es g@h.es' }).recipients).toEqual(['a@b.com', 'c@d.es', 'e@f.es', 'g@h.es']);
  });

  it('un valor raro no rompe nada y cae en los de por defecto', () => {
    const c = sanitizeConfig({ weekly: { enabled: 'sí', compare: 'otra' }, includeAi: 'x', recipients: 5 });
    expect(c.weekly).toEqual({ enabled: true, compare: 'prev' });
    expect(c.includeAi).toBe(true);
    expect(sanitizeConfig(null)).toEqual(DEFAULT_CONFIG);
  });

  it('respeta la comparación con el año pasado', () => {
    expect(sanitizeConfig({ monthly: { enabled: true, compare: 'yoy' } }).monthly.compare).toBe('yoy');
  });
});

describe('cuándo toca enviar', () => {
  const on = sanitizeConfig({ daily: { enabled: true }, weekly: { enabled: true }, monthly: { enabled: true } });

  it('antes de las 8:00 de Madrid no se envía nada', () => {
    expect(dueReports(MON_7, on, NONE)).toEqual([]);
  });

  it('el lunes a las 8:00 sale el semanal de la semana anterior (lunes a domingo) y el diario de ayer', () => {
    const due = dueReports(MON_8, on, NONE);
    const weekly = due.find((d) => d.kind === 'weekly')!;
    expect([weekly.key, weekly.period.from, weekly.period.to, weekly.period.compare]).toEqual(['2026-11-23', '2026-11-16', '2026-11-22', 'prev']);
    const daily = due.find((d) => d.kind === 'daily')!;
    expect([daily.key, daily.period.from, daily.period.to]).toEqual(['2026-11-23', '2026-11-22', '2026-11-22']);
    expect(due.find((d) => d.kind === 'monthly')).toBeUndefined();
  });

  it('un informe ya enviado no se repite', () => {
    const due = dueReports(MON_8, on, { daily: '2026-11-23', weekly: '2026-11-23', monthly: null });
    expect(due).toEqual([]);
  });

  it('el martes aún sale el semanal que no salió el lunes (servidor parado), pero el miércoles ya no', () => {
    const tue = new Date('2026-11-24T10:00:00Z');
    expect(dueReports(tue, sanitizeConfig({ weekly: { enabled: true } }), NONE)[0]).toMatchObject({ kind: 'weekly', key: '2026-11-23' });
    const wed = new Date('2026-11-25T10:00:00Z');
    expect(dueReports(wed, sanitizeConfig({ weekly: { enabled: true } }), NONE)).toEqual([]);
  });

  it('el día 1 sale el mensual del mes anterior y el día 2 todavía por si no salió', () => {
    const d1 = dueReports(new Date('2026-12-01T09:00:00Z'), on, NONE).find((d) => d.kind === 'monthly')!;
    expect([d1.key, d1.period.from, d1.period.to]).toEqual(['2026-12-01', '2026-11-01', '2026-11-30']);
    const d2 = dueReports(new Date('2026-12-02T09:00:00Z'), on, NONE).find((d) => d.kind === 'monthly')!;
    expect(d2.key).toBe('2026-12-01');
    expect(dueReports(new Date('2026-12-03T09:00:00Z'), on, NONE).find((d) => d.kind === 'monthly')).toBeUndefined();
  });

  it('el mensual de enero es el de diciembre (cruza de año)', () => {
    const d = dueReports(new Date('2027-01-01T09:00:00Z'), on, NONE).find((x) => x.kind === 'monthly')!;
    expect([d.period.from, d.period.to]).toEqual(['2026-12-01', '2026-12-31']);
  });

  it('con el cambio de hora de octubre las 8:00 siguen siendo las 8:00 de Madrid', () => {
    // 26/10/2026 (lunes): ya en horario de invierno (UTC+1) → 07:05 Madrid = 06:05 UTC
    expect(dueReports(new Date('2026-10-26T06:05:00Z'), sanitizeConfig({ weekly: { enabled: true } }), NONE)).toHaveLength(0);
    expect(dueReports(new Date('2026-10-26T07:05:00Z'), sanitizeConfig({ weekly: { enabled: true } }), NONE)).toHaveLength(1);
  });

  it('un informe apagado no sale y se respeta la comparación elegida', () => {
    const only = sanitizeConfig({ daily: { enabled: false }, weekly: { enabled: true, compare: 'yoy' }, monthly: { enabled: false } });
    const due = dueReports(MON_8, only, NONE);
    expect(due).toHaveLength(1);
    expect(due[0].period.compare).toBe('yoy');
  });
});

describe('próximo envío', () => {
  it('semanal: el lunes siguiente; el propio lunes si aún no son las 8 y no se ha enviado', () => {
    expect(nextSendDate('weekly', MON_7, null)).toBe('2026-11-23');
    expect(nextSendDate('weekly', MON_8, '2026-11-23')).toBe('2026-11-30');
    expect(nextSendDate('weekly', new Date('2026-11-18T12:00:00Z'), null)).toBe('2026-11-23');
  });

  it('mensual: el día 1 del mes siguiente (también en diciembre)', () => {
    expect(nextSendDate('monthly', new Date('2026-11-18T12:00:00Z'), null)).toBe('2026-12-01');
    expect(nextSendDate('monthly', new Date('2026-12-10T12:00:00Z'), null)).toBe('2027-01-01');
  });

  it('diario: hoy si aún no son las 8, y si no mañana', () => {
    expect(nextSendDate('daily', MON_7, null)).toBe('2026-11-23');
    expect(nextSendDate('daily', MON_8, '2026-11-23')).toBe('2026-11-24');
  });
});

describe('texto de la IA en el correo', () => {
  it('escapa el HTML antes de dar formato', () => {
    const html = markdownToHtml('## Título\n\nUna **negrita** y <script>alert(1)</script> & más');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong');
  });

  it('listas con guiones y numeradas', () => {
    const html = markdownToHtml('- uno\n- dos\n\n1. primero\n2. segundo');
    expect(html.match(/<ul/g)).toHaveLength(1);
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/<li/g)).toHaveLength(4);
  });
});

describe('el correo', () => {
  it('lleva asunto con periodo y ventas, indicadores y el análisis', () => {
    const m = renderReportEmail({ report: makeReport(), kind: 'weekly', aiText: '## Resumen ejecutivo\n\nTodo bien.' });
    expect(m.subject).toMatch(/^Informe semanal · 12\/11\/2026 – 18\/11\/2026 · ventas 480,00 € \(\+140,0 %\)$/);
    expect(m.html).toContain('Ventas (IVA incluido)');
    expect(m.html).toContain('Análisis con IA');
    expect(m.text).toContain('Todo bien.');
    expect(m.html).not.toContain('undefined');
  });

  it('una prueba se marca [PRUEBA] en el asunto y en el cuerpo', () => {
    const m = renderReportEmail({ report: makeReport(), kind: 'monthly', test: true });
    expect(m.subject.startsWith('[PRUEBA] Informe mensual')).toBe(true);
    expect(m.html).toContain('Esto es una prueba');
  });

  it('sin datos del año pasado lo dice en lugar de enseñar variaciones', () => {
    const m = renderReportEmail({ report: makeReport({ yoyNoData: true }), kind: 'weekly' });
    expect(m.html).toContain('sin datos de comparación');
    expect(m.subject).not.toMatch(/\(\+/);
    expect(m.text).toContain('sin datos de comparación');
  });

  it('si la IA falla el correo sale igualmente y avisa', () => {
    const m = renderReportEmail({ report: makeReport(), kind: 'daily', aiError: 'timeout' });
    expect(m.html).toContain('No se pudo redactar el análisis con IA');
  });
});

describe('envío y trabajo programado', () => {
  beforeEach(() => {
    store.clear();
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ status: 'sent', attempts: 1 });
    generate.mockReset();
    generate.mockResolvedValue({ text: '## Resumen ejecutivo\n\nBien.', model: 'm', attempts: 7, notes: [], tokens: 1 });
    getReport.mockClear();
  });

  it('manda un correo con el PDF adjunto a los destinatarios', async () => {
    await sendOverviewReport({ kind: 'weekly', key: 'k', period: { preset: 'custom', from: '2026-11-09', to: '2026-11-15', compare: 'prev' } }, { to: ['a@b.com', 'c@d.es'], includeAi: true });
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('a@b.com, c@d.es');
    expect(mail.attachments[0].filename).toMatch(/^informe-escapesymas-.*\.pdf$/);
    expect(mail.attachments[0].content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(mail.html).toContain('Análisis con IA');
  });

  it('sin IA no la pide', async () => {
    await sendOverviewReport({ kind: 'daily', key: 'k', period: { preset: 'custom', from: '2026-11-17', to: '2026-11-17', compare: 'prev' } }, { to: ['a@b.com'], includeAi: false });
    expect(generate).not.toHaveBeenCalled();
  });

  it('si la IA falla, el correo sale sin análisis', async () => {
    generate.mockRejectedValue(new Error('boom'));
    await sendOverviewReport({ kind: 'daily', key: 'k', period: { preset: 'custom', from: '2026-11-17', to: '2026-11-17', compare: 'prev' } }, { to: ['a@b.com'], includeAi: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].html).toContain('No se pudo redactar');
  });

  it('un fallo del correo lanza error y queda en el registro', async () => {
    sendEmail.mockResolvedValue({ status: 'permanent_failure', attempts: 3, lastError: 'SMTP caído' });
    await expect(sendOverviewReport({ kind: 'daily', key: 'k', period: { preset: 'custom', from: '2026-11-17', to: '2026-11-17', compare: 'prev' } }, { to: ['a@b.com'], includeAi: false })).rejects.toThrow('SMTP caído');
    expect(store.get('overview_email_log')[0]).toMatchObject({ ok: false, error: 'SMTP caído' });
  });

  it('el trabajo envía el semanal una sola vez aunque se ejecute varias veces', async () => {
    await overviewEmailTick(MON_8);
    await overviewEmailTick(MON_8);
    await overviewEmailTick(new Date(MON_8.getTime() + 300_000));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].subject).toContain('Informe semanal');
    expect(store.get('overview_email_last_weekly')).toBe('2026-11-23');
  });

  it('si el envío falla se deshace la marca y se reintenta en la pasada siguiente', async () => {
    sendEmail.mockResolvedValueOnce({ status: 'permanent_failure', attempts: 3, lastError: 'SMTP caído' });
    await overviewEmailTick(new Date('2026-11-30T07:05:00Z'));
    expect(store.has('overview_email_last_weekly')).toBe(false);
    await overviewEmailTick(new Date('2026-11-30T07:10:00Z'));
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(store.get('overview_email_last_weekly')).toBe('2026-11-30');
  });

  it('sin destinatarios o apagado con OVERVIEW_EMAIL_DISABLED no envía', async () => {
    store.set('overview_email', { ...DEFAULT_CONFIG, recipients: [] });
    await overviewEmailTick(new Date('2026-12-07T07:05:00Z'));
    expect(sendEmail).not.toHaveBeenCalled();
    store.clear();
    process.env.OVERVIEW_EMAIL_DISABLED = 'true';
    try { await overviewEmailTick(new Date('2026-12-14T07:05:00Z')); } finally { delete process.env.OVERVIEW_EMAIL_DISABLED; }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('lee la configuración guardada', async () => {
    store.set('overview_email', { recipients: ['x@y.es'], includeAi: false, daily: { enabled: true, compare: 'yoy' } });
    const c = await loadConfig();
    expect(c.recipients).toEqual(['x@y.es']);
    expect(c.daily).toEqual({ enabled: true, compare: 'yoy' });
    expect(c.weekly.enabled).toBe(true);
  });
});
