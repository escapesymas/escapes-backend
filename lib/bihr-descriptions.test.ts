import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('./cache.js', () => ({ cacheBust: vi.fn(async () => {}) }));

const { cleanDescription, decodeEntities, looksEnglish, readDescriptions, textOf } = await import('./bihr-descriptions.js');

describe('limpieza del HTML del proveedor', () => {
  it('deja solo etiquetas de texto sin atributos y pasa las entidades a letras', () => {
    const html = '<p style="color:red">Protecci&oacute;n <a href="https://x.com">total</a><img src="a.jpg"></p><script>alert(1)</script><UL><LI>Uno</LI></UL>';
    expect(cleanDescription(html)).toBe('<p>Protección total</p><ul><li>Uno</li></ul>');
  });

  it('convierte títulos y negritas, y quita bloques vacíos y saltos de más', () => {
    expect(cleanDescription('<h2>Ficha</h2><p><br /></p><b>Material</b>: acero<br><br><br><br>Fin'))
      .toBe('<p><strong>Ficha</strong></p><strong>Material</strong>: acero<br><br>Fin');
  });

  it('quita las frases que nombran al proveedor', () => {
    const out = cleanDescription('<p>Pastillas sinterizadas. Distribuido por BIHR en Europa. Para uso en carretera.</p><li>Marca Bihr</li>');
    expect(out).not.toMatch(/bihr/i);
    expect(textOf(out)).toBe('Pastillas sinterizadas. Para uso en carretera.');
  });

  it('escapa lo que podría ser HTML dentro del texto', () => {
    expect(cleanDescription('<p>Diámetro &lt;script&gt; &amp; 5 &#8364;</p>')).toBe('<p>Diámetro &lt;script&gt; &amp; 5 €</p>');
    expect(decodeEntities('&#x2013; &desconocida;')).toBe('– &desconocida;');
  });
});

describe('idioma', () => {
  it('detecta el inglés y no confunde el español', () => {
    expect(looksEnglish('Brake calliper piston kit For superior quality reconditioning Includes all pistons required for the particular application')).toBe(true);
    expect(looksEnglish('Sintered brake pads, high performance')).toBe(true);
    expect(looksEnglish('Kit de cadena compuesto por cadena estándar y piñón de acero')).toBe(false);
    expect(looksEnglish('Corona de acero para la moto, the best')).toBe(false);
  });
});

describe('lectura del catálogo', () => {
  it('asigna cada descripción a su referencia principal y no a las variantes', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'desc-test-'));
    const file = path.join(dir, 'p.json');
    const catalog = { Products: [
      { PartNumber: 'A1', Title: 'Uno', HtmlDescription: '<p>Descripción "uno"</p>', GenericProduct: { PartNumber: 'G1', Variations: [{ PartNumber: 'V1' }] } },
      { PartNumber: 'B2', Title: 'Dos' },
      { PartNumber: 'C3', HtmlDescription: '<p>Tres</p>' },
    ] };
    await fs.promises.writeFile(file, JSON.stringify(catalog, null, 2));
    const map = await readDescriptions(file);
    await fs.promises.rm(dir, { recursive: true, force: true });
    expect([...map.entries()]).toEqual([['a1', '<p>Descripción "uno"</p>'], ['c3', '<p>Tres</p>']]);
  });
});
