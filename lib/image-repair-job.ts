/**
 * Descarga en bloque de las fotos de los productos que se ven sin imagen (lib/image-audit.ts).
 *
 * Es el botón «Descargar fotos de Bihr» de la ficha (lib/bihr-images.ts) aplicado a todos los
 * productos de la auditoría, uno tras otro y en segundo plano:
 *   - primero los productos con stock y, si se pide, después el resto;
 *   - agrupados por marca, para que el índice del zip de cada marca se lea una sola vez;
 *   - fuentes: el zip de la marca y, si no está ahí, la API de Bihr (más lenta: una petición cada 250 ms);
 *     la URL remota de la ficha no se prueba porque Bihr devuelve 404 (docs/BIHR_IMAGE_SOURCES.md);
 *   - solo con el número de pieza y el SKU, nunca con el código del fabricante (puede dar la foto de otra pieza).
 *
 * El estado vive en memoria: si se despliega una versión nueva el trabajo se corta, pero basta con
 * volver a lanzarlo, porque cada vuelta solo recoge los productos que siguen sin imagen.
 * Se para solo si hay fallos seguidos (algo no va: red, procesador de imágenes) o queda poco disco.
 */
import fs from 'fs';
import path from 'path';
import { getImageAudit, filterAuditItems, invalidateImageAudit, type ImageAuditItem } from './image-audit.js';
import { repairProductImages, contestedFileBases, type RepairOptions, type RepairResult, type RepairSource } from './bihr-images.js';
import { cacheBust } from './cache.js';

export type RepairJobScope = 'stock' | 'all';
export type RepairJobStatus = 'idle' | 'running' | 'stopping' | 'done' | 'stopped' | 'error';

export interface BrandStats { total: number; done: number; saved: number; notFound: number; failed: number; skipped: number; lastError?: string }
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
  /** La fuente funcionó pero no tiene la foto. */
  notFound: number;
  /** Alguna fuente falló (red, zip dañado, procesador de imágenes…). */
  failed: number;
  /** Ya tenían foto, otro proceso los estaba tratando o su marca se dejó de intentar. */
  skipped: number;
  currentBrand: string;
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
  repair(id: number, opts: RepairOptions): Promise<RepairResult>;
  /** Vacía las cachés de la tienda para que se vean las fotos nuevas. */
  bust(): Promise<void>;
  /** Espacio libre en el disco de las fotos, o null si no se sabe. */
  freeBytes(): Promise<number | null>;
}

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
export const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 6;
/** Fallos seguidos de una misma marca antes de dejarla (su zip no responde). */
const BRAND_FAILURE_LIMIT = 5;
/** Fallos seguidos, de cualquier marca, antes de parar todo. */
const GLOBAL_FAILURE_LIMIT = 40;
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const DISK_CHECK_EVERY = 25;
const BUST_EVERY_SAVED = 200;
const BUST_EVERY_MS = 60_000;
const MAX_RECENT_ERRORS = 20;

const defaultDeps: RepairJobDeps = {
  async loadItems(scope) {
    const audit = await getImageAudit({ refresh: true });
    return filterAuditItems(audit.items, { onlyInStock: scope === 'stock' });
  },
  contested: contestedFileBases,
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
  total: 0, done: 0, saved: 0, notFound: 0, failed: 0, skipped: 0, currentBrand: '', brands: {}, recentErrors: [],
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
  const items = await deps.loadItems(job.scope);
  const contested = await deps.contested();
  const queue = orderQueue(items);
  job.total = queue.length;
  for (const item of queue) {
    const b = (job.brands[item.brand] ||= { total: 0, done: 0, saved: 0, notFound: 0, failed: 0, skipped: 0 });
    b.total++;
  }
  job.message = queue.length === 0 ? 'No hay productos que descargar' : undefined;
  console.log(`[IMAGE REPAIR JOB] empieza: ${queue.length} productos (${job.scope}), concurrencia ${job.concurrency}, API ${job.useApi ? 'sí' : 'no'}`);

  const sources: RepairSource[] = job.useApi ? ['zip', 'api'] : ['zip'];
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
      .then(() => deps.bust())
      .catch((e) => console.error('[IMAGE REPAIR JOB] no se pudo vaciar la caché:', e?.message))
      .finally(() => { if (busting === done) busting = null; });
    busting = done;
    return done;
  };

  const fail = (item: ImageAuditItem, message: string) => {
    const b = job.brands[item.brand];
    b.lastError = message;
    job.recentErrors.push({ id: item.id, sku: item.sku, brand: item.brand, message });
    if (job.recentErrors.length > MAX_RECENT_ERRORS) job.recentErrors.shift();
  };

  const handle = async (item: ImageAuditItem) => {
    const b = job.brands[item.brand];
    job.currentBrand = item.brand;
    if (deadBrands.has(item.brand)) { job.skipped++; b.skipped++; return; }

    let result: RepairResult | null = null;
    let thrown: string | null = null;
    try {
      result = await deps.repair(item.id, { sources, exactCodes: true, contested });
    } catch (err) {
      thrown = messageOf(err);
    }

    if (thrown !== null) {
      if (/Ya se están descargando/.test(thrown)) { job.skipped++; b.skipped++; return; }
      // Problemas de la ficha o cambios mientras se descargaba: de ese producto, no de la descarga.
      job.failed++; b.failed++;
      fail(item, thrown);
      if (!/no tiene SKU|no encontrado|formato de las fotos|cambió mientras/.test(thrown)) streak++;
      return;
    }
    switch (result!.outcome) {
      case 'saved': job.saved++; b.saved++; streak = 0; brandStreak.set(item.brand, 0); savedSinceBust++; break;
      case 'nothing_to_do': job.skipped++; b.skipped++; streak = 0; break;
      case 'not_found': job.notFound++; b.notFound++; streak = 0; brandStreak.set(item.brand, 0); break;
      default: {
        job.failed++; b.failed++;
        const why = result!.attempts.filter((a) => !a.ok).map((a) => `${a.source}: ${a.detail}`).pop() || 'error desconocido';
        fail(item, why);
        streak++;
        const brandFails = (brandStreak.get(item.brand) || 0) + 1;
        brandStreak.set(item.brand, brandFails);
        if (brandFails >= BRAND_FAILURE_LIMIT && !deadBrands.has(item.brand)) {
          deadBrands.add(item.brand);
          console.warn(`[IMAGE REPAIR JOB] se deja la marca ${item.brand}: ${brandFails} fallos seguidos (${why})`);
        }
      }
    }
  };

  const worker = async () => {
    while (!ctl.stop && next < queue.length) {
      const item = queue[next++];
      try {
        await handle(item);
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
  else { job.status = 'done'; job.message = undefined; }
  console.log(`[IMAGE REPAIR JOB] ${job.status}: ${job.done}/${job.total} · con foto ${job.saved} · sin foto en Bihr ${job.notFound} · fallos ${job.failed} · saltados ${job.skipped}`);
}
