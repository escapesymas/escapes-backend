/**
 * Palabras en inglés colándose en una respuesta en español.
 *
 * MiniMax M3.1 a veces mezcla una palabra inglesa en mitad de la frase («También Available hay opciones», «por su
 * reinforced construction», «resolver tu patiently»). El filtro de caracteres chinos ya existía; este detecta las inglesas
 * más típicas. Solo cuentan las que NO aparecen en lo que el modelo tenía delante (nombres de productos, mensaje del
 * cliente): «Racing», «Premium» o «Race» son del catálogo y valen.
 */

import { ES_BLOOM_B64, ES_BLOOM_BITS, ES_BLOOM_K } from './esWords.js';

// Palabras inglesas corrientes que no son españolas ni suelen aparecer en nombres de producto.
const ENGLISH = new Set([
  'available', 'availability', 'reinforced', 'patiently', 'patience', 'quality', 'price', 'prices', 'cheap', 'cheaper', 'cheapest',
  'better', 'best', 'good', 'great', 'strong', 'stronger', 'lighter', 'heavy', 'faster', 'slower', 'with', 'without', 'the', 'and', 'for',
  'your', 'you', 'this', 'that', 'these', 'those', 'will', 'would', 'should', 'could', 'only', 'also', 'very', 'more', 'most', 'less',
  'which', 'what', 'when', 'where', 'because', 'while', 'after', 'before', 'delivery', 'shipping', 'order', 'orders', 'brand', 'size',
  'color', 'colour', 'fits', 'fit', 'works', 'work', 'need', 'needs', 'want', 'wants', 'recommend', 'recommended', 'option', 'options',
  'construction', 'performance', 'durable', 'durability', 'lightweight', 'upgrade', 'replacement', 'compatible', 'compatibility',
  'warranty', 'return', 'returns', 'refund', 'stock', 'unfortunately', 'however', 'therefore', 'sorry', 'please', 'thanks', 'thank',
  'welcome', 'hello', 'customer', 'service', 'support', 'advisor', 'contact', 'email', 'address', 'payment', 'cost', 'costs', 'total',
  'high', 'low', 'new', 'old', 'big', 'small', 'long', 'short', 'right', 'left', 'front', 'rear', 'balance', 'equilibrium', 'tracking',
  'purchase', 'purchases', 'prioritise', 'prioritize', 'prioritizing', 'checkout', 'choose', 'chosen', 'check', 'make', 'makes', 'sure',
  'ensure', 'consider', 'provide', 'provides', 'include', 'includes', 'included', 'offer', 'offers', 'help', 'helps', 'helpful', 'find',
  'found', 'look', 'looks', 'looking', 'select', 'selection', 'perfect', 'exact', 'exactly', 'specific', 'specifically', 'generally',
  'usually', 'typically', 'depends', 'depending', 'based', 'since', 'then', 'than', 'about', 'between', 'through', 'during', 'within',
  'around', 'instead', 'always', 'never', 'just', 'here', 'there', 'their', 'them', 'they', 'have', 'been', 'being', 'from', 'into', 'over',
  'under', 'some', 'such', 'each', 'every', 'both', 'other', 'another', 'same', 'different', 'easy', 'hard', 'proper',
  'properly', 'correct', 'correctly', 'wrong', 'again', 'still', 'even', 'much', 'many', 'take', 'takes', 'give', 'gives', 'going', 'keep',
  'like', 'likes', 'love', 'enjoy', 'sell', 'sold', 'paid', 'shipped', 'shipment', 'receive', 'received', 'arrive', 'arrives', 'arrived',
  'wait', 'waiting', 'send', 'sent', 'write', 'tell', 'told', 'asked', 'answer', 'question', 'questions', 'problem', 'problems', 'issue',
  'issues', 'solution', 'solve', 'solved', 'repair', 'install', 'installation', 'mounted', 'remove', 'removed', 'change', 'changed', 'replaced',
  'replacing', 'transmission', 'refers', 'refer', 'sincerely', 'apologize', 'apologies', 'regarding', 'kindly', 'assist', 'assistance',
  'additional', 'information', 'details', 'detail', 'confirm', 'confirmed', 'confirmation', 'requirements', 'requirement', 'model', 'models',
]);

