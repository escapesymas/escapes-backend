import 'dotenv/config';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db.js';

const DEFAULT_BATCH = 50;
const DEFAULT_CONCURRENCY = 4;
const SIZES = [800, 400, 200] as const;
const OPTIMIZED_DIR = '/app/server/uploads/optimized';
const CSV_DIR_DEFAULT = '/app/server/uploads/catalog-csv';
const CSV_DIR_FALLBACK = '/app/server/catalog-csv';
const ZIP_BASE = 'https://static.bihr.pro/eBihr/Pictures';
const ZIP_INDEX_CACHE = '/app/server/uploads/bihr-zip-index.json'; // { brand → { totalSize, cdOffset, cdSize, files: [{name, offset, compSize}] } }
const BIHR_API_BASE = process.env.BIHR_API_BASE || 'https://api.bihr.net';
const BIHR_USERNAME = process.env.BIHR_USERNAME || '';
const BIHR_MACKEY = process.env.BIHR_MACKEY || '';

interface CliOptions {
  batch: number;
  concurrency: number;
  csvDir: string;
  loopAll: boolean;
  recheckFiles: boolean;
}

interface ProductRow {
  id: number;
  sku: string;
  supplier_code: string;
  images: unknown;
  name: string | null;
}

interface ImageRecord {
  src: string;
  srcMobile: string;
  srcCardDesktop: string;
  srcCardMobile: string;
  alt: string;
  originalUrl: string;
}

interface ZipEntry {
  name: string;
  offset: number;
  compSize: number;
  uncompSize: number;
}

interface BrandIndex {
  brand: string;
  totalSize: number;
  files: ZipEntry[];
}

function resolveCsvDir(): string {
  for (const dir of [CSV_DIR_DEFAULT, CSV_DIR_FALLBACK]) {
    try {
      if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.csv'))) return dir;
    } catch {}
  }
  return CSV_DIR_DEFAULT;
}

function parseArgs(args: string[]): CliOptions {
  let batch = DEFAULT_BATCH;
  let concurrency = DEFAULT_CONCURRENCY;
  let csvDir = CSV_DIR_DEFAULT;
  let loopAll = false;
  let recheckFiles = false;
  for (const arg of args) {
    if (arg.startsWith('--batch=')) batch = parseInt(arg.slice(8), 10);
    else if (arg.startsWith('--concurrency=')) concurrency = parseInt(arg.slice(14), 10);
    else if (arg.startsWith('--csv-dir=')) csvDir = arg.slice(10);
    else if (arg === '--all') loopAll = true;
    else if (arg === '--recheck-files') recheckFiles = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (batch <= 0 || concurrency <= 0) throw new Error('batch and concurrency must be positive');
  return { batch, concurrency, csvDir, loopAll, recheckFiles };
}

function sanitizeSku(sku: string | null | undefined): string {
  if (!sku) return '';
  return String(sku).replace(/[^A-Za-z0-9._-]/g, '_');
}

function brandFromCsvFilename(filename: string): string {
  // cat-extended-full-ES01-ES001-es-2026_08_09_00_15_02_<BRAND>.csv
  // The year is preceded by '-' (e.g. 'es-2026'), not '_'. Match the timestamp
  // block without requiring a leading underscore.
  const stem = filename.replace(/\.csv$/, '');
  const m = stem.match(/(?:^|[^_\d])(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(.+)$/);
  return m ? m[7] : stem;
}

// Self-log to /app/server/uploads/image-dl-v5-self.log — bypasses the parent's
// pipe tee which can drop output if the parent process restarts.
const SELF_LOG = '/app/server/uploads/image-dl-v5-self.log';
function selfLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    require('node:fs').appendFileSync(SELF_LOG, line);
  } catch {}
  // Also keep stdout for parent pipe
  console.log(msg);
}

/** Build sku → image URL map, sku → brand (for the zip), and
 *  any-key → CSV PartNumber (Bihr's internal SKU, used in zip filenames).
 *  The products table stores our internal `sku` and the human-readable
 *  `supplier_code`, neither of which match the zip filenames; only the
 *  CSV's PartNumber does. We index by all three so the downloader can
 *  resolve any product to the right zip entry. */
