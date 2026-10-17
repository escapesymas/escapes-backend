/**
 * Recupera las fotos de UN producto cuando la ficha solo apunta a URLs remotas
 * de Bihr que no se ven (la tienda enseña «Imagen no disponible») y las deja
 * en /uploads/optimized, como hace el descargador (scripts/download-images-from-zip.ts):
 *
 *   1. las URLs de la propia ficha (CDN de Bihr, con la cabecera de /api/image-proxy);
 *   2. el zip de fotos de la marca (static.bihr.pro), leyendo solo las partes
 *      que hacen falta con HTTP Range (docs/BIHR_IMAGE_SOURCES.md);
 *   3. la API de Bihr (/Products/Image/{código}).
 *
 * Las fotos se abren en el procesador aislado (lib/image-sandbox.ts), nunca aquí.
 * Devuelve qué se intentó y qué contestó cada fuente, para ver el motivo si no hay foto.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pool } from '../db.js';
import { fetchRemoteImage, REMOTE_IMAGE_MAX_BYTES } from './remote-image.js';
import { processImage, detectImageType } from './image-sandbox.js';

export const BIHR_ZIP_BASE = 'https://static.bihr.pro/eBihr/Pictures';
const BIHR_API_BASE = process.env.BIHR_API_BASE || 'https://api.bihr.net';
const ALLOWED_IMAGE_HOSTS = new Set(['api.mybihr.com', 'cdn.mybihr.com', 'bihr.net']);
const OPTIMIZED_DIR = path.join(process.cwd(), 'uploads', 'optimized');
const SIZES = [800, 400, 200] as const;
const MAX_PHOTOS = 4;
const ZIP_UA = 'EscapesYMas-Bihr-Image-Downloader/4.0';

export interface RepairAttempt { source: 'catalogo' | 'zip' | 'api'; target: string; ok: boolean; detail: string }
export interface RepairResult { saved: number; attempts: RepairAttempt[] }

const repairing = new Set<number>();

/** Nombre de fichero seguro a partir del SKU (igual que el descargador). */
const safeSkuForFile = (sku: string) => String(sku || '').replace(/[^A-Za-z0-9._-]/g, '_');

/** Lo que devuelve una fuente tiene que ser una foto de verdad (no una página de error con 200). */
function asPhoto(buf: Buffer): Buffer {
  const type = detectImageType(buf);
  if (type !== 'jpeg' && type !== 'png' && type !== 'webp' && type !== 'gif') throw new Error('la respuesta no es una imagen');
  return buf;
}

// ---------------------------------------------------------------- zip por rangos

export interface ZipEntry { name: string; offset: number; compSize: number; uncompSize: number }

