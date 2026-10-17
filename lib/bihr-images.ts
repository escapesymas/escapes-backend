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
 * Solo se sustituyen las fotos que faltan o apuntan al CDN de Bihr; las que ya
 * funcionan (ficheros locales que existen, otras webs) se dejan como están.
 * Devuelve qué se intentó y qué contestó cada fuente, para ver el motivo si no hay foto.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { pool } from '../db.js';
import { fetchRemoteImage, REMOTE_IMAGE_MAX_BYTES } from './remote-image.js';
import { processImage, detectImageType } from './image-sandbox.js';
import { httpGet } from './range-http.js';

export const BIHR_ZIP_BASE = 'https://static.bihr.pro/eBihr/Pictures';
const BIHR_API_BASE = process.env.BIHR_API_BASE || 'https://api.bihr.net';
const ALLOWED_IMAGE_HOSTS = new Set(['api.mybihr.com', 'cdn.mybihr.com', 'bihr.net']);
const BIHR_REDIRECT_HOST = /(^|\.)(bihr\.pro|bihr\.net|mybihr\.com)$/i;
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const SIZES = [800, 400, 200] as const;
const MAX_PHOTOS = 4;
const ZIP_UA = 'EscapesYMas-Bihr-Image-Downloader/4.0';
/** Tiempo máximo de toda la reparación; el proxy del panel corta a los 120 s. */
const REPAIR_BUDGET_MS = 55_000;
const ZIP64 = 0xffffffff;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface RepairAttempt { source: 'catalogo' | 'zip' | 'api'; target: string; ok: boolean; detail: string }
export interface RepairResult { saved: number; attempts: RepairAttempt[] }

const inflateRaw = promisify(zlib.inflateRaw) as (buf: Buffer, opts: zlib.ZlibOptions) => Promise<Buffer>;
const repairing = new Set<number>();

/** Nombre de fichero seguro a partir del SKU (igual que el descargador). */
const safeSkuForFile = (sku: string) => String(sku || '').replace(/[^A-Za-z0-9._-]/g, '_');

/** Cuenta lo que le pasó a una descarga en castellano (fetch solo dice «fetch failed»). */
function explain(err: any): string {
  const code = String(err?.cause?.code || err?.code || '');
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'sin respuesta a tiempo';
  if (code === 'ENOTFOUND') return 'no se encuentra el servidor (DNS)';
  if (code === 'ECONNREFUSED') return 'conexión rechazada';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'conexión cortada por el servidor';
  if (/^UNABLE_TO_(VERIFY|GET)/.test(code)) return `el certificado del servidor no se puede verificar (${code}); no se pudo completar la cadena de certificados`;
  if (/CERT|TLS|SSL/.test(code)) return `error de certificado (${code})`;
  if (err?.message === 'fetch failed') return `fallo de red${code ? ` (${code})` : ''}`;
  return err?.message || String(err);
}

/** Lo que devuelve una fuente tiene que ser una foto de verdad (no una página de error con 200). */
function asPhoto(buf: Buffer): Buffer {
  const type = detectImageType(buf);
  if (type !== 'jpeg' && type !== 'png' && type !== 'webp' && type !== 'gif') throw new Error('la respuesta no es una imagen');
  return buf;
}

// ---------------------------------------------------------------- zip por rangos

export interface ZipEntry { name: string; offset: number; compSize: number; uncompSize: number; crc32: number }
type ByteRange = { start: number; end: number } | { suffix: number };

/**
 * GET con Range. Acepta un 206 que empiece donde se pidió, o un 200 pequeño (que se
 * recorta); un 200 grande es un servidor que ignora Range y no se baja el zip entero.
 * Las redirecciones solo van a hosts de Bihr (o al mismo servidor).
 */
