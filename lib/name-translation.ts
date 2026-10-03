/**
 * Traduce al español los nombres de producto que Bihr manda en inglés o a medias
 * y los guarda en name_translations (lib/catalog-enrich.ts los aplica en cada
 * sincronización). Usa el mismo modelo que el chatbot (MiniMax).
 *
 * Solo se traducen palabras genéricas y colores; marcas, líneas de producto,
 * modelos, referencias y medidas se dejan tal cual.
 *
 * Uso (dentro del contenedor del backend):
 *   node -e "import('./dist/lib/name-translation.js').then(m => m.translateNames({ limit: 200, dryRun: true }))"
 */
import { pool } from '../db.js';
import { minimaxClient, CHAT_MODEL } from '../chatbot/minimax.js';

const BATCH = 40;

// Palabras inglesas habituales en los nombres de Bihr (sin equivalente español idéntico).
const EN = String.raw`\m(Front|Rear|Black|White|Silver|Grey|Gray|Red|Blue|Green|Yellow|Orange|Handlebar|Bearing|Bearings|Protector|Protectors|Cover|Guard|Lever|Levers|Bolt|Bolts|Screw|Plate|Bracket|Mount|Rim|Wheel|Seat|Tank|Pad|Pads|Disc|Chain|Sprocket|Filter|Seal|Seals|Gasket|Clutch|Brake|Mirror|Light|Switch|Holder|Bag|Strap|Footrest|Footpeg|Grip|Grips|Hose|Pipe|Clamp|Washer|Nut|Spring|Shock|Fork|Valve|Piston|Cylinder|Steering|Kit with|Pair|Left|Right|Set of|Helmet|Jacket|Gloves|Boots|Pants|Removal|Replacement)\M`;
const ES = String.raw`\m(de|para|con|del|trasero|trasera|delantero|delantera|negro|negra|blanco|blanca|juego|izquierdo|derecho)\M`;

const SYSTEM = `Eres traductor de catálogo de recambios y equipamiento de moto para una tienda española.
Traduce al español cada nombre de producto que te paso, con estas reglas:
- Traduce solo las palabras genéricas en inglés (tipo de pieza, posición, colores): Front→delantero, Rear→trasero, Black→negro, Handlebar→manillar, Bearing→rodamiento, Rim→llanta, Protector→protector, Kit→kit…
- NO traduzcas marcas, líneas de producto ni modelos (p. ej. «Road Low», «Formula S Carbon Byte», «Pro-Bolt»), referencias, códigos ni medidas.
- Escribe un nombre natural en español: tipo de pieza primero, luego marca y modelo. Respeta las mayúsculas de las marcas.
- Si el nombre ya está en español, devuélvelo igual.
Responde SOLO con un array JSON de cadenas, una por nombre, en el mismo orden.`;

async function translateBatch(names: string[]): Promise<string[] | null> {
  const res = await minimaxClient.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.1,
    max_tokens: 4000,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(names) },
    ],
  });
  const text = (res.choices[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  try {
    const out = JSON.parse(json);
    if (Array.isArray(out) && out.length === names.length && out.every((x) => typeof x === 'string' && x.trim())) return out.map((x) => x.trim());
  } catch { /* respuesta no válida */ }
  return null;
}

export async function translateNames(opts: { limit?: number; dryRun?: boolean } = {}) {
  const LIMIT = opts.limit || 100000;
  const DRY = !!opts.dryRun;
  const { rows } = await pool.query(
    `SELECT DISTINCT p.name FROM products p
      WHERE p.status = 'published' AND p.name ~ $1 AND p.name !~* $2
        AND NOT EXISTS (SELECT 1 FROM name_translations t WHERE t.source_name = p.name)
      ORDER BY p.name LIMIT $3`, [EN, ES, LIMIT]);
  const names: string[] = rows.map((r: any) => r.name);
  console.log(`[TRANSLATE] ${names.length} nombres por traducir${DRY ? ' (prueba, no se guarda)' : ''}`);
  let saved = 0, failed = 0;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    let out: string[] | null = null;
    for (let attempt = 1; attempt <= 3 && !out; attempt++) {
      out = await translateBatch(batch).catch((e) => { console.error('[TRANSLATE] Error:', e.message); return null; });
    }
    if (!out) { failed += batch.length; continue; }
    for (let k = 0; k < batch.length; k++) {
      // Cambios absurdos (nombre vacío o 3 veces más largo) se descartan.
      if (out[k].length < 3 || out[k].length > batch[k].length * 3) { failed++; continue; }
      if (DRY) { if (k < 5) console.log(`  ${batch[k]}  →  ${out[k]}`); continue; }
      await pool.query(
        `INSERT INTO name_translations (source_name, name_es) VALUES ($1, $2)
         ON CONFLICT (source_name) DO UPDATE SET name_es = EXCLUDED.name_es`, [batch[k], out[k]]);
      saved++;
    }
    console.log(`[TRANSLATE] ${Math.min(i + BATCH, names.length)}/${names.length} · guardadas ${saved} · descartadas ${failed}`);
  }
  console.log(`[TRANSLATE] Fin: ${saved} traducciones guardadas, ${failed} descartadas`);
  return { total: names.length, saved, failed };
}
