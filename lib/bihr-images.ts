/**
 * Recupera las fotos de UN producto cuando la ficha solo apunta a URLs remotas
 * de Bihr que no se ven (la tienda enseña «Imagen no disponible») y las deja
 * en /uploads/optimized, como hace el descargador (scripts/download-images-from-zip.ts):
 *
 *   0. los detalles del producto en la API v3 de Bihr (Products/Details): cada foto trae su enlace actual;
 *   1. las URLs del catálogo de Bihr y de la propia ficha (CDN de Bihr, con la cabecera de /api/image-proxy);
 *   2. el zip de fotos de la marca (static.bihr.pro), leyendo solo las partes
 *      que hacen falta con HTTP Range (docs/BIHR_IMAGE_SOURCES.md);
 *   3. la API de Bihr (/Products/Image/{código}).
 *
 * Las fotos se abren en el procesador aislado (lib/image-sandbox.ts), nunca aquí.
 * Solo se sustituyen las fotos que faltan o apuntan al CDN de Bihr; las que ya
 * funcionan (ficheros locales que existen, otras webs) se dejan como están.
 * Devuelve qué se intentó y qué contestó cada fuente, para ver el motivo si no hay foto.
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { pool } from '../db.js';
import { fetchRemoteImage, REMOTE_IMAGE_MAX_BYTES } from './remote-image.js';
import { processImage, detectImageType } from './image-sandbox.js';
import { httpGet } from './range-http.js';
import { urlMatchesCode } from './bihr-catalog-pictures.js';

export const BIHR_ZIP_BASE = 'https://static.bihr.pro/eBihr/Pictures';
const BIHR_API_BASE = process.env.BIHR_API_BASE || 'https://api.bihr.net';
const ALLOWED_IMAGE_HOSTS = new Set(['api.mybihr.com', 'cdn.mybihr.com', 'bihr.net']);
const BIHR_REDIRECT_HOST = /(^|\.)(bihr\.pro|bihr\.net|mybihr\.com)$/i;
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const SIZES = [800, 400, 200] as const;
/** Todas las fotos de cada producto (Adrián, 18/10/2026); el tope solo frena fichas anómalas. */
const MAX_PHOTOS = 20;
const ZIP_UA = 'EscapesYMas-Bihr-Image-Downloader/4.0';
/** Tiempo máximo de toda la reparación; el proxy del panel corta a los 120 s. */
const REPAIR_BUDGET_MS = 55_000;
const ZIP64 = 0xffffffff;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface RepairAttempt { source: 'detalles' | 'catalogo' | 'zip' | 'api'; target: string; ok: boolean; detail: string }
/**
 * `saved`: se guardó alguna foto; `nothing_to_do`: la ficha ya tiene fotos que existen;
 * `not_found`: la fuente funcionó pero no tiene la foto; `error`: alguna fuente falló.
 */
export type RepairOutcome = 'saved' | 'nothing_to_do' | 'not_found' | 'error';
export interface RepairResult {
  saved: number;
  attempts: RepairAttempt[];
  outcome: RepairOutcome;
  /** Con `error`: si falla la propia fuente (red, API, procesador) o solo la foto de este producto. */
  errorScope?: 'product' | 'service';
  /** Con `error`: el intento fallido que lo explica, p. ej. «api: HTTP 500». */
  reason?: string;
}
export type RepairSource = RepairAttempt['source'];
const NOT_IN_ZIP = 'ninguna de las referencias está en el zip';
const NO_BRAND = 'el producto no tiene marca; no se sabe qué zip usar';
/** Respuestas de una fuente que funcionó pero no tiene la foto (no son un fallo). */
const NO_DETAILS_PICTURES = 'Bihr no trae fotos de este producto';
const NOT_FOUND_DETAILS = new Set([NOT_IN_ZIP, NO_BRAND, NO_DETAILS_PICTURES]);

/**
 * Qué significa un intento fallido: `missing` (la fuente funciona pero no tiene la foto), `product`
 * (la foto está pero no sirve: dañada, no es una imagen, el procesador la rechaza) o `service`
 * (falla la propia fuente: red, tiempo, 5xx, 429, autenticación, API en pausa, procesador caído).
 */
