import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../bihrService.js', () => ({ getBihrToken: vi.fn() }));
vi.mock('./cache.js', () => ({ cacheBust: vi.fn() }));
vi.mock('./bihr-live-stock.js', async (orig) => ({ ...(await orig<typeof import('./bihr-live-stock.js')>()), refreshLiveBihrStock: vi.fn() }));

import { readCatalogStatus, readStocks, readStockDetails, planStockSync, planDiscontinued, DISCONTINUED_STATUS, type CatalogStatus } from './bihr-discontinued.js';

const tmp = (name: string, content: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bihr-test-')), name);
  fs.writeFileSync(f, content);
  return f;
};

describe('lectura de los catálogos v3', () => {
  it('saca los descatalogados (con su referencia antigua) y los vigentes', async () => {
    const f = tmp('p.json', JSON.stringify({ Groups: [{ Families: [{ Segments: [{ Brands: [{ Products: [
      { PartNumber: '1000001', Title: 'Vigente', IsDiscontinued: false, GenericProduct: { PartNumber: '1000' } },
      { PartNumber: '8005496', OldPartNumber: '801000350168', Name: 'Casco', IsDiscontinued: true, UpdateDateTime: 'x' },
      { PartNumber: '8005497', OldPartNumber: '', Name: 'Casco M', IsDiscontinued: true },
    ] }] }] }] }] }, null, 2));
    const st = await readCatalogStatus(f);
    expect(Object.fromEntries(st.main)).toEqual({ '1000001': false, '1000': false, '8005496': true, '8005497': true });
    expect([...st.oldDiscontinued]).toEqual(['801000350168']);
  });

  it('lee el stock de cada referencia', async () => {
    const f = tmp('s.json', JSON.stringify({ Stocks: [{ PartNumber: '1000000', Value: 7, UpdateDateTime: 'x' }, { PartNumber: 'ABC', Value: 0 }] }, null, 2));
    const stocks = await readStocks(f);
    expect(Object.fromEntries(stocks)).toEqual({ '1000000': 7, abc: 0 });
  });
});

describe('qué ocultar y qué recuperar', () => {
  const status: CatalogStatus = {
    total: 6,
    main: new Map([['d1', true], ['d2', true], ['d4', true], ['ok5', false], ['1156486', false], ['1099187', true]]),
    oldDiscontinued: new Set(['old3']),
  };
  const stocks = new Map([['d1', 0], ['d2', 5], ['d4', 0], ['ok5', 0]]);
  const rows = [
    { id: 1, sku: 'S1', part_number: 'D1', status: 'published' }, // descatalogado sin stock -> se oculta
    { id: 2, sku: 'S2', part_number: 'D2', status: 'published' }, // descatalogado con stock -> se sigue vendiendo
    { id: 3, sku: 'OLD3', part_number: '', status: 'published' }, // solo por la referencia antigua, sin stock -> se oculta
    { id: 4, sku: 'S4', part_number: 'D4', status: 'draft' }, // borrador: no se toca
    { id: 5, sku: 'S5', part_number: 'OK5', status: DISCONTINUED_STATUS }, // Bihr lo reactivó -> vuelve
    { id: 6, sku: 'S6', part_number: 'D2', status: DISCONTINUED_STATUS }, // le entró stock -> vuelve
    { id: 7, sku: 'S7', part_number: 'D1', status: DISCONTINUED_STATUS }, // sigue igual -> se queda oculto
    { id: 8, sku: '1099187', part_number: '1156486', status: 'published' }, // renumerado: la referencia actual está vigente
    { id: 9, sku: '1099187', part_number: '1156486', status: DISCONTINUED_STATUS }, // ocultado por error -> vuelve
  ];
  it('oculta solo los descatalogados sin stock en Bihr, manda la referencia actual y recupera los reactivados', () => {
    expect(planDiscontinued(rows, status, stocks)).toEqual({ hide: [1, 3], restore: [5, 6, 9], keptWithStock: 1 });
  });
});

describe('stock y reaprovisionamiento del catálogo «Stocks»', () => {
  const f = () => tmp('s2.json', JSON.stringify({ Stocks: [
    { PartNumber: '1078960', Value: 0, ForecastAvailabilityDateTime: '2026-12-21T00:00:00.0000000', UpdateDateTime: 'x' },
    { PartNumber: '1000000', Value: 7, UpdateDateTime: 'x' },
    { PartNumber: '1000002', Value: 0, UpdateDateTime: 'x' },
  ] }, null, 2));

  it('lee la fecha prevista solo de quien la tiene', async () => {
    const d = await readStockDetails(f());
    expect(Object.fromEntries(d)).toEqual({
      '1078960': { value: 0, forecast: '2026-12-21' },
      '1000000': { value: 7, forecast: null },
      '1000002': { value: 0, forecast: null },
    });
  });

  it('calcula qué cambia: usa la referencia de Bihr, no toca lo que ya coincide y cuenta los que se agotan', async () => {
    const d = await readStockDetails(f());
    const plan = planStockSync([
      { id: 1, sku: '30400041', part_number: '1078960', stock: 39, restock_date: null }, // Bihr: 0 y reaprovisionando -> cambia
      { id: 2, sku: '1000000', part_number: '1000000', stock: 7, restock_date: null },   // coincide -> no cambia
      { id: 3, sku: 'X3', part_number: '1000002', stock: 0, restock_date: null },        // coincide -> no cambia
      { id: 4, sku: '1000000', part_number: null, stock: 0, restock_date: null },        // sin part_number: por sku -> le entra stock
      { id: 5, sku: 'PROPIO', part_number: 'zzz', stock: 5, restock_date: null },        // no es de Bihr -> se deja
      { id: 6, sku: 'S6', part_number: '1078960', stock: 0, restock_date: '2026-12-01' },// solo cambia la fecha
    ], d);
    expect(plan).toEqual({ ids: [1, 4, 6], stocks: [0, 7, 0], dates: ['2026-12-21', '', '2026-12-21'], matched: 5, toZero: 1, fromZero: 1 });
  });
});
