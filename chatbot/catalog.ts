import { pool } from '../db.js';
import { listFamilies, normalizeText, searchTerms } from '../lib/catalog-query.js';
import { formatOrderNumber, eur } from '../lib/email-templates.js';

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

// El año llega como «(2021)» (JSON antiguo) o suelto («YAMAHA MT-07 2021», tabla garage).
const GARAGE_YEAR_RE = /\(?\b(19[5-9]\d|20[0-4]\d)\b\)?/;

function parseGarageMotorcycle(entry: string): GarageMotorcycle | null {
  const s = (entry || '').trim();
  if (!s) return null;
  const m = s.match(GARAGE_YEAR_RE);
  const year = m ? parseInt(m[1], 10) : null;
  const withoutYear = s.replace(GARAGE_YEAR_RE, ' ').replace(/\s+/g, ' ').trim();
  const parts = withoutYear.split(' ');
  if (parts.length < 2) return null;
  return {
    brand: parts[0].toUpperCase(),
    model: parts.slice(1).join(' ').toUpperCase(),
    year: Number.isFinite(year as number) ? (year as number) : null,
  };
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
    // La ficha se abre por la referencia tal cual (/producto/07YA23SA; en minúsculas da 404).
    slug: row.slug || row.sku || String(row.id),
    compatibility: row.compatibility,
    category2: row.category2,
    category3: row.category3,
  };
}

function formatHitText(p: CatalogHit, tag = ''): string {
  const priceStr = p.sale_price
    ? `${(p.sale_price / 100).toFixed(2)}€ (antes ${(p.price / 100).toFixed(2)}€)`
    : `${(p.price / 100).toFixed(2)}€`;
  const stockStr = (p.stock || 0) > 0 ? `stock: ${p.stock}` : 'sin stock';
  return `- ${tag ? `${tag} ` : ''}${p.sku} | ${p.brand || 'Genérico'} | "${p.name}" | ${priceStr} | ${stockStr}`;
}

/** «MT-07» → /(^|[^A-Z0-9])MT[\s-]?07(?![A-Z0-9])/: no confunde la Z900 con la Z900RS. */
function modelPattern(model: string): RegExp | null {
  const chunks = model.toUpperCase().match(/[A-Z]+|\d+/g);
  if (!chunks) return null;
  return new RegExp(`(^|[^A-Z0-9])${chunks.join('[\\s./-]?')}(?![A-Z0-9])`);
}

/** Años de la moto (marca y modelo) con los que el producto es compatible. */
function compatibleYears(hit: CatalogHit, moto: GarageMotorcycle): number[] | null {
  const list = Array.isArray(hit.compatibility) ? hit.compatibility : [];
  if (list.length === 0) return null; // sin datos de compatibilidad
  const re = modelPattern(moto.model);
  const years = new Set<number>();
  for (const e of list) {
    if (moto.brand && String(e?.brand || '').toUpperCase() !== moto.brand) continue;
    if (re && !re.test(String(e?.model || '').toUpperCase())) continue;
    const y = parseInt(e?.year, 10);
    if (Number.isFinite(y)) years.add(y);
  }
  return [...years].sort((x, y) => x - y);
}

function yearRanges(years: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < years.length; i++) {
    let j = i;
    while (j + 1 < years.length && years[j + 1] === years[j] + 1) j++;
    out.push(i === j ? `${years[i]}` : `${years[i]}-${years[j]}`);
    i = j;
  }
  return out.join(', ');
}

/**
 * Filtra por la moto (y el año, si se sabe) con la compatibilidad de cada
 * producto: del mismo modelo cambian las piezas según el año (MT-07 2014-2016,
 * 2017-2020 y 2021+). Devuelve los productos con la etiqueta para el asistente.
 */
