/**
 * Freno para los avisos de visitantes (POST /api/push/visitor-event, público): cualquiera puede llamarlo, así que
 * limita cuántas sesiones nuevas y cuántos avisos al equipo puede provocar una misma IP, y limpia los textos
 * que llegan del navegador antes de ponerlos en una notificación.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Sesiones nuevas por IP y hora (una casa o una oficina con NAT pueden tener varias personas). */
export const MAX_NEW_SESSIONS_PER_IP = 8;
/** Avisos al equipo por IP y hora. */
export const MAX_NOTICES_PER_IP = 24;
/** Sesiones en memoria a la vez: más allá se ignoran las nuevas. */
export const MAX_TRACKED_SESSIONS = 5000;

export function createVisitorGuard() {
  const sessions = new Map<string, number[]>();
  const notices = new Map<string, number[]>();

  // Anota un intento y dice si cabe en el límite de la última hora.
  const hit = (map: Map<string, number[]>, ip: string, max: number, now: number) => {
    const key = ip || 'sin-ip';
    const recent = (map.get(key) || []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= max) { map.set(key, recent); return false; }
    recent.push(now);
    map.set(key, recent);
    return true;
  };

  return {
    allowNewSession: (ip: string, now = Date.now()) => hit(sessions, ip, MAX_NEW_SESSIONS_PER_IP, now),
    allowNotice: (ip: string, now = Date.now()) => hit(notices, ip, MAX_NOTICES_PER_IP, now),
    /** Olvida las IP sin actividad en la última hora. */
    sweep(now = Date.now()) {
      for (const map of [sessions, notices]) {
        for (const [ip, times] of map) if (!times.some((t) => now - t < HOUR_MS)) map.delete(ip);
      }
    },
  };
}

/** Texto del navegador → una línea sin caracteres de control y con límite de largo ('' si no es texto). */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Importe o cantidad del navegador → número razonable, o undefined. */
export function cleanNumber(value: unknown, max = 1_000_000): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : undefined;
}
