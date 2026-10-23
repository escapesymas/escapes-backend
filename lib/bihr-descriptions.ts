/**
 * Descripciones de producto a partir del catálogo «Products» de la API v3 (HtmlDescription, en español).
 *
 * - Solo rellena productos sin descripción propia (menos de 30 letras) o que ya rellenó este proceso
 *   (description_source = 'bihr'), para recoger las mejoras del fabricante. Nunca pisa un texto escrito a mano.
 * - El HTML se limpia: solo etiquetas de texto sin atributos (fuera enlaces, imágenes y estilos), entidades
 *   pasadas a letras y sin frases que nombren al proveedor (regla de Adrián: no se da a conocer).
 * - Las que llegan en inglés se apuntan en description_translations; lib/description-translation.ts las traduce
 *   poco a poco y aquí se usa la traducción en cuanto existe.
 *
 * Va con la descarga diaria del catálogo de descatalogados (lib/bihr-discontinued.ts). Mientras catalog_meta
 * 'bihr_descriptions' no valga 'on' solo calcula qué haría y guarda ejemplos, sin tocar productos.
 */
import crypto from 'crypto';
import fs from 'fs';
import readline from 'readline';
import { pool } from '../db.js';
import { cacheBust } from './cache.js';

/** Letras mínimas para considerar que un producto ya tiene descripción. */
export const MIN_DESCRIPTION_TEXT = 30;
/** Si el catálogo trae menos descripciones que esto, el formato ha cambiado o la descarga está incompleta. */
const MIN_CATALOG_DESCRIPTIONS = 20_000;
const BATCH = 1000;

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù', acirc: 'â', ecirc: 'ê', ocirc: 'ô', ccedil: 'ç', Ccedil: 'Ç',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', ouml: 'ö', auml: 'ä', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª', deg: '°',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…', bull: '•',
  middot: '·', euro: '€', reg: '®', trade: '™', copy: '©', times: '×', plusmn: '±', micro: 'µ', sup2: '²', sup3: '³',
  frac12: '½', frac14: '¼', frac34: '¾', le: '≤', ge: '≥', asymp: '≈', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? m;
  });
}

/** Quita las frases que nombran al proveedor (como withoutSupplier de socialContentAI, sin cargar el chatbot). */
const withoutSupplier = (text: string) => text.split(/(?<=[.!?…:])\s+/).filter((s) => !/bihr/i.test(s)).join(' ');

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Etiqueta de origen → la que se guarda (null: se quita y se queda su texto). */
const KEEP: Record<string, string | null> = {
  p: 'p', div: 'p', br: 'br', ul: 'ul', ol: 'ol', li: 'li', strong: 'strong', b: 'strong', em: 'em', i: 'em',
  table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td',
};