/** GET con Range; solo acepta 206 (o un 200 pequeño) para no bajarse un zip de 1 GB por error. */
async function rangeFetch(url: string, range: string, timeoutMs: number): Promise<Buffer> {
  const r = await fetch(url, { headers: { 'User-Agent': ZIP_UA, Range: range }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (r.status !== 206 && !(r.status === 200 && Number(r.headers.get('content-length') || Infinity) <= 4 * 1024 * 1024)) {
    r.body?.cancel().catch(() => {});
    throw new Error(r.status === 200 ? 'el servidor no admite Range' : `HTTP ${r.status}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

/** Lee el directorio central del zip (sin ZIP64) y lista sus ficheros. */
export async function readZipIndex(zipUrl: string): Promise<ZipEntry[]> {
  const tail = await rangeFetch(zipUrl, 'bytes=-65536', 60_000);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no se encuentra el final del zip');
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdSize > 64 * 1024 * 1024) throw new Error('directorio del zip demasiado grande');
  const cd = await rangeFetch(zipUrl, `bytes=${cdOffset}-${cdOffset + cdSize - 1}`, 120_000);

  const files: ZipEntry[] = [];
  let i = 0;
  while (i + 46 <= cd.length && files.length < entries) {
    if (cd.readUInt32LE(i) !== 0x02014b50) break;
    const compSize = cd.readUInt32LE(i + 20);
    const uncompSize = cd.readUInt32LE(i + 24);
    const nameLen = cd.readUInt16LE(i + 28);
    const extraLen = cd.readUInt16LE(i + 30);
    const commentLen = cd.readUInt16LE(i + 32);
    const offset = cd.readUInt32LE(i + 42);
    files.push({ name: cd.toString('utf-8', i + 46, i + 46 + nameLen), offset, compSize, uncompSize });
    i += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Descomprime un fichero del zip. Los tamaños son los del directorio central (el local puede venir a 0). */
export async function readZipEntry(zipUrl: string, entry: ZipEntry): Promise<Buffer> {
  if (entry.compSize > REMOTE_IMAGE_MAX_BYTES || entry.uncompSize > REMOTE_IMAGE_MAX_BYTES) throw new Error('imagen demasiado grande');
  const first = await rangeFetch(zipUrl, `bytes=${entry.offset}-${entry.offset + 30 + 512 + entry.compSize - 1}`, 60_000);
  if (first.length < 30 || first.readUInt32LE(0) !== 0x04034b50) throw new Error('cabecera local no encontrada');
  const method = first.readUInt16LE(8);
  const dataStart = 30 + first.readUInt16LE(26) + first.readUInt16LE(28);
  let data = first.subarray(dataStart, dataStart + entry.compSize);
  if (data.length < entry.compSize) {
    data = await rangeFetch(zipUrl, `bytes=${entry.offset + dataStart}-${entry.offset + dataStart + entry.compSize - 1}`, 60_000);
  }
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`compresión ${method} no admitida`);
}

const zipIndexCache = new Map<string, { at: number; files: ZipEntry[] }>();
const ZIP_INDEX_TTL_MS = 6 * 3600_000;

async function cachedZipIndex(zipUrl: string): Promise<ZipEntry[]> {
  const hit = zipIndexCache.get(zipUrl);
  if (hit && Date.now() - hit.at < ZIP_INDEX_TTL_MS) return hit.files;
  const files = await readZipIndex(zipUrl);
  zipIndexCache.set(zipUrl, { at: Date.now(), files });
  return files;
}

/** Fotos <código>-1.jpg, -2.jpg… del zip, por número. */
export function zipPhotosFor(files: ZipEntry[], partNumber: string): Map<number, ZipEntry> {
  const re = new RegExp(`^${partNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.jpe?g$`, 'i');
  const out = new Map<number, ZipEntry>();
  for (const f of files) {
    const n = Number(f.name.split('/').pop()?.match(re)?.[1] ?? f.name.match(re)?.[1]);
    if (n >= 1 && !out.has(n)) out.set(n, f);
  }
  return out;
}

// ---------------------------------------------------------------- API de Bihr

let apiToken: { token: string; expiresAt: number } | null = null;

async function bihrApiToken(): Promise<string> {
  const user = process.env.BIHR_USERNAME || '';
  const key = process.env.BIHR_MACKEY || '';
  if (!user || !key) throw new Error('sin credenciales de la API de Bihr');
  if (apiToken && apiToken.expiresAt > Date.now() + 60_000) return apiToken.token;
  const r = await fetch(`${BIHR_API_BASE}/api/v2.1/Authentication/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ UserName: user, PassWord: key }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`autenticación HTTP ${r.status}`);
  const d: any = await r.json();
  if (!d?.access_token) throw new Error('la API no devolvió token');
  apiToken = { token: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return apiToken.token;
}

async function bihrApiImage(code: string): Promise<Buffer> {
  const token = await bihrApiToken();
  const r = await fetch(`${BIHR_API_BASE}/api/v2.1/Products/Image/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 200) throw new Error('respuesta demasiado pequeña');
  if (buf.length > REMOTE_IMAGE_MAX_BYTES) throw new Error('imagen demasiado grande');
  return buf;
}

// ---------------------------------------------------------------- guardado

async function saveVariants(photo: Buffer, safeSku: string, index: number): Promise<void> {
  const variants = await Promise.all(SIZES.map(async (size) => ({
    size,
    data: (await processImage(photo, { width: size, fit: 'inside', quality: 85, formats: ['jpeg', 'png', 'webp', 'gif'] })).data,
  })));
  await fs.promises.mkdir(OPTIMIZED_DIR, { recursive: true });
  for (const { size, data } of variants) {
    const file = path.join(OPTIMIZED_DIR, `${safeSku}_${index}_${size}.webp`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  }
}

const localImage = (safeSku: string, index: number, alt: string, originalUrl: string) => {
  const base = `/uploads/optimized/${safeSku}_${index}_`;
  return { src: `${base}800.webp`, srcMobile: `${base}400.webp`, srcCardDesktop: `${base}400.webp`, srcCardMobile: `${base}200.webp`, alt, originalUrl };
};

/** URL sin la parte firmada, para mostrarla en el informe. */
const shortUrl = (u: string) => { try { const p = new URL(u); return `${p.host}${p.pathname}`; } catch { return u.slice(0, 80); } };

const imageSrc = (img: any): string => (typeof img === 'string' ? img : img?.src || img?.url || '');

/**
 * Descarga las fotos del producto y reescribe `images` con las copias locales.
 * Si no se consigue ni la primera, la ficha queda como estaba.
 * `zipBase` solo cambia en las pruebas.
 */
export async function repairProductImages(productId: number, opts: { zipBase?: string } = {}): Promise<RepairResult> {
  if (repairing.has(productId)) throw new Error('Ya se están descargando las fotos de este producto');
  repairing.add(productId);
  try {
    const { rows: [p] } = await pool.query(
      `SELECT id, sku, name, brand, supplier_code, part_number, images FROM products WHERE id = $1`, [productId]);
    if (!p) throw new Error('Producto no encontrado');
    const safeSku = safeSkuForFile(p.sku);
    if (!safeSku) throw new Error('El producto no tiene SKU');

    const original: any[] = Array.isArray(p.images) ? p.images : [];
    const attempts: RepairAttempt[] = [];
    const slots: (Buffer | null)[] = Array.from({ length: Math.min(Math.max(original.length, 1), MAX_PHOTOS) }, () => null);
    const origin: string[] = slots.map(() => '');
    const note = (a: RepairAttempt) => { attempts.push(a); return a.ok; };

    // 1) URLs de la ficha
    for (let i = 0; i < slots.length; i++) {
      const src = imageSrc(original[i]);
      let host = '';
      try { const u = new URL(src); host = u.protocol === 'https:' ? u.hostname : ''; } catch { /* local o vacía */ }
      if (!host || !ALLOWED_IMAGE_HOSTS.has(host)) continue;
      try {
        slots[i] = asPhoto((await fetchRemoteImage(src, 20_000)).data);
        origin[i] = shortUrl(src);
        note({ source: 'catalogo', target: shortUrl(src), ok: true, detail: `${slots[i]!.length} bytes` });
      } catch (err: any) {
        note({ source: 'catalogo', target: shortUrl(src), ok: false, detail: err.message });
      }
    }

    // 2) zip de la marca
    const codes = Array.from(new Set([p.part_number, p.sku, p.supplier_code].map((c) => String(c || '').trim()).filter(Boolean)));
    if (slots.some((s) => !s) && p.brand) {
      const zipUrl = `${opts.zipBase || BIHR_ZIP_BASE}/${encodeURIComponent(String(p.brand).trim().toUpperCase())}-pictures.zip`;
      try {
        const files = await cachedZipIndex(zipUrl);
        note({ source: 'zip', target: shortUrl(zipUrl), ok: true, detail: `${files.length} ficheros en el índice` });
        const code = codes.find((c) => zipPhotosFor(files, c).size > 0);
        if (!code) note({ source: 'zip', target: codes.join(', '), ok: false, detail: 'ninguna de las referencias está en el zip' });
        else {
          const photos = zipPhotosFor(files, code);
          for (let i = 0; i < slots.length; i++) {
            const entry = photos.get(i + 1);
            if (slots[i] || !entry) continue;
            try {
              slots[i] = asPhoto(await readZipEntry(zipUrl, entry));
              origin[i] = `zip:${code}-${i + 1}`;
              note({ source: 'zip', target: entry.name, ok: true, detail: `${slots[i]!.length} bytes` });
            } catch (err: any) {
              note({ source: 'zip', target: entry.name, ok: false, detail: err.message });
            }
          }
        }
      } catch (err: any) {
        note({ source: 'zip', target: shortUrl(zipUrl), ok: false, detail: err.message });
      }
    }

    // 3) API de Bihr (una sola foto)
    if (!slots[0]) {
      for (const code of codes) {
        try {
          slots[0] = asPhoto(await bihrApiImage(code));
          origin[0] = `api:${code}`;
          note({ source: 'api', target: code, ok: true, detail: `${slots[0].length} bytes` });
          break;
        } catch (err: any) {
          note({ source: 'api', target: code, ok: false, detail: err.message });
          if (/credenciales/.test(err.message)) break;
        }
      }
    }

    // Guardado: la primera foto es imprescindible; si falla el procesador, la ficha no se toca.
    if (!slots[0]) return { saved: 0, attempts };
    const images: any[] = [];
    let saved = 0;
    for (let i = 0; i < Math.max(slots.length, original.length); i++) {
      const photo = slots[i];
      if (photo) {
        try {
          await saveVariants(photo, safeSku, i);
          images.push(localImage(safeSku, i, original[i]?.alt || p.name || p.sku, origin[i]));
          saved++;
          continue;
        } catch (err: any) {
          note({ source: 'catalogo', target: `foto ${i + 1}`, ok: false, detail: `procesador de imágenes: ${err.message}` });
          if (i === 0) return { saved: 0, attempts };
        }
      }
      if (original[i]) images.push(original[i]);
    }
    await pool.query(`UPDATE products SET images = $2::jsonb WHERE id = $1`, [productId, JSON.stringify(images)]);
    return { saved, attempts };
  } finally {
    repairing.delete(productId);
  }
}
