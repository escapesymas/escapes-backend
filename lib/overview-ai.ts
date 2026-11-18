/**
 * Informe de la Vista general redactado por la IA (MiniMax) a partir de los mismos datos que enseña la pantalla.
 *
 * La IA solo recibe cifras ya calculadas (nunca consulta nada) y se le prohíbe inventar; no recibe datos personales de clientes.
 * El informe se redacta POR SECCIONES, en paralelo: MiniMax M3.1 Flash se desvía al chino en textos largos (en las pruebas del
 * 18/11/2026, 5 de 6 intentos de un texto de ~500 palabras) y mucho menos en textos cortos. Así solo se repite la sección que falla.
 * Cada sección pasa por el corrector de español del asistente de la web (chino, inglés y palabras que no existen).
 */
import { minimaxClient, CHAT_MODEL } from '../chatbot/minimax.js';
import { foreignWords, garbledTokens, stripForeignWords, stripUnknownForeign, unknownWords } from '../chatbot/spanishGuard.js';
import { DEVICE_NAMES, GROUP_ORDER, GROUP_TITLES, PAYMENT_NAMES, cityLabel, deltaOf, fmtDay, fmtValue } from './overview-format.js';
import type { OverviewReport } from './overview-report.js';

const CJK_RE = new RegExp('[\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]+', 'g');
const CJK_ANY_RE = new RegExp('[\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]');

export const SYSTEM_PROMPT = `Eres el analista de negocio de «Escapes y Más», una tienda online de escapes, recambios y accesorios de moto. Redactas el informe de rendimiento para Adrián, el dueño. El informe se escribe por secciones: en cada petición te piden UNA.

REGLAS
- Escribe en español de España, claro, directo y sin jerga innecesaria.
- Usa SOLO los datos que se te dan. No inventes cifras, causas ni hechos. Cita las cifras tal y como vienen (no recalcules porcentajes).
- La tienda es pequeña: con pocos pedidos o pocas visitas una variación no es una tendencia. Si la muestra es pequeña, dilo en una frase y no saques conclusiones fuertes.
- El informe compara el periodo con un periodo de comparación (el periodo anterior o el mismo periodo del año pasado; los datos dicen cuál). Menciona siempre con cuál se compara.
- Si el periodo de comparación vale 0, no hables de porcentaje: di la cifra y que antes no había.
- Si un dato pone «sin datos» en el periodo de comparación, no compares ese dato: di que de ese periodo no hay datos.
- Compara con el periodo de comparación cuando haya dato. Distingue lo que mejora de lo que empeora según la columna «bueno si».
- Escribe SOLO con el alfabeto latino: nunca caracteres chinos ni de otros alfabetos, ni palabras en inglés.
- Conjuga bien los verbos: «ha bajado», «han subido», «ha mejorado» (nunca «ha bajar»).
- No menciones nombres de proveedores ni mayoristas.
- Las cifras con «foto del momento» (carritos activos, catálogo, clientes registrados) no se comparan con el pasado.
- Escribe solo el cuerpo de la sección pedida: sin título, sin tablas, sin emojis. Puedes usar párrafos cortos y listas con guiones o numeradas.`;

export interface Section { title: string; brief: string; words: string }

/** Secciones del informe, en el orden en que salen. */
export const SECTIONS: Section[] = [
  { title: 'Resumen ejecutivo', brief: 'Lo más importante del periodo en 3 o 4 frases: qué ha pasado, si va mejor o peor que en el periodo de comparación y qué destaca.', words: '60 a 90' },
  { title: 'Ventas y márgenes', brief: 'Ventas, pedidos, ticket medio, margen, cupones, reembolsos y productos más vendidos.', words: '60 a 100' },
  { title: 'Visitas y origen del tráfico', brief: 'Visitantes, páginas vistas, rebote, de dónde vienen, dispositivos, páginas más vistas, búsquedas (también las que no dan resultados) y errores 404.', words: '70 a 110' },
  { title: 'Embudo y carritos', brief: 'Cómo pasan los visitantes de ver una ficha a pagar, los carritos activos y su valor, los abandonados y los recuperados.', words: '70 a 110' },
  { title: 'Atención al cliente', brief: 'Conversaciones con el asistente IA y con asesores, esperas, propuestas de pedido, reseñas y reembolsos.', words: '40 a 70' },
  { title: 'Alertas', brief: 'Solo lo que preocupa de verdad, en una lista con guiones. Si no hay nada, escribe exactamente «Sin alertas relevantes.»', words: '30 a 80' },
  { title: 'Recomendaciones', brief: 'Entre 3 y 5 recomendaciones numeradas, la más importante primero. Cada una concreta, accionable y con el motivo basado en los datos.', words: '90 a 140' },
];

