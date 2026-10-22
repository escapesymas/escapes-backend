/**
 * Feed de productos para Google Merchant Center (Google Shopping): RSS 2.0 con el espacio de nombres g:.
 *
 * - Solo productos publicados con foto en nuestro servidor y con stock (decisión de Adrián, 22/10/2026).
 * - Sin productos de Bihr (marca BIHR o «Bihr» en el nombre): es nuestro proveedor y no se anuncia.
 * - El precio es el mismo que enseña la web (promoción, oferta si es menor o precio); Google exige que coincida.
 *
 * Se genera una vez al día en uploads/feeds/google.xml.gz (fuera de lo público de /uploads) y lo sirve
 * GET /feeds/google.xml. Pesa decenas de MB: se escribe por tandas y comprimido.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { pool } from '../db.js';

const SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://escapesymas.com').replace(/\/$/, '');
export const FEED_DIR = path.join(process.cwd(), 'uploads', 'feeds');
export const FEED_FILE = path.join(FEED_DIR, 'google.xml.gz');
const BATCH = 2000;
const MAX_DESCRIPTION = 1500;
const MAX_EXTRA_IMAGES = 10;

export interface FeedResult { startedAt: string; finishedAt?: string; status: 'running' | 'done' | 'error'; items?: number; skipped?: Record<string, number>; bytes?: number; error?: string }
let running: Promise<FeedResult> | null = null;

const xml = (s: string) => s
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Texto plano de la descripción (sin HTML), sin frases que nombren al proveedor. */
export function plainDescription(html: string | null | undefined): string {
  const text = String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ').trim();
  return text.split(/(?<=[.!?])\s+/).filter((s) => !/bihr/i.test(s)).join(' ').slice(0, MAX_DESCRIPTION).trim();
}

/** EAN/UPC válido (8, 12, 13 o 14 cifras con su dígito de control); si no, se omite. */
export function validGtin(code: string | null | undefined): string | null {
  const c = String(code || '').trim();
  if (!/^(\d{8}|\d{12,14})$/.test(c)) return null;
  const digits = c.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? c : null;
}

/** Lo que cobra la web: promoción; si no, la oferta si es menor; si no, el precio (como quoteOrder). */
export function feedPrices(price: number, sale: number | null, promo: number | null): { price: number; salePrice: number | null } {
  const list = Number(price) || 0;
  const s = Number(sale) || 0;
  const effective = Number(promo) || (s > 0 && s < list ? s : list);
  return { price: list, salePrice: effective < list ? effective : null };
}

const eur = (cents: number) => `${(cents / 100).toFixed(2)} EUR`;
const srcOf = (img: any): string => (typeof img === 'string' ? img : img?.src || img?.url || '');
const absolute = (src: string) => (src.startsWith('/') ? `${SITE_URL}${src}` : src);

export interface FeedRow {
  id: number; sku: string; name: string; brand: string | null; description: string | null;
  price: number; sale_price: number | null; promo_price: number | null; stock: number;
  images: unknown; barcode: string | null; supplier_code: string | null; weight_g: number | null; category_id: number | null;
}

