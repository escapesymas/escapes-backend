/**
 * Generación de contenido para TikTok: copy, guion y hashtags con Gemini (y
 * MiniMax si Gemini falla o está saturado), a partir de un producto REAL del
 * catálogo, con sus fotos reales. Si Gemini responde, se añade además una
 * imagen de ambiente hecha con la foto real del producto como referencia, para
 * no enseñar nunca un producto inventado. El vídeo final (Veo) se deja para
 * cuando haya presupuesto/cuota confirmados.
 */
import fs from 'fs';
import sharp from 'sharp';
import path from 'path';
import { pool } from '../db.js';
import { minimaxClient, CHAT_MODEL } from '../chatbot/minimax.js';
import { storePolicies } from '../chatbot/index.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TIMEOUT_MS = 45_000;

const uploadDir = path.join(process.cwd(), 'uploads', 'social-content');
fs.mkdirSync(uploadDir, { recursive: true });

/** Precio mínimo (céntimos) de un producto elegido automáticamente: nada de tornillería suelta. */
export const AUTO_MIN_PRICE = 3000;
/** Stock mínimo para sortear un producto: con 1-2 unidades el enlace de TikTok se queda sin producto enseguida. */
export const AUTO_MIN_STOCK = 5;

export const NICHE_CONTEXT = `Escapes y Más (escapesymas.com) vende recambios, accesorios y equipamiento de
moto de más de 200 marcas: escapes, cascos, ropa técnica, transmisión, frenos,
suspensión, protecciones y mantenimiento. Público: moteros en España,
tono cercano y experto, nada de humo de marketing. El contenido debe generar
deseo por el producto con argumentos reales (sonido y estética del escape,
protección y comodidad del equipamiento, precio).`;

export interface SlotProduct {
  id: number;
  sku: string;
  name: string;
  brand: string;
  price: number;           // céntimos, precio que paga el cliente hoy
  listPrice: number;       // céntimos, PVP sin oferta
  inStock: boolean;
  description: string;
  images: string[];
  /** Motos compatibles resumidas (marca modelo años), del catálogo de Bihr. */
  compatibility: string;
}

export interface GeneratedCopy {
  hook: string;
  copy: string;
  script: string;
  hashtags: string;
  imagePrompt: string;   // para la app de Gemini (Nano Banana Pro) con la foto real adjunta
  videoPrompt: string;   // para Flow/Veo: vídeo vertical de 8 s
  slides?: { title: string; text: string }[];  // carrusel de producto: gancho, producto, precio, llamada a la acción
}

const euros = (cents: number) => (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** «Yamaha MT-07 (2014-2024), Yamaha XSR700 (2016-2023) y 12 modelos más» a partir de la compatibilidad del catálogo. */
export function compatibilitySummary(raw: unknown, max = 6): string {
  let list: any[] = [];
  try { list = Array.isArray(raw) ? raw : JSON.parse(String(raw || '[]')); } catch { return ''; }
  if (!Array.isArray(list) || !list.length) return '';
  const byModel = new Map<string, { label: string; min: number; max: number; n: number }>();
  for (const c of list) {
    const brand = String(c?.brand || '').trim();
    const model = String(c?.model || '').trim();
    if (!brand || !model) continue;
    const label = `${brand.charAt(0)}${brand.slice(1).toLowerCase()} ${model}`;
    const year = Number(c?.year) || 0;
    const e = byModel.get(label) || { label, min: year || 9999, max: year, n: 0 };
    if (year) { e.min = Math.min(e.min, year); e.max = Math.max(e.max, year); }
    e.n++;
    byModel.set(label, e);
  }
  const models = [...byModel.values()].sort((a, b) => b.n - a.n);
  const shown = models.slice(0, max).map((m) => (m.max ? `${m.label} (${m.min === m.max ? m.max : `${m.min}-${m.max}`})` : m.label));
  const rest = models.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ` y ${rest} ${rest === 1 ? 'modelo' : 'modelos'} más` : '');
}

