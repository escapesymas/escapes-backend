/**
 * Enlaces de foto del último catálogo JSON de Bihr que guardó el servidor (bihrService.ts).
 *
 * El enlace de una foto de Bihr (`api.mybihr.com/medias/{código}-1-800Wx800H?context=…`) lleva firmada la
 * ruta del fichero: cambiar solo la referencia sirve la foto del otro producto. Cada producto necesita su
 * propio enlace, y los de los CSV antiguos pueden haber caducado; el catálogo JSON que se descarga con la
 * API trae el actual (`DefaultPicture`).
 *
 * El fichero es enorme y se lee entero, así que se hace en un hilo aparte: no bloquea la tienda mientras
 * tanto y, si se acaba la memoria, cae el hilo y no el servidor.
 */
import fs from 'fs';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';

export const LATEST_CATALOG_JSON = process.env.BIHR_LATEST_CATALOG_JSON || '/app/server/uploads/bihr-catalog-latest.json';

export interface CatalogPictures {
  /** ProductCode (el SKU de la tienda) → enlace de su foto principal. */
  urls: Map<string, string>;
  /** Referencias del catálogo y cuántas traen enlace de foto. */
  refs: number;
  withPictures: number;
  /** Enlaces descartados porque el nombre de la foto no lleva el código del producto (foto genérica o de otra pieza). */
  unmatched: number;
  /** Campos del catálogo con aspecto de foto, para saber qué trae si no sale lo esperado. */
  pictureFields: string[];
  /** Cuándo se guardó ese catálogo. */
  modifiedAt: string;
}

const FIELD_SAMPLE = 500;
const PICTURE_FIELD = /pic|image|photo|media|foto/i;
const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v.trim());

/** Enlace de la foto principal de una referencia del catálogo. */
export function mainPictureUrl(ref: any): string | undefined {
  const v = isUrl(ref?.DefaultPicture) ? ref.DefaultPicture : ref?.Picture1;
  return isUrl(v) ? v.trim() : undefined;
}

/**
 * ¿El nombre del fichero del enlace lleva el código del producto? (`1008253-1-800Wx800H` o `800Wx800H-1008253-1.jpg`).
 * Evita guardar una foto genérica («sin imagen») o la de otra pieza que el catálogo repita en varias referencias.
 */
export function urlMatchesCode(url: string, code: string): boolean {
  try {
    const file = decodeURIComponent(new URL(url).pathname.split('/').pop() || '').toLowerCase();
    const escaped = code.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[-_])${escaped}([-_.]|$)`).test(file);
  } catch {
    return false;
  }
}

/** `wanted`: solo se guardan esos códigos (la tabla entera ocuparía cientos de MB). */
export function parseCatalogPictures(text: string, wanted?: ReadonlySet<string>): Omit<CatalogPictures, 'modifiedAt'> {
  const data = JSON.parse(text);
  const list: any[] = data.Products || data.References || [];
  const urls = new Map<string, string>();
  const fields = new Set<string>();
  let withPictures = 0;
  let unmatched = 0;
  list.forEach((ref, i) => {
    if (i < FIELD_SAMPLE && ref && typeof ref === 'object') for (const k of Object.keys(ref)) if (PICTURE_FIELD.test(k)) fields.add(k);
    const url = mainPictureUrl(ref);
    if (!url) return;
    withPictures++;
    const code = String(ref.ProductCode || '').trim();
    if (!code) return;
    if (!urlMatchesCode(url, code)) { unmatched++; return; }
    if (!wanted || wanted.has(code)) urls.set(code, url);
  });
  return { urls, refs: list.length, withPictures, unmatched, pictureFields: [...fields].sort() };
}

export function readCatalogPictures(file: string, wanted?: ReadonlySet<string>): CatalogPictures {
  const modifiedAt = fs.statSync(file).mtime.toISOString();
  return { ...parseCatalogPictures(fs.readFileSync(file, 'utf-8'), wanted), modifiedAt };
}

/** Lee el catálogo en un hilo aparte. `null` si no hay catálogo guardado. */
export function loadCatalogPictures(wanted?: readonly string[], file = LATEST_CATALOG_JSON): Promise<CatalogPictures | null> {
  if (!fs.existsSync(file)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { catalogPicturesTask: true, file, wanted } });
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    worker.once('message', (m: { ok: boolean; result?: any; error?: string }) => finish(() => {
      if (!m.ok) return reject(new Error(m.error));
      resolve({ ...m.result, urls: new Map<string, string>(m.result.urls) });
    }));
    worker.once('error', (err: any) => finish(() => reject(new Error(err?.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? 'el catálogo de Bihr guardado es demasiado grande para leerlo (memoria)' : (err?.message || String(err))))));
    worker.once('exit', () => finish(() => reject(new Error('se cerró la lectura del catálogo sin respuesta'))));
  });
}

if (!isMainThread && workerData?.catalogPicturesTask) {
  try {
    const wanted = workerData.wanted ? new Set<string>(workerData.wanted) : undefined;
    const result = readCatalogPictures(workerData.file, wanted);
    parentPort!.postMessage({ ok: true, result: { ...result, urls: [...result.urls] } });
  } catch (err: any) {
    parentPort!.postMessage({ ok: false, error: err?.message || String(err) });
  }
}
