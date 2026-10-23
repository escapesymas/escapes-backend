/**
 * Descripciones a partir de los datos del producto, para los que el fabricante no da ninguna (decisión de Adrián,
 * 24/10/2026): unas 12.000 fichas con stock, casi todas recambio técnico (cables, coronas, chiclés…).
 *
 * - Los datos salen del catálogo «Products» de la API v3 (categoría, uso, atributos, piezas del kit, nota corta del
 *   fabricante, origen) y de la ficha (nombre, marca, atributos). Nada más.
 * - La IA (MiniMax, como el chatbot) solo escribe un párrafo que destaca lo que decide la compra. La lista de datos
 *   técnicos y la de piezas del kit se montan aquí, tal cual vienen.
 * - Se descarta el párrafo si trae una cifra que no está en los datos, alguna afirmación que no se apoye en ellos
 *   (homologación, garantía, materiales…), superlativos o el nombre del proveedor.
 * - Se guardan con description_source = 'atributos'. Si más adelante llega la descripción del fabricante, la
 *   sustituye (lib/bihr-descriptions.ts); un texto escrito a mano no se toca nunca.
 *
 * La cola (attribute_descriptions) se llena con la descarga diaria del catálogo y se procesa por tandas desde
 * index.ts mientras catalog_meta 'attr_descriptions' valga 'on'.
 */
import crypto from 'crypto';
import fs from 'fs';
import readline from 'readline';
import { pool } from '../db.js';
import { minimaxClient, CHAT_MODEL } from '../chatbot/minimax.js';
import { MIN_DESCRIPTION_TEXT, cleanDescription, textOf } from './bihr-descriptions.js';
import { cacheBust } from './cache.js';

const PER_REQUEST = 8;
const PARALLEL = 3;
const MAX_ATTEMPTS = 3;
const BATCH = 1000;
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿＀-￯]/;

/** Atributos que la ficha ya enseña en «Características» (PUBLIC_ATTRIBUTES de routes/catalog.ts). */
const SHOWN_ON_PAGE = new Set(['Talla', 'Color', 'Modelo de casco', 'Estilo de casco', 'Homologación', 'Composición', 'Material',
  'Tipo de cierre', 'Estilo de pintura', 'Acabado de la pintura', 'Acabado', 'Color de la lente', 'Interior desmontable',
  'Tipo de pieza de repuesto', 'Posición', 'Tipo de escape', 'Colección', 'Uso', 'Gama', 'Medida', 'Categoría de neumático',
  'Estructura de neumático', 'Índice de carga del neumático (IC)', 'Índice de velocidad (CV)', 'Sin cámara o tipo de cámara']);

const UNIVERSE: Record<string, string> = {
  STREET: 'carretera', OFFROAD: 'off-road', 'MAXI SCOOTER': 'maxiscooter', SCOOTER: 'scooter', QUAD: 'quad', ATV: 'quad',
  'SXS/UTV': 'SSV/UTV', MOPED: 'ciclomotor', CUSTOM: 'custom', TRIAL: 'trial', ENDURO: 'enduro', MX: 'motocross',
};
const countryName = (() => {
  let names: Intl.DisplayNames | null = null;
  try { names = new Intl.DisplayNames(['es'], { type: 'region' }); } catch { /* sin ICU */ }
  return (code: string) => { try { return (code && names?.of(code.toUpperCase())) || ''; } catch { return ''; } };
})();

/** Lo que se sabe de un producto: lo único que puede usar la descripción. */
export interface Facts {
  nombre: string;
  marca: string;
  categoria: string;
  uso?: string[];
  datos?: Array<[string, string]>;
  incluye?: Array<[number, string]>;
  nota_fabricante?: string;
  origen?: string;
}

interface CatalogRecord {
  PartNumber?: string; Title?: string; HtmlDescription?: string; CountryOfOrigin?: string;
  SalesCategories?: Array<{ Name?: string }>; VehicleUniverses?: Array<{ Name?: string }>;
  Attributes?: Array<{ Name?: string; Value?: string }>; BillOfMaterials?: Array<{ Amount?: number; PartNumber?: string }>;
}

/**
 * Lee las fichas del catálogo «Products» (una clave por línea; cada producto es un objeto cuyas claves van a la
 * sangría de la primera «PartNumber»). Devuelve las de `wanted` y el título de todas (para las piezas de los kits).
 */
