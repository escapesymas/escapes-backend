import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  INDEXNOW_KEY,
  INDEXNOW_HOST,
  INDEXNOW_KEY_LOCATION,
  INDEXNOW_ENDPOINT,
  submitIndexNowUrls,
} from './indexnow.js';

describe('IndexNow Protocol Integration', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('cuenta con claves y endpoint válidos según especificación', () => {
    expect(INDEXNOW_KEY).toBe('e9a4f682d3c1482098d5781a5a04e4c2');
    expect(INDEXNOW_HOST).toBe('escapesymas.com');
    expect(INDEXNOW_KEY_LOCATION).toBe(
      'https://escapesymas.com/e9a4f682d3c1482098d5781a5a04e4c2.txt'
    );
    expect(INDEXNOW_ENDPOINT).toBe('https://api.indexnow.org/IndexNow');
  });

  it('no realiza peticiones si la lista de URLs está vacía', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const res = await submitIndexNowUrls([]);
    expect(res).toEqual({ ok: true, submittedCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normaliza rutas relativas, deduplica y descarta dominios externos', async () => {
    let capturedBody: any = null;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        status: 200,
        statusText: 'OK',
        text: async () => 'OK',
      } as any;
    });

    const res = await submitIndexNowUrls([
      '/escapes/yamaha/mt-07',
      'https://escapesymas.com/escapes/yamaha/mt-07', // duplicada
      'escapes/kawasaki/z-900', // sin barra inicial
      'https://google.com/spam', // dominio externo -> descartar
      'https://otrodominio.es/escapes', // dominio externo -> descartar
      'https://www.escapesymas.com/marcas/ixil', // www -> normalizar a escapesymas.com
    ]);

    expect(res.ok).toBe(true);
    expect(res.submittedCount).toBe(3);
    expect(capturedBody).toEqual({
      host: 'escapesymas.com',
      key: 'e9a4f682d3c1482098d5781a5a04e4c2',
      keyLocation: 'https://escapesymas.com/e9a4f682d3c1482098d5781a5a04e4c2.txt',
      urlList: [
        'https://escapesymas.com/escapes/yamaha/mt-07',
        'https://escapesymas.com/escapes/kawasaki/z-900',
        'https://escapesymas.com/marcas/ixil',
      ],
    });
  });

  it('acepta respuestas HTTP 202 (Accepted) de IndexNow', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 202,
      statusText: 'Accepted',
      text: async () => 'Accepted',
    } as any);

    const res = await submitIndexNowUrls(['/marcas']);
    expect(res.ok).toBe(true);
    expect(res.statusCode).toBe(202);
    expect(res.submittedCount).toBe(1);
  });

  it('gestiona respuestas de error HTTP de la API de IndexNow', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 422,
      statusText: 'Unprocessable Entity',
      text: async () => 'Invalid key location',
    } as any);

    const res = await submitIndexNowUrls(['/marcas']);
    expect(res.ok).toBe(false);
    expect(res.submittedCount).toBe(0);
    expect(res.statusCode).toBe(422);
    expect(res.error).toContain('IndexNow HTTP 422: Invalid key location');
  });

  it('gestiona excepciones de red de forma segura', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network connection timeout'));

    const res = await submitIndexNowUrls(['/marcas']);
    expect(res.ok).toBe(false);
    expect(res.submittedCount).toBe(0);
    expect(res.error).toBe('Network connection timeout');
  });
});