async function rangeFetch(zipUrl: string, range: ByteRange, timeoutMs: number): Promise<Buffer> {
  const header = 'suffix' in range ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end}`;
  const expected = 'suffix' in range ? range.suffix : range.end - range.start + 1;
  let current = zipUrl;
  for (let hop = 0; ; hop++) {
    const r = await httpGet(current, {
      headers: { 'User-Agent': ZIP_UA, Range: header },
      timeoutMs,
      onResponse: (status, headers) => {
        if (REDIRECT_STATUS.has(status)) return 0;
        if (status === 206) {
          if (!('suffix' in range) && Number(/^bytes (\d+)-/.exec(String(headers['content-range'] || ''))?.[1] ?? -1) !== range.start) {
            throw new Error('el servidor devolvió otro trozo del zip');
          }
          return expected + 1024;
        }
        if (status === 200) {
          if (Number(headers['content-length'] || Infinity) > 4 * 1024 * 1024) throw new Error('el servidor no admite Range');
          return 4 * 1024 * 1024;
        }
        throw new Error(`HTTP ${status}`);
      },
    });
    if (REDIRECT_STATUS.has(r.status)) {
      const location = r.headers.location;
      const next = location ? new URL(location, current) : null;
      if (!next || hop >= 3) throw new Error(`redirección ${r.status} sin destino`);
      if (next.host !== new URL(zipUrl).host && !(next.protocol === 'https:' && BIHR_REDIRECT_HOST.test(next.hostname))) {
        throw new Error(`redirección a ${next.host} no permitida`);
      }
      current = next.toString();
      continue;
    }
    if (r.status === 200) {
      return 'suffix' in range ? r.body.subarray(Math.max(0, r.body.length - range.suffix)) : r.body.subarray(range.start, range.end + 1);
    }
    return r.body;
  }
}

/** Lee el directorio central del zip (sin ZIP64) y lista sus ficheros. */
export async function readZipIndex(zipUrl: string, timeouts: { tailMs?: number; directoryMs?: number } = {}): Promise<ZipEntry[]> {
  const tail = await rangeFetch(zipUrl, { suffix: 65536 }, timeouts.tailMs ?? 15_000);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > tail.length) throw new Error('no se encuentra el final del zip');
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdSize === ZIP64 || cdOffset === ZIP64) throw new Error('zip de más de 4 GB (ZIP64), no se puede leer por rangos');
  if (entries === 0 || cdSize === 0) throw new Error('el zip está vacío');
  if (cdSize > 64 * 1024 * 1024) throw new Error('directorio del zip demasiado grande');
  const cd = await rangeFetch(zipUrl, { start: cdOffset, end: cdOffset + cdSize - 1 }, timeouts.directoryMs ?? 25_000);

  // Con más de 65534 ficheros el contador del final vale 0xFFFF y no se puede fiar de él.
  const countKnown = entries !== 0xffff;
  const files: ZipEntry[] = [];
  let i = 0;
  while (i + 46 <= cd.length && (!countKnown || files.length < entries)) {
    if (cd.readUInt32LE(i) !== 0x02014b50) throw new Error('el directorio del zip está dañado');
    const nameLen = cd.readUInt16LE(i + 28);
    const extraLen = cd.readUInt16LE(i + 30);
    const commentLen = cd.readUInt16LE(i + 32);
    files.push({
      name: cd.toString('utf-8', i + 46, i + 46 + nameLen),
      crc32: cd.readUInt32LE(i + 16),
      compSize: cd.readUInt32LE(i + 20),
      uncompSize: cd.readUInt32LE(i + 24),
      offset: cd.readUInt32LE(i + 42),
    });
    i += 46 + nameLen + extraLen + commentLen;
  }
  if (files.length === 0 || (countKnown && files.length !== entries)) throw new Error('el directorio del zip está incompleto');
  return files;
}

/**
 * Descomprime un fichero del zip. Los tamaños son los del directorio central (el local puede
 * venir a 0) y se comprueban contra lo que sale de verdad: nombre, tamaño y CRC.
 */
export async function readZipEntry(zipUrl: string, entry: ZipEntry, timeoutMs = 20_000): Promise<Buffer> {
  if (entry.offset === ZIP64 || entry.compSize === ZIP64 || entry.uncompSize === ZIP64) throw new Error('fichero ZIP64, no admitido');
  if (entry.compSize > REMOTE_IMAGE_MAX_BYTES || entry.uncompSize > REMOTE_IMAGE_MAX_BYTES) throw new Error('imagen demasiado grande');
  const first = await rangeFetch(zipUrl, { start: entry.offset, end: entry.offset + 30 + 512 + entry.compSize - 1 }, timeoutMs);
  if (first.length < 30 || first.readUInt32LE(0) !== 0x04034b50) throw new Error('cabecera local no encontrada (el zip ha cambiado)');
  if (first.readUInt16LE(6) & 1) throw new Error('fichero cifrado');
  const method = first.readUInt16LE(8);
  const nameLen = first.readUInt16LE(26);
  const dataStart = 30 + nameLen + first.readUInt16LE(28);
  if (first.length >= 30 + nameLen && first.toString('utf-8', 30, 30 + nameLen) !== entry.name) {
    throw new Error('el fichero del zip no es el del índice (el zip ha cambiado)');
  }
  let data = first.subarray(dataStart, dataStart + entry.compSize);
  if (data.length < entry.compSize) {
    data = await rangeFetch(zipUrl, { start: entry.offset + dataStart, end: entry.offset + dataStart + entry.compSize - 1 }, timeoutMs);
  }
  let out: Buffer;
  if (method === 0) out = data;
  else if (method === 8) {
    try {
      out = await inflateRaw(data, { maxOutputLength: Math.max(1, Math.min(entry.uncompSize || REMOTE_IMAGE_MAX_BYTES, REMOTE_IMAGE_MAX_BYTES)) });
    } catch (err: any) {
      throw new Error(err?.code === 'ERR_BUFFER_TOO_LARGE' ? 'la foto descomprimida es más grande de lo que dice el zip' : `no se pudo descomprimir (${err?.message})`);
    }
  } else throw new Error(`compresión ${method} no admitida`);
  if (out.length !== entry.uncompSize) throw new Error('el tamaño de la foto no coincide con el del zip');
  const crc = (zlib as any).crc32 as undefined | ((b: Buffer) => number);
  if (typeof crc === 'function' && crc(out) >>> 0 !== entry.crc32 >>> 0) throw new Error('la foto del zip está dañada (CRC)');
  return out;
}

const ZIP_INDEX_TTL_MS = 6 * 3600_000;
const ZIP_INDEX_MAX_CACHED = 8;
const zipIndexCache = new Map<string, { at: number; files: Promise<ZipEntry[]> }>();

/** Índice del zip de una marca, guardado unas horas; solo se guarda si se leyó bien. */
function cachedZipIndex(zipUrl: string, maxAgeMs = ZIP_INDEX_TTL_MS): Promise<ZipEntry[]> {
  const hit = zipIndexCache.get(zipUrl);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.files;
  const entry = { at: Date.now(), files: readZipIndex(zipUrl) };
  zipIndexCache.set(zipUrl, entry);
  entry.files.catch(() => { if (zipIndexCache.get(zipUrl) === entry) zipIndexCache.delete(zipUrl); });
  while (zipIndexCache.size > ZIP_INDEX_MAX_CACHED) zipIndexCache.delete(zipIndexCache.keys().next().value as string);
  return entry.files;
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
let apiTokenRequest: Promise<string> | null = null;

async function requestBihrToken(): Promise<string> {
  const user = process.env.BIHR_USERNAME || '';
  const key = process.env.BIHR_MACKEY || '';
  if (!user || !key) throw new Error('sin credenciales de la API de Bihr');
  const r = await fetch(`${BIHR_API_BASE}/api/v2.1/Authentication/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ UserName: user, PassWord: key }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`autenticación rechazada (HTTP ${r.status})`);
  const d: any = await r.json();
  if (!d?.access_token) throw new Error('autenticación: la API no devolvió token');
  apiToken = { token: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return apiToken.token;
}

