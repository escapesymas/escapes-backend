/**
 * Carrusel de producto (4 diapositivas): gancho sobre una escena, ficha del
 * producto con su foto real, precio (con el anterior tachado y el % si está en
 * oferta) y llamada a la acción. El precio se lee del catálogo al componer, así
 * que siempre sale el actual; los textos son los que escribió la IA (editables).
 */
import { composeSlide, composeProductCard, Platform } from './socialPromo.js';
import { productBySku, SlotProduct } from './socialContentAI.js';

export interface ProductSlide { title: string; text: string; kind: 'scene' | 'card' | 'price'; image: string }

export const isProductCarousel = (slides: any[] | null | undefined) =>
  Array.isArray(slides) && slides.length > 0 && !!slides[0]?.kind;

/** Diapositivas a partir de los textos de la IA y las imágenes disponibles. */
export function buildProductSlides(
  texts: { title: string; text: string }[] | undefined,
  p: SlotProduct,
  scenes: { hook: string | null; cta: string | null },
  hook: string,
): ProductSlide[] {
  const photo1 = p.images[0];
  const photo2 = p.images[1] || photo1;
  const t = (i: number, title: string, text = '') => ({ title: texts?.[i]?.title || title, text: texts?.[i]?.text ?? text });
  return [
    { ...t(0, hook || `${p.brand} ${p.name}`.slice(0, 60)), kind: scenes.hook ? 'scene' : 'card', image: scenes.hook || photo1 },
    { ...t(1, p.name.slice(0, 60)), kind: 'card', image: photo1 },
    { ...t(2, 'Precio'), kind: 'price', image: photo2 },
    { ...t(3, 'Pídelo en escapesymas.com'), kind: scenes.cta || scenes.hook ? 'scene' : 'card', image: scenes.cta || scenes.hook || photo1 },
  ];
}

/** Compone las diapositivas (TikTok 9:16 o Instagram 4:5). */
export async function composeProductCarousel(slides: ProductSlide[], productSku: string | null, platform: Platform = 'tiktok'): Promise<string[]> {
  const p = productSku ? await productBySku(productSku) : null;
  const brand = p?.brand || null;
  const out: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const sl = slides[i];
    const isLast = i === slides.length - 1;
    try {
      if (sl.kind === 'scene') out.push(await composeSlide(sl.image, sl, isLast, platform, brand));
      else if (sl.kind === 'price' && p) {
        out.push(await composeProductCard(sl.image, sl, { brand, price: { now: p.price, before: p.price < p.listPrice ? p.listPrice : null } }, platform));
      } else out.push(await composeProductCard(sl.image, sl, { brand, accent: isLast }, platform));
    } catch (err: any) {
      console.warn('[SOCIAL CAROUSEL] diapositiva', i, err.message);
    }
  }
  return out;
}
