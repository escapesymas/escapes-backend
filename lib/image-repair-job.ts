/**
 * Descarga en bloque de las fotos de los productos que se ven sin imagen (lib/image-audit.ts).
 *
 * Es el botón «Descargar fotos de Bihr» de la ficha (lib/bihr-images.ts) aplicado a todos los
 * productos de la auditoría, uno tras otro y en segundo plano:
 *   - primero los productos con stock y, si se pide, después el resto;
 *   - agrupados por marca, para dejar de intentar una marca si falla varias veces seguidas;
 *   - fuentes: la API v3 de Bihr (Products/Details, pedidos de 20 en 20: cada foto trae su enlace actual) y, si no
 *     da fotos, el enlace del catálogo JSON de Bihr guardado en el servidor (lib/bihr-catalog-pictures.ts) o el de la
 *     ficha. Ya no se usan el zip de la marca (hay zips de más de 4 GB que no se pueden leer por partes) ni la API v2
 *     de imágenes (404 para todo). Los enlaces caducados (404) no cuentan como fallo;
 *   - solo con el número de pieza y el SKU, nunca con el código del fabricante (puede dar la foto de otra pieza).
 *
 * El estado vive en memoria: si se despliega una versión nueva el trabajo se corta, pero basta con
 * volver a lanzarlo, porque cada vuelta solo recoge los productos que siguen sin imagen.
 * Se para solo si hay fallos seguidos (algo no va: red, la API, procesador de imágenes) o queda poco disco.
 */
import { pool } from '../db.js';
import fs from 'fs';
import path from 'path';
import { getImageAudit, filterAuditItems, invalidateImageAudit, type ImageAuditItem } from './image-audit.js';
import { repairProductImages, contestedFileBases, bihrProductPictures, type RepairOptions, type RepairResult, type RepairSource } from './bihr-images.js';
import { cacheBust } from './cache.js';
import { loadCatalogPictures, type CatalogPictures } from './bihr-catalog-pictures.js';

export type RepairJobScope = 'stock' | 'all';
export type RepairJobStatus = 'idle' | 'running' | 'stopping' | 'done' | 'stopped' | 'error';

export interface BrandStats {
  total: number; done: number; saved: number; notFound: number; failed: number; skipped: number; lastError?: string;
  /** Se dejó a medias por fallos seguidos: los productos que quedaban cuentan como saltados. */
  gaveUp?: boolean;
}
export interface RepairJobError { id: number; sku: string; brand: string; message: string }
export interface RepairJobState {
  status: RepairJobStatus;
  scope: RepairJobScope;
  useApi: boolean;
  concurrency: number;
  startedAt?: string;
  finishedAt?: string;
  /** Productos en la cola y cuántos se han tratado ya. */
  total: number;
  done: number;
  /** Con foto nueva. */
  saved: number;
  /** De ellos, los que salieron de un enlace del catálogo de Bihr o de la ficha. */
  savedFromLinks: number;
  /** La fuente funcionó pero no tiene la foto. */
  notFound: number;
  /** Alguna fuente falló (red, API de Bihr, procesador de imágenes…). */
  failed: number;
  /** Ya tenían foto, otro proceso los estaba tratando o su marca se dejó de intentar. */
  skipped: number;
  currentBrand: string;
  /** Lo que trae el catálogo de Bihr guardado en el servidor (null: no hay catálogo o no se pudo leer; sin definir: aún no se ha mirado). */
  catalog?: { modifiedAt: string; refs: number; withPictures: number; unmatched: number; forQueue: number; pictureFields: string[] } | null;
  brands: Record<string, BrandStats>;
  recentErrors: RepairJobError[];
  /** Qué está haciendo o por qué se paró. */
  message?: string;
}

export class RepairJobBusy extends Error {
  constructor() { super('Ya hay una descarga en bloque en marcha'); }
}

