import { describe, it, expect, vi, beforeEach } from 'vitest';

// Productos y cupones de prueba que devuelve la BD simulada.
const db = vi.hoisted(() => ({ products: [] as any[], coupon: null as any }));

vi.mock('../db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM products')) return { rows: db.products };
      if (sql.includes('FROM shipping_zones')) return { rows: [{ id: 1, regions: ['ES'] }] };
      if (sql.includes('FROM shipping_methods')) return { rows: [{ zone_id: 1, cost: 1999, free_shipping_threshold: 200 }] };
      if (sql.includes('FROM coupons')) return { rows: db.coupon ? [db.coupon] : [] };
      return { rows: [] };
    }),
  },
}));

vi.mock('./tax.js', () => ({
  resolveTax: vi.fn(async () => ({ rate: 21, label: 'IVA', note: null })),
  toDestinationCents: (c: number) => c,
  taxInTotal: () => 0,
}));

import { quoteOrder, SHIPPING_REAL_COST_CENTS, EXTRA_DISCOUNT_MIN_MARGIN, MAX_EXTRA_DISCOUNT_PERCENT } from './order-pricing.js';
import { floorPrice } from './pricing.js';

/** Margen neto del pedido: ingresos sin IVA − coste − comisión de pago − envío real. */
function netMargin(q: Awaited<ReturnType<typeof quoteOrder>>, cost: number, qty = 1) {
  const paid = q.totalCents;
  const shippingPaid = q.shippingCents;
  return (paid - shippingPaid) / 1.21 - cost * qty - (paid * 0.015 + 25) + shippingPaid / 1.21 - SHIPPING_REAL_COST_CENTS / 1.21;
}

describe('quoteOrder: tope de descuentos extra', () => {
  beforeEach(() => { db.products = []; db.coupon = null; });

  it('aplica el tramo completo cuando hay margen de sobra', async () => {
    // 200 € con coste 100 €: mucho margen.
    db.products = [{ id: 1, price: 20000, sale_price: 0, promo_price: null, stock: 5, cost: 10000 }];
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }] });
    expect(q.discountPercent).toBe(5);
    expect(q.discountCents).toBe(1000);
    expect(q.discountCapped).toBe(false);
  });

  it('recorta tramo + cupón para no bajar del margen mínimo (envío gratis incluido)', async () => {
    // 500 € con coste 360 €: el 10 % (tramo + cupón, ya en el máximo) daría pérdidas.
    db.products = [{ id: 1, price: 50000, sale_price: 0, promo_price: null, stock: 5, cost: 36000 }];
    db.coupon = { type: 'percent', value: 10, min_amount: 0 };
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }], promoCode: 'VUELVE10-X' });
    expect(q.shippingCents).toBe(0);
    expect(q.discountCapped).toBe(true);
    const room = 50000 - floorPrice(36000, EXTRA_DISCOUNT_MIN_MARGIN);
    expect(q.discountCents).toBe(room - SHIPPING_REAL_COST_CENTS);
    expect(netMargin(q, 36000)).toBeGreaterThan(0);
  });

  it('sin coste conocido no hay descuento extra', async () => {
    db.products = [{ id: 1, price: 60000, sale_price: 0, promo_price: null, stock: 5, cost: 0 }];
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }] });
    expect(q.discountCents).toBe(0);
    expect(q.discountCapped).toBe(true);
  });

  it('los productos en promoción siguen sin admitir descuentos', async () => {
    db.products = [{ id: 1, price: 40000, sale_price: 0, promo_price: 30000, stock: 5, cost: 20000 }];
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }] });
    expect(q.discountCents).toBe(0);
    expect(q.discountCapped).toBe(false);
  });

  it('un cupón de importe fijo tampoco pasa del tope', async () => {
    db.products = [{ id: 1, price: 5000, sale_price: 0, promo_price: null, stock: 5, cost: 3500 }];
    db.coupon = { type: 'fixed', value: 3000, min_amount: 0 };
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }], promoCode: 'FIJO30' });
    // 50 € con coste 35 € y envío cobrado (19,99 € < 25 € reales): casi no queda margen.
    expect(q.discountCents).toBeLessThan(3000);
    expect(q.discountCapped).toBe(true);
  });
});

describe('quoteOrder: máximo del 10 % de descuento extra (margen para los asesores)', () => {
  beforeEach(() => { db.products = []; db.coupon = null; });
  const roomy = (price: number) => [{ id: 1, price, sale_price: 0, promo_price: null, stock: 5, cost: Math.round(price * 0.3) }];

  it('el tramo más alto es el 10 % (ya no hay 15 % desde 500 €)', async () => {
    db.products = roomy(80000);
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }] });
    expect(q.discountPercent).toBe(10);
    expect(q.discountCents).toBe(8000);
    expect(q.nextTier).toBeNull();
  });

  it('tramo + cupón no pasan del 10 % y se avisa de cuánto suma el cupón', async () => {
    db.products = roomy(20000); // 5 % por importe
    db.coupon = { type: 'percent', value: 10, min_amount: 0 };
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }], promoCode: 'VUELVE10-X' });
    expect(q.discountPercent).toBe(MAX_EXTRA_DISCOUNT_PERCENT);
    expect(q.discountCents).toBe(2000);
    expect(q.promo?.valid).toBe(true);
    expect(q.promo?.note).toMatch(/suma un 5 %/);
  });

  it('con el 10 % por importe el cupón de porcentaje no suma nada', async () => {
    db.products = roomy(40000);
    db.coupon = { type: 'percent', value: 5, min_amount: 0 };
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }], promoCode: 'VUELVE5-X' });
    expect(q.discountCents).toBe(4000);
    expect(q.promo?.note).toMatch(/no suma más/);
  });

  it('sin tramo, un cupón del 10 % se aplica entero y sin aviso', async () => {
    db.products = roomy(10000);
    db.coupon = { type: 'percent', value: 10, min_amount: 0 };
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }], promoCode: 'VUELVE10-X' });
    expect(q.discountCents).toBe(1000);
    expect(q.promo?.note).toBeUndefined();
  });
});
