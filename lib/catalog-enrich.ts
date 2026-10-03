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
import { applyTyreAttributes } from './tyres.js';

export interface BihrRefLite {
  productCode: string;
  partNumber: string;
  size?: string;
  color?: string;
}

export interface CsvInfo {
  nameEn: string;
  /** Nombre en español (columna Designation) */
  nameEs: string;
  variant: Record<string, string>;
  attrs: Record<string, string>;
  /** Fotos del proveedor (Picture1…6), en orden */
  pictures: string[];
  /** Categorías de Bihr (Category2 / Category3, en inglés) */
  cat2: string;
  cat3: string;
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
  // En el catálogo de Bihr, V-Tamaño contiene tallas de ropa (S, M, L, UK40…).
  'V-Tamaño': 'Talla',
};

// Atributos útiles para filtrar (no son ejes de variante).
const FILTER_ATTRS = [
  'Homologación', 'Composición', 'Tipo de cierre', 'Estilo de casco', 'Modelo de casco',
  'Estilo de pintura', 'Acabado de la pintura', 'Colección', 'Uso', 'Gama',
  'Tipo de pieza de repuesto', 'Color de la lente', 'Interior desmontable',
  // Neumáticos (medida y ficha técnica; ver lib/tyres.ts)
  'Anchura del neumático', 'Altura del neumático (perfil)', 'Diámetro de la llanta', 'Posición',
  'Estructura de neumático', 'Índice de carga del neumático (IC)', 'Índice de velocidad (CV)',
  'Sin cámara o tipo de cámara', 'Categoría de neumático',
];

export function normalizeVariantOptions(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const value = String(v ?? '').trim();
    if (!value || !k.startsWith('V-') || k === 'V-') continue;
    const key = VARIANT_KEY_MAP[k] || k.slice(2).trim();
    if (!key || out[key]) continue;
    // Códigos cortos de talla en mayúsculas (s/m → S/M); textos como
    // "Talla única adulto" se dejan tal cual.
    out[key] = key === 'Talla' && value.length <= 7 && !/\s/.test(value) ? value.toUpperCase() : value;
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
      const pictures: string[] = [];
      for (let k = 1; k <= 6; k++) {
        const i = idx(`Picture${k}`);
        if (i >= 0 && /^https?:\/\//.test(cols[i] || '')) pictures.push(cols[i].trim());
      }
      const i2 = idx('Category2');
      const i3 = idx('Category3');
      index.set(pn, {
        cat2: i2 >= 0 ? (cols[i2] || '').trim().toUpperCase() : '',
        cat3: i3 >= 0 ? (cols[i3] || '').trim().toUpperCase() : '',
        pictures,
        nameEn: iName >= 0 ? cols[iName] : '',
        nameEs: iEs >= 0 ? (cols[iEs] || '').trim() : '',
        variant: normalizeVariantOptions(raw),
        attrs,
      });
    }
  }
  return index;
}