export interface RepairJobDeps {
  loadItems(scope: RepairJobScope): Promise<ImageAuditItem[]>;
  contested(): Promise<Set<string>>;
  /** Fotos de varios productos de una vez (Products/Details de Bihr): código en minúsculas → enlaces. */
  productPictures(codes: string[]): Promise<Map<string, string[]>>;
  /** Enlaces de foto del catálogo de Bihr para esos SKU; null si no hay catálogo guardado. */
  catalogPictures(skus: string[]): Promise<CatalogPictures | null>;
  repair(id: number, opts: RepairOptions): Promise<RepairResult>;
  /** Vacía las cachés de la tienda para que se vean las fotos nuevas. */
  bust(): Promise<void>;
  /** Espacio libre en el disco de las fotos, o null si no se sabe. */
  freeBytes(): Promise<number | null>;
  /** Esperas antes de reintentar un producto cuando la API de Bihr no responde (ms). */
  outageWaitsMs?: number[];
}

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
export const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 6;
/** Fallos seguidos de una misma marca antes de dejarla (la fuente no responde para ella). */
const BRAND_FAILURE_LIMIT = 5;
/** Fallos seguidos, de cualquier marca, antes de parar todo. */
const GLOBAL_FAILURE_LIMIT = 40;
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const DISK_CHECK_EVERY = 25;
const BUST_EVERY_SAVED = 200;
const BUST_EVERY_MS = 60_000;
const BUST_TIMEOUT_MS = 30_000;
const MAX_RECENT_ERRORS = 20;
/** Leer el catálogo guardado (cientos de MB) tarda segundos; si pasa de aquí, se sigue sin él. */
const CATALOG_LOAD_TIMEOUT_MS = 5 * 60_000;
/** Productos por llamada a Products/Details. */
const DETAILS_BATCH = 20;
/**
 * Si la API de Bihr (o su acceso) no responde, no es culpa de la marca ni del producto: se espera y se
 * reintenta el mismo producto (unos 14 min en total). Así una caída de Bihr no hace dejar marcas enteras.
 */
const OUTAGE_WAITS_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 300_000];

const defaultDeps: RepairJobDeps = {
  async loadItems(scope) {
    const audit = await getImageAudit({ refresh: true });
    const items = filterAuditItems(audit.items, { onlyInStock: scope === 'stock' });
    // También se descargan todas las demás fotos: los productos con la primera foto en local pero alguna
    // de las siguientes todavía en Bihr (la auditoría solo mira la primera, la que se ve en los listados).
    const seen = new Set(items.map((i) => i.id));
    const { rows } = await pool.query(
      `SELECT id, sku, name, brand, stock, family_code, jsonb_array_length(images) AS n FROM products
       WHERE status = 'published' AND price > 0 AND jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 1
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(images) WITH ORDINALITY AS e(img, i)
                     WHERE e.i > 1 AND coalesce(e.img->>'src', '') ~ '^https?://')
         ${scope === 'stock' ? 'AND stock > 0' : ''}`);
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      items.push({ id: r.id, sku: r.sku || '', name: r.name || '', brand: r.brand || '', stock: Number(r.stock) || 0, familyCode: r.family_code || '', problem: 'foto_remota', photos: Number(r.n) || 0, firstSrc: '' });
    }
    return items;
  },
  contested: contestedFileBases,
  productPictures: (codes) => bihrProductPictures(codes),
  catalogPictures: (skus) => loadCatalogPictures(skus),
  repair: repairProductImages,
  async bust() {
    await Promise.all([cacheBust('cache:products'), cacheBust('compat:prod'), cacheBust('cache:suggest')]);
  },
  async freeBytes() {
    try {
      const s = await fs.promises.statfs(path.join(UPLOADS_DIR, fs.existsSync(path.join(UPLOADS_DIR, 'optimized')) ? 'optimized' : ''));
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  },
};