export async function readCatalogRecords(file: string, wanted: Set<string>): Promise<{ records: Map<string, CatalogRecord>; titles: Map<string, string> }> {
  const records = new Map<string, CatalogRecord>();
  const titles = new Map<string, string>();
  let keyIndent = -1;
  let cur: string[] | null = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const indent = line.length - line.trimStart().length;
    if (cur === null) {
      if (/^\s*"PartNumber"\s*:/.test(line) && (keyIndent < 0 || indent === keyIndent)) { keyIndent = indent; cur = ['{', line]; }
      continue;
    }
    if (indent === keyIndent - 2 && /^\s*\},?\s*$/.test(line)) {
      cur.push('}');
      try {
        const rec: CatalogRecord = JSON.parse(cur.join('\n'));
        const code = String(rec.PartNumber || '').trim().toLowerCase();
        if (code) {
          if (rec.Title) titles.set(code, rec.Title);
          if (wanted.has(code)) records.set(code, rec);
        }
      } catch { /* objeto que no se pudo leer: se salta */ }
      cur = null;
      continue;
    }
    cur.push(line);
  }
  return { records, titles };
}

const plainAttrs = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const text = Array.isArray(v) ? v.join(', ') : v;
      if (typeof text === 'string' || typeof text === 'number') { const t = String(text).trim(); if (t && t.length < 120) out[k] = t; }
    }
  }
  return out;
};

/** Junta los datos de la ficha y del catálogo. */
export function buildFacts(p: { name: string; brand: string | null; category: string; attributes: unknown }, rec: CatalogRecord | undefined, titles: Map<string, string>): Facts {
  const own = plainAttrs(p.attributes);
  const datos = new Map<string, string>();
  for (const a of rec?.Attributes || []) {
    const k = String(a.Name || '').trim(), v = String(a.Value ?? '').trim();
    if (k && v && v.length < 120 && !datos.has(k)) datos.set(k, v);
  }
  for (const [k, v] of Object.entries(own)) if (!datos.has(k)) datos.set(k, v);
  const nota = rec?.HtmlDescription ? textOf(cleanDescription(rec.HtmlDescription)) : '';
  const incluye = (rec?.BillOfMaterials || [])
    .map((b) => [Number(b.Amount) || 1, titles.get(String(b.PartNumber || '').trim().toLowerCase()) || ''] as [number, string])
    .filter(([, t]) => t && !/bihr/i.test(t));
  const facts: Facts = {
    nombre: p.name,
    marca: String(p.brand || '').trim(),
    categoria: [...new Set((rec?.SalesCategories || []).map((c) => String(c.Name || '').trim()).filter(Boolean))].join(', ') || p.category,
  };
  const uso = [...new Set((rec?.VehicleUniverses || []).map((u) => UNIVERSE[String(u.Name || '').toUpperCase()] || '').filter(Boolean))];
  if (uso.length) facts.uso = uso;
  const d = [...datos.entries()].filter(([k, v]) => !/bihr/i.test(`${k} ${v}`));
  if (d.length) facts.datos = d;
  if (incluye.length) facts.incluye = incluye;
  if (nota && nota.length < MIN_DESCRIPTION_TEXT * 4 && !/bihr/i.test(nota)) facts.nota_fabricante = nota;
  const origen = countryName(String(rec?.CountryOfOrigin || ''));
  if (origen) facts.origen = `Fabricado en ${origen}`;
  return facts;
}

/** ¿Hay algo que contar además del nombre? Si no, no se genera nada (sería repetir el título). */
export const worthDescribing = (f: Facts) => !!(f.datos?.length || f.incluye?.length || f.nota_fabricante || f.uso?.length);

export const factsHash = (f: Facts) => crypto.createHash('sha1').update(JSON.stringify(f)).digest('hex');

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Palabras que solo se pueden decir si aparecen en los datos (afirmaciones que habría que poder demostrar). */
const CLAIMS = ['homolog', 'garant', 'certific', 'impermeab', 'original', 'oem\\b', 'titanio', 'carbono', 'acero', 'aluminio',
  'inoxidable', 'reforzad', 'ligero', 'racing', 'competici', 'itv\\b', 'ece\\b', 'cnc\\b', 'forjad', 'sinteriz', 'orgánic', 'cerámic',
  'japón', 'italia', 'alemania', 'europa', 'fabricad', 'resistente', 'duradero', 'durabilidad'].map((c) => new RegExp(`(?<![\\p{L}])${c}`, 'iu'));