/** SQL: ¿la columna images tiene al menos una foto válida? (jsonb) */
const HAS_IMAGES = (col: string) =>
  `(jsonb_typeof(${col}) = 'array' AND jsonb_array_length(${col}) > 0 AND COALESCE(${col}->0->>'src', ${col}->>0, '') <> '')`;

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
  const rows: Array<[string, string, string, string, string, string, string]> = [];
  const covered = new Set<string>();
  let withVariants = 0;
  const pushRow = (sku: string, partNumber: string, csv: CsvInfo | undefined, variant: Record<string, string>) => {
    rows.push([sku, partNumber, JSON.stringify(variant), csv?.nameEn || '', JSON.stringify(csv?.attrs || {}), csv?.nameEs || '', JSON.stringify(csv?.pictures || [])]);
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
                      || v.attrs::jsonb || COALESCE(NULLIF(v.vo::jsonb, '{}'::jsonb), '{}'::jsonb),
         -- Galería: se conservan las fotos ya guardadas (la primera suele estar
         -- descargada y optimizada) y se añaden las demás del proveedor.
         images = CASE
           WHEN jsonb_array_length(v.pics::jsonb) = 0 THEN p.images
           WHEN NOT ${HAS_IMAGES('p.images')} THEN
             (SELECT jsonb_agg(jsonb_build_object('src', x, 'alt', p.name) ORDER BY i)
              FROM jsonb_array_elements_text(v.pics::jsonb) WITH ORDINALITY t(x, i))
           WHEN jsonb_array_length(v.pics::jsonb) > jsonb_array_length(p.images) THEN
             p.images || (SELECT jsonb_agg(jsonb_build_object('src', x, 'alt', p.name) ORDER BY i)
                          FROM jsonb_array_elements_text(v.pics::jsonb) WITH ORDINALITY t(x, i)
                          WHERE i > jsonb_array_length(p.images))
           ELSE p.images END
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS v(sku, pn, vo, en, attrs, es, pics)
       WHERE p.sku = v.sku
         -- Solo filas que cambian: las re-ejecuciones tras cada importación
         -- no reescriben (ni re-indexan) todo el catálogo.
         AND (p.part_number IS DISTINCT FROM v.pn
           OR p.variant_options IS DISTINCT FROM NULLIF(v.vo::jsonb, '{}'::jsonb)
           OR p.supplier_name IS DISTINCT FROM NULLIF(v.en, '')
           OR NOT (CASE WHEN jsonb_typeof(p.attributes) = 'object' THEN p.attributes ELSE '{}'::jsonb END) @> v.attrs::jsonb
           OR (v.es <> '' AND p.name <> v.es AND (p.name = v.en OR p.name ~ '^[A-Z0-9 ,./()&+-]+$'))
           OR (jsonb_array_length(v.pics::jsonb) > 0 AND (NOT ${HAS_IMAGES('p.images')}
               OR jsonb_array_length(v.pics::jsonb) > jsonb_array_length(p.images))))`,
      [0, 1, 2, 3, 4, 5, 6].map((i) => chunk.map((r) => r[i]))
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

const SIZE_TOKEN = /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|[A-Z]{0,2}\d{1,3}(\/[A-Z0-9]{1,4})?|Y?(XS|S|M|L|XL)|\d{1,2}\/[A-Z]{1,3})$/i;
const isAllCaps = (s: string) => /^[A-Z0-9 ,./()&+'-]+$/.test(s);

// Abreviaturas de color en los nombres del proveedor (respaldo cuando el modelo
// no tiene ninguna hermana de ese color de la que aprenderlo).
const COLOR_CODES: Record<string, string> = {
  BLK: 'Negro', WHT: 'Blanco', RED: 'Rojo', BLU: 'Azul', GRY: 'Gris', GREY: 'Gris', YEL: 'Amarillo',
  ORG: 'Naranja', ORA: 'Naranja', GRN: 'Verde', PNK: 'Rosa', SIL: 'Plata', SLV: 'Plata', BRN: 'Marrón',
  PUR: 'Morado', GLD: 'Oro', NYE: 'Amarillo flúor', NAV: 'Azul marino', BGE: 'Beige', KHA: 'Caqui',
  CRB: 'Carbono', TIT: 'Titanio', CLR: 'Transparente', BRZ: 'Bronce',
};

/**
 * Completa modelos con variantes "huérfanas": referencias que el proveedor ya
 * no lista (sin talla/color ni nombre en español) junto a hermanas que sí los
 * tienen. Aprende, dentro de cada modelo, qué código del nombre del proveedor
 * corresponde a cada color ("RED" → "Rojo") y deduce talla y color del nombre
 * ("…, RED, XS"). Toma el nombre en español de una hermana del mismo color.
 */
/** Nombre en español para un color: el de una hermana de ese color, o el de otra cambiando el color. */
function spanishNameFor(color: string, nameByColor: Map<string, string>): string {
  if (nameByColor.has(color)) return nameByColor.get(color)!;
  for (const [otherColor, name] of nameByColor) {
    const re = new RegExp(`\\b${otherColor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const m = name.match(re);
    if (m) {
      const replacement = m[0] === m[0].toLowerCase() ? color.toLowerCase() : color;
      return name.replace(re, replacement);
    }
  }
  return '';
}

