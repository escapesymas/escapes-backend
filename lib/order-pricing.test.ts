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

import { quoteOrder, SHIPPING_REAL_COST_CENTS, EXTRA_DISCOUNT_MIN_MARGIN } from './order-pricing.js';
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
    // 500 € con coste 320 €: el 15 % del tramo + 10 % de cupón darían pérdidas.
    db.products = [{ id: 1, price: 50000, sale_price: 0, promo_price: null, stock: 5, cost: 32000 }];
    db.coupon = { type: 'percent', value: 10, min_amount: 0 };
    const q = await quoteOrder({ cart: [{ id: 1, quantity: 1 }], promoCode: 'VUELVE10-X' });
    expect(q.shippingCents).toBe(0);
    expect(q.discountCapped).toBe(true);
    const room = 50000 - floorPrice(32000, EXTRA_DISCOUNT_MIN_MARGIN);
    expect(q.discountCents).toBe(room - SHIPPING_REAL_COST_CENTS);
    expect(netMargin(q, 32000)).toBeGreaterThan(0);
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
