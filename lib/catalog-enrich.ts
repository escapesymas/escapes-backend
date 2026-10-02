/**
 * Enriquecimiento del catálogo de Bihr: variantes, atributos y duplicados.
 *
 * Fuentes:
 *   - JSON de la API de Bihr (Catalog/GeneratedFile): relaciona ProductCode
 *     (el SKU con el que la tienda vende y pide a Bihr) con NewPartNumber.
 *     Trae también Size/Color para parte de la ropa.
 *   - CSV "cat-extended-full" de Bihr (catalog-csv/): por PartNumber, columnas
 *     V-* (ejes de la variante: talla, color, nº de dientes…), nombre original
 *     en inglés y atributos (homologación, composición…).
 *
 * Reglas (verificadas sobre el catálogo completo):
 *   - Un número de pieza de 10 dígitos es siempre una variante; sus 7
 *     primeros dígitos identifican el modelo (family_code).
 *   - Las fichas cuyo SKU es el NewPartNumber de otra ficha publicada son
 *     duplicados de importaciones antiguas por CSV: se marcan
 *     status='duplicate' con duplicate_of → ficha canónica (ProductCode).
 */
import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';

export interface BihrRefLite {
  productCode: string;
  partNumber: string;
  size?: string;
  color?: string;
}

interface CsvInfo {
  nameEn: string;
  /** Nombre en español (columna Designation) */
  nameEs: string;
  variant: Record<string, string>;
  attrs: Record<string, string>;
}

// Columnas V-* → nombre del eje que verá el cliente.
const VARIANT_KEY_MAP: Record<string, string> = {
  'V-Talla': 'Talla',
  'V-Size': 'Talla',
  'V-Talla para hombre': 'Talla',
  'V-Talla para mujer': 'Talla',
  'V-Talla de calzado': 'Talla',
  'V-Men Pants Size': 'Talla',
  'V-Youth Pants Size': 'Talla',
  'V-Color': 'Color',
  'V-Colores': 'Color',
  'V-Tamaño': 'Tamaño',
};

// Atributos útiles para filtrar (no son ejes de variante).
const FILTER_ATTRS = [
  'Homologación', 'Composición', 'Tipo de cierre', 'Estilo de casco', 'Modelo de casco',
  'Estilo de pintura', 'Acabado de la pintura', 'Colección', 'Uso', 'Gama',
  'Tipo de pieza de repuesto', 'Color de la lente', 'Interior desmontable',
];

