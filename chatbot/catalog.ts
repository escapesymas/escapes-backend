import { pool } from '../db.js';

export interface CatalogHit {
  id: number;
  sku: string;
  brand: string;
  name: string;
  price: number;
  sale_price: number | null;
  stock: number;
  stock_status: string;
  image: string | null;
  slug: string | null;
  compatibility: any;
  category2: string | null;
  category3: string | null;
}

export interface CatalogContextResult {
  hits: CatalogHit[];
  text: string;
}

interface GarageMotorcycle {
  brand: string;
  model: string;
  year: number | null;
}

const SYNONYMS_ES_EN: Record<string, string[]> = {
  'pastilla': ['brake', 'pad', 'pads'],
  'pastillas': ['brake', 'pad', 'pads'],
  'freno': ['brake', 'brakes'],
  'frenos': ['brake', 'brakes'],
  'escape': ['exhaust'],
  'escapes': ['exhaust'],
  'bujia': ['spark', 'plug'],
  'bujias': ['spark', 'plug'],
  'bujía': ['spark', 'plug'],
  'bujías': ['spark', 'plug'],
  'cadena': ['chain'],
  'cadenas': ['chain'],
  'transmision': ['chain', 'transmission'],
  'aceite': ['oil'],
  'filtro': ['filter'],
  'filtros': ['filter'],
  'embrague': ['clutch'],
  'amortiguador': ['shock', 'absorber', 'fork'],
  'amortiguadores': ['shock', 'absorber', 'fork'],
  'suspension': ['suspension', 'shock', 'fork'],
  'bateria': ['battery'],
  'baterias': ['battery'],
  'manillar': ['handlebar'],
  'espejo': ['mirror'],
  'espejos': ['mirror'],
  'intermitente': ['indicator', 'turn'],
  'intermitentes': ['indicator', 'turn'],
  'piloto': ['light', 'lamp'],
  'pilotos': ['light', 'lamp'],
  'casco': ['helmet'],
  'guante': ['glove'],
  'guantes': ['glove'],
  'chaqueta': ['jacket'],
  'chaquetas': ['jacket'],
  'pantalon': ['trouser', 'pant'],
  'pantalones': ['trouser', 'pant'],
  'motor': ['engine'],
  'piston': ['piston'],
  'pistones': ['piston'],
  'junta': ['gasket'],
  'juntas': ['gasket'],
  'rodamiento': ['bearing'],
  'rodamientos': ['bearing'],
  'kit': ['kit'],
  'arrastre': ['chain', 'sprocket'],
};

function expandSynonyms(keywords: string[]): string[] {
  const expanded = new Set<string>();
  for (const kw of keywords) {
    expanded.add(kw);
    const synonyms = SYNONYMS_ES_EN[kw];
    if (synonyms) {
      for (const s of synonyms) expanded.add(s);
    }
  }
  return Array.from(expanded);
}

function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    'para', 'como', 'cuál', 'cuales', 'donde', 'cuando', 'cuanto', 'tengo', 'tienes',
    'queremos', 'quiero', 'quisiera', 'busco', 'buscando', 'algo', 'algun', 'alguna',
    'hola', 'buenas', 'buenos', 'dias', 'tardes', 'noches', 'gracias', 'por', 'favor',
    'una', 'uno', 'unos', 'unas', 'del', 'los', 'las', 'con', 'sin', 'que', 'qué',
    'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aqui', 'allí',
    'the', 'and', 'for', 'are', 'you', 'can', 'have', 'has', 'with', 'from',
  ]);
  const matches = text.toLowerCase().match(/[a-záéíóúñ0-9]{3,}/g) || [];
  const filtered = matches.filter((w) => !stopwords.has(w)).slice(0, 8);
  return expandSynonyms(filtered);
}

const PURCHASE_INTENT_WORDS = [
  'busco', 'buscando', 'quiero', 'quisiera', 'necesito', 'recomienda', 'recomiendas',
  'tienes', 'teneis', 'hay', 'toca', 'cambiar', 'comprar', 'escape', 'escapes',
  'recambio', 'recambios', 'filtro', 'filtros', 'pastilla', 'pastillas', 'freno',
  'frenos', 'cadena', 'transmision', 'transmisión', 'aceite', 'bujia', 'bujía',
  'bateria', 'batería', 'kit', 'moto', 'motero', 'compatible', 'compatibilidad',
  'sirve', 'valvula', 'válvula', 'embrague', 'amortiguador', 'suspension',
];

function hasPurchaseIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return PURCHASE_INTENT_WORDS.some((w) => lower.includes(w));
}

const GARAGE_YEAR_RE = /\((\d{4})\)/;
const GARAGE_MODEL_BRAND_RE = /^([A-Z][A-Z0-9\-]+(?:\s+[A-Z0-9][A-Z0-9\-]+)*)\s+\(([^)]+)\)\s*$/;

function parseGarageMotorcycle(entry: string): GarageMotorcycle | null {
  const s = (entry || '').trim();
  if (!s) return null;
  const m = s.match(GARAGE_YEAR_RE);
  const year = m ? parseInt(m[1], 10) : null;
  const withoutYear = s.replace(GARAGE_YEAR_RE, '').trim();
  const parts = withoutYear.split(/\s+/);
  if (parts.length < 2) return null;
  return {
    brand: parts[0].toUpperCase(),
    model: parts.slice(1).join(' ').toUpperCase(),
    year: Number.isFinite(year as number) ? (year as number) : null,
  };
}

function modelMatchesGarage(model: string, garageModel: string): boolean {
  if (!model || !garageModel) return false;
  const a = model.toUpperCase();
  const b = garageModel.toUpperCase();
  if (a === b) return true;
  const tokensA = a.split(/\s+/).filter((t) => t.length >= 2);
  const tokensB = b.split(/\s+/).filter((t) => t.length >= 2);
  const significant = tokensA.filter((t) => !/^\d+$/.test(t) && t.length >= 3);
  if (significant.length === 0) return false;
  return significant.some((t) => b.includes(t));
}

function pickFirstImage(images: any): string | null {
  if (!images) return null;
  let arr: any[] = [];
  if (typeof images === 'string') {
    try { arr = JSON.parse(images); } catch { arr = []; }
  } else if (Array.isArray(images)) {
    arr = images;
  }
  if (arr.length === 0) return null;
  const first = arr[0] || {};
  return first.src || first.url || null;
}

function mapHit(row: any): CatalogHit {
  return {
    id: row.id,
    sku: row.sku,
    brand: row.brand,
    name: row.name,
    price: row.price,
    sale_price: row.sale_price,
    stock: row.stock,
    stock_status: row.stock_status,
    image: pickFirstImage(row.images),
    slug: row.slug || row.sku?.toLowerCase().replace(/[^a-z0-9]/g, '-') || `product-${row.id}`,
    compatibility: row.compatibility,
    category2: row.category2,
    category3: row.category3,
  };
}

function formatHitText(p: CatalogHit): string {
  const priceStr = p.sale_price
    ? `${(p.sale_price / 100).toFixed(2)}€ (antes ${(p.price / 100).toFixed(2)}€)`
    : `${(p.price / 100).toFixed(2)}€`;
  const stockStr = (p.stock || 0) > 0 ? `stock: ${p.stock}` : 'sin stock';
  return `- ${p.sku} | ${p.brand || 'Genérico'} | "${p.name}" | ${priceStr} | ${stockStr}`;
}

async function searchByKeywords(
  keywords: string[],
  options: { garageMotos?: GarageMotorcycle[]; preferGarage?: boolean; limit?: number; typeFilter?: string }
): Promise<CatalogHit[]> {
  if (keywords.length === 0) return [];
  const tsQuery = keywords.map((k) => `${k}:*`).join(' | ');
  const limit = options.limit ?? 8;
  const typeFilter = options.typeFilter || '';

  try {
    const result = await pool.query(
      `SELECT id, sku, name, brand, price, sale_price, stock, stock_status,
              images, compatibility, category2, category3
       FROM products
       WHERE to_tsvector('simple',
                coalesce(name,'') || ' ' ||
                coalesce(brand,'') || ' ' ||
                coalesce(sku,'') || ' ' ||
                coalesce(category2,'') || ' ' ||
                coalesce(category3,'')
              ) @@ to_tsquery('simple', $1)
         AND (
           (compatibility IS NOT NULL AND jsonb_array_length(compatibility) > 0)
           OR coalesce(category2,'') ILIKE '%moto%'
           OR coalesce(category3,'') ILIKE '%moto%'
         )
         AND coalesce(name,'') NOT ILIKE '%bici%'
         AND coalesce(name,'') NOT ILIKE '%patinete%'
         AND coalesce(name,'') NOT ILIKE '%bicycle%'
         AND coalesce(name,'') NOT ILIKE '%ebike%'
         AND coalesce(category2,'') NOT ILIKE '%bici%'
         AND coalesce(category2,'') NOT ILIKE '%patinete%'
         AND coalesce(category3,'') NOT ILIKE '%bici%'
         AND coalesce(category3,'') NOT ILIKE '%patinete%'
         ${typeFilter}
       ORDER BY stock DESC NULLS LAST, price ASC
       LIMIT 40`,
      [tsQuery]
    );

    const hits = (result.rows as any[]).map(mapHit);
    return filterAndRank(hits, options);
  } catch (err) {
    console.error('[chatbot] keyword search failed:', err);
    return [];
  }
}

