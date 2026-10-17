import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// BD simulada: `db.rows` son los productos de la tienda; el SELECT respeta `id > $1`, `id = $1` y el límite del lote.
const db = vi.hoisted(() => ({ rows: [] as any[], queries: [] as string[] }));

vi.mock('../db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: any[]) => {
      db.queries.push(sql);
      if (/id = \$1/.test(sql)) return { rows: db.rows.filter((r) => r.id === params[0]) };
      return { rows: db.rows.filter((r) => r.id > params[0]).sort((a, b) => a.id - b.id).slice(0, params[1]) };
    }),
  },
}));

import {
  classifyFirstImage, loadDiskIndex, scanCatalogImages, filterAuditItems, auditToCsv, recheckProductImages, getImageAudit,
} from './image-audit.js';

let base: string;
let uploads: string;
const touch = (rel: string) => { const f = path.join(uploads, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };

/** Fila como la devuelve el SELECT de la auditoría. */
const row = (id: number, sku: string | null, images: any, extra: Record<string, any> = {}) => {
  const kind = Array.isArray(images) ? 'array' : images === null ? null : typeof images === 'string' ? 'string' : 'object';
  return {
    id, sku, name: `Producto ${id}`, brand: 'MARCA', stock: 3, family_code: null, kind,
    n: Array.isArray(images) ? images.length : null, first: Array.isArray(images) ? images[0] ?? null : images, ...extra,
  };
};
const local = (sku: string) => ({ src: `/uploads/optimized/${sku}_0_800.webp` });
const BIHR = 'https://api.mybihr.com/medias/8010897003-1-800Wx800H?context=abc';

beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'image-audit-')); uploads = path.join(base, 'uploads'); });
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });
beforeEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(uploads, 'optimized'), { recursive: true });
  db.rows = [];
  db.queries = [];
});

describe('classifyFirstImage', () => {
  it('da por buena una foto local que existe', async () => {
    touch('optimized/AAA_0_800.webp');
    const disk = await loadDiskIndex(uploads);
    expect(classifyFirstImage(local('AAA'), 'AAA', disk).problem).toBeNull();
    // también si la ficha guarda la dirección completa del CDN o con parámetros
    expect(classifyFirstImage({ src: 'https://cdn.example.com/uploads/optimized/AAA_0_800.webp?v=2' }, 'AAA', disk).problem).toBeNull();
    expect(classifyFirstImage('/uploads/optimized/AAA_0_800.webp', 'AAA', disk).problem).toBeNull();
  });

  it('marca el fichero local que no está en disco', async () => {
    const disk = await loadDiskIndex(uploads);
    expect(classifyFirstImage(local('FALTA'), 'FALTA', disk).problem).toBe('fichero_perdido');
  });

  it('marca la ficha sin fotos o con la primera foto vacía', async () => {
    const disk = await loadDiskIndex(uploads);
    for (const first of [null, undefined, '', {}, { src: '' }, { alt: 'x' }, 42]) {
      expect(classifyFirstImage(first, 'S', disk).problem).toBe('sin_foto');
    }
  });

  it('marca la foto remota de Bihr sin copia local', async () => {
    const disk = await loadDiskIndex(uploads);
    const r = classifyFirstImage({ src: BIHR }, '8010897003', disk);
    expect(r.problem).toBe('foto_remota');
    expect(classifyFirstImage({ src: '/api/image-proxy?w=800&url=x' }, 'S', disk).problem).toBe('foto_remota');
  });

  it('acepta la foto remota si la tienda la sustituye por la copia antigua {SKU}-800.webp', async () => {
    touch('optimized/80-108_97-800.webp');
    const disk = await loadDiskIndex(uploads);
    expect(classifyFirstImage({ src: BIHR }, '80-108.97', disk).problem).toBeNull();
    expect(classifyFirstImage({ src: BIHR }, 'OTRO', disk).problem).toBe('foto_remota');
  });

  it('no sale de la carpeta de fotos con rutas raras', async () => {
    touch('../fuera.webp');
    const disk = await loadDiskIndex(uploads);
    expect(classifyFirstImage({ src: '/uploads/../fuera.webp' }, 'S', disk).problem).toBe('fichero_perdido');
    expect(classifyFirstImage({ src: '/uploads/optimized/../../etc/passwd' }, 'S', disk).problem).toBe('fichero_perdido');
  });
});

describe('loadDiskIndex', () => {
  it('falla si no puede leer la carpeta, en vez de dar todas las fotos por perdidas', async () => {
    await expect(loadDiskIndex(path.join(uploads, 'no-existe'))).rejects.toThrow(/carpeta de fotos/);
  });
});