export function normalizeVariantOptions(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const value = String(v ?? '').trim();
    if (!value || !k.startsWith('V-') || k === 'V-') continue;
    const key = VARIANT_KEY_MAP[k] || k.slice(2).trim();
    if (!key || out[key]) continue;
    out[key] = key === 'Talla' ? value.toUpperCase().replace(/\s+/g, '') : value;
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Lee todos los CSV de Bihr de un directorio (maneja campos con saltos de línea). */
export function loadCsvIndex(csvDir: string): Map<string, CsvInfo> {
  const index = new Map<string, CsvInfo>();
  if (!csvDir || !fs.existsSync(csvDir)) return index;
  for (const file of fs.readdirSync(csvDir).filter((f) => f.toLowerCase().endsWith('.csv'))) {
    const text = fs.readFileSync(path.join(csvDir, file), 'utf-8');
    // Reunir líneas físicas en registros lógicos (comillas balanceadas).
    const records: string[] = [];
    let buf = '';
    for (const line of text.split(/\r?\n/)) {
      buf = buf ? `${buf}\n${line}` : line;
      if (((buf.match(/"/g) || []).length % 2) === 0) { records.push(buf); buf = ''; }
    }
    if (records.length < 2) continue;
    const header = parseCsvLine(records[0]);
    const idx = (name: string) => header.indexOf(name);
    const iPn = idx('PartNumber');
    const iName = idx('ProductName');
    const iEs = idx('Designation');
    if (iPn < 0) continue;
    for (let r = 1; r < records.length; r++) {
      if (!records[r]) continue;
      const cols = parseCsvLine(records[r]);
      const pn = cols[iPn];
      if (!pn) continue;
      const raw: Record<string, string> = {};
      header.forEach((h, i) => { if (h.startsWith('V-')) raw[h] = cols[i]; });
      const attrs: Record<string, string> = {};
      for (const a of FILTER_ATTRS) {
        const i = idx(a);
        if (i >= 0 && cols[i]) attrs[a] = cols[i].trim();
      }
      index.set(pn, {
        nameEn: iName >= 0 ? cols[iName] : '',
        nameEs: iEs >= 0 ? (cols[iEs] || '').trim() : '',
        variant: normalizeVariantOptions(raw),
        attrs,
      });
    }
  }
  return index;
}

export interface EnrichStats {
  matched: number;
  withVariants: number;
  duplicates: number;
  imagesCopied: number;
  compatCopied: number;
}

/**
 * Escribe part_number, family_code, variant_options, supplier_name y atributos
 * de filtro. Se puede llamar con todas las referencias del catálogo de Bihr.
 */
export async function applyEnrichment(refs: BihrRefLite[], csvIndex: Map<string, CsvInfo>): Promise<Pick<EnrichStats, 'matched' | 'withVariants'>> {
  // Cada referencia se aplica a la ficha con SKU = ProductCode y también a la
  // antigua con SKU = NewPartNumber (si existe), para que ambas compartan modelo.
  const rows: Array<[string, string, string, string, string, string]> = [];
  const covered = new Set<string>();
  let withVariants = 0;
  const pushRow = (sku: string, partNumber: string, csv: CsvInfo | undefined, variant: Record<string, string>) => {
    rows.push([sku, partNumber, JSON.stringify(variant), csv?.nameEn || '', JSON.stringify(csv?.attrs || {}), csv?.nameEs || '']);
    covered.add(sku);
  };
  for (const ref of refs) {
    if (!ref.partNumber) continue;
    const csv = csvIndex.get(ref.partNumber);
    let variant = csv?.variant || {};
    if (Object.keys(variant).length === 0 && (ref.size || ref.color)) {
      variant = normalizeVariantOptions({ 'V-Talla': ref.size, 'V-Color': ref.color });
    }
    if (Object.keys(variant).length) withVariants++;
    pushRow(ref.productCode, ref.partNumber, csv, variant);
    if (ref.partNumber !== ref.productCode) pushRow(ref.partNumber, ref.partNumber, csv, variant);
  }
  // Productos que solo están en el CSV (SKU = PartNumber): mismo tratamiento.
  for (const [pn, csv] of csvIndex) {
    if (covered.has(pn)) continue;
    if (Object.keys(csv.variant).length) withVariants++;
    pushRow(pn, pn, csv, csv.variant);
  }

  let matched = 0;
  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await pool.query(
      `UPDATE products p SET
         part_number = v.pn,
         family_code = CASE WHEN v.pn ~ '^[0-9]{10}$' THEN left(v.pn, 7) ELSE p.sku END,
         variant_options = NULLIF(v.vo::jsonb, '{}'::jsonb),
         supplier_name = NULLIF(v.en, ''),
         -- El nombre abreviado en inglés del proveedor se sustituye por el español.
         name = CASE WHEN v.es <> '' AND (p.name = v.en OR p.name ~ '^[A-Z0-9 ,./()&+-]+$') THEN v.es ELSE p.name END,
         attributes = (CASE WHEN jsonb_typeof(p.attributes) = 'object' THEN p.attributes ELSE '{}'::jsonb END)
                      || v.attrs::jsonb || COALESCE(NULLIF(v.vo::jsonb, '{}'::jsonb), '{}'::jsonb)
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS v(sku, pn, vo, en, attrs, es)
       WHERE p.sku = v.sku
         -- Solo filas que cambian: las re-ejecuciones tras cada importación
         -- no reescriben (ni re-indexan) todo el catálogo.
         AND (p.part_number IS DISTINCT FROM v.pn
           OR p.variant_options IS DISTINCT FROM NULLIF(v.vo::jsonb, '{}'::jsonb)
           OR p.supplier_name IS DISTINCT FROM NULLIF(v.en, '')
           OR NOT (CASE WHEN jsonb_typeof(p.attributes) = 'object' THEN p.attributes ELSE '{}'::jsonb END) @> v.attrs::jsonb
           OR (v.es <> '' AND p.name <> v.es AND (p.name = v.en OR p.name ~ '^[A-Z0-9 ,./()&+-]+$')))`,
      [0, 1, 2, 3, 4, 5].map((i) => chunk.map((r) => r[i]))
    );
    matched += res.rowCount || 0;
  }
  return { matched, withVariants };
}

/**
 * Marca como duplicadas las fichas cuyo SKU es el número de pieza de otra
 * ficha publicada, y pasa a la canónica las imágenes y compatibilidades que
 * le falten. No borra nada.
 */
export async function markDuplicates(): Promise<Pick<EnrichStats, 'duplicates' | 'imagesCopied' | 'compatCopied'>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(`
      UPDATE products d SET status = 'duplicate', duplicate_of = c.id, updated_at = NOW()
      FROM products c
      WHERE c.part_number = d.sku AND c.sku <> d.sku AND c.id <> d.id
        AND c.status = 'published' AND d.status = 'published'
    `);
    const img = await client.query(`
      UPDATE products c SET images = d.images
      FROM products d
      WHERE d.duplicate_of = c.id
        AND COALESCE(c.images::text, '') IN ('', '[]', 'null', '""')
        AND COALESCE(d.images::text, '') NOT IN ('', '[]', 'null', '""')
    `);
    const compat = await client.query(`
      UPDATE products c SET compatibility = d.compatibility
      FROM products d
      WHERE d.duplicate_of = c.id
        AND (c.compatibility IS NULL OR c.compatibility = '[]'::jsonb)
        AND d.compatibility IS NOT NULL AND d.compatibility <> '[]'::jsonb
    `);
    await client.query('COMMIT');
    return { duplicates: dup.rowCount || 0, imagesCopied: img.rowCount || 0, compatCopied: compat.rowCount || 0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Lee el JSON de la API de Bihr y devuelve las referencias mínimas. */
export function loadBihrApiRefs(jsonPath: string): BihrRefLite[] {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const list: any[] = data.Products || data.References || [];
  return list
    .filter((p) => p.ProductCode && p.NewPartNumber)
    .map((p) => ({ productCode: String(p.ProductCode), partNumber: String(p.NewPartNumber), size: p.Size, color: p.Color }));
}

export async function enrichCatalog(jsonPath: string, csvDir: string): Promise<EnrichStats> {
  const refs = loadBihrApiRefs(jsonPath);
  const csvIndex = loadCsvIndex(csvDir);
  console.log(`[ENRICH] ${refs.length} referencias de la API, ${csvIndex.size} filas de CSV`);
  const a = await applyEnrichment(refs, csvIndex);
  const b = await markDuplicates();
  return { ...a, ...b };
}
