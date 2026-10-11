/**
 * Registro de las conversaciones con el asistente IA (tabla ai_chat_sessions).
 *
 * El navegador manda un identificador de conversación (sessionId) con cada
 * mensaje; aquí solo se añade el turno nuevo (pregunta + respuesta, con los
 * productos que se enseñaron), sin fiarse del historial que manda el cliente.
 * Nunca lanza: si falla el registro, el chat sigue funcionando.
 */
import { pool } from '../db.js';

export interface AiTurn {
  question: string;
  answer: string;
  /** SKU de las tarjetas de producto que se mostraron con la respuesta. */
  products?: string[];
  /** ok · out_of_scope · guardrail · error */
  outcome?: string;
  offeredHuman?: boolean;
}

const KEY_RE = /^[A-Za-z0-9-]{8,64}$/;

export function validSessionKey(v: unknown): string | null {
  return typeof v === 'string' && KEY_RE.test(v) ? v : null;
}

export async function logAiTurn(sessionKey: string | null, userId: number, turn: AiTurn): Promise<void> {
  if (!sessionKey) return;
  const at = new Date().toISOString();
  const entries = [
    { role: 'user', content: turn.question.slice(0, 4000), at },
    {
      role: 'assistant', content: turn.answer.slice(0, 8000), at,
      ...(turn.products?.length ? { products: turn.products.slice(0, 8) } : {}),
      ...(turn.outcome && turn.outcome !== 'ok' ? { outcome: turn.outcome } : {}),
      ...(turn.offeredHuman ? { offeredHuman: true } : {}),
    },
  ];
  try {
    // La misma conversación solo la puede continuar su dueño.
    await pool.query(
      `INSERT INTO ai_chat_sessions (session_key, user_id, messages, turns) VALUES ($1, $2, $3::jsonb, 1)
       ON CONFLICT (session_key) DO UPDATE
         SET messages = ai_chat_sessions.messages || EXCLUDED.messages, turns = ai_chat_sessions.turns + 1, updated_at = NOW()
         WHERE ai_chat_sessions.user_id = EXCLUDED.user_id`,
      [sessionKey, userId, JSON.stringify(entries)]);
  } catch (err: any) {
    console.error('[AI CHAT LOG]:', err.message);
  }
}

/** Al pasar a un asesor, se anota en la conversación con la IA. */
export async function linkAiHandoff(sessionKey: string | null, userId: number, conversationId: number): Promise<void> {
  if (!sessionKey) return;
  await pool.query(
    `UPDATE ai_chat_sessions SET handoff_conversation_id = $3, updated_at = NOW() WHERE session_key = $1 AND user_id = $2`,
    [sessionKey, userId, conversationId]).catch(() => {});
}

/** Se borran pasados 12 meses (lo llama el resumen diario). */
export async function pruneAiChats(): Promise<void> {
  await pool.query(`DELETE FROM ai_chat_sessions WHERE updated_at < NOW() - INTERVAL '12 months'`).catch(() => {});
}
