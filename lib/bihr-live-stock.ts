/**
 * Stock de Bihr en vivo para lo que se va a enseñar o vender (listados, carrito, pedido y ficha).
 *
 * La base de datos guarda una copia del stock de Bihr que se renueva dos veces al día (lib/bihr-discontinued.ts), pero
 * Bihr lo mueve continuamente: se podía mostrar y vender lo que ya no tienen (Regulador TECNIUM 1078960: 39 uds. en la
 * tienda y «en reaprovisionamiento» en Bihr). Aquí se pregunta a la API v3 (Products/Stocks, hasta 500 referencias por
 * llamada) justo por los productos que se van a mostrar, con estas protecciones:
 *  - caché por referencia en Redis (por defecto 10 min): una referencia se pregunta como mucho una vez por ese tiempo;
 *  - una llamada por segundo como máximo (límite de Bihr) y un presupuesto diario (Bihr da 30.000 por semana);
 *  - plazo corto: si Bihr tarda, la página sale con el valor de la base de datos y no se retrasa;
 *  - si Bihr falla (429, 5xx, plazo), se deja de preguntar durante un minuto;
 *  - nunca se escribe un 0 por un error: solo se guarda lo que Bihr contesta.
 *
 * Sin stock, Bihr da la fecha prevista de reaprovisionamiento (forecastAvailability): se guarda en `products.restock_date`
 * y un producto con stock 0 y fecha se muestra «en reaprovisionamiento».
 *
 * Solo para productos de Bihr: se identifican por `part_number` (la referencia de Bihr; `supplier_code` suele ser la del
 * fabricante y no sirve). Los de Andreani (AND-*) tienen su propio refresco y no se tocan.
 */
import { pool } from '../db.js';
import { getBihrToken } from '../bihrService.js';
import { getRedisClient } from '../redis.js';

const BIHR_API_BASE = process.env.BIHR_API_BASE || 'https://api.bihr.net';
const MAX_PER_CALL = 500;
const DEFAULT_TTL_S = 600;
/** Referencias que Bihr no devuelve: no se vuelven a preguntar durante una hora. */
const UNKNOWN_TTL_S = 3600;
const DAILY_BUDGET = Number(process.env.BIHR_LIVE_STOCK_DAILY_CALLS) || 3000;
/** Lo máximo que se hace esperar a quien pide la página. */
const DEADLINE_MS = 3500;
const BREAKER_S = 60;

const KEY = 'bihr:stk:';
const GATE_KEY = 'bihr:stk:gate';
const BREAKER_KEY = 'bihr:stk:breaker';
const BUDGET_KEY = 'bihr:stk:calls:';

export interface LiveStockOptions {
  /** Cuánto vale un dato en caché (segundos). Para el pedido, menos que para los listados. */
  ttlSec?: number;
  /**
   * Cuánto esperar el turno si otra petición acaba de llamar a Bihr (límite de 1 llamada por segundo). Por defecto 0: se
   * usa lo guardado y la página no se retrasa. Quien no bloquea ninguna página (las tarjetas a la vista) puede esperar.
   */
  waitGateMs?: number;
}

export interface LiveStock {
  stock: number;
  /** Fecha prevista (AAAA-MM-DD) si Bihr no tiene stock y está reaprovisionando; null en otro caso. */
  restockDate: string | null;
}

type Row = { id: number; part_number: string; stock: number | string | null; restock_date: string | null };

const norm = (p: string) => String(p).trim().toLowerCase();

/** «2026-12-21T00:00:00.0000000» → «2026-12-21»; cualquier otra cosa → null. */
export function parseForecast(f: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(f ?? ''));
  return m ? m[1] : null;
}

/**
 * Stock actual en Bihr de los productos pedidos (id de producto → unidades y fecha de reaprovisionamiento). Solo trae los
 * que se han podido saber: quien llama usa el valor de la base de datos para el resto. Si hay cambios, también los guarda
 * en `products`. No lanza nunca: ante cualquier problema devuelve lo que tenga.
 */