/** Datos del informe en texto compacto: es lo único que ve la IA. */
export function reportToPromptText(r: OverviewReport): string {
  const L: string[] = [];
  L.push(`PERIODO: ${r.period.label} (${r.period.from} a ${r.period.to}, ${r.period.days} día${r.period.days === 1 ? '' : 's'}).`);
  L.push(`COMPARADO CON: ${r.period.prevLabel} (${r.period.prevFrom} a ${r.period.prevTo}) — ${r.period.compare === 'yoy' ? 'el mismo periodo del año pasado' : 'el periodo anterior equivalente'}.`);
  L.push(`Hay datos de la tienda desde ${r.dataSince.store ?? 'siempre'} y de las visitas desde ${r.dataSince.visits ?? 'nunca'}.`);
  L.push(`Tráfico propio de Canarias ${r.excludeInternal ? 'excluido' : 'incluido'} en las visitas.`);
  for (const g of GROUP_ORDER) {
    const ks = r.kpis.filter((k) => k.group === g);
    if (!ks.length) continue;
    L.push('', `## ${GROUP_TITLES[g]}`, 'indicador | periodo | periodo de comparación | variación | bueno si');
    for (const k of ks) {
      const d = deltaOf(k);
      const prev = k.prev == null ? (k.noPrev ? 'sin datos' : 'foto del momento') : fmtValue(k.prev, k.unit);
      L.push(`${k.label} | ${fmtValue(k.value, k.unit)} | ${prev} | ${d.text || '-'} | ${k.good === 'up' ? 'subir' : k.good === 'down' ? 'bajar' : 'neutro'}${k.hint ? ` (${k.hint})` : ''}`);
    }
  }
  if (r.funnel.length) {
    L.push('', '## Embudo (visitantes que llegan a cada paso; periodo | comparación)');
    for (const f of r.funnel) L.push(`${f.label}: ${f.current} | ${f.previous ?? 'sin datos'}`);
  }
  if (r.sales.topProducts.length) {
    L.push('', '## Productos más vendidos');
    for (const p of r.sales.topProducts) L.push(`${p.name} (ref. ${p.sku}): ${p.units} ud., ${fmtValue(p.revenue, 'eur')}`);
  }
  if (r.sales.payments.length) L.push('', `## Métodos de pago: ${r.sales.payments.map((p) => `${PAYMENT_NAMES[p.method] || p.method} ${p.orders} pedido(s)`).join('; ')}`);
  if (r.sales.coupons.length) L.push(`## Cupones usados: ${r.sales.coupons.map((c) => `${c.code} ${c.orders} pedido(s)`).join('; ')}`);
  const v = r.visits;
  if (v) {
    if (v.topPages.length) L.push('', '## Páginas más vistas', ...v.topPages.slice(0, 6).map((p) => `${p.path}: ${p.views} vistas, ${p.visitors} visitantes`));
    if (v.sources.length) L.push('', `## Origen de los visitantes: ${v.sources.map((s) => `${s.name} ${s.visitors}`).join('; ')}`);
    if (v.devices.length) L.push(`## Dispositivos: ${v.devices.map((d) => `${DEVICE_NAMES[d.device] || d.device} ${d.visitors}`).join('; ')}`);
    if (v.cities.length) L.push(`## Ciudades: ${v.cities.slice(0, 5).map((c) => `${cityLabel(c.city, c.country)} ${c.visitors}`).join('; ')}`);
    if (v.topSearches.length) L.push(`## Búsquedas más frecuentes: ${v.topSearches.map((s) => `«${s.term}» (${s.count})`).join('; ')}`);
    if (v.noResultSearches.length) L.push(`## Búsquedas SIN resultados: ${v.noResultSearches.map((s) => `«${s.term}» (${s.count})`).join('; ')}`);
    if (v.topBikes.length) L.push(`## Motos que más eligen: ${v.topBikes.map((s) => `${s.term} (${s.count})`).join('; ')}`);
    const busiest = [...v.byDay].sort((a, b) => b.visitors - a.visitors)[0];
    if (busiest && v.byDay.length > 1) L.push(`## Día con más visitantes: ${fmtDay(busiest.date)} (${busiest.visitors})`);
  }
  if (r.carts.top.length) L.push('', `## Carritos activos de más valor (${r.carts.active.guests} de ${r.carts.active.count} son de invitados): ${r.carts.top.map((c) => `${fmtValue(c.value, 'eur')} (${c.items} ud.)`).join('; ')}`);
  if (r.warnings.length) L.push('', `## Avisos: ${r.warnings.join(' ')}`);
  return L.join('\n');
}

