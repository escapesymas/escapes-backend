import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { fetchRemoteImage, REMOTE_IMAGE_HEADERS } from './remote-image.js';

let server: http.Server;
let base = '';

beforeAll(async () => {
  // Como el CDN de Bihr: 403 si no llega una cabecera de navegador.
  server = http.createServer((req, res) => {
    if (req.url === '/gone') { res.statusCode = 404; return res.end('nope'); }
    if (req.headers['user-agent'] !== REMOTE_IMAGE_HEADERS['User-Agent']) { res.statusCode = 403; return res.end('blocked'); }
    res.setHeader('Content-Type', 'image/png');
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

describe('fetchRemoteImage', () => {
  it('descarga con la cabecera de navegador y devuelve el tipo', async () => {
    const { data, mime } = await fetchRemoteImage(`${base}/ok.png`, 5_000);
    expect(mime).toBe('image/png');
    expect(data.length).toBe(4);
  });

  it('incluye el código HTTP cuando falla', async () => {
    await expect(fetchRemoteImage(`${base}/gone`, 5_000)).rejects.toThrow('No se pudo descargar la imagen (404)');
  });
});
