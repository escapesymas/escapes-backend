import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock('./image-audit.js', () => ({
  getImageAudit: vi.fn(),
  filterAuditItems: vi.fn(),
  invalidateImageAudit: mocks.invalidate,
}));
vi.mock('./bihr-images.js', () => ({ repairProductImages: vi.fn(), contestedFileBases: vi.fn(), bihrProductPictures: vi.fn() }));
vi.mock('./cache.js', () => ({ cacheBust: vi.fn() }));

import { startRepairJob, stopRepairJob, getRepairJobState, orderQueue, RepairJobBusy, type RepairJobDeps } from './image-repair-job.js';
import type { ImageAuditItem } from './image-audit.js';
import type { RepairResult, RepairOutcome } from './bihr-images.js';

const item = (id: number, brand: string, stock = 1): ImageAuditItem => ({
  id, sku: `SKU${id}`, name: `Producto ${id}`, brand, stock, familyCode: '', problem: 'foto_remota', photos: 1, firstSrc: 'api.mybihr.com/x',
});
const result = (outcome: RepairOutcome, detail = 'HTTP 500', errorScope: 'product' | 'service' = 'service'): RepairResult => ({
  saved: outcome === 'saved' ? 1 : 0, outcome,
  attempts: outcome === 'error' ? [{ source: 'zip', target: 'zip', ok: false, detail }] : [],
  ...(outcome === 'error' ? { errorScope, reason: `zip: ${detail}` } : {}),
});

const contested = new Set(['DUP']);

function makeDeps(items: ImageAuditItem[], repair: RepairJobDeps['repair'], over: Partial<RepairJobDeps> = {}): RepairJobDeps & { bust: ReturnType<typeof vi.fn> } {
  return {
    loadItems: vi.fn(async (scope) => (scope === 'stock' ? items.filter((i) => i.stock > 0) : items)),
    contested: vi.fn(async () => contested),
    catalogPictures: vi.fn(async () => null),
    productPictures: vi.fn(async () => new Map<string, string[]>()),
    repair: vi.fn(repair),
    bust: vi.fn(async () => {}),
    freeBytes: vi.fn(async () => 50 * 1024 ** 3),
    ...over,
  } as any;
}

const finished = () => vi.waitFor(() => expect(['done', 'stopped', 'error']).toContain(getRepairJobState().status), { timeout: 5000 });

beforeEach(async () => {
  mocks.invalidate.mockClear();
  // Cualquier trabajo que quedara de otra prueba termina antes de empezar la siguiente.
  stopRepairJob();
  await vi.waitFor(() => expect(['idle', 'done', 'stopped', 'error']).toContain(getRepairJobState().status), { timeout: 5000 });
});

describe('orderQueue', () => {
  it('pone primero los productos con stock y agrupa por marca (las de más productos antes)', () => {
    const q = orderQueue([item(9, 'B', 0), item(1, 'A'), item(2, 'B'), item(3, 'B'), item(4, 'A', 0), item(5, 'C'), item(6, 'B')]);
    expect(q.map((i) => i.id)).toEqual([2, 3, 6, 1, 5, 4, 9]);
  });
});