export type FailureKind = 'missing' | 'product' | 'service';
const PRODUCT_FAILURE = /^No se pudo descargar la imagen \(400\)$|dañada \(CRC\)|no coincide con el del zip|no se pudo descomprimir|más grande de lo que dice|imagen demasiado grande|la respuesta no es una imagen|fichero cifrado|fichero ZIP64|compresión .* no admitida|Imagen no válida/;
export function failureKind(a: Pick<RepairAttempt, 'source' | 'detail'>): FailureKind {
  if (NOT_FOUND_DETAILS.has(a.detail) || a.detail === 'HTTP 404') return 'missing';
  // El enlace de la ficha o del catálogo ya no existe (fetchRemoteImage dice «(404)»); un 400 es un enlace roto.
  if ((a.source === 'catalogo' || a.source === 'detalles') && /^No se pudo descargar la imagen \((404|410)\)$/.test(a.detail)) return 'missing';
  // La API de Bihr contesta con algo que no es una foto cuando no tiene la de ese producto.
  if (a.source === 'api' && /^(respuesta demasiado pequeña|imagen demasiado grande|la respuesta no es una imagen)$/.test(a.detail)) return 'missing';
  return PRODUCT_FAILURE.test(a.detail) ? 'product' : 'service';
}

const inflateRaw = promisify(zlib.inflateRaw) as (buf: Buffer, opts: zlib.ZlibOptions) => Promise<Buffer>;
const repairing = new Set<number>();

/** Nombre de fichero seguro a partir del SKU (igual que el descargador). */
const safeSkuForFile = (sku: string) => String(sku || '').replace(/[^A-Za-z0-9._-]/g, '_');