async function searchByGarage(
  garageMotos: GarageMotorcycle[],
  limit: number
): Promise<CatalogHit[]> {
  if (garageMotos.length === 0) return [];
  return searchByCompatibility(garageMotos, [], limit);
}

async function searchByCompatibility(
  motos: GarageMotorcycle[],
  keywords: string[],
  limit: number
): Promise<CatalogHit[]> {
  const validMotos = motos.filter((m) => m.brand || m.model);
  if (validMotos.length === 0) return [];

  const conditions: string[] = [];
  const params: any[] = [];
  let i = 1;

  for (const moto of validMotos) {
    const parts: string[] = [];
    const modelNorm = moto.model.replace(/[^A-Za-z0-9]/g, '');
    const modelHyphen = modelNorm.replace(/^([A-Za-z]+)(\d+)$/, '$1-$2');
    const modelSpace = modelNorm.replace(/^([A-Za-z]+)(\d+)$/, '$1 $2');
    const modelOriginal = moto.model.replace(/[^A-Za-z0-9]/g, '');
    const variants = Array.from(new Set([modelNorm, modelHyphen, modelSpace, modelOriginal].filter((v, i, a) => v && a.indexOf(v) === i)));

    if (moto.brand && moto.model && moto.year) {
      const variantConds = variants.map((_v, idx) => `c->>'model' ILIKE $${i + 1 + idx}`).join(' OR ');
      parts.push(`(c->>'brand' = $${i} AND (${variantConds}) AND ABS(COALESCE((c->>'year')::int, $${i + 1 + variants.length}) - $${i + 1 + variants.length}) <= 2)`);
      params.push(moto.brand, ...variants.map((v) => `%${v}%`), moto.year);
      i += 2 + variants.length;
    }
    if (moto.brand && moto.model) {
      const variantConds = variants.map((_v, idx) => `c->>'model' ILIKE $${i + 1 + idx}`).join(' OR ');
      parts.push(`(c->>'brand' = $${i} AND (${variantConds}))`);
      params.push(moto.brand, ...variants.map((v) => `%${v}%`));
      i += 1 + variants.length;
    }
    if (moto.brand && !moto.model) {
      parts.push(`(c->>'brand' = $${i})`);
      params.push(moto.brand);
      i += 1;
    }
    if (!moto.brand && moto.model) {
      const variantConds = variants.map((_v, idx) => `c->>'model' ILIKE $${i + idx}`).join(' OR ');
      parts.push(`(${variantConds})`);
      params.push(...variants.map((v) => `%${v}%`));
      i += variants.length;
    }

    if (parts.length > 0) {
      conditions.push(`(EXISTS (SELECT 1 FROM jsonb_array_elements(compatibility) AS c WHERE ${parts.join(' OR ')}))`);
    }
  }

  if (conditions.length === 0) return [];

  let keywordFilter = '';
  if (keywords.length > 0) {
    const tsQuery = keywords.map((k) => `${k}:*`).join(' | ');
    keywordFilter = `AND to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(category2,'') || ' ' || coalesce(category3,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(sku,'')) @@ to_tsquery('simple', $${i})`;
    params.push(tsQuery);
    i += 1;
  }

  let nameILikeFilter = '';
  const productKeywords = keywords.filter((k) => /pastill|brake|pads|filtro|filter|aceite|oil|escape|exhaust|cadena|chain|buji|spark|embrague|clutch|amortiguador|suspension|bateria|battery|kit|faros?|light|motor|engine|correa|belt|sprocket|rodamiento|bearing|junta|gasket|disco|disc|casco|helmet|guant|glove/i.test(k));
  if (productKeywords.length > 0) {
    const orClauses = productKeywords
      .map((_k, idx) => `(coalesce(name,'') ILIKE $${i + idx} OR coalesce(category3,'') ILIKE $${i + idx})`)
      .join(' OR ');
    nameILikeFilter = `AND (${orClauses})`;
    params.push(...productKeywords.map((k) => `%${k}%`));
    i += productKeywords.length;
  }

  let typeSpecificFilter = '';
  const wantsOil = keywords.some((k) => /aceite|oil/i.test(k));
  const wantsPad = keywords.some((k) => /pastill|pads/i.test(k));
  const wantsAir = keywords.some((k) => /aire|air/i.test(k));
  if (wantsOil && !wantsAir) {
    typeSpecificFilter = `AND (coalesce(name,'') ILIKE '%oil%' OR coalesce(name,'') ILIKE '%aceite%' OR coalesce(category3,'') ILIKE '%oil%')`;
  } else if (wantsPad) {
    typeSpecificFilter = `AND (coalesce(name,'') ILIKE '%pad%' OR coalesce(name,'') ILIKE '%pastilla%' OR coalesce(category3,'') ILIKE '%brake pads%')`;
  } else if (wantsAir) {
    typeSpecificFilter = `AND (coalesce(name,'') ILIKE '%air%' OR coalesce(name,'') ILIKE '%aire%')`;
  }

  const sql = `
    SELECT id, sku, name, brand, price, sale_price, stock, stock_status,
           images, compatibility, category2, category3
    FROM products
    WHERE (${conditions.join(' OR ')})
      AND stock > 0
      ${keywordFilter}
      ${nameILikeFilter}
      ${typeSpecificFilter}
    ORDER BY stock DESC NULLS LAST, price ASC
    LIMIT ${limit}
  `;

  try {
    const result = await pool.query(sql, params);
    return (result.rows as any[]).map(mapHit);
  } catch (err) {
    console.error('[chatbot] compatibility search failed:', err);
    return [];
  }
}