function rowToProduct(p: any): SlotProduct {
  const list = Number(p.price);
  const price = Number(p.promo_price) > 0 ? Number(p.promo_price)
    : Math.min(list, Number(p.sale_price) > 0 ? Number(p.sale_price) : list);
  const images = (Array.isArray(p.images) ? p.images : [])
    .map((i: any) => (typeof i === 'string' ? i : i?.src))
    .filter((s: any) => typeof s === 'string' && s)
    .slice(0, 6);
  const description = String(p.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
  return {
    id: p.id, sku: p.sku, name: p.name, brand: p.brand || '', price, listPrice: list,
    inStock: Number(p.stock) > 0, description, images,
    compatibility: compatibilitySummary(p.compatibility),
  };
}

/** Producto publicado por SKU (con sus fotos). */
export async function productBySku(sku: string): Promise<SlotProduct | null> {
  const { rows: [p] } = await pool.query(
    `SELECT id, sku, name, brand, price, sale_price, promo_price, stock, description, images, compatibility
     FROM products WHERE upper(sku) = upper($1) AND status = 'published' AND price > 0
     ORDER BY (duplicate_of IS NULL) DESC LIMIT 1`, [sku]);
  return p ? rowToProduct(p) : null;
}

/**
 * Elige un producto para un hueco sin producto, de cualquier marca, con stock,
 * fotos, precio de al menos 30 € y al menos AUTO_MIN_STOCK unidades. Para que no se repitan:
 * - primero se sortea la MARCA (todas con la misma probabilidad; si no, las
 *   marcas con miles de referencias salen siempre) y se evitan las marcas de
 *   las últimas 10 publicaciones;
 * - después un producto de esa marca cuya familia (mismo modelo en otras tallas
 *   o colores) no se haya publicado en los últimos 120 días.
 */
export async function pickProduct(): Promise<SlotProduct | null> {
  const query = (avoidRecentBrands: boolean) => pool.query(
    `WITH used AS (
       SELECT p.sku, p.family_code, upper(p.brand) AS brand, c.scheduled_at, c.created_at
       FROM social_content_calendar c
       JOIN products p ON upper(p.sku) = upper(c.product_sku)
       WHERE c.product_sku IS NOT NULL),
     recent_brands AS (
       SELECT brand FROM (SELECT brand FROM used ORDER BY scheduled_at DESC LIMIT 10) r),
     eligible AS (
       SELECT p.id, p.sku, p.name, p.brand, p.price, p.sale_price, p.promo_price, p.stock, p.description, p.images, p.compatibility
       FROM products p
       WHERE p.status = 'published' AND p.price >= $1 AND p.stock >= $3 AND p.duplicate_of IS NULL
         AND COALESCE(p.brand, '') <> '' AND jsonb_array_length(COALESCE(p.images, '[]'::jsonb)) > 0
         AND ($2 = false OR upper(p.brand) NOT IN (SELECT brand FROM recent_brands))
         AND NOT EXISTS (SELECT 1 FROM used u WHERE u.created_at > NOW() - INTERVAL '120 days'
                         AND (upper(u.sku) = upper(p.sku) OR (p.family_code IS NOT NULL AND u.family_code = p.family_code)))),
     brand AS (SELECT upper(brand) AS b FROM eligible GROUP BY 1 ORDER BY random() LIMIT 1)
     SELECT * FROM eligible WHERE upper(brand) = (SELECT b FROM brand) ORDER BY random() LIMIT 1`,
    [AUTO_MIN_PRICE, avoidRecentBrands, AUTO_MIN_STOCK]);
  let { rows: [p] } = await query(true);
  if (!p) ({ rows: [p] } = await query(false));
  return p ? rowToProduct(p) : null;
}

// ---------------------------------------------------------------- texto

export async function geminiGenerateText(prompt: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');
  const res = await fetch(`${GEMINI_BASE}/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gemini texto ${res.status}`);
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
  if (!text) throw new Error('Gemini no devolvió texto');
  return text;
}

export async function minimaxGenerateText(prompt: string): Promise<string> {
  // El razonamiento de MiniMax cuenta en max_tokens: con poco margen la respuesta llega vacía.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r: any = await minimaxClient.chat.completions.create({
      model: CHAT_MODEL, max_tokens: 10000, temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
      reasoning_split: true,
    } as any);
    const content = String(r.choices?.[0]?.message?.content || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]+/g, '')
      .trim();
    if (content) return content;
    console.warn('[SOCIAL CONTENT] MiniMax sin texto:', r.choices?.[0]?.finish_reason, JSON.stringify(r.usage || {}));
  }
  throw new Error('MiniMax no devolvió texto');
}