describe('descarga en bloque', () => {
  it('recorre la cola, cuenta cada resultado y vuelve a pedir la auditoría al acabar', async () => {
    const outcomes: Record<number, RepairOutcome> = { 1: 'saved', 2: 'not_found', 3: 'error', 4: 'nothing_to_do', 5: 'saved' };
    const deps = makeDeps([1, 2, 3, 4, 5].map((id) => item(id, id < 3 ? 'RST' : 'FLY')), async (id) => result(outcomes[id]));
    const started = await startRepairJob({}, deps);
    expect(started.status).toBe('running');
    await finished();
    const s = getRepairJobState();
    expect(s).toMatchObject({ status: 'done', total: 5, done: 5, saved: 2, notFound: 1, failed: 1, skipped: 1, scope: 'stock', useApi: true });
    expect(s.brands.RST).toMatchObject({ total: 2, done: 2, saved: 1, notFound: 1 });
    expect(s.brands.FLY).toMatchObject({ total: 3, done: 3, saved: 1, failed: 1, skipped: 1, lastError: 'zip: HTTP 500' });
    expect(s.recentErrors).toEqual([{ id: 3, sku: 'SKU3', brand: 'FLY', message: 'zip: HTTP 500' }]);
    expect(deps.repair).toHaveBeenCalledWith(1, { sources: ['detalles', 'catalogo', 'zip'], exactCodes: true, contested, detailsLookup: expect.any(Function), refreshStaleIndex: false });
    expect(deps.bust).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(s.finishedAt).toBeTruthy();
    expect(s.message).toBeUndefined();
  });

  it('sin API usa los enlaces que ya se conocen y el zip de la marca, y «todos» incluye los agotados al final', async () => {
    const order: number[] = [];
    const deps = makeDeps([item(1, 'A', 0), item(2, 'A', 5)], async (id) => { order.push(id); return result('not_found'); });
    await startRepairJob({ scope: 'all', useApi: false, concurrency: 1 }, deps);
    await finished();
    expect(order).toEqual([2, 1]);
    expect(deps.repair).toHaveBeenCalledWith(2, { sources: ['catalogo', 'zip'], exactCodes: true, contested, detailsLookup: expect.any(Function), refreshStaleIndex: false });
    expect(deps.bust).not.toHaveBeenCalled(); // no se guardó ninguna foto
    expect(getRepairJobState()).toMatchObject({ scope: 'all', useApi: false, notFound: 2 });
  });

  it('usa los enlaces del catálogo de Bihr guardado y cuenta las fotos que salen de enlaces', async () => {
    const urls = new Map([['SKU1', 'https://api.mybihr.com/medias/SKU1-1-800Wx800H?context=x']]);
    const catalog = { urls, refs: 10, withPictures: 8, unmatched: 1, pictureFields: ['DefaultPicture'], modifiedAt: '2026-10-10T00:00:00.000Z' };
    const viaLink: RepairResult = { saved: 1, outcome: 'saved', attempts: [{ source: 'catalogo', target: 'api.mybihr.com/medias/SKU1-1-800Wx800H (catálogo de Bihr)', ok: true, detail: '45150 bytes' }] };
    const deps = makeDeps([item(1, 'V PARTS'), item(2, 'V PARTS')], async (id) => (id === 1 ? viaLink : result('saved')), { catalogPictures: vi.fn(async () => catalog) });
    await startRepairJob({ concurrency: 1 }, deps);
    await finished();
    expect(deps.catalogPictures).toHaveBeenCalledWith(['SKU1', 'SKU2']);
    expect(deps.repair).toHaveBeenCalledWith(1, { sources: ['detalles', 'catalogo', 'zip'], exactCodes: true, contested, catalogUrls: urls, detailsLookup: expect.any(Function), refreshStaleIndex: false });
    expect(getRepairJobState()).toMatchObject({
      status: 'done', saved: 2, savedFromLinks: 1,
      catalog: { modifiedAt: '2026-10-10T00:00:00.000Z', refs: 10, withPictures: 8, unmatched: 1, forQueue: 1, pictureFields: ['DefaultPicture'] },
    });
    expect(getRepairJobState().message).toBeUndefined();
  });

  it('si el catálogo guardado no se puede leer, sigue con zip y API y lo dice al acabar', async () => {
    const deps = makeDeps([item(1, 'A')], async () => result('saved'), { catalogPictures: vi.fn(async () => { throw new Error('memoria'); }) });
    await startRepairJob({}, deps);
    await finished();
    const s = getRepairJobState();
    expect(s).toMatchObject({ status: 'done', saved: 1, catalog: null });
    expect(s.message).toContain('No se pudo leer el catálogo de Bihr guardado (memoria)');
    expect(deps.repair).toHaveBeenCalledWith(1, { sources: ['detalles', 'catalogo', 'zip'], exactCodes: true, contested, detailsLookup: expect.any(Function), refreshStaleIndex: false });
  });

  it('sin catálogo guardado usa solo los enlaces de las fichas', async () => {
    const deps = makeDeps([item(1, 'A')], async () => result('not_found'));
    await startRepairJob({}, deps);
    await finished();
    expect(getRepairJobState()).toMatchObject({ status: 'done', catalog: null, message: undefined });
  });

  describe('Products/Details por tandas', () => {
    const urlsFor = (sku: string) => [`https://api.mybihr.com/medias/800Wx800H-${sku}-1.jpg?context=x`];

    it('pide los productos de la cola de 20 en 20 y reparte los enlaces a cada uno', async () => {
      const items = Array.from({ length: 45 }, (_, i) => item(i + 1, 'V PARTS'));
      const productPictures = vi.fn(async (codes: string[]) => new Map(codes.map((c) => [c.toLowerCase(), urlsFor(c)])));
      const seen = new Map<number, readonly string[]>();
      const deps = makeDeps(items, async (id, opts) => {
        seen.set(id, await opts.detailsLookup!([`SKU${id}`]));
        return result('saved');
      }, { productPictures });
      await startRepairJob({ concurrency: 3 }, deps);
      await finished();
      expect(getRepairJobState()).toMatchObject({ status: 'done', saved: 45 });
      expect(productPictures).toHaveBeenCalledTimes(3);
      expect(productPictures.mock.calls.map((c) => c[0].length).sort((a, b) => b - a)).toEqual([20, 20, 5]);
      expect(seen.get(1)).toEqual(urlsFor('SKU1'));
      expect(seen.get(45)).toEqual(urlsFor('SKU45'));
    });

    it('si Bihr no trae fotos de un producto devuelve una lista vacía sin llamar otra vez', async () => {
      const productPictures = vi.fn(async () => new Map<string, string[]>());
      let got: readonly string[] | undefined;
      const deps = makeDeps([item(1, 'A')], async (_id, opts) => { got = await opts.detailsLookup!(['SKU1']); return result('not_found'); }, { productPictures });
      await startRepairJob({}, deps);
      await finished();
      expect(got).toEqual([]);
      expect(productPictures).toHaveBeenCalledTimes(1);
    });

    it('si falla la llamada de una tanda, todos sus productos reciben el error y no se repite', async () => {
      const productPictures = vi.fn(async () => { throw new Error('HTTP 401'); });
      const errors: string[] = [];
      const deps = makeDeps([item(1, 'A'), item(2, 'A'), item(3, 'A')], async (_id, opts) => {
        try { await opts.detailsLookup!(['x']); } catch (e: any) { errors.push(e.message); }
        return result('not_found');
      }, { productPictures });
      await startRepairJob({ concurrency: 1 }, deps);
      await finished();
      expect(errors).toEqual(['HTTP 401', 'HTTP 401', 'HTTP 401']);
      expect(productPictures).toHaveBeenCalledTimes(1);
    });

    it('un código que no iba en la tanda (número de pieza distinto del SKU) se pide aparte', async () => {
      const productPictures = vi.fn(async (codes: string[]) => new Map(codes.filter((c) => c === 'PN-1').map((c) => [c.toLowerCase(), urlsFor(c)])));
      let got: readonly string[] | undefined;
      const deps = makeDeps([item(1, 'A')], async (_id, opts) => { got = await opts.detailsLookup!(['PN-1', 'SKU1']); return result('saved'); }, { productPictures });
      await startRepairJob({}, deps);
      await finished();
      expect(got).toEqual(urlsFor('PN-1'));
      expect(productPictures.mock.calls.map((c) => c[0])).toEqual([['SKU1'], ['PN-1']]);
    });
  });

  it('solo hay un trabajo a la vez y se puede lanzar otro cuando acaba', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps = makeDeps([item(1, 'A')], async () => { await gate; return result('saved'); });
    await startRepairJob({}, deps);
    await expect(startRepairJob({}, deps)).rejects.toBeInstanceOf(RepairJobBusy);
    release();
    await finished();
    await startRepairJob({}, makeDeps([], async () => result('saved')));
    await finished();
    expect(getRepairJobState()).toMatchObject({ status: 'done', total: 0, message: undefined });
  });

  it('se puede parar: acaba el producto en curso y no coge más', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps = makeDeps(Array.from({ length: 10 }, (_, i) => item(i + 1, 'A')), async () => { await gate; return result('saved'); });
    await startRepairJob({ concurrency: 2 }, deps);
    await vi.waitFor(() => expect(deps.repair).toHaveBeenCalledTimes(2));
    expect(stopRepairJob().status).toBe('stopping');
    release();
    await finished();
    expect(getRepairJobState()).toMatchObject({ status: 'stopped', done: 2, saved: 2, total: 10, message: 'Parado a petición' });
    expect(deps.repair).toHaveBeenCalledTimes(2);
  });

  it('deja la marca cuyo zip falla 5 veces seguidas y sigue con las demás', async () => {
    const items = [...Array.from({ length: 8 }, (_, i) => item(100 + i, 'MALA')), item(1, 'BUENA'), item(2, 'BUENA')];
    const deps = makeDeps(items, async (id) => (id >= 100 ? result('error', 'sin respuesta a tiempo') : result('saved')));
    await startRepairJob({ concurrency: 1 }, deps);
    await finished();
    const s = getRepairJobState();
    expect(s.status).toBe('done');
    expect(s.brands.MALA).toMatchObject({ done: 8, failed: 5, skipped: 3, gaveUp: true });
    expect(s.brands.BUENA).toMatchObject({ saved: 2 });
    expect(s.brands.BUENA.gaveUp).toBeUndefined();
    expect(deps.repair).toHaveBeenCalledTimes(7);
    // No acaba como si nada: dice qué marca se quedó a medias.
    expect(s.message).toBe('Terminado, pero se dejó a medias la marca MALA por fallos seguidos. Vuelve a lanzar la descarga para reintentarlas.');
  });

  describe('caídas de la API de Bihr', () => {
    // Lo que devuelve la ficha cuando Products/Details (o pedir el token) no responde.
    const outage = (): RepairResult => ({
      saved: 0, outcome: 'error', errorScope: 'service', reason: 'detalles: sin respuesta a tiempo',
      attempts: [{ source: 'detalles', target: 'Products/Details', ok: false, detail: 'sin respuesta a tiempo' }],
    });

    it('espera y reintenta el mismo producto sin dejar la marca, y vuelve a pedir la tanda', async () => {
      const items = Array.from({ length: 8 }, (_, i) => item(i + 1, 'RST'));
      let calls = 0;
      const productPictures = vi.fn(async () => new Map<string, string[]>());
      const deps = makeDeps(items, async (id, opts) => {
        await opts.detailsLookup!([`SKU${id}`]);
        return ++calls <= 6 ? outage() : result('saved'); // Bihr no responde las 6 primeras veces
      }, { productPictures, outageWaitsMs: [0, 0, 0, 0, 0, 0, 0] });
      await startRepairJob({ concurrency: 1 }, deps);
      await finished();
      const s = getRepairJobState();
      expect(s).toMatchObject({ status: 'done', saved: 8, failed: 0, skipped: 0, message: undefined });
      expect(s.brands.RST.gaveUp).toBeUndefined();
      expect(deps.repair).toHaveBeenCalledTimes(14);
      expect(productPictures).toHaveBeenCalledTimes(7); // cada reintento vuelve a pedir la tanda
    });

    it('si Bihr sigue sin responder cuenta el fallo para parar el trabajo, pero no deja la marca', async () => {
      const items = Array.from({ length: 6 }, (_, i) => item(i + 1, 'RST'));
      const deps = makeDeps(items, async () => outage(), { outageWaitsMs: [0, 0] });
      await startRepairJob({ concurrency: 1 }, deps);
      await finished();
      const s = getRepairJobState();
      expect(s.brands.RST).toMatchObject({ done: 6, failed: 6, skipped: 0 });
      expect(s.brands.RST.gaveUp).toBeUndefined();
      expect(deps.repair).toHaveBeenCalledTimes(18); // 1 + 2 reintentos por producto
    });

    it('un fallo al descargar la foto del CDN (no de la API) sigue contando para dejar la marca', async () => {
      const cdnFail = (): RepairResult => ({
        saved: 0, outcome: 'error', errorScope: 'service', reason: 'detalles: sin respuesta a tiempo',
        attempts: [{ source: 'detalles', target: 'api.mybihr.com/medias/x.jpg', ok: false, detail: 'sin respuesta a tiempo' }],
      });
      const deps = makeDeps(Array.from({ length: 7 }, (_, i) => item(i + 1, 'MALA')), async () => cdnFail(), { outageWaitsMs: [0] });
      await startRepairJob({ concurrency: 1 }, deps);
      await finished();
      expect(getRepairJobState().brands.MALA).toMatchObject({ failed: 5, skipped: 2, gaveUp: true });
      expect(deps.repair).toHaveBeenCalledTimes(5);
    });
  });

  it('una foto dañada de un producto no cuenta para dejar la marca ni para parar el trabajo', async () => {
    const deps = makeDeps(Array.from({ length: 60 }, (_, i) => item(i + 1, 'A')), async () => result('error', 'la foto del zip está dañada (CRC)', 'product'));
    await startRepairJob({ concurrency: 1 }, deps);
    await finished();
    const s = getRepairJobState();
    expect(s).toMatchObject({ status: 'done', done: 60, failed: 60, skipped: 0, message: undefined });
    expect(s.brands.A.gaveUp).toBeUndefined();
    expect(deps.repair).toHaveBeenCalledTimes(60);
    expect(s.recentErrors.at(-1)?.message).toBe('zip: la foto del zip está dañada (CRC)');
  });

  it('si se para mientras carga la lista no empieza ni toca la auditoría', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps = makeDeps([item(1, 'A')], async () => result('saved'), { loadItems: vi.fn(async () => { await gate; return [item(1, 'A')]; }) });
    await startRepairJob({}, deps);
    expect(stopRepairJob().status).toBe('stopping');
    release();
    await finished();
    expect(getRepairJobState()).toMatchObject({ status: 'stopped', done: 0, total: 0, message: 'Parado a petición' });
    expect(deps.repair).not.toHaveBeenCalled();
    expect(deps.contested).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('se para solo tras 40 fallos seguidos de marcas distintas', async () => {
    const deps = makeDeps(Array.from({ length: 80 }, (_, i) => item(i + 1, `M${i}`)), async () => result('error', 'el procesador no responde'));
    await startRepairJob({ concurrency: 1 }, deps);
    await finished();
    const s = getRepairJobState();
    expect(s.status).toBe('error');
    expect(s.message).toBe('Se paró tras 40 fallos seguidos; último: zip: el procesador no responde');
    expect(s.done).toBe(40);
    expect(s.recentErrors).toHaveLength(20);
  });

  it('un acierto corta la racha de fallos', async () => {
    const deps = makeDeps(Array.from({ length: 90 }, (_, i) => item(i + 1, `M${i}`)), async (id) => (id % 30 === 0 ? result('saved') : result('error')));
    await startRepairJob({ concurrency: 1 }, deps);
    await finished();
    expect(getRepairJobState()).toMatchObject({ status: 'done', done: 90, saved: 3, failed: 87 });
  });

  it('se para si queda poco disco', async () => {
    const deps = makeDeps(Array.from({ length: 100 }, (_, i) => item(i + 1, 'A')), async () => result('saved'), { freeBytes: vi.fn(async () => 1024 ** 3) });
    await startRepairJob({ concurrency: 1 }, deps);
    await finished();
    const s = getRepairJobState();
    expect(s.status).toBe('error');
    expect(s.message).toContain('1.0 GB libres');
    expect(s.done).toBe(25);
    expect(deps.bust).toHaveBeenCalled(); // lo que se guardó hasta entonces se ve en la tienda
  });

  it('los avisos de la ficha no cuentan como fallos de la descarga', async () => {
    const deps = makeDeps(Array.from({ length: 50 }, (_, i) => item(i + 1, 'A')), async (id) => {
      if (id % 2) throw new Error('El producto no tiene SKU');
      throw new Error('Ya se están descargando las fotos de este producto');
    });
    await startRepairJob({ concurrency: 1 }, deps);
    await finished();
    expect(getRepairJobState()).toMatchObject({ status: 'done', done: 50, failed: 25, skipped: 25 });
  });

  it('un error al cargar la lista deja el trabajo en «error» con el motivo', async () => {
    const deps = makeDeps([], async () => result('saved'), { loadItems: vi.fn(async () => { throw new Error('No se puede leer la carpeta de fotos'); }) });
    await startRepairJob({}, deps);
    await finished();
    expect(getRepairJobState()).toMatchObject({ status: 'error', message: 'No se puede leer la carpeta de fotos' });
  });

  it('vacía las cachés cada 200 productos con foto nueva y una vez más al acabar', async () => {
    const deps = makeDeps(Array.from({ length: 450 }, (_, i) => item(i + 1, 'A')), async () => result('saved'));
    await startRepairJob({ concurrency: 1 }, deps);
    await finished();
    expect(getRepairJobState().saved).toBe(450);
    expect(deps.bust).toHaveBeenCalledTimes(3); // a los 200, a los 400 y al acabar (50 más)
  });
});