async function loadCatalogMap(csvDir: string): Promise<{
  urlMap: Map<string, { url: string; brand: string }>;
  skuMap: Map<string, { brand: string }>;
  partMap: Map<string, { brand: string; partNumber: string }>;
}> {
  const finalDir = existsSync(csvDir) && readdirSync(csvDir).some((f) => f.endsWith('.csv'))
    ? csvDir : resolveCsvDir();
  console.log(`[CATALOG] Reading CSVs from ${finalDir}`);
  const files = (await readdir(finalDir)).filter((f) => f.endsWith('.csv'));
  console.log(`[CATALOG] ${files.length} CSV files`);

  const urlMap = new Map<string, { url: string; brand: string }>();
  const skuMap = new Map<string, { brand: string }>();
  const partMap = new Map<string, { brand: string; partNumber: string }>();

  // Simple per-line parser that handles quoted fields with commas/newlines.
  const parseCsv = (text: string): string[][] => {
    const rows: string[][] = [];
    let current: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else field += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { current.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          current.push(field); field = '';
          if (current.some((v) => v !== '')) rows.push(current);
          current = [];
        } else field += ch;
      }
    }
    if (field !== '' || current.length > 0) {
      current.push(field);
      if (current.some((v) => v !== '')) rows.push(current);
    }
    return rows;
  };

  for (const file of files) {
    const brand = brandFromCsvFilename(file);
    const text = await (await import('node:fs/promises')).readFile(path.join(finalDir, file), 'utf-8');
    const rows = parseCsv(text);
    if (rows.length < 2) continue;
    const header = rows[0];
    const partIdx = header.indexOf('PartNumber');
    const picIdx = header.indexOf('Picture1');
    const supIdx = header.indexOf('SupplierProductCode');
    const oldIdx = header.indexOf('OldPartNumber');
    if (partIdx === -1 || picIdx === -1) continue;

    let rowsAdded = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const part = (r[partIdx] || '').trim();
      const pic = (r[picIdx] || '').trim();
      const sup = supIdx !== -1 ? (r[supIdx] || '').trim() : '';
      const old = oldIdx !== -1 ? (r[oldIdx] || '').trim() : '';
      if (part && pic && !urlMap.has(part)) {
        urlMap.set(part, { url: pic, brand });
        skuMap.set(part, { brand });
        partMap.set(part, { brand, partNumber: part });
        rowsAdded++;
      }
      // Index by every alias we know about so product lookup (by sku or
      // supplier_code) resolves to the CSV's PartNumber (zip filename stem).
      for (const alias of [sup, old]) {
        if (alias && pic && !urlMap.has(alias)) {
          urlMap.set(alias, { url: pic, brand });
        }
        if (alias) {
          skuMap.set(alias, { brand });
          partMap.set(alias, { brand, partNumber: part });
        }
      }
    }
  }

  console.log(`[CATALOG] urlMap size: ${urlMap.size}, skuMap size: ${skuMap.size}, partMap size: ${partMap.size}`);
  return { urlMap, skuMap, partMap };
}

