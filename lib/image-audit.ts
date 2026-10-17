/**
 * Auditoría de fotos del catálogo: qué productos de la tienda se ven sin imagen.
 *
 * Mira la primera foto de cada producto publicado (la que enseñan el listado, la
 * ficha, el carrito y el carrusel de TikTok) con las mismas reglas que
 * `mapProductToFrontend` (routes/catalog.ts):
 *   - `sin_foto`: la ficha no tiene fotos o la primera no trae dirección.
 *   - `fichero_perdido`: apunta a /uploads/... pero el fichero no está en disco.
 *   - `foto_remota`: solo una URL remota (CDN de Bihr) sin copia local; la tienda la
 *     pide por /api/image-proxy y, si Bihr no contesta, enseña «Imagen no disponible».
 *     No se pide a Bihr para comprobarlo: es el caso que arregla «Descargar fotos de Bihr».
 */
import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';

export type ImageProblem = 'sin_foto' | 'foto_remota' | 'fichero_perdido';
export const IMAGE_PROBLEMS: readonly ImageProblem[] = ['sin_foto', 'foto_remota', 'fichero_perdido'];

export interface ImageAuditItem {
  id: number;
  sku: string;
  name: string;
  brand: string;
  stock: number;
  familyCode: string;
  problem: ImageProblem;
  /** Fotos que tiene la ficha. */
  photos: number;
  /** Dirección de la primera foto, sin la parte firmada. */
  firstSrc: string;
}

export interface ImageAuditSummary {
  scannedAt: string;
  /** Productos publicados de la tienda. */
  total: number;
  conFoto: number;
  sinImagen: number;
  sinImagenConStock: number;
  porProblema: Record<ImageProblem, { total: number; conStock: number }>;
}

export interface ImageAudit { summary: ImageAuditSummary; items: ImageAuditItem[] }

/** Qué ficheros hay en /uploads (el listado de /uploads/optimized se lee una vez). */
export interface DiskIndex { has(relativePath: string): boolean }

const BATCH = 2000;
const CACHE_TTL_MS = 10 * 60_000;
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

/** Misma limpieza del SKU que usa routes/catalog.ts para el nombre de fichero antiguo `{SKU}-800.webp`. */
const legacyFileName = (sku: string) => `${sku.replace(/[^a-zA-Z0-9_-]/g, '_')}-800.webp`;

const srcOf = (img: unknown): string => {
  if (typeof img === 'string') return img;
  const o = img as { src?: unknown; url?: unknown } | null;
  const s = o?.src || o?.url;
  return typeof s === 'string' ? s : '';
};

/** Dirección sin la parte firmada (?context=...), para enseñarla en el informe. */
const shortSrc = (src: string): string => {
  try { const u = new URL(src); return `${u.host}${u.pathname}`.slice(0, 160); } catch { return src.split('?')[0].slice(0, 160); }
};