function filterByMoto(hits: CatalogHit[], moto: GarageMotorcycle): { hit: CatalogHit; tag: string }[] {
  const name = `${moto.brand} ${moto.model}`.replace(/[¿?¡!,;]/g, '').trim();
  const verified: { hit: CatalogHit; tag: string }[] = [];
  const unknown: { hit: CatalogHit; tag: string }[] = [];
  for (const hit of hits) {
    const years = compatibleYears(hit, moto);
    if (years === null) { unknown.push({ hit, tag: '' }); continue; } // sin datos: se ofrece sin garantizar
    if (years.length === 0) continue; // tiene compatibilidades, pero no con esta moto
    if (moto.year) {
      if (years.includes(moto.year)) verified.push({ hit, tag: `[COMPATIBLE VERIFICADO CON ${name} (${moto.year})]` });
    } else {
      verified.push({ hit, tag: `[COMPATIBLE CON ${name} DE ${yearRanges(years)}]` });
    }
  }
  return [...verified, ...unknown];
}


// Palabras de conversación que no describen el producto («¿tenéis…?», «me
// recomiendas…»): el buscador de la web exige que aparezcan todas.
const CHAT_FILLER = new Set([
  'hola', 'buenas', 'buenos', 'dias', 'tardes', 'noches', 'gracias', 'por', 'favor', 'porfa',
  'teneis', 'tienes', 'tiene', 'tienen', 'hay', 'vendeis', 'venden', 'busco', 'buscando', 'buscaba',
  'quiero', 'quisiera', 'queria', 'necesito', 'necesitaria', 'recomienda', 'recomiendas', 'recomendais',
  'me', 'mi', 'mis', 'te', 'se', 'su', 'sus', 'yo', 'que', 'cual', 'cuales', 'algun', 'alguno', 'alguna',
  'algo', 'unos', 'unas', 'uno', 'moto', 'compatible', 'compatibles', 'sirve', 'sirven', 'valen', 'vale',
  'puedo', 'podeis', 'poner', 'montar', 'cambiar', 'comprar', 'precio', 'cuanto', 'cuesta', 'stock',
  'tengo', 'mia', 'nueva', 'buena', 'bueno', 'mejor', 'barato', 'barata', 'es', 'son', 'si', 'no',
  'este', 'esta', 'ese', 'esa', 'como', 'donde', 'pues', 'ok', 'tambien', 'o',
  'baratos', 'baratas', 'caro', 'cara', 'caros', 'caras', 'mas', 'menos', 'otro', 'otra', 'otros', 'otras',
  'ver', 'ensena', 'ensename', 'muestrame', 'dime', 'opciones', 'modelos', 'hay', 'diferencia', 'entre',
]);

// Palabras de pedidos, envíos y cuenta: si el mensaje solo trae estas, no se
// busca en el catálogo («¿cómo va mi pedido?», «¿cuánto cuesta el envío?»).
const NON_PRODUCT = new Set([
  'pedido', 'pedidos', 'envio', 'envios', 'enviar', 'enviais', 'entrega', 'entregas', 'llega', 'llegara',
  'tarda', 'tardan', 'plazo', 'plazos', 'devolucion', 'devoluciones', 'devolver', 'garantia', 'reembolso',
  'factura', 'facturas', 'pago', 'pagar', 'pagos', 'bizum', 'klarna', 'tarjeta', 'cuenta', 'contrasena',
  'registro', 'registrarme', 'cupon', 'cupones', 'descuento', 'descuentos', 'codigo', 'estado', 'seguimiento',
  'tracking', 'horario', 'telefono', 'contacto', 'contactar', 'tienda', 'web', 'gastos', 'gratis', 'va',
  'ayuda', 'ayudar', 'ayudarme', 'informacion', 'info', 'cancelar', 'anular', 'cambio', 'direccion', 'iva',
  'canarias', 'baleares', 'ceuta', 'melilla', 'portugal', 'francia', 'italia', 'alemania', 'europa',
  'dias', 'horas', 'semana', 'semanas', 'cuando', 'tiempo', 'adios', 'vale', 'genial', 'perfecto',
]);