function bihrApiToken(): Promise<string> {
  if (apiToken && apiToken.expiresAt > Date.now() + 60_000) return Promise.resolve(apiToken.token);
  if (!apiTokenRequest) apiTokenRequest = requestBihrToken().finally(() => { apiTokenRequest = null; });
  return apiTokenRequest;
}

async function bihrApiImage(code: string, timeoutMs: number, retry = true): Promise<Buffer> {
  const token = await bihrApiToken();
  const r = await fetch(`${BIHR_API_BASE}/api/v2.1/Products/Image/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if ((r.status === 401 || r.status === 403) && retry) {
    r.body?.cancel().catch(() => {});
    apiToken = null; // el token puede haberse revocado antes de caducar
    return bihrApiImage(code, timeoutMs, false);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 200) throw new Error('respuesta demasiado pequeña');
  if (buf.length > REMOTE_IMAGE_MAX_BYTES) throw new Error('imagen demasiado grande');
  return buf;
}

// ---------------------------------------------------------------- guardado

/**
 * Escribe las tres medidas primero en ficheros temporales y solo cuando están todas
 * las pone en su sitio (la de 800, la que ve la ficha, la última). Si algo falla no
 * se queda ningún temporal y los ficheros que ya había no se tocan.
 */
async function saveVariants(photo: Buffer, fileBase: string, index: number, optimizedDir: string): Promise<void> {
  const variants = await Promise.all(SIZES.map(async (size) => ({
    size,
    data: (await processImage(photo, { width: size, fit: 'inside', quality: 85, formats: ['jpeg', 'png', 'webp', 'gif'] })).data,
  })));
  await fs.promises.mkdir(optimizedDir, { recursive: true });
  const staged: { tmp: string; file: string }[] = [];
  try {
    for (const { size, data } of variants) {
      const file = path.join(optimizedDir, `${fileBase}_${index}_${size}.webp`);
      const tmp = `${file}.${randomUUID()}.tmp`;
      await fs.promises.writeFile(tmp, data);
      staged.push({ tmp, file });
    }
    for (const { tmp, file } of [...staged].reverse()) await fs.promises.rename(tmp, file);
  } catch (err) {
    await Promise.all(staged.map(({ tmp }) => fs.promises.unlink(tmp).catch(() => {})));
    throw err;
  }
}

const localImage = (fileBase: string, index: number, alt: string, originalUrl: string) => {
  const base = `/uploads/optimized/${fileBase}_${index}_`;
  return { src: `${base}800.webp`, srcMobile: `${base}400.webp`, srcCardDesktop: `${base}400.webp`, srcCardMobile: `${base}200.webp`, alt, originalUrl };
};

/** URL sin la parte firmada, para mostrarla en el informe. */
const shortUrl = (u: string) => { try { const p = new URL(u); return `${p.host}${p.pathname}`; } catch { return u.slice(0, 80); } };

const imageSrc = (img: any): string => (typeof img === 'string' ? img : img?.src || img?.url || '');

const isBihrRemote = (src: string): boolean => {
  try { const u = new URL(src); return u.protocol === 'https:' && ALLOWED_IMAGE_HOSTS.has(u.hostname); } catch { return false; }
};

/** ¿Esta foto de la ficha hay que traerla de nuevo? Vacía, del CDN de Bihr o un fichero local que no existe. */
function needsPhoto(img: any, uploadsDir: string): boolean {
  const src = imageSrc(img);
  if (!src || isBihrRemote(src)) return true;
  if (src.startsWith('/uploads/')) {
    const file = path.resolve(uploadsDir, '.' + src.slice('/uploads'.length));
    return !file.startsWith(path.resolve(uploadsDir) + path.sep) || !fs.existsSync(file);
  }
  return false;
}

/**
 * Descarga las fotos del producto y reescribe `images` con las copias locales.
 * Si no se consigue ni la primera, la ficha queda como estaba.
 * `zipBase` y `uploadsDir` solo cambian en las pruebas.
 */
export async function repairProductImages(productId: number, opts: { zipBase?: string; uploadsDir?: string } = {}): Promise<RepairResult> {
  if (repairing.has(productId)) throw new Error('Ya se están descargando las fotos de este producto');
  repairing.add(productId);
  try {
    const uploadsDir = opts.uploadsDir || UPLOADS_DIR;
    const optimizedDir = path.join(uploadsDir, 'optimized');
    const deadlineAt = Date.now() + REPAIR_BUDGET_MS;
    /** Tiempo que se le puede dar a la siguiente descarga sin pasarse del total. */
    const budget = (capMs: number): number => {
      const left = deadlineAt - Date.now();
      if (left < 2_000) throw new Error('se acabó el tiempo; vuelve a intentarlo');
      return Math.min(capMs, left);
    };

    const { rows: [p] } = await pool.query(
      `SELECT id, sku, name, brand, supplier_code, part_number, images, images::text AS images_raw FROM products WHERE id = $1`, [productId]);
    if (!p) throw new Error('Producto no encontrado');
    const safeSku = safeSkuForFile(p.sku);
    if (!safeSku) throw new Error('El producto no tiene SKU');
    // Dos SKU distintos pueden dar el mismo nombre de fichero (se cambian los símbolos por «_»).
    const { rows: clash } = await pool.query(
      `SELECT 1 FROM products WHERE id <> $2 AND regexp_replace(sku, '[^A-Za-z0-9._-]', '_', 'g') = $1 LIMIT 1`, [safeSku, productId]);
    const fileBase = clash.length > 0 ? `${safeSku}_id${productId}` : safeSku;

    let current: any = p.images;
    if (typeof current === 'string') { try { current = JSON.parse(current); } catch { /* se queda como texto */ } }
    if (current != null && !Array.isArray(current)) throw new Error('El formato de las fotos de la ficha no es el esperado; no se ha tocado');
    const original: any[] = current || [];

    const attempts: RepairAttempt[] = [];
    const slotCount = Math.min(Math.max(original.length, 1), MAX_PHOTOS);
    const wanted = Array.from({ length: slotCount }, (_, i) => !original[i] || needsPhoto(original[i], uploadsDir));
    if (!wanted.some(Boolean)) {
      return { saved: 0, attempts: [{ source: 'catalogo', target: 'ficha', ok: true, detail: 'la ficha ya tiene fotos locales que existen; no hay nada que descargar' }] };
    }
    const slots: (Buffer | null)[] = wanted.map(() => null);
    const origin: string[] = wanted.map(() => '');
    const note = (a: RepairAttempt) => { attempts.push(a); return a.ok; };

    // 1) URLs de la ficha
    const bihrRedirect = (to: URL) => to.protocol === 'https:' && BIHR_REDIRECT_HOST.test(to.hostname);
    for (let i = 0; i < slotCount; i++) {
      const src = imageSrc(original[i]);
      if (!wanted[i] || !isBihrRemote(src)) continue;
      try {
        slots[i] = asPhoto((await fetchRemoteImage(src, budget(15_000), { allowRedirect: bihrRedirect })).data);
        origin[i] = shortUrl(src);
        note({ source: 'catalogo', target: shortUrl(src), ok: true, detail: `${slots[i]!.length} bytes` });
      } catch (err: any) {
        note({ source: 'catalogo', target: shortUrl(src), ok: false, detail: explain(err) });
      }
    }

    // 2) zip de la marca
    const codes = Array.from(new Set([p.part_number, p.sku, p.supplier_code].map((c) => String(c || '').trim()).filter(Boolean)));
    const missing = () => slots.some((s, i) => wanted[i] && !s);
    if (missing() && p.brand) {
      const zipUrl = `${opts.zipBase || BIHR_ZIP_BASE}/${encodeURIComponent(String(p.brand).trim().toUpperCase())}-pictures.zip`;
      try {
        budget(1);
        const cachedBefore = zipIndexCache.get(zipUrl);
        const cachedAge = cachedBefore ? Date.now() - cachedBefore.at : -1;
        let files = await cachedZipIndex(zipUrl);
        const findCode = (list: ZipEntry[]) => codes.find((c) => zipPhotosFor(list, c).size > 0);
        let code = findCode(files);
        if (!code && cachedAge > 60_000 && cachedAge < ZIP_INDEX_TTL_MS) {
          // El índice es de hace rato: si no está la referencia, se vuelve a leer una vez (como mucho cada minuto).
          files = await cachedZipIndex(zipUrl, 0);
          code = findCode(files);
        }
        note({ source: 'zip', target: shortUrl(zipUrl), ok: true, detail: `${files.length} ficheros en el índice` });
        if (!code) note({ source: 'zip', target: codes.join(', '), ok: false, detail: 'ninguna de las referencias está en el zip' });
        else {
          const photos = zipPhotosFor(files, code);
          for (let i = 0; i < slotCount; i++) {
            const entry = photos.get(i + 1);
            if (slots[i] || !wanted[i] || !entry) continue;
            try {
              slots[i] = asPhoto(await readZipEntry(zipUrl, entry, budget(20_000)));
              origin[i] = `zip:${code}-${i + 1}`;
              note({ source: 'zip', target: entry.name, ok: true, detail: `${slots[i]!.length} bytes` });
            } catch (err: any) {
              if (/ha cambiado/.test(err.message)) zipIndexCache.delete(zipUrl);
              note({ source: 'zip', target: entry.name, ok: false, detail: explain(err) });
            }
          }
        }
      } catch (err: any) {
        note({ source: 'zip', target: shortUrl(zipUrl), ok: false, detail: explain(err) });
      }
    }

    // 3) API de Bihr (una sola foto)
    if (wanted[0] && !slots[0]) {
      for (const code of codes) {
        try {
          slots[0] = asPhoto(await bihrApiImage(code, budget(20_000)));
          origin[0] = `api:${code}`;
          note({ source: 'api', target: code, ok: true, detail: `${slots[0].length} bytes` });
          break;
        } catch (err: any) {
          note({ source: 'api', target: code, ok: false, detail: explain(err) });
          if (/credenciales|autenticación|se acabó el tiempo/.test(err.message)) break;
        }
      }
    }

    // Guardado: si la primera foto hacía falta, es imprescindible; si falla el procesador, la ficha no se toca.
    if (!slots.some(Boolean) || (wanted[0] && !slots[0])) return { saved: 0, attempts };
    const images: any[] = [];
    let saved = 0;
    for (let i = 0; i < Math.max(slotCount, original.length); i++) {
      const photo = slots[i];
      if (photo) {
        try {
          await saveVariants(photo, fileBase, i, optimizedDir);
          images.push(localImage(fileBase, i, original[i]?.alt || p.name || p.sku, origin[i]));
          saved++;
          continue;
        } catch (err: any) {
          note({ source: 'catalogo', target: `foto ${i + 1}`, ok: false, detail: `procesador de imágenes: ${explain(err)}` });
          if (i === 0 && wanted[0]) return { saved: 0, attempts };
        }
      }
      if (original[i]) images.push(original[i]);
    }
    if (saved === 0) return { saved: 0, attempts };
    // Solo se escribe si la ficha no ha cambiado mientras se descargaba (p. ej. otro guardado desde el panel).
    const upd = await pool.query(
      `UPDATE products SET images = $2::jsonb WHERE id = $1 AND images::text IS NOT DISTINCT FROM $3::text`,
      [productId, JSON.stringify(images), p.images_raw ?? null]);
    if (!upd.rowCount) throw new Error('La ficha cambió mientras se descargaban las fotos; vuelve a intentarlo');
    return { saved, attempts };
  } finally {
    repairing.delete(productId);
  }
}
