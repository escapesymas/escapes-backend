/**
 * Stock de Andreani (productos AND-*) en vivo para lo que se va a enseñar o vender.
 *
 * Andreani no da un catálogo de stock ni una consulta por lotes: el único camino es el buscador de su web (ApproSearch,
 * `api/v1/search?q=<referencia>`), que contesta una referencia por llamada. Por eso aquí se pregunta solo por lo que se
 * va a ver y con muchas protecciones, porque la cuota de esa API (300 llamadas por minuto) **la comparte la propia web
 * de Andreani**: si la gastamos, se la dejamos sin buscador a ellos.
 *  - caché por referencia en Redis (por defecto 10 min: lo normal es que varias personas miren las mismas fichas);
 *  - tope propio de llamadas por minuto (90 por defecto) y por día, y hasta 6 llamadas a la vez;
 *  - si ApproSearch contesta con error o la cuota restante baja de 60, se deja de preguntar hasta que se recupere;
 *  - plazo corto: quien pide la página no espera más de 3 s; lo que falte se completa en segundo plano;
 *  - nunca se escribe un stock por un error: solo se guarda lo que ApproSearch contesta, y solo si cambia.
 *
 * La clave es la pública del buscador de andreanimhs.com (`APPROSEARCH_API_KEY` en Coolify, nunca en el código). Sin
 * ella no se consulta nada y se sirve el stock guardado. Los de Bihr tienen su propio módulo (lib/bihr-live-stock.ts).
 */
import { pool } from '../db.js';
import { getRedisClient } from '../redis.js';
import type { LiveStock } from './bihr-live-stock.js';

const API_URL = 'https://api.approsearch.com/api/v1/search';
const MAX_PER_CALL = 24;
const CONCURRENCY = 6;
const DEFAULT_TTL_S = 600;
/** Referencias que ApproSearch no devuelve: no se vuelven a preguntar durante media hora. */
const UNKNOWN_TTL_S = 1800;
const PER_MINUTE_BUDGET = Number(process.env.ANDREANI_LIVE_STOCK_PER_MIN) || 90;
const DAILY_BUDGET = Number(process.env.ANDREANI_LIVE_STOCK_DAILY_CALLS) || 6000;
/** Lo máximo que se hace esperar a quien pide la página. */
const DEADLINE_MS = 3000;
const CALL_TIMEOUT_MS = 2500;
const BREAKER_S = 60;
/** Cuota restante de ApproSearch por debajo de la cual se deja de preguntar hasta que se reinicie. */
const MIN_REMAINING = 60;

const KEY = 'and:stk:';
const LOCK_KEY = 'and:stk:lock:';
const BREAKER_KEY = 'and:stk:breaker';
const MINUTE_KEY = 'and:stk:min:';
const DAY_KEY = 'and:stk:calls:';

export interface LiveAndreaniOptions {
  /** Cuánto vale un dato en caché (segundos). */
  ttlSec?: number;
}

type Row = { id: number; sku: string; supplier_code: string | null; stock: number | string | null };

/** Referencia que se pregunta a ApproSearch: la del fabricante, o la del SKU sin el prefijo AND-. */
export const andreaniRef = (r: { sku: string; supplier_code: string | null }): string =>
  String(r.supplier_code || String(r.sku).replace(/^AND-/, '')).trim().toUpperCase();

/** Stock de ApproSearch de una referencia (el producto cuya `reference` coincide exactamente), o null si no aparece. */
export function stockFromSearch(body: any, ref: string): number | null {
  const products = body?.data?.products;
  if (!Array.isArray(products)) return null;
  const match = products.find((p: any) => String(p?.reference || '').trim().toUpperCase() === ref);
  if (!match || match.stock === undefined || match.stock === null) return null;
  return Math.max(0, Math.floor(Number(match.stock) || 0));
}

/**
 * Stock actual en Andreani de los productos pedidos (id de producto → unidades). Solo trae los que se han podido saber:
 * quien llama usa el valor de la base de datos para el resto. Si hay cambios, también los guarda. No lanza nunca.
 */
