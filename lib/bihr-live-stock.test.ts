import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn() }));
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../db.js', () => ({ pool: db }));
vi.mock('../bihrService.js', () => ({ getBihrToken: vi.fn(async () => 'token') }));
vi.mock('../redis.js', () => ({
  getRedisClient: async () => ({
    mGet: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, o?: { NX?: boolean }) => {
      if (o?.NX && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    incr: async (k: string) => { const n = Number(store.get(k) || 0) + 1; store.set(k, String(n)); return n; },
    expire: async () => 1,
    multi: () => {
      const ops: Array<[string, string]> = [];
      const m = { set: (k: string, v: string) => { ops.push([k, v]); return m; }, exec: async () => { ops.forEach(([k, v]) => store.set(k, v)); return []; } };
      return m;
    },
  }),
}));

import { refreshLiveBihrStock, parseForecast } from './bihr-live-stock.js';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as any;
const bihrReplies = (body: unknown, ok = true, status = 200) =>
  fetchMock.mockResolvedValueOnce({ ok, status, json: async () => body });

// Regulador TECNIUM: en la tienda 39 uds.; Bihr, 0 y reaprovisionando hasta el 21/12.
const rows = [
  { id: 10, part_number: '1078960', stock: 39, restock_date: null },
  { id: 11, part_number: '1012827', stock: 2, restock_date: null },
];

beforeEach(() => {
  store.clear();
  db.query.mockReset();
  fetchMock.mockReset();
});

describe('parseForecast', () => {
  it('se queda con la fecha', () => {
    expect(parseForecast('2026-12-21T00:00:00.0000000')).toBe('2026-12-21');
    expect(parseForecast(null)).toBeNull();
    expect(parseForecast('pronto')).toBeNull();
  });
});

describe('refreshLiveBihrStock', () => {
  it('pregunta a Bihr por lo que no está en caché, en una sola llamada, y guarda solo lo que cambia', async () => {
    db.query.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [] });
    bihrReplies([
      { partNumber: '1078960', value: 0, forecastAvailability: '2026-12-21T00:00:00.0000000' },
      { partNumber: '1012827', value: 2 },
    ]);

    const out = await refreshLiveBihrStock([10, 11]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).productCriteria).toEqual([{ partNumber: '1078960' }, { partNumber: '1012827' }]);
    expect(out.get(10)).toEqual({ stock: 0, restockDate: '2026-12-21' });
    expect(out.get(11)).toEqual({ stock: 2, restockDate: null });
    // Solo se actualiza el regulador (39 → 0); el otro ya coincidía.
    const update = db.query.mock.calls[1];
    expect(update[1]).toEqual([[10], [0], ['2026-12-21']]);
  });

  it('no vuelve a preguntar por lo que está en caché', async () => {
    db.query.mockResolvedValue({ rows });
    bihrReplies([{ partNumber: '1078960', value: 0, forecastAvailability: '2026-12-21T00:00:00' }, { partNumber: '1012827', value: 2 }]);
    await refreshLiveBihrStock([10, 11]);
    store.delete('bihr:stk:gate');

    const again = await refreshLiveBihrStock([10, 11]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.get(10)).toEqual({ stock: 0, restockDate: '2026-12-21' });
  });

  it('si Bihr falla no escribe nada (nunca un 0 por un error) y deja de preguntar un rato', async () => {
    db.query.mockResolvedValue({ rows });
    bihrReplies([], false, 429);

    const out = await refreshLiveBihrStock([10, 11]);

    expect(out.size).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1); // solo la lectura, ningún UPDATE
    expect(store.get('bihr:stk:breaker')).toBe('1');

    store.delete('bihr:stk:gate');
    await refreshLiveBihrStock([10, 11]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // con el freno puesto no llama
  });

  it('no llama más de una vez por segundo', async () => {
    db.query.mockResolvedValue({ rows });
    store.set('bihr:stk:gate', '1');

    const out = await refreshLiveBihrStock([10, 11]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it('respeta el presupuesto diario', async () => {
    db.query.mockResolvedValue({ rows });
    store.set(`bihr:stk:calls:${new Date().toISOString().slice(0, 10)}`, '999999');

    await refreshLiveBihrStock([10, 11]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('las referencias que Bihr no devuelve no se vuelven a preguntar', async () => {
    db.query.mockResolvedValueOnce({ rows: [rows[1]] });
    bihrReplies([]);
    await refreshLiveBihrStock([11]);
    expect(store.get('bihr:stk:1012827')).toBe('x');
  });
});
