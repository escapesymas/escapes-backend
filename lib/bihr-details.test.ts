import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Products/Details (API v3 de Bihr). Como la API de las fotos, tiene estado propio (token, ritmo, pausa): módulo limpio en cada prueba.
vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

let bihrProductPictures: typeof import('./bihr-images.js').bihrProductPictures;

const pic = (code: string, n: number, isDefault = false) => ({ isDefault, url: `https://api.mybihr.com/medias/800Wx800H-${code}-${n}.jpg?context=c${n}` });
const detail = (code: string, extra: Record<string, any> = {}) => ({
  partNumber: code, oldPartNumber: code, name: 'Pieza',
  pictures: [pic(code, 2), pic(code, 1, true), pic(code, 3)],
  ...extra,
});

let calls: { url: string; init: any }[];
let respond: (body: any) => Response;
let tokens: number;

beforeEach(async () => {
  vi.resetModules();
  ({ bihrProductPictures } = await import('./bihr-images.js'));
  process.env.BIHR_USERNAME = 'user';
  process.env.BIHR_MACKEY = 'key';
  calls = [];
  tokens = 0;
  respond = () => new Response('[]', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
    const url = String(input);
    if (url.endsWith('/Authentication/Token')) { tokens++; return new Response(JSON.stringify({ access_token: `t${tokens}`, expires_in: 3600 }), { status: 200 }); }
    calls.push({ url, init });
    return respond(JSON.parse(init.body));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BIHR_USERNAME;
  delete process.env.BIHR_MACKEY;
});

describe('Products/Details de Bihr', () => {
  it('pide los productos de una vez y devuelve las fotos de cada uno con la principal primero', async () => {
    respond = () => new Response(JSON.stringify([detail('1008253'), detail('1008254')]), { status: 200 });
    const found = await bihrProductPictures(['1008253', '1008254', '1008253', ' ']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.bihr.net/api/v3/Products/Details');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer t1', 'Content-Type': 'application/json' });
    expect(JSON.parse(calls[0].init.body)).toEqual({ productCriteria: [{ partNumber: '1008253' }, { partNumber: '1008254' }], language: 'es' });
    expect(found.get('1008253')!.map((u) => /-(\d)\.jpg/.exec(u)![1])).toEqual(['1', '2', '3']);
    expect([...found.keys()]).toEqual(['1008253', '1008254']);
  });

  it('entiende un producto suelto o una lista dentro de un objeto (products, items, result…)', async () => {
    respond = () => new Response(JSON.stringify(detail('1008253')), { status: 200 });
    expect((await bihrProductPictures(['1008253'])).has('1008253')).toBe(true);
    respond = () => new Response(JSON.stringify({ products: [detail('1008253')] }), { status: 200 });
    expect((await bihrProductPictures(['1008253'])).has('1008253')).toBe(true);
    respond = () => new Response(JSON.stringify({ total: 1, result: [detail('1008253')] }), { status: 200 });
    expect((await bihrProductPictures(['1008253'])).has('1008253')).toBe(true);
  });

  it('encuentra el producto también por su número de pieza antiguo', async () => {
    respond = () => new Response(JSON.stringify([detail('1110696001', { oldPartNumber: 'ANTIGUO-7' , pictures: [{ isDefault: true, url: 'https://api.mybihr.com/medias/800Wx800H-ANTIGUO-7-1.jpg?context=x' }] })]), { status: 200 });
    const found = await bihrProductPictures(['antiguo-7']);
    expect(found.get('antiguo-7')).toHaveLength(1);
  });

  it('descarta los enlaces de otros dominios o de otra pieza, y los productos que no se pidieron', async () => {
    respond = () => new Response(JSON.stringify([
      detail('1008253', { pictures: [
        { isDefault: true, url: 'https://otra-web.example/medias/800Wx800H-1008253-1.jpg' },
        { isDefault: false, url: 'http://api.mybihr.com/medias/800Wx800H-1008253-2.jpg' },
        { isDefault: false, url: 'https://api.mybihr.com/medias/800Wx800H-9999999-1.jpg?context=otra' },
        pic('1008253', 4),
      ] }),
      detail('5555555'),
      detail('1008254', { pictures: [] }),
    ]), { status: 200 });
    const found = await bihrProductPictures(['1008253', '1008254']);
    expect([...found.keys()]).toEqual(['1008253']);
    expect(found.get('1008253')).toEqual([pic('1008253', 4).url]);
  });

  it('un 404 es «Bihr no conoce esos productos»: sin fotos y sin pausar la API', async () => {
    respond = () => new Response('', { status: 404 });
    for (let i = 0; i < 6; i++) expect((await bihrProductPictures(['X'])).size).toBe(0);
    respond = () => new Response(JSON.stringify([detail('X')]), { status: 200 });
    expect((await bihrProductPictures(['X'])).has('x')).toBe(true);
  }, 20_000);

  it('si el token está revocado pide otro y repite la llamada una vez', async () => {
    let n = 0;
    respond = () => (++n === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify([detail('1008253')]), { status: 200 }));
    expect((await bihrProductPictures(['1008253'])).has('1008253')).toBe(true);
    expect(tokens).toBe(2);
    expect(calls.map((c) => c.init.headers.Authorization)).toEqual(['Bearer t1', 'Bearer t2']);
  }, 10_000);

  it('un error de Bihr se cuenta con su código y el principio de lo que contesta', async () => {
    respond = () => new Response('{"error":"too many criteria"}', { status: 400 });
    await expect(bihrProductPictures(['1', '2'])).rejects.toThrow('HTTP 400: {"error":"too many criteria"}');
  });

  it('una respuesta que no es JSON se dice', async () => {
    respond = () => new Response('<html>', { status: 200 });
    await expect(bihrProductPictures(['1'])).rejects.toThrow('la respuesta no es JSON');
  });

  it('sin credenciales no llama a la API y lo dice', async () => {
    delete process.env.BIHR_USERNAME;
    await expect(bihrProductPictures(['1'])).rejects.toThrow('sin credenciales de la API de Bihr');
    expect(calls).toHaveLength(0);
  });

  it('sin códigos no llama a la API', async () => {
    expect((await bihrProductPictures([' ', ''])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