function filterAndRank(
  hits: CatalogHit[],
  options: { garageMotos?: GarageMotorcycle[]; preferGarage?: boolean }
): CatalogHit[] {
  if (hits.length === 0) return hits;
  const garage = options.garageMotos || [];
  const preferGarage = options.preferGarage && garage.length > 0;

  const compatible: CatalogHit[] = [];
  const rest: CatalogHit[] = [];

  for (const h of hits) {
    if (garage.length > 0 && isCompatibleWithGarage(h, garage)) {
      compatible.push(h);
    } else {
      rest.push(h);
    }
  }

  if (preferGarage) {
    return [...compatible, ...rest].slice(0, 8);
  }

  return hits.slice(0, 8);
}

function isCompatibleWithGarage(hit: CatalogHit, garage: GarageMotorcycle[]): boolean {
  if (!hit.compatibility || !Array.isArray(hit.compatibility)) return false;
  for (const entry of hit.compatibility) {
    if (!entry || typeof entry !== 'object') continue;
    const entryBrand = String(entry.brand || '').toUpperCase().trim();
    const entryModel = String(entry.model || '').toUpperCase().trim();
    const entryYear = entry.year ? parseInt(entry.year, 10) : null;
    for (const moto of garage) {
      if (!moto.brand) continue;
      const brandMatch = entryBrand === moto.brand || moto.brand.includes(entryBrand) || entryBrand.includes(moto.brand);
      if (!brandMatch) continue;
      const modelMatch = modelMatchesGarage(entryModel, moto.model);
      if (!modelMatch) continue;
      if (moto.year && entryYear && Math.abs(entryYear - moto.year) > 5) continue;
      return true;
    }
  }
  return false;
}

function mentionsGarage(query: string, garageMotos: GarageMotorcycle[]): boolean {
  const lower = query.toLowerCase();
  return garageMotos.some((m) => {
    if (m.brand && lower.includes(m.brand.toLowerCase())) return true;
    if (m.model) {
      const tokens = m.model.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
      return tokens.some((t) => lower.includes(t));
    }
    return false;
  });
}