/** Nunca: publicidad que no se puede comprobar. */
const BANNED = /\b(mejor|mejores|excepcional|inigualable|perfect[oa]s?|líder|premium|número uno|máxima calidad|alta calidad|la más|el más|garantiza)\b/i;

/** Palabras inglesas que se cuelan al copiar valores del catálogo (solo valen si están en los datos, p. ej. en un modelo). */
const ENGLISH = /\b(the|and|with|for|from|of|supplied|spare|single|unit|frequented|black|white|front|rear|shocks?|endless)\b/gi;

const numbersOf = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.').replace(/\.0+$/, ''));

/** Comprueba que el párrafo solo diga lo que está en los datos. */
export function supported(text: unknown, f: Facts): text is string {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 60 || t.length > 700) return false;
  if (CJK_RE.test(t) || /bihr/i.test(t) || /[<>]/.test(t) || BANNED.test(t)) return false;
  const source = JSON.stringify(f).toLowerCase();
  if ((t.match(ENGLISH) || []).some((w) => !new RegExp(`\\b${w}\\b`, 'i').test(JSON.stringify([f.nombre, f.marca])))) return false;
  const allowed = new Set(numbersOf(source));
  if (numbersOf(t).some((n) => !allowed.has(n))) return false;
  return CLAIMS.every((c) => !c.test(t) || c.test(source));
}

/** HTML final: párrafo de la IA + datos técnicos y piezas del kit, tal cual vienen. */
export function renderDescription(paragraph: string, f: Facts): string {
  let html = `<p>${escapeText(paragraph.trim())}</p>`;
  const datos = (f.datos || []).filter(([k]) => !SHOWN_ON_PAGE.has(k));
  if (datos.length) html += `<p><strong>Datos técnicos</strong></p><ul>${datos.map(([k, v]) => `<li><strong>${escapeText(k)}:</strong> ${escapeText(v)}</li>`).join('')}</ul>`;
  if (f.incluye?.length) html += `<p><strong>Incluye</strong></p><ul>${f.incluye.map(([n, t]) => `<li>${n} × ${escapeText(t)}</li>`).join('')}</ul>`;
  return html;
}

const SYSTEM = `Eres redactor de fichas de producto de una tienda española de recambios y equipamiento de moto.
Te paso un objeto JSON: cada clave es una ficha con TODO lo que se sabe del producto.
Para cada ficha escribe UN párrafo de 1 a 4 frases (como mucho 450 caracteres) en español de España, tuteando, que:
- diga qué es y para qué sirve, a partir del nombre y la categoría;
- destaque los datos que deciden la compra de ese tipo de pieza (medida, paso, dientes, material, talla, posición, uso, piezas del kit…);
- explique lo que significa un dato si ayuda (p. ej. «14/50» en un kit de cadena = piñón de 14 dientes y corona de 50).
Reglas estrictas:
- Usa SOLO los datos que te paso. No inventes características, materiales, homologaciones, garantías, cifras ni compatibilidades.
- Nada de publicidad vacía («la mejor», «alta calidad», «excepcional», «premium»…).
- No menciones a ningún distribuidor ni proveedor; la tienda es Escapes y Más (no hace falta nombrarla).
- Si hay pocos datos, escribe menos: una o dos frases bastan. Nada de frases de relleno («identificado por su
  referencia», «ten en cuenta la referencia», «componente de reposición») ni de decir lo que NO incluye si no es un dato.
- Todo en español: traduce los valores que vengan en inglés («Twin Shocks» → doble amortiguador, «endless» → sin
  eslabón de cierre). Deja en su idioma marcas, modelos y referencias.
- Revisa la ortografía: palabras españolas correctas, sin erratas.
- Sin HTML ni listas: solo el párrafo.
Responde SOLO con un objeto JSON con las mismas claves y el párrafo como valor.`;

async function ask(payload: Record<string, Facts>): Promise<Record<string, unknown> | null> {
  const r: any = await minimaxClient.chat.completions.create({
    model: CHAT_MODEL, temperature: 0.2, max_tokens: 12000,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }],
    reasoning_split: true,
  } as any);
  const text = String(r.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return answerObject(text);
}