export function classifyFirstImage(first: unknown, sku: string | null, disk: DiskIndex): { problem: ImageProblem | null; src: string } {
  const src = srcOf(first).trim();
  if (!src) return { problem: 'sin_foto', src: '' };
  const at = src.indexOf('/uploads/');
  if (at >= 0) {
    let rel = src.slice(at + '/uploads/'.length).split(/[?#]/)[0];
    try { rel = decodeURIComponent(rel); } catch { /* se queda como viene */ }
    return { problem: disk.has(rel) ? null : 'fichero_perdido', src };
  }
  // Foto remota: la tienda la cambia por la copia antigua `{SKU}-800.webp` si existe.
  if (sku && disk.has(`optimized/${legacyFileName(sku)}`)) return { problem: null, src };
  return { problem: 'foto_remota', src };
}

/** Lee la carpeta de fotos una vez; falla si no se puede, para no dar por perdidas todas las fotos. */
export async function loadDiskIndex(uploadsDir = UPLOADS_DIR): Promise<DiskIndex> {
  let names: string[];
  try {
    names = await fs.promises.readdir(path.join(uploadsDir, 'optimized'));
  } catch (err: any) {
    throw new Error(`No se puede leer la carpeta de fotos (${err.code || err.message}); no se puede comprobar qué fotos existen`);
  }
  const optimized = new Set(names);
  const root = path.resolve(uploadsDir) + path.sep;
  return {
    has(rel) {
      if (rel.startsWith('optimized/') && !rel.includes('/', 'optimized/'.length)) return optimized.has(rel.slice('optimized/'.length));
      const file = path.resolve(uploadsDir, rel);
      return file.startsWith(root) && fs.existsSync(file);
    },
  };
}

interface ProductImageRow {
  id: number; sku: string | null; name: string | null; brand: string | null; stock: number | null; family_code: string | null;
  kind: string | null; n: number | null; first: unknown;
}

/** Solo trae la primera foto de cada producto: lo demás no hace falta y la tabla es grande. */
const SELECT_ROWS = `
  SELECT id, sku, name, brand, stock, family_code, jsonb_typeof(images) AS kind,
         CASE jsonb_typeof(images) WHEN 'array' THEN jsonb_array_length(images) END AS n,
         CASE jsonb_typeof(images) WHEN 'array' THEN images -> 0 ELSE images END AS first
  FROM products`;
const SHOP_FILTER = `status = 'published' AND price > 0`;

function toItem(row: ProductImageRow, disk: DiskIndex): ImageAuditItem | null {
  let first = row.first;
  let photos = row.n ?? 0;
  if (row.kind === 'string' && typeof first === 'string') {
    // Fichas antiguas con la lista guardada como texto JSON.
    try { const list = JSON.parse(first); if (Array.isArray(list)) { first = list[0]; photos = list.length; } } catch { first = null; }
  } else if (row.kind !== 'array') {
    first = null;
    photos = 0;
  }
  const { problem, src } = classifyFirstImage(first, row.sku, disk);
  if (!problem) return null;
  return {
    id: row.id, sku: row.sku || '', name: row.name || '', brand: row.brand || '', stock: Number(row.stock) || 0,
    familyCode: row.family_code || '', problem, photos, firstSrc: shortSrc(src),
  };
}

function emptySummary(scannedAt: string): ImageAuditSummary {
  return {
    scannedAt, total: 0, conFoto: 0, sinImagen: 0, sinImagenConStock: 0,
    porProblema: {
      sin_foto: { total: 0, conStock: 0 }, foto_remota: { total: 0, conStock: 0 }, fichero_perdido: { total: 0, conStock: 0 },
    },
  };
}

const byStockThenId = (a: ImageAuditItem, b: ImageAuditItem) => (b.stock > 0 ? 1 : 0) - (a.stock > 0 ? 1 : 0) || a.id - b.id;

function tally(summary: ImageAuditSummary, item: ImageAuditItem, sign: 1 | -1) {
  summary.sinImagen += sign;
  summary.porProblema[item.problem].total += sign;
  if (item.stock > 0) { summary.sinImagenConStock += sign; summary.porProblema[item.problem].conStock += sign; }
}

/** Recorre todos los productos publicados de la tienda (por lotes) y devuelve los que se ven sin imagen. */
export async function scanCatalogImages(uploadsDir = UPLOADS_DIR): Promise<ImageAudit> {
  const disk = await loadDiskIndex(uploadsDir);
  const summary = emptySummary(new Date().toISOString());
  const items: ImageAuditItem[] = [];
  let lastId = 0;
  for (;;) {
    const { rows } = await pool.query<ProductImageRow>(
      `${SELECT_ROWS} WHERE ${SHOP_FILTER} AND id > $1 ORDER BY id LIMIT $2`, [lastId, BATCH]);
    if (rows.length === 0) break;
    for (const row of rows) {
      summary.total++;
      const item = toItem(row, disk);
      if (item) { items.push(item); tally(summary, item, 1); } else summary.conFoto++;
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < BATCH) break;
  }
  items.sort(byStockThenId);
  return { summary, items };
}

let cached: { audit: ImageAudit; at: number } | null = null;
let inFlight: Promise<ImageAudit> | null = null;

/** El resultado se guarda 10 minutos: paginar o filtrar no vuelve a recorrer la tabla. */
export async function getImageAudit(opts: { refresh?: boolean; uploadsDir?: string } = {}): Promise<ImageAudit> {
  if (!opts.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.audit;
  if (!inFlight) {
    inFlight = scanCatalogImages(opts.uploadsDir)
      .then((audit) => { cached = { audit, at: Date.now() }; return audit; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Descarta el resultado guardado: la siguiente consulta vuelve a recorrer el catálogo. */
export function invalidateImageAudit(): void { cached = null; }

/** Tras descargar las fotos de un producto: vuelve a mirar solo ese producto y corrige el resultado guardado. */
export async function recheckProductImages(productId: number, uploadsDir = UPLOADS_DIR): Promise<void> {
  if (!cached) return;
  const audit = cached.audit;
  const disk = await loadDiskIndex(uploadsDir);
  const { rows } = await pool.query<ProductImageRow>(`${SELECT_ROWS} WHERE ${SHOP_FILTER} AND id = $1`, [productId]);
  const before = audit.items.findIndex((i) => i.id === productId);
  const after = rows[0] ? toItem(rows[0], disk) : null;
  if (before >= 0) {
    tally(audit.summary, audit.items[before], -1);
    audit.items.splice(before, 1);
    if (!after) audit.summary.conFoto++;
  } else if (after) {
    audit.summary.conFoto--;
  }
  if (after) {
    tally(audit.summary, after, 1);
    audit.items.push(after);
    audit.items.sort(byStockThenId);
  }
}

export interface ImageAuditQuery { problem?: string; q?: string; onlyInStock?: boolean }

export function filterAuditItems(items: ImageAuditItem[], { problem, q, onlyInStock }: ImageAuditQuery): ImageAuditItem[] {
  const term = (q || '').trim().toLowerCase();
  const wanted = IMAGE_PROBLEMS.includes(problem as ImageProblem) ? problem : '';
  return items.filter((i) =>
    (!wanted || i.problem === wanted) &&
    (!onlyInStock || i.stock > 0) &&
    (!term || `${i.sku} ${i.name} ${i.brand}`.toLowerCase().includes(term)));
}

const PROBLEM_LABEL: Record<ImageProblem, string> = {
  sin_foto: 'Sin foto',
  foto_remota: 'Solo foto remota de Bihr',
  fichero_perdido: 'Foto local que no está en disco',
};

/** Una celda de CSV; los textos que Excel leería como fórmula se escriben como texto. */
const csvCell = (v: string | number): string => {
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV con «;» y BOM para que Excel en español lo abra bien. */
export function auditToCsv(items: ImageAuditItem[], shopUrl = 'https://escapesymas.com'): string {
  const head = ['id', 'sku', 'producto', 'marca', 'stock', 'problema', 'fotos_en_ficha', 'primera_foto', 'familia', 'ficha_en_la_tienda'];
  const lines = items.map((i) => [
    i.id, i.sku, i.name, i.brand, i.stock, PROBLEM_LABEL[i.problem], i.photos, i.firstSrc, i.familyCode, `${shopUrl}/producto/${i.id}`,
  ].map(csvCell).join(';'));
  return `﻿${[head.join(';'), ...lines].join('\r\n')}\r\n`;
}