export async function completeFamilies(): Promise<number> {
  const fams = await pool.query(`
    SELECT family_code, json_agg(json_build_object(
      'id', id, 'name', name, 'en', supplier_name, 'vo', variant_options)) AS members
    FROM products
    WHERE status = 'published' AND family_code IN (
      SELECT family_code FROM products WHERE status = 'published'
      GROUP BY family_code
      HAVING bool_or(variant_options IS NULL) AND bool_or(variant_options IS NOT NULL) AND count(*) <= 300)
    GROUP BY family_code`);

  const ids: number[] = [];
  const opts: string[] = [];
  const names: string[] = [];
  for (const { members } of fams.rows as { members: { id: number; name: string; en: string | null; vo: Record<string, string> | null }[] }[]) {
    const codeToColor = new Map<string, string>();
    const sizes = new Set<string>();
    const nameByColor = new Map<string, string>();
    for (const m of members) {
      if (!m.vo) continue;
      if (m.vo.Talla) sizes.add(m.vo.Talla.toUpperCase());
      if (m.vo.Color && m.name && !isAllCaps(m.name)) nameByColor.set(m.vo.Color, m.name);
      const tokens = (m.en || '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      if (m.vo.Color && tokens.length >= 2) {
        const tail = tokens.slice(1).filter((t) => !(m.vo!.Talla && t === m.vo!.Talla.toUpperCase()));
        const code = tail[tail.length - 1];
        if (code && !codeToColor.has(code)) codeToColor.set(code, m.vo.Color);
      }
    }
    for (const m of members) {
      if (m.vo || !m.name) continue;
      const tokens = m.name.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      if (tokens.length < 2) continue;
      const derived: Record<string, string> = {};
      let rest = tokens.slice(1);
      const last = rest[rest.length - 1];
      if (last && (sizes.has(last) || (sizes.size > 0 && SIZE_TOKEN.test(last)))) {
        derived.Talla = last;
        rest = rest.slice(0, -1);
      }
      const colorCode = rest[rest.length - 1];
      if (colorCode && codeToColor.has(colorCode)) derived.Color = codeToColor.get(colorCode)!;
      else if (colorCode && codeToColor.size > 0 && COLOR_CODES[colorCode]) derived.Color = COLOR_CODES[colorCode];
      if (!Object.keys(derived).length) continue;
      ids.push(m.id);
      opts.push(JSON.stringify(derived));
      names.push(isAllCaps(m.name) && derived.Color ? spanishNameFor(derived.Color, nameByColor) : '');
    }
  }
  if (!ids.length) return 0;
  const res = await pool.query(
    `UPDATE products p SET
       variant_options = v.vo::jsonb,
       name = CASE WHEN v.nm <> '' THEN v.nm ELSE p.name END
     FROM unnest($1::int[], $2::text[], $3::text[]) AS v(id, vo, nm)
     WHERE p.id = v.id AND p.variant_options IS NULL`, [ids, opts, names]);
  return res.rowCount || 0;
}

/**
 * Coloca en su categoría los productos sin subcategoría (p. ej. los que el
 * importador dejaba en la 1 "Cascos" por defecto), usando la categoría de Bihr
 * del CSV y la correspondencia categories.bihr_cat3 / bihr_cat2. Solo usa el
 * árbol vigente (no los slugs old-*). Si un código de Bihr corresponde a varias
 * categorías, gana la MENOS profunda: las de tercer nivel con el mismo código
 * son duplicados heredados (p. ej. "Cascos integrales" colgando de
 * "Accesorios y recambios para cascos").
 * Guarda raíz, segundo nivel y hoja en category_id / category2_id / category3_id.
 */
