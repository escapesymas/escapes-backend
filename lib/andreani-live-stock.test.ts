import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn() }));
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../db.js', () => ({ pool: db }));
vi.mock('../redis.js', () => ({
  getRedisClient: async () => ({
    mGet: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, o?: { NX?: boolean }) => {
      if (o?.NX && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    del: async (k: string) => { store.delete(k); return 1; },
    incr: async (k: string) => { const n = Number(store.get(k) || 0) + 1; store.set(k, String(n)); return n; },
    expire: async () => 1,
  }),
}));

import { refreshLiveAndreaniStock, andreaniRef, stockFromSearch } from './andreani-live-stock.js';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as any;

/** Respuesta de ApproSearch para una referencia. */
const reply = (reference: string, stock: number, headers: Record<string, string> = { 'x-ratelimit-remaining': '299' }) =>
  fetchMock.mockResolvedValueOnce({
    ok: true, status: 200, headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    json: async () => ({ data: { products: [{ reference: 'OTRA', stock: 99 }, { reference, stock }] } }),
  });

const rows = [
  { id: 1, sku: 'AND-YA 241', supplier_code: 'YA 241', stock: 6 },
  { id: 2, sku: 'AND-P2R229', supplier_code: null, stock: 5 },
];

beforeEach(() => {
  store.clear();
  db.query.mockReset();
  fetchMock.mockReset();
  process.env.APPROSEARCH_API_KEY = 'aps_test_clave_de_prueba';
  delete process.env.ANDREANI_LIVE_STOCK_DISABLED;
});

describe('andreaniRef / stockFromSearch', () => {
  it('usa la referencia del fabricante o la del SKU sin el prefijo y en mayúsculas', () => {
    expect(andreaniRef({ sku: 'AND-ya 241', supplier_code: ' ya 241 ' })).toBe('YA 241');
    expect(andreaniRef({ sku: 'AND-P2R229', supplier_code: null })).toBe('P2R229');
  });

  it('solo vale el producto cuya referencia coincide exactamente', () => {
    const body = { data: { products: [{ reference: 'P2R2290', stock: 7 }, { reference: 'p2r229', stock: 3 }] } };
    expect(stockFromSearch(body, 'P2R229')).toBe(3);
    expect(stockFromSearch(body, 'NOEXISTE')).toBeNull();
    expect(stockFromSearch({ data: {} }, 'P2R229')).toBeNull();
    expect(stockFromSearch({ data: { products: [{ reference: 'X', stock: -4 }] } }, 'X')).toBe(0);
  });
});

describe('refreshLiveAndreaniStock', () => {
  it('pregunta por cada referencia, guarda solo lo que cambia y devuelve el stock', async () => {
    db.query.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [] });
    reply('YA 241', 4);
    reply('P2R229', 5);

    const out = await refreshLiveAndreaniStock([1, 2]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.get(1)).toEqual({ stock: 4, restockDate: null });
    expect(out.get(2)).toEqual({ stock: 5, restockDate: null });
    // Solo cambia el primero (6 → 4); el otro ya coincidía.
    expect(db.query.mock.calls[1][1]).toEqual([[1], [4]]);
  });

  it('no vuelve a preguntar por lo que está en caché', async () => {
    db.query.mockResolvedValue({ rows });
    reply('YA 241', 4); reply('P2R229', 5);
    await refreshLiveAndreaniStock([1, 2]);

    const again = await refreshLiveAndreaniStock([1, 2]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(again.get(1)).toEqual({ stock: 4, restockDate: null });
  });

  it('ignora lo que no es de Andreani y respeta el tope de 24 por llamada', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, sku: `AND-R${i}`, supplier_code: `R${i}`, stock: 1 }));
    db.query.mockResolvedValue({ rows: many });
    fetchMock.mockImplementation(async (url: string) => {
      const ref = decodeURIComponent(String(url).match(/q=([^&]+)/)![1]);
      return { ok: true, status: 200, headers: { get: () => '299' }, json: async () => ({ data: { products: [{ reference: ref, stock: 1 }] } }) };
    });

    const out = await refreshLiveAndreaniStock(many.map((r) => r.id));

    expect(fetchMock).toHaveBeenCalledTimes(24);
    expect(out.size).toBe(24);
  });

  it('si ApproSearch falla no escribe nada (nunca un stock por un error) y deja de preguntar un rato', async () => {
    db.query.mockResolvedValue({ rows });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) });

    const out = await refreshLiveAndreaniStock([1, 2]);

    expect(out.size).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1); // solo la lectura, ningún UPDATE
    expect(store.get('and:stk:breaker')).toBe('1');

    await refreshLiveAndreaniStock([1, 2]);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2); // con el freno puesto no llama más
  });

  it('con la cuota de ApproSearch casi agotada se frena', async () => {
    db.query.mockResolvedValue({ rows });
    reply('YA 241', 4, { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '30' });

    await refreshLiveAndreaniStock([1]);

    expect(store.get('and:stk:breaker')).toBe('1');
  });

  it('respeta el tope de llamadas por minuto', async () => {
    db.query.mockResolvedValue({ rows });
    store.set(`and:stk:min:${Math.floor(Date.now() / 60_000)}`, '90');

    const out = await refreshLiveAndreaniStock([1, 2]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it('las referencias que ApproSearch no devuelve no se vuelven a preguntar', async () => {
    db.query.mockResolvedValue({ rows: [rows[1]] });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => '299' }, json: async () => ({ data: { products: [] } }) });
    await refreshLiveAndreaniStock([2]);
    expect(store.get('and:stk:P2R229')).toBe('x');
  });

  it('sin clave configurada o apagado no hace nada', async () => {
    delete process.env.APPROSEARCH_API_KEY;
    expect((await refreshLiveAndreaniStock([1, 2])).size).toBe(0);
    process.env.APPROSEARCH_API_KEY = 'aps_x';
    process.env.ANDREANI_LIVE_STOCK_DISABLED = 'true';
    expect((await refreshLiveAndreaniStock([1, 2])).size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