const KNOWN_BRANDS = new Set([
  'HONDA', 'YAMAHA', 'KAWASAKI', 'SUZUKI', 'DUCATI', 'BMW', 'KTM',
  'TRIUMPH', 'APRILIA', 'MV AGUSTA', 'HUSQVARNA', 'ROYAL ENFIELD',
  'MOTO GUZZI', 'BENELLI', 'DERBI', 'GILERA', 'PIAGGIO', 'VESPA',
  'PEUGEOT', 'RIEJU', 'SYM', 'KYMCO', 'BETA', 'FANTIC', 'MONTESA',
  'HUSABERG', 'BUELL', 'INDIAN', 'HARLEY', 'DAVIDSON', 'MOTO MORINI',
  'SHERCO', 'GASGAS', 'SCORPA', 'POLARIS',
]);

const BRAND_ALIASES: Record<string, string> = {
  'yamaha': 'YAMAHA',
  'honda': 'HONDA',
  'kawasaki': 'KAWASAKI',
  'suzuki': 'SUZUKI',
  'ducati': 'DUCATI',
  'bmw': 'BMW',
  'ktm': 'KTM',
  'triumph': 'TRIUMPH',
  'aprilia': 'APRILIA',
  'mv': 'MV AGUSTA',
  'mv agusta': 'MV AGUSTA',
  'agusta': 'MV AGUSTA',
  'husqvarna': 'HUSQVARNA',
  'husaberg': 'HUSABERG',
  'royal': 'ROYAL ENFIELD',
  'enfield': 'ROYAL ENFIELD',
  'guzzi': 'MOTO GUZZI',
  'benelli': 'BENELLI',
  'derbi': 'DERBI',
  'gilera': 'GILERA',
  'piaggio': 'PIAGGIO',
  'vespa': 'VESPA',
  'peugeot': 'PEUGEOT',
  'rieju': 'RIEJU',
  'sym': 'SYM',
  'kymco': 'KYMCO',
  'beta': 'BETA',
  'fantic': 'FANTIC',
  'montesa': 'MONTESA',
  'buell': 'BUELL',
  'indian': 'INDIAN',
  'harley': 'HARLEY',
  'davidson': 'HARLEY',
  'morini': 'MOTO MORINI',
  'sherco': 'SHERCO',
  'gasgas': 'GASGAS',
  'polaris': 'POLARIS',
};

function normalizeModelForSearch(model: string): string {
  if (!model) return model;
  return model.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function extractMotorcycleFromQuery(query: string): GarageMotorcycle | null {
  const lower = query.toLowerCase();
  let detectedBrand: string | null = null;

  for (const alias of Object.keys(BRAND_ALIASES)) {
    const re = new RegExp(`(?:^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z]|$)`);
    if (re.test(lower)) {
      detectedBrand = BRAND_ALIASES[alias];
      break;
    }
  }

  const yearMatch = lower.match(/\b(19[8-9]\d|20[0-3]\d)\b/);
  const detectedYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

  const modelCandidates: string[] = [];
  const knownModelPrefixes = ['mt', 'gs', 'xr', 'cbr', 'cb', 'yzf', 'r1', 'r6', 'z750', 'z800', 'z900', 'zx', 'ninja', 'er6', 'er', 'klr', 'crf', 'cb500', 'cb1000', 'cbr600', 'cbr1000', 'gsxr', 'sv', 'rmz', 'drz', 'dr', 'xt', 'wr', 'xf', 'xc', 'fe', 'te', 'tx', 'sm', 'yz', 'cr', 'rm', 'klx', 'pcx', 'sh', 'nss', 'vision', 'xmax', 'aerox', 'fz', 'mtn', 'trk', 'rx', 'cbf', 'cbx', 'nx', 'gl', 'st', 'vf', 'vfr', 'cbrf', 'kx', 'versys', 'tmax', 'nmax', 'vespa', 'medley', 'mp3', 'gts', 'et4', 'fj1200', 'tenera', 'tracer', 'tricity', 'niken', 'xs', 'xj', 'tt', 'fz', 'fz6', 'fz1', 'fazer', 'xl', 'xr', 'xt'];

  const tokenRe = /\b([a-z]{2,}[\-\d]?[a-z\d]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(lower)) !== null) {
    const t = m[1];
    if (KNOWN_BRANDS.has(t.toUpperCase())) continue;
    if (/^\d+$/.test(t)) continue;
    if (/^(para|mi|tu|tus|mis|los|las|del|con|sin|uno|una|unos|unas|este|esta|ese|esa|moto|necesito|quiero|busco|tengo|tienes|filtro|filtros|aceite|escape|escapes|recambio|recambios|hola|holas)$/.test(t)) continue;
    if (t.length < 3) continue;

    const isKnownModel = knownModelPrefixes.some((p) => t.toUpperCase().startsWith(p.toUpperCase()) || t.toUpperCase() === p.toUpperCase());
    if (isKnownModel) {
      modelCandidates.push(t);
    } else if (/^[a-z]+\d+/.test(t) && t.length <= 12) {
      modelCandidates.push(t);
    }
  }

  let detectedModel: string | null = null;
  if (modelCandidates.length > 0) {
    const sorted = [...modelCandidates].sort((a, b) => b.length - a.length);
    detectedModel = normalizeModelForSearch(sorted[0]);
  }

  if (!detectedBrand && !detectedModel) return null;

  return {
    brand: detectedBrand || '',
    model: detectedModel || '',
    year: detectedYear,
  };
}

