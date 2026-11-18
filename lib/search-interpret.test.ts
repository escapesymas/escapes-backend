import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ pool: { query: vi.fn() } }));

import { buildVehicleDictionary, buildCategoryDictionary, interpretTerms, categoriesForTerm, pieces } from './search-interpret.js';
import { searchTerms } from './catalog-query.js';

// Motos y modelos tal como están en las compatibilidades (muestra real de producción).
const models: [string, string][] = [
  ...['BOT 125 E4', 'BOT 50 E4', 'NERVA EXE', 'STORM 125', 'STORM 125 E4', 'STORM S 300', 'STORM-S', 'STORM-T 125', 'STORM-T 125 E4'].map((m) => ['WOTTAN', m] as [string, string]),
  ...['125 GP', '125 GTS', '125 RT', 'RT 125', 'XRS 125', 'ADV 125', 'ALPHA 125'].map((m) => ['MITT', m] as [string, string]),
  ['QJ MOTOR', 'LTR 125'], ['QJ MOTOR', 'SRV 550'], ['QJMOTOR', 'SRT 700'],
  ...['COTA 310', 'COTA 315', 'COTA 315 R', 'COTA 4RT'].map((m) => ['MONTESA', m] as [string, string]),
  ['HONDA', 'SES 125 DYLAN (JF10)'], ['HONDA', 'SES 150 DYLAN'], ['HONDA', 'DYLAND 125'], ['HONDA', 'PCX 125'], ['HONDA', 'SH 125'], ['HONDA', 'SH 150'], ['HONDA', 'CBR 600 RR (PC40)'],
  ['KTM', '690 DUKE'], ['KTM', '390 DUKE'], ['KTM', '125 DUKE'],
];
const vehicles = buildVehicleDictionary(models.map(([brand, model]) => ({ brand, model })));

const categories = buildCategoryDictionary([
  { id: 1, name: 'Cascos', parent_id: null },
  { id: 507, name: 'Frenos', parent_id: null },
  { id: 508, name: 'Pastillas de freno', parent_id: 507 },
  { id: 509, name: 'Discos de freno', parent_id: 507 },
  { id: 402, name: 'Plástica', parent_id: null },
  { id: 413, name: 'Plástica vintage', parent_id: 402 },
  { id: 495, name: 'Escapes', parent_id: null },
  { id: 39, name: 'Caballetes laterales', parent_id: 26 },
  { id: 26, name: 'Chasis', parent_id: null },
]);

const interpret = (search: string) => interpretTerms(searchTerms(search), vehicles, categories);

describe('piezas del texto', () => {
  it('separa símbolos y letras de números', () => {
    expect(pieces('STORM-S')).toEqual(['storm', 's']);
    expect(pieces('315r')).toEqual(['315', 'r']);
    expect(pieces('SES 125 DYLAN (JF10)')).toEqual(['ses', '125', 'dylan']);
  });
});