/** Cuenta lo que le pasó a una descarga en castellano (fetch solo dice «fetch failed»). */
function explain(err: any): string {
  const code = String(err?.cause?.code || err?.code || err?.errors?.[0]?.code || '');
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'sin respuesta a tiempo';
  if (code === 'ENOTFOUND') return 'no se encuentra el servidor (DNS)';
  if (code === 'ECONNREFUSED') return 'conexión rechazada';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'conexión cortada por el servidor';
  if (/^UNABLE_TO_(VERIFY|GET)/.test(code)) return `el certificado del servidor no se puede verificar (${code}); no se pudo completar la cadena de certificados`;
  if (/CERT|TLS|SSL/.test(code)) return `error de certificado (${code})`;
  if (err?.message === 'fetch failed' || err instanceof AggregateError) return `fallo de red${code ? ` (${code})` : ''}`;
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
      const origin = new URL(zipUrl);
      const bihrHost = next.protocol === 'https:' && BIHR_REDIRECT_HOST.test(next.hostname);
      if ((origin.protocol === 'https:' && next.protocol !== 'https:') || (next.host !== origin.host && !bihrHost)) {
        throw new Error(`redirección a ${next.protocol}//${next.host} no permitida`);
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
/** Una marca sin zip (HTTP 404) no se vuelve a pedir en unos minutos: con miles de productos serían miles de 404. */
const ZIP_MISSING_TTL_MS = 10 * 60_000;
const zipIndexCache = new Map<string, { at: number; files: Promise<ZipEntry[]>; missing?: boolean }>();

/** Índice del zip de una marca, guardado unas horas; solo se guarda si se leyó bien (o si no existe). */
function cachedZipIndex(zipUrl: string, maxAgeMs = ZIP_INDEX_TTL_MS): Promise<ZipEntry[]> {
  const hit = zipIndexCache.get(zipUrl);
  if (hit && Date.now() - hit.at < Math.min(maxAgeMs, hit.missing ? ZIP_MISSING_TTL_MS : Infinity)) return hit.files;
  const entry: { at: number; files: Promise<ZipEntry[]>; missing?: boolean } = { at: Date.now(), files: readZipIndex(zipUrl) };
  zipIndexCache.set(zipUrl, entry);
  entry.files.catch((err) => {
    if (err?.message === 'HTTP 404') entry.missing = true;
    else if (zipIndexCache.get(zipUrl) === entry) zipIndexCache.delete(zipUrl);
  });
  while (zipIndexCache.size > ZIP_INDEX_MAX_CACHED) zipIndexCache.delete(zipIndexCache.keys().next().value as string);
  return entry.files;
}

/** Índice <código en minúsculas> → fotos por número, de un listado de zip (se calcula una vez por listado). */
const photosByCode = new WeakMap<ZipEntry[], Map<string, Map<number, ZipEntry>>>();

function zipLookup(files: ZipEntry[]): Map<string, Map<number, ZipEntry>> {
  let index = photosByCode.get(files);
  if (index) return index;
  index = new Map();
  for (const f of files) {
    const m = /^(.+)-(\d+)\.jpe?g$/i.exec(f.name.split('/').pop() || '');
    if (!m) continue;
    const n = Number(m[2]);
    if (!(n >= 1)) continue;
    const key = m[1].toLowerCase();
    let photos = index.get(key);
    if (!photos) index.set(key, (photos = new Map()));
    if (!photos.has(n)) photos.set(n, f);
  }
  photosByCode.set(files, index);
  return index;
}

/** Fotos <código>-1.jpg, -2.jpg… del zip, por número. */
export function zipPhotosFor(files: ZipEntry[], partNumber: string): Map<number, ZipEntry> {
  return new Map(zipLookup(files).get(partNumber.toLowerCase()) || []);
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

/**
 * La API de Bihr limita las peticiones a 1 por segundo y servicio (429 si van más seguidas): todas las
 * llamadas del proceso salen de una en una, con algo más de un segundo entre una y otra.
 */
const API_MIN_GAP_MS = 1_100;
let apiChain: Promise<void> = Promise.resolve();
let apiLastCallAt = 0;

async function apiGate(): Promise<void> {
  const previous = apiChain;
  let release!: () => void;
  apiChain = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const wait = apiLastCallAt + API_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    apiLastCallAt = Date.now();
  } finally {
    release();
  }
}

/**
 * Tras 5 fallos seguidos (red, 5xx, 429, autenticación) la API se deja en paz 5 minutos. Un 404 no es un fallo
 * («no tengo esa foto») y, como un 200, demuestra que la API responde: reinicia la cuenta.
 */
const API_FAILURE_LIMIT = 5;
const API_PAUSE_MS = 5 * 60_000;
let apiFailures = 0;
let apiPausedUntil = 0;
const apiFailed = () => { if (++apiFailures >= API_FAILURE_LIMIT) apiPausedUntil = Date.now() + API_PAUSE_MS; };

/**
 * Llamada a la API de Bihr con token, ritmo (apiGate), reintento si el token está revocado, espera si hay 429 y
 * la cuenta de fallos seguidos. Devuelve la respuesta sea cual sea su código: quien llama lee el cuerpo o lo cancela.
 */
async function bihrApiFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, timeoutMs: number, retry = true, backoff = 0): Promise<Response> {
  if (apiPausedUntil) {
    if (apiPausedUntil > Date.now()) throw new Error('la API de Bihr no responde bien; se vuelve a probar en unos minutos');
    apiPausedUntil = 0; // pasó la pausa: vuelve a tener sus cinco intentos
    apiFailures = 0;
  }
  let token: string;
  try {
    token = await bihrApiToken();
  } catch (err) {
    apiFailed(); // sin esto cada producto pediría un token nuevo aunque Bihr rechace el acceso
    throw err;
  }
  await apiGate();
  let r: Response;
  try {
    r = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    apiFailed();
    throw err;
  }
  if ((r.status === 401 || r.status === 403) && retry) {
    r.body?.cancel().catch(() => {});
    apiToken = null; // el token puede haberse revocado antes de caducar
    return bihrApiFetch(url, init, timeoutMs, false, backoff);
  }
  if (r.status === 429 && backoff < 3) {
    r.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** backoff));
    return bihrApiFetch(url, init, timeoutMs, retry, backoff + 1);
  }
  if (r.ok || r.status === 404) apiFailures = 0;
  else apiFailed();
  return r;
}

async function bihrApiImage(code: string, timeoutMs: number): Promise<Buffer> {
  const r = await bihrApiFetch(`${BIHR_API_BASE}/api/v2.1/Products/Image/${encodeURIComponent(code)}`, {}, timeoutMs);
  if (!r.ok) {
    r.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${r.status}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 200) throw new Error('respuesta demasiado pequeña');
  if (buf.length > REMOTE_IMAGE_MAX_BYTES) throw new Error('imagen demasiado grande');
  return buf;
}

/**
 * Fotos de los productos según `Products/Details` de la API v3 de Bihr: cada foto con su propio enlace
 * (el `context` firmado lleva la ruta del fichero). Devuelve, por código (en minúsculas), los enlaces de sus
 * fotos con la principal primero. Solo se aceptan los de dominios de Bihr cuyo fichero lleve el código del producto.
 */