export async function getCatalogContext(
  query: string,
  garageEntries: string[] = []
): Promise<CatalogContextResult> {
  const garageMotos: GarageMotorcycle[] = garageEntries
    .map(parseGarageMotorcycle)
    .filter((m): m is GarageMotorcycle => m !== null);

  if (!hasPurchaseIntent(query)) {
    return {
      hits: [],
      text: 'Catálogo: 156.862 productos totales, 107.917 en stock. Marcas principales: Akrapovic, Leovince, Arrow, Scorpion, Yoshimura, Termignoni, Mivv, Giannelli.',
    };
  }

  const keywords = extractKeywords(query);
  if (keywords.length === 0) {
    return {
      hits: [],
      text: 'Resumen del catálogo: 156.862 productos totales, 107.917 en stock. Marcas principales: Akrapovic, Leovince, Arrow, Scorpion, Yoshimura, Termignoni, Mivv, Giannelli.',
    };
  }

  const queryMentionsGarage = mentionsGarage(query, garageMotos);
  const queryMoto = extractMotorcycleFromQuery(query);

  const targetMotos: GarageMotorcycle[] = [];
  if (queryMoto && (queryMoto.brand || queryMoto.model)) {
    targetMotos.push(queryMoto);
  } else if (queryMentionsGarage && garageMotos.length > 0) {
    targetMotos.push(garageMotos[0]);
  }

  const wantsOil = keywords.some((k) => /aceite|oil/i.test(k));
  const wantsPad = keywords.some((k) => /pastill|pads/i.test(k));
  const wantsAir = keywords.some((k) => /aire|air/i.test(k));
  let typeFilter = '';
  if (wantsOil && !wantsAir) {
    typeFilter = `AND (coalesce(name,'') ILIKE '%oil%' OR coalesce(name,'') ILIKE '%aceite%' OR coalesce(category3,'') ILIKE '%oil%')`;
  } else if (wantsPad) {
    typeFilter = `AND (coalesce(name,'') ILIKE '%pad%' OR coalesce(name,'') ILIKE '%pastilla%' OR coalesce(category3,'') ILIKE '%brake pads%')`;
  } else if (wantsAir) {
    typeFilter = `AND (coalesce(name,'') ILIKE '%air%' OR coalesce(name,'') ILIKE '%aire%')`;
  }

  let primaryHits: CatalogHit[] = [];

  if (targetMotos.length > 0) {
    primaryHits = await searchByCompatibility(targetMotos, keywords, 12);
  } else {
    primaryHits = await searchByKeywords(keywords, { garageMotos: [], limit: 12, typeFilter });
  }

  const merged: CatalogHit[] = [];
  const seen = new Set<number>();
  for (const h of primaryHits) {
    if (!seen.has(h.id)) {
      seen.add(h.id);
      merged.push(h);
    }
  }

  if (merged.length < 4) {
    const fallbackHits = await searchByKeywords(keywords, { garageMotos: [], limit: 12, typeFilter });
    for (const h of fallbackHits) {
      if (!seen.has(h.id) && merged.length < 12) {
        seen.add(h.id);
        merged.push(h);
      }
    }
  }

  if (merged.length === 0) {
    return {
      hits: [],
      text: 'Resumen del catálogo: 156.862 productos totales, 107.917 en stock. No se encontraron coincidencias exactas para la consulta.',
    };
  }

  const ranked = rankByBrandAndPrice(merged);
  const diversified = diversifyByBrand(ranked, 1);
  const finalHits = diversified.slice(0, 6);

  const text = finalHits.map(formatHitText).join('\n');

  return { hits: finalHits, text };
}

