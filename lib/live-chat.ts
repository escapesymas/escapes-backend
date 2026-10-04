/**
 * Chat con un asesor humano (migración 023).
 *
 * El asistente IA atiende siempre; si no resuelve la consulta y hay alguien
 * atendiendo según el horario, el cliente pasa a una conversación que el
 * administrador responde desde el panel. Aquí viven el horario y el acceso a
 * las conversaciones; las rutas están en routes/liveChatRoutes.ts.
 */
import { pool } from '../db.js';

export type SupportMode = 'auto' | 'on' | 'off';

export interface SupportSettings {
  /** auto: según el horario · on: disponible ahora · off: no disponible. */
  mode: SupportMode;
  timezone: string;
  /** Nombre por defecto del asesor en el chat (si el asesor no ha puesto el suyo). */
  agentName: string;
  /** Nombre de cada asesor en el chat (id de usuario → nombre). */
  agents?: Record<string, string>;
  /** Bienvenida al atender: {cliente} y {asesor} se sustituyen. */
  welcomeTemplate?: string;
  /** Día de la semana (0 = domingo) → tramos ["HH:MM", "HH:MM"]. */
  days: Record<string, [string, string][]>;
}

export interface SupportStatus {
  available: boolean;
  /** Dentro del horario (o modo «disponible»), aunque no haya nadie conectado. */
  inHours: boolean;
  /** Asesores conectados ahora mismo. */
  onlineAgents: number;
  mode: SupportMode;
  hoursText: string;
  /** «hoy a las 16:00», «el lunes a las 10:00»… o null si no hay horario. */
  nextOpen: string | null;
  agentName: string;
}

const DEFAULT_SETTINGS: SupportSettings = {
  mode: 'auto',
  timezone: 'Europe/Madrid',
  agentName: 'Equipo de Escapes y Más',
  days: { 1: [['10:00', '14:00'], ['16:00', '20:00']], 2: [['10:00', '14:00'], ['16:00', '20:00']],
    3: [['10:00', '14:00'], ['16:00', '20:00']], 4: [['10:00', '14:00'], ['16:00', '20:00']],
    5: [['10:00', '14:00'], ['16:00', '20:00']], 6: [], 0: [] } as any,
};

export const DEFAULT_WELCOME = '¡Hola{cliente}! Soy {asesor}, del equipo de Escapes y Más, y voy a atenderte yo. Ya he leído tu consulta, dame un momento.';

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

let cache: { at: number; value: SupportSettings } | null = null;