export async function bihrProductPictures(partNumbers: readonly string[], timeoutMs = 20_000): Promise<Map<string, string[]>> {
  const requested = Array.from(new Set(partNumbers.map((c) => String(c || '').trim()).filter(Boolean)));
  const found = new Map<string, string[]>();
  if (requested.length === 0) return found;
  const wanted = new Set(requested.map((c) => c.toLowerCase()));
  const r = await bihrApiFetch(`${BIHR_API_BASE}/api/v3/Products/Details`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ productCriteria: requested.map((partNumber) => ({ partNumber })), language: 'es' }),
  }, timeoutMs);
  if (r.status === 404) { r.body?.cancel().catch(() => {}); return found; }
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`HTTP ${r.status}${text ? `: ${text}` : ''}`);
  }
  let data: any;
  try { data = await r.json(); } catch { throw new Error('Products/Details: la respuesta no es JSON'); }
  // La documentación enseña un producto; con varios códigos puede venir una lista, suelta o dentro de un objeto.
  const wrapped = data && typeof data === 'object' && !Array.isArray(data) && !('partNumber' in data)
    ? Object.values(data).find((v) => Array.isArray(v)) as any[] | undefined : undefined;
  const items: any[] = Array.isArray(data) ? data : wrapped ? wrapped : data && typeof data === 'object' ? [data] : [];
  for (const item of items) {
    const codes = [item?.partNumber, item?.oldPartNumber].map((c) => String(c ?? '').trim()).filter(Boolean);
    const pictures: any[] = Array.isArray(item?.pictures) ? item.pictures : [];
    const ordered = [...pictures.filter((p) => p?.isDefault), ...pictures.filter((p) => !p?.isDefault)];
    const urls: string[] = [];
    for (const pic of ordered) {
      const url = typeof pic?.url === 'string' ? pic.url.trim() : '';
      if (url && isBihrRemote(url) && codes.some((c) => urlMatchesCode(url, c)) && !urls.includes(url)) urls.push(url);
    }
    if (urls.length === 0) continue;
    for (const c of codes) if (wanted.has(c.toLowerCase()) && !found.has(c.toLowerCase())) found.set(c.toLowerCase(), urls);
  }
  return found;
}

// ---------------------------------------------------------------- guardado

/**
 * Escribe las tres medidas primero en ficheros temporales y solo cuando están todas
 * las pone en su sitio (la de 800, la que ve la ficha, la última). Si algo falla no
 * se queda ningún temporal y los ficheros que ya había no se tocan.
 */