export async function assignCategories(csvIndex: Map<string, CsvInfo>): Promise<number> {
  const cats = (await pool.query('SELECT id, parent_id, slug, bihr_cat2, bihr_cat3 FROM categories')).rows as
    { id: number; parent_id: number | null; slug: string; bihr_cat2: string | null; bihr_cat3: string | null }[];
  const byId = new Map(cats.map((c) => [c.id, c]));
  const chainCache = new Map<number, number[]>();
  const chainOf = (id: number): number[] => {
    const hit = chainCache.get(id);
    if (hit) return hit;
    const chain: number[] = [];
    let c = byId.get(id);
    while (c && chain.length < 6) { chain.unshift(c.id); c = c.parent_id ? byId.get(c.parent_id) : undefined; }
    chainCache.set(id, chain);
    return chain;
  };
  const isCurrent = (id: number) => {
    const chain = chainOf(id);
    return chain.length > 0 && chain.every((x) => !(byId.get(x)?.slug || '').startsWith('old-'));
  };
  const pick = (map: Map<string, number[]>, key: string) => {
    const ids = (map.get(key) || []).filter(isCurrent);
    return ids.sort((a, b) => chainOf(a).length - chainOf(b).length || a - b)[0];
  };
  const by3 = new Map<string, number[]>();
  const by2 = new Map<string, number[]>();
  for (const c of cats) {
    if (c.bihr_cat3) (by3.get(c.bihr_cat3.trim().toUpperCase()) || by3.set(c.bihr_cat3.trim().toUpperCase(), []).get(c.bihr_cat3.trim().toUpperCase())!).push(c.id);
    if (c.bihr_cat2) (by2.get(c.bihr_cat2.trim().toUpperCase()) || by2.set(c.bihr_cat2.trim().toUpperCase(), []).get(c.bihr_cat2.trim().toUpperCase())!).push(c.id);
  }

  const bestCache = new Map<string, number | undefined>();
  const pickCached = (map: Map<string, number[]>, key: string, tag: string) => {
    const k = `${tag}:${key}`;
    if (!bestCache.has(k)) bestCache.set(k, pick(map, key));
    return bestCache.get(k);
  };

  const targets = (await pool.query(`
    SELECT id, sku, part_number, category3_id FROM products
    WHERE status = 'published'`)).rows as { id: number; sku: string; part_number: string | null; category3_id: number | null }[];
  const candidatesOf = (info: CsvInfo) => new Set([...(by3.get(info.cat3) || []), ...(by2.get(info.cat2) || [])]);

  const ids: number[] = []; const c1: number[] = []; const c2: number[] = []; const c3: number[] = [];
  for (const t of targets) {
    const info = (t.part_number && csvIndex.get(t.part_number)) || csvIndex.get(t.sku);
    if (!info) continue;
    const leaf = pickCached(by3, info.cat3, '3') ?? pickCached(by2, info.cat2, '2');
    if (!leaf) continue;
    // Solo productos sin categoría o colocados en otra candidata de su mismo
    // código de Bihr; los movidos a mano a otra categoría se respetan.
    if (t.category3_id === leaf) continue;
    if (t.category3_id !== null && !candidatesOf(info).has(t.category3_id)) continue;
    const chain = chainOf(leaf);
    ids.push(t.id); c1.push(chain[0]); c2.push(chain[1] ?? chain[0]); c3.push(leaf);
  }
  let updated = 0;
  for (let i = 0; i < ids.length; i += 2000) {
    const r = await pool.query(
      `UPDATE products p SET category_id = v.c1, category2_id = v.c2, category3_id = v.c3
       FROM unnest($1::int[], $2::int[], $3::int[], $4::int[]) AS v(id, c1, c2, c3)
       WHERE p.id = v.id`,
      [ids.slice(i, i + 2000), c1.slice(i, i + 2000), c2.slice(i, i + 2000), c3.slice(i, i + 2000)]);
    updated += r.rowCount || 0;
  }

  // Subcategorías duplicadas (mismo código de Bihr que otra menos profunda,
  // p. ej. "Guantes › Guantes" o "Accesorios y recambios › Cascos integrales"):
  // sus productos pasan a la categoría buena.
  for (const [code, ids] of by3) {
    const current = ids.filter(isCurrent);
    if (current.length < 2) continue;
    const preferred = pick(by3, code)!;
    const dups = current.filter((x) => x !== preferred);
    const chain = chainOf(preferred);
    const r = await pool.query(
      `UPDATE products SET category_id = $1, category2_id = $2, category3_id = $3
       WHERE status = 'published' AND category3_id = ANY($4::int[])`,
      [chain[0], chain[1] ?? chain[0], preferred, dups]);
    updated += r.rowCount || 0;
  }

  // Raíz y segundo nivel coherentes con la hoja (había productos con la hoja
  // bien puesta pero la raíz en la 1 "Cascos").
  const withLeaf = (await pool.query(`
    SELECT id, category_id, category2_id, category3_id FROM products
    WHERE status = 'published' AND category3_id IS NOT NULL`)).rows as { id: number; category_id: number; category2_id: number | null; category3_id: number }[];
  const fixIds: number[] = []; const f1: number[] = []; const f2: number[] = [];
  for (const r of withLeaf) {
    const chain = chainOf(r.category3_id);
    if (!chain.length) continue;
    const want1 = chain[0];
    const want2 = chain[1] ?? chain[0];
    if (r.category_id !== want1 || r.category2_id !== want2) { fixIds.push(r.id); f1.push(want1); f2.push(want2); }
  }
  for (let i = 0; i < fixIds.length; i += 2000) {
    const r = await pool.query(
      `UPDATE products p SET category_id = v.c1, category2_id = v.c2
       FROM unnest($1::int[], $2::int[], $3::int[]) AS v(id, c1, c2) WHERE p.id = v.id`,
      [fixIds.slice(i, i + 2000), f1.slice(i, i + 2000), f2.slice(i, i + 2000)]);
    updated += r.rowCount || 0;
  }
  return updated;
}

