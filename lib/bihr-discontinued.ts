/**
 * Productos que Bihr ha descatalogado (catálogos «Products» y «Stocks» de la API v3).
 *
 * - Se ocultan de la tienda (status 'descatalogado') los que Bihr marca como descatalogados
 *   (IsDiscontinued) y ya no tienen stock en Bihr: no se pueden servir.
 * - Un descatalogado con stock en Bihr se sigue vendiendo; se oculta cuando se agota.
 * - Vuelven a 'published' si Bihr los reactiva o les entra stock (Bihr avisa de que puede pasar).
 * - Solo toca productos 'published' o 'descatalogado': los borradores, archivados o duplicados no.
 *
 * Se ejecuta tras cada sincronización del catálogo de Bihr y una vez al día; de paso rellena descripciones
 * (lib/bihr-descriptions.ts). Los catálogos v3 se generan al
 * momento y pesan poco (~40 MB y ~13 MB comprimidos); se leen por trozos para no cargar el JSON entero.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pool } from '../db.js';
import { getBihrToken } from '../bihrService.js';
import { cacheBust } from './cache.js';

const run = promisify(execFile);
const BIHR_API_BASE = process.env.BIHR_API_BASE || 'https://api.bihr.net';
export const DISCONTINUED_STATUS = 'descatalogado';
/** Si Bihr devuelve menos que esto, la descarga se considera incompleta y no se toca nada. */
const MIN_CATALOG_PRODUCTS = 50_000;
const MIN_STOCK_ROWS = 50_000;
/** Freno por si algo va mal: nunca se ocultan más de estos productos de una vez. */
const MAX_HIDE_PER_RUN = 15_000;

export interface DiscontinuedResult {
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'error';
  catalogProducts?: number;
  catalogDiscontinued?: number;
  stockRows?: number;
  hidden?: number;
  restored?: number;
  keptWithStock?: number;
  error?: string;
}

let last: DiscontinuedResult | null = null;
let running: Promise<DiscontinuedResult> | null = null;
export const lastDiscontinuedSync = () => last;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pide un catálogo v3, espera a que esté y lo deja descomprimido en `dir`. Devuelve la ruta del JSON. */
async function downloadCatalog(catalogType: 'Products' | 'Stocks', dir: string): Promise<string> {
  const headers = async () => ({ Authorization: `Bearer ${await getBihrToken()}`, 'Content-Type': 'application/json' });
  const r = await fetch(`${BIHR_API_BASE}/api/v3/Catalogs/Request`, {
    method: 'POST', headers: await headers(),
    body: JSON.stringify({ catalogType, compressionType: 'ZIP', serializationType: 'JSON', language: 'es' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`${catalogType}: la petición dio HTTP ${r.status}`);
  let req: any = await r.json();
  for (let i = 0; i < 90 && !req.catalogFileId; i++) {
    if (req.status === 'Failed' || req.status === 'Cancelled') throw new Error(`${catalogType}: ${req.status} ${req.errorMessage || ''}`);
    await sleep(20_000);
    const s = await fetch(`${BIHR_API_BASE}/api/v3/Catalogs/Request/${encodeURIComponent(req.id)}`, { headers: await headers(), signal: AbortSignal.timeout(60_000) });
    if (s.ok) req = await s.json();
  }
  if (!req.catalogFileId) throw new Error(`${catalogType}: Bihr no lo generó a tiempo`);
  const f = await fetch(`${BIHR_API_BASE}/api/v3/Catalogs/File/${encodeURIComponent(req.catalogFileId)}`, { headers: await headers(), signal: AbortSignal.timeout(10 * 60_000) });
  if (!f.ok) throw new Error(`${catalogType}: la descarga dio HTTP ${f.status}`);
  const zip = path.join(dir, `${catalogType}.zip`);
  await fs.promises.writeFile(zip, Buffer.from(await f.arrayBuffer()));
  const out = path.join(dir, catalogType);
  await fs.promises.mkdir(out, { recursive: true });
  await run('unzip', ['-o', '-q', zip, '-d', out]);
  await fs.promises.rm(zip, { force: true });
  const json = (await fs.promises.readdir(out)).find((n) => n.endsWith('.json'));
  if (!json) throw new Error(`${catalogType}: el zip no trae JSON`);
  return path.join(out, json);
}

/** Recorre el JSON por trozos y llama a `onMatch` con cada coincidencia de `re` (que debe tener la bandera g). */
async function scan(file: string, re: RegExp, onMatch: (m: RegExpExecArray) => void): Promise<void> {
  let tail = '';
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf-8', highWaterMark: 1 << 20 })) {
    const text = tail + chunk;
    let consumed = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index + m[0].length > text.length - 200) break; // puede venir cortado: se mira con el siguiente trozo
      onMatch(m);
      consumed = m.index + m[0].length;
    }
    tail = text.slice(Math.max(consumed, text.length - 400));
  }
  // Lo que quedaba al final del fichero ya no tiene trozo siguiente: se mira entero.
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail))) onMatch(m);
}

