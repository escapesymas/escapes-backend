import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// La API de Bihr tiene su propio estado (ritmo, pausa tras fallos): se prueba aparte, en su propio módulo.
const db = vi.hoisted(() => ({ product: null as any, updates: [] as any[][] }));

vi.mock('../db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith('SELECT id, sku')) return { rows: db.product ? [db.product] : [] };
      if (sql.startsWith('UPDATE products')) { db.updates.push(params); return { rowCount: 1, rows: [] }; }
      return { rows: [] };
    }),
  },
}));
vi.mock('./image-sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./image-sandbox.js')>()),
  processImage: vi.fn(async (buf: Buffer, o: { width: number }) => ({ data: Buffer.from(`webp-${o.width}-${buf.length}`) })),
}));

let repairProductImages: typeof import('./bihr-images.js').repairProductImages;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]);
let uploads: string;
let imageCalls: { code: string; at: number }[];
let imageStatus: (n: number) => number;

const product = (code: string) => ({
  id: 7, sku: code, name: 'Pieza', brand: null, part_number: code, supplier_code: null, images: [], images_raw: '[]',
});
const repair = (sources: ('api')[] = ['api']) => repairProductImages(7, { uploadsDir: uploads, sources, exactCodes: true });

beforeEach(async () => {
  // La API de Bihr guarda estado (ritmo, cuenta de fallos, pausa): cada prueba empieza con el módulo limpio.
  vi.resetModules();
  ({ repairProductImages } = await import('./bihr-images.js'));
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'bihr-api-'));
  process.env.BIHR_USERNAME = 'user';
  process.env.BIHR_MACKEY = 'key';
  db.updates.length = 0;
  imageCalls = [];
  imageStatus = () => 200;
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input);
    if (url.endsWith('/Authentication/Token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    const code = decodeURIComponent(url.split('/Products/Image/')[1]);
    imageCalls.push({ code, at: Date.now() });
    const status = imageStatus(imageCalls.length);
    return status === 200 ? new Response(JPEG, { status: 200 }) : new Response('no', { status });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(uploads, { recursive: true, force: true });
  delete process.env.BIHR_USERNAME;
  delete process.env.BIHR_MACKEY;
});

describe('API de Bihr', () => {
  it('guarda la foto que da la API', async () => {
    db.product = product('1047724');
    const r = await repair();
    expect(r).toMatchObject({ saved: 1, outcome: 'saved' });
    expect(imageCalls.map((c) => c.code)).toEqual(['1047724']);
    expect(db.updates).toHaveLength(1);
  });

  it('espacia las llamadas al menos 250 ms para no recibir 429, aunque lleguen a la vez', async () => {
    db.product = product('A');
    imageStatus = () => 404;
    await Promise.all([7, 8, 9].map((id) => repairProductImages(id, { uploadsDir: uploads, sources: ['api'], exactCodes: true })));
    expect(imageCalls).toHaveLength(3);
    const times = imageCalls.map((c) => c.at);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(240);
  }, 15_000);

  it('si la API contesta 429 espera y vuelve a probar', async () => {
    db.product = product('1047724');
    imageStatus = (n) => (n === 1 ? 429 : 200);
    const r = await repair();
    expect(r).toMatchObject({ saved: 1, outcome: 'saved' });
    expect(imageCalls).toHaveLength(2);
    expect(imageCalls[1].at - imageCalls[0].at).toBeGreaterThanOrEqual(950);
  }, 15_000);

  it('un 404 es «no tengo esa foto» y no pausa la API; cinco fallos de verdad sí', async () => {
    db.product = product('X');
    imageStatus = () => 404;
    for (let i = 0; i < 6; i++) {
      const r = await repair();
      expect(r.outcome).toBe('not_found');
      expect(r.attempts.find((a) => a.source === 'api')?.detail).toBe('HTTP 404');
    }
    expect(imageCalls).toHaveLength(6);

    imageStatus = () => 500;
    imageCalls.length = 0;
    for (let i = 0; i < 5; i++) await repair();
    expect(imageCalls).toHaveLength(5);

    // Pausada: ya no se llama a la API y se dice por qué.
    const paused = await repair();
    expect(imageCalls).toHaveLength(5);
    expect(paused.attempts.find((a) => a.source === 'api')?.detail).toContain('se vuelve a probar en unos minutos');
    expect(paused).toMatchObject({ outcome: 'error', errorScope: 'service' }); // la API caída no es «no tiene la foto»
  }, 20_000);

  it('un 404 demuestra que la API responde: reinicia la cuenta de fallos', async () => {
    db.product = product('Y');
    imageStatus = () => 500;
    for (let i = 0; i < 4; i++) await repair();
    imageStatus = () => 404;
    expect((await repair()).outcome).toBe('not_found');
    imageStatus = () => 500;
    imageCalls.length = 0;
    for (let i = 0; i < 4; i++) await repair();
    expect(imageCalls).toHaveLength(4); // sigue sin estar pausada: no se llegó a cinco seguidos
  }, 20_000);

  it('si Bihr rechaza el acceso se deja de pedir token tras cinco intentos', async () => {
    db.product = product('Z');
    let tokenCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      if (String(input).endsWith('/Authentication/Token')) { tokenCalls++; return new Response('no', { status: 401 }); }
      throw new Error('no debería pedir fotos sin token');
    }));
    for (let i = 0; i < 8; i++) {
      const r = await repair();
      expect(r).toMatchObject({ outcome: 'error', errorScope: 'service' });
    }
    expect(tokenCalls).toBe(5);
  }, 20_000);
});