const BRAND_QUALITY_RANK: Record<string, number> = {
  'BREMBO': 9,
  'BREMBO RACING': 10,
  'CL BRAKES': 8,
  'NG BRAKE DISC': 8,
  'NISSIN': 7,
  'EBC': 6,
  'TRW': 5,
  'FERODO': 4,
  'TECNIUM': 3,
  'POLINI': 2,
  'HIFLOFILTRO': 5,
  'NGK': 7,
  'BOSCH': 6,
  'DENSO': 7,
  'MOTUL': 8,
  'CASTROL': 7,
  'LIQUI MOLY': 8,
  'AKRAPOVIC': 10,
  'LEOVINCE': 9,
  'ARROW': 9,
  'SCORPION': 9,
  'YOSHIMURA': 10,
  'TERMIGNONI': 10,
  'MIVV': 8,
  'GIANNELLI': 7,
  'KOSO': 5,
  'TOURMAX': 4,
};

function brandRank(brand: string): number {
  if (!brand) return 1;
  const norm = brand.toUpperCase().trim();
  if (BRAND_QUALITY_RANK[norm] !== undefined) return BRAND_QUALITY_RANK[norm];
  const ranked = BRAND_QUALITY_RANK[norm];
  if (ranked !== undefined) return ranked;
  return 1;
}

function rankByBrandAndPrice(hits: CatalogHit[]): CatalogHit[] {
  return [...hits].sort((a, b) => {
    const rankDiff = brandRank(b.brand) - brandRank(a.brand);
    if (rankDiff !== 0) return rankDiff;
    return a.price - b.price;
  });
}

function diversifyByBrand(hits: CatalogHit[], maxPerBrand: number): CatalogHit[] {
  const result: CatalogHit[] = [];
  const brandCount = new Map<string, number>();
  for (const h of hits) {
    const key = h.brand.toUpperCase().trim();
    const count = brandCount.get(key) || 0;
    if (count >= maxPerBrand) continue;
    brandCount.set(key, count + 1);
    result.push(h);
  }
  return result;
}

export interface GarageEntry {
  brand: string;
  model: string;
  year: string | number;
  source: 'table' | 'jsonb';
}

function parseBikeString(s: string): { brand: string; model: string; year: string } {
  const cleaned = s.trim();
  const knownBrands = ['HONDA', 'YAMAHA', 'KAWASAKI', 'SUZUKI', 'BMW', 'DUCATI', 'KTM', 'APRILIA', 'TRIUMPH', 'HARLEY', 'VESPA', 'PIAGGIO', 'KYMCO', 'SYM'];
  const upper = cleaned.toUpperCase();
  for (const b of knownBrands) {
    if (upper.startsWith(b + ' ')) {
      const rest = cleaned.substring(b.length + 1).trim();
      const yearMatch = rest.match(/\((\d{4})\)|\b(\d{4})\b/);
      const year = yearMatch ? (yearMatch[1] || yearMatch[2]) : '';
      const model = yearMatch ? rest.replace(yearMatch[0], '').trim() : rest;
      return { brand: b.charAt(0) + b.slice(1).toLowerCase(), model, year };
    }
  }
  const yearMatch = cleaned.match(/\((\d{4})\)|\b(\d{4})\b/);
  const year = yearMatch ? (yearMatch[1] || yearMatch[2]) : '';
  const model = yearMatch ? cleaned.replace(yearMatch[0], '').trim() : cleaned;
  return { brand: '', model, year };
}

