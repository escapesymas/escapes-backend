import { describe, it, expect } from 'vitest';
import { emptySignals, signalsFromRow, visitorTier, visitorScore, compareVisitors, type VisitorSignals } from './visitor-score.js';

const sig = (o: Partial<VisitorSignals>): VisitorSignals => ({ ...emptySignals(), ...o });

describe('visitorTier', () => {
  it('quien pone algo en el carrito o empieza a pagar es caliente aunque vea pocas páginas', () => {
    expect(visitorTier(sig({ pageviews: 1, addToCart: 1 }))).toBe('hot');
    expect(visitorTier(sig({ pageviews: 2, checkout: 1 }))).toBe('hot');
    expect(visitorTier(sig({ pageviews: 1, chat: 1 }))).toBe('hot');
    expect(visitorTier(sig({ pageviews: 1, purchase: 1 }))).toBe('hot');
  });

  it('varias páginas, fichas, búsquedas o volver a entrar es interés', () => {
    expect(visitorTier(sig({ pageviews: 4 }))).toBe('engaged');
    expect(visitorTier(sig({ pageviews: 2, productViews: 2 }))).toBe('engaged');
    expect(visitorTier(sig({ pageviews: 1, visits: 2 }))).toBe('engaged');
    expect(visitorTier(sig({ pageviews: 1, searches: 1 }))).toBe('engaged');
    expect(visitorTier(sig({ pageviews: 2, bikes: 1 }))).toBe('engaged');
  });

  it('2-3 páginas sin más es curioso y una sola página es rebote', () => {
    expect(visitorTier(sig({ pageviews: 2, visits: 1 }))).toBe('browsing');
    expect(visitorTier(sig({ pageviews: 3, visits: 1, productViews: 1 }))).toBe('browsing');
    expect(visitorTier(sig({ pageviews: 1, visits: 1 }))).toBe('bounce');
  });
});

describe('visitorScore', () => {
  it('una compra pesa más que cualquier recorrido sin compra', () => {
    const compra = visitorScore(sig({ pageviews: 2, purchase: 1 }));
    const curioso = visitorScore(sig({ pageviews: 25, productViews: 10, visits: 6, searches: 5, bikes: 3 }));
    expect(compra).toBeGreaterThan(curioso);
  });

  it('los contadores tienen tope: un robot con 500 páginas no desborda', () => {
    expect(visitorScore(sig({ pageviews: 500, productViews: 500, visits: 90 }))).toBe(25 + 20 + 25);
  });

  it('añadir más productos al carrito sube la puntuación', () => {
    expect(visitorScore(sig({ addToCart: 3 }))).toBeGreaterThan(visitorScore(sig({ addToCart: 1 })));
  });
});

describe('compareVisitors', () => {
  it('ordena por nivel, luego puntuación y luego el más reciente', () => {
    const rows = [
      { id: 'rebote', tier: 'bounce' as const, score: 1, lastSeenMs: 9 },
      { id: 'curioso-viejo', tier: 'browsing' as const, score: 4, lastSeenMs: 1 },
      { id: 'caliente-pocos', tier: 'hot' as const, score: 30, lastSeenMs: 1 },
      { id: 'caliente-muchos', tier: 'hot' as const, score: 60, lastSeenMs: 1 },
      { id: 'interesado-nuevo', tier: 'engaged' as const, score: 10, lastSeenMs: 8 },
      { id: 'interesado-viejo', tier: 'engaged' as const, score: 10, lastSeenMs: 2 },
    ];
    expect(rows.sort(compareVisitors).map((r) => r.id)).toEqual([
      'caliente-muchos', 'caliente-pocos', 'interesado-nuevo', 'interesado-viejo', 'curioso-viejo', 'rebote',
    ]);
  });
});

describe('signalsFromRow', () => {
  it('convierte las cadenas de COUNT de Postgres en números', () => {
    const s = signalsFromRow({ pageviews: '12', product_views: '3', visits: '2', add_to_cart: '1', checkout: '0', purchase: null, chat: undefined, sign_up: 'x', searches: '4', no_results: '1', bikes: '2' });
    expect(s).toEqual({ pageviews: 12, productViews: 3, visits: 2, addToCart: 1, checkout: 0, purchase: 0, chat: 0, signUp: 0, searches: 4, noResults: 1, bikes: 2 });
  });
});
