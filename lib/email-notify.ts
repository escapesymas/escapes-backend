/**
 * Aviso «Correo enviado» para los administradores (categoría `email_sent`; se activa o se quita en Ajustes › Avisos › Qué avisos recibir).
 *
 * - Solo avisa de correos a personas de fuera: lo que va a nuestros propios buzones (avisos internos, informes) ya tiene su aviso.
 * - Un envío masivo (p. ej. «piezas nuevas para tu moto») no llena el móvil: tras 3 avisos seguidos de la misma plantilla en
 *   10 minutos, el resto se cuenta y sale un único resumen cuando se cierra esa ventana.
 * - El aviso nunca puede romper ni retrasar el envío del correo: quien lo llama no espera y los errores se ignoran.
 */

/** Dominios propios: un correo que va solo a ellos es interno y no genera aviso. */
export const INTERNAL_DOMAINS = ['escapesymas.com', 'backendescapes.com'];
/** Avisos individuales por plantilla antes de pasar al resumen. */
export const INDIVIDUAL_LIMIT = 3;
/** Ventana (ms) en la que se cuentan los avisos de una misma plantilla. */
export const WINDOW_MS = 10 * 60_000;

const ADDRESS = /[^\s<>,;"']+@([^\s<>,;"']+)/g;

/** ¿Todos los destinatarios son de nuestros dominios? Acepta «Nombre <a@b.com>» y listas separadas por comas. */
export function isInternalRecipient(to: string): boolean {
  const domains = [...String(to || '').matchAll(ADDRESS)].map((m) => m[1].toLowerCase());
  if (!domains.length) return true;
  return domains.every((d) => INTERNAL_DOMAINS.some((own) => d === own || d.endsWith(`.${own}`)));
}

export interface SentEmail { to: string; subject: string; template?: string }

export interface NotifierDeps {
  /** Envía el aviso al administrador. */
  notify: (title: string, body: string) => Promise<unknown> | unknown;
  now?: () => number;
  /** Programa el cierre de la ventana (se inyecta en las pruebas). */
  schedule?: (fn: () => void, ms: number) => unknown;
}

const TITLE = '✉️ Correo enviado';

export function createEmailSentNotifier(deps: NotifierDeps) {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => { const t: any = setTimeout(fn, ms); t?.unref?.(); return t; });
  const windows = new Map<string, { startedAt: number; shown: number; extra: number }>();
  const safeNotify = (title: string, body: string) => {
    try { Promise.resolve(deps.notify(title, body)).catch(() => {}); } catch { /* el aviso nunca rompe el envío */ }
  };

  return function onEmailSent(mail: SentEmail): void {
    if (isInternalRecipient(mail.to)) return;
    const key = mail.template || 'general';
    let w = windows.get(key);
    if (!w || now() - w.startedAt >= WINDOW_MS) {
      w = { startedAt: now(), shown: 0, extra: 0 };
      windows.set(key, w);
      const mine = w;
      schedule(() => {
        if (windows.get(key) === mine) windows.delete(key);
        if (mine.extra > 0) safeNotify(TITLE, `${mine.extra} correo${mine.extra === 1 ? '' : 's'} más de «${key}» en los últimos 10 minutos`);
      }, WINDOW_MS);
    }
    if (w.shown < INDIVIDUAL_LIMIT) {
      w.shown++;
      safeNotify(TITLE, `«${String(mail.subject || '').slice(0, 110)}» a ${String(mail.to).slice(0, 80)}`);
    } else {
      w.extra++;
    }
  };
}

/** El aviso real: va por pushService (importado al usarlo para no crear dependencias circulares con lib/email). */
export const emailSentNotifier = createEmailSentNotifier({
  notify: async (title, body) => {
    const { notifyEmailSent } = await import('../pushService.js');
    await notifyEmailSent(title, body);
  },
});
