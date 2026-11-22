import { describe, it, expect, vi, beforeEach } from 'vitest';

// BD simulada: lo que devuelve chat_agents y si falla.
const db = vi.hoisted(() => ({ rows: [] as any[], fail: false, calls: 0 }));
vi.mock('../db.js', () => ({
  pool: {
    query: vi.fn(async () => {
      db.calls++;
      if (db.fail) throw new Error('base de datos caída');
      return { rows: db.rows };
    }),
  },
}));

import {
  MIN_MARKUP, COMMISSION_SHARE, COMMISSION_HOLD_DAYS, maxDiscountPct, minGrossCents, discountedCents, netMarginCents,
  commissionCents, productEconomics, agentCommissionShare, forgetCommissionShare,
} from './chat-commission.js';

// Producto de ejemplo: PVP 100 € (con IVA), coste 50 €.
const LIST = 10000;
const COST = 5000;

describe('reglas de negocio fijadas por Adrián', () => {
  // Si cambian a propósito, hay que cambiar este test: así nadie las toca sin querer.
  it('margen neto mínimo del 20 % sobre el coste, comisión del 50 % y 30 días de retención', () => {
    expect(MIN_MARKUP).toBe(0.2);
    expect(COMMISSION_SHARE).toBe(0.5);
    expect(COMMISSION_HOLD_DAYS).toBe(30);
  });
});

describe('descuento máximo del asesor: deja un margen neto del 20 % sobre el coste', () => {
  it('sin coste conocido, o con datos absurdos, no hay descuento', () => {
    expect(maxDiscountPct(LIST, null)).toBe(0);
    expect(maxDiscountPct(LIST, undefined)).toBe(0);
    expect(maxDiscountPct(LIST, 0)).toBe(0);
    expect(maxDiscountPct(LIST, -100)).toBe(0);
    expect(maxDiscountPct(0, COST)).toBe(0);
  });

  it('un producto que ya vende por debajo del margen mínimo no admite descuento', () => {
    // PVP 60 € con coste 50 €: el 20 % de margen exige subir el precio, no bajarlo.
    expect(maxDiscountPct(6000, 5000)).toBe(0);
  });

  it('al descuento máximo la unidad sigue dejando el 20 % del coste (tolerancia de 1 céntimo)', () => {
    const pct = maxDiscountPct(LIST, COST);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
    const margin = netMarginCents(discountedCents(LIST, pct), COST, LIST);
    expect(margin).toBeGreaterThanOrEqual(MIN_MARKUP * COST - 1);
  });

  it('una décima más de descuento ya bajaría del margen mínimo', () => {
    const pct = maxDiscountPct(LIST, COST);
    const margin = netMarginCents(discountedCents(LIST, pct + 0.1), COST, LIST);
    expect(margin).toBeLessThan(MIN_MARKUP * COST);
  });

  it('el precio mínimo es coherente con el descuento (redondeo hacia abajo, una decimal)', () => {
    const pct = maxDiscountPct(LIST, COST);
    expect(Math.round(pct * 10) / 10).toBe(pct);
    expect(discountedCents(LIST, pct)).toBeGreaterThanOrEqual(minGrossCents(COST, LIST) - 1);
  });

  it('discountedCents redondea al céntimo', () => {
    expect(discountedCents(10000, 10)).toBe(9000);
    expect(discountedCents(999, 33.3)).toBe(Math.round(999 * (1 - 0.333)));
    expect(discountedCents(10000, 0)).toBe(10000);
  });
});

describe('comisión del asesor: mitad del margen neto', () => {
  it('sin coste conocido no hay comisión', () => {
    expect(commissionCents(LIST, null)).toBeNull();
    expect(commissionCents(LIST, 0)).toBeNull();
  });

  it('por defecto es el 50 % del margen neto de la unidad', () => {
    expect(COMMISSION_SHARE).toBe(0.5);
    expect(commissionCents(LIST, COST)).toBe(Math.round(0.5 * netMarginCents(LIST, COST)));
  });

  it('respeta el reparto propio de un asesor', () => {
    expect(commissionCents(LIST, COST, LIST, 0.3)).toBe(Math.round(0.3 * netMarginCents(LIST, COST, LIST)));
  });

  it('nunca es negativa, ni vendiendo por debajo del coste', () => {
    expect(commissionCents(3000, COST, LIST)).toBe(0);
  });

  it('cuanto más descuento, menos comisión', () => {
    const full = commissionCents(LIST, COST, LIST)!;
    const discounted = commissionCents(discountedCents(LIST, 10), COST, LIST)!;
    expect(discounted).toBeLessThan(full);
  });
});

describe('productEconomics: lo que ve el asesor de cada producto', () => {
  it('los productos en promoción no admiten descuento ni comisionan', () => {
    expect(productEconomics(LIST, COST, true)).toEqual({
      has_cost: true, in_promo: true, max_discount_pct: 0, commission_max: 0, commission_min: 0,
    });
  });

  it('sin coste: sin descuento y sin cifras de comisión', () => {
    expect(productEconomics(LIST, null)).toEqual({
      has_cost: false, in_promo: false, max_discount_pct: 0, commission_max: null, commission_min: null,
    });
  });

  it('con coste: comisión mínima (al descuento máximo) ≤ máxima, y la mínima ronda el 10 % del coste', () => {
    const e = productEconomics(LIST, COST);
    expect(e.has_cost).toBe(true);
    expect(e.max_discount_pct).toBe(maxDiscountPct(LIST, COST));
    expect(e.commission_min!).toBeLessThanOrEqual(e.commission_max!);
    // Al precio mínimo el margen neto es el 20 % del coste y el asesor se lleva la mitad.
    expect(Math.abs(e.commission_min! - 0.5 * MIN_MARKUP * COST)).toBeLessThanOrEqual(2);
  });
});

describe('agentCommissionShare', () => {
  beforeEach(() => { db.rows = []; db.fail = false; db.calls = 0; });

  it('sin usuario (o sin fila) vale el 50 % por defecto', async () => {
    expect(await agentCommissionShare(null)).toBe(0.5);
    expect(await agentCommissionShare(undefined)).toBe(0.5);
    expect(await agentCommissionShare(7001)).toBe(0.5);
  });

  it('lee el porcentaje propio del asesor', async () => {
    db.rows = [{ commission_share: 30 }];
    expect(await agentCommissionShare(7002)).toBeCloseTo(0.3);
  });

  it('un valor fuera de 0-100 o no numérico cae al 50 %', async () => {
    db.rows = [{ commission_share: 150 }];
    expect(await agentCommissionShare(7003)).toBe(0.5);
    db.rows = [{ commission_share: 'abc' }];
    expect(await agentCommissionShare(7004)).toBe(0.5);
  });

  it('si la base de datos falla, el asesor cobra lo normal (no 0, no error)', async () => {
    db.fail = true;
    expect(await agentCommissionShare(7005)).toBe(0.5);
  });

  it('cachea 30 s y forgetCommissionShare la borra', async () => {
    db.rows = [{ commission_share: 40 }];
    await agentCommissionShare(7006);
    await agentCommissionShare(7006);
    expect(db.calls).toBe(1);
    forgetCommissionShare(7006);
    db.rows = [{ commission_share: 20 }];
    expect(await agentCommissionShare(7006)).toBeCloseTo(0.2);
    expect(db.calls).toBe(2);
  });
});
