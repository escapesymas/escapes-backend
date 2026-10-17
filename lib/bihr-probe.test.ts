import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkProbeUrl, probeImageUrl } from './bihr-probe.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]);
const URL_OK = 'https://api.mybihr.com/medias/1008253-1-800Wx800H?context=abc';

afterEach(() => vi.unstubAllGlobals());

describe('checkProbeUrl', () => {
  it('solo acepta enlaces https de fotos de Bihr', () => {
    expect(checkProbeUrl(URL_OK)).toHaveProperty('url');
    expect(checkProbeUrl('https://api.mybihr.com/medias/800Wx800H-8006685010-1.jpg')).toHaveProperty('url');
    for (const bad of [undefined, '', '   ', 'no es un enlace', 'http://api.mybihr.com/x.jpg', 'https://evil.com/x.jpg',
      'https://api.mybihr.com.evil.com/x.jpg', 'https://user:pw@api.mybihr.com/x.jpg', 'https://api.mybihr.com:8443/x.jpg',
      'https://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
      expect(checkProbeUrl(bad)).toHaveProperty('error');
    }
  });
});

describe('probeImageUrl', () => {
  it('prueba cuatro formas de pedirla y cuenta lo que contesta cada una, sin seguir redirecciones', async () => {
    const calls: { headers: Record<string, string>; redirect: string }[] = [];
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      if (String(input).endsWith('/cdn-cgi/trace')) return new Response('fl=1\nip=203.0.113.9\nuag=secreto\nloc=DE\nhttp=http/1.1\n', { status: 200 });
      requested.push(String(input));
      calls.push({ headers: init.headers, redirect: init.redirect });
      const browser = /Chrome/.test(init.headers['User-Agent'] || '') && !!init.headers.Referer;
      if (browser) return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg', server: 'cloudflare', 'cf-ray': 'abc-MAD', 'set-cookie': 'secreto=1' } });
      return new Response('Not Found\n<html>', { status: 404, headers: { 'content-type': 'text/html', server: 'cloudflare' } });
    }));
    const probe = await probeImageUrl(new URL(URL_OK));
    expect(probe.url).toBe('api.mybihr.com/medias/1008253-1-800Wx800H'); // sin el context firmado
    expect(probe.results).toHaveLength(6); // las cuatro formas, sin context y la forma corta
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
    expect(probe.results.map((r) => r.status)).toEqual([404, 200, 404, 404, 200, 200]);
    expect(probe.sent).toEqual({ length: URL_OK.length, end: URL_OK.slice(-8) });
    expect(requested.slice(0, 4).every((u) => u === URL_OK)).toBe(true);
    expect(requested[4]).toBe('https://api.mybihr.com/medias/1008253-1-800Wx800H'); // sin context
    expect(requested[5]).toBe('https://api.mybihr.com/medias/800Wx800H-1008253-1.jpg'); // forma corta
    expect(probe.trace).toEqual({ estado: '200', ip: '203.0.113.9', loc: 'DE', http: 'http/1.1' }); // solo las claves útiles
    expect(probe.results[1]).toMatchObject({ isImage: true, contentType: 'image/jpeg', bytes: JPEG.length });
    expect(probe.results[1].headers).toEqual({ server: 'cloudflare', 'cf-ray': 'abc-MAD', 'content-type': 'image/jpeg' }); // sin set-cookie
    expect(probe.results[0]).toMatchObject({ isImage: false, bodyStart: 'Not Found <html>' });
    expect(calls[3].headers).toEqual({}); // la cuarta no manda nada propio
  });

  it('un fallo de red o un tiempo agotado se cuenta en esa variante y no rompe las demás', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      if (n === 1) { const e: any = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; }
      if (n === 2) { const e: any = new Error('x'); e.name = 'TimeoutError'; throw e; }
      return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }));
    const { results } = await probeImageUrl(new URL(URL_OK));
    expect(results.slice(0, 4).map((r) => r.error ?? r.status)).toEqual(['ECONNRESET', 'sin respuesta a tiempo', 200, 200]);
  });

  it('lee como mucho 64 KB de la respuesta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.concat([JPEG, Buffer.alloc(300 * 1024)]), { status: 200, headers: { 'content-type': 'image/jpeg' } })));
    const { results } = await probeImageUrl(new URL(URL_OK));
    expect(results[0].truncated).toBe(true);
    expect(results[0].bytes).toBe(64 * 1024);
    expect(results[0].isImage).toBe(true);
  });
});
