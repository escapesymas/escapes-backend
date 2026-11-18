import { describe, it, expect, vi } from 'vitest';

// El módulo abre la base de datos al importarse: aquí solo se prueba el cálculo de los KPIs.
vi.mock('../db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('./overview-visits.js', () => ({ getVisitsSummary: vi.fn(), getVisitsDetail: vi.fn() }));

const { buildKpis } = await import('./overview-report.js');
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
