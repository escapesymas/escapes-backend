import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import zlib from 'zlib';
import type { AddressInfo } from 'net';
import { readZipIndex, readZipEntry, zipPhotosFor } from './bihr-images.js';

/** Zip mínimo con las longitudes del cabezal local a 0 (como cuando hay «data descriptor»). */
function buildZip(files: { name: string; data: Buffer; store?: boolean }[]): Buffer {
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
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const JPG = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, n)]);
const zip = buildZip([
  { name: '8010897003-1.jpg', data: JPG(1) },
  { name: '8010897003-2.jpg', data: JPG(2), store: true },
  { name: '8010897003-3.jpg', data: JPG(3) },
  { name: '80108970030-1.jpg', data: JPG(9) },
  { name: 'OTRA-1.jpg', data: JPG(7) },
]);

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/gone.zip') { res.statusCode = 404; return res.end(); }
    if (req.url === '/sin-range.zip') { res.setHeader('Content-Length', 5 * 1024 * 1024); return res.end(Buffer.alloc(5 * 1024 * 1024)); }
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (!m) { res.statusCode = 400; return res.end(); }
    const start = m[1] === '' ? Math.max(0, zip.length - Number(m[2])) : Number(m[1]);
    const end = m[1] === '' ? zip.length - 1 : Math.min(zip.length - 1, m[2] === '' ? zip.length - 1 : Number(m[2]));
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${zip.length}`);
    res.end(zip.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

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
});