/** «ha bajar», «han subir»: el modelo a veces deja el infinitivo tras «haber» (en vez de «ha bajado»). */
export function badParticiples(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(ha|han|has|he|hemos|habéis)\s+([a-záéíóúñ]{3,}(?:ar|er|ir))\b/gi)) out.add(m[0].toLowerCase());
  return [...out];
}

/** Quita el razonamiento que a veces se cuela delante del texto y los caracteres que no son españoles. */
function stripThink(raw: string): string {
  let text = raw;
  const close = [...text.matchAll(/<\/\s*(mm:)?think(ing)?\s*>/gi)].pop();
  if (close) text = text.slice(close.index! + close[0].length);
  return text.replace(/<\s*(mm:)?think(ing)?\s*>[\s\S]*?<\/\s*(mm:)?think(ing)?\s*>/gi, '').trim();
}

export interface AiReportResult { text: string; model: string; attempts: number; notes: string[]; tokens: number }

const MAX_ATTEMPTS = 3;
// Las 7 secciones a la vez: cada reintento solo repite la suya y la espera total es la de la sección más lenta.
const PARALLEL = 7;

/** Palabras válidas del informe que el diccionario del corrector marca por error (se amplía si aparece otra en los logs). */
const REPORT_VOCAB = 'reembolso reembolsos reembolsado reembolsada reembolsados reembolsadas';

/** «5carritos»: un número pegado a una palabra (MiniMax a veces se come el espacio). No cuenta «315r» ni nada que esté en los datos. */
export function gluedNumbers(text: string, allowed: string): string[] {
  const hay = allowed.toLowerCase();
  const out = new Set<string>();
  for (const m of text.matchAll(/\b\d+[a-záéíóúñ]{3,}\b/gi)) if (!hay.includes(m[0].toLowerCase())) out.add(m[0]);
  return [...out];
}

/** Palabras con mayúscula en medio de una frase (nombres propios o inglés suelto como «Visibility») que no están en los datos ni en el diccionario. */
function strayCapitalised(text: string, allowed: string): string[] {
  const words = new Set<string>();
  for (const m of text.matchAll(/(?<=[a-záéíóúñ,;:)]\s)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{3,})\b/g)) words.add(m[1].toLowerCase());
  if (!words.size) return [];
  return unknownWords([...words].join(' '), `${allowed} ${REPORT_VOCAB} Adrián Google TikTok Instagram Facebook Canarias`);
}

/**
 * Último recurso con chino que no se va tras los reintentos: se quita la frase entera (o el punto de la lista) en lugar de
 * borrar solo los caracteres, que dejaba frases mutiladas. Las listas numeradas se renumeran.
 */