/** Escapa saltos de línea y tabuladores sueltos dentro de las cadenas (JSON "casi válido" de los modelos). */
export function repairJson(raw: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString && ch === '\\') { out += ch + (raw[i + 1] ?? ''); i++; continue; }
    if (ch === '"') inString = !inString;
    if (inString && ch === '\n') { out += '\\n'; continue; }
    if (inString && ch === '\r') continue;
    if (inString && ch === '\t') { out += ' '; continue; }
    out += ch;
  }
  return out;
}

/** «#neumaticos moto» → «#neumaticosmoto»: los hashtags no pueden llevar espacios. */
export function normalizeHashtags(text: string): string {
  const out: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (w.startsWith('#') || !out.length) out.push(w.startsWith('#') ? w : `#${w}`);
    else out[out.length - 1] += w.replace(/[^\p{L}\p{N}_]/gu, '');
  }
  return out.join(' ');
}

function parseCopy(text: string): GeneratedCopy {
  const jsonMatch = text.replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('[SOCIAL CONTENT] respuesta sin JSON:', text.slice(0, 200));
    throw new Error('La IA no devolvió el formato esperado');
  }
  let parsed: any;
  try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = JSON.parse(repairJson(jsonMatch[0])); }
  const str = (v: any) => (Array.isArray(v) ? v.join('\n') : String(v || '')).trim();
  const copy = {
    hook: str(parsed.hook), copy: str(parsed.copy), script: str(parsed.script), hashtags: normalizeHashtags(str(parsed.hashtags)),
    imagePrompt: str(parsed.image_prompt), videoPrompt: str(parsed.video_prompt),
    slides: Array.isArray(parsed.slides)
      ? parsed.slides.slice(0, 4).map((x: any) => ({ title: str(x?.title).slice(0, 70), text: str(x?.text).slice(0, 180) }))
      : undefined,
  };
  if (!copy.copy && !copy.hook) throw new Error('La IA devolvió el contenido vacío');
  return copy;
}