/**
 * Productos que siguen sin categoría (no están en el catálogo de Bihr): se
 * clasifican por votación entre los 10 productos ya clasificados con el texto
 * más parecido (pg_trgm). Solo con consenso suficiente; el resto queda
 * pendiente de revisión manual (category3_id NULL).
 */
export async function classifyByNeighbours(minVotes = 4, minSimilarity = 0.4): Promise<{ classified: number; pending: number }> {
  const res = await pool.query(`
    WITH u AS (
      SELECT p.id, p.search_text FROM products p
      WHERE p.status = 'published' AND p.category3_id IS NULL AND p.search_text IS NOT NULL
    ), guess AS (
      SELECT u.id, b.c3, b.votes, b.sim
      FROM u CROSS JOIN LATERAL (
        SELECT c3, count(*) AS votes, max(sim) AS sim FROM (
          SELECT p.category3_id AS c3, similarity(p.search_text, u.search_text) AS sim
          FROM products p
          WHERE p.status = 'published' AND p.category3_id IS NOT NULL AND p.id <> u.id
            AND p.search_text % u.search_text
          ORDER BY p.search_text <-> u.search_text LIMIT 10) n
        GROUP BY c3 ORDER BY count(*) DESC, max(sim) DESC LIMIT 1) b
    )
    UPDATE products p SET category_id = COALESCE(c.root, g.c3), category2_id = COALESCE(c.lvl2, g.c3), category3_id = g.c3
    FROM guess g
    LEFT JOIN LATERAL (
      SELECT (SELECT x.category_id FROM products x WHERE x.category3_id = g.c3 LIMIT 1) AS root,
             (SELECT x.category2_id FROM products x WHERE x.category3_id = g.c3 LIMIT 1) AS lvl2
    ) c ON true
    WHERE p.id = g.id AND g.votes >= $1 AND g.sim >= $2`, [minVotes, minSimilarity]);
  const pending = await pool.query(`SELECT count(*)::int AS n FROM products WHERE status = 'published' AND category3_id IS NULL`);
  return { classified: res.rowCount || 0, pending: pending.rows[0].n };
}

/** Lee el JSON de la API de Bihr y devuelve las referencias mínimas. */
export function loadBihrApiRefs(jsonPath: string): BihrRefLite[] {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const list: any[] = data.Products || data.References || [];
  return list
    .filter((p) => p.ProductCode && p.NewPartNumber)
    .map((p) => ({ productCode: String(p.ProductCode), partNumber: String(p.NewPartNumber), size: p.Size, color: p.Color }));
}

/**
 * Productos publicados en una categoría desactivada (categories.status <> 'active',
 * p. ej. Ciclismo) se archivan: el importador da de alta los nuevos como publicados.
 */
export async function archiveInInactiveCategories(): Promise<number> {
  const r = await pool.query(`
    UPDATE products p SET status = 'archived', updated_at = NOW()
    WHERE p.status = 'published'
      AND EXISTS (SELECT 1 FROM categories c
                  WHERE c.status <> 'active'
                    -- El árbol antiguo (old-*) está inactivo pero aún aloja productos
                    -- pendientes de recolocar: esos no se tocan.
                    AND c.slug NOT LIKE 'old-%'
                    AND c.id IN (p.category_id, p.category2_id, p.category3_id))`);
  return r.rowCount || 0;
}

