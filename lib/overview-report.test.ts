import { describe, it, expect, vi } from 'vitest';

// El módulo abre la base de datos al importarse: aquí solo se prueba el cálculo de los KPIs.
vi.mock('../db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('./overview-visits.js', () => ({ getVisitsSummary: vi.fn(), getVisitsDetail: vi.fn() }));

const { alignSeries, applyAvailability, buildKpis } = await import('./overview-report.js');
const { makeData, makeReport } = await import('./overview-fixture.js');

const kpi = (list: ReturnType<typeof buildKpis>, id: string) => {
  const found = list.find((x) => x.id === id);
  if (!found) throw new Error(`falta el KPI ${id}`);
  return found;
};

describe('KPIs de la Vista general', () => {
  const kpis = buildKpis(makeData());

  it('ventas, ticket medio y margen salen de los céntimos', () => {
    expect(kpi(kpis, 'sales_revenue')).toMatchObject({ value: 480, prev: 200, unit: 'eur', good: 'up' });
    expect(kpi(kpis, 'sales_avg')).toMatchObject({ value: 120, prev: 100 });
    // base imponible = 480 − 83,31 = 396,69; margen = 396,69 − 210 = 186,69
    expect(kpi(kpis, 'sales_base').value).toBeCloseTo(396.69, 2);
    expect(kpi(kpis, 'sales_margin').value).toBeCloseTo(186.69, 2);
    expect(kpi(kpis, 'sales_margin_pct').value).toBeCloseTo(47.1, 1);
  });

  it('la conversión es pedidos entre visitantes (en %)', () => {
    expect(kpi(kpis, 'conv_rate').value).toBeCloseTo(0.33, 2);
    expect(kpi(kpis, 'conv_rate').prev).toBeCloseTo(0.25, 2);
  });

  it('rebote, 404 y búsquedas sin resultado: bajar es bueno', () => {
    for (const id of ['bounce_rate', 'not_found', 'no_results', 'sales_pending', 'sales_refunded', 'abandoned_detected']) {
      expect(kpi(kpis, id).good, id).toBe('down');
    }
  });

  it('las fotos del momento no tienen periodo anterior', () => {
    for (const id of ['carts_active', 'carts_active_value', 'carts_stale', 'customers_total', 'products_published', 'products_in_stock']) {
      expect(kpi(kpis, id).prev, id).toBeNull();
    }
  });

  it('el valor medio por carrito no divide por cero', () => {
    const none = buildKpis(makeData({ visitsCur: { ...makeData().visitsCur!, addToCart: 0, visitors: 0, cartValue: 0 } }));
    expect(kpi(none, 'carts_avg_value').value).toBe(0);
    expect(kpi(none, 'pages_per_visitor').value).toBe(0);
    expect(kpi(none, 'conv_rate').value).toBe(0);
  });

  it('sin estadísticas web el informe sigue saliendo sin esos KPIs', () => {
    const noVisits = buildKpis(makeData({ visitsCur: null, visitsPrev: null, googleCur: null, googlePrev: null }));
    expect(noVisits.find((x) => x.id === 'visitors')).toBeUndefined();
    expect(noVisits.find((x) => x.id === 'conv_rate')).toBeUndefined();
    expect(kpi(noVisits, 'sales_revenue').value).toBe(480);
    expect(kpi(noVisits, 'carts_active').value).toBe(5);
  });

  it('los ids son únicos y los destacados existen', () => {
    const ids = kpis.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of makeReport().headline) expect(ids, h).toContain(h);
  });

  it('la espera del asesor solo sale si hubo chats con respuesta', () => {
    const none = buildKpis(makeData({ peopleCur: { ...makeData().peopleCur, advisorWaitMin: null }, peoplePrev: { ...makeData().peoplePrev, advisorWaitMin: null } }));
    expect(none.find((x) => x.id === 'advisor_wait')).toBeUndefined();
    expect(kpi(kpis, 'advisor_wait').value).toBe(4.5);
  });
});

describe('comparación sin datos del otro periodo', () => {
  it('si no hay datos de visitas del periodo de comparación, esos KPIs salen sin comparar (no «nuevo»)', () => {
    const k = buildKpis(makeData({ prevAvail: { store: true, visits: false } }));
    for (const id of ['visitors', 'bounce_rate', 'carts_added', 'carts_added_value', 'cart_to_checkout', 'conv_rate']) {
      expect(kpi(k, id), id).toMatchObject({ prev: null, noPrev: true });
    }
    // lo de la tienda sí se compara
    expect(kpi(k, 'sales_revenue')).toMatchObject({ prev: 200 });
    expect(kpi(k, 'sales_revenue').noPrev).toBeUndefined();
    expect(kpi(k, 'abandoned_detected')).toMatchObject({ prev: 3 });
  });

  it('si no hay datos de la tienda, las ventas, clientes y atención salen sin comparar y las visitas sí', () => {
    const k = buildKpis(makeData({ prevAvail: { store: false, visits: true } }));
    for (const id of ['sales_revenue', 'customers_new', 'ai_chats', 'abandoned_recovered', 'conv_rate']) expect(kpi(k, id), id).toMatchObject({ prev: null, noPrev: true });
    expect(kpi(k, 'visitors')).toMatchObject({ prev: 800 });
  });

  it('las fotos del momento no se marcan como «sin datos»: nunca tuvieron comparación', () => {
    const k = buildKpis(makeData({ prevAvail: { store: false, visits: false } }));
    expect(kpi(k, 'carts_active').noPrev).toBeUndefined();
    expect(kpi(k, 'customers_total').noPrev).toBeUndefined();
  });

  it('con datos de los dos lados no cambia nada', () => {
    const list = buildKpis(makeData());
    expect(applyAvailability(list, { store: true, visits: true })).toEqual(list);
    expect(applyAvailability(list, undefined)).toBe(list);
  });
});

describe('series del periodo de comparación', () => {
  it('se alinean por posición con las del periodo y rellenan con ceros los días sin dato', () => {
    const prev = ['2025-11-12', '2025-11-13', '2025-11-14'];
    expect(alignSeries(prev, new Map([['2025-11-13', 50]]), 3, true)).toEqual([0, 50, 0]);
  });

  it('si el periodo de comparación es más corto, el resto queda vacío (null)', () => {
    expect(alignSeries(['2025-02-27', '2025-02-28'], new Map([['2025-02-28', 7]]), 3, true)).toEqual([0, 7, null]);
  });

  it('sin datos disponibles todo es null', () => {
    expect(alignSeries(['2025-11-12'], new Map([['2025-11-12', 9]]), 2, false)).toEqual([null, null]);
  });
});