/**
 * El objeto de respuesta: a veces el modelo repite antes los datos que se le pasaron, así que se toma el último
 * objeto JSON de primer nivel cuyos valores son todos textos.
 */
export function answerObject(text: string): Record<string, unknown> | null {
  const found: Record<string, unknown>[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}' && depth > 0 && --depth === 0) {
      try { const o = JSON.parse(text.slice(start, i + 1)); if (o && typeof o === 'object' && !Array.isArray(o)) found.push(o); } catch { /* no es JSON */ }
    }
  }
  return found.reverse().find((o) => Object.values(o).every((v) => typeof v === 'string')) || null;
}

/** Escribe en las fichas sin texto propio (o con uno de este proceso). */
async function writeProducts(updates: Array<{ id: number; html: string }>): Promise<void> {
  for (let i = 0; i < updates.length; i += BATCH) {
    const part = updates.slice(i, i + BATCH);
    await pool.query(
      `UPDATE products p SET description = u.html, description_source = 'atributos', updated_at = NOW()
         FROM unnest($1::int[], $2::text[]) AS u(id, html)
        WHERE p.id = u.id AND p.description IS DISTINCT FROM u.html AND (p.description_source = 'atributos'
           OR (p.description_source IS NULL AND length(btrim(regexp_replace(coalesce(p.description, ''), '<[^>]*>', '', 'g'))) < $3))`,
      [part.map((u) => u.id), part.map((u) => u.html), MIN_DESCRIPTION_TEXT]);
  }
  if (updates.length) await Promise.all([cacheBust('cache:products'), cacheBust('cache:suggest')]).catch(() => {});
}

export interface QueueResult { candidates: number; queued: number; withoutData: number; inTranslation: number }

/**
 * Apunta en la cola las fichas sin descripción (con el catálogo ya descargado). Se llama después de rellenar las
 * del fabricante, así que lo que queda sin texto es lo que el fabricante no describe.
 */
export async function queueAttributeDescriptions(file: string): Promise<QueueResult> {
  const { rows } = await pool.query<{ id: number; sku: string; part_number: string | null; name: string; brand: string | null; attributes: unknown; stock: number; category: string | null }>(
    `SELECT p.id, p.sku, p.part_number, p.name, p.brand, p.attributes, p.stock, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.status IN ('published', 'descatalogado') AND p.duplicate_of IS NULL
        AND (p.description_source = 'atributos'
          OR (p.description_source IS NULL AND length(btrim(regexp_replace(coalesce(p.description, ''), '<[^>]*>', '', 'g'))) < $1))
        AND NOT EXISTS (SELECT 1 FROM description_translations t WHERE t.html_es IS NULL AND t.attempts < 3 AND p.id = ANY(t.product_ids))`,
    [MIN_DESCRIPTION_TEXT]);
  const { rows: [tr] } = await pool.query(`SELECT coalesce(sum(cardinality(product_ids)), 0)::int AS n FROM description_translations WHERE html_es IS NULL AND attempts < 3`);
  const codesOf = (r: { sku: string; part_number: string | null }) => [r.sku, r.part_number].map((c) => String(c || '').trim().toLowerCase()).filter(Boolean);
  const wanted = new Set(rows.flatMap(codesOf));
  const { records, titles } = await readCatalogRecords(file, wanted);
  const items: Array<{ id: number; facts: Facts; hash: string; inStock: boolean }> = [];
  let withoutData = 0;
  for (const r of rows) {
    if (/bihr/i.test(`${r.brand || ''} ${r.name || ''}`)) continue; // su propia marca: el nombre ya lo dice todo y no se anuncia
    const rec = codesOf(r).map((c) => records.get(c)).find(Boolean);
    const facts = buildFacts({ name: r.name, brand: r.brand, category: r.category || '', attributes: r.attributes }, rec, titles);
    if (!worthDescribing(facts)) { withoutData++; continue; }
    items.push({ id: r.id, facts, hash: factsHash(facts), inStock: r.stock > 0 });
  }
  for (let i = 0; i < items.length; i += BATCH) {
    const part = items.slice(i, i + BATCH);
    // Si los datos cambian, se vuelve a escribir (html a NULL); si no, se queda la que había.
    await pool.query(
      `INSERT INTO attribute_descriptions (product_id, facts, facts_hash, in_stock)
       SELECT * FROM unnest($1::int[], $2::jsonb[], $3::text[], $4::bool[])
       ON CONFLICT (product_id) DO UPDATE SET in_stock = EXCLUDED.in_stock,
         facts = EXCLUDED.facts, facts_hash = EXCLUDED.facts_hash,
         html = CASE WHEN attribute_descriptions.facts_hash = EXCLUDED.facts_hash THEN attribute_descriptions.html END,
         attempts = CASE WHEN attribute_descriptions.facts_hash = EXCLUDED.facts_hash THEN attribute_descriptions.attempts ELSE 0 END`,
      [part.map((x) => x.id), part.map((x) => JSON.stringify(x.facts)), part.map((x) => x.hash), part.map((x) => x.inStock)]);
  }
  const result = { candidates: rows.length, queued: items.length, withoutData, inTranslation: tr.n };
  console.log('[DESCRIPCIONES ATRIBUTOS] cola', JSON.stringify(result));
  return result;
}