/** Read index from disk cache, or build it. */
async function loadBrandIndex(brand: string): Promise<BrandIndex> {
  let cache: Record<string, BrandIndex> = {};
  if (existsSync(ZIP_INDEX_CACHE)) {
    try {
      cache = JSON.parse(await (await import('node:fs/promises')).readFile(ZIP_INDEX_CACHE, 'utf-8'));
    } catch {}
  }
  if (cache[brand] && cache[brand].files.length > 0) {
    return cache[brand];
  }

  console.log(`[ZIP] Building index for brand ${brand}...`);
  const zipUrl = `${ZIP_BASE}/${encodeURIComponent(brand)}-pictures.zip`;
  // First fetch the last 64KB to find EOCD
  const tailResp = await fetch(zipUrl, {
    headers: {
      'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
      Range: 'bytes=-65536',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!tailResp.ok && tailResp.status !== 206) {
    throw new Error(`Failed to fetch zip tail for ${brand}: HTTP ${tailResp.status}`);
  }
  const tail = Buffer.from(await tailResp.arrayBuffer());
  const eocdIdx = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdIdx < 0) throw new Error(`EOCD not found in tail of ${brand} zip`);
  // EOCD: 4 sig + 2 disk + 2 cd_disk + 2 entries_disk + 2 entries_total + 4 cd_size + 4 cd_offset + 2 comment_len
  const cdEntries = tail.readUInt16LE(eocdIdx + 10);
  const cdSize = tail.readUInt32LE(eocdIdx + 12);
  const cdOffset = tail.readUInt32LE(eocdIdx + 16);
  // Total size = cdOffset + cdSize (assuming no zip64)
  const totalSize = cdOffset + cdSize;

  // Fetch the central directory
  const cdResp = await fetch(zipUrl, {
    headers: {
      'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
      Range: `bytes=${cdOffset}-${totalSize - 1}`,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!cdResp.ok && cdResp.status !== 206) {
    throw new Error(`Failed to fetch central directory: HTTP ${cdResp.status}`);
  }
  const cd = Buffer.from(await cdResp.arrayBuffer());

  const files: ZipEntry[] = [];
  let i = 0;
  while (i < cd.length - 46 && files.length < cdEntries) {
    if (cd.readUInt32LE(i) !== 0x02014b50) {
      // Find next PK\x01\x02
      const next = cd.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i + 1);
      if (next < 0) break;
      i = next;
      continue;
    }
    const compSize = cd.readUInt32LE(i + 20);
    const uncompSize = cd.readUInt32LE(i + 24);
    const fnameLen = cd.readUInt16LE(i + 28);
    const extraLen = cd.readUInt16LE(i + 30);
    const commentLen = cd.readUInt16LE(i + 32);
    const localOffset = cd.readUInt32LE(i + 42);
    const name = cd.toString('utf-8', i + 46, i + 46 + fnameLen);
    files.push({ name, offset: localOffset, compSize, uncompSize });
    i += 46 + fnameLen + extraLen + commentLen;
  }

  cache[brand] = { brand, totalSize, files };
  await writeFile(ZIP_INDEX_CACHE, JSON.stringify(cache));
  console.log(`[ZIP] Brand ${brand}: ${files.length} files indexed`);
  return cache[brand];
}

async function fetchImageFromZip(brand: string, sku: string, index: BrandIndex): Promise<Buffer | null> {
  // Find <sku>-N.jpg files (prefer -1)
  const matches = index.files.filter((f) => f.name.startsWith(`${sku}-`) && f.name.endsWith('.jpg'));
  if (matches.length === 0) return null;
  // Sort to prefer -1, then -2, etc.
  matches.sort((a, b) => {
    const aNum = parseInt(a.name.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
    const bNum = parseInt(b.name.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
    return aNum - bNum;
  });
  const entry = matches[0];

  const zipUrl = `${ZIP_BASE}/${encodeURIComponent(brand)}-pictures.zip`;
  // Fetch local file header (30 bytes) + filename + extra + compressed data
  // Start 50 bytes before the local offset to handle header variations
  const startByte = Math.max(0, entry.offset - 50);
  const endByte = entry.offset + 30 + 256 + entry.compSize; // 256 = max filename+extra
  const rangeResp = await fetch(zipUrl, {
    headers: {
      'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
      Range: `bytes=${startByte}-${endByte}`,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!rangeResp.ok && rangeResp.status !== 206) {
    throw new Error(`Range fetch failed: HTTP ${rangeResp.status}`);
  }
  const buf = Buffer.from(await rangeResp.arrayBuffer());
  if (rangeResp.status !== 206) {
    throw new Error(`Range request ignored: got HTTP ${rangeResp.status} (expected 206 Partial Content). Response size=${buf.length}, expected=${endByte - startByte + 1}`);
  }
  // Local file header should be at offset (entry.offset - startByte) since we asked for that range.
  const expectedLfhOffset = entry.offset - startByte;
  const PK_0304 = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let lfhIdx = buf.indexOf(PK_0304, expectedLfhOffset);
  if (lfhIdx < 0) {
    // Fall back to anywhere in buffer (server may have shifted us)
    lfhIdx = buf.indexOf(PK_0304);
  }
  if (lfhIdx < 0) throw new Error('Local file header not found in response');
  // LFH: 4 sig + 2 ver + 2 flags + 2 compression + 2 mod_time + 2 mod_date + 4 crc + 4 comp + 4 uncomp + 2 fname_len + 2 extra_len = 30
  const method = buf.readUInt16LE(lfhIdx + 8);     // 0=stored, 8=deflate
  const fnameLen = buf.readUInt16LE(lfhIdx + 26);
  const extraLen = buf.readUInt16LE(lfhIdx + 28);
  const actualCompSize = buf.readUInt32LE(lfhIdx + 18);
  const actualUncompSize = buf.readUInt32LE(lfhIdx + 22);
  const dataStart = lfhIdx + 30 + fnameLen + extraLen;

  // For method=0 (stored) the data is uncompressed, so actualCompSize == actualUncompSize
  // and we just return the bytes directly.
  if (method === 0) {
    if (buf.length >= dataStart + actualCompSize) {
      return buf.subarray(dataStart, dataStart + actualCompSize);
    }
    // Re-fetch exact bytes
    const newResp = await fetch(zipUrl, {
      headers: {
        'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
        Range: `bytes=${entry.offset + 30 + fnameLen + extraLen}-${entry.offset + 30 + fnameLen + extraLen + actualCompSize - 1}`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!newResp.ok && newResp.status !== 206) throw new Error(`Re-fetch failed: HTTP ${newResp.status}`);
    return Buffer.from(await newResp.arrayBuffer());
  }

  // method=8 (deflate) — raw deflate in zip, so use inflateRawSync (NOT inflateSync
  // which expects the 2-byte zlib header + adler32 checksum).
  if (buf.length < dataStart + actualCompSize) {
    const newEnd = entry.offset + 30 + fnameLen + extraLen + actualCompSize - 1;
    const newResp = await fetch(zipUrl, {
      headers: {
        'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/4.0',
        Range: `bytes=${entry.offset + 30 + fnameLen + extraLen}-${newEnd}`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!newResp.ok && newResp.status !== 206) throw new Error(`Re-fetch failed: HTTP ${newResp.status}`);
    const compressed = Buffer.from(await newResp.arrayBuffer());
    return zlib.inflateRawSync(compressed);
  }
  const compressed = buf.subarray(dataStart, dataStart + actualCompSize);
  try {
    return zlib.inflateRawSync(compressed);
  } catch (inflateErr: any) {
    const detail = {
      brand,
      sku,
      method,
      actualCompSize,
      actualUncompSize,
      bufLen: buf.length,
      dataStart,
      first16: compressed.subarray(0, Math.min(16, compressed.length)).toString('hex'),
      last16: compressed.subarray(Math.max(0, compressed.length - 16)).toString('hex'),
      status: rangeResp.status,
    };
    selfLog(`INFLATE FAIL: ${JSON.stringify(detail)}`);
    throw new Error(`inflate failed (${inflateErr.message}): ${JSON.stringify(detail)}`);
  }
}

async function writeVariants(image: Buffer, safeSku: string): Promise<void> {
  const variants = await Promise.all(
    SIZES.map(async (size) => ({
      size,
      data: await sharp(image)
        .resize({ width: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85, effort: 4 })
        .toBuffer(),
    })),
  );
  await mkdir(OPTIMIZED_DIR, { recursive: true });
  await Promise.all(
    variants.map(({ size, data }) =>
      writeFile(path.join(OPTIMIZED_DIR, `${safeSku}_0_${size}.webp`), data),
    ),
  );
}

function imageRecordFor(row: ProductRow, safeSku: string, originalUrl: string): ImageRecord {
  const base = `/uploads/optimized/${safeSku}_0_`;
  return {
    src: `${base}800.webp`,
    srcMobile: `${base}400.webp`,
    srcCardDesktop: `${base}400.webp`,
    srcCardMobile: `${base}200.webp`,
    alt: row.name || row.sku,
    originalUrl,
  };
}

// ---------- Bihr API fallback (per-SKU image) ----------
//
// When a brand's static zip returns 404 from static.bihr.pro (e.g. EK CHAIN,
// NG BRAKE DISC, ALL BALLS, V PARTS), fall back to the authenticated
// per-product endpoint. The token is cached in memory for ~1h (token expiry
// minus a safety margin).
interface BihrToken {
  token: string;
  expiresAt: number;
}
let cachedToken: BihrToken | null = null;
// Circuit breaker: when the API is down or rate-limiting hard, we see a run
// of auth/HTTP failures. After CIRCUIT_BREAKER_THRESHOLD consecutive API
// failures (auth OR 429 OR timeout), we open the circuit — getBihrToken()
// returns null and the caller marks the product as "api-unreachable" rather
// than retrying. The circuit re-closes after CIRCUIT_BREAKER_RESET_MS so
// transient outages recover.
let apiConsecutiveFails = 0;
let apiCircuitOpenedAt = 0;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 5 * 60_000;

function isCircuitOpen(): boolean {
  if (apiConsecutiveFails < CIRCUIT_BREAKER_THRESHOLD) return false;
  if (Date.now() - apiCircuitOpenedAt > CIRCUIT_BREAKER_RESET_MS) {
    // Try again — half-open.
    selfLog(`BIHR-API circuit half-open (was open for ${Math.round((Date.now() - apiCircuitOpenedAt) / 1000)}s)`);
    apiConsecutiveFails = 0;
    return false;
  }
  return true;
}

function bumpCircuit(reason: string): void {
  apiConsecutiveFails++;
  if (apiConsecutiveFails === CIRCUIT_BREAKER_THRESHOLD) {
    apiCircuitOpenedAt = Date.now();
    selfLog(`BIHR-API circuit OPEN for ${CIRCUIT_BREAKER_RESET_MS / 1000}s — ${reason}`);
  } else if (apiConsecutiveFails > CIRCUIT_BREAKER_THRESHOLD) {
    // Already open, but reset timer if we're still failing.
    apiCircuitOpenedAt = Date.now();
  } else {
    selfLog(`BIHR-API fail #${apiConsecutiveFails}: ${reason}`);
  }
}

async function getBihrToken(): Promise<string | null> {
  if (!BIHR_USERNAME || !BIHR_MACKEY) return null;
  if (isCircuitOpen()) return null;
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;
  try {
    const resp = await fetch(`${BIHR_API_BASE}/api/v2.1/Authentication/Token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ UserName: BIHR_USERNAME, PassWord: BIHR_MACKEY }).toString(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      bumpCircuit(`AUTH HTTP ${resp.status}`);
      cachedToken = null;
      return null;
    }
    const data: any = await resp.json();
    if (!data?.access_token) {
      bumpCircuit('AUTH no access_token');
      cachedToken = null;
      return null;
    }
    apiConsecutiveFails = 0;
    cachedToken = {
      token: data.access_token,
      expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
    };
    return cachedToken.token;
  } catch (err: any) {
    bumpCircuit(`AUTH ${err?.message || err}`);
    cachedToken = null;
    return null;
  }
}

async function fetchImageFromBihrApi(supplierCode: string): Promise<Buffer | null> {
  const token = await getBihrToken();
  if (!token) return null;
  const url = `${BIHR_API_BASE}/api/v2.1/Products/Image/${encodeURIComponent(supplierCode)}`;
  // Bihr's API is rate-limited and returns HTTP 429 when we hit too fast. The
  // happy path (zip-based) doesn't go through the API at all, so this only
  // affects products in brands whose zip returned 404. We serialize the API
  // path with a fixed ~250ms gap to stay well under the limit, and back off
  // aggressively on 429.
  await bihrApiGate();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        // 404 sometimes returns a tiny HTML error page — guard against it.
        if (buf.length < 200) return null;
        // Successful call → API is healthy, reset circuit state.
        apiConsecutiveFails = 0;
        return buf;
      }
      if (resp.status === 404) return null;
      if (resp.status === 429) {
        bumpCircuit(`API 429 for ${supplierCode}`);
        // Exponential backoff: 1s, 2s, 4s, 8s.
        const wait = 1000 * Math.pow(2, attempt);
        selfLog(`BIHR-API 429 for ${supplierCode}, backing off ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      bumpCircuit(`API HTTP ${resp.status} for ${supplierCode}`);
      return null;
    } catch (err: any) {
      bumpCircuit(`API timeout/err ${supplierCode}: ${err?.message || err}`);
      return null;
    }
  }
  selfLog(`BIHR-API giving up on ${supplierCode} after 4 retries`);
  return null;
}

// Process-wide mutex + rate limiter for the Bihr API. The API is rate-limited
// (HTTP 429 on bursts), so we serialize ALL API calls across workers and add a
// minimum gap between them. This makes API throughput ~4 req/s — slow but
// sustainable. The zip-based path doesn't go through here, so brands with
// working zips aren't slowed down.
let bihrApiChain: Promise<unknown> = Promise.resolve();
let bihrApiLastCallAt = 0;
const BIHR_API_MIN_GAP_MS = 250;
async function bihrApiGate(): Promise<void> {
  // Chain each call onto the previous one so only one is ever in-flight.
  // (The workers still run in parallel for the zip path; the API path queues.)
  const prev = bihrApiChain;
  let release!: () => void;
  bihrApiChain = new Promise<void>((res) => (release = res));
  await prev;
  try {
    const now = Date.now();
    const wait = bihrApiLastCallAt + BIHR_API_MIN_GAP_MS - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    bihrApiLastCallAt = Date.now();
  } finally {
    release();
  }
}

// Module-level fallback chain: called from any branch in processProduct that
// failed to find the image in the brand zip. Tries (1) the authenticated
// Bihr per-product API, then (2) the direct CDN URL from the CSV. Respects
// the circuit breaker for the API path.
async function tryApiFallback(
  row: ProductRow,
  brand: string,
  urlMap: Map<string, { url: string; brand: string }>,
): Promise<Buffer | null> {
  if (!isCircuitOpen()) {
    const code = row.supplier_code || row.sku;
    if (code) {
      selfLog(`BIHR-API-TRY ${brand}/${code}`);
      const buf = await fetchImageFromBihrApi(code);
      if (buf) {
        selfLog(`BIHR-API-OK ${brand}/${code} (${buf.length}B)`);
        return buf;
      }
    }
  }
  // Try the CSV-embedded CDN URL. Cheap, no auth, public.
  return await tryUrlFallback(row, urlMap);
}

// Third-tier fallback: the Bihr catalog CSV embeds direct CDN URLs for each
// product's Picture1..6 (api.mybihr.com/medias/{id}-{n}-{size}?context=...).
// These URLs are the same images packaged in the brand zip, but they're
// publicly addressable — no auth, no rate limit. This is the most reliable
// source when both zip and authenticated API fail.
async function tryUrlFallback(
  row: ProductRow,
  urlMap: Map<string, { url: string; brand: string }>,
): Promise<Buffer | null> {
  // Look up by supplier_code or sku (the CSV indexes these as aliases).
  const urlEntry =
    urlMap.get(row.supplier_code) ||
    urlMap.get(row.sku);
  if (!urlEntry?.url) return null;
  selfLog(`BIHR-URL-TRY ${urlEntry.url.slice(0, 100)}...`);
  try {
    const resp = await fetch(urlEntry.url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'EscapesYMas-Bihr-Image-Downloader/5.0' },
    });
    if (!resp.ok) {
      selfLog(`BIHR-URL HTTP ${resp.status}`);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1000) {
      // Some 404 responses are tiny HTML pages — reject them.
      selfLog(`BIHR-URL too small (${buf.length}B), rejecting`);
      return null;
    }
    selfLog(`BIHR-URL-OK ${buf.length}B`);
    return buf;
  } catch (err: any) {
    selfLog(`BIHR-URL-ERR ${err?.message || err}`);
    return null;
  }
}

// Brands whose zip returned 404 (or otherwise unreachable) — once a brand is
// known-bad, we skip the fetch and mark every product of that brand with a
// placeholder so the loop doesn't re-pick them. Persisted to disk so we don't
// re-fetch across restarts.
const FAILED_BRANDS_FILE = '/app/server/uploads/bihr-failed-brands.json';
const failedBrands: Set<string> = new Set();

async function loadFailedBrands(): Promise<void> {
  try {
    if (existsSync(FAILED_BRANDS_FILE)) {
      const raw = await (await import('node:fs/promises')).readFile(FAILED_BRANDS_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const b of list) failedBrands.add(b);
      }
    }
  } catch {}
}

async function saveFailedBrands(): Promise<void> {
  try {
    const arr: string[] = [];
    failedBrands.forEach((b) => arr.push(b));
    arr.sort();
    await (await import('node:fs/promises')).writeFile(
      FAILED_BRANDS_FILE,
      JSON.stringify(arr),
    );
  } catch {}
}

async function processProduct(
  row: ProductRow,
  position: number,
  total: number,
  skuMap: Map<string, { brand: string }>,
  partMap: Map<string, { brand: string; partNumber: string }>,
  urlMap: Map<string, { url: string; brand: string }>,
): Promise<'downloaded' | 'no-image'> {
  const safeSku = sanitizeSku(row.sku);
  if (!safeSku) throw new Error('SKU empty');
  const entry = skuMap.get(row.sku) || skuMap.get(row.supplier_code);
  if (!entry) {
    // No CSV row matched this product's sku or supplier_code. The Bihr CSV
    // is a snapshot — products added to Bihr AFTER the snapshot date won't
    // appear in it, but the authenticated per-product API may still have
    // them. Try the API before giving up. Use row.brand (the product's own
    // brand) for the originalUrl label — it's what users see in the catalog.
    const code = row.supplier_code || row.sku;
    console.log(`[${position}/${total}] Product ${row.id}: no brand mapping, trying API for ${code}`);
    const apiBuf = await fetchImageFromBihrApi(code);
    if (apiBuf) {
      await writeVariants(apiBuf, safeSku);
      const images = [imageRecordFor(row, safeSku, `api:${row.brand || 'unknown'}/${code}`)];
      await db.execute(sql`
        UPDATE products
        SET images = ${JSON.stringify(images)}::jsonb
        WHERE id = ${row.id}
      `);
      console.log(`[${position}/${total}] Product ${row.id}: API fallback (no CSV match) ${safeSku}_0_800.webp`);
      return 'downloaded';
    }
    // API confirmed missing — mark so we don't retry every loop.
    console.log(`[${position}/${total}] Product ${row.id}: no brand mapping (API also 404)`);
    await db.execute(sql`
      UPDATE products
      SET images = ${JSON.stringify([{ src: '', originalUrl: 'no-image:no-brand-mapping', alt: row.name || row.sku || '' }])}::jsonb
      WHERE id = ${row.id}
    `);
    return 'no-image';
  }
  // Look up the CSV's PartNumber — that's the stem used in the zip filenames,
  // not the product's internal sku or supplier_code.
  const partEntry = partMap.get(row.sku) || partMap.get(row.supplier_code);
  const partNumber = partEntry?.partNumber || row.supplier_code || row.sku;
  if (failedBrands.has(entry.brand)) {
    // Brand zip is known-bad (404). Try the API fallback before giving up.
    console.log(`[${position}/${total}] Product ${row.id}: brand ${entry.brand} zip 404, trying API`);
    const apiImage = await tryApiFallback(row, entry.brand, urlMap);
    if (apiImage) {
      await writeVariants(apiImage, safeSku);
      const images = [imageRecordFor(row, safeSku, `api:${entry.brand}/${row.supplier_code || row.sku}`)];
      await db.execute(sql`
        UPDATE products
        SET images = ${JSON.stringify(images)}::jsonb
        WHERE id = ${row.id}
      `);
      console.log(`[${position}/${total}] Product ${row.id}: API fallback ${safeSku}_0_800.webp`);
      return 'downloaded';
    }
    const noImgReason = isCircuitOpen() ? 'no-image:brand-X-api-circuit-open' : `no-image:brand-${entry.brand}-no-zip`;
    await db.execute(sql`
      UPDATE products
      SET images = ${JSON.stringify([{ src: '', originalUrl: noImgReason, alt: row.name || row.sku || '' }])}::jsonb
      WHERE id = ${row.id}
    `);
    return 'no-image';
  }

  // Module-level API fallback helper (hoisted; safe to use above).
  let index: BrandIndex | null = null;
  // Skip the zip fetch if we already know this brand's zip is unreachable —
  // we'll fall through to the API fallback below.
  if (!failedBrands.has(entry.brand)) {
    try {
      index = await loadBrandIndex(entry.brand);
    } catch (err: any) {
      // Remember the brand as failed (write to disk) so we don't re-fetch
      // its (likely 404) zip for every product of that brand. The API
      // fallback below will still try per-SKU.
      failedBrands.add(entry.brand);
      await saveFailedBrands();
      selfLog(`BRAND-FAIL ${entry.brand}: ${err?.message || err}`);
      console.error(`[${position}/${total}] Product ${row.id}: brand ${entry.brand} zip failed (${err?.message || err}), will try API fallback`);
    }
  }

  // No index (brand zip 404) → API only.
  if (!index) {
    const apiImage = await tryApiFallback(row, entry.brand, urlMap);
    if (apiImage) {
      await writeVariants(apiImage, safeSku);
      const images = [imageRecordFor(row, safeSku, `api:${entry.brand}/${row.supplier_code || row.sku}`)];
      await db.execute(sql`
        UPDATE products
        SET images = ${JSON.stringify(images)}::jsonb
        WHERE id = ${row.id}
      `);
      console.log(`[${position}/${total}] Product ${row.id}: API fallback ${safeSku}_0_800.webp`);
      return 'downloaded';
    }
    await db.execute(sql`
      UPDATE products
      SET images = ${JSON.stringify([{ src: '', originalUrl: `no-image:brand-${entry.brand}-no-zip`, alt: row.name || row.sku || '' }])}::jsonb
      WHERE id = ${row.id}
    `);
    return 'no-image';
  }
  // If the brand's zip exists but is empty (0 image files), treat it as
  // failed — every product of this brand will miss the lookup and we should
  // not waste cycles re-fetching the (cached) empty index for each one.
  if (index.files.length === 0) {
    failedBrands.add(entry.brand);
    await saveFailedBrands();
    selfLog(`BRAND-EMPTY ${entry.brand}: zip has 0 files`);
    const apiImage = await tryApiFallback(row, entry.brand, urlMap);
    if (apiImage) {
      await writeVariants(apiImage, safeSku);
      const images = [imageRecordFor(row, safeSku, `api:${entry.brand}/${row.supplier_code || row.sku}`)];
      await db.execute(sql`
        UPDATE products
        SET images = ${JSON.stringify(images)}::jsonb
        WHERE id = ${row.id}
      `);
      console.log(`[${position}/${total}] Product ${row.id}: API fallback (empty zip) ${safeSku}_0_800.webp`);
      return 'downloaded';
    }
    await db.execute(sql`
      UPDATE products
      SET images = ${JSON.stringify([{ src: '', originalUrl: `no-image:brand-${entry.brand}-empty-zip`, alt: row.name || row.sku || '' }])}::jsonb
      WHERE id = ${row.id}
    `);
    return 'no-image';
  }
  const image = await fetchImageFromZip(entry.brand, partNumber, index);
  if (!image) {
    console.log(`[${position}/${total}] Product ${row.id}: not in ${entry.brand} zip, trying API`);
    const apiImage = await tryApiFallback(row, entry.brand, urlMap);
    if (apiImage) {
      await writeVariants(apiImage, safeSku);
      const images = [imageRecordFor(row, safeSku, `api:${entry.brand}/${row.supplier_code || row.sku}`)];
      await db.execute(sql`
        UPDATE products
        SET images = ${JSON.stringify(images)}::jsonb
        WHERE id = ${row.id}
      `);
      console.log(`[${position}/${total}] Product ${row.id}: API fallback ${safeSku}_0_800.webp`);
      return 'downloaded';
    }
    await db.execute(sql`
      UPDATE products
      SET images = ${JSON.stringify([{ src: '', originalUrl: `no-image:not-in-${entry.brand}-zip`, alt: row.name || row.sku || '' }])}::jsonb
      WHERE id = ${row.id}
    `);
    return 'no-image';
  }
  await writeVariants(image, safeSku);
  const images = [imageRecordFor(row, safeSku, `zip:${entry.brand}`)];
  await db.execute(sql`
    UPDATE products
    SET images = ${JSON.stringify(images)}::jsonb
    WHERE id = ${row.id}
  `);
  console.log(`[${position}/${total}] Product ${row.id}: downloaded ${safeSku}_0_800.webp`);
  return 'downloaded';
}

interface CumulativeTotals {
  processed: number;
  downloaded: number;
  skipped: number;
  errors: number;
}

async function updateImageRegenState(fields: Record<string, unknown>): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${idx++}`);
    values.push(value);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = NOW()`);
  values.push(1);
  await pool.query(`UPDATE image_regen_state SET ${sets.join(', ')} WHERE id = $${idx}`, values);
}

async function countCandidates(): Promise<number> {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS total FROM products
    WHERE (images IS NULL OR images::text = '[]') AND sku IS NOT NULL AND sku <> ''
  `);
  return result.rows[0]?.total ?? 0;
}

/**
 * Scan all products with images and reset the ones whose webp file is missing
 * on disk. Recovery for when the upload volume was wiped but the DB kept
 * image references (or a container recreation lost the writable layer).
 *
 * For each product with non-null images, we check if its 800px variant file
 * exists at OPTIMIZED_DIR/{sku}_0_800.webp. If not, we reset images to NULL
 * so the regular loopAll picks it up for re-download.
 *
 * Loads the id+sku list in one query (small projection, ~100k rows is fine),
 * then walks the filesystem in a single pass. Reports progress every 1000
 * products and resets in batches of 500 to keep the UPDATE cheap.
 */
async function resetMissingFiles(): Promise<void> {
  selfLog('[RECHECK] Starting file-existence scan...');
  const result = await pool.query(`
    SELECT id, sku FROM products
    WHERE images IS NOT NULL AND images::text NOT LIKE '%no-image%' AND images::text NOT IN ('[]','null')
      AND sku IS NOT NULL AND sku <> ''
  `);
  const rows = result.rows as Array<{ id: number; sku: string }>;
  selfLog(`[RECHECK] ${rows.length} products with images to verify`);
  const missing: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const { id, sku } = rows[i];
    const file = path.join(OPTIMIZED_DIR, `${sanitizeSku(sku)}_0_800.webp`);
    if (!existsSync(file)) missing.push(id);
    if ((i + 1) % 1000 === 0) selfLog(`[RECHECK] progress ${i + 1}/${rows.length}`);
  }
  selfLog(`[RECHECK] ${missing.length} products with missing files`);
  if (missing.length === 0) return;
  // Reset in batches of 500 to avoid a single huge statement.
  const BATCH = 500;
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH);
    await pool.query(
      `UPDATE products SET images = NULL WHERE id = ANY($1::int[])`,
      [slice],
    );
  }
  selfLog(`[RECHECK] Reset ${missing.length} products to NULL — they'll be re-downloaded`);
}

async function runBatch(
  options: CliOptions,
  skuMap: Map<string, { brand: string }>,
  partMap: Map<string, { brand: string; partNumber: string }>,
  urlMap: Map<string, { url: string; brand: string }>,
  effectiveBatch: number,
  totals: CumulativeTotals,
): Promise<CumulativeTotals> {
  const result = await db.execute(sql`
    SELECT id, sku, supplier_code, images, name FROM products
    WHERE (images IS NULL OR images::text = '[]') AND sku IS NOT NULL AND sku <> ''
    ORDER BY id LIMIT ${effectiveBatch}
  `);
  const products = result.rows as unknown as ProductRow[];
  if (products.length === 0) return totals;

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= products.length) return;
      const product = products[index];
      try {
        const status = await processProduct(product, index + 1, products.length, skuMap, partMap, urlMap);
        if (status === 'downloaded') totals.downloaded++;
        else totals.skipped++;
      } catch (error) {
        totals.errors++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${index + 1}/${products.length}] Product ${product.id}: failed - ${message}`);
        selfLog(`FAIL ${product.id} sku=${product.sku}: ${message}`);
        // Mark the product so it isn't re-selected next batch. Without this,
        // any product that throws here will sit in the queue forever and
        // prevent the loop from reaching remaining=0.
        try {
          await db.execute(sql`
            UPDATE products
            SET images = ${JSON.stringify([{ src: '', originalUrl: `no-image:download-error`, alt: product.name || product.sku || '' }])}::jsonb
            WHERE id = ${product.id}
          `);
        } catch (markErr) {
          selfLog(`MARK-FAIL ${product.id}: ${markErr instanceof Error ? markErr.message : String(markErr)}`);
        }
      } finally {
        totals.processed++;
        await updateImageRegenState({
          processed: totals.processed,
          success: totals.downloaded,
          failed: totals.errors,
          skipped: totals.skipped,
          current_sku: product.sku ?? '',
        }).catch((err) => console.error('[STATE UPDATE ERROR]', err));
      }
    }
  }
  const workerCount = Math.min(options.concurrency, products.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return totals;
}

async function main(): Promise<void> {
  selfLog('=== main() start ===');
  const options = parseArgs(process.argv.slice(2));
  selfLog(`[INFO] batch=${options.batch} concurrency=${options.concurrency} csvDir=${options.csvDir}`);
  await loadFailedBrands();
  selfLog(`[INFO] failedBrands=${failedBrands.size} (cached)`);
  if (options.recheckFiles) {
    await resetMissingFiles();
  }
  const { skuMap, partMap, urlMap } = await loadCatalogMap(options.csvDir);
  const totalCandidates = await countCandidates();
  selfLog(`[INFO] totalCandidates=${totalCandidates} skuMapSize=${skuMap.size} partMapSize=${partMap.size} urlMapSize=${urlMap.size}`);
  let effectiveBatch = Math.min(options.batch, totalCandidates);
  await updateImageRegenState({
    status: 'running',
    processed: 0, success: 0, failed: 0, skipped: 0,
    total: totalCandidates, current_sku: '',
  });
  if (effectiveBatch === 0) {
    selfLog('[DONE] No products with missing images found.');
    await updateImageRegenState({ status: 'completed' });
    return;
  }
  const totals: CumulativeTotals = { processed: 0, downloaded: 0, skipped: 0, errors: 0 };
  let batchNum = 1;
  while (true) {
    totals.processed = 0; totals.downloaded = 0; totals.skipped = 0; totals.errors = 0;
    await runBatch(options, skuMap, partMap, urlMap, effectiveBatch, totals);
    selfLog(`[BATCH ${batchNum}] downloaded=${totals.downloaded} skipped=${totals.skipped} errors=${totals.errors}`);
    if (!options.loopAll) break;
    const remaining = await countCandidates();
    selfLog(`[LOOP] remaining=${remaining}`);
    if (remaining === 0) break;
    effectiveBatch = Math.min(options.batch, remaining);
    batchNum++;
  }
  await updateImageRegenState({ status: 'completed', current_sku: '' });
  selfLog(`[ALL DONE] batches=${batchNum}`);
}

main()
  .catch((error) => {
    console.error('[FATAL]', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });