import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('../lib/moto-catalog.js', () => ({
  compatibleSkus: vi.fn(async () => []),
  getCatalogData: () => ({ hierarchy: {
    YAMAHA: { 'MT-09': {}, 'MT-09 SP': {}, 'MT-07': {}, 'TENERE 700': {}, 'TENERE 700 RALLY': {} },
    HONDA: { 'PCX 125': {}, 'CB 500 F': {}, 'CB 500 X': {} },
    APRILIA: { 'AMICO 50': {} },
    CYCLONE: { RX2: {} },
    MOTOBECANE: { '51': {} },
    'MOTO MORINI': { '650 X-CAPE': {} },
  } }),
}));

const { splitPosition, contradictsPosition, cardsFor, catalogMoto, conversationMoto, conversationProduct } = await import('./catalog.js');

const garage = ['CYCLONE RX2 2026', 'APRILIA AMICO 50 1998', 'HONDA PCX 125 (2022)'];

describe('moto de la conversación', () => {
  it('reconoce la moto se escriba como se escriba, con marca o sin ella', () => {
    expect(catalogMoto('Honda CB500F de 2016')).toEqual({ brand: 'HONDA', model: 'CB 500 F', year: 2016 });
    expect(catalogMoto('Y para una mt09 de 2023?')).toEqual({ brand: 'YAMAHA', model: 'MT-09', year: 2023 });
    expect(catalogMoto('una yamaha mt-07')).toEqual({ brand: 'YAMAHA', model: 'MT-07', year: null });
    expect(catalogMoto('Y para una tenere de 2025?')).toEqual({ brand: 'YAMAHA', model: 'TENERE 700', year: 2025 });
    expect(catalogMoto('HONDA PCX 125 (2022)')).toEqual({ brand: 'HONDA', model: 'PCX 125', year: 2022 });
    expect(catalogMoto('pastillas de freno delanteras')).toBeNull();
    expect(catalogMoto('¿Y para una MOTOBECANE 51 de 1986?')).toEqual({ brand: 'MOTOBECANE', model: '51', year: 1986 });
  });

  it('la del último mensaje que nombre una; si no, la elegida en la web', () => {
    expect(conversationMoto(['Pastillas de freno para mi moto'], garage)).toMatchObject({ brand: 'CYCLONE', model: 'RX2', year: 2026, from: 'garaje' });
    expect(conversationMoto(['Pastillas de freno para mi moto', 'Y para una mt09 de 2023?'], garage)).toMatchObject({ model: 'MT-09', year: 2023, from: 'mensaje' });
    expect(conversationMoto(['Pastillas para una mt09 de 2023', 'Y para una tenere de 2025?', 'Si'], garage)).toMatchObject({ model: 'TENERE 700', year: 2025 });
  });

  it('una moto de su garaje nombrada a medias lleva el año del garaje', () => {
    expect(conversationMoto(['Pastillas de freno para mi moto', 'Y para mi pcx'], garage)).toMatchObject({ brand: 'HONDA', model: 'PCX 125', year: 2022 });
  });

  it('el año puede llegar después («es de 2016»)', () => {
    expect(conversationMoto(['kit de arrastre para la Honda CB500F', 'Es de 2016'], [])).toMatchObject({ model: 'CB 500 F', year: 2016 });
  });
});

describe('pieza de la conversación', () => {
  it('sin la moto ni el año, y sigue con la anterior si el mensaje no nombra pieza', () => {
    expect(conversationProduct(['¿Tenéis pastillas de freno para la Honda PCX 125 de 2022?']).search).toBe('pastillas freno');
    expect(conversationProduct(['Pastillas de freno para mi moto', 'Y para una mt09 de 2023?']).search).toBe('pastillas freno');
    expect(conversationProduct(['kit de arrastre para la CB500F', 'Es de 2016']).search).toBe('kit de arrastre');
    expect(conversationProduct(['pastillas para la mt07', '¿y un filtro de aceite?']).search).toBe('filtro aceite');
    expect(conversationProduct(['Busco filtro de aire', 'Es para una moto morini 650 x-cape del 2022']).search).toBe('filtro aire');
  });

  it('la posición va aparte y manda la del último mensaje', () => {
    expect(conversationProduct(['Pastillas de freno para mi moto', 'Delanteras'])).toEqual({ search: 'pastillas freno', positions: ['delantera'] });
    expect(conversationProduct(['pastillas delanteras honda pcx 125', '¿y las traseras?'])).toEqual({ search: 'pastillas', positions: ['trasera'] });
  });
});

describe('posición pedida', () => {
  it('se saca de la búsqueda (los nombres no la llevan)', () => {
    expect(splitPosition('pastillas delanteras honda pcx 125')).toEqual({ search: 'pastillas honda pcx 125', positions: ['delantera'] });
    expect(splitPosition('intermitente trasero izquierdo')).toEqual({ search: 'intermitente', positions: ['trasera', 'izquierda'] });
  });

  it('solo descarta un producto si su ficha dice otra posición', () => {
    expect(contradictsPosition('Trasero', ['delantera'])).toBe(true);
    expect(contradictsPosition('Delantero', ['delantera'])).toBe(false);
    expect(contradictsPosition('Delantero/trasero', ['delantera'])).toBe(false);
    expect(contradictsPosition(null, ['delantera'])).toBe(false);
    expect(contradictsPosition('Izquierda', ['derecha'])).toBe(true);
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
    const named = [{ ...hit(1), name: 'Pastillas de freno Tecnium MA359 Orgánicas' }, { ...hit(2), name: 'Pastillas Brembo 07GR03CC' }, { ...hit(3), name: 'Zapatas BA208' }];
    expect(cardsFor(named, null, 'Te recomiendo las **Tecnium MA359** o las Brembo 07GR03CC.').map((c) => c.id)).toEqual([1, 2]);
  });
});
