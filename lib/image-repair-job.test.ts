import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock('./image-audit.js', () => ({
  getImageAudit: vi.fn(),
  filterAuditItems: vi.fn(),
  invalidateImageAudit: mocks.invalidate,
}));
vi.mock('./bihr-images.js', () => ({ repairProductImages: vi.fn(), contestedFileBases: vi.fn() }));
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
    expect(deps.repair).toHaveBeenCalledWith(1, { sources: ['catalogo', 'zip', 'api'], exactCodes: true, contested, refreshStaleIndex: false });
    expect(deps.bust).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(s.finishedAt).toBeTruthy();
    expect(s.message).toBeUndefined();
  });

  it('sin API usa solo el zip, y «todos» incluye los agotados al final', async () => {
    const order: number[] = [];
    const deps = makeDeps([item(1, 'A', 0), item(2, 'A', 5)], async (id) => { order.push(id); return result('not_found'); });
    await startRepairJob({ scope: 'all', useApi: false, concurrency: 1 }, deps);
    await finished();
    expect(order).toEqual([2, 1]);
    expect(deps.repair).toHaveBeenCalledWith(2, { sources: ['catalogo', 'zip'], exactCodes: true, contested, refreshStaleIndex: false });
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
    expect(deps.repair).toHaveBeenCalledWith(1, { sources: ['catalogo', 'zip', 'api'], exactCodes: true, contested, catalogUrls: urls, refreshStaleIndex: false });
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
    expect(deps.repair).toHaveBeenCalledWith(1, { sources: ['catalogo', 'zip', 'api'], exactCodes: true, contested, refreshStaleIndex: false });
  });

  it('sin catálogo guardado usa solo los enlaces de las fichas', async () => {
    const deps = makeDeps([item(1, 'A')], async () => result('not_found'));
    await startRepairJob({}, deps);
    await finished();
    expect(getRepairJobState()).toMatchObject({ status: 'done', catalog: null, message: undefined });
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