export async function getGarageContext(userId: number): Promise<string> {
  try {
    const userRes = await pool.query(
      `SELECT first_name, last_name, garage FROM users WHERE id = $1`,
      [userId]
    );
    if (userRes.rows.length === 0) return '';
    const user = userRes.rows[0] as { first_name: string | null; last_name: string | null; garage: any };

    const tableRes = await pool.query(
      `SELECT brand, model, year FROM garage WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    const fromTable: GarageEntry[] = (tableRes.rows as any[]).map((r) => ({
      brand: String(r.brand || '').trim(),
      model: String(r.model || '').trim(),
      year: String(r.year || '').trim(),
      source: 'table' as const,
    }));

    let fromJsonb: GarageEntry[] = [];
    try {
      if (user.garage) {
        const raw = typeof user.garage === 'string' ? JSON.parse(user.garage) : user.garage;
        if (Array.isArray(raw)) {
          for (const e of raw) {
            if (typeof e === 'string') {
              const parsed = parseBikeString(e);
              if (parsed.brand || parsed.model) {
                fromJsonb.push({ ...parsed, source: 'jsonb' });
              }
            } else if (e && typeof e === 'object') {
              fromJsonb.push({
                brand: String(e.brand || '').trim(),
                model: String(e.model || '').trim(),
                year: String(e.year || '').trim(),
                source: 'jsonb',
              });
            }
          }
        }
      }
    } catch {
      // ignore parse errors
    }

    const seen = new Set<string>();
    const merged: GarageEntry[] = [];
    for (const e of [...fromTable, ...fromJsonb]) {
      const key = `${(e.brand || '').toLowerCase()}|${(e.model || '').toLowerCase()}|${e.year}`;
      if (!seen.has(key) && (e.brand || e.model)) {
        seen.add(key);
        merged.push(e);
      }
    }

    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    const namePart = name ? `Nombre del cliente: ${name}.` : '';
    const garagePart = merged.length > 0
      ? `Motos en su garaje: ${merged.map((m) => `${m.brand} ${m.model}${m.year ? ` (${m.year})` : ''}`.trim()).join(', ')}. RECOMIENDA productos del catálogo que sean compatibles con estas motos cuando aplique.`
      : 'El cliente aún no tiene motos registradas en su garaje.';

    return `${namePart} ${garagePart}`.trim();
  } catch (err) {
    console.error('[chatbot] garage query failed:', err);
    return '';
  }
}

export function getGarageEntries(userId: number): Promise<string[]> {
  return pool
    .query(
      `SELECT brand, model, year FROM garage WHERE user_id = $1
       UNION
       SELECT NULL as brand, NULL as model, NULL as year WHERE FALSE`,
      [userId]
    )
    .then((res) => {
      const tableEntries: string[] = (res.rows as any[])
        .map((r) => [r.brand, r.model, r.year].filter(Boolean).join(' ').trim())
        .filter(Boolean);

      return pool
        .query(`SELECT garage FROM users WHERE id = $1`, [userId])
        .then((userRes) => {
          const out: string[] = [...tableEntries];
          if (userRes.rows.length > 0) {
            const raw = userRes.rows[0].garage;
            if (raw) {
              try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (Array.isArray(parsed)) {
                  for (const e of parsed) {
                    if (typeof e === 'string') {
                      if (e.trim()) out.push(e.trim());
                    } else if (e && typeof e === 'object') {
                      const s = [e.brand, e.model, e.year].filter(Boolean).join(' ').trim();
                      if (s) out.push(s);
                    }
                  }
                }
              } catch {}
            }
          }
          const seen = new Set<string>();
          return out.filter((s) => {
            const k = s.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        });
    })
    .catch((err) => {
      console.error('[chatbot] garage entries fetch failed:', err);
      return [];
    });
}

export async function getRecentOrdersContext(userId: number): Promise<string> {
  try {
    const res = await pool.query(
      `SELECT id, status, total, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 3`,
      [userId]
    );
    if (res.rows.length === 0) return 'El cliente aún no tiene pedidos registrados.';
    const orders = res.rows as any[];
    const statusMap: Record<string, string> = {
      pending: 'pendiente de pago',
      processing: 'en preparación',
      completed: 'completado/enviado',
      cancelled: 'cancelado',
      failed: 'con problema',
    };
    const summary = orders.map((o) => {
      const status = statusMap[o.status] || o.status;
      const date = new Date(o.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
      const total = (parseInt(o.total) / 100).toFixed(2);
      return `#${o.id} (${status}, ${total}€, ${date})`;
    }).join(', ');
    return `Pedidos recientes del cliente: ${summary}. Puedes ayudarle a consultar el estado de cualquiera de estos pedidos.`;
  } catch (err) {
    console.error('[chatbot] recent orders query failed:', err);
    return '';
  }
}
