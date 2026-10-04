/**
 * Descuentos y comisiones de los asesores del chat.
 *
 * Margen neto de una unidad = precio sin IVA − coste − comisión del cobro
 * (Stripe) − coste de pagar la comisión al asesor (Stripe Connect, 0,25 %).
 * - El asesor puede descontar hasta dejar un margen neto del 20 % del coste.
 * - Su comisión es el 50 % del margen neto que queda después del descuento.
 * - El coste de pagarle (0,25 % de lo enviado) se calcula sobre la comisión
 *   máxima del producto y se trata como un coste más de la venta: al asesor no
 *   se le descuenta nada. Los fijos de Connect (0,10 € por pago y 2 € al mes
 *   por asesor) son gasto general, no de cada producto.
 * - Sin coste conocido no se puede descontar ni calcular la comisión.
 * - Los productos en promoción (precio DTO2) ya van al margen mínimo: ni
 *   descuento ni comisión.
 * Todos los importes en céntimos; los precios de venta llevan el IVA español.
 */
import { VAT, PAYMENT_FEE_PCT, PAYMENT_FEE_FIXED } from './pricing.js';

export const MIN_MARKUP = 0.20;
export const COMMISSION_SHARE = 0.5;
/** Stripe Connect: % de cada pago al asesor (el fijo por pago es gasto general). */
export const PAYOUT_FEE_PCT = 0.0025;
/** Días desde el pago hasta que la comisión se puede cobrar (envío + 14 días de devolución). */
export const COMMISSION_HOLD_DAYS = 30;

const saleFee = (grossCents: number) => grossCents * PAYMENT_FEE_PCT + PAYMENT_FEE_FIXED;

/**
 * Coste por unidad de pagar la comisión al asesor: 0,25 % de la comisión
 * máxima (la del precio sin descuento), fijo para cada producto.
 */
export function payoutCostCents(listGrossCents: number, costCents: number): number {
  const maxMargin = listGrossCents / VAT - costCents - saleFee(listGrossCents);
  return Math.max(0, PAYOUT_FEE_PCT * COMMISSION_SHARE * maxMargin);
}

/** Margen neto de una unidad vendida a `grossCents` (precio sin descuento de referencia: `listGrossCents`). */
export function netMarginCents(grossCents: number, costCents: number, listGrossCents = grossCents): number {
  return grossCents / VAT - costCents - saleFee(grossCents) - payoutCostCents(listGrossCents, costCents);
}

/** Precio mínimo (con IVA) que deja el 20 % de margen neto sobre el coste. */
export function minGrossCents(costCents: number, listGrossCents: number): number {
  return Math.ceil((costCents * (1 + MIN_MARKUP) + PAYMENT_FEE_FIXED + payoutCostCents(listGrossCents, costCents)) / (1 / VAT - PAYMENT_FEE_PCT));
}

/** Descuento máximo en % (una decimal, hacia abajo) sobre el precio de venta. */
export function maxDiscountPct(listGrossCents: number, costCents: number | null | undefined): number {
  if (!costCents || costCents <= 0 || listGrossCents <= 0) return 0;
  const pct = (1 - minGrossCents(costCents, listGrossCents) / listGrossCents) * 100;
  return Math.max(0, Math.floor(pct * 10) / 10);
}

export function discountedCents(listGrossCents: number, discountPct: number): number {
  return Math.round(listGrossCents * (1 - discountPct / 100));
}

/** Comisión por unidad vendida a `grossCents`; `listGrossCents` es el precio sin descuento del asesor. */
export function commissionCents(grossCents: number, costCents: number | null | undefined, listGrossCents = grossCents): number | null {
  if (!costCents || costCents <= 0) return null;
  return Math.max(0, Math.round(COMMISSION_SHARE * netMarginCents(grossCents, costCents, listGrossCents)));
}

/** Lo que el asesor puede hacer con un producto: descuento máximo y comisión mínima/máxima por unidad. */
export function productEconomics(listGrossCents: number, costCents: number | null | undefined, inPromo = false) {
  const hasCost = !!costCents && costCents > 0;
  if (inPromo) {
    return { has_cost: hasCost, in_promo: true, max_discount_pct: 0, commission_max: 0, commission_min: 0 };
  }
  const max = maxDiscountPct(listGrossCents, costCents);
  return {
    has_cost: hasCost,
    in_promo: false,
    max_discount_pct: max,
    commission_max: hasCost ? commissionCents(listGrossCents, costCents, listGrossCents) : null,
    commission_min: hasCost ? commissionCents(discountedCents(listGrossCents, max), costCents, listGrossCents) : null,
  };
}
