/**
 * Imágenes promocionales para TikTok: compone sobre la imagen (escena de la IA,
 * foto real del producto o imagen subida a mano) el logo de escapesymas.com y
 * el de la marca del producto. Los logos se ponen aquí y no con la IA porque
 * los modelos de imagen dibujan mal los logotipos.
 *
 * Formato 1080x1920 (9:16). Los logos van arriba, por debajo de la franja de
 * pestañas de TikTok (~150 px) y lejos de los botones de la derecha y del
 * texto de abajo.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { pool } from '../db.js';

const W = 1080;
const H = 1920;
const TOP = 170;          // por debajo de «Siguiendo | Para ti»
const SIDE = 60;
const STORE_LOGO_W = 500;
const BRAND_BOX = { w: 340, h: 120 };

const UPLOADS = path.join(process.cwd(), 'uploads');
const PROMO_DIR = path.join(UPLOADS, 'social-content', 'promo');
export const BRAND_DIR = path.join(UPLOADS, 'social-content', 'brands');
const TEMPLATES = path.join(process.cwd(), 'templates', 'social');
// Noto Sans Black (licencia OFL, ver fonts/OFL-NotoSans.txt) para el nombre de la marca sin logo.
const BRAND_FONT = path.join(TEMPLATES, 'fonts', 'NotoSans-Black.ttf');

const storeLogoCache: Record<string, Buffer> = {};

/** Logo de la tienda: blanco para fondos oscuros, negro para fondos claros. */
async function storeLogo(variant: 'blanco' | 'negro'): Promise<Buffer> {
  if (!storeLogoCache[variant]) {
    storeLogoCache[variant] = await sharp(path.join(TEMPLATES, `logo-escapesymas-${variant}.svg`), { density: 400 })
      .resize({ width: STORE_LOGO_W }).png().toBuffer();
  }
  return storeLogoCache[variant];
}

/** Lee una imagen de /uploads (ruta local) o de una URL. */
export async function readImage(src: string): Promise<Buffer> {
  if (src.startsWith('/uploads/')) {
    const file = path.join(process.cwd(), src.replace(/^\/+/, ''));
    if (!file.startsWith(UPLOADS)) throw new Error('Ruta no permitida');
    return fs.promises.readFile(file);
  }
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`No se pudo descargar la imagen (${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error('Imagen no válida');
}

/** Ruta del logo de una marca si el administrador lo ha subido. */
export async function brandLogoPath(brand: string | null | undefined): Promise<string | null> {
  if (!brand) return null;
  const { rows: [r] } = await pool.query(`SELECT url FROM brand_logos WHERE brand = upper($1)`, [brand.trim()]);
  if (!r) return null;
  const file = path.join(process.cwd(), String(r.url).replace(/^\/+/, ''));
  return file.startsWith(UPLOADS) && fs.existsSync(file) ? file : null;
}

/** Guarda un logo de marca subido: recortado, en PNG y con un tamaño manejable. */
export async function saveBrandLogo(brand: string, input: Buffer): Promise<string> {
  const key = brand.trim().toUpperCase();
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'marca';
  await fs.promises.mkdir(BRAND_DIR, { recursive: true });
  const filename = `${slug}-${Date.now()}.png`;
  await sharp(input, { density: 400 }).trim().resize({ width: 1000, height: 400, fit: 'inside', withoutEnlargement: true })
    .png().toFile(path.join(BRAND_DIR, filename));
  const url = `/uploads/social-content/brands/${filename}`;
  const { rows: [old] } = await pool.query(`SELECT url FROM brand_logos WHERE brand = $1`, [key]);
  await pool.query(
    `INSERT INTO brand_logos (brand, url, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (brand) DO UPDATE SET url = EXCLUDED.url, updated_at = NOW()`, [key, url]);
  if (old?.url) fs.unlink(path.join(process.cwd(), String(old.url).replace(/^\/+/, '')), () => {});
  return url;
}

/** Fondo blanco redondeado detrás del logo de la marca (los logos vienen en cualquier color). */
function pill(w: number, h: number) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" rx="${Math.round(h / 2.6)}" fill="#ffffff" fill-opacity="0.94"/></svg>`);
}

