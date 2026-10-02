/**
 * Motor de precios: precio de venta (IVA incluido) a partir del PVP de Bihr y
 * del coste real, según las reglas de pricing_rules (migración 011).
 *
 *   precio = máx( PVP × (1 − descuento),  suelo )
 *   suelo  = el precio que deja `margen mínimo` neto después de IVA y de la
 *            comisión de pago: (coste + fijo) / ((1 − margen) / 1,21 − %comisión)
 *
 * Nunca sube por encima del PVP salvo que el suelo lo exija (coste muy alto).
 * Los productos con price_manual no se tocan; sin PVP o sin coste, tampoco.
 */
import { pool } from '../db.js';

const VAT = 1.21;
const PAYMENT_FEE_PCT = 0.015; // Stripe, tarjetas UE
const PAYMENT_FEE_FIXED = 25;  // céntimos
export const DEFAULT_RULE = { discount: 0, minMargin: 15 };

export interface PricingRule { type: 'global' | 'category' | 'brand'; target: string | null; discount: number; minMargin: number }

export async function loadPricingRules(): Promise<PricingRule[]> {
  const r = await pool.query(`SELECT rule_type, target_id, discount_percent, min_margin_percent FROM pricing_rules WHERE active = 1`);
  return r.rows.map((x: any) => ({
    type: x.rule_type, target: x.target_id ? String(x.target_id) : null,
    discount: Number(x.discount_percent) || 0, minMargin: Number(x.min_margin_percent) || 0,
  }));
}

export function ruleFor(rules: PricingRule[], p: { brand?: string | null; category_id?: number | null }): { discount: number; minMargin: number } {
  const brand = String(p.brand || '').toLowerCase();
  return rules.find((r) => r.type === 'brand' && r.target?.toLowerCase() === brand)
    || rules.find((r) => r.type === 'category' && r.target === String(p.category_id))
    || rules.find((r) => r.type === 'global')
    || DEFAULT_RULE;
}

/** Precio mínimo (céntimos, IVA incl.) que deja `minMargin` % de margen neto. */
export function floorPrice(costCents: number, minMargin: number): number {
  return Math.ceil((costCents + PAYMENT_FEE_FIXED) / ((1 - minMargin / 100) / VAT - PAYMENT_FEE_PCT));
}

/** Redondeo comercial a ,x9: hacia abajo para el objetivo (no supera el PVP)
 *  y hacia arriba para el suelo (no baja del margen mínimo). */
const nineDown = (c: number) => Math.max(9, Math.floor((c + 1) / 10) * 10 - 1);
const nineUp = (c: number) => Math.ceil((c + 1) / 10) * 10 - 1;

export function priceFor(pvpCents: number, costCents: number, rule: { discount: number; minMargin: number }): number {
  const target = nineDown(Math.round(pvpCents * (1 - rule.discount / 100)));
  const floor = nineUp(floorPrice(costCents, rule.minMargin));
  return Math.max(target, floor);
}

export interface RepriceStats {
  candidates: number; changed: number; down: number; up: number;
  avgOld: number; avgNew: number; avgMarginNew: number; belowPvp: number;
  sample: { sku: string; name: string; old: number; new: number; pvp: number }[];
}

/**
 * Recalcula los precios de los productos publicados con PVP y coste.
 * @param dryRun true: solo devuelve el efecto (vista previa del admin).
 */
export async function repriceProducts(opts: { dryRun?: boolean } = {}): Promise<RepriceStats> {
  const rules = await loadPricingRules();
  const res = await pool.query(`
    SELECT id, sku, name, brand, category_id, pvp, cost, price
    FROM products
    WHERE status IN ('published', 'draft') AND NOT price_manual AND pvp > 0 AND cost > 0`);
  const ids: number[] = []; const prices: number[] = [];
  let sumOld = 0, sumNew = 0, sumMargin = 0, down = 0, up = 0, belowPvp = 0;
  const sample: RepriceStats['sample'] = [];
  for (const p of res.rows as any[]) {
    const next = priceFor(Number(p.pvp), Number(p.cost), ruleFor(rules, p));
    sumOld += Number(p.price) || 0; sumNew += next;
    sumMargin += (next / VAT - p.cost - (next * PAYMENT_FEE_PCT + PAYMENT_FEE_FIXED)) / (next / VAT);
    if (next < Number(p.pvp)) belowPvp++;
    if (next !== Number(p.price)) {
      ids.push(p.id); prices.push(next);
      if (next < p.price) down++; else up++;
      if (sample.length < 12 && Math.abs(next - p.price) > p.price * 0.1) {
        sample.push({ sku: p.sku, name: String(p.name).slice(0, 80), old: p.price / 100, new: next / 100, pvp: p.pvp / 100 });
      }
    }
  }
  if (!opts.dryRun) {
    for (let i = 0; i < ids.length; i += 2000) {
      await pool.query(`
        UPDATE products p SET price = v.price, updated_at = NOW()
        FROM unnest($1::int[], $2::int[]) AS v(id, price)
        WHERE p.id = v.id`, [ids.slice(i, i + 2000), prices.slice(i, i + 2000)]);
    }
  }
  const n = res.rows.length || 1;
  return {
    candidates: res.rows.length, changed: ids.length, down, up,
    avgOld: Math.round(sumOld / n) / 100, avgNew: Math.round(sumNew / n) / 100,
    avgMarginNew: Math.round((sumMargin / n) * 1000) / 10, belowPvp, sample,
  };
}

export async function pricingAuto(): Promise<boolean> {
  const r = await pool.query(`SELECT value FROM catalog_meta WHERE key = 'pricing_auto'`).catch(() => ({ rows: [] as any[] }));
  return r.rows[0]?.value === 'on';
}