export async function getSupportSettings(): Promise<SupportSettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  try {
    const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'support_hours'`);
    const value = { ...DEFAULT_SETTINGS, ...(rows[0]?.value || {}) } as SupportSettings;
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Valida y guarda el horario que llega del panel. */
export async function saveSupportSettings(input: any): Promise<SupportSettings> {
  const mode: SupportMode = ['auto', 'on', 'off'].includes(input?.mode) ? input.mode : 'auto';
  const days: Record<string, [string, string][]> = {};
  for (const d of WEEK_ORDER) {
    const ranges = Array.isArray(input?.days?.[d]) ? input.days[d] : [];
    days[d] = ranges
      .filter((r: any) => Array.isArray(r) && HHMM.test(r[0]) && HHMM.test(r[1]) && r[0] < r[1])
      .slice(0, 3)
      .map((r: any) => [r[0], r[1]] as [string, string])
      .sort((a: [string, string], b: [string, string]) => a[0].localeCompare(b[0]));
  }
  const current = await getSupportSettings();
  const agentName = String(input?.agentName ?? current.agentName ?? '').trim().slice(0, 60) || DEFAULT_SETTINGS.agentName;
  const welcomeTemplate = String(input?.welcomeTemplate ?? current.welcomeTemplate ?? '').trim().slice(0, 500) || DEFAULT_WELCOME;
  const value: SupportSettings = {
    mode, timezone: DEFAULT_SETTINGS.timezone, agentName, days, welcomeTemplate, agents: current.agents || {},
  };
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('support_hours', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(value)],
  );
  cache = { at: Date.now(), value };
  return value;
}

/** Día de la semana y minuto del día en la zona horaria de la tienda. */
function localNow(timezone: string, date = new Date()): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const minutes = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
  return { day, minutes };
}

const toMin = (hhmm: string) => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3), 10);

/** «lunes a viernes de 10:00 a 14:00 y de 16:00 a 20:00; sábado de 10:00 a 14:00». */
export function hoursText(s: SupportSettings): string {
  const rangesOf = (d: number) => (s.days[d] || []).map(([a, b]) => `de ${a} a ${b}`).join(' y ');
  const groups: { from: number; to: number; text: string }[] = [];
  for (const d of WEEK_ORDER) {
    const text = rangesOf(d);
    if (!text) continue;
    const last = groups[groups.length - 1];
    const prevDay = last ? WEEK_ORDER[WEEK_ORDER.indexOf(d) - 1] : null;
    if (last && last.text === text && last.to === prevDay) last.to = d;
    else groups.push({ from: d, to: d, text });
  }
  if (groups.length === 0) return 'sin horario de atención por chat';
  return groups.map((g) => {
    const span = g.from === g.to ? DAY_NAMES[g.from]
      : WEEK_ORDER.indexOf(g.to) - WEEK_ORDER.indexOf(g.from) === 1 ? `${DAY_NAMES[g.from]} y ${DAY_NAMES[g.to]}`
      : `${DAY_NAMES[g.from]} a ${DAY_NAMES[g.to]}`;
    return `${span} ${g.text}`;
  }).join('; ');
}

export async function supportStatus(date = new Date()): Promise<SupportStatus> {
  const s = await getSupportSettings();
  const { day, minutes } = localNow(s.timezone, date);
  const inSchedule = (s.days[day] || []).some(([a, b]) => minutes >= toMin(a) && minutes < toMin(b));
  const open = s.mode === 'on' || (s.mode === 'auto' && inSchedule);
  // Hace falta al menos un asesor conectado (botón «Conectado» de su panel).
  const onlineAgents = await onlineAgentIds().then((ids) => ids.length).catch(() => 0);
  const available = open && onlineAgents > 0;

  // Próxima apertura (para decírselo al cliente fuera de horario).
  let nextOpen: string | null = null;
  if (!open && s.mode !== 'off') {
    for (let offset = 0; offset < 8 && !nextOpen; offset++) {
      const d = (day + offset) % 7;
      const start = (s.days[d] || []).map(([a]) => a).find((a) => offset > 0 || toMin(a) > minutes);
      if (start) {
        nextOpen = offset === 0 ? `hoy a las ${start}` : offset === 1 ? `mañana a las ${start}` : `el ${DAY_NAMES[d]} a las ${start}`;
      }
    }
  }
  return { available, inHours: open, onlineAgents, mode: s.mode, hoursText: hoursText(s), nextOpen, agentName: s.agentName };
}

/** Asesores (y administradores) conectados para atender el chat. */
export async function onlineAgentIds(): Promise<number[]> {
  // En pausa no cuenta: sigue con su chat pero no recibe clientes nuevos.
  const { rows } = await pool.query(
    `SELECT a.user_id FROM chat_agents a JOIN users u ON u.id = a.user_id
     WHERE a.online AND NOT a.paused AND u.role IN ('admin', 'asesor')`);
  return rows.map((r: any) => Number(r.user_id));
}

export async function isAgentOnline(userId: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT online FROM chat_agents WHERE user_id = $1`, [userId]);
  return !!rows[0]?.online;
}

export async function setAgentOnline(userId: number, online: boolean): Promise<void> {
  // Conectarse o desconectarse quita la pausa.
  await pool.query(
    `INSERT INTO chat_agents (user_id, online, paused, updated_at) VALUES ($1, $2, FALSE, NOW())
     ON CONFLICT (user_id) DO UPDATE SET online = EXCLUDED.online, paused = FALSE, updated_at = NOW()`, [userId, online]);
}

