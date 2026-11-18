import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../db.js', () => ({ pool: { query: (...a: any[]) => query(...a) } }));
vi.mock('../lib/live-stock.js', () => ({
  refreshLiveStock: vi.fn(async (ids: number[]) => new Map(ids.map((id) => [id, { stock: 3, restockDate: null }]))),
}));
const compatibleSkus = vi.fn(async () => [] as string[]);
vi.mock('../lib/moto-catalog.js', () => ({
  compatibleSkus: (...a: any[]) => (compatibleSkus as any)(...a),
  getCatalogData: () => ({ hierarchy: { YAMAHA: { 'MT-09': {} }, HONDA: { 'PCX 125': {} } } }),
}));

const { parsePageRef, getPageProductContext } = await import('./pageContext.js');

describe('referencia de producto que manda el navegador', () => {
  it('acepta un sku o un id con forma válida', () => {
    expect(parsePageRef({ sku: 'AND-ALMG 608Y' })).toEqual({ sku: 'AND-ALMG 608Y', id: undefined });
    expect(parsePageRef({ id: 42 })).toEqual({ sku: undefined, id: 42 });
    expect(parsePageRef({ sku: ' ABC-123 ', id: 7 })).toEqual({ sku: 'ABC-123', id: 7 });
  });

  it('descarta todo lo demás', () => {
    expect(parsePageRef(null)).toBeNull();
    expect(parsePageRef('ABC')).toBeNull();
    expect(parsePageRef({})).toBeNull();
    expect(parsePageRef({ id: -3 })).toBeNull();
    expect(parsePageRef({ id: 1.5 })).toBeNull();
    expect(parsePageRef({ sku: "x'; DROP TABLE products;--" })).toBeNull();
    expect(parsePageRef({ sku: 'a'.repeat(200) })).toBeNull();
  });
});

describe('ficha del producto de la página', () => {
  const product = (over: Record<string, unknown> = {}) => ({
    id: 10, sku: 'TEC-1', name: 'Escape Tecnium Racing', brand: 'TECNIUM', price: 25000, sale_price: null, promo_price: null,
    stock: 0, description: '<p>Escape de <b>acero</b></p>', compatibility: [{ brand: 'YAMAHA', model: 'MT-09', years: [2021, 2022] }],
    attributes: { Material: 'Acero' }, restock_date: null, ...over,
  });

  beforeEach(() => { query.mockReset(); compatibleSkus.mockReset(); compatibleSkus.mockResolvedValue([]); });

  it('producto que no existe → nada', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getPageProductContext({ sku: 'NOPE' }, null)).toBe('');
  });

  it('un fallo de la base de datos no rompe el chat', async () => {
    query.mockRejectedValue(new Error('boom'));
    expect(await getPageProductContext({ id: 1 }, null)).toBe('');
  });

  it('da precio, stock en vivo y pide la moto si no se conoce', async () => {
    query.mockResolvedValue({ rows: [product()] });
    const t = await getPageProductContext({ sku: 'TEC-1' }, null);
    expect(t).toContain('ESTÁ VIENDO ESTE PRODUCTO');
    expect(t).toContain('250.00 €');
    expect(t).toContain('en stock (3 uds.)');
    expect(t).toContain('NO sabemos la moto del cliente');
    expect(t).not.toContain('<p>');
  });

  it('con la moto conocida y compatible, lo confirma', async () => {
    query.mockResolvedValue({ rows: [product()] });
    compatibleSkus.mockResolvedValue(['TEC-1']);
    const t = await getPageProductContext({ sku: 'TEC-1' }, 'Yamaha MT-09 2022');
    expect(t).toContain('VERIFICADO COMPATIBLE');
  });

  it('con la moto conocida y no compatible, lo dice con claridad', async () => {
    query.mockResolvedValue({ rows: [product()] });
    compatibleSkus.mockResolvedValue(['OTRO-1', 'OTRO-2']);
    const t = await getPageProductContext({ sku: 'TEC-1' }, 'Yamaha MT-09 2022');
    expect(t).toContain('NO figura como compatible');
  });

  it('un producto sin compatibilidades es universal', async () => {
    query.mockResolvedValue({ rows: [product({ compatibility: [] })] });
    const t = await getPageProductContext({ sku: 'TEC-1' }, 'Yamaha MT-09 2022');
    expect(t).toContain('universal');
  });

  it('con precio rebajado enseña el de ahora y el de antes', async () => {
    query.mockResolvedValue({ rows: [product({ sale_price: 20000 })] });
    const t = await getPageProductContext({ sku: 'TEC-1' }, null);
    expect(t).toContain('200.00 € (antes 250.00 €)');
  });
});
