import { describe, it, expect } from 'vitest';
import { parseBikeLabel, bikeLabel } from './moto-catalog.js';

// Lee moto_catalog.json y moto_catalog_extra.json del repo (los mismos del servidor).
describe('parseBikeLabel (motos del garaje)', () => {
  it('lee marca, modelo y año tal como los guarda el selector', () => {
    expect(parseBikeLabel('HONDA PCX 125 (2022)')).toEqual({ brand: 'HONDA', model: 'PCX 125', year: '2022' });
    expect(parseBikeLabel('honda x-adv 750 (2022)')).toEqual({ brand: 'HONDA', model: 'X-ADV 750', year: '2022' });
  });

  it('marcas de varias palabras', () => {
    expect(parseBikeLabel('HARLEY DAVIDSON XL 883 S')?.brand).toBe('HARLEY DAVIDSON');
  });

  it('incluye las motos añadidas a mano (Cyclone)', () => {
    expect(parseBikeLabel('CYCLONE RX6 (2025)')).toEqual({ brand: 'CYCLONE', model: 'RX6', year: '2025' });
    // Año que no existe para ese modelo: se queda sin año (todas las versiones).
    expect(parseBikeLabel('CYCLONE RX6 (2019)')).toEqual({ brand: 'CYCLONE', model: 'RX6', year: '' });
  });

  it('motos que no están en el catálogo', () => {
    expect(parseBikeLabel('MARCAINVENTADA X1 (2020)')).toBeNull();
    expect(parseBikeLabel('HONDA MODELOINVENTADO (2020)')).toBeNull();
    expect(parseBikeLabel('')).toBeNull();
  });

  it('bikeLabel es la inversa', () => {
    expect(bikeLabel('CYCLONE', 'RX6', '2025')).toBe('CYCLONE RX6 (2025)');
    expect(parseBikeLabel(bikeLabel('HONDA', 'PCX 125', '2022'))).toEqual({ brand: 'HONDA', model: 'PCX 125', year: '2022' });
  });
});