/** Degradado oscuro arriba para que el logo blanco se lea sobre cualquier escena. */
const topShade = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="560">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="0.72"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
  </linearGradient></defs><rect width="${W}" height="560" fill="url(#g)"/></svg>`);

const wordmarkCache = new Map<string, Buffer>();

/**
 * Marca sin logo subido: su nombre escrito en negrita (en el sitio del logo).
 * Así cualquiera de las 200+ marcas del catálogo sale identificada.
 */
async function brandWordmark(brand: string): Promise<Buffer> {
  const key = brand.trim().toUpperCase();
  if (!wordmarkCache.has(key)) {
    const safe = key.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = await sharp({
      text: { text: `<span foreground="#111111">${safe}</span>`, font: 'Noto Sans Black', fontfile: BRAND_FONT, rgba: true, dpi: 900 },
    }).png().toBuffer();
    wordmarkCache.set(key, await sharp(text).trim().resize({ width: BRAND_BOX.w, height: 64, fit: 'inside' }).png().toBuffer());
    if (wordmarkCache.size > 300) wordmarkCache.delete(wordmarkCache.keys().next().value as string);
  }
  return wordmarkCache.get(key)!;
}

/** Logo de la marca (o su nombre si no hay logo) en su cápsula blanca, para escenas y vídeos. */
async function brandPillLayers(logoFile: string | Buffer): Promise<sharp.OverlayOptions[]> {
  const logo = await sharp(logoFile).resize({ width: BRAND_BOX.w, height: BRAND_BOX.h, fit: 'inside' }).png().toBuffer();
  const lm = await sharp(logo).metadata();
  const pad = 22;
  const pw = (lm.width || BRAND_BOX.w) + pad * 2;
  const ph = (lm.height || BRAND_BOX.h) + pad * 2;
  return [
    { input: pill(pw, ph), left: W - SIDE - pw, top: TOP - 10 },
    { input: logo, left: W - SIDE - pw + pad, top: TOP - 10 + pad },
  ];
}

/**
 * Capa transparente de 1080x1920 con el degradado y los logos, para ponerla
 * encima de un vídeo (ffmpeg). Devuelve la ruta del PNG.
 */
export async function logoOverlayFile(brand: string | null | undefined): Promise<{ file: string; missingBrandLogo: boolean }> {
  const layers: sharp.OverlayOptions[] = [{ input: topShade, left: 0, top: 0 }, { input: await storeLogo('blanco'), left: SIDE, top: TOP }];
  const logoFile = await brandLogoPath(brand);
  const mark = logoFile || (brand ? await brandWordmark(brand).catch(() => null) : null);
  if (mark) layers.push(...(await brandPillLayers(mark)));
  await fs.promises.mkdir(PROMO_DIR, { recursive: true });
  const file = path.join(PROMO_DIR, `overlay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers).png().toFile(file);
  return { file, missingBrandLogo: !!brand && !logoFile };
}

/**
 * Compone la imagen promocional y devuelve su ruta en /uploads.
 * - Escena vertical (de la IA o subida): a pantalla completa, logo blanco y marca en una cápsula blanca.
 * - Foto de producto (cuadrada, fondo blanco): sobre lienzo blanco, logo negro y marca sin cápsula.
 */
export async function composePromo(src: string, brand: string | null | undefined): Promise<{ url: string; missingBrandLogo: boolean }> {
  const input = await readImage(src);
  const meta = await sharp(input).metadata();
  const isProductPhoto = !!meta.width && !!meta.height && meta.width / meta.height > 0.8;

  const layers: sharp.OverlayOptions[] = [];
  let base: sharp.Sharp;
  if (isProductPhoto) {
    const photo = await sharp(input).flatten({ background: '#ffffff' })
      .resize({ width: 980, height: 1100, fit: 'inside' }).png().toBuffer();
    const pm = await sharp(photo).metadata();
    base = sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } });
    layers.push({ input: photo, left: Math.round((W - (pm.width || 980)) / 2), top: Math.round(520 + (1100 - (pm.height || 1100)) / 2) });
    layers.push({ input: await storeLogo('negro'), left: SIDE, top: TOP });
  } else {
    base = sharp(input).resize({ width: W, height: H, fit: 'cover', position: 'attention' });
    layers.push({ input: topShade, left: 0, top: 0 });
    layers.push({ input: await storeLogo('blanco'), left: SIDE, top: TOP });
  }

  const logoFile = await brandLogoPath(brand);
  const mark = logoFile || (brand ? await brandWordmark(brand).catch(() => null) : null);
  if (mark) {
    const logo = await sharp(mark).resize({ width: BRAND_BOX.w, height: BRAND_BOX.h, fit: 'inside' }).png().toBuffer();
    const lm = await sharp(logo).metadata();
    const lw = lm.width || BRAND_BOX.w;
    const lh = lm.height || BRAND_BOX.h;
    if (isProductPhoto) {
      layers.push({ input: logo, left: W - SIDE - lw, top: TOP + Math.round((97 - lh) / 2) });
    } else {
      layers.push(...(await brandPillLayers(mark)));
    }
  }

  await fs.promises.mkdir(PROMO_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  await base.composite(layers).jpeg({ quality: 90, mozjpeg: true }).toFile(path.join(PROMO_DIR, filename));
  return { url: `/uploads/social-content/promo/${filename}`, missingBrandLogo: !!brand && !logoFile };
}