/** HTML del proveedor → HTML sencillo y seguro para la ficha, sin el nombre del proveedor. */
export function cleanDescription(html: string | null | undefined): string {
  const src = String(html || '')
    .replace(/<(script|style|iframe|object|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  let out = '';
  const re = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi;
  let last = 0;
  const text = (t: string) => {
    const plain = decodeEntities(t).replace(/\s+/g, ' ');
    out += escapeText(/bihr/i.test(plain) ? ` ${withoutSupplier(plain)} ` : plain);
  };
  for (let m: RegExpExecArray | null; (m = re.exec(src));) {
    text(src.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (/^h[1-6]$/.test(name)) { out += m[1] ? '</strong></p>' : '<p><strong>'; continue; }
    const keep = KEEP[name];
    if (keep === 'br') out += '<br>';
    else if (keep) out += `<${m[1]}${keep}>`;
    else if (['p', 'li', 'tr', 'img', 'hr'].includes(name) || m[1]) out += ' ';
  }
  text(src.slice(last));
  let prev = '';
  while (prev !== out) {
    prev = out;
    out = out
      .replace(/<(p|li|strong|em|ul|ol)>\s*(<br>\s*)*<\/\1>/g, '')   // bloques vacíos (también tras quitar frases)
      .replace(/(<br>\s*){3,}/g, '<br><br>')
      .replace(/<p>\s*(<br>\s*)+/g, '<p>').replace(/(<br>\s*)+<\/p>/g, '</p>');
  }
  return out.replace(/\s+/g, ' ')
    .replace(/\s*(<\/?(?:p|ul|ol|li|table|thead|tbody|tr|th|td)>)\s*/g, '$1')   // espacios junto a bloques
    .replace(/^(\s*<br>)+|(<br>\s*)+$/g, '').trim();
}

/** Texto sin etiquetas, para medir y decidir el idioma. */
export const textOf = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** ¿Está en inglés? Cuenta palabras vacías (y algunas de recambios que no se usan en español) de cada idioma. */
export function looksEnglish(text: string): boolean {
  const en = (text.match(/\b(the|and|with|without|for|your|of|to|is|this|from|which|are|it|high|front|rear|black|white|includes|made|quality|performance|steel|pads|pair|fits|new)\b/gi) || []).length;
  const es = (text.match(/\b(el|la|los|las|de|del|y|con|para|que|en|por|una|un|es|se|su|al)\b/gi) || []).length;
  return en > es && (en >= 2 || es === 0);
}

/**
 * Lee el catálogo línea a línea (viene con una clave por línea): referencia principal → HtmlDescription.
 * La descripción va antes que las variantes de un genérico, así que la última referencia leída es la suya.
 */
export async function readDescriptions(file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let code = '';
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const m = line.match(/^\s*"(PartNumber|HtmlDescription)"\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/);
    if (!m) continue;
    let value = '';
    try { value = JSON.parse(m[2]); } catch { continue; }
    if (m[1] === 'PartNumber') code = value.trim().toLowerCase();
    else if (code && value.trim()) { if (!out.has(code)) out.set(code, value); code = ''; }
  }
  return out;
}

/** Huella de una descripción limpia: clave de su traducción. */
export const descriptionHash = (html: string) => crypto.createHash('sha1').update(html).digest('hex');

/**
 * Guarda descripciones del proveedor. Se vuelve a comprobar en la propia consulta que no haya un texto escrito
 * a mano (por si alguien lo ha escrito mientras tanto).
 */
export async function writeDescriptions(updates: Array<{ id: number; html: string }>): Promise<void> {
  if (!updates.length) return;
  for (let i = 0; i < updates.length; i += BATCH) {
    const part = updates.slice(i, i + BATCH);
    await pool.query(
      `UPDATE products p SET description = u.html, description_source = 'bihr', updated_at = NOW()
         FROM unnest($1::int[], $2::text[]) AS u(id, html)
        WHERE p.id = u.id AND p.description IS DISTINCT FROM u.html AND (p.description_source = 'bihr'
           OR length(btrim(regexp_replace(coalesce(p.description, ''), '<[^>]*>', '', 'g'))) < $3)`,
      [part.map((u) => u.id), part.map((u) => u.html), MIN_DESCRIPTION_TEXT]);
  }
  await Promise.all([cacheBust('cache:products'), cacheBust('cache:suggest')]).catch(() => {});
}

export interface DescriptionsResult {
  startedAt: string; finishedAt?: string; status: 'running' | 'done' | 'error'; applied: boolean;
  catalogDescriptions?: number; candidates?: number; filled?: number; refreshed?: number;
  english?: number; translated?: number; tooShort?: number; samples?: Array<{ sku: string; text: string }>; error?: string;
}

/** Rellena las descripciones con el catálogo ya descargado (`file`). Sin 'on' en catalog_meta, solo simula. */
export async function fillDescriptions(file: string): Promise<DescriptionsResult> {
  const result: DescriptionsResult = { startedAt: new Date().toISOString(), status: 'running', applied: false };
  try {
    const flag = await pool.query(`SELECT value FROM catalog_meta WHERE key = 'bihr_descriptions'`);
    result.applied = flag.rows[0]?.value === 'on';
    const catalog = await readDescriptions(file);
    result.catalogDescriptions = catalog.size;
    if (catalog.size < MIN_CATALOG_DESCRIPTIONS) throw new Error(`el catálogo trae solo ${catalog.size} descripciones; no se toca nada`);

    const { rows } = await pool.query<{ id: number; sku: string; part_number: string | null; description: string | null; description_source: string | null; stock: number }>(
      `SELECT id, sku, part_number, description, description_source, stock FROM products
        WHERE status IN ('published', 'descatalogado') AND duplicate_of IS NULL`);
    const { rows: tr } = await pool.query<{ hash: string; html_es: string }>(
      `SELECT hash, html_es FROM description_translations WHERE html_es IS NOT NULL`);
    const translations = new Map(tr.map((t) => [t.hash, t.html_es]));
    const pending = new Map<string, { html: string; ids: number[]; inStock: boolean }>();
    const updates: Array<{ id: number; html: string; refresh: boolean }> = [];
    let english = 0, translated = 0, tooShort = 0, candidates = 0;
    const samples: Array<{ sku: string; text: string }> = [];
    for (const r of rows) {
      const ours = r.description_source === 'bihr';
      if (!ours && textOf(r.description || '').length >= MIN_DESCRIPTION_TEXT) continue;
      const raw = [r.sku, r.part_number].map((c) => String(c || '').trim().toLowerCase()).map((c) => catalog.get(c)).find(Boolean);
      if (!raw) continue;
      candidates++;
      let html = cleanDescription(raw);
      const plain = textOf(html);
      if (plain.length < MIN_DESCRIPTION_TEXT) { tooShort++; continue; }
      if (looksEnglish(plain)) {
        const hash = descriptionHash(html);
        const es = translations.get(hash);
        if (!es) {
          english++;
          const p = pending.get(hash) || { html, ids: [], inStock: false };
          p.ids.push(r.id); p.inStock ||= r.stock > 0;
          pending.set(hash, p);
          continue;
        }
        html = es; translated++;
      }
      if (html === r.description) continue;
      updates.push({ id: r.id, html, refresh: ours });
      if (samples.length < 8 && r.stock > 0 && Math.random() < 0.01) samples.push({ sku: r.sku, text: plain.slice(0, 400) });
    }
    Object.assign(result, { candidates, english, translated, tooShort, samples, filled: updates.filter((u) => !u.refresh).length, refreshed: updates.filter((u) => u.refresh).length });

    if (result.applied) {
      await writeDescriptions(updates);
      // Las de inglés sin traducir quedan en cola con los productos que las usan (se actualiza la lista).
      const queue = [...pending.entries()];
      for (let i = 0; i < queue.length; i += BATCH) {
        const part = queue.slice(i, i + BATCH);
        await pool.query(
          `INSERT INTO description_translations (hash, source_html, product_ids, in_stock)
           SELECT h, src, string_to_array(ids, ',')::int[], st FROM unnest($1::text[], $2::text[], $3::text[], $4::bool[]) AS q(h, src, ids, st)
           ON CONFLICT (hash) DO UPDATE SET product_ids = EXCLUDED.product_ids, in_stock = EXCLUDED.in_stock`,
          [part.map(([h]) => h), part.map(([, v]) => v.html), part.map(([, v]) => v.ids.join(',')), part.map(([, v]) => v.inStock)]);
      }
    }
    result.status = 'done';
  } catch (err: any) {
    Object.assign(result, { status: 'error', error: err?.message || String(err) });
  } finally {
    result.finishedAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO catalog_meta (key, value) VALUES ('bihr_descriptions_last', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(result)]).catch(() => {});
    console.log('[BIHR DESCRIPCIONES]', JSON.stringify({ ...result, samples: result.samples?.length }));
  }
  return result;
}
