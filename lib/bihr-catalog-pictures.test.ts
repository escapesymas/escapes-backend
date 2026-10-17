import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mainPictureUrl, urlMatchesCode, parseCatalogPictures, readCatalogPictures, loadCatalogPictures } from './bihr-catalog-pictures.js';

const URL1 = 'https://api.mybihr.com/medias/1008253-1-800Wx800H?context=abc';
const URL2 = 'https://api.mybihr.com/medias/1008254-1-800Wx800H?context=def';

const catalog = {
  References: [
    { ProductCode: '1008253', ProductName: 'A', DefaultPicture: URL1 },
    { ProductCode: ' 1008254 ', DefaultPicture: ` ${URL2} ` },
    { ProductCode: '1008255', DefaultPicture: '' },
    { ProductCode: '1008256', Picture1: 'https://api.mybihr.com/medias/1008256-1-800Wx800H?context=ghi' },
    { ProductCode: '1008258', DefaultPicture: 'https://api.mybihr.com/medias/sin-imagen-800Wx800H?context=zzz' },
    { ProductCode: '1008259', DefaultPicture: URL1 },
    { ProductCode: '1008257', DefaultPicture: 'no-es-un-enlace' },
    { ProductCode: '', DefaultPicture: URL2 },
  ],
};

describe('enlaces de foto del catálogo de Bihr', () => {
  it('toma DefaultPicture (o Picture1) solo si es un enlace', () => {
    expect(mainPictureUrl({ DefaultPicture: URL1, Picture1: URL2 })).toBe(URL1);
    expect(mainPictureUrl({ DefaultPicture: ' ' + URL1 + ' ' })).toBe(URL1);
    expect(mainPictureUrl({ Picture1: URL2 })).toBe(URL2);
    expect(mainPictureUrl({ DefaultPicture: 'x', Picture1: '' })).toBeUndefined();
    expect(mainPictureUrl(null)).toBeUndefined();
  });

  it('solo acepta enlaces cuyo fichero lleva el código del producto (no una foto genérica ni la de otra pieza)', () => {
    expect(urlMatchesCode(URL1, '1008253')).toBe(true);
    expect(urlMatchesCode('https://api.mybihr.com/medias/800Wx800H-1008253-1.jpg', '1008253')).toBe(true);
    expect(urlMatchesCode('https://api.mybihr.com/medias/B02-6-1-800Wx800H?context=x', 'B02-6')).toBe(true);
    expect(urlMatchesCode('https://api.mybihr.com/medias/1008253-1-800Wx800H', '1008254')).toBe(false);
    expect(urlMatchesCode('https://api.mybihr.com/medias/10082531-1-800Wx800H', '1008253')).toBe(false);
    expect(urlMatchesCode('https://api.mybihr.com/medias/sin-imagen-800Wx800H', '1008253')).toBe(false);
    expect(urlMatchesCode('no es un enlace', '1008253')).toBe(false);
    expect(urlMatchesCode('https://api.mybihr.com/medias/A.B-1-800Wx800H', 'A.B')).toBe(true);
    expect(urlMatchesCode('https://api.mybihr.com/medias/AxB-1-800Wx800H', 'A.B')).toBe(false);
  });

  it('cuenta las referencias, guarda el enlace de cada código y dice qué campos de foto hay', () => {
    const r = parseCatalogPictures(JSON.stringify(catalog));
    expect(r.refs).toBe(8);
    expect(r.withPictures).toBe(6);
    expect(r.unmatched).toBe(2);
    expect([...r.urls]).toEqual([['1008253', URL1], ['1008254', URL2], ['1008256', 'https://api.mybihr.com/medias/1008256-1-800Wx800H?context=ghi']]);
    expect(r.pictureFields).toEqual(['DefaultPicture', 'Picture1']);
  });

  it('con `wanted` guarda solo esos códigos pero sigue contando todo el catálogo', () => {
    const r = parseCatalogPictures(JSON.stringify({ Products: catalog.References }), new Set(['1008254']));
    expect([...r.urls]).toEqual([['1008254', URL2]]);
    expect(r.withPictures).toBe(6);
  });

  it('un catálogo sin lista de referencias da cero, no un error', () => {
    expect(parseCatalogPictures('{}')).toMatchObject({ refs: 0, withPictures: 0, pictureFields: [] });
  });

  it('lee el fichero y anota cuándo se guardó; sin fichero no hay catálogo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bihr-cat-'));
    const file = path.join(dir, 'catalogo.json');
    fs.writeFileSync(file, JSON.stringify(catalog));
    const r = readCatalogPictures(file, new Set(['1008253']));
    expect([...r.urls]).toEqual([['1008253', URL1]]);
    expect(r.modifiedAt).toBe(fs.statSync(file).mtime.toISOString());
    expect(await loadCatalogPictures(undefined, path.join(dir, 'no-existe.json'))).toBeNull();
  });
});