const idleState = (): RepairJobState => ({
  status: 'idle', scope: 'stock', useApi: true, concurrency: DEFAULT_CONCURRENCY,
  total: 0, done: 0, saved: 0, savedFromLinks: 0, notFound: 0, failed: 0, skipped: 0, currentBrand: '', brands: {}, recentErrors: [],
});

let state: RepairJobState = idleState();
let control = { stop: false };

export function getRepairJobState(): RepairJobState { return state; }

export function isRepairJobActive(): boolean { return state.status === 'running' || state.status === 'stopping'; }

/** Pide parar: cada trabajador acaba el producto que tiene entre manos y no coge otro. */
export function stopRepairJob(): RepairJobState {
  if (isRepairJobActive()) {
    control.stop = true;
    state.status = 'stopping';
  }
  return state;
}

/** Con stock primero y, dentro de cada tanda, marca a marca (las que más productos tienen antes). */
export function orderQueue(items: ImageAuditItem[]): ImageAuditItem[] {
  const pass = (list: ImageAuditItem[]) => {
    const byBrand = new Map<string, ImageAuditItem[]>();
    for (const item of list) {
      const group = byBrand.get(item.brand);
      if (group) group.push(item); else byBrand.set(item.brand, [item]);
    }
    return [...byBrand.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .flatMap(([, group]) => group.sort((a, b) => a.id - b.id));
  };
  return [...pass(items.filter((i) => i.stock > 0)), ...pass(items.filter((i) => i.stock <= 0))];
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Para que una llamada que no contesta no deje el trabajo en «en marcha» para siempre. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: sin respuesta en ${ms / 1000} s`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Lanza la descarga en bloque y devuelve enseguida; el trabajo sigue en segundo plano. */
export async function startRepairJob(
  opts: { scope?: unknown; useApi?: unknown; concurrency?: unknown } = {},
  deps: RepairJobDeps = defaultDeps,
): Promise<RepairJobState> {
  if (isRepairJobActive()) throw new RepairJobBusy();
  const scope: RepairJobScope = opts.scope === 'all' ? 'all' : 'stock';
  const useApi = opts.useApi !== false;
  const concurrency = Math.min(Math.max(Math.floor(Number(opts.concurrency)) || DEFAULT_CONCURRENCY, 1), MAX_CONCURRENCY);
  const job: RepairJobState = { ...idleState(), status: 'running', scope, useApi, concurrency, startedAt: new Date().toISOString(), message: 'Revisando el catálogo…' };
  state = job;
  control = { stop: false };
  run(job, control, deps).catch((err) => {
    console.error('[IMAGE REPAIR JOB ERROR]:', err);
    job.status = 'error';
    job.message = messageOf(err);
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

async function run(job: RepairJobState, ctl: { stop: boolean }, deps: RepairJobDeps): Promise<void> {
  const stoppedBeforeStart = () => {
    if (!ctl.stop) return false;
    job.status = 'stopped';
    job.message = 'Parado a petición';
    job.finishedAt = new Date().toISOString();
    return true;
  };
  const items = await deps.loadItems(job.scope);
  if (stoppedBeforeStart()) return;
  const contested = await deps.contested();
  if (stoppedBeforeStart()) return;
  const queue = orderQueue(items);
  job.total = queue.length;
  for (const item of queue) {
    const b = (job.brands[item.brand] ||= { total: 0, done: 0, saved: 0, notFound: 0, failed: 0, skipped: 0 });
    b.total++;
  }
  job.message = queue.length === 0 ? 'No hay productos que descargar' : undefined;
  console.log(`[IMAGE REPAIR JOB] empieza: ${queue.length} productos (${job.scope}), concurrencia ${job.concurrency}, API ${job.useApi ? 'sí' : 'no'}`);

  // Enlaces actuales de las fotos en el catálogo de Bihr guardado; si no se pueden leer, se sigue sin ellos.
  let catalogUrls: ReadonlyMap<string, string> | undefined;
  let catalogNote: string | undefined;
  if (queue.length > 0) {
    job.message = 'Leyendo el catálogo de Bihr guardado…';
    try {
      const catalog = await withTimeout(deps.catalogPictures(queue.map((i) => i.sku)), CATALOG_LOAD_TIMEOUT_MS, 'leer el catálogo de Bihr');
      if (catalog) {
        catalogUrls = catalog.urls;
        job.catalog = { modifiedAt: catalog.modifiedAt, refs: catalog.refs, withPictures: catalog.withPictures, unmatched: catalog.unmatched, forQueue: catalog.urls.size, pictureFields: catalog.pictureFields };
        console.log(`[IMAGE REPAIR JOB] catálogo de Bihr (${catalog.modifiedAt}): ${catalog.refs} referencias, ${catalog.withPictures} con foto (${catalog.unmatched} descartadas), ${catalog.urls.size} de la cola`);
      } else {
        job.catalog = null;
        console.warn('[IMAGE REPAIR JOB] no hay catálogo de Bihr guardado; solo se usan los enlaces de las fichas');
      }
    } catch (err) {
      job.catalog = null;
      console.error('[IMAGE REPAIR JOB] no se pudo leer el catálogo de Bihr guardado:', messageOf(err));
      catalogNote = `No se pudo leer el catálogo de Bihr guardado (${messageOf(err)}); se usaron solo los enlaces de las fichas.`;
    }
    if (stoppedBeforeStart()) return;
    job.message = catalogNote;
  }

  const sources: RepairSource[] = job.useApi ? ['detalles', 'catalogo'] : ['catalogo'];

  // Products/Details se pide por tandas de 20 productos de la cola (una llamada en vez de veinte). Solo se guardan las
  // tandas cercanas a la que se está tratando, para no acumular los enlaces de toda la cola.
  type DetailsChunk = { asked: Set<string>; result: Promise<Map<string, string[]> | Error> };
  const detailsChunks = new Map<number, DetailsChunk>();
  const detailsChunk = (chunk: number): DetailsChunk => {
    let c = detailsChunks.get(chunk);
    if (!c) {
      const skus = queue.slice(chunk * DETAILS_BATCH, (chunk + 1) * DETAILS_BATCH).map((i) => i.sku.trim()).filter(Boolean);
      c = {
        asked: new Set(skus.map((x) => x.toLowerCase())),
        result: deps.productPictures(skus).catch((err) => (err instanceof Error ? err : new Error(String(err)))),
      };
      detailsChunks.set(chunk, c);
    }
    return c;
  };
  const detailsLookupFor = (index: number): RepairOptions['detailsLookup'] => async (codes) => {
    const chunk = Math.floor(index / DETAILS_BATCH);
    for (const old of [...detailsChunks.keys()]) if (old < chunk - 2) detailsChunks.delete(old);
    const c = detailsChunk(chunk);
    const loaded = await c.result;
    if (loaded instanceof Error) throw loaded;
    for (const code of codes) { const urls = loaded.get(code.toLowerCase()); if (urls?.length) return urls; }
    // Los códigos que no iban en la tanda (el número de pieza no es el SKU) se piden aparte.
    const extra = codes.filter((code) => !c.asked.has(code.toLowerCase()));
    if (extra.length > 0) {
      const found = await deps.productPictures(extra);
      for (const code of extra) { const urls = found.get(code.toLowerCase()); if (urls?.length) return urls; }
    }
    return [];
  };
  const deadBrands = new Set<string>();
  const brandStreak = new Map<string, number>();
  let streak = 0;
  let fatal: string | null = null;
  let next = 0;
  let savedSinceBust = 0;
  let lastBustAt = Date.now();
  let busting: Promise<void> | null = null;

  const stopAll = (why: string) => { if (!fatal) { fatal = why; ctl.stop = true; } };

  /** Vacía las cachés de la tienda cada 200 productos con foto nueva o cada minuto (siempre, al acabar). */
  const flushCaches = (force: boolean): Promise<void> => {
    if (savedSinceBust === 0 || (busting && !force)) return busting ?? Promise.resolve();
    if (!force && savedSinceBust < BUST_EVERY_SAVED && Date.now() - lastBustAt < BUST_EVERY_MS) return Promise.resolve();
    savedSinceBust = 0;
    lastBustAt = Date.now();
    const done: Promise<void> = (busting ?? Promise.resolve())
      .then(() => withTimeout(deps.bust(), BUST_TIMEOUT_MS, 'vaciar la caché'))
      .catch((e) => console.error('[IMAGE REPAIR JOB] no se pudo vaciar la caché:', e?.message))
      .finally(() => { if (busting === done) busting = null; });
    busting = done;
    return done;
  };

  /** La API de Bihr no respondió (Products/Details o su acceso): fallo de Bihr, no de la marca ni del producto. */
  const apiOutage = (r: RepairResult) => {
    if (r.outcome !== 'error' || r.errorScope !== 'service') return false;
    const worst = r.attempts.find((a) => !a.ok && `${a.source}: ${a.detail}` === r.reason);
    return worst?.source === 'detalles' && worst.target === 'Products/Details';
  };
  /** Espera que se corta si se pide parar. */
  const pause = async (ms: number) => {
    const until = Date.now() + ms;
    while (!ctl.stop && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
  };

  const fail = (item: ImageAuditItem, message: string) => {
    const b = job.brands[item.brand];
    b.lastError = message;
    job.recentErrors.push({ id: item.id, sku: item.sku, brand: item.brand, message });
    if (job.recentErrors.length > MAX_RECENT_ERRORS) job.recentErrors.shift();
  };

  const handle = async (item: ImageAuditItem, index: number) => {
    const b = job.brands[item.brand];
    job.currentBrand = item.brand;
    if (deadBrands.has(item.brand)) { job.skipped++; b.skipped++; return; }

    let result: RepairResult | null = null;
    let thrown: string | null = null;
    const waits = deps.outageWaitsMs ?? OUTAGE_WAITS_MS;
    for (let attempt = 0; ; attempt++) {
      result = null; thrown = null;
      try {
        result = await deps.repair(item.id, { sources, exactCodes: true, contested, catalogUrls, detailsLookup: detailsLookupFor(index), refreshStaleIndex: false });
      } catch (err) {
        thrown = messageOf(err);
      }
      if (!result || !apiOutage(result) || attempt >= waits.length || ctl.stop) break;
      const wait = waits[attempt];
      job.message = `La API de Bihr no responde (${result.reason}); se reintenta en ${Math.round(wait / 1000)} s…`;
      if (attempt === 0) console.warn(`[IMAGE REPAIR JOB] la API de Bihr no responde (${result.reason}); se reintenta`);
      await pause(wait);
      // La tanda guardada tiene el error: se vuelve a pedir.
      detailsChunks.delete(Math.floor(index / DETAILS_BATCH));
    }
    if (job.message?.startsWith('La API de Bihr no responde')) job.message = catalogNote;

    if (thrown !== null) {
      if (/Ya se están descargando/.test(thrown)) { job.skipped++; b.skipped++; return; }
      // Problemas de la ficha o cambios mientras se descargaba: de ese producto, no de la descarga.
      job.failed++; b.failed++;
      fail(item, thrown);
      if (!/no tiene SKU|no encontrado|formato de las fotos|cambió mientras/.test(thrown)) streak++;
      return;
    }
    switch (result!.outcome) {
      case 'saved':
        job.saved++; b.saved++;
        if (result!.attempts.some((a) => a.source === 'catalogo' && a.ok)) job.savedFromLinks++;
        streak = 0; brandStreak.set(item.brand, 0); savedSinceBust++; break;
      case 'nothing_to_do': job.skipped++; b.skipped++; streak = 0; break;
      case 'not_found': job.notFound++; b.notFound++; streak = 0; brandStreak.set(item.brand, 0); break;
      default: {
        job.failed++; b.failed++;
        const why = result!.reason || result!.attempts.filter((a) => !a.ok).map((a) => `${a.source}: ${a.detail}`).pop() || 'error desconocido';
        fail(item, why);
        // Que la foto de este producto no sirva (dañada, el procesador la rechaza) no dice nada de la fuente.
        if (result!.errorScope === 'product') break;
        streak++;
        // Bihr siguió sin responder tras las esperas: cuenta para parar el trabajo, no para dejar la marca.
        if (apiOutage(result!)) break;
        const brandFails = (brandStreak.get(item.brand) || 0) + 1;
        brandStreak.set(item.brand, brandFails);
        if (brandFails >= BRAND_FAILURE_LIMIT && !deadBrands.has(item.brand)) {
          deadBrands.add(item.brand);
          b.gaveUp = true;
          console.warn(`[IMAGE REPAIR JOB] se deja la marca ${item.brand}: ${brandFails} fallos seguidos (${why})`);
        }
      }
    }
  };

  const worker = async () => {
    while (!ctl.stop && next < queue.length) {
      const index = next++;
      const item = queue[index];
      try {
        await handle(item, index);
      } catch (err) {
        // Un fallo inesperado de la propia cola (no de la descarga) no debe dejar el trabajo a medias en silencio.
        console.error('[IMAGE REPAIR JOB] fallo inesperado:', err);
        job.failed++; job.brands[item.brand].failed++;
        fail(item, messageOf(err));
        streak++;
      }
      const n = ++job.done;
      job.brands[item.brand].done++;
      if (streak >= GLOBAL_FAILURE_LIMIT) stopAll(`Se paró tras ${streak} fallos seguidos; último: ${job.recentErrors[job.recentErrors.length - 1]?.message || 'desconocido'}`);
      if (n % 100 === 0) console.log(`[IMAGE REPAIR JOB] ${n}/${job.total} · con foto ${job.saved} · sin foto en Bihr ${job.notFound} · fallos ${job.failed}`);
      void flushCaches(false);
      if (n % DISK_CHECK_EVERY === 0) {
        const free = await deps.freeBytes();
        if (free !== null && free < MIN_FREE_BYTES) stopAll(`Se paró: quedan solo ${(free / 1024 ** 3).toFixed(1)} GB libres en el disco`);
      }
    }
  };

  await Promise.all(Array.from({ length: job.concurrency }, worker));
  await flushCaches(true);
  invalidateImageAudit();

  job.finishedAt = new Date().toISOString();
  if (fatal) { job.status = 'error'; job.message = fatal; }
  else if (ctl.stop) { job.status = 'stopped'; job.message = 'Parado a petición'; }
  else {
    job.status = 'done';
    const gaveUp = Object.keys(job.brands).filter((name) => job.brands[name].gaveUp);
    const names = gaveUp.length > 5 ? `${gaveUp.slice(0, 5).join(', ')} y ${gaveUp.length - 5} más` : gaveUp.join(', ');
    const gaveUpNote = gaveUp.length
      ? `Terminado, pero ${gaveUp.length === 1 ? 'se dejó a medias la marca' : 'se dejaron a medias las marcas'} ${names} por fallos seguidos. Vuelve a lanzar la descarga para reintentarlas.`
      : undefined;
    job.message = [gaveUpNote, catalogNote].filter(Boolean).join(' ') || undefined;
  }
  console.log(`[IMAGE REPAIR JOB] ${job.status}: ${job.done}/${job.total} · con foto ${job.saved} · sin foto en Bihr ${job.notFound} · fallos ${job.failed} · saltados ${job.skipped}`);
}
