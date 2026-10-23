import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('./cache.js', () => ({ cacheBust: vi.fn(async () => {}) }));
vi.mock('../chatbot/minimax.js', () => ({ minimaxClient: {}, CHAT_MODEL: 'test' }));

const { buildFacts, supported, renderDescription, readCatalogRecords, worthDescribing } = await import('./attribute-descriptions.js');

const rec = {
  PartNumber: '3026777', Title: 'Kit de cadena AFAM 520XRR3 14/50 Reforzado - corona ultraligero', HtmlDescription: '', CountryOfOrigin: 'IT',
  SalesCategories: [{ Name: 'Kits de transmisión por cadena' }], VehicleUniverses: [{ Name: 'OFFROAD' }],
  Attributes: [{ Name: 'Uso', Value: 'Off-Road' }, { Name: 'Eslabón de conexión', Value: 'Clip' }, { Name: 'Material de la corona', Value: 'Aluminio' }],
  BillOfMaterials: [{ Amount: 1, PartNumber: 'C1' }, { Amount: 1, PartNumber: 'X9' }],
};
const titles = new Map([['c1', 'Cadena AFAM 520XRR3 118 eslabones']]);
const facts = buildFacts({ name: 'Kit de cadena AFAM 520XRR3 14/50 Reforzado - corona ultraligero · Ref. 3026777', brand: 'AFAM', category: 'Chasis', attributes: { Uso: 'Off-Road' } }, rec, titles);

describe('datos del producto', () => {
  it('junta categoría, uso, atributos, piezas del kit y origen del catálogo', () => {
    expect(facts.categoria).toBe('Kits de transmisión por cadena');
    expect(facts.uso).toEqual(['off-road']);
    expect(facts.datos).toEqual([['Uso', 'Off-Road'], ['Eslabón de conexión', 'Clip'], ['Material de la corona', 'Aluminio']]);
    expect(facts.incluye).toEqual([[1, 'Cadena AFAM 520XRR3 118 eslabones']]);
    expect(facts.origen).toBe('Italia');
    expect(worthDescribing(facts)).toBe(true);
    expect(worthDescribing(buildFacts({ name: 'Tornillo', brand: 'X', category: 'Frenos', attributes: {} }, undefined, titles))).toBe(false);
  });
});

describe('párrafo de la IA', () => {
  const ok = 'Kit de cadena AFAM 520XRR3 reforzado para off-road: piñón de 14 dientes y corona de 50 dientes de aluminio, con eslabón de conexión de clip.';
  it('acepta lo que se apoya en los datos', () => {
    expect(supported(ok, facts)).toBe(true);
  });
  it('rechaza cifras, materiales, homologaciones o publicidad que no están en los datos', () => {
    expect(supported(ok.replace('50 dientes', '52 dientes'), facts)).toBe(false);
    expect(supported(`${ok} Corona de titanio.`, facts)).toBe(false);
    expect(supported(`${ok} Homologado para carretera.`, facts)).toBe(false);
    expect(supported(`${ok} La mejor opción del mercado.`, facts)).toBe(false);
    expect(supported(`${ok} Distribuido por Bihr.`, facts)).toBe(false);
  });
  it('no confunde palabras corrientes con afirmaciones («ofrece» no es «ECE»)', () => {
    expect(supported(`${ok} Ofrece un montaje sencillo.`, facts)).toBe(true);
  });
});

describe('HTML de la descripción', () => {
  it('añade los datos técnicos que la ficha no enseña y las piezas del kit', () => {
    const html = renderDescription('Kit de cadena <reforzado>.', facts);
    expect(html).toBe('<p>Kit de cadena &lt;reforzado&gt;.</p><p><strong>Datos técnicos</strong></p><ul><li><strong>Eslabón de conexión:</strong> Clip</li><li><strong>Material de la corona:</strong> Aluminio</li></ul><p><strong>Incluye</strong></p><ul><li>1 × Cadena AFAM 520XRR3 118 eslabones</li></ul>');
  });
});

describe('lectura del catálogo', () => {
  it('lee cada producto entero (con listas anidadas) y el título de todos', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'attr-test-'));
    const file = path.join(dir, 'p.json');
    await fs.promises.writeFile(file, JSON.stringify({ Groups: [{ Products: [rec, { PartNumber: 'C1', Title: 'Cadena', GenericProduct: { PartNumber: 'G', Variations: [{ PartNumber: 'V' }] } }] }] }, null, 2));
    const { records, titles: t } = await readCatalogRecords(file, new Set(['3026777']));
    await fs.promises.rm(dir, { recursive: true, force: true });
    expect([...records.keys()]).toEqual(['3026777']);
    expect(records.get('3026777')?.Attributes?.length).toBe(3);
    expect(t.get('c1')).toBe('Cadena');
    expect(t.has('v')).toBe(false);
  });
});