/** Un <item> del feed, o el motivo para dejarlo fuera. */
export function feedItem(r: FeedRow, categoryPath: (id: number | null) => string): { xml: string } | { skip: string } {
  if (/bihr/i.test(`${r.brand || ''} ${r.name || ''}`)) return { skip: 'bihr' };
  if (!(Number(r.stock) > 0)) return { skip: 'sin_stock' };
  // Solo fotos de nuestro servidor: las de Bihr pueden caducar y Google rechaza el producto si la foto falla.
  const local = (Array.isArray(r.images) ? r.images : []).map(srcOf).filter((s) => s.startsWith('/uploads/'));
  if (!local.length) return { skip: 'sin_foto' };
  const { price, salePrice } = feedPrices(r.price, r.sale_price, r.promo_price);
  if (price <= 0) return { skip: 'sin_precio' };
  const title = String(r.name || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  const description = plainDescription(r.description) || title;
  const gtin = validGtin(r.barcode);
  const mpn = String(r.supplier_code || '').trim().slice(0, 70);
  const brand = String(r.brand || '').trim();
  const type = categoryPath(r.category_id);
  const parts = [
    `<g:id>${xml(r.sku)}</g:id>`,
    `<title>${xml(title)}</title>`,
    `<description>${xml(description)}</description>`,
    `<link>${xml(`${SITE_URL}/producto/${encodeURIComponent(r.sku)}`)}</link>`,
    `<g:image_link>${xml(absolute(local[0]))}</g:image_link>`,
    ...local.slice(1, 1 + MAX_EXTRA_IMAGES).map((s) => `<g:additional_image_link>${xml(absolute(s))}</g:additional_image_link>`),
    '<g:availability>in_stock</g:availability>',
    '<g:condition>new</g:condition>',
    `<g:price>${eur(price)}</g:price>`,
    salePrice ? `<g:sale_price>${eur(salePrice)}</g:sale_price>` : '',
    brand ? `<g:brand>${xml(brand)}</g:brand>` : '',
    gtin ? `<g:gtin>${gtin}</g:gtin>` : '',
    mpn ? `<g:mpn>${xml(mpn)}</g:mpn>` : '',
    !gtin && !(brand && mpn) ? '<g:identifier_exists>no</g:identifier_exists>' : '',
    type ? `<g:product_type>${xml(type)}</g:product_type>` : '',
    Number(r.weight_g) > 0 ? `<g:shipping_weight>${Number(r.weight_g)} g</g:shipping_weight>` : '',
  ].filter(Boolean);
  return { xml: `<item>${parts.join('')}</item>\n` };
}

async function* feedChunks(stats: { items: number; skipped: Record<string, number> }): AsyncGenerator<string> {
  const { rows: cats } = await pool.query('SELECT id, name, parent_id FROM categories');
  const byId = new Map<number, { name: string; parent_id: number | null }>(cats.map((c: any) => [c.id, c]));
  const pathCache = new Map<number, string>();
  const categoryPath = (id: number | null): string => {
    if (!id) return '';
    if (pathCache.has(id)) return pathCache.get(id)!;
    const names: string[] = [];
    for (let cur = byId.get(id), guard = 0; cur && guard < 6; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, guard++) names.unshift(cur.name);
    const p = names.join(' > ');
    pathCache.set(id, p);
    return p;
  };

  yield '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n'
    + `<title>Escapes y Más</title>\n<link>${SITE_URL}</link>\n<description>Recambios, accesorios y equipamiento de moto</description>\n`;
  let lastId = 0;
  for (;;) {
    const { rows } = await pool.query<FeedRow>(
      `SELECT id, sku, name, brand, description, price, sale_price, promo_price, stock, images, barcode, supplier_code, weight_g, category_id
         FROM products
        WHERE id > $1 AND status = 'published' AND price > 0 AND duplicate_of IS NULL AND stock > 0
        ORDER BY id LIMIT $2`, [lastId, BATCH]);
    if (!rows.length) break;
    let out = '';
    for (const r of rows) {
      const it = feedItem(r, categoryPath);
      if ('skip' in it) stats.skipped[it.skip] = (stats.skipped[it.skip] || 0) + 1;
      else { out += it.xml; stats.items++; }
    }
    lastId = rows[rows.length - 1].id;
    yield out;
  }
  yield '</channel>\n</rss>\n';
}

async function build(): Promise<FeedResult> {
  const result: FeedResult = { startedAt: new Date().toISOString(), status: 'running' };
  const stats = { items: 0, skipped: {} as Record<string, number> };
  const tmp = `${FEED_FILE}.${process.pid}.tmp`;
  try {
    await fs.promises.mkdir(FEED_DIR, { recursive: true });
    await pipeline(Readable.from(feedChunks(stats)), zlib.createGzip({ level: 9 }), fs.createWriteStream(tmp));
    await fs.promises.rename(tmp, FEED_FILE);
    Object.assign(result, { status: 'done', items: stats.items, skipped: stats.skipped, bytes: (await fs.promises.stat(FEED_FILE)).size });
  } catch (err: any) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    Object.assign(result, { status: 'error', error: err?.message || String(err) });
  } finally {
    result.finishedAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO catalog_meta (key, value) VALUES ('google_feed_last', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(result)]).catch(() => {});
    console.log('[GOOGLE FEED]', JSON.stringify(result));
  }
  return result;
}

/** Genera el feed (si ya se está generando, espera a esa pasada). */
export function buildGoogleFeed(): Promise<FeedResult> {
  if (!running) running = build().finally(() => { running = null; });
  return running;
}