export async function setAgentPaused(userId: number, paused: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO chat_agents (user_id, online, paused, updated_at) VALUES ($1, TRUE, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET online = TRUE, paused = EXCLUDED.paused, updated_at = NOW()`, [userId, paused]);
}

export async function isAgentPaused(userId: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT paused FROM chat_agents WHERE user_id = $1`, [userId]);
  return !!rows[0]?.paused;
}

/** Nombre de un asesor en el chat: el que haya puesto, su nombre de pila o el genérico. */
export async function agentNameFor(userId: number): Promise<string> {
  const s = await getSupportSettings();
  const own = s.agents?.[String(userId)];
  if (own) return own;
  try {
    const { rows } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId]);
    if (rows[0]?.first_name) return String(rows[0].first_name).trim();
  } catch { /* nada */ }
  return s.agentName;
}

export async function setAgentName(userId: number, name: string): Promise<void> {
  const s = await getSupportSettings();
  const agents = { ...(s.agents || {}) };
  const clean = name.trim().slice(0, 60);
  if (clean) agents[String(userId)] = clean; else delete agents[String(userId)];
  const value = { ...s, agents };
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('support_hours', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(value)],
  );
  cache = { at: Date.now(), value };
}

export function welcomeText(template: string, customerFirstName: string, agentName: string): string {
  return (template || DEFAULT_WELCOME)
    .replace(/\{cliente\}/g, customerFirstName ? ` ${customerFirstName}` : '')
    .replace(/\{asesor\}/g, agentName)
    .replace(/\s+([!,.?])/g, '$1');
}

// ── Conversaciones ───────────────────────────────────────────────────────

export type ChatMessageKind = 'text' | 'product' | 'image' | 'order';

export interface ChatMessageRow {
  id: number;
  sender: 'customer' | 'ai' | 'agent' | 'system';
  kind: ChatMessageKind;
  content: string;
  payload: any;
  created_at: string;
}

/** Conversación abierta del cliente (o la última cerrada hace menos de 2 h, para que vea el cierre). */
export async function currentConversation(userId: number) {
  const { rows } = await pool.query(
    `SELECT id, status, created_at, taken_at, closed_at, closed_by, agent_user_id, agent_name, offline, rating,
            agent_typing_at, agent_read_id FROM chat_conversations
     WHERE user_id = $1 AND (status <> 'closed' OR closed_at > NOW() - INTERVAL '2 hours')
     ORDER BY (status <> 'closed') DESC, id DESC LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

export async function messagesAfter(conversationId: number, afterId = 0): Promise<ChatMessageRow[]> {
  const { rows } = await pool.query(
    `SELECT id::int, sender, kind, content, payload, created_at FROM chat_messages
     WHERE conversation_id = $1 AND id > $2 ORDER BY id LIMIT 200`,
    [conversationId, afterId],
  );
  return rows;
}

export async function addMessage(
  conversationId: number, sender: ChatMessageRow['sender'], content: string,
  kind: ChatMessageKind = 'text', payload: any = null,
) {
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (conversation_id, sender, content, kind, payload) VALUES ($1, $2, $3, $4, $5)
     RETURNING id::int, sender, kind, content, payload, created_at`,
    [conversationId, sender, content.slice(0, 4000), kind, payload ? JSON.stringify(payload) : null],
  );
  await pool.query(`UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
  return rows[0] as ChatMessageRow;
}

/** Cierra conversaciones sin actividad en 24 h (se llama al listar en el panel). */
export async function closeStaleConversations() {
  const { rows } = await pool.query(
    `UPDATE chat_conversations SET status = 'closed', closed_at = NOW(), closed_by = 'auto'
     WHERE status <> 'closed' AND updated_at < NOW() - INTERVAL '24 hours'
       -- Los mensajes dejados fuera de horario esperan hasta 7 días (fines de semana, festivos).
       AND NOT (offline AND status = 'waiting' AND updated_at > NOW() - INTERVAL '7 days')
     RETURNING id`,
  );
  for (const r of rows) {
    await addMessage(r.id, 'system', 'Conversación cerrada por inactividad.').catch(() => {});
  }
}
