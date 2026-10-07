/**
 * Publicaciones «de marca» para TikTok (sin producto): por ejemplo, dar a
 * conocer el chat con asesores. La IA escribe el texto de cada diapositiva y
 * describe una escena; Gemini (o MiniMax) genera la escena sin texto y el
 * servidor compone encima el título, el texto y el logo, para que no salgan
 * letras deformadas ni faltas de ortografía.
 */
import { storePolicies } from '../chatbot/index.js';
import { getSupportSettings, hoursText } from './live-chat.js';
import {
  NICHE_CONTEXT, GeneratedCopy, geminiGenerateText, minimaxGenerateText, repairJson,
  geminiGenerateImage, minimaxGenerateImage, normalizeHashtags,
} from './socialContentAI.js';

export interface Slide { title: string; text: string; scene: string }

/** Lo que ofrece la tienda además del catálogo (para no inventar servicios). */
async function storeServices(): Promise<string> {
  let hours = '';
  try { hours = hoursText(await getSupportSettings()); } catch { /* sin horario */ }
  return `SERVICIOS DE LA TIENDA (úsalos tal cual, no inventes otros):
- Chat en la web (botón abajo a la derecha en escapesymas.com).
- Asistente con IA disponible siempre: busca recambios compatibles con la moto del cliente por marca, modelo y año.
- Asesores humanos expertos en moto${hours ? ` (horario de atención: ${hours})` : ' dentro del horario de atención'}: el cliente pide hablar con una persona desde el mismo chat. El asesor le ayuda a elegir, le envía productos y fotos, le prepara el pedido con sus piezas y le manda el enlace para pagar.
- Fuera de horario el cliente deja un mensaje y le contestamos; le avisamos al móvil (los avisos son solo de su consulta, nunca publicidad).
- Más de 200 marcas y más de 100.000 recambios, accesorios y equipamiento de moto.`;
}

function parseCampaign(text: string): GeneratedCopy & { slides: Slide[] } {
  const m = text.replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('La IA no devolvió el formato esperado');
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch { parsed = JSON.parse(repairJson(m[0])); }
  const str = (v: any) => (Array.isArray(v) ? v.join('\n') : String(v || '')).trim();
  const slides: Slide[] = (Array.isArray(parsed.slides) ? parsed.slides : [])
    .map((x: any) => ({ title: str(x?.title).slice(0, 80), text: str(x?.text).slice(0, 220), scene: str(x?.scene).slice(0, 600) }))
    .filter((x: Slide) => x.title && x.scene)
    .slice(0, 6);
  if (!slides.length) throw new Error('La IA no devolvió diapositivas');
  return {
    hook: str(parsed.hook), copy: str(parsed.copy), script: str(parsed.script), hashtags: normalizeHashtags(str(parsed.hashtags)),
    imagePrompt: '', videoPrompt: str(parsed.video_prompt), slides,
  };
}

/** Texto de la publicación y de cada diapositiva. Gemini primero; si falla, MiniMax. */
export async function generateCampaignCopy(opts: { format: string; topic: string }): Promise<GeneratedCopy & { slides: Slide[] }> {
  const count = opts.format === 'carousel' ? 4 : 1;
  const prompt = `${NICHE_CONTEXT}

${await storeServices()}

${await storePolicies()}

Crea una publicación de TikTok de la propia tienda (sin un producto concreto) sobre: ${opts.topic}
Formato: ${opts.format === 'carousel' ? `carrusel de ${count} imágenes que se leen en orden: 1) gancho, 2-${count - 1}) beneficios concretos, ${count}) llamada a la acción con «escapesymas.com»` : 'una sola imagen con gancho y llamada a la acción'}.

Reglas:
- Usa solo los servicios y datos reales de arriba. No prometas tiempos de respuesta, descuentos ni nada que no aparezca.
- Títulos de 2 a 6 palabras, con fuerza. Textos de 1 o 2 frases cortas (máximo 160 caracteres).
- Español de España, tono motero cercano. Sin emojis en títulos ni textos de las diapositivas.
- "scene": descripción EN ESPAÑOL de una foto realista vertical para el fondo de esa diapositiva (personas, motos, taller, carretera, un móvil con un chat...), SIN texto, SIN logotipos y SIN marcas visibles; la mitad inferior debe tener zonas tranquilas para poner texto encima.

Responde EXCLUSIVAMENTE en JSON válido (sin markdown) con esta forma exacta:
{"hook": "frase de enganche",
 "copy": "texto para la descripción del TikTok, máx 2 líneas, con 1 emoji máximo",
 "hashtags": "6-8 hashtags separados por espacio",
 "script": "resumen del carrusel en una línea por diapositiva",
 "video_prompt": "instrucciones en español para animar la primera escena en un vídeo vertical de 6-8 segundos, sin texto en pantalla",
 "slides": [{"title": "...", "text": "...", "scene": "..."}]}`;
  try {
    return parseCampaign(await geminiGenerateText(prompt));
  } catch (err: any) {
    console.warn('[SOCIAL CAMPAIGN] Gemini texto falló, uso MiniMax:', err.message);
    return parseCampaign(await minimaxGenerateText(prompt));
  }
}

/** Escena de fondo de una diapositiva (vertical, sin texto). Gemini y, si falla, MiniMax. */
export async function generateScene(scene: string): Promise<{ url: string; engine: string }> {
  const prompt = `Fotografía realista vertical 9:16, estilo publicitario cuidado, buena luz, sin marcas de agua ni logotipos de redes sociales. ${scene}
Sin ningún texto, letra, logotipo ni marca visible. La foto ocupa todo el encuadre de borde a borde (nunca franjas,
marcos ni zonas de color liso); arriba, fondo sencillo (pared, cielo o desenfoque) y la mitad inferior con zonas tranquilas, porque ahí irá texto encima.`;
  try {
    return { url: await geminiGenerateImage(prompt, null), engine: 'gemini' };
  } catch (err: any) {
    console.warn('[SOCIAL CAMPAIGN] Gemini imagen falló, uso MiniMax:', err.message);
    return { url: await minimaxGenerateImage(prompt), engine: 'minimax' };
  }
}