export function dropCjkSentences(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!CJK_ANY_RE.test(line)) { out.push(line); continue; }
    if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) continue;
    const kept = line.split(/(?<=[.!?])\s+/).filter((sn) => !CJK_ANY_RE.test(sn)).join(' ');
    if (kept.trim()) out.push(kept);
  }
  let n = 0;
  return out
    .map((l) => {
      const m = /^(\s*)\d+([.)])\s+(.*)$/.exec(l);
      if (m) return `${m[1]}${++n}${m[2]} ${m[3]}`;
      if (l.trim()) n = 0;
      return l;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Quita encabezados que el modelo añade aunque se le pida solo el cuerpo (el título lo pone el servidor). */
function stripHeading(text: string): string {
  return text.replace(/^\s*(#{1,4}[^\n]*\n+)+/, '').trim();
}

interface SectionResult { body: string; attempts: number; notes: string[]; tokens: number }

async function writeSection(section: Section, data: string): Promise<SectionResult> {
  let extra = '';
  let tokens = 0;
  const notes: string[] = [];
  let best: { text: string; score: number } | null = null;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    const r: any = await minimaxClient.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT },
        {
          role: 'user',
          content: `DATOS DEL INFORME\n\n${data}\n\nSECCIÓN A REDACTAR: «${section.title}»\n${section.brief}\nExtensión: ${section.words} palabras. Español correcto, verbos bien conjugados y sin ningún carácter chino.`,
        },
      ] as any,
      max_tokens: 5000,
      // Con la misma temperatura baja el modelo repetía el mismo fallo: los reintentos varían un poco.
      temperature: attempts === 2 ? 0.45 : 0.2,
      top_p: attempts === 2 ? 0.9 : 0.8,
      reasoning_split: true,
      reasoning_effort: 'low',
    } as any, { timeout: 60_000 });
    tokens += Number(r.usage?.total_tokens) || 0;
    const text = stripHeading(stripThink(String(r.choices?.[0]?.message?.content || '')));
    const english = foreignWords(text, data);
    const garbled = garbledTokens(text, data);
    const seen = new Set([...english, ...garbled.map((g) => g.toLowerCase())]);
    const glued = gluedNumbers(text, data);
    const unknown = [...unknownWords(text, `${data} ${REPORT_VOCAB}`), ...strayCapitalised(text, data), ...glued].filter((w, i, a) => !seen.has(w) && a.indexOf(w) === i);
    const cjk = CJK_ANY_RE.test(text);
    const verbs = badParticiples(text);
    const score = (!text.trim() ? 20 : 0) + (cjk ? 5 : 0) + (r.choices?.[0]?.finish_reason === 'length' ? 3 : 0) + (english.length + garbled.length) * 2 + unknown.length + verbs.length * 2;
    if (!best || score < best.score) best = { text, score };
    if (score === 0) break;
    const bad = [...english, ...garbled, ...unknown];
    const why = !text.trim() ? 'vacía' : cjk ? 'con chino' : bad.length ? `con palabras raras: ${bad.join(', ')}` : verbs.length ? `con verbos mal conjugados: ${verbs.join(', ')}` : 'cortada';
    notes.push(`${section.title}: ${why}`);
    console.warn(`[overview-ai] sección «${section.title}» descartada (${why}), intento ${attempts}`);
    if (bad.length || cjk || verbs.length) {
      const problems = [
        bad.length ? `palabras que no existen o no son españolas (${bad.join(', ')})` : '',
        cjk ? 'caracteres chinos' : '',
        verbs.length ? `verbos sin conjugar (${verbs.join(', ')}; debe ser «ha bajado», «han subido»…)` : '',
      ].filter(Boolean).join(', ');
      extra = `IMPORTANTE: tu texto anterior llevaba ${problems}. Escribe TODO en español correcto, solo con alfabeto latino y con los verbos bien conjugados.`;
    }
  }
  // Último recurso con el mejor intento: se quita el chino, las palabras inglesas y las rotas.
  let text = best?.text || '';
  if (CJK_ANY_RE.test(text)) text = dropCjkSentences(text);
  text = text.replace(/。/g, '. ').replace(/，/g, ', ').replace(/：/g, ': ').replace(CJK_RE, '').replace(/[ \t]{2,}/g, ' ');
  const leftover = foreignWords(text, data);
  if (leftover.length) text = stripForeignWords(text, leftover);
  for (const g of garbledTokens(text, data)) text = text.split(g).join('');
  text = stripUnknownForeign(text, `${data} ${REPORT_VOCAB}`);
  // «5carritos» → «5 carritos»: mejor separarlo que dejarlo roto.
  text = text.replace(/\b(\d+)([a-záéíóúñ]{3,})\b/gi, (m, d, w) => (data.toLowerCase().includes(m.toLowerCase()) ? m : `${d} ${w}`)).trim();
  return { body: text, attempts, notes, tokens };
}

/** Ejecuta las tareas con como mucho `limit` a la vez, conservando el orden del resultado. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/** Redacta el informe completo, sección a sección, y lo devuelve en Markdown ya limpio. */
export async function generateOverviewAiReport(report: OverviewReport): Promise<AiReportResult> {
  const data = reportToPromptText(report);
  const results = await pool(SECTIONS, PARALLEL, (s) => writeSection(s, data));
  const parts = results.map((r, i) => (r.body ? `## ${SECTIONS[i].title}\n\n${r.body}` : ''));
  if (results.filter((r) => r.body).length < 3) throw new Error('La IA no devolvió ningún texto');
  return {
    text: parts.filter(Boolean).join('\n\n'),
    model: CHAT_MODEL,
    attempts: results.reduce((a, r) => a + r.attempts, 0),
    notes: results.flatMap((r) => r.notes),
    tokens: results.reduce((a, r) => a + r.tokens, 0),
  };
}