/** Copy, guion, hook y hashtags. Gemini primero; si falla o está saturado, MiniMax. */
export async function generateCopy(opts: { format: string; topic?: string | null; product: SlotProduct | null }): Promise<GeneratedCopy & { engine: string }> {
  const p = opts.product;
  const productBlock = p
    ? `PRODUCTO (datos reales; no inventes características, medidas, homologaciones ni compatibilidades que no estén aquí):
- Nombre: ${p.name}
- Marca: ${p.brand}
- Precio: ${euros(p.price)} €${p.price < p.listPrice ? ` (antes ${euros(p.listPrice)} €)` : ''}
- ${p.inStock ? 'Disponible' : 'Ahora mismo sin stock'}
- Enlace: escapesymas.com/producto/${encodeURIComponent(p.sku)}
- Descripción: ${p.description || '(sin descripción)'}
- Motos compatibles (según el catálogo): ${p.compatibility || '(sin datos: no menciones ninguna moto)'}`
    : 'Sin producto concreto: habla de la categoría sin nombrar modelos concretos ni inventar datos.';

  const prompt = `${NICHE_CONTEXT}

${await storePolicies()}

${productBlock}

Genera contenido para un TikTok de formato "${opts.format}"${opts.topic ? ` con este enfoque: ${opts.topic}` : ''}.

Reglas:
- Usa solo datos reales de arriba. No prometas plazos de entrega, stock limitado, "últimas unidades" ni descuentos que no aparezcan.
- Si mencionas el envío, usa exactamente los importes de los datos de la tienda.
- Formas de pago: tarjeta, Bizum y Klarna; solo Klarna es a plazos (nunca digas «Bizum a plazos»).
- La publicación lleva el enlace del producto de TikTok: la llamada a la acción es «toca el enlace del producto» o similar. Nunca «enlace en la bio».
- Si hay motos compatibles en los datos, menciona las principales. Si es una pieza para modelos concretos sin datos de compatibilidad, invita a comprobar en «Mi garaje» de escapesymas.com que le vale a su moto. No inventes compatibilidades.
- Si el producto es universal (aceite, cargadores, herramientas, fundas, compresores, equipación del motorista, baúles con su placa), no hables de compatibilidad ni de «Mi garaje».
- Hashtags: nada de ciudades ni regiones (la tienda envía a toda España).
- Español de España, tono motero cercano.

Responde EXCLUSIVAMENTE en JSON válido (sin markdown) con esta forma exacta:
{"hook": "primera frase para enganchar en los 2 primeros segundos",
 "copy": "texto para la descripción del TikTok, máx 2 líneas, con 1 emoji máximo",
 "script": "guion corto plano por escenas para grabar el vídeo o para el carrusel (3-5 pasos)",
 "hashtags": "6-8 hashtags separados por espacio, mezcla de nicho moto y genéricos de España",
 "image_prompt": "instrucciones en español para generar en la app de Gemini una foto vertical 9:16 de ambiente con la FOTO REAL DEL PRODUCTO ADJUNTA: escena, luz, encuadre; pide conservar exactamente forma, colores y logotipos del producto y no añadir texto",
 "video_prompt": "instrucciones en español para generar en Flow (Veo) un vídeo vertical 9:16 de 8 segundos a partir de la foto del producto: planos, movimiento de cámara, ambiente y sonido (p. ej. el escape al acelerar); sin texto en pantalla y sin cambiar el producto"${opts.format === 'carousel' && p ? `,
 "slides": [
   {"title": "gancho de 3 a 6 palabras (diapositiva 1, sobre la foto de ambiente)", "text": "una frase corta que conecte con el motero"},
   {"title": "nombre corto del producto (marca y modelo)", "text": "1 o 2 frases con datos reales del nombre o la descripción (medida, uso, material); nada inventado"},
   {"title": "etiqueta corta para el precio, p. ej. «Precio de oferta» (el precio lo pone el sistema)", "text": "una frase con ventajas reales de compra de los datos de la tienda (descuento por importe, envío gratis desde…)"},
   {"title": "llamada a la acción con «escapesymas.com», 3 a 6 palabras", "text": "una frase corta (pago seguro, garantía…)"}
 ]` : ''}}`;

  try {
    return { ...parseCopy(await geminiGenerateText(prompt)), engine: 'gemini' };
  } catch (err: any) {
    console.warn('[SOCIAL CONTENT] Gemini texto falló, uso MiniMax:', err.message);
    return { ...parseCopy(await minimaxGenerateText(prompt)), engine: 'minimax' };
  }
}

// ---------------------------------------------------------------- imágenes

async function saveBufferAsFile(buffer: Buffer, ext: string): Promise<string> {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), buffer);
  return `/uploads/social-content/${filename}`;
}

