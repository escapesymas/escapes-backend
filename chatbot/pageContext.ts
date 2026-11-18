/**
 * Producto que el cliente tiene abierto en la web cuando escribe al asistente.
 *
 * Antes el asistente no sabía en qué página estaba el cliente: «¿me sirve para mi moto?», «¿hay stock?» o «¿cuándo llega?»
 * desde una ficha obligaban a repetir el nombre del producto, y lo habitual en preventa es preguntar justo eso. Aquí se
 * prepara un bloque con los datos reales de la ficha (precio, stock de este momento, compatibilidad con la moto del cliente)
 * para el prompt.
 */
import { pool } from '../db.js';
import { refreshLiveStock } from '../lib/live-stock.js';
import { compatibleSkus } from '../lib/moto-catalog.js';
import { catalogMoto } from './catalog.js';

export interface PageRef {
  sku?: string;
  id?: number;
}

const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/+ ]{0,79}$/;

/** Referencia de producto que manda el navegador (hay que fiarse poco: solo se acepta un sku o un id con forma válida). */
export function parsePageRef(raw: unknown): PageRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sku = typeof r.sku === 'string' && SKU_RE.test(r.sku.trim()) ? r.sku.trim() : undefined;
  const id = Number.isInteger(r.id) && (r.id as number) > 0 ? (r.id as number) : undefined;
  return sku || id ? { sku, id } : null;
}

const stripHtml = (html: string): string =>
  String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;|&quot;|&#39;/g, ' ').replace(/\s+/g, ' ').trim();

const eurCents = (c: number) => `${(c / 100).toFixed(2)} €`;

/** Marcas de las compatibilidades de un producto (para decir «vale para Honda, Yamaha…» sin listar cientos de modelos). */
function compatBrands(compat: any[]): string[] {
  return [...new Set(compat.map((e) => String(e?.brand || '').trim().toUpperCase()).filter(Boolean))].slice(0, 8);
}

/**
 * Bloque de texto para el prompt con la ficha del producto de la página y, si se conoce la moto del cliente, si le vale.
 * Devuelve '' si no se encuentra el producto. No lanza nunca.
 */
export async function getPageProductContext(ref: PageRef, bike: string | null): Promise<string> {
  try {
    const find = (by: 'sku' | 'id', value: string | number) => pool.query(
      `SELECT id, sku, name, brand, price, sale_price, promo_price, stock, description, compatibility, attributes, restock_date::text AS restock_date
         FROM products WHERE status = 'published' AND ${by} = $1 LIMIT 1`, [value]);
    let p = ref.sku ? (await find('sku', ref.sku)).rows[0] : undefined;
    // La URL de la ficha lleva el sku, pero un enlace antiguo puede llevar el id numérico.
    if (!p && ref.sku && /^\d{1,9}$/.test(ref.sku)) p = (await find('id', Number(ref.sku))).rows[0];
    if (!p && ref.id) p = (await find('id', ref.id)).rows[0];
    if (!p) return '';

    const live = (await refreshLiveStock([p.id], { ttlSec: 120, waitGateMs: 800 })).get(p.id);
    const stock = live ? live.stock : Number(p.stock) || 0;
    const restock = stock > 0 ? null : (live ? live.restockDate : p.restock_date) || null;
    const eff = Number(p.promo_price) > 0
      ? Number(p.promo_price)
      : Math.min(Number(p.price), Number(p.sale_price) > 0 ? Number(p.sale_price) : Number(p.price));
    const priceStr = eff < Number(p.price) ? `${eurCents(eff)} (antes ${eurCents(Number(p.price))})` : eurCents(Number(p.price));
    const stockStr = stock > 0 ? `en stock (${stock} uds.)` : restock ? `sin stock ahora, en reaprovisionamiento (previsto ${restock})` : 'sin stock ahora mismo';

    const compat: any[] = Array.isArray(p.compatibility) ? p.compatibility : [];
    let compatLine: string;
    if (!compat.length) {
      compatLine = 'No depende de la moto (producto universal).';
    } else {
      const moto = bike ? catalogMoto(bike) : null;
      if (moto?.model) {
        const skus = await compatibleSkus(moto.brand, moto.model, moto.year ? String(moto.year) : undefined).catch(() => [] as string[]);
        const name = `${moto.brand} ${moto.model}${moto.year ? ` (${moto.year})` : ''}`.toUpperCase();
        compatLine = skus.includes(p.sku)
          ? `Su moto (${name}): VERIFICADO COMPATIBLE. Confírmaselo sin rodeos.`
          : skus.length
            ? `Su moto (${name}): NO figura como compatible con este producto. Díselo con claridad y, si quiere, ofrécele buscarle uno que sí le valga.`
            : `Su moto (${name}): no tenemos datos de compatibilidad suficientes para confirmarlo; no afirmes que vale. Ofrécele un asesor.`;
      } else {
        compatLine = `Depende de la moto (compatibilidades registradas con marcas como ${compatBrands(compat).join(', ')}). NO sabemos la moto del cliente: ` +
          'pregúntale marca, modelo y año antes de decirle si le vale.';
      }
    }

    const attrs = Object.entries(p.attributes && typeof p.attributes === 'object' ? p.attributes : {})
      .filter(([, v]) => typeof v === 'string' && String(v).length <= 60 && String(v).trim())
      .slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(' · ');
    const desc = stripHtml(p.description).slice(0, 450);

    return [
      'EL CLIENTE ESTÁ VIENDO ESTE PRODUCTO AHORA MISMO (si dice «este», «esto», «el escape», «¿me sirve?»… se refiere a él; usa estos datos tal cual):',
      `- ${p.brand || 'Genérico'} | "${p.name}" | ${priceStr} | ${stockStr}`,
      `- Compatibilidad: ${compatLine}`,
      attrs ? `- Datos de la ficha: ${attrs}` : '',
      desc ? `- Descripción de la ficha: ${desc}` : '',
    ].filter(Boolean).join('\n');
  } catch (err) {
    console.warn('[chatbot] contexto de página no disponible:', (err as Error)?.message);
    return '';
  }
}
