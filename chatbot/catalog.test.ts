import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('../lib/moto-catalog.js', () => ({ getCatalogData: () => ({ hierarchy: {
  YAMAHA: { 'MT-09': {}, 'MT-09 SP': {}, 'TENERE 700': {}, 'TENERE 700 RALLY': {} },
  HONDA: { 'PCX 125': {}, 'CB 500 F': {} },
} }) }));

const { splitPosition, contradictsPosition, cardsFor, spaceModel, garageMotoNamed, catalogMotoIn, buildSearchQuery } = await import('./catalog.js');

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

describe('modelo escrito junto', () => {
  it('se separa como en las compatibilidades', () => {
    expect(spaceModel('kit de arrastre honda cb500f', 'CB500F')).toBe('kit de arrastre honda cb 500 f');
    expect(spaceModel('pastillas honda pcx 125', 'PCX 125')).toBe('pastillas honda pcx 125');
    expect(spaceModel('kit 520 honda', undefined)).toBe('kit 520 honda');
  });
});

describe('moto del garaje nombrada', () => {
  const motos = [{ brand: 'CYCLONE', model: 'RX2', year: 2026 }, { brand: 'APRILIA', model: 'AMICO 50', year: 1998 }, { brand: 'HONDA', model: 'PCX 125', year: 2022 }];
  it('por una palabra de su modelo, la última nombrada', () => {
    expect(garageMotoNamed('Pastillas de freno para mi moto Delanteras Y para mi pcx', motos)?.model).toBe('PCX 125');
    expect(garageMotoNamed('para la amico y luego la PCX', motos)?.model).toBe('PCX 125');
    expect(garageMotoNamed('pastillas delanteras', motos)).toBeNull();
  });
});

describe('moto nombrada solo por el modelo', () => {
  it('se reconoce con el catálogo de motos y su año', () => {
    expect(catalogMotoIn('Y para una mt09 de 2023?')).toEqual({ brand: 'YAMAHA', model: 'MT-09', year: 2023 });
    expect(catalogMotoIn('Y para una tenere de 2025?')).toEqual({ brand: 'YAMAHA', model: 'TENERE 700', year: 2025 });
    expect(catalogMotoIn('pastillas de freno delanteras')).toBeNull();
  });
  it('una pregunta de seguimiento con otra moto mantiene el producto y cambia de moto', () => {
    expect(buildSearchQuery(['Pastillas de freno para mi moto', 'Y para una mt09 de 2023?'])).toBe('pastillas freno Y para una mt09 de 2023?');
    expect(buildSearchQuery(['pastillas de freno honda pcx 125 2022', 'Y para una tenere de 2025?'])).toBe('pastillas freno Y para una tenere de 2025?');
    expect(buildSearchQuery(['pastillas de freno honda pcx 125 2022', '¿y la trasera?'])).toBe('pastillas de freno honda pcx 125 2022 ¿y la trasera?');
  });
});

describe('tarjetas del chat', () => {
  const hit = (id: number) => ({ id, sku: `S${id}`, brand: 'B', name: `N${id}`, price: 1000, sale_price: null, stock: id, stock_status: '', image: null, slug: `S${id}`, compatibility: [], category2: null, category3: null, position: null });
  const hits = [hit(1), hit(2), hit(3)];

  it('solo las de los productos que elige el asistente, en su orden', () => {
    expect(cardsFor(hits, ' P3, P1').map((c) => c.sku)).toEqual(['S3', 'S1']);
    expect(cardsFor(hits, 'P2, P2, P9').map((c) => c.sku)).toEqual(['S2']);
    expect(cardsFor(hits, ' 3, 1').map((c) => c.sku)).toEqual(['S3', 'S1']);
  });

  it('ninguna si elige «ninguno»; sin marca, las que nombra la respuesta por su referencia', () => {
    expect(cardsFor(hits, ' ninguno')).toEqual([]);
    expect(cardsFor(hits, null)).toEqual([]);
    const named = [{ ...hit(1), name: 'Pastillas de freno Tecnium MA359 Orgánicas' }, { ...hit(2), name: 'Pastillas Brembo 07GR03CC' }, { ...hit(3), name: 'Zapatas BA208' }];
    expect(cardsFor(named, null, 'Te recomiendo las **Tecnium MA359** o las Brembo 07GR03CC.').map((c) => c.id)).toEqual([1, 2]);
  });
});
