/**
 * Traduce al español las descripciones del proveedor que llegan en inglés (cola description_translations, que
 * llena lib/bihr-descriptions.ts) y las guarda en los productos que las usan. Mismo modelo que el chatbot (MiniMax).
 *
 * - Solo se mandan los trozos de texto: las etiquetas se quedan donde estaban, así que el HTML no se puede romper.
 * - Traducción fiel: si cambian las cifras, falta un trozo o la longitud no cuadra, se descarta y se reintenta
 *   (como mucho MAX_ATTEMPTS veces).
 * - Primero las de productos con stock. Va por tandas cortas desde index.ts; varias instancias no se pisan
 *   (cada tanda se reserva con claimed_at).
 */
import { pool } from '../db.js';
import { minimaxClient, CHAT_MODEL } from '../chatbot/minimax.js';
import { decodeEntities, writeDescriptions } from './bihr-descriptions.js';

const PER_REQUEST_CHARS = 3500;
const PER_REQUEST_ITEMS = 6;
const MAX_ATTEMPTS = 3;
/** Peticiones a la vez (el chatbot usa el mismo modelo: no se acapara). */
const PARALLEL = 3;
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿＀-￯]/;

const SYSTEM = `Eres traductor de fichas de producto de recambios y equipamiento de moto para una tienda española.
Te paso un objeto JSON: cada clave es una ficha y su valor, la lista de fragmentos de texto de esa ficha.
Traduce cada fragmento al español de España con estas reglas:
- Traducción fiel: no añadas, quites ni inventes nada.
- Deja tal cual marcas, modelos, nombres de tecnologías (™, ®), referencias, códigos, medidas, cifras y unidades.
- Si un fragmento ya está en español o es solo una marca o referencia, devuélvelo igual.
- Mismo número de fragmentos y mismo orden en cada clave.
Responde SOLO con el objeto JSON, con las mismas claves.`;

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Parte el HTML limpio en etiquetas y textos; `texts` son los índices de los trozos con letras. */
export function splitHtml(html: string): { parts: string[]; texts: number[] } {
  const parts = html.split(/(<[^>]+>)/);
  const texts = parts.map((p, i) => (!p.startsWith('<') && /[a-z]/i.test(p) ? i : -1)).filter((i) => i >= 0);
  return { parts, texts };
}

/** Cifras de un texto, ordenadas: una traducción fiel tiene las mismas (cambie o no el separador decimal). */
const digitsOf = (s: string) => (s.match(/\d/g) || []).sort().join('');

/** Comprueba un fragmento traducido frente al original. */
export function faithful(src: string, out: unknown): out is string {
  if (typeof out !== 'string' || !out.trim()) return false;
  if (CJK_RE.test(out) || /bihr/i.test(out) || /<|>/.test(out)) return false;
  if (digitsOf(src) !== digitsOf(out)) return false;
  const a = src.trim().length, b = out.trim().length;
  return a < 25 || (b >= a * 0.5 && b <= a * 2.2);
}

/** Vuelve a montar el HTML con los fragmentos traducidos (o null si alguno no vale). */
export function rebuild(html: string, translated: unknown): string | null {
  const { parts, texts } = splitHtml(html);
  if (!Array.isArray(translated) || translated.length !== texts.length) return null;
  const out = [...parts];
  for (let k = 0; k < texts.length; k++) {
    const src = decodeEntities(parts[texts[k]]);
    if (!faithful(src, translated[k])) return null;
    const lead = /^\s/.test(src) ? ' ' : '', tail = /\s$/.test(src) ? ' ' : '';
    out[texts[k]] = lead + escapeText(String(translated[k]).trim()) + tail;
  }
  return out.join('');
}

async function ask(payload: Record<string, string[]>): Promise<Record<string, unknown> | null> {
  const r: any = await minimaxClient.chat.completions.create({
    model: CHAT_MODEL, temperature: 0.1, max_tokens: 12000,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }],
    reasoning_split: true,
  } as any);
  const text = String(r.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; }
}

interface Row { hash: string; source_html: string; product_ids: number[] }