interface Row { product_id: number; facts: Facts }

/** Genera una tanda ya reservada; con `write` false solo devuelve el HTML (para enseñar ejemplos). */
export async function generateRows(rows: Row[], write = true): Promise<Array<{ id: number; html: string | null }>> {
  const payload: Record<string, Facts> = {};
  rows.forEach((r, i) => { payload[`f${i}`] = r.facts; });
  let answer: Record<string, unknown> | null = null;
  let error = '';
  try { answer = await ask(payload); if (!answer) error = 'respuesta sin JSON'; } catch (e: any) { error = e?.message || String(e); }
  const out: Array<{ id: number; html: string | null }> = [];
  for (let i = 0; i < rows.length; i++) {
    const text = answer?.[`f${i}`];
    const html = supported(text, rows[i].facts) ? renderDescription(text, rows[i].facts) : null;
    out.push({ id: rows[i].product_id, html });
    if (!write) continue;
    if (!html) {
      await pool.query(`UPDATE attribute_descriptions SET error = $2, claimed_at = NULL WHERE product_id = $1`,
        [rows[i].product_id, error || 'párrafo descartado (dice algo que no está en los datos)']);
      continue;
    }
    await pool.query(`UPDATE attribute_descriptions SET html = $2, error = NULL, generated_at = NOW() WHERE product_id = $1`, [rows[i].product_id, html]);
  }
  if (write) await writeProducts(out.filter((o) => o.html).map((o) => ({ id: o.id, html: o.html! })));
  return out;
}

export interface GenerationRun { generated: number; failed: number; pending: number }
let running: Promise<GenerationRun> | null = null;

async function run(limit: number): Promise<GenerationRun> {
  const flag = await pool.query(`SELECT value FROM catalog_meta WHERE key = 'attr_descriptions'`);
  if (flag.rows[0]?.value !== 'on') return { generated: 0, failed: 0, pending: 0 };
  let generated = 0, failed = 0;
  while (generated + failed < limit) {
    const { rows } = await pool.query<Row>(
      `UPDATE attribute_descriptions SET claimed_at = NOW(), attempts = attempts + 1
        WHERE product_id IN (SELECT product_id FROM attribute_descriptions
                              WHERE html IS NULL AND attempts < $1 AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '15 minutes')
                              ORDER BY in_stock DESC, product_id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING product_id, facts`, [MAX_ATTEMPTS, PER_REQUEST * PARALLEL]);
    if (!rows.length) break;
    const groups: Row[][] = [];
    for (let i = 0; i < rows.length; i += PER_REQUEST) groups.push(rows.slice(i, i + PER_REQUEST));
    const results = await Promise.all(groups.map((g) => generateRows(g)));
    for (const res of results) for (const r of res) { if (r.html) generated++; else failed++; }
  }
  const { rows: [p] } = await pool.query(`SELECT count(*)::int AS n FROM attribute_descriptions WHERE html IS NULL AND attempts < $1`, [MAX_ATTEMPTS]);
  const result = { generated, failed, pending: p.n };
  if (generated || failed) console.log('[DESCRIPCIONES ATRIBUTOS]', JSON.stringify(result));
  return result;
}

/** Una pasada de generación; si ya hay una en marcha, espera a esa. */
export function generatePendingDescriptions(limit = 96): Promise<GenerationRun> {
  if (!running) running = run(limit).finally(() => { running = null; });
  return running;
}