/**
 * Productos distintos que se llaman igual (832 discos «Disco de freno NG BRAKES
 * redondo fijo»): a los que no tienen variantes se les añade la referencia del
 * fabricante («… · Ref. 1979»). El importador repone el nombre de Bihr en cada
 * sincronización y este paso lo vuelve a aplicar. Por lotes de id.
 */
export async function disambiguateNames(): Promise<number> {
  const { rows: [range] } = await pool.query(`SELECT min(id) AS lo, max(id) AS hi FROM products WHERE status = 'published'`);
  let total = 0;
  for (let from = Number(range?.lo) || 0; from <= (Number(range?.hi) || 0); from += 5000) {
    const r = await pool.query(`
      WITH dup AS (
        SELECT name FROM products WHERE status = 'published' GROUP BY name HAVING count(DISTINCT family_code) > 1
      ), single AS (
        SELECT family_code FROM products WHERE status = 'published' GROUP BY family_code HAVING count(*) = 1
      )
      UPDATE products p
         SET name = p.name || ' · Ref. ' || COALESCE(NULLIF(trim(p.supplier_code), ''), p.sku)
        FROM dup d, single s
       WHERE p.id >= $1 AND p.id < $2 AND p.status = 'published'
         AND d.name = p.name AND s.family_code = p.family_code
         AND p.name NOT LIKE '% · Ref. %'`, [from, from + 5000]);
    total += r.rowCount || 0;
  }
  return total;
}

/**
 * Nombres en inglés traducidos (tabla name_translations, rellenada una vez con
 * lib/name-translation.ts). Como el importador repone el nombre de Bihr, la
 * traducción se aplica de nuevo en cada sincronización.
 */
export async function applyNameTranslations(): Promise<number> {
  const exists = await pool.query(`SELECT to_regclass('public.name_translations') AS t`);
  if (!exists.rows[0]?.t) return 0;
  const r = await pool.query(`
    UPDATE products p SET name = t.name_es
      FROM name_translations t
     WHERE p.name = t.source_name AND t.name_es <> '' AND p.name <> t.name_es`);
  return r.rowCount || 0;
}

export async function enrichCatalog(jsonPath: string, csvDir: string): Promise<EnrichStats> {
  const refs = loadBihrApiRefs(jsonPath);
  const csvIndex = loadCsvIndex(csvDir);
  console.log(`[ENRICH] ${refs.length} referencias de la API, ${csvIndex.size} filas de CSV`);
  const a = await applyEnrichment(refs, csvIndex);
  const b = await markDuplicates();
  const completed = await completeFamilies();
  console.log(`[ENRICH] ${completed} variantes completadas a partir de su modelo`);
  const categorized = await assignCategories(csvIndex);
  console.log(`[ENRICH] ${categorized} productos colocados en su categoría`);
  const nb = await classifyByNeighbours();
  console.log(`[ENRICH] ${nb.classified} clasificados por similitud; ${nb.pending} pendientes de revisión manual`);
  const hidden = await archiveInInactiveCategories();
  if (hidden) console.log(`[ENRICH] ${hidden} productos archivados por estar en categorías desactivadas (p. ej. Ciclismo)`);
  const ty = await applyTyreAttributes(csvIndex);
  console.log(`[ENRICH] Neumáticos y cámaras: ${ty.sized}/${ty.tyres + ty.tubes} con medida, ${ty.updated} actualizados`);
  const translated = await applyNameTranslations();
  if (translated) console.log(`[ENRICH] ${translated} nombres traducidos al español`);
  const refs2 = await disambiguateNames();
  if (refs2) console.log(`[ENRICH] ${refs2} nombres repetidos con la referencia del fabricante`);
  // Vocabulario del buscador (corrección de erratas) con los nombres nuevos.
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY catalog_words').catch((e) =>
    console.error('[ENRICH] No se pudo refrescar catalog_words:', e.message));
  return { ...a, ...b };
}