/** Compone todas las imágenes; si alguna falla se queda la original. */
export async function composeAll(srcs: string[], brand: string | null | undefined): Promise<{ urls: string[]; missingBrandLogo: boolean }> {
  const urls: string[] = [];
  let missing = false;
  for (const src of srcs) {
    try {
      const r = await composePromo(src, brand);
      urls.push(r.url);
      missing = missing || r.missingBrandLogo;
    } catch (err: any) {
      console.warn('[SOCIAL PROMO] no se pudo componer', src, err.message);
      urls.push(src);
    }
  }
  return { urls, missingBrandLogo: missing };
}

// ---------------------------------------------------------------- diapositivas de marca

const BODY_FONT = path.join(TEMPLATES, 'fonts', 'NotoSans-Bold.ttf');
const ACCENT = '#FACC15'; // el amarillo del «+» del logo
const TEXT_W = 900;
const TEXT_BOTTOM = 1500;   // por encima del texto y los botones de TikTok

const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Texto en varias líneas (Pango) con la tipografía de la tienda. */
async function renderText(text: string, fontfile: string, family: string, sizePx: number, color: string): Promise<Buffer> {
  return sharp({
    text: {
      text: `<span foreground="${color}">${escapeMarkup(text)}</span>`,
      font: `${family} ${sizePx}`, fontfile, width: TEXT_W, dpi: 72, rgba: true, wrap: 'word', spacing: Math.round(sizePx * 0.15),
    },
  }).png().toBuffer();
}

/** Degradado oscuro en la mitad inferior para que el texto blanco se lea sobre cualquier escena. */
const bottomShade = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="1160">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.45" stop-color="#000" stop-opacity="0.62"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.85"/>
  </linearGradient></defs><rect width="${W}" height="1160" fill="url(#g)"/></svg>`);

/**
 * Diapositiva de una publicación de marca: escena a pantalla completa, logo de
 * escapesymas.com arriba, y título (amarillo en la última, la llamada a la acción)
 * con su texto en la mitad inferior. Devuelve la ruta en /uploads.
 */
export async function composeSlide(scene: string, slide: { title: string; text: string }, isLast: boolean): Promise<string> {
  const input = await readImage(scene);
  const base = sharp(input).resize({ width: W, height: H, fit: 'cover', position: 'attention' });
  const title = await renderText(slide.title.toUpperCase(), BRAND_FONT, 'Noto Sans Black', 86, isLast ? ACCENT : '#FFFFFF');
  const body = slide.text ? await renderText(slide.text, BODY_FONT, 'Noto Sans Bold', 44, '#F4F4F5') : null;
  const th = (await sharp(title).metadata()).height || 0;
  const bh = body ? (await sharp(body).metadata()).height || 0 : 0;
  const gap = body ? 30 : 0;
  const top = Math.max(760, TEXT_BOTTOM - th - gap - bh);
  const bar = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="12"><rect width="120" height="12" rx="6" fill="${ACCENT}"/></svg>`);
  const layers: sharp.OverlayOptions[] = [
    { input: topShade, left: 0, top: 0 },
    { input: bottomShade, left: 0, top: H - 1160 },
    { input: await storeLogo('blanco'), left: SIDE, top: TOP },
    { input: bar, left: SIDE, top: top - 40 },
    { input: title, left: SIDE, top },
  ];
  if (body) layers.push({ input: body, left: SIDE, top: top + th + gap });
  await fs.promises.mkdir(PROMO_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  await base.composite(layers).jpeg({ quality: 90, mozjpeg: true }).toFile(path.join(PROMO_DIR, filename));
  return `/uploads/social-content/promo/${filename}`;
}