/** Lee una foto del catálogo (ruta /uploads local o URL) para usarla de referencia. */
async function loadImage(src: string): Promise<{ data: string; mime: string } | null> {
  try {
    if (src.startsWith('/uploads/')) {
      const file = path.join(process.cwd(), src.replace(/^\/+/, ''));
      if (!file.startsWith(path.join(process.cwd(), 'uploads'))) return null;
      const buf = fs.readFileSync(file);
      const ext = path.extname(file).slice(1).toLowerCase();
      return { data: buf.toString('base64'), mime: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
    }
    if (/^https?:\/\//.test(src)) {
      const r = await fetch(src, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      return { data: Buffer.from(await r.arrayBuffer()).toString('base64'), mime: r.headers.get('content-type') || 'image/jpeg' };
    }
  } catch { /* sin referencia */ }
  return null;
}

/**
 * Pone primero la mejor foto del catálogo: a veces la primera es un dibujo
 * técnico con medidas, la bolsa de transporte o un detalle de la tela, y la
 * escena de ambiente y la ficha salían con eso. Gemini (visión) elige la foto
 * real del producto completo; si falla, se deja el orden del catálogo.
 */
export async function withBestImageFirst(p: SlotProduct): Promise<SlotProduct> {
  if (!GEMINI_API_KEY || p.images.length < 2) return p;
  const candidates = p.images.slice(0, 4);
  try {
    const loaded = await Promise.all(candidates.map((src) => loadImage(src)));
    const parts: any[] = [{ text: `Estas imágenes son las fotos del catálogo del producto «${p.brand} ${p.name}». Elige la MEJOR para un anuncio y como referencia para generar una foto de ambiente:
- una FOTO REAL del producto completo y reconocible;
- descarta dibujos técnicos o esquemas con medidas, embalajes, bolsas o fundas de transporte, etiquetas, detalles parciales (tela, costuras, un trozo) y fotos de otro color o de un accesorio.
Responde SOLO con el número de la imagen.` }];
    const index: number[] = [];
    loaded.forEach((img, i) => {
      if (!img) return;
      index.push(i);
      parts.push({ text: `Imagen ${index.length}:` }, { inlineData: { mimeType: img.mime, data: img.data } });
    });
    if (index.length < 2) return p;
    const res = await fetch(`${GEMINI_BASE}/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0 } }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
    if (!res.ok) return p;
    const data: any = await res.json();
    const n = parseInt(String(data?.candidates?.[0]?.content?.parts?.map((x: any) => x.text).join('') || '').match(/\d+/)?.[0] || '', 10);
    const chosen = index[n - 1];
    if (chosen == null || chosen === 0) return p;
    const images = [p.images[chosen], ...p.images.filter((_, i) => i !== chosen)];
    return { ...p, images };
  } catch (err: any) {
    console.warn('[SOCIAL CONTENT] elegir foto:', err.message);
    return p;
  }
}

/** Imagen con Gemini, con la foto real del producto como referencia si la hay. */
/**
 * ¿La imagen vertical es en realidad una foto apaisada pegada entre franjas?
 * Gemini lo hace a veces aunque se le pida 9:16: deja una costura horizontal
 * recta de lado a lado en el tercio de arriba o de abajo.
 */
export async function hasLetterbox(input: Buffer): Promise<boolean> {
  const W = 64;
  const H = 200;
  const { data } = await sharp(input).flatten({ background: '#ffffff' }).greyscale()
    .resize({ width: W, height: H, fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const diffs: number[] = [0];
  const fullWidth: number[] = [0];
  for (let y = 1; y < H; y++) {
    let sum = 0;
    let strong = 0;
    for (let x = 0; x < W; x++) {
      const d = Math.abs(data[y * W + x] - data[(y - 1) * W + x]);
      sum += d;
      if (d > 15) strong++;
    }
    diffs.push(sum / W);
    fullWidth.push(strong / W);
  }
  const sorted = diffs.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  for (let y = 1; y < H; y++) {
    const inBand = (y >= 20 && y <= 90) || (y >= 110 && y <= 180);
    if (inBand && diffs[y] > Math.max(18, 5 * median) && fullWidth[y] >= 0.8) return true;
  }
  return false;
}

/** Imagen con Gemini, con la foto real del producto como referencia si la hay. Si sale con franjas, se repite una vez. */
export async function geminiGenerateImage(prompt: string, reference: { data: string; mime: string } | null): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');
  let buffer: Buffer | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = attempt === 0 ? prompt : `${prompt}
IMPORTANTE: una sola fotografía vertical continua de arriba abajo. Nada de una foto horizontal con franjas, bloques de color o relleno arriba y abajo.`;
    const parts: any[] = [{ text }];
    if (reference) parts.push({ inlineData: { mimeType: reference.mime, data: reference.data } });
    const res = await fetch(`${GEMINI_BASE}/models/gemini-3-pro-image:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      if (buffer) break; // la repetición falló: se queda la primera
      throw new Error(`Gemini imagen ${res.status}`);
    }
    const data: any = await res.json();
    const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
    if (!part) {
      if (buffer) break;
      throw new Error('Gemini no devolvió imagen');
    }
    buffer = Buffer.from(part.inlineData.data, 'base64');
    const banded = await hasLetterbox(buffer).catch(() => false);
    if (!banded) break;
    console.warn(`[SOCIAL CONTENT] imagen con franjas (intento ${attempt + 1}), se repite`);
  }
  return saveBufferAsFile(buffer!, 'png');
}

/** Imagen solo a partir de texto con MiniMax (sin producto: escena genérica sin marcas). */
export async function minimaxGenerateImage(prompt: string): Promise<string> {
  if (!process.env.MINIMAX_API_KEY) throw new Error('MINIMAX_API_KEY no configurada');
  const res = await fetch('https://api.minimax.io/v1/image_generation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'image-01', prompt, n: 1, aspect_ratio: '9:16' }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`MiniMax imagen ${res.status}`);
  const data: any = await res.json();
  const url = data?.data?.image_urls?.[0];
  if (!url) throw new Error('MiniMax no devolvió imagen');
  const imgRes = await fetch(url);
  return saveBufferAsFile(Buffer.from(await imgRes.arrayBuffer()), 'jpg');
}

/**
 * Imágenes del hueco. Con producto: sus fotos reales (1 para foto/vídeo, hasta
 * 4 para carrusel) y, si Gemini responde, una escena de ambiente al principio
 * hecha a partir de la foto real. Sin producto: escenas genéricas sin marcas.
 */
/** Escena de ambiente con el producto real como referencia (Gemini). null si Gemini no responde. */
export async function productScene(p: SlotProduct, focus: string): Promise<string | null> {
  if (!p.images.length) return null;
  const reference = await loadImage(p.images[0]);
  if (!reference) return null;
  try {
    return await geminiGenerateImage(
      `Fotografía publicitaria realista en vertical (9:16), buena luz, sin marcas de agua ni logotipos de redes sociales. ${focus}
Coloca EXACTAMENTE el producto de la foto adjunta (${p.brand} ${p.name}) en la escena, sin cambiar su forma, colores ni las letras impresas en él.
Sin ningún texto, cartel, letrero, valla ni logotipo en el escenario. La foto ocupa todo el encuadre de borde a borde;
arriba, fondo sencillo (cielo, pared o desenfoque) porque ahí irán los logotipos, y la mitad inferior tranquila para poner texto encima.`,
      reference);
  } catch (err: any) {
    console.warn('[SOCIAL CONTENT] escena de producto:', err.message);
    return null;
  }
}

export async function generateImages(opts: { format: string; topic?: string | null; script?: string; product: SlotProduct | null }): Promise<{ urls: string[]; notes: string[] }> {
  const notes: string[] = [];
  const p = opts.product;
  const scene = `Fotografía publicitaria realista en vertical (9:16), sin marcas de agua ni logotipos de redes sociales, fondo de garaje/taller o carretera de
montaña, buena luz. Sin ningún texto, cartel, letrero, valla ni logotipo en el escenario: las únicas letras
permitidas son las impresas en el propio producto. La foto ocupa todo el encuadre de borde a borde (sin franjas ni marcos);
en la parte superior, fondo sencillo (cielo, pared o desenfoque) porque ahí irán los logotipos. ${opts.topic ? `Enfoque: ${opts.topic}.` : ''}`;

  if (p && p.images.length) {
    const real = p.images.slice(0, opts.format === 'carousel' ? 4 : 1);
    let ambient: string | null = null;
    const reference = await loadImage(p.images[0]);
    if (reference) {
      try {
        ambient = await geminiGenerateImage(
          `${scene}\nColoca EXACTAMENTE el producto de la foto adjunta (${p.brand} ${p.name}) en la escena, sin cambiar su forma, colores ni logotipos.`,
          reference);
      } catch (err: any) {
        notes.push(/ 429$/.test(err.message)
          ? 'Sin imagen de ambiente: la cuenta de Gemini no tiene cuota para imágenes (plan gratuito). Activa la facturación en Google AI Studio. Se usan las fotos reales del producto.'
          : 'No se pudo crear la imagen de ambiente (Gemini no responde); se usan las fotos reales del producto.');
        console.warn('[SOCIAL CONTENT] imagen de ambiente:', err.message);
      }
    }
    return { urls: ambient ? [ambient, ...real].slice(0, Math.max(real.length, opts.format === 'carousel' ? 4 : 2)) : real, notes };
  }

  // Sin producto: escenas genéricas, nunca marcas ni modelos inventados.
  const count = opts.format === 'carousel' ? 3 : 1;
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const prompt = `${scene}\nMotos y equipamiento genéricos, sin logotipos ni marcas visibles.${count > 1 ? ` Escena ${i + 1} de ${count}, ángulo distinto.` : ''}`;
    try {
      urls.push(await geminiGenerateImage(prompt, null));
    } catch {
      try { urls.push(await minimaxGenerateImage(prompt)); } catch (err: any) {
        notes.push('No se pudo generar alguna imagen.');
        console.warn('[SOCIAL CONTENT] imagen genérica:', err.message);
      }
    }
  }
  return { urls, notes };
}