/** Estado de cada referencia en el catálogo «Products» de Bihr. */
export interface CatalogStatus {
  /** Productos leídos (referencias principales). */
  total: number;
  /** Referencia principal → si está descatalogada. */
  main: Map<string, boolean>;
  /** Referencias antiguas (OldPartNumber) de productos descatalogados. */
  oldDiscontinued: Set<string>;
}

/**
 * Lee el catálogo «Products». Los descatalogados vienen con una ficha corta (PartNumber, OldPartNumber, …
 * IsDiscontinued: true); los vigentes, con la ficha completa (donde puede haber referencias anidadas de genéricos).
 */
export async function readCatalogStatus(file: string): Promise<CatalogStatus> {
  const main = new Map<string, boolean>();
  const oldDiscontinued = new Set<string>();
  let total = 0;
  let code = '', old = '';
  await scan(file, /"(PartNumber|OldPartNumber)"\s*:\s*"([^"]*)"|"IsDiscontinued"\s*:\s*(true|false)/g, (m) => {
    if (m[1] === 'PartNumber') {
      code = m[2].trim().toLowerCase(); old = '';
      if (code && !main.has(code)) { main.set(code, false); total++; }
    } else if (m[1] === 'OldPartNumber') old = m[2].trim().toLowerCase();
    else if (m[3] === 'true' && code) { main.set(code, true); if (old) oldDiscontinued.add(old); }
  });
  return { total, main, oldDiscontinued };
}

/**
 * ¿Bihr tiene descatalogado este producto? Manda su referencia actual: si Bihr la tiene vigente, no lo está
 * aunque una referencia antigua suya figure como descatalogada (productos renumerados).
 */
export function isDiscontinued(codes: string[], status: CatalogStatus): boolean {
  for (const c of codes) {
    const known = status.main.get(c);
    if (known !== undefined) return known;
  }
  return codes.some((c) => status.oldDiscontinued.has(c));
}

/** Stock de cada referencia del catálogo «Stocks». */
export async function readStocks(file: string): Promise<Map<string, number>> {
  const stocks = new Map<string, number>();
  let current = '';
  await scan(file, /"PartNumber"\s*:\s*"([^"]*)"|"Value"\s*:\s*(-?[\d.]+)/g, (m) => {
    if (m[1] !== undefined) current = m[1].trim().toLowerCase();
    else if (current) { stocks.set(current, Number(m[2]) || 0); current = ''; }
  });
  return stocks;
}

export interface ProductRow { id: number; sku: string | null; part_number: string | null; status: string }