// Palabras de esa lista que sí son válidas en español o muy habituales en una tienda de moto: no se marcan.
const VALID_SPANISH_OR_TECH = new Set(['compatible', 'stock', 'email', 'total', 'service', 'balance', 'contact', 'support', 'color', 'fit', 'tracking']);

const WORD_RE = /[a-zA-Záéíóúñü]+/g;

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Palabras inglesas de la respuesta que no estaban en `allowedText`. `allowedText` es todo lo que el modelo tenía delante
 * (catálogo y mensajes del cliente).
 */
export function foreignWords(answer: string, allowedText: string): string[] {
  const allowed = new Set((norm(allowedText).match(/[a-z]+/g) || []));
  const out = new Set<string>();
  for (const w of norm(answer).match(WORD_RE) || []) {
    if (w.length < 4 || !ENGLISH.has(w) || VALID_SPANISH_OR_TECH.has(w) || allowed.has(w)) continue;
    out.add(w);
  }
  return [...out];
}

/** Traducción de último recurso de las palabras sueltas más frecuentes (si tras reintentar sigue habiéndolas). */
const FALLBACK: Record<string, string> = {
  available: 'disponible', reinforced: 'reforzado', patiently: 'con paciencia', quality: 'calidad', cheaper: 'más baratas', cheap: 'barata',
  better: 'mejor', best: 'mejor', good: 'buena', great: 'excelente', strong: 'resistente', only: 'solo', also: 'también', very: 'muy',
  delivery: 'entrega', shipping: 'envío', order: 'pedido', brand: 'marca', size: 'talla', option: 'opción', options: 'opciones',
  construction: 'construcción', durable: 'duradero', upgrade: 'mejora', replacement: 'recambio', warranty: 'garantía', return: 'devolución',
  refund: 'reembolso', sorry: 'lo siento', please: 'por favor', however: 'sin embargo', recommended: 'recomendado', recommend: 'recomiendo',
  purchase: 'compra', prioritise: 'priorizar', prioritize: 'priorizar', checkout: 'pago', sincerely: 'sinceramente', transmission: 'transmisión',
  refers: 'se refiere', refer: 'refiere', information: 'información', details: 'detalles', detail: 'detalle', question: 'pregunta', questions: 'preguntas',
  problem: 'problema', problems: 'problemas', issue: 'problema', issues: 'problemas', exactly: 'exactamente', specific: 'concreto', always: 'siempre',
  never: 'nunca', check: 'comprobar', choose: 'elegir', help: 'ayuda', find: 'encontrar', perfect: 'perfecto', different: 'distinto',
};

/**
 * Fragmentos rotos que a veces escribe el modelo («deAGN», «laTransmission»): una palabra que empieza en minúscula y lleva una mayúscula en medio.
 * Solo cuenta si no figura tal cual en lo que tenía delante (un «MotoGP» del catálogo es válido).
 */
export function garbledTokens(answer: string, allowedText: string): string[] {
  const out = new Set<string>();
  const allowed = allowedText.toLowerCase();
  // Debe empezar en minúscula: «PayPal», «MotoGP» o «YouTube» son nombres, no fragmentos rotos.
  for (const t of String(answer || '').match(/(?<![A-Za-záéíóúñü])[a-záéíóúñü]+[A-ZÁÉÍÓÚÑ][A-Za-záéíóúñü]*/g) || []) {
    if (!allowed.includes(t.toLowerCase())) out.add(t);
  }
  return [...out];
}

export function stripForeignWords(answer: string, words: string[]): string {
  let out = answer;
  for (const w of words) {
    const es = FALLBACK[w];
    out = out.replace(new RegExp(`\\b${w}\\b`, 'gi'), es ?? '').replace(/[ \t]{2,}/g, ' ');
  }
  return out.replace(/\s+([.,;:!?])/g, '$1').trim();
}

