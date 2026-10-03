/**
 * Cálculo único del pedido (subtotal, descuentos, envío, impuesto y total).
 * Lo usan /api/orders/create (que cobra) y /api/cart/quote (lo que ve el
 * cliente en el carrito), para que nunca enseñen importes distintos.
 */
import { pool } from '../db.js';
import { resolveTax, toDestinationCents, taxInTotal } from './tax.js';

/** Descuento por importe del pedido (sobre el subtotal con IVA español). */
export const ORDER_TIERS = [
  { min: 500, discountPercent: 15, freeShipping: true },
  { min: 300, discountPercent: 10, freeShipping: true },
  { min: 150, discountPercent: 5, freeShipping: true },
];
const DEFAULT_SHIPPING_CENTS = 1500;

export interface CartLine { id: number; quantity: number }
export interface QuoteInput { cart: CartLine[]; country?: string; postcode?: string; promoCode?: string | null }

export interface Quote {
  items: { productId: number; quantity: number; price: number }[];
  stockErrors: { id: number; requested: number; available: number }[];
  missing: number[];
  subtotalCents: number;
  discountPercent: number;
  discountCents: number;
  shippingCents: number;
  taxRate: number;
  taxLabel: string;
  taxNote: string | null;
  taxCents: number;
  totalCents: number;
  promo: { code: string; valid: boolean; type?: string; minAmount?: number; error?: string } | null;
  nextTier: { min: number; discountPercent: number; freeShipping: boolean; missingCents: number } | null;
}

async function shippingFor(country: string, postcode: string, subtotalEur: number): Promise<number> {
  const prefix2 = postcode.substring(0, 2);
  const [zones, methods] = await Promise.all([
    pool.query('SELECT id, regions FROM shipping_zones'),
    pool.query('SELECT zone_id, cost, free_shipping_threshold FROM shipping_methods WHERE active = 1 ORDER BY id'),
  ]);
  const regionsOf = (z: any): string[] => (Array.isArray(z.regions) ? z.regions : (() => { try { return JSON.parse(z.regions); } catch { return []; } })());
  const zone = zones.rows.find((z: any) => regionsOf(z).includes(`${country}-${prefix2}`))
    || zones.rows.find((z: any) => regionsOf(z).includes(country));
  const method: any = zone && methods.rows.find((m: any) => m.zone_id === zone.id);
  if (!method) return DEFAULT_SHIPPING_CENTS;
  if (method.free_shipping_threshold && subtotalEur >= Number(method.free_shipping_threshold)) return 0;
  return Number(method.cost) || 0;
}

/**
 * @param redeemCoupon true solo al crear el pedido: consume un uso del cupón.
 */