/** Qué productos ocultar y cuáles volver a publicar (sin tocar la BD). */
export function planDiscontinued(rows: ProductRow[], status: CatalogStatus, stocks: Map<string, number>) {
  const hide: number[] = [], restore: number[] = [];
  let keptWithStock = 0;
  for (const r of rows) {
    const codes = [r.part_number, r.sku].map((c) => String(c || '').trim().toLowerCase()).filter(Boolean);
    const isDisc = isDiscontinued(codes, status);
    const stock = Math.max(0, ...codes.map((c) => stocks.get(c) ?? 0));
    if (r.status === 'published' && isDisc) {
      if (stock > 0) keptWithStock++; else hide.push(r.id);
    } else if (r.status === DISCONTINUED_STATUS && (!isDisc || stock > 0)) {
      restore.push(r.id);
    }
  }
  return { hide, restore, keptWithStock };
}

async function doSync(): Promise<DiscontinuedResult> {
  const result: DiscontinuedResult = { startedAt: new Date().toISOString(), status: 'running' };
  last = result;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bihr-v3-'));
  try {
    const productsFile = await downloadCatalog('Products', dir);
    const status = await readCatalogStatus(productsFile);
    const total = status.total;
    result.catalogProducts = total;
    result.catalogDiscontinued = [...status.main.values()].filter(Boolean).length;
    if (total < MIN_CATALOG_PRODUCTS) throw new Error(`el catálogo de productos de Bihr parece incompleto (${total} productos)`);
    const stocksFile = await downloadCatalog('Stocks', dir);
    const stocks = await readStocks(stocksFile);
    result.stockRows = stocks.size;
    if (stocks.size < MIN_STOCK_ROWS) throw new Error(`el catálogo de stock de Bihr parece incompleto (${stocks.size} referencias)`);

    const { rows } = await pool.query<ProductRow>(
      `SELECT id, sku, part_number, status FROM products WHERE status IN ('published', $1)`, [DISCONTINUED_STATUS]);
    const { hide, restore, keptWithStock } = planDiscontinued(rows, status, stocks);
    if (hide.length > MAX_HIDE_PER_RUN) throw new Error(`se iban a ocultar ${hide.length} productos de golpe; no se toca nada por si es un error`);
    if (hide.length) await pool.query(`UPDATE products SET status = $2, updated_at = NOW() WHERE id = ANY($1) AND status = 'published'`, [hide, DISCONTINUED_STATUS]);
    if (restore.length) await pool.query(`UPDATE products SET status = 'published', updated_at = NOW() WHERE id = ANY($1) AND status = $2`, [restore, DISCONTINUED_STATUS]);
    if (hide.length || restore.length) {
      await Promise.all([cacheBust('cache:products'), cacheBust('compat:prod'), cacheBust('cache:suggest')]).catch(() => {});
    }
    Object.assign(result, { status: 'done', hidden: hide.length, restored: restore.length, keptWithStock });
    // Con el catálogo ya descargado se aprovecha para rellenar descripciones (no falla: guarda su propio resultado).
    await (await import('./bihr-descriptions.js')).fillDescriptions(productsFile);
    // Lo que sigue sin texto se apunta para describirlo con sus datos (lib/attribute-descriptions.ts).
    await (await import('./attribute-descriptions.js')).queueAttributeDescriptions(productsFile)
      .catch((e) => console.error('[DESCRIPCIONES ATRIBUTOS ERROR]:', e.message));
  } catch (err: any) {
    Object.assign(result, { status: 'error', error: err?.message || String(err) });
  } finally {
    result.finishedAt = new Date().toISOString();
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    await pool.query(
      `INSERT INTO catalog_meta (key, value) VALUES ('bihr_discontinued_last', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(result)]).catch(() => {});
    console.log('[BIHR DESCATALOGADOS]', JSON.stringify(result));
  }
  return result;
}

/** Oculta los descatalogados sin stock y recupera los reactivados. Si ya está en marcha, espera a esa pasada. */
export function syncDiscontinued(): Promise<DiscontinuedResult> {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}