async function saveVariants(photo: Buffer, fileBase: string, index: number, optimizedDir: string): Promise<void> {
  // La foto de fuera solo se abre una vez, en el procesador aislado (la de 800). Las de 400 y 200 se sacan aquí
  // de esa WebP, que ya está limpia y sin metadatos (sharp en el backend vale para lo que ya pasó por el
  // procesador). Antes eran tres procesos por foto y la descarga en bloque iba a la mitad o menos con 2 núcleos.
  const largest = await processImage(photo, { width: SIZES[0], fit: 'inside', quality: 85, formats: ['jpeg', 'png', 'webp', 'gif'] });
  const variants: { size: number; data: Buffer }[] = [{ size: SIZES[0], data: largest.data }];
  for (const size of SIZES.slice(1)) {
    const data = await sharp(largest.data, { failOn: 'error', animated: false })
      .resize({ width: size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85, effort: 2 })
      .toBuffer();
    variants.push({ size, data });
  }
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

export interface RepairOptions {
  /** Solo cambian en las pruebas. */
  zipBase?: string;
  uploadsDir?: string;
  /** Fuentes que se prueban (todas por defecto, en este orden: catálogo, zip, API). */
  sources?: readonly RepairSource[];
  /**
   * Usa solo el número de pieza y el SKU (que son la referencia de Bihr) y no el código del
   * fabricante, que en la API de Bihr puede dar la foto de otra pieza con ese mismo número.
   */
  exactCodes?: boolean;
  /**
   * Nombres de fichero que comparten varios productos (ver `contestedFileBases`): evita una
   * consulta por producto cuando se reparan muchos seguidos.
   */
  contested?: ReadonlySet<string>;
  /**
   * SKU → enlace actual de la foto principal en el catálogo de Bihr (lib/bihr-catalog-pictures.ts).
   * Se prueba antes que el enlace guardado en la ficha, que puede haber caducado.
   */
  catalogUrls?: ReadonlyMap<string, string>;
  /**
   * Enlaces de las fotos del producto en Products/Details de Bihr, por orden, a partir de sus códigos
   * (número de pieza y SKU). Por defecto una llamada a la API por producto; el trabajo en bloque pide
   * varios productos en una sola llamada.
   */
  detailsLookup?: (codes: string[]) => Promise<readonly string[]>;
  /**
   * Si la referencia no está en un índice del zip de hace más de un minuto, se vuelve a leer el índice
   * (por defecto sí). El trabajo en bloque lo desactiva: con miles de productos repetiría la lectura cada minuto.
   */
  refreshStaleIndex?: boolean;
}

/**
 * Nombres de fichero (SKU saneado) que dan dos o más productos. Una sola consulta que recorre
 * la tabla: para un trabajo en bloque, en lugar de una comprobación por producto.
 */
export async function contestedFileBases(): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT regexp_replace(sku, '[^A-Za-z0-9._-]', '_', 'g') AS base FROM products
     WHERE sku IS NOT NULL GROUP BY 1 HAVING count(*) > 1`);
  return new Set(rows.map((r: any) => String(r.base)));
}

/**
 * Descarga las fotos del producto y reescribe `images` con las copias locales.
 * Si no se consigue ni la primera, la ficha queda como estaba.
 */
export async function repairProductImages(productId: number, opts: RepairOptions = {}): Promise<RepairResult> {
  if (repairing.has(productId)) throw new Error('Ya se están descargando las fotos de este producto');
  repairing.add(productId);
  try {
    const uploadsDir = opts.uploadsDir || UPLOADS_DIR;
    const optimizedDir = path.join(uploadsDir, 'optimized');
    const useSource = (source: RepairSource) => !opts.sources || opts.sources.includes(source);
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
    const clashes = opts.contested
      ? opts.contested.has(safeSku)
      : (await pool.query(
        `SELECT 1 FROM products WHERE id <> $2 AND regexp_replace(sku, '[^A-Za-z0-9._-]', '_', 'g') = $1 LIMIT 1`, [safeSku, productId])).rows.length > 0;
    const fileBase = clashes ? `${safeSku}_id${productId}` : safeSku;

    let current: any = p.images;
    if (typeof current === 'string') { try { current = JSON.parse(current); } catch { /* se queda como texto */ } }
    if (current != null && !Array.isArray(current)) throw new Error('El formato de las fotos de la ficha no es el esperado; no se ha tocado');
    const original: any[] = current || [];

    const attempts: RepairAttempt[] = [];
    const slotCount = Math.min(Math.max(original.length, 1), MAX_PHOTOS);
    const wanted = Array.from({ length: slotCount }, (_, i) => !original[i] || needsPhoto(original[i], uploadsDir));
    if (!wanted.some(Boolean)) {
      return { saved: 0, outcome: 'nothing_to_do', attempts: [{ source: 'catalogo', target: 'ficha', ok: true, detail: 'la ficha ya tiene fotos locales que existen; no hay nada que descargar' }] };
    }
    const slots: (Buffer | null)[] = wanted.map(() => null);
    const origin: string[] = wanted.map(() => '');
    const note = (a: RepairAttempt) => { attempts.push(a); return a.ok; };
    // «Error» es que algo falló (red, API, zip dañado, procesador); que la fuente no tenga la foto no lo es.
    const none = (): RepairResult => {
      const failed = attempts.filter((a) => !a.ok).map((a) => ({ a, kind: failureKind(a) })).filter((x) => x.kind !== 'missing');
      if (failed.length === 0) return { saved: 0, attempts, outcome: 'not_found' };
      const worst = failed.find((x) => x.kind === 'service') || failed[failed.length - 1];
      return { saved: 0, attempts, outcome: 'error', errorScope: worst.kind === 'service' ? 'service' : 'product', reason: `${worst.a.source}: ${worst.a.detail}` };
    };

    // 0) Detalles del producto en la API v3 de Bihr: cada foto con su enlace actual
    const bihrRedirect = (to: URL) => to.protocol === 'https:' && BIHR_REDIRECT_HOST.test(to.hostname);
    const codes = Array.from(new Set((opts.exactCodes ? [p.part_number, p.sku] : [p.part_number, p.sku, p.supplier_code])
      .map((c) => String(c || '').trim()).filter(Boolean)));
    if (useSource('detalles') && wanted.some(Boolean)) {
      try {
        const lookup = opts.detailsLookup || (async (cs: string[]) => {
          const found = await bihrProductPictures(cs, budget(20_000));
          for (const c of cs) { const urls = found.get(c.toLowerCase()); if (urls?.length) return urls; }
          return [];
        });
        const urls = await lookup(codes);
        if (urls.length === 0) note({ source: 'detalles', target: 'Products/Details', ok: false, detail: NO_DETAILS_PICTURES });
        for (let i = 0; i < slotCount; i++) {
          const url = urls[i];
          if (!wanted[i] || !url || !isBihrRemote(url)) continue;
          try {
            slots[i] = asPhoto((await fetchRemoteImage(url, budget(15_000), { allowRedirect: bihrRedirect })).data);
            origin[i] = shortUrl(url);
            note({ source: 'detalles', target: shortUrl(url), ok: true, detail: `${slots[i]!.length} bytes` });
          } catch (err: any) {
            note({ source: 'detalles', target: shortUrl(url), ok: false, detail: explain(err) });
          }
        }
      } catch (err: any) {
        note({ source: 'detalles', target: 'Products/Details', ok: false, detail: explain(err) });
      }
    }

    // 1) Enlaces del catálogo de Bihr y de la ficha
    for (let i = 0; i < slotCount; i++) {
      if (!useSource('catalogo') || !wanted[i] || slots[i]) continue;
      const stored = imageSrc(original[i]);
      const candidates: { url: string; label: string }[] = [];
      const fresh = i === 0 ? opts.catalogUrls?.get(String(p.sku).trim()) : undefined;
      if (fresh && isBihrRemote(fresh)) candidates.push({ url: fresh, label: 'catálogo de Bihr' });
      if (isBihrRemote(stored) && stored !== fresh) candidates.push({ url: stored, label: 'ficha' });
      for (const { url, label } of candidates) {
        try {
          slots[i] = asPhoto((await fetchRemoteImage(url, budget(15_000), { allowRedirect: bihrRedirect })).data);
          origin[i] = shortUrl(url);
          note({ source: 'catalogo', target: `${shortUrl(url)} (${label})`, ok: true, detail: `${slots[i]!.length} bytes` });
          break;
        } catch (err: any) {
          note({ source: 'catalogo', target: `${shortUrl(url)} (${label})`, ok: false, detail: explain(err) });
        }
      }
    }

    // 2) zip de la marca
    const missing = () => slots.some((s, i) => wanted[i] && !s);
    if (useSource('zip') && missing() && !p.brand) note({ source: 'zip', target: 'marca', ok: false, detail: NO_BRAND });
    if (useSource('zip') && missing() && p.brand) {
      const zipUrl = `${opts.zipBase || BIHR_ZIP_BASE}/${encodeURIComponent(String(p.brand).trim().toUpperCase())}-pictures.zip`;
      try {
        budget(1);
        const cachedBefore = zipIndexCache.get(zipUrl);
        const cachedAge = cachedBefore ? Date.now() - cachedBefore.at : -1;
        let files = await cachedZipIndex(zipUrl);
        const findCode = (list: ZipEntry[]) => codes.find((c) => zipPhotosFor(list, c).size > 0);
        let code = findCode(files);
        if (!code && opts.refreshStaleIndex !== false && cachedAge > 60_000 && cachedAge < ZIP_INDEX_TTL_MS) {
          // El índice es de hace rato: si no está la referencia, se vuelve a leer una vez (como mucho cada minuto).
          files = await cachedZipIndex(zipUrl, 0);
          code = findCode(files);
        }
        note({ source: 'zip', target: shortUrl(zipUrl), ok: true, detail: `${files.length} ficheros en el índice` });
        if (!code) note({ source: 'zip', target: codes.join(', '), ok: false, detail: NOT_IN_ZIP });
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
    if (useSource('api') && wanted[0] && !slots[0]) {
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
    if (!slots.some(Boolean) || (wanted[0] && !slots[0])) return none();
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
          if (i === 0 && wanted[0]) return none();
        }
      }
      if (original[i]) images.push(original[i]);
    }
    if (saved === 0) return none();
    // Solo se escribe si la ficha no ha cambiado mientras se descargaba (p. ej. otro guardado desde el panel).
    const upd = await pool.query(
      `UPDATE products SET images = $2::jsonb WHERE id = $1 AND images::text IS NOT DISTINCT FROM $3::text`,
      [productId, JSON.stringify(images), p.images_raw ?? null]);
    if (!upd.rowCount) throw new Error('La ficha cambió mientras se descargaban las fotos; vuelve a intentarlo');
    return { saved, attempts, outcome: 'saved' };
  } finally {
    repairing.delete(productId);
  }
}