export async function refreshLiveBihrStock(ids: number[], opts: LiveStockOptions = {}): Promise<Map<number, LiveStock>> {
  const out = new Map<number, LiveStock>();
  const wanted = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_PER_CALL);
  if (!wanted.length || process.env.BIHR_LIVE_STOCK_DISABLED === 'true') return out;

  const work = (async () => {
    try {
      // Sin Redis no hay forma de limitar las llamadas a Bihr: no se arriesga su cuota.
      const redis = await getRedisClient();
      if (!redis) return;

      const { rows } = await pool.query<Row>(
        `SELECT id, part_number, stock, restock_date::text AS restock_date FROM products
          WHERE id = ANY($1) AND status = 'published'
            AND COALESCE(part_number, '') <> ''
            AND COALESCE(supplier_name, '') <> 'Andreani MHS' AND sku NOT LIKE 'AND-%'`,
        [wanted]);
      if (!rows.length) return;

      const cached = await redis.mGet(rows.map((r) => KEY + norm(r.part_number)));
      const stale: Row[] = [];
      rows.forEach((r, i) => {
        const v = cached[i];
        if (v === null || v === undefined) stale.push(r);
        else if (String(v) !== 'x') {
          const [stock, date] = String(v).split('|');
          out.set(r.id, { stock: Number(stock) || 0, restockDate: date || null });
        }
      });
      if (!stale.length) return;

      if (await redis.get(BREAKER_KEY)) return;
      // Una llamada por segundo: si otra petición acaba de preguntar, esta espera su turno (hasta waitGateMs) o usa lo que haya.
      const turnFrom = Date.now();
      while (!(await redis.set(GATE_KEY, '1', { NX: true, PX: 1100 }))) {
        if (Date.now() - turnFrom >= (opts.waitGateMs ?? 0)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const budgetKey = BUDGET_KEY + new Date().toISOString().slice(0, 10);
      const used = Number(await redis.incr(budgetKey));
      if (used === 1) await redis.expire(budgetKey, 3 * 86400);
      if (used > DAILY_BUDGET) return;

      let results: Array<{ partNumber: string; value: number; forecastAvailability?: string | null }>;
      try {
        const res = await fetch(`${BIHR_API_BASE}/api/v3/Products/Stocks`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await getBihrToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ productCriteria: [...new Set(stale.map((r) => String(r.part_number).trim()))].map((partNumber) => ({ partNumber })) }),
          signal: AbortSignal.timeout(DEADLINE_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        results = await res.json();
        if (!Array.isArray(results)) throw new Error('respuesta inesperada');
      } catch (e: any) {
        console.warn(`[BIHR LIVE STOCK] Bihr no ha contestado (${e?.message || e}); se usa el stock guardado durante ${BREAKER_S} s`);
        await redis.set(BREAKER_KEY, '1', { EX: BREAKER_S });
        return;
      }

      const byPart = new Map(results.map((r) => {
        const stock = Math.max(0, Math.floor(Number(r.value) || 0));
        return [norm(r.partNumber), { stock, restockDate: stock === 0 ? parseForecast(r.forecastAvailability) : null }] as const;
      }));
      const ttl = opts.ttlSec ?? DEFAULT_TTL_S;
      const changedIds: number[] = [];
      const changedStock: number[] = [];
      const changedDate: string[] = [];
      const multi = redis.multi();
      for (const r of stale) {
        const k = KEY + norm(r.part_number);
        const live = byPart.get(norm(r.part_number));
        if (!live) { multi.set(k, 'x', { EX: UNKNOWN_TTL_S }); continue; }
        multi.set(k, `${live.stock}|${live.restockDate ?? ''}`, { EX: ttl });
        out.set(r.id, live);
        if ((Number(r.stock) || 0) !== live.stock || (r.restock_date ?? null) !== live.restockDate) {
          changedIds.push(r.id);
          changedStock.push(live.stock);
          changedDate.push(live.restockDate ?? '');
        }
      }
      await multi.exec();
      if (changedIds.length) {
        await pool.query(
          `UPDATE products p SET stock = v.stock, restock_date = NULLIF(v.restock_date, '')::date
             FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS stock, unnest($3::text[]) AS restock_date) v
            WHERE p.id = v.id`,
          [changedIds, changedStock, changedDate]);
      }
    } catch (e: any) {
      console.warn('[BIHR LIVE STOCK] error:', e?.message || e);
    }
  })();

  // Quien pide la página no espera más del plazo: lo que falte se completa en segundo plano para la próxima vez.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, DEADLINE_MS); })]);
  clearTimeout(timer);
  return out;
}