describe('búsquedas reales sin resultados', () => {
  it('«wottan»: la marca sola enseña todo lo compatible con ella', () => {
    const r = interpret('wottan')!;
    expect(r.vehicle?.label).toBe('WOTTAN');
    expect(r.vehicle?.models).toBeNull();
    expect(r.vehicle?.compat).toEqual(['[{"brand":"WOTTAN"}]']);
    expect(r.restTerms).toEqual([]);
  });

  it('perdona una errata en la marca («wotan», «qmotor»)', () => {
    expect(interpret('wotan')?.vehicle?.label).toBe('WOTTAN');
    expect(interpret('lateral qmotor ltr 125')?.vehicle?.models).toEqual(['LTR 125']);
  });

  it('«escape wottan s2»: la moto se reconoce, el modelo «s2» no (pesa muy poco) y «escape» se busca como pieza', () => {
    const r = interpret('escape wottan s2')!;
    expect(r.vehicle?.label).toBe('WOTTAN');
    expect(r.vehicle?.models).toBeNull();
    expect(r.restTerms).toEqual(['escape', 's2']);
    // «escape» también vale por la categoría Escapes.
    expect(r.categoryTerms.escape).toEqual([495]);
  });

  it('«escape mitt 125 rt»: marca + modelo, y solo queda la pieza', () => {
    const r = interpret('escape mitt 125 rt')!;
    expect(r.vehicle?.models?.sort()).toEqual(['125 RT', 'RT 125']);
    expect(r.vehicle?.compat).toHaveLength(2);
    expect(r.restTerms).toEqual(['escape']);
  });

  it('«lateral qjmotor ltr 125»: junta las dos escrituras de la marca (QJ MOTOR y QJMOTOR)', () => {
    const r = interpret('lateral qjmotor ltr 125')!;
    expect(r.vehicle?.models).toEqual(['LTR 125']);
    expect(r.vehicle?.compat).toEqual(['[{"brand":"QJ MOTOR","model":"LTR 125"}]']);
    expect(r.restTerms).toEqual(['lateral']);
    expect(interpret('lateral qj motor ltr 125')?.vehicle?.models).toEqual(['LTR 125']);
  });

  it('«escape intermedio de montesa cota 315r»: elige el modelo que explica más', () => {
    const r = interpret('escape intermedio de montesa cota 315r')!;
    expect(r.vehicle?.models).toEqual(['COTA 315 R']);
    expect(r.restTerms).toEqual(['escape', 'intermedio']);
  });

  it('«aceite honda dulan»: errata en el modelo → los Dylan (no el Dyland)', () => {
    const r = interpret('aceite honda dulan')!;
    expect(r.vehicle?.models?.sort()).toEqual(['SES 125 DYLAN (JF10)', 'SES 150 DYLAN']);
    expect(r.restTerms).toEqual(['aceite']);
  });
});

describe('cuándo no se interpreta como moto', () => {
  it('una cifra suelta que encaja con muchos modelos no es un modelo: se queda en el texto', () => {
    const many = buildVehicleDictionary(Array.from({ length: 60 }, (_, i) => ({ brand: 'YAMAHA', model: `XYZ ${i} 125` })));
    const r = interpretTerms(searchTerms('yamaha 125'), many, categories)!;
    expect(r.vehicle?.models).toBeNull();
    expect(r.restTerms).toEqual(['125']);
  });

  it('palabras de pieza comunes no se toman por una marca', () => {
    const common = ['escape', 'escapes', 'lateral', 'aceite', 'pastillas', 'freno', 'casco', 'cadena', 'filtro', 'bateria', 'neumatico', 'manillar', 'amortiguador', 'intermedio', 'carenado', 'plastico', 'kit', 'moto'];
    for (const w of common) expect(interpret(w)?.vehicle ?? null).toBeNull();
  });

  it('sin moto ni categoría conocida no interpreta nada', () => {
    expect(interpret('zzzqq xxwy')).toBeNull();
    expect(interpret('')).toBeNull();
  });
});

describe('categorías', () => {
  it('una palabra que es una categoría incluye también sus subcategorías', () => {
    const c = categoriesForTerm('frenos', categories)!;
    expect(c.ids.sort((a, b) => a - b)).toEqual([507, 508, 509]);
    expect(categoriesForTerm('freno', categories)?.ids).toContain(508);
  });

  it('sin moto, una categoría basta para interpretar («plástica»)', () => {
    const r = interpret('plastica')!;
    expect(r.vehicle).toBeNull();
    expect(r.categoryTerms.plastica.sort((a, b) => a - b)).toEqual([402, 413]);
    expect(r.categoryNames[0]).toBe('Plástica');
  });

  it('palabras muy cortas o números no buscan categoría', () => {
    expect(categoriesForTerm('de', categories)).toBeNull();
    expect(categoriesForTerm('125', categories)).toBeNull();
  });
});
