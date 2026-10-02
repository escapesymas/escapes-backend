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
 *
 * Campos: price = PVP (precio tachado), sale_price = DTO1 (precio habitual),
 * promo_price = precio de la promoción activa, price_dto1 = DTO1 calculado,
 * price_dto2 = mínimo sin pérdidas.
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

// Índice por marca/categoría (hay cientos de reglas de marca y ~100.000 productos).
const ruleIndex = new WeakMap<PricingRule[], { brand: Map<string, PricingRule>; category: Map<string, PricingRule>; global?: PricingRule }>();

export function ruleFor(rules: PricingRule[], p: { brand?: string | null; category_id?: number | null }): { discount: number; minMargin: number } {
  let idx = ruleIndex.get(rules);
  if (!idx) {
    idx = { brand: new Map(), category: new Map(), global: rules.find((r) => r.type === 'global') };
    for (const r of rules) {
      if (r.type === 'brand' && r.target) idx.brand.set(r.target.toLowerCase(), r);
      if (r.type === 'category' && r.target) idx.category.set(r.target, r);
    }
    ruleIndex.set(rules, idx);
  }
  return idx.brand.get(String(p.brand || '').toLowerCase())
    || idx.category.get(String(p.category_id))
    || idx.global
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
  // Sin descuento, el PVP exacto (redondear a ,x9 daría un "descuento" de céntimos).
  const target = rule.discount > 0 ? nineDown(Math.round(pvpCents * (1 - rule.discount / 100))) : pvpCents;
  const floor = nineUp(floorPrice(costCents, rule.minMargin));
  return Math.max(target, floor);
}

export interface RepriceStats {
  candidates: number; changed: number; down: number; up: number;
  avgOld: number; avgNew: number; avgMarginNew: number; belowPvp: number; abovePvp: number;
  sample: { sku: string; name: string; old: number; new: number; pvp: number }[];
}

/**
 * Recalcula los precios de los productos publicados con PVP y coste.
 * @param dryRun true: solo devuelve el efecto (vista previa del admin).
 */
export async function repriceProducts(opts: { dryRun?: boolean } = {}): Promise<RepriceStats> {
  const rules = await loadPricingRules();
  const res = await pool.query(`
    SELECT id, sku, name, brand, category_id, pvp, cost, price, sale_price, price_dto1, promo_price
    FROM products
    WHERE status IN ('published', 'draft') AND NOT price_manual AND pvp > 0 AND cost > 0`);
  const ids: number[] = []; const pvps: number[] = []; const dto1s: number[] = []; const sales: (number | null)[] = [];
  let sumOld = 0, sumNew = 0, sumMargin = 0, down = 0, up = 0, belowPvp = 0, abovePvp = 0;
  const sample: RepriceStats['sample'] = [];
  for (const p of res.rows as any[]) {
    const pvp = Number(p.pvp);
    const dto1 = priceFor(pvp, Number(p.cost), ruleFor(rules, p));
    // Lo que paga hoy y lo que pagará: el precio de oferta si es menor que el PVP.
    const eff = (promo: number, sale: number, price: number) => promo > 0 ? promo : sale > 0 && sale < price ? sale : price;
    const oldEff = eff(Number(p.promo_price), Number(p.sale_price), Number(p.price));
    // DTO1 por debajo del PVP: price = PVP (tachado) y sale_price = DTO1. Si ni el
    // PVP cubre el margen mínimo (marcas sin margen de distribuidor), se vende al
    // precio mínimo con margen, sin descuento: venderlo a PVP sería perder dinero.
    // Un ahorro de menos del 1 % no se anuncia: se vende a PVP sin tachado.
    const sale = dto1 < pvp * 0.99 ? dto1 : null;
    const listPrice = sale ? pvp : Math.max(pvp, dto1);
    // La promoción activa (promo_price) se mantiene; applyPromotions la revisa después.
    const newEff = eff(Number(p.promo_price), sale || 0, listPrice);
    sumOld += oldEff; sumNew += newEff;
    sumMargin += (newEff / VAT - p.cost - (newEff * PAYMENT_FEE_PCT + PAYMENT_FEE_FIXED)) / (newEff / VAT);
    if (newEff < pvp) belowPvp++;
    if (listPrice > pvp) abovePvp++;
    const changed = Number(p.price) !== listPrice || Number(p.price_dto1) !== dto1 || (Number(p.sale_price) || null) !== (sale || null);
    if (changed) {
      ids.push(p.id); pvps.push(listPrice); dto1s.push(dto1); sales.push(sale);
      if (newEff < oldEff) down++; else if (newEff > oldEff) up++;
      if (sample.length < 12 && Math.abs(newEff - oldEff) > oldEff * 0.1) {
        sample.push({ sku: p.sku, name: String(p.name).slice(0, 80), old: oldEff / 100, new: newEff / 100, pvp: pvp / 100 });
      }
    }
  }
  if (!opts.dryRun) {
    for (let i = 0; i < ids.length; i += 2000) {
      await pool.query(`
        UPDATE products p SET price = v.pvp, price_dto1 = v.dto1, sale_price = v.sale, updated_at = NOW()
        FROM unnest($1::int[], $2::int[], $3::int[], $4::int[]) AS v(id, pvp, dto1, sale)
        WHERE p.id = v.id`, [ids.slice(i, i + 2000), pvps.slice(i, i + 2000), dto1s.slice(i, i + 2000), sales.slice(i, i + 2000)]);
    }
    await refreshDto2();
    await applyPromotions();
  }
  const n = res.rows.length || 1;
  return {
    candidates: res.rows.length, changed: ids.length, down, up,
    avgOld: Math.round(sumOld / n) / 100, avgNew: Math.round(sumNew / n) / 100,
    avgMarginNew: Math.round((sumMargin / n) * 1000) / 10, belowPvp, abovePvp, sample,
  };
}

