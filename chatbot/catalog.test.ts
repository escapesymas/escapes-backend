import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

const { splitPosition, contradictsPosition, cardsFor } = await import('./catalog.js');

describe('posición pedida', () => {
  it('se saca de la búsqueda (los nombres no la llevan)', () => {
    expect(splitPosition('pastillas delanteras honda pcx 125')).toEqual({ search: 'pastillas honda pcx 125', positions: ['delantera'] });
    expect(splitPosition('intermitente trasero izquierdo')).toEqual({ search: 'intermitente', positions: ['trasera', 'izquierda'] });
    expect(splitPosition('pastillas honda pcx 125').positions).toEqual([]);
  });

  it('solo descarta un producto si su ficha dice otra posición', () => {
    expect(contradictsPosition('Trasero', ['delantera'])).toBe(true);
    expect(contradictsPosition('Delantero', ['delantera'])).toBe(false);
    expect(contradictsPosition('Delantero/trasero', ['delantera'])).toBe(false);
    expect(contradictsPosition(null, ['delantera'])).toBe(false);
    expect(contradictsPosition('Derecho', ['delantera'])).toBe(false);
    expect(contradictsPosition('Izquierda', ['derecha'])).toBe(true);
  });
});

describe('tarjetas del chat', () => {
  const hit = (id: number) => ({ id, sku: `S${id}`, brand: 'B', name: `N${id}`, price: 1000, sale_price: null, stock: id, stock_status: '', image: null, slug: `S${id}`, compatibility: [], category2: null, category3: null, position: null });
  const hits = [hit(1), hit(2), hit(3)];

  it('solo las de los productos que elige el asistente, en su orden', () => {
    expect(cardsFor(hits, ' P3, P1').map((c) => c.sku)).toEqual(['S3', 'S1']);
    expect(cardsFor(hits, 'P2, P2, P9').map((c) => c.sku)).toEqual(['S2']);
  });

  it('ninguna si no elige o no pone la marca', () => {
    expect(cardsFor(hits, ' ninguno')).toEqual([]);
    expect(cardsFor(hits, null)).toEqual([]);
  });
});
