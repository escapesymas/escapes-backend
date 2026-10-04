/**
 * Descuentos y comisiones de los asesores del chat.
 *
 * Margen neto de una unidad = precio sin IVA − coste − comisión de pago (Stripe).
 * - El asesor puede descontar hasta dejar un margen neto del 20 % del coste.
 * - Su comisión es el 50 % del margen neto que queda después del descuento.
 * - Sin coste conocido no se puede descontar ni calcular la comisión.
 * - Los productos en promoción (precio DTO2) ya van al margen mínimo: ni
 *   descuento ni comisión.
 * Todos los importes en céntimos; los precios de venta llevan el IVA español.
 */
import { VAT, PAYMENT_FEE_PCT, PAYMENT_FEE_FIXED } from './pricing.js';

export const MIN_MARKUP = 0.20;
export const COMMISSION_SHARE = 0.5;
/** Días desde el pago hasta que la comisión se puede cobrar (envío + 14 días de devolución). */
export const COMMISSION_HOLD_DAYS = 30;

export function netMarginCents(grossCents: number, costCents: number): number {
  return grossCents / VAT - costCents - (grossCents * PAYMENT_FEE_PCT + PAYMENT_FEE_FIXED);
}

/** Precio mínimo (con IVA) que deja el 20 % de margen neto sobre el coste. */
export function minGrossCents(costCents: number): number {
  return Math.ceil((costCents * (1 + MIN_MARKUP) + PAYMENT_FEE_FIXED) / (1 / VAT - PAYMENT_FEE_PCT));
}

/** Descuento máximo en % (una decimal, hacia abajo) sobre el precio de venta. */
export function maxDiscountPct(listGrossCents: number, costCents: number | null | undefined): number {
  if (!costCents || costCents <= 0 || listGrossCents <= 0) return 0;
  const pct = (1 - minGrossCents(costCents) / listGrossCents) * 100;
  return Math.max(0, Math.floor(pct * 10) / 10);
}

export function discountedCents(listGrossCents: number, discountPct: number): number {
  return Math.round(listGrossCents * (1 - discountPct / 100));
}

export function commissionCents(grossCents: number, costCents: number | null | undefined): number | null {
  if (!costCents || costCents <= 0) return null;
  return Math.max(0, Math.round(COMMISSION_SHARE * netMarginCents(grossCents, costCents)));
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
    commission_max: hasCost ? commissionCents(listGrossCents, costCents) : null,
    commission_min: hasCost ? commissionCents(discountedCents(listGrossCents, max), costCents) : null,
  };
}