export async function pricingAuto(): Promise<boolean> {
  const r = await pool.query(`SELECT value FROM catalog_meta WHERE key = 'pricing_auto'`).catch(() => ({ rows: [] as any[] }));
  return r.rows[0]?.value === 'on';
}

// ---------------------------------------------------------------------------
// DTO2 (precio mínimo sin pérdidas) y promociones
// ---------------------------------------------------------------------------

/** Margen neto de DTO2 (catalog_meta.promo_margin, por defecto 0 = sin pérdidas). */
export async function promoMargin(): Promise<number> {
  const r = await pool.query(`SELECT value FROM catalog_meta WHERE key = 'promo_margin'`).catch(() => ({ rows: [] as any[] }));
  const n = Number(r.rows[0]?.value);
  return Number.isFinite(n) && n >= 0 && n < 50 ? n : 0;
}

/** DTO2 de un producto: coste + IVA + comisión de pago (+ margen de promoción). */
export function dto2For(costCents: number, margin: number): number {
  return nineUp(floorPrice(costCents, margin));
}

/**
 * Recalcula products.price_dto2 de todo lo que tiene coste. No cambia lo que
 * paga el cliente (eso solo lo hacen las promociones).
 */
export async function refreshDto2(): Promise<number> {
  const margin = await promoMargin();
  const res = await pool.query(`SELECT id, cost, COALESCE(price_dto1, price) AS price, price_dto2 FROM products WHERE status IN ('published', 'draft') AND cost > 0`);
  const ids: number[] = []; const vals: number[] = [];
  for (const p of res.rows as any[]) {
    // Nunca por encima del precio habitual (DTO1, o el precio si no hay DTO1).
    const v = Math.min(dto2For(Number(p.cost), margin), Number(p.price) || Infinity);
    if (v !== Number(p.price_dto2)) { ids.push(p.id); vals.push(v); }
  }
  for (let i = 0; i < ids.length; i += 5000) {
    await pool.query(`UPDATE products p SET price_dto2 = v.d FROM unnest($1::int[], $2::int[]) AS v(id, d) WHERE p.id = v.id`,
      [ids.slice(i, i + 5000), vals.slice(i, i + 5000)]);
  }
  return ids.length;
}

/**
 * Aplica las promociones activas: promo_price = DTO2 (o DTO1 − %, sin bajar
 * de DTO2) en los productos de su ámbito; si un producto está en varias, gana
 * el precio más bajo. Los que ya no están en ninguna pierden promo_price (y
 * vuelven a su DTO1, que está intacto en sale_price). Precios manuales: no.
 */
