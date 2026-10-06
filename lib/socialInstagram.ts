/**
 * Versión de Instagram de una publicación del calendario: las mismas imágenes
 * en 4:5 (1080x1350, lo que más ocupa en el feed) con los logos y textos
 * recolocados, y una descripción adaptada (Instagram no enlaza en el texto:
 * «enlace en la bio»). Los vídeos de 9:16 sirven tal cual para Reels.
 */
import { pool } from '../db.js';
import { composeAll, composePromo, composeSlide } from './socialPromo.js';
import { productBySku, NICHE_CONTEXT, geminiGenerateText, minimaxGenerateText, repairJson } from './socialContentAI.js';

/** Imágenes 4:5: diapositivas de marca, o promos de producto desde las imágenes base y las finales subidas. */
async function instagramImages(slot: any): Promise<string[]> {
  if (slot.campaign) {
    const scenes: string[] = slot.base_media || [];
    const slides = slot.slides || [];
    const out: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      try { out.push(await composeSlide(scenes[i], slides[i] || { title: '', text: '' }, i === scenes.length - 1 && scenes.length > 1, 'instagram')); }
      catch (err: any) { console.warn('[SOCIAL IG] diapositiva', i, err.message); }
    }
    return out;
  }
  const brand = slot.product_sku ? (await productBySku(slot.product_sku))?.brand || null : null;
  const base: string[] = slot.base_media?.length ? slot.base_media : slot.media_urls || [];
  const { urls } = await composeAll(base, brand, 'instagram');
  for (const m of slot.final_media || []) {
    if (m.type !== 'image') continue;
    try { urls.push((await composePromo(m.original || m.url, brand, 'instagram')).url); } catch { /* se omite */ }
  }
  return urls;
}

/** Descripción para Instagram a partir del texto de TikTok y las diapositivas. */
async function instagramCaption(slot: any): Promise<{ copy: string; hashtags: string }> {
  const slidesText = (slot.slides || []).map((s: any, i: number) => `${i + 1}. ${s.title} — ${s.text}`).join('\n');
  const prompt = `${NICHE_CONTEXT}

Adapta esta publicación de TikTok a una publicación de Instagram (carrusel o foto en el feed).
Texto de TikTok:
${slot.copy || ''}
${slidesText ? `Diapositivas:\n${slidesText}` : ''}
${slot.script ? `Guion:\n${slot.script}` : ''}

Reglas:
- Usa solo lo que dice el texto original; no inventes datos, precios, plazos ni descuentos.
- 3 a 6 líneas cortas: gancho, beneficio, y cierre con llamada a la acción. En Instagram los enlaces del texto no funcionan:
  di «enlace en la bio» o «escríbenos por el chat de escapesymas.com». Si es un carrusel, invita a deslizar.
- 1 o 2 emojis como mucho. Español de España, tono motero cercano.
- 10 a 15 hashtags en español (moto, recambios, España) separados por espacio.

Responde EXCLUSIVAMENTE en JSON válido (sin markdown): {"copy": "...", "hashtags": "..."}`;
  const parse = (t: string) => {
    const m = t.replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('La IA no devolvió el formato esperado');
    let d: any;
    try { d = JSON.parse(m[0]); } catch { d = JSON.parse(repairJson(m[0])); }
    if (!d.copy) throw new Error('La IA devolvió el texto vacío');
    return { copy: String(d.copy).trim().slice(0, 2200), hashtags: String(d.hashtags || '').trim().slice(0, 600) };
  };
  try { return parse(await geminiGenerateText(prompt)); }
  catch (err: any) {
    console.warn('[SOCIAL IG] Gemini falló, uso MiniMax:', err.message);
    return parse(await minimaxGenerateText(prompt));
  }
}

/** Crea (o rehace) la versión de Instagram en segundo plano. */
export async function startInstagramVersion(id: number, withCaption = true): Promise<boolean> {
  const { rows: [slot] } = await pool.query(
    `UPDATE social_content_calendar SET ig_status = 'generating', ig_error = NULL, updated_at = NOW()
     WHERE id = $1 AND (copy IS NOT NULL OR jsonb_array_length(media_urls) > 0) RETURNING *`, [id]);
  if (!slot) return false;
  (async () => {
    try {
      const media = await instagramImages(slot);
      if (!media.length) throw new Error('No hay imágenes para adaptar');
      const caption = withCaption || !slot.ig_copy ? await instagramCaption(slot) : { copy: slot.ig_copy, hashtags: slot.ig_hashtags };
      await pool.query(
        `UPDATE social_content_calendar SET ig_media = $2::jsonb, ig_copy = $3, ig_hashtags = $4, ig_status = 'ready', updated_at = NOW() WHERE id = $1`,
        [id, JSON.stringify(media), caption.copy, caption.hashtags]);
    } catch (err: any) {
      console.error('[SOCIAL IG]', id, err.message);
      await pool.query(`UPDATE social_content_calendar SET ig_status = 'error', ig_error = $2 WHERE id = $1`,
        [id, `No se pudo crear la versión de Instagram: ${err.message}`]);
    }
  })();
  return true;
}

/** Tras editar las diapositivas o subir logos: rehace solo las imágenes de Instagram (sin IA). */
export async function recomposeInstagram(id: number) {
  const { rows: [slot] } = await pool.query(`SELECT * FROM social_content_calendar WHERE id = $1`, [id]);
  if (!slot || !(slot.ig_media || []).length) return;
  const media = await instagramImages(slot);
  if (media.length) await pool.query(`UPDATE social_content_calendar SET ig_media = $2::jsonb WHERE id = $1`, [id, JSON.stringify(media)]);
}
