import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// BD simulada: cada prueba deja en `db` la ficha que devuelve el SELECT y mira qué UPDATE se hizo.
const db = vi.hoisted(() => ({ product: null as any, clash: false, clashQueries: 0, contestedRows: [] as any[], updateRows: 1, updates: [] as any[][] }));

vi.mock('../db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.includes('GROUP BY')) return { rows: db.contestedRows };
      if (sql.includes('regexp_replace')) { db.clashQueries++; return { rows: db.clash ? [{ '?column?': 1 }] : [] }; }
      if (sql.startsWith('SELECT id, sku')) return { rows: db.product ? [db.product] : [] };
      if (sql.startsWith('UPDATE products')) { db.updates.push(params); return { rowCount: db.updateRows, rows: [] }; }
      return { rows: [] };
    }),
  },
}));

// El procesador aislado real necesita su socket: aquí solo devuelve algo reconocible.
const sandbox = vi.hoisted(() => ({ fail: false }));
vi.mock('./image-sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./image-sandbox.js')>()),
  processImage: vi.fn(async (buf: Buffer, o: { width: number }) => {
    if (sandbox.fail) throw new Error('sandbox caído');
    return { data: Buffer.from(`webp-${o.width}-${buf.length}`) };
  }),
}));

import { readZipIndex, readZipEntry, zipPhotosFor, repairProductImages, contestedFileBases } from './bihr-images.js';

interface ZipFile { name: string; data: Buffer; store?: boolean; declaredSize?: number; crc?: number }