export async function refreshLiveAndreaniStock(ids: number[], opts: LiveAndreaniOptions = {}): Promise<Map<number, LiveStock>> {
  const out = new Map<number, LiveStock>();
  const wanted = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  const apiKey = process.env.APPROSEARCH_API_KEY;
  if (!wanted.length || !apiKey || process.env.ANDREANI_LIVE_STOCK_DISABLED === 'true') return out;

  const work = (async () => {
    try {
      // Sin Redis no hay forma de limitar las llamadas a una API que no es solo nuestra: no se arriesga su cuota.
      const redis = await getRedisClient();
      if (!redis) return;

      const { rows: all } = await pool.query<Row>(
        `SELECT id, sku, supplier_code, stock FROM products
          WHERE id = ANY($1) AND status = 'published' AND (sku LIKE 'AND-%' OR supplier_name = 'Andreani MHS')`,
        [wanted]);
      const rows = all.filter((r) => andreaniRef(r)).slice(0, MAX_PER_CALL);
      if (!rows.length) return;

      const cached = await redis.mGet(rows.map((r) => KEY + andreaniRef(r)));
      const stale: Row[] = [];
      rows.forEach((r, i) => {
        const v = cached[i];
        if (v === null || v === undefined) stale.push(r);
        else if (String(v) !== 'x') out.set(r.id, { stock: Number(v) || 0, restockDate: null });
      });
      if (!stale.length) return;

      const ttl = opts.ttlSec ?? DEFAULT_TTL_S;
      const changedIds: number[] = [];
      const changedStock: number[] = [];
      let stop = false;
      let next = 0;

      /** Reserva una llamada de los presupuestos por minuto y por día; false si no queda o hay freno puesto. */
      const reserveCall = async (): Promise<boolean> => {
        if (stop || (await redis.get(BREAKER_KEY))) return false;
        const minuteKey = MINUTE_KEY + Math.floor(Date.now() / 60_000);
        const perMinute = Number(await redis.incr(minuteKey));
        if (perMinute === 1) await redis.expire(minuteKey, 120);
        if (perMinute > PER_MINUTE_BUDGET) return false;
        const dayKey = DAY_KEY + new Date().toISOString().slice(0, 10);
        const perDay = Number(await redis.incr(dayKey));
        if (perDay === 1) await redis.expire(dayKey, 3 * 86400);
        return perDay <= DAILY_BUDGET;
      };

      const trip = async (why: string, seconds = BREAKER_S) => {
        stop = true;
        console.warn(`[ANDREANI LIVE STOCK] ${why}; se usa el stock guardado durante ${seconds} s`);
        await redis.set(BREAKER_KEY, '1', { EX: Math.max(5, seconds) });
      };

      const one = async (r: Row) => {
        const ref = andreaniRef(r);
        // Si otra petición ya está preguntando por esta referencia, esta usa lo que haya.
        if (!(await redis.set(LOCK_KEY + ref, '1', { NX: true, EX: 10 }))) return;
        if (!(await reserveCall())) return;
        try {
          const res = await fetch(`${API_URL}?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(ref)}&limit=5`, {
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          });
          const remaining = Number(res.headers.get('x-ratelimit-remaining'));
          if (!res.ok) return await trip(`ApproSearch contesta HTTP ${res.status}`);
          if (Number.isFinite(remaining) && remaining < MIN_REMAINING) {
            await trip(`cuota de ApproSearch casi agotada (${remaining} restantes)`, Math.min(60, Math.max(5, Number(res.headers.get('x-ratelimit-reset')) || BREAKER_S)));
          }
          const stock = stockFromSearch(await res.json(), ref);
          if (stock === null) { await redis.set(KEY + ref, 'x', { EX: UNKNOWN_TTL_S }); return; }
          await redis.set(KEY + ref, String(stock), { EX: ttl });
          out.set(r.id, { stock, restockDate: null });
          if ((Number(r.stock) || 0) !== stock) { changedIds.push(r.id); changedStock.push(stock); }
        } catch (e: any) {
          await trip(`ApproSearch no ha contestado (${e?.message || e})`);
        } finally {
          await redis.del(LOCK_KEY + ref).catch(() => {});
        }
      };

      // Hasta CONCURRENCY llamadas a la vez, cada trabajador coge la siguiente referencia pendiente.
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stale.length) }, async () => {
        while (!stop && next < stale.length) await one(stale[next++]);
      }));

      if (changedIds.length) {
        await pool.query(
          `UPDATE products p SET stock = v.stock, updated_at = NOW()
             FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS stock) v
            WHERE p.id = v.id`,
          [changedIds, changedStock]);
      }
    } catch (e: any) {
      console.warn('[ANDREANI LIVE STOCK] error:', e?.message || e);
    }
  })();

  // Quien pide la página no espera más del plazo: lo que falte se completa en segundo plano para la próxima vez.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, DEADLINE_MS); })]);
  clearTimeout(timer);
  return out;
}
