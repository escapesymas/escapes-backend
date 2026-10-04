/**
 * Generación de contenido para TikTok: copy, guion y hashtags con Gemini (y
 * MiniMax si Gemini falla o está saturado), a partir de un producto REAL del
 * catálogo, con sus fotos reales. Si Gemini responde, se añade además una
 * imagen de ambiente hecha con la foto real del producto como referencia, para
 * no enseñar nunca un producto inventado. El vídeo final (Veo) se deja para
 * cuando haya presupuesto/cuota confirmados.
 */
import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';
import { minimaxClient, CHAT_MODEL } from '../chatbot/minimax.js';
import { storePolicies } from '../chatbot/index.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TIMEOUT_MS = 45_000;

const uploadDir = path.join(process.cwd(), 'uploads', 'social-content');
fs.mkdirSync(uploadDir, { recursive: true });

/** Marcas que se promocionan cuando el hueco no tiene producto elegido. */
export const FEATURED_BRANDS = ['IXIL', 'BELL', 'RST'];

export const NICHE_CONTEXT = `Escapes y Más (escapesymas.com) vende recambios y equipamiento de moto de
alto rendimiento: escapes/silenciadores IXIL, cascos BELL, ropa y equipamiento
técnico RST (cazadoras, pantalones, guantes). Público: moteros en España,
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
}

export interface GeneratedCopy {
  hook: string;
  copy: string;
  script: string;
  hashtags: string;
}

const euros = (cents: number) => (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  };
}

/** Producto publicado por SKU (con sus fotos). */
export async function productBySku(sku: string): Promise<SlotProduct | null> {
  const { rows: [p] } = await pool.query(
    `SELECT id, sku, name, brand, price, sale_price, promo_price, stock, description, images
     FROM products WHERE upper(sku) = upper($1) AND status = 'published' AND price > 0
     ORDER BY (duplicate_of IS NULL) DESC LIMIT 1`, [sku]);
  return p ? rowToProduct(p) : null;
}

/**
 * Elige un producto para un hueco sin producto: de las marcas destacadas, con
 * stock y fotos, y que no se haya usado en el calendario en los últimos 60 días.
 */
export async function pickProduct(): Promise<SlotProduct | null> {
  const { rows: [p] } = await pool.query(
    `SELECT id, sku, name, brand, price, sale_price, promo_price, stock, description, images
     FROM products p
     WHERE p.status = 'published' AND p.price > 0 AND p.stock > 0 AND p.duplicate_of IS NULL
       AND upper(p.brand) = ANY($1) AND jsonb_array_length(COALESCE(p.images, '[]'::jsonb)) > 0
       AND NOT EXISTS (SELECT 1 FROM social_content_calendar c
                       WHERE upper(c.product_sku) = upper(p.sku) AND c.created_at > NOW() - INTERVAL '60 days')
     ORDER BY random() LIMIT 1`, [FEATURED_BRANDS]);
  return p ? rowToProduct(p) : null;
}

// ---------------------------------------------------------------- texto

async function geminiGenerateText(prompt: string): Promise<string> {
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

async function minimaxGenerateText(prompt: string): Promise<string> {
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
function repairJson(raw: string): string {
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

function parseCopy(text: string): GeneratedCopy {
  const jsonMatch = text.replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('[SOCIAL CONTENT] respuesta sin JSON:', text.slice(0, 200));
    throw new Error('La IA no devolvió el formato esperado');
  }
  let parsed: any;
  try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = JSON.parse(repairJson(jsonMatch[0])); }
  const str = (v: any) => (Array.isArray(v) ? v.join('\n') : String(v || '')).trim();
  const copy = { hook: str(parsed.hook), copy: str(parsed.copy), script: str(parsed.script), hashtags: str(parsed.hashtags) };
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
- Descripción: ${p.description || '(sin descripción)'}`
    : 'Sin producto concreto: habla de la categoría sin nombrar modelos concretos ni inventar datos.';

  const prompt = `${NICHE_CONTEXT}

${await storePolicies()}

${productBlock}

Genera contenido para un TikTok de formato "${opts.format}"${opts.topic ? ` con este enfoque: ${opts.topic}` : ''}.

Reglas:
- Usa solo datos reales de arriba. No prometas plazos de entrega, stock limitado, "últimas unidades" ni descuentos que no aparezcan.
- Si mencionas el envío, usa exactamente los importes de los datos de la tienda.
- Español de España, tono motero cercano.

Responde EXCLUSIVAMENTE en JSON válido (sin markdown) con esta forma exacta:
{"hook": "primera frase para enganchar en los 2 primeros segundos",
 "copy": "texto para la descripción del TikTok, máx 2 líneas, con 1 emoji máximo",
 "script": "guion corto plano por escenas para grabar el vídeo o para el carrusel (3-5 pasos)",
 "hashtags": "6-8 hashtags separados por espacio, mezcla de nicho moto y genéricos de España"}`;

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

/** Imagen con Gemini, con la foto real del producto como referencia si la hay. */
async function geminiGenerateImage(prompt: string, reference: { data: string; mime: string } | null): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');
  const parts: any[] = [{ text: prompt }];
  if (reference) parts.push({ inlineData: { mimeType: reference.mime, data: reference.data } });
  const res = await fetch(`${GEMINI_BASE}/models/gemini-3-pro-image:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Gemini imagen ${res.status}`);
  const data: any = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!part) throw new Error('Gemini no devolvió imagen');
  return saveBufferAsFile(Buffer.from(part.inlineData.data, 'base64'), 'png');
}

/** Imagen solo a partir de texto con MiniMax (sin producto: escena genérica sin marcas). */
async function minimaxGenerateImage(prompt: string): Promise<string> {
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
export async function generateImages(opts: { format: string; topic?: string | null; script?: string; product: SlotProduct | null }): Promise<{ urls: string[]; notes: string[] }> {
  const notes: string[] = [];
  const p = opts.product;
  const scene = `Fotografía publicitaria realista en vertical (9:16) para TikTok, fondo de garaje/taller o carretera de
montaña, buena luz, sin texto superpuesto. ${opts.topic ? `Enfoque: ${opts.topic}.` : ''}`;

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