export async function applyPromotions(): Promise<{ applied: number; removed: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE promo_target ON COMMIT DROP AS
      SELECT DISTINCT ON (p.id) p.id, a.id AS promo,
             CASE WHEN a.level = 'dto2' THEN p.price_dto2
                  ELSE GREATEST(p.price_dto2, ROUND(COALESCE(NULLIF(p.sale_price, 0), p.price) * (1 - a.percent / 100.0))::int) END AS sp
      FROM products p
      JOIN promotions a ON a.active
        AND NOW() >= COALESCE(a.starts_at, '-infinity') AND NOW() < COALESCE(a.ends_at, 'infinity')
        AND (a.scope = 'all'
          OR (a.scope = 'category' AND a.target ~ '^[0-9]+$' AND a.target::int IN (p.category_id, p.category2_id, p.category3_id))
          OR (a.scope = 'brand' AND lower(p.brand) = lower(trim(a.target)))
          OR (a.scope = 'skus' AND p.sku = ANY (SELECT trim(x) FROM unnest(string_to_array(a.target, ',')) AS x)))
      WHERE p.status = 'published' AND NOT p.price_manual
        AND p.price_dto2 > 0 AND p.price_dto2 < COALESCE(NULLIF(p.sale_price, 0), p.price)
      ORDER BY p.id, sp ASC`);
    const applied = await client.query(`
      UPDATE products p SET promo_price = t.sp, promo_id = t.promo, updated_at = NOW()
      FROM promo_target t
      WHERE p.id = t.id AND (p.promo_price IS DISTINCT FROM t.sp OR p.promo_id IS DISTINCT FROM t.promo)`);
    const removed = await client.query(`
      UPDATE products p SET promo_price = NULL, promo_id = NULL, updated_at = NOW()
      WHERE p.promo_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM promo_target t WHERE t.id = p.id)`);
    await client.query('COMMIT');
    return { applied: applied.rowCount || 0, removed: removed.rowCount || 0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// DTO1 por marca: descuento sugerido para un margen medio objetivo
// ---------------------------------------------------------------------------

export interface BrandSuggestion { brand: string; products: number; discount: number; avgMargin: number; avgVsPvp: number }

/**
 * Para cada marca, el mayor descuento sobre el PVP (en pasos de 0,5 %) con el
 * que el margen neto medio de sus productos sigue en `targetMargin` o más; el
 * suelo `minMargin` se aplica además producto a producto. Marcas que ni a PVP
 * llegan al objetivo quedan a PVP (descuento 0).
 */
export async function suggestBrandRules(opts: { targetMargin?: number; minMargin?: number; maxDiscount?: number } = {}): Promise<BrandSuggestion[]> {
  const target = (opts.targetMargin ?? 30) / 100;
  const minMargin = opts.minMargin ?? 15;
  const maxDiscount = opts.maxDiscount ?? 40;
  const res = await pool.query(`
    SELECT brand, pvp, cost FROM products
    WHERE status = 'published' AND NOT price_manual AND pvp > 0 AND cost > 0 AND COALESCE(brand, '') <> ''`);
  const byBrand = new Map<string, { pvp: number; cost: number }[]>();
  for (const r of res.rows as any[]) {
    const k = String(r.brand).trim();
    (byBrand.get(k) || byBrand.set(k, []).get(k)!).push({ pvp: Number(r.pvp), cost: Number(r.cost) });
  }
  const margin = (p: number, c: number) => (p / VAT - c - (p * PAYMENT_FEE_PCT + PAYMENT_FEE_FIXED)) / (p / VAT);
  const stats = (list: { pvp: number; cost: number }[], d: number) => {
    let m = 0, ratio = 0;
    for (const x of list) {
      const p = priceFor(x.pvp, x.cost, { discount: d, minMargin });
      m += margin(p, x.cost); ratio += p / x.pvp;
    }
    return { m: m / list.length, ratio: ratio / list.length };
  };
  const out: BrandSuggestion[] = [];
  for (const [brand, list] of byBrand) {
    let best = 0;
    for (let d = 0.5; d <= maxDiscount; d += 0.5) {
      if (stats(list, d).m >= target) best = d; else break;
    }
    const s = stats(list, best);
    out.push({ brand, products: list.length, discount: best, avgMargin: Math.round(s.m * 1000) / 10, avgVsPvp: Math.round((s.ratio - 1) * 1000) / 10 });
  }
  return out.sort((a, b) => b.products - a.products);
}

/** Sustituye las reglas de marca por las sugeridas (las de categoría y la global se mantienen). */
export async function saveBrandRules(list: BrandSuggestion[], minMargin = 15): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM pricing_rules WHERE rule_type = 'brand'`);
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      await client.query(`
        INSERT INTO pricing_rules (rule_type, target_id, margin_percent, discount_percent, min_margin_percent, active)
        SELECT 'brand', b, 0, d, $3, 1 FROM unnest($1::text[], $2::numeric[]) AS v(b, d)`,
        [chunk.map((x) => x.brand), chunk.map((x) => x.discount), minMargin]);
    }
    await client.query('COMMIT');
    return list.length;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