// ── Palabras que no existen en español ────────────────────────────────────────────────────────────────────────────
// MiniMax a veces escribe una palabra que no es de ningún idioma útil («waitress», «mingle», «te/helpemos»). El diccionario
// de español va en un filtro de Bloom (esWords.ts, ≈1 % de falsos positivos: una palabra rota pasa con esa probabilidad).
// Un falso negativo del diccionario (una palabra válida que no figura) solo cuesta un reintento.
const bloomBits = Buffer.from(ES_BLOOM_B64, 'base64');

function bloomHas(word: string): boolean {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (const b of Buffer.from(word, 'utf8')) {
    h1 = Math.imul(h1 ^ b, 16777619) >>> 0;
    h2 = (Math.imul(h2, 33) + b) >>> 0;
  }
  h2 = (h2 | 1) >>> 0;
  for (let i = 0; i < ES_BLOOM_K; i++) {
    const idx = (h1 + i * h2) % ES_BLOOM_BITS;
    if (!(bloomBits[idx >> 3] & (1 << (idx & 7)))) return false;
  }
  return true;
}

const CLITICS = ['nos', 'les', 'los', 'las', 'me', 'te', 'se', 'lo', 'la', 'le', 'os'];
const deaccent = (w: string) => w.normalize('NFD').replace(/\p{Diacritic}/gu, '').normalize('NFC');

/** Verbo con pronombres pegados («inclúyelo», «indícamelo», «confirmármelo»): vale si el verbo suelto vale (con o sin tilde). */
function validWithClitics(word: string, depth = 0): boolean {
  if (depth > 2) return false;
  for (const c of CLITICS) {
    if (word.length > c.length + 2 && word.endsWith(c)) {
      const stem = word.slice(0, -c.length);
      if (bloomHas(stem) || bloomHas(deaccent(stem)) || validWithClitics(stem, depth + 1)) return true;
    }
  }
  return false;
}

function validSpanishWord(w: string): boolean {
  if (bloomHas(w)) return true;
  if (validWithClitics(w)) return true;
  // «-mente» sobre un adjetivo que sí figura; plurales y femeninos de palabras técnicas sueltas.
  if (w.endsWith('mente') && bloomHas(w.slice(0, -5))) return true;
  return false;
}

/**
 * Palabras de la respuesta que no son españolas (ni del catálogo ni de lo que dijo el cliente). Se ignoran las que empiezan
 * en mayúscula (marcas, modelos, siglas, inicio de frase). Se desactiva con CHAT_SPELLCHECK=off.
 */
export function unknownWords(answer: string, allowedText: string): string[] {
  if (process.env.CHAT_SPELLCHECK === 'off') return [];
  const allowed = new Set(allowedText.toLowerCase().match(/[\p{L}]+/gu) || []);
  const out = new Set<string>();
  for (const token of String(answer || '').match(/[\p{L}]+/gu) || []) {
    if (token.length < 4) continue;
    if (token[0] !== token[0].toLowerCase()) continue;
    const w = token.toLowerCase().normalize('NFC');
    if (allowed.has(w) || validSpanishWord(w)) continue;
    out.add(w);
  }
  return [...out];
}

/** Una palabra desconocida con pinta de inglés (letras o terminaciones que casi no existen en español): se puede quitar sin miedo. */
export function looksForeign(word: string): boolean {
  return /[wk]|th|ck|sh|ou|ow|ph|(ed|ing|ly|ous|ness|ment|tion|ship|ity|ive|ess)$/.test(word);
}

/** Último recurso: quita las palabras desconocidas que parecen inglesas (las dudosas se dejan: puede ser español válido que el diccionario no tiene). */
export function stripUnknownForeign(answer: string, allowedText: string): string {
  let out = answer;
  for (const w of unknownWords(answer, allowedText)) {
    if (looksForeign(w)) out = out.replace(new RegExp(`\\b${w}\\b`, 'gi'), '');
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}
