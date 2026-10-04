/**
 * Generación de contenido para TikTok (copy, guion, imagen) con Gemini, y
 * como alternativa de imagen, Minimax. El vídeo final (Veo) se deja para
 * cuando haya presupuesto/cuota confirmados: de momento se genera guion +
 * imágenes de apoyo para que el administrador grabe o monte el vídeo.
 */
import fs from 'fs';
import path from 'path';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

const uploadDir = path.join(process.cwd(), 'uploads', 'social-content');
fs.mkdirSync(uploadDir, { recursive: true });

export const NICHE_CONTEXT = `Escapes y Más (escapesymas.com) vende recambios y equipamiento de moto de
alto rendimiento: escapes/silenciadores IXIL, cascos BELL, ropa y equipamiento
técnico RST (cazadoras, pantalones, guantes). Público: moteros en España,
tono cercano y experto, nada de humo de marketing. El contenido debe generar
deseo por el producto y dar un motivo claro para comprar ya (envío 24h,
pocas unidades, sonido/estética del escape, protección real).`;

export interface GeneratedCopy {
  hook: string;
  copy: string;
  script: string;
  hashtags: string;
}

async function geminiGenerateText(prompt: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');
  const res = await fetch(`${GEMINI_BASE}/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini text error ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
  if (!text) throw new Error('Gemini no devolvió texto');
  return text;
}

/** Copy, guion, hook y hashtags para un slot del calendario. */
export async function generateCopy(opts: { format: string; topic?: string; productSku?: string }): Promise<GeneratedCopy> {
  const prompt = `${NICHE_CONTEXT}

Genera contenido para un TikTok de formato "${opts.format}" sobre: ${opts.topic || 'un producto destacado del catálogo (escape, casco o ropa técnica)'}.
${opts.productSku ? `SKU de referencia: ${opts.productSku}.` : ''}

Responde EXCLUSIVAMENTE en JSON válido (sin markdown) con esta forma exacta:
{"hook": "primera frase para enganchar en los 2 primeros segundos",
 "copy": "texto para la descripción del TikTok, máx 2 líneas, con 1 emoji máximo",
 "script": "guion corto plano por escenas para grabar el vídeo o para el carrusel (3-5 pasos)",
 "hashtags": "6-8 hashtags separados por espacio, mezcla de nicho moto y genéricos de España"}`;

  const text = await geminiGenerateText(prompt);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini no devolvió JSON parseable: ' + text.slice(0, 200));
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    hook: parsed.hook || '',
    copy: parsed.copy || '',
    script: parsed.script || '',
    hashtags: parsed.hashtags || '',
  };
}

async function saveBufferAsFile(buffer: Buffer, ext: string): Promise<string> {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), buffer);
  return `/uploads/social-content/${filename}`;
}

/** Imagen con Gemini (Nano Banana Pro). Devuelve la ruta local servida por /uploads. */
async function geminiGenerateImage(prompt: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');
  const res = await fetch(`${GEMINI_BASE}/models/gemini-3-pro-image:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini image error ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!part) throw new Error('Gemini no devolvió imagen');
  const buffer = Buffer.from(part.inlineData.data, 'base64');
  return saveBufferAsFile(buffer, 'png');
}

/** Alternativa de imagen con Minimax (confirmado disponible en el plan actual). */
async function minimaxGenerateImage(prompt: string): Promise<string> {
  if (!MINIMAX_API_KEY) throw new Error('MINIMAX_API_KEY no configurada');
  const res = await fetch('https://api.minimax.io/v1/image_generation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'image-01', prompt, n: 1 }),
  });
  if (!res.ok) throw new Error(`Minimax image error ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const url = data?.data?.image_urls?.[0];
  if (!url) throw new Error('Minimax no devolvió imagen: ' + JSON.stringify(data).slice(0, 200));
  const imgRes = await fetch(url);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  return saveBufferAsFile(buffer, 'jpg');
}

/** Genera 1 imagen (foto) o varias (carrusel), con Minimax como respaldo si Gemini falla. */
export async function generateImages(opts: { format: string; topic?: string; script?: string }): Promise<string[]> {
  const count = opts.format === 'carousel' ? 4 : 1;
  const basePrompt = `Fotografía publicitaria realista para TikTok, estilo producto de alto
rendimiento para motos (escapes, cascos o ropa técnica), fondo de garaje/taller
o carretera, buena luz, sin texto superpuesto. Tema: ${opts.topic || 'producto destacado'}.
${opts.script ? `Contexto del guion: ${opts.script}` : ''}`;

  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const prompt = count > 1 ? `${basePrompt}\nEscena ${i + 1} de ${count} del carrusel, ángulo distinto.` : basePrompt;
    try {
      urls.push(await geminiGenerateImage(prompt));
    } catch (err: any) {
      console.error('[SOCIAL CONTENT] Gemini image failed, falling back to Minimax:', err.message);
      urls.push(await minimaxGenerateImage(prompt));
    }
  }
  return urls;
}

/** Genera copy + imágenes para un slot completo del calendario. */
export async function generateFullContent(opts: { format: string; topic?: string; productSku?: string }) {
  const copy = await generateCopy(opts);
  const mediaUrls = await generateImages({ format: opts.format, topic: opts.topic, script: copy.script });
  return { copy, mediaUrls };
}