describe('scanCatalogImages', () => {
  it('recorre el catálogo por lotes y cuenta cada caso', async () => {
    touch('optimized/OK_0_800.webp');
    db.rows = [
      row(1, 'OK', [local('OK')]),
      row(2, 'VACIO', []),
      row(3, 'NULO', null, { stock: 0 }),
      row(4, '8010897003', [{ src: BIHR }, { src: BIHR }], { family_code: 'SCOTT' }),
      row(5, 'PERDIDO', [local('PERDIDO')], { stock: 0 }),
      row(6, 'TEXTO', JSON.stringify([{ src: BIHR }])),
      row(7, 'RARO', { src: 'no-es-una-lista' }),
    ];
    for (let id = 100; id < 2105; id++) db.rows.push(row(id, `OK${id}`, [local('OK')])); // obliga a pedir más de un lote
    const { summary, items } = await scanCatalogImages(uploads);
    expect(db.queries.length).toBeGreaterThan(1);
    expect(summary.total).toBe(7 + 2005);
    expect(summary.sinImagen).toBe(items.length);
    expect(summary.porProblema).toEqual({
      sin_foto: { total: 3, conStock: 2 },
      foto_remota: { total: 2, conStock: 2 },
      fichero_perdido: { total: 1, conStock: 0 },
    });
    expect(summary.sinImagenConStock).toBe(4);
    expect(summary.conFoto).toBe(summary.total - 6);
    const p4 = items.find((i) => i.id === 4)!;
    expect(p4).toMatchObject({ sku: '8010897003', problem: 'foto_remota', photos: 2, familyCode: 'SCOTT', firstSrc: 'api.mybihr.com/medias/8010897003-1-800Wx800H' });
    expect(items.find((i) => i.id === 6)).toMatchObject({ problem: 'foto_remota', photos: 1 });
    // con stock primero
    const firstNoStock = items.findIndex((i) => i.stock === 0);
    expect(items.slice(0, firstNoStock).every((i) => i.stock > 0)).toBe(true);
  });
});

describe('filterAuditItems y CSV', () => {
  const items = [
    { id: 1, sku: 'A1', name: 'Escape SCOTT', brand: 'SCOTT', stock: 2, familyCode: '', problem: 'foto_remota' as const, photos: 4, firstSrc: 'api.mybihr.com/x' },
    { id: 2, sku: 'B2', name: '=SUMA(1;2) casco', brand: 'HJC', stock: 0, familyCode: 'F', problem: 'sin_foto' as const, photos: 0, firstSrc: '' },
    { id: 3, sku: 'C3', name: 'Guantes "pro"; talla M', brand: 'ALPINESTARS', stock: -1, familyCode: '', problem: 'fichero_perdido' as const, photos: 1, firstSrc: '/uploads/optimized/C3_0_800.webp' },
  ];

  it('filtra por problema, stock y texto', () => {
    expect(filterAuditItems(items, {}).length).toBe(3);
    expect(filterAuditItems(items, { problem: 'sin_foto' }).map((i) => i.id)).toEqual([2]);
    expect(filterAuditItems(items, { problem: 'inventado' }).length).toBe(3);
    expect(filterAuditItems(items, { onlyInStock: true }).map((i) => i.id)).toEqual([1]);
    expect(filterAuditItems(items, { q: ' scott ' }).map((i) => i.id)).toEqual([1]);
    expect(filterAuditItems(items, { q: 'c3' }).map((i) => i.id)).toEqual([3]);
  });

  it('escribe un CSV para Excel en español, sin fórmulas ni comillas rotas', () => {
    const csv = auditToCsv(items, 'https://tienda.test');
    expect(csv.startsWith('﻿id;sku;producto;marca;stock;problema;fotos_en_ficha;primera_foto;familia;ficha_en_la_tienda\r\n')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('1;A1;Escape SCOTT;SCOTT;2;Solo foto remota de Bihr;4;api.mybihr.com/x;;https://tienda.test/producto/1');
    expect(lines[2]).toBe('2;B2;"\'=SUMA(1;2) casco";HJC;0;Sin foto;0;;F;https://tienda.test/producto/2');
    expect(lines[3]).toContain('"Guantes ""pro""; talla M";ALPINESTARS;-1;');
  });
});

describe('getImageAudit y recheckProductImages', () => {
  it('guarda el resultado y, tras descargar las fotos de un producto, lo corrige sin recorrer todo', async () => {
    db.rows = [row(1, 'AAA', [{ src: BIHR }]), row(2, 'BBB', []), row(3, 'CCC', [local('CCC')])];
    touch('optimized/CCC_0_800.webp');
    const first = await getImageAudit({ refresh: true, uploadsDir: uploads });
    expect(first.summary).toMatchObject({ total: 3, conFoto: 1, sinImagen: 2 });
    const queries = db.queries.length;
    expect(await getImageAudit()).toBe(first);
    expect(db.queries.length).toBe(queries);

    // se descargan las fotos del producto 1
    touch('optimized/AAA_0_800.webp');
    db.rows[0] = row(1, 'AAA', [local('AAA')]);
    await recheckProductImages(1, uploads);
    expect(first.items.map((i) => i.id)).toEqual([2]);
    expect(first.summary).toMatchObject({ total: 3, conFoto: 2, sinImagen: 1, sinImagenConStock: 1 });
    expect(first.summary.porProblema.foto_remota).toEqual({ total: 0, conStock: 0 });
    expect(db.queries.length).toBe(queries + 1);

    // una foto que desaparece del disco se añade
    fs.rmSync(path.join(uploads, 'optimized/CCC_0_800.webp'));
    await recheckProductImages(3, uploads);
    expect(first.items.map((i) => i.id)).toEqual([2, 3]);
    expect(first.summary).toMatchObject({ conFoto: 1, sinImagen: 2 });
  });
});