export async function quoteOrder(input: QuoteInput, opts: { redeemCoupon?: boolean } = {}): Promise<Quote> {
  const country = String(input.country || 'ES').trim().toUpperCase().slice(0, 2) || 'ES';
  const postcode = String(input.postcode || '').replace(/\s+/g, '');

  const ids = input.cart.map((l) => l.id);
  const rows = ids.length
    ? (await pool.query('SELECT id, price, sale_price, promo_price, stock FROM products WHERE id = ANY($1)', [ids])).rows
    : [];
  const byId = new Map(rows.map((r: any) => [r.id, r]));

  let subtotalCents = 0;
  // Líneas en promoción (precio DTO2, el mínimo sin pérdidas): no admiten más descuentos.
  let promoCents = 0;
  const items: Quote['items'] = [];
  const stockErrors: Quote['stockErrors'] = [];
  const missing: number[] = [];
  for (const line of input.cart) {
    const row: any = byId.get(line.id);
    if (!row) { missing.push(line.id); continue; }
    // Lo mismo que muestra la web: promoción, si no la oferta (solo si es menor), si no el precio.
    const list = Number(row.price) || 0;
    const sale = Number(row.sale_price) || 0;
    const price = Number(row.promo_price) || (sale > 0 && sale < list ? sale : list);
    subtotalCents += price * line.quantity;
    if (Number(row.promo_price) > 0) promoCents += price * line.quantity;
    const stock = Number(row.stock) || 0;
    if (stock < line.quantity) stockErrors.push({ id: line.id, requested: line.quantity, available: stock });
    items.push({ productId: line.id, quantity: line.quantity, price });
  }
  const subtotalEur = subtotalCents / 100;

  let shippingCents = await shippingFor(country, postcode, subtotalEur);
  const tier = ORDER_TIERS.find((t) => subtotalEur >= t.min);
  let discountPercent = tier?.discountPercent || 0;
  if (tier?.freeShipping) shippingCents = 0;

  // Cupones (tabla coupons). Al presupuestar solo se valida; al crear el pedido
  // se canjea de forma atómica (límite de usos y caducidad).
  let promo: Quote['promo'] = null;
  let fixedCents = 0;
  const code = String(input.promoCode || '').trim().toUpperCase();
  if (code) {
    const sqlCheck = `FROM coupons WHERE UPPER(code) = $1 AND active = 1
        AND (max_uses IS NULL OR times_used < max_uses) AND (expires_at IS NULL OR expires_at > NOW())`;
    const found: any = (await pool.query(`SELECT type, value, COALESCE(min_amount, 0) AS min_amount ${sqlCheck} LIMIT 1`, [code])).rows[0];
    const minCents = Number(found?.min_amount) || 0;
    let applied: any = null;
    let error: string | undefined;
    if (!found) {
      error = 'Cupón no válido o caducado';
    } else if (subtotalCents < minCents) {
      error = `Este cupón requiere una compra mínima de ${(minCents / 100).toFixed(2).replace('.', ',')} €`;
    } else if (opts.redeemCoupon) {
      // Canje atómico: límite de usos y caducidad comprobados en la misma sentencia.
      applied = (await pool.query(`UPDATE coupons SET times_used = times_used + 1
          WHERE id = (SELECT id ${sqlCheck} LIMIT 1) RETURNING type, value`, [code])).rows[0] || null;
      if (!applied) error = 'Cupón no válido o caducado';
    } else {
      applied = found;
    }
    promo = { code, valid: !!applied, type: applied?.type, minAmount: minCents / 100, error };
    if (applied?.type === 'percent') discountPercent += Number(applied.value) || 0;
    else if (applied?.type === 'fixed') fixedCents = Number(applied.value) || 0;
    else if (applied?.type === 'free_shipping') shippingCents = 0;
  }

  discountPercent = Math.min(100, Math.max(0, discountPercent));
  const discountable = subtotalCents - promoCents;
  const discountCents = Math.min(discountable, Math.round((discountable * discountPercent) / 100) + Math.max(0, fixedCents));

  // Impuesto del destino: los precios llevan el IVA español y se reexpresan con
  // el tipo de la regla (0 % en Canarias, Ceuta y Melilla).
  const tax = await resolveTax(country, postcode);
  const subtotalDest = toDestinationCents(subtotalCents, tax.rate);
  const discountDest = toDestinationCents(discountCents, tax.rate);
  const shippingDest = toDestinationCents(shippingCents, tax.rate);
  const totalCents = Math.max(0, subtotalDest - discountDest + shippingDest);

  const next = [...ORDER_TIERS].reverse().find((t) => subtotalEur < t.min);
  return {
    items, stockErrors, missing,
    subtotalCents: subtotalDest,
    discountPercent,
    discountCents: discountDest,
    shippingCents: shippingDest,
    taxRate: tax.rate, taxLabel: tax.label, taxNote: tax.note,
    taxCents: taxInTotal(totalCents, tax.rate),
    totalCents,
    promo,
    nextTier: next ? { ...next, missingCents: Math.round(next.min * 100 - subtotalCents) } : null,
  };
}