/** Zip mínimo con las longitudes del cabezal local a 0 (como cuando hay «data descriptor»). */
function buildZip(files: ZipFile[], eocd: { entries?: number; cdOffset?: number } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const body = f.store ? f.data : zlib.deflateRawSync(f.data);
    const method = f.store ? 0 : 8;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(name.length, 26);
    parts.push(lfh, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE((f.crc ?? (zlib as any).crc32(f.data)) >>> 0, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.declaredSize ?? f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(eocd.entries ?? files.length, 8);
  end.writeUInt16LE(eocd.entries ?? files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(eocd.cdOffset ?? offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

const JPG = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, n)]);

const zips: Record<string, { body: Buffer; ignoreRange?: boolean }> = {
  '/SCOTT-pictures.zip': { body: buildZip([
    { name: '8010897003-1.jpg', data: JPG(1) },
    { name: '8010897003-2.jpg', data: JPG(2), store: true },
    { name: '8010897003-3.jpg', data: JPG(3) },
    { name: '80108970030-1.jpg', data: JPG(9) },
    { name: 'OTRA-1.jpg', data: JPG(7) },
  ]) },
  // Mismos ficheros en otro orden: sirve para simular un zip que Bihr ha vuelto a generar.
  '/SCOTT-nuevo.zip': { body: buildZip([
    { name: 'OTRA-1.jpg', data: JPG(7) },
    { name: '80108970030-1.jpg', data: JPG(9) },
    { name: '8010897003-3.jpg', data: JPG(3) },
    { name: '8010897003-2.jpg', data: JPG(2), store: true },
    { name: '8010897003-1.jpg', data: JPG(1) },
  ]) },
  '/CRC-pictures.zip': { body: buildZip([{ name: 'MAL-1.jpg', data: JPG(6), crc: 12345 }]) },
  '/pequeno.zip': { ignoreRange: true, body: buildZip([{ name: 'A-1.jpg', data: JPG(4) }, { name: 'C-1.jpg', data: JPG(5) }]) },
  '/bomba.zip': { body: buildZip([{ name: 'BOMB-1.jpg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * 1024 * 1024)]), declaredSize: 300 }]) },
  '/crc.zip': { body: buildZip([{ name: 'MAL-1.jpg', data: JPG(6), crc: 12345 }]) },
  '/zip64.zip': { body: buildZip([{ name: 'A-1.jpg', data: JPG(4) }], { cdOffset: 0xffffffff }) },
  '/muchos.zip': { body: buildZip([{ name: 'A-1.jpg', data: JPG(4) }, { name: 'B-1.jpg', data: JPG(5) }], { entries: 0xffff }) },
};

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/gone.zip' || req.url === '/GONE-pictures.zip') { res.statusCode = 404; return res.end(); }
    if (req.url === '/sin-range.zip') { res.setHeader('Content-Length', 5 * 1024 * 1024); return res.end(Buffer.alloc(5 * 1024 * 1024)); }
    if (req.url === '/salto.zip') { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.2:1/x.zip'); return res.end(); }
    const zip = zips[req.url || ''];
    if (!zip) { res.statusCode = 404; return res.end(); }
    if (zip.ignoreRange) return res.end(zip.body);
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (!m) { res.statusCode = 400; return res.end(); }
    const len = zip.body.length;
    const start = m[1] === '' ? Math.max(0, len - Number(m[2])) : Number(m[1]);
    const end = m[1] === '' ? len - 1 : Math.min(len - 1, m[2] === '' ? len - 1 : Number(m[2]));
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${len}`);
    res.end(zip.body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

describe('zipPhotosFor', () => {
  const file = (name: string) => ({ name, offset: 0, compSize: 0, uncompSize: 0, crc32: 0 });

  it('busca por código sin distinguir mayúsculas, con carpetas y códigos con guiones o puntos', () => {
    const files = [file('fotos/80-108.97-1.JPG'), file('80-108.97-2.jpeg'), file('ABC-1-2.jpg'), file('ABC-1.jpg'), file('ABC-3.png'), file('ABC-1.jpg.bak'), file('Abc-1.jpg')];
    expect([...zipPhotosFor(files, '80-108.97').keys()]).toEqual([1, 2]);
    expect(zipPhotosFor(files, '80-108.97').get(1)?.name).toBe('fotos/80-108.97-1.JPG');
    expect([...zipPhotosFor(files, 'abc').keys()]).toEqual([1]);
    expect(zipPhotosFor(files, 'ABC').get(1)?.name).toBe('ABC-1.jpg'); // si hay dos con el mismo número, la primera
    expect([...zipPhotosFor(files, 'ABC-1').keys()]).toEqual([2]);
    expect(zipPhotosFor(files, 'A.C').size).toBe(0);
    expect(zipPhotosFor(files, '').size).toBe(0);
  });
});

describe('zip de fotos de Bihr por rangos', () => {
  it('lista los ficheros y encuentra las fotos de una referencia sin confundir otras', async () => {
    const files = await readZipIndex(`${base}/SCOTT-pictures.zip`);
    expect(files.map((f) => f.name)).toContain('8010897003-2.jpg');
    const photos = zipPhotosFor(files, '8010897003');
    expect([...photos.keys()].sort()).toEqual([1, 2, 3]);
    expect(zipPhotosFor(files, '80108970030').size).toBe(1);
    expect(zipPhotosFor(files, '8010897').size).toBe(0);
  });

  it('descomprime ficheros deflate y almacenados aunque el cabezal local tenga tamaño 0', async () => {
    const url = `${base}/SCOTT-pictures.zip`;
    const photos = zipPhotosFor(await readZipIndex(url), '8010897003');
    expect((await readZipEntry(url, photos.get(1)!)).equals(JPG(1))).toBe(true);
    expect((await readZipEntry(url, photos.get(2)!)).equals(JPG(2))).toBe(true);
    expect((await readZipEntry(url, photos.get(3)!)).equals(JPG(3))).toBe(true);
  });

  it('no se baja el zip entero si el servidor ignora Range', async () => {
    await expect(readZipIndex(`${base}/sin-range.zip`)).rejects.toThrow('no admite Range');
  });

  it('informa del código HTTP cuando el zip de la marca no existe', async () => {
    await expect(readZipIndex(`${base}/gone.zip`)).rejects.toThrow('HTTP 404');
  });

  it('si el servidor ignora Range en un zip pequeño, recorta el trozo pedido (no devuelve la foto equivocada)', async () => {
    const url = `${base}/pequeno.zip`;
    const photos = zipPhotosFor(await readZipIndex(url), 'C');
    expect((await readZipEntry(url, photos.get(1)!)).equals(JPG(5))).toBe(true);
  });

  it('rechaza una foto que al descomprimirse es mucho mayor de lo que declara el zip', async () => {
    const url = `${base}/bomba.zip`;
    const photos = zipPhotosFor(await readZipIndex(url), 'BOMB');
    await expect(readZipEntry(url, photos.get(1)!)).rejects.toThrow('más grande de lo que dice el zip');
  });

  it('rechaza una foto cuyo CRC no coincide con el índice', async () => {
    const url = `${base}/crc.zip`;
    const photos = zipPhotosFor(await readZipIndex(url), 'MAL');
    await expect(readZipEntry(url, photos.get(1)!)).rejects.toThrow('CRC');
  });

  it('avisa de que un zip ZIP64 no se puede leer, en vez de devolver un índice vacío', async () => {
    await expect(readZipIndex(`${base}/zip64.zip`)).rejects.toThrow('ZIP64');
  });

  it('con el contador del final a 0xFFFF lista todos los ficheros', async () => {
    expect((await readZipIndex(`${base}/muchos.zip`)).map((f) => f.name)).toEqual(['A-1.jpg', 'B-1.jpg']);
  });

  it('detecta que el zip ha cambiado desde que se leyó el índice', async () => {
    const photos = zipPhotosFor(await readZipIndex(`${base}/SCOTT-pictures.zip`), '8010897003');
    await expect(readZipEntry(`${base}/SCOTT-nuevo.zip`, photos.get(1)!)).rejects.toThrow('ha cambiado');
  });

  it('no sigue redirecciones a otros servidores', async () => {
    await expect(readZipIndex(`${base}/salto.zip`)).rejects.toThrow('no permitida');
  });
});

describe('reparar las fotos de un producto', () => {
  let uploads: string;
  const product = (over: Record<string, any> = {}) => {
    const images = over.images === undefined ? null : over.images;
    return { id: 244141, sku: '8010897003', name: 'Gafas SCOTT', brand: 'scott', part_number: '8010897003', supplier_code: null,
      images, images_raw: images === null ? null : JSON.stringify(images), ...over };
  };
  const repair = () => repairProductImages(244141, { zipBase: base, uploadsDir: uploads });

  beforeEach(() => {
    uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'bihr-repair-'));
    db.product = product();
    db.clash = false;
    db.clashQueries = 0;
    db.contestedRows = [];
    db.updateRows = 1;
    db.updates.length = 0;
    sandbox.fail = false;
    delete process.env.BIHR_USERNAME;
    delete process.env.BIHR_MACKEY;
    // La prueba usa /SCOTT-pictures.zip del servidor de arriba.
  });

  it('baja las fotos del zip, las guarda en local y reescribe la ficha', async () => {
    const r = await repair();
    expect(r.saved).toBe(1);
    expect(r.attempts.some((a) => a.source === 'zip' && a.ok && a.target === '8010897003-1.jpg')).toBe(true);
    expect(fs.readdirSync(path.join(uploads, 'optimized')).sort()).toEqual(
      ['8010897003_0_200.webp', '8010897003_0_400.webp', '8010897003_0_800.webp']);
    expect(db.updates).toHaveLength(1);
    const [id, json, snapshot] = db.updates[0];
    expect(id).toBe(244141);
    expect(snapshot).toBeNull();
    expect(JSON.parse(json)[0]).toMatchObject({ src: '/uploads/optimized/8010897003_0_800.webp', srcCardMobile: '/uploads/optimized/8010897003_0_200.webp', originalUrl: 'zip:8010897003-1' });
  });

  it('completa las fotos que faltan y deja intactas las que ya funcionan', async () => {
    fs.mkdirSync(path.join(uploads, 'optimized'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'optimized', 'buena.webp'), 'x');
    const images = [{ src: '/uploads/optimized/buena.webp', alt: 'ok' }, { src: '', alt: 'vacía' }, { src: '/uploads/optimized/no-existe.webp' }];
    db.product = product({ images });
    const r = await repair();
    expect(r.saved).toBe(2);
    const saved = JSON.parse(db.updates[0][1]);
    expect(saved[0]).toEqual(images[0]);
    expect(saved[1].src).toBe('/uploads/optimized/8010897003_1_800.webp');
    expect(saved[2].src).toBe('/uploads/optimized/8010897003_2_800.webp');
    expect(db.updates[0][2]).toBe(JSON.stringify(images));
  });

  it('no toca nada si todas las fotos de la ficha ya existen', async () => {
    fs.mkdirSync(path.join(uploads, 'optimized'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'optimized', 'buena.webp'), 'x');
    db.product = product({ images: [{ src: '/uploads/optimized/buena.webp' }, { src: 'https://otra-web.example/foto.jpg' }] });
    const r = await repair();
    expect(r.saved).toBe(0);
    expect(r.attempts[0].detail).toContain('nada que descargar');
    expect(db.updates).toHaveLength(0);
  });

  it('entiende una galería guardada como texto JSON y rechaza formatos raros sin escribir', async () => {
    const images = [{ src: '' }];
    db.product = product({ images: JSON.stringify(images), images_raw: JSON.stringify(JSON.stringify(images)) });
    expect((await repair()).saved).toBe(1);
    db.product = product({ images: { raro: true }, images_raw: '{"raro":true}' });
    await expect(repair()).rejects.toThrow('formato');
  });

  it('si la ficha cambia mientras se descargaba, no pisa los cambios', async () => {
    db.updateRows = 0;
    await expect(repair()).rejects.toThrow('cambió mientras');
  });

  it('usa otro nombre de fichero si otro producto da el mismo SKU saneado', async () => {
    db.clash = true;
    await repair();
    expect(fs.readdirSync(path.join(uploads, 'optimized'))).toContain('8010897003_id244141_0_800.webp');
  });

  it('si el procesador falla con la primera foto, no cambia la ficha ni deja temporales', async () => {
    sandbox.fail = true;
    const r = await repair();
    expect(r.saved).toBe(0);
    expect(db.updates).toHaveLength(0);
    expect(fs.existsSync(path.join(uploads, 'optimized')) ? fs.readdirSync(path.join(uploads, 'optimized')) : []).toEqual([]);
  });

  it('cuando ninguna fuente tiene la foto cuenta qué contestó cada una', async () => {
    db.product = product({ brand: 'gone', images: [] });
    const r = await repair();
    expect(r.saved).toBe(0);
    expect(r.attempts.find((a) => a.source === 'zip')?.detail).toBe('HTTP 404');
    expect(r.attempts.find((a) => a.source === 'api')?.detail).toContain('credenciales');
    expect(db.updates).toHaveLength(0);
  });
  it('dice qué pasó: guardada, nada que hacer, la fuente no la tiene o la fuente falló', async () => {
    expect((await repair()).outcome).toBe('saved');
    fs.mkdirSync(path.join(uploads, 'optimized'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'optimized', 'buena.webp'), 'x');
    db.product = product({ images: [{ src: '/uploads/optimized/buena.webp' }] });
    expect((await repair()).outcome).toBe('nothing_to_do');
    db.product = product({ sku: 'NOESTA', part_number: 'NOESTA' });
    const missing = await repair();
    expect(missing).toMatchObject({ saved: 0, outcome: 'not_found' });
    db.product = product({ brand: 'gone', images: [] });
    expect((await repair()).outcome).toBe('not_found'); // la marca no tiene zip (HTTP 404): no es un fallo
    db.product = product({ brand: 'crc', sku: 'MAL', part_number: 'MAL' });
    expect((await repair()).outcome).toBe('error'); // la foto del zip está dañada
    sandbox.fail = true;
    db.product = product();
    expect((await repair()).outcome).toBe('error'); // el procesador de imágenes no responde
  });

  it('un producto sin marca no tiene zip que mirar y se dice', async () => {
    db.product = product({ brand: null });
    const r = await repair();
    expect(r.outcome).toBe('not_found');
    expect(r.attempts.find((a) => a.source === 'zip')?.detail).toContain('no tiene marca');
  });

  it('con sources solo prueba esas fuentes', async () => {
    db.product = product({ sku: 'NOESTA', part_number: 'NOESTA', images: [] });
    const zipOnly = await repairProductImages(244141, { zipBase: base, uploadsDir: uploads, sources: ['zip'] });
    expect(new Set(zipOnly.attempts.map((a) => a.source))).toEqual(new Set(['zip']));
    const apiOnly = await repairProductImages(244141, { zipBase: base, uploadsDir: uploads, sources: ['api'] });
    expect(apiOnly.attempts.map((a) => a.source)).toEqual(['api']);
    const all = await repair();
    expect(new Set(all.attempts.map((a) => a.source))).toEqual(new Set(['zip', 'api']));
  });

  it('con exactCodes no usa el código del fabricante (otra pieza podría tener ese número)', async () => {
    db.product = product({ sku: 'XXX', part_number: 'XXX', supplier_code: 'OTRA' });
    const exact = await repairProductImages(244141, { zipBase: base, uploadsDir: uploads, sources: ['zip'], exactCodes: true });
    expect(exact.outcome).toBe('not_found');
    expect(db.updates).toHaveLength(0);
    const loose = await repairProductImages(244141, { zipBase: base, uploadsDir: uploads, sources: ['zip'] });
    expect(loose.saved).toBe(1);
    expect(loose.attempts.some((a) => a.target === 'OTRA-1.jpg')).toBe(true);
  });

  it('con la lista de nombres repetidos ya calculada no consulta la tabla por cada producto', async () => {
    await repairProductImages(244141, { zipBase: base, uploadsDir: uploads, contested: new Set() });
    expect(db.clashQueries).toBe(0);
    expect(fs.readdirSync(path.join(uploads, 'optimized'))).toContain('8010897003_0_800.webp');
    await repairProductImages(244141, { zipBase: base, uploadsDir: uploads, contested: new Set(['8010897003']) });
    expect(db.clashQueries).toBe(0);
    expect(fs.readdirSync(path.join(uploads, 'optimized'))).toContain('8010897003_id244141_0_800.webp');
    await repair();
    expect(db.clashQueries).toBe(1);
  });

  it('contestedFileBases lista los nombres de fichero que dan varios productos', async () => {
    db.contestedRows = [{ base: 'AB_C' }, { base: '123' }];
    expect(await contestedFileBases()).toEqual(new Set(['AB_C', '123']));
  });
});