/** Lo que el cliente busca, sin el relleno de la conversación. */
function productSearchText(text: string): string {
  return normalizeText(text)
    .replace(/[^a-z0-9.\-/ ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !CHAT_FILLER.has(w))
    .join(' ')
    .trim();
}

/**
 * Busca como el catálogo de la web y devuelve un producto por modelo (el
 * representativo: con stock y el más barato). Sin resultados aproximados, para
 * no ofrecer piezas de otra moto.
 */
async function searchLikeWeb(search: string, perPage = 12): Promise<CatalogHit[]> {
  if (!search) return [];
  try {
    // Una sola consulta exacta; los modelos con stock van primero.
    const res = await listFamilies({ search }, 'relevance', 1, perPage, { exact: true });
    if (res.total === 0) return [];
    const ids = res.rows.map((r) => r.rep_id);
    const { rows } = await pool.query(
      `SELECT id, sku, name, brand, price, sale_price, promo_price, stock, stock_status,
              images, compatibility, category2, category3
       FROM products WHERE id = ANY($1::int[])`,
      [ids]
    );
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a: any, b: any) => Number(b.stock > 0) - Number(a.stock > 0))
      .map((r: any) => {
        // Precio que paga el cliente: promoción, o el menor entre PVP y DTO1.
        const eff = Number(r.promo_price) > 0
          ? Number(r.promo_price)
          : Math.min(Number(r.price), Number(r.sale_price) > 0 ? Number(r.sale_price) : Number(r.price));
        return mapHit({ ...r, sale_price: eff < Number(r.price) ? eff : null });
      });
  } catch (err) {
    console.error('[chatbot] búsqueda como la web falló:', err);
    return [];
  }
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

export function extractMotorcycleFromQuery(query: string): GarageMotorcycle | null {
  const cleaned = query.trim();
  const lower = cleaned.toLowerCase();

  let detectedBrand = '';
  let brandPos = -1;
  let brandLen = 0;

  for (const alias of Object.keys(BRAND_ALIASES)) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) {
      const charBefore = idx > 0 ? lower[idx - 1] : ' ';
      const charAfter = idx + alias.length < lower.length ? lower[idx + alias.length] : ' ';
      if (!/[a-z0-9]/.test(charBefore) && !/[a-z0-9]/.test(charAfter)) {
        detectedBrand = BRAND_ALIASES[alias];
        brandPos = idx;
        brandLen = alias.length;
        break;
      }
    }
  }

  const yearMatch = lower.match(/\b(19[8-9]\d|20[0-3]\d)\b/);
  const detectedYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

  let modelStr = '';

  if (detectedBrand && brandPos !== -1) {
    let afterBrand = lower.substring(brandPos + brandLen).trim();
    afterBrand = afterBrand.replace(/\b(19[8-9]\d|20[0-3]\d)\b/g, '').replace(/\(\s*\)/g, '').trim();

    const stopWords = /\b(para|como|tengo|tienes|quiero|busco|hola|dias|tardes|noches|este|esta|cambiar|comprar|recambio|recambios|escape|escapes|transmision|transmisión|cadena|cadenas|piñon|piñones|piñón|pinon|corona|coronas|filtro|filtros|aceite|pastilla|pastillas|freno|frenos|kit|embrague|bateria|bujia|bujías|del|con|sin|que|qué)\b/gi;

    // El modelo acaba en la primera puntuación o conjunción y tiene como mucho 3
    // palabras («mt-07 y alguna más barata?» → «MT-07»).
    afterBrand = afterBrand.split(/[¿?¡!,.;:()]|\s(?:y|e|o|u|de|del|año|es|era|son|tiene|tengo|modelo|pero|alguna?|algun|mas|más|que|qué)(?:\s|$)/)[0];
    const parts = afterBrand.split(stopWords);
    const firstSegment = (parts[0] || '').trim().split(/\s+/).slice(0, 3).join(' ');
    if (firstSegment && firstSegment.length >= 1) {
      modelStr = firstSegment.toUpperCase().replace(/\s+/g, ' ');
    }
  }

  if (!modelStr) {
    const modelPattern = /\b([a-z]{1,3}\s*\d{2,4}\s*[a-z]{0,4}|[a-z]+\s*\d{2,4})\b/gi;
    const matches = lower.match(modelPattern) || [];
    for (const m of matches) {
      const cleanM = m.trim().toUpperCase();
      if (KNOWN_BRANDS.has(cleanM)) continue;
      if (/^(PARA|COMO|TENGO|TIENES|QUIERO|BUSCO|HOLA|CAMBIAR|COMPRAR|RECAMBIO|ESCAPE|TRANSMISION|CADENA|PIÑON|CORONA|KIT)$/i.test(cleanM)) continue;
      modelStr = cleanM;
      break;
    }
  }

  if (!detectedBrand && !modelStr) return null;

  return {
    brand: detectedBrand || '',
    model: modelStr || '',
    year: detectedYear,
  };
}