/** Traduce una tanda ya reservada. Devuelve cuántas se tradujeron. */
async function translateRows(rows: Row[]): Promise<number> {
  const payload: Record<string, string[]> = {};
  rows.forEach((r, i) => {
    const { parts, texts } = splitHtml(r.source_html);
    payload[`f${i}`] = texts.map((t) => decodeEntities(parts[t]).trim());
  });
  let answer: Record<string, unknown> | null = null;
  let error = '';
  // Los fallos de la petición (límite de uso, corte) se reintentan aquí y no gastan los intentos de cada texto.
  for (let attempt = 0; attempt < 3 && !answer; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 5000));
    try { answer = await ask(payload); if (!answer) error = 'respuesta sin JSON'; } catch (e: any) { error = e?.message || String(e); }
  }
  if (!answer) {
    console.warn('[TRADUCCIÓN DESCRIPCIONES] petición fallida:', error);
    await pool.query(`UPDATE description_translations SET attempts = greatest(attempts - 1, 0), claimed_at = NULL, error = $2 WHERE hash = ANY($1)`,
      [rows.map((r) => r.hash), error]);
    return 0;
  }
  let done = 0;
  for (let i = 0; i < rows.length; i++) {
    const html = answer ? rebuild(rows[i].source_html, answer[`f${i}`]) : null;
    if (!html) {
      await pool.query(`UPDATE description_translations SET error = $2, claimed_at = NULL WHERE hash = $1`,
        [rows[i].hash, error || 'traducción descartada (no cuadra con el original)']);
      continue;
    }
    await pool.query(`UPDATE description_translations SET html_es = $2, error = NULL, translated_at = NOW() WHERE hash = $1`, [rows[i].hash, html]);
    await writeDescriptions(rows[i].product_ids.map((id) => ({ id, html })));
    done++;
  }
  return done;
}

export interface TranslationRun { translated: number; failed: number; pending: number }
let running: Promise<TranslationRun> | null = null;

/** Traduce como mucho `limit` descripciones de la cola (las de productos con stock primero). */
async function run(limit: number): Promise<TranslationRun> {
  const flag = await pool.query(`SELECT value FROM catalog_meta WHERE key = 'bihr_descriptions'`);
  if (flag.rows[0]?.value !== 'on') return { translated: 0, failed: 0, pending: 0 };
  let translated = 0, failed = 0;
  while (translated + failed < limit) {
    const { rows } = await pool.query<Row>(
      `UPDATE description_translations SET claimed_at = NOW(), attempts = attempts + 1
        WHERE hash IN (SELECT hash FROM description_translations
                        WHERE html_es IS NULL AND attempts < $1 AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '15 minutes')
                        ORDER BY in_stock DESC, created_at, hash LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING hash, source_html, product_ids`, [MAX_ATTEMPTS, PER_REQUEST_ITEMS * PARALLEL]);
    if (!rows.length) break;
    // Tandas que no pasen de PER_REQUEST_CHARS (una descripción larga va sola).
    const groups: Row[][] = [];
    let cur: Row[] = [], size = 0;
    for (const r of rows) {
      if (cur.length && size + r.source_html.length > PER_REQUEST_CHARS) { groups.push(cur); cur = []; size = 0; }
      cur.push(r); size += r.source_html.length;
    }
    if (cur.length) groups.push(cur);
    for (let i = 0; i < groups.length; i += PARALLEL) {
      const batch = groups.slice(i, i + PARALLEL);
      const oks = await Promise.all(batch.map((g) => translateRows(g)));
      oks.forEach((ok, k) => { translated += ok; failed += batch[k].length - ok; });
    }
  }
  const { rows: [p] } = await pool.query(`SELECT count(*)::int AS n FROM description_translations WHERE html_es IS NULL AND attempts < $1`, [MAX_ATTEMPTS]);
  const result = { translated, failed, pending: p.n };
  if (translated || failed) console.log('[TRADUCCIÓN DESCRIPCIONES]', JSON.stringify(result));
  return result;
}

/** Una pasada de traducción; si ya hay una en marcha, espera a esa. */
export function translatePendingDescriptions(limit = 60): Promise<TranslationRun> {
  if (!running) running = run(limit).finally(() => { running = null; });
  return running;
}