// Resumen real del catálogo para preguntas generales (antes decía «Akrapovic,
// Arrow…», marcas que la tienda no tiene). Se refresca cada 6 h.
let summaryCache: { at: number; text: string } | null = null;

async function catalogSummary(): Promise<string> {
  if (summaryCache && Date.now() - summaryCache.at < 6 * 3600_000) return summaryCache.text;
  try {
    const [{ rows: [n] }, { rows: cats }, { rows: brands }] = await Promise.all([
      pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE stock > 0)::int AS stock
                  FROM products WHERE status = 'published' AND price > 0`),
      pool.query(`SELECT c.name, count(*)::int AS n FROM products p JOIN categories c ON c.id = p.category_id
                  WHERE p.status = 'published' AND p.price > 0 AND c.status = 'active'
                  GROUP BY c.name ORDER BY n DESC LIMIT 12`),
      pool.query(`SELECT brand, count(*)::int AS n FROM products
                  WHERE status = 'published' AND price > 0 AND stock > 0 AND coalesce(brand, '') <> ''
                  GROUP BY brand ORDER BY n DESC LIMIT 20`),
    ]);
    const fmt = (x: number) => x.toLocaleString('es-ES');
    const text = `Resumen del catálogo: ${fmt(n.total)} productos (${fmt(n.stock)} con stock). ` +
      `Categorías: ${cats.map((c: any) => c.name).join(', ')}. ` +
      `Marcas con más referencias en stock: ${brands.map((b: any) => b.brand).join(', ')}. ` +
      `Si preguntan por una marca o producto concreto que no aparezca aquí, pídeles más detalles para buscarlo.`;
    summaryCache = { at: Date.now(), text };
    return text;
  } catch (err) {
    console.error('[chatbot] resumen del catálogo falló:', err);
    return 'Catálogo de recambios, accesorios y equipamiento para moto.';
  }
}

/**
 * La palabra menos frecuente en los nombres del catálogo, si aparece en menos de
 * 100 productos (frases y números no cuentan): la candidata a quitar cuando una
 * búsqueda no da nada.
 */
async function rarestTerm(terms: string[]): Promise<string | null> {
  const words = terms.filter((t) => !t.includes(' ') && t.length >= 3 && !/^\d+$/.test(t));
  if (words.length === 0) return null;
  try {
    const { rows } = await pool.query(`SELECT word, freq FROM catalog_words WHERE word = ANY($1::text[])`, [words]);
    const freq = new Map(rows.map((r: any) => [r.word, Number(r.freq)]));
    const ranked = words.map((w) => ({ w, f: freq.get(w) ?? 0 })).sort((a, b) => a.f - b.f);
    return ranked[0].f < 100 ? ranked[0].w : null;
  } catch {
    return null;
  }
}

/** Términos de producto de un mensaje (sin relleno ni palabras de pedidos). */
function productTerms(text: string): string[] {
  return searchTerms(productSearchText(text)).filter((w) => !NON_PRODUCT.has(w));
}

/**
 * Lo que hay que buscar teniendo en cuenta la conversación: en «¿y para la
 * trasera?» o «¿alguna más barata?» se arrastra la petición anterior, y si el
 * mensaje no nombra moto se usa la última que haya salido.
 */
export function buildSearchQuery(userMessages: string[]): string {
  const msgs = userMessages.map((m) => m.trim()).filter(Boolean);
  const last = msgs[msgs.length - 1] || '';
  const previous = msgs.slice(0, -1).reverse().slice(0, 3);
  let query = last;
  // Sin producto propio («¿y alguna más barata?», «¿y la trasera?») se arrastra la
  // petición anterior; con producto propio («¿y pastillas?») solo la moto.
  if (previous.length > 0 && productTerms(last).length <= 1) {
    const lastRequest = previous.find((m) => productTerms(m).length > 0);
    if (lastRequest) query = `${lastRequest} ${last}`;
  }
  if (!extractMotorcycleFromQuery(query)?.brand) {
    for (const m of previous) {
      const moto = extractMotorcycleFromQuery(m);
      if (moto?.brand) { query = `${query} ${moto.brand} ${moto.model}${moto.year ? ` ${moto.year}` : ''}`.trim(); break; }
    }
  }
  return query;
}

/** Búsqueda del asistente: los mismos resultados que el catálogo de la web. */
export async function getCatalogContext(
  query: string,
  garageEntries: string[] = []
): Promise<CatalogContextResult> {
  let base = productSearchText(query);
  if (productTerms(query).length === 0) {
    return { hits: [], text: await catalogSummary() };
  }

  // Moto nombrada en la consulta (solo si se reconoce la marca: «talla 58» no es una moto).
  const parsed = extractMotorcycleFromQuery(query);
  const queryMoto = parsed?.brand ? parsed : null;
  // El año de la moto no está en el texto de búsqueda (se filtra después con la
  // compatibilidad): «pastillas mt-07 2019» buscaría «2019» y no daría nada.
  if (queryMoto?.year) base = base.replace(new RegExp(`\\b${queryMoto.year}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim();
  const garageMoto = !queryMoto
    ? garageEntries.map(parseGarageMotorcycle).find((m): m is GarageMotorcycle => !!m && !!m.brand) || null
    : null;

  // Sin moto en la consulta, primero se prueba con la del garaje («pastillas de
  // freno» → las de su MT-07) y si no hay nada, sin moto (un casco no depende de ella).
  const attempts: { search: string; moto: GarageMotorcycle | null }[] = [];
  if (garageMoto) {
    attempts.push({ search: `${base} ${productSearchText(`${garageMoto.brand} ${garageMoto.model}`)}`, moto: garageMoto });
  }
  attempts.push({ search: base, moto: queryMoto });

  // Con moto se piden más modelos: después se quitan los que no le valen por año.
  const run = async (search: string, m: GarageMotorcycle | null) => {
    const found = await searchLikeWeb(search, m ? 36 : 12);
    return m ? filterByMoto(found, m) : found.map((hit) => ({ hit, tag: '' }));
  };

  let found: { hit: CatalogHit; tag: string }[] = [];
  let moto: GarageMotorcycle | null = null;
  for (const a of attempts) {
    found = await run(a.search, a.moto);
    if (found.length > 0) { moto = a.moto; break; }
  }

  // ¿Pide algo que no tenemos («escape Akrapovic para Z900», «guantes de
  // verano»)? Se quita la palabra más rara del catálogo (una marca que no hay, un
  // adjetivo) y se ofrece lo que haya; nunca el tipo de pieza («kit de arrastre»).
  let missing = '';
  if (found.length === 0) {
    const motoTerms = new Set(queryMoto ? searchTerms(`${queryMoto.brand} ${queryMoto.model}`) : []);
    const terms = searchTerms(base);
    const rare = await rarestTerm(terms.filter((w) => !motoTerms.has(w)));
    if (rare && terms.length >= 2) {
      found = await run(terms.filter((w) => w !== rare).join(' '), queryMoto);
      if (found.length > 0) { missing = rare; moto = queryMoto; }
    }
  }

  if (found.length === 0) {
    const what = queryMoto
      ? `${base} (moto ${queryMoto.brand} ${queryMoto.model}${queryMoto.year ? ` de ${queryMoto.year}` : ''})`
      : base;
    return {
      hits: [],
      text: `NO SE ENCONTRARON PRODUCTOS PARA «${what}». Dile al cliente que ahora mismo no lo tenemos en el catálogo, ` +
        `no ofrezcas piezas de otra moto ni de otro año y pídele más detalles o que escriba a info@escapesymas.com.`,
    };
  }

  // Dos por marca para variar, respetando el orden (compatibles verificados primero).
  const perBrand = new Map<string, number>();
  const shown = found.filter(({ hit }) => {
    const k = (hit.brand || '').toUpperCase().trim();
    const n = perBrand.get(k) || 0;
    if (n >= 2) return false;
    perBrand.set(k, n + 1);
    return true;
  }).slice(0, 6);

  const notes: string[] = [];
  if (missing) notes.push(`NO HAY NADA QUE CUMPLA «${missing}» EN ESTA BÚSQUEDA. Díselo al cliente y ofrécele estas alternativas.`);
  if (moto && moto === garageMoto) {
    notes.push(`Resultados para su moto ${moto.brand} ${moto.model}${moto.year ? ` (${moto.year})` : ''} (la elegida en la web o la primera de su garaje).`);
    if (garageEntries.length > 1) {
      notes.push(`Tiene más motos guardadas (${garageEntries.slice(1, 4).join(', ')}): menciona para cuál son y ofrece buscar para otra.`);
    }
  }
  if (moto && !moto.year) {
    notes.push('NO SABEMOS EL AÑO DE LA MOTO: indica los años compatibles de cada producto y pregúntale el año para confirmar.');
  }
  if (shown.some((x) => !x.tag) && moto) {
    notes.push('Los productos sin etiqueta de compatibilidad no tienen datos de compatibilidad: dilo y recomienda comprobar la medida o la referencia original.');
  }
  const text = [...notes, ...shown.map(({ hit, tag }) => formatHitText(hit, tag))].join('\n');
  return { hits: shown.map((x) => x.hit), text };
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
      `SELECT id, status, total, created_at, carrier, tracking_number, tracking_url
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [userId]
    );
    if (res.rows.length === 0) return 'Pedidos del cliente: todavía no tiene ninguno.';
    // Los mismos estados y números de pedido que ve en Mi cuenta.
    const statusMap: Record<string, string> = {
      pending: 'pendiente de pago',
      pending_payment: 'pendiente de pago',
      payment_failed: 'pago fallido',
      payment_amount_mismatch: 'en revisión',
      paid: 'pagado',
      processing: 'en preparación',
      shipped: 'enviado',
      delivered: 'entregado',
      completed: 'completado',
      cancelled: 'cancelado',
      refunded: 'reembolsado',
      partially_refunded: 'reembolso parcial',
    };
    const lines = (res.rows as any[]).map((o) => {
      const date = new Date(o.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
      const tracking = o.tracking_number
        ? `, seguimiento ${o.carrier ? `${o.carrier} ` : ''}${o.tracking_number}${o.tracking_url ? ` (${o.tracking_url})` : ''}`
        : '';
      return `- Pedido ${formatOrderNumber(o.id, o.created_at)} del ${date}: ${statusMap[o.status] || o.status}, ${eur(o.total)}${tracking}`;
    });
    return `Pedidos recientes del cliente (el detalle está en Mi cuenta → Mis pedidos):\n${lines.join('\n')}`;
  } catch (err) {
    console.error('[chatbot] recent orders query failed:', err);
    return '';
  }
}
