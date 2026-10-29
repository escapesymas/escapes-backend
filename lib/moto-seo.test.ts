import { describe, it, expect } from 'vitest';
import { cleanModelName } from './compat.js';
import {
  slugifyMoto,
  compactSlug,
  sortedTokenSlug,
  formatBrandDisplay,
  resolveBrandSlug,
  resolveModelSlug,
  isEscapeProduct,
  isPrimaryEscape,
  buildRootCategoryMap,
  classifyMotoProducts,
  getMotoSeoDirectory,
} from './moto-seo.js';

describe('moto-seo: slugs y nombres de marca', () => {
  it('genera slugs limpios y deterministas', () => {
    expect(slugifyMoto('YAMAHA')).toBe('yamaha');
    expect(slugifyMoto('HARLEY DAVIDSON')).toBe('harley-davidson');
    expect(slugifyMoto('MT-07')).toBe('mt-07');
    expect(slugifyMoto('Z 900')).toBe('z-900');
    expect(slugifyMoto('R 100 /7T')).toBe('r-100-7t');
    expect(compactSlug('Z 900')).toBe('z900');
    expect(sortedTokenSlug('duke-125')).toBe('125-duke');
    expect(sortedTokenSlug('125 DUKE')).toBe('125-duke');
  });

  it('formatea las marcas para títulos SEO', () => {
    expect(formatBrandDisplay('YAMAHA')).toBe('Yamaha');
    expect(formatBrandDisplay('BMW')).toBe('BMW');
    expect(formatBrandDisplay('KTM')).toBe('KTM');
    expect(formatBrandDisplay('HARLEY DAVIDSON')).toBe('Harley-Davidson');
    expect(formatBrandDisplay('MV AGUSTA')).toBe('MV Agusta');
    expect(formatBrandDisplay('GAS GAS')).toBe('Gas Gas');
    expect(formatBrandDisplay('ROYAL ENFIELD')).toBe('Royal Enfield');
  });
});

describe('cleanModelName: ediciones cosméticas sin mezclar modelos distintos', () => {
  it('iguala ediciones comerciales al modelo base', () => {
    expect(cleanModelName('CB 650 R NEO SPORTS CAFE (RH02)')).toBe(cleanModelName('CB 650 R'));
    expect(cleanModelName('CB 1000 R BLACK EDITION')).toBe(cleanModelName('CB 1000 R'));
    expect(cleanModelName('T-MAX 560 TECH MAX')).toBe(cleanModelName('T-MAX 560'));
  });

  it('mantiene separados modelos físicamente distintos', () => {
    expect(cleanModelName('Z 900')).not.toBe(cleanModelName('Z 900 RS'));
    expect(cleanModelName('R 1250 GS')).not.toBe(cleanModelName('R 1250 GS ADVENTURE'));
    expect(cleanModelName('MT-07')).not.toBe(cleanModelName('MT-09'));
  });
});

describe('resolución canónica sobre moto_catalog.json real', () => {
  it('resuelve URLs canónicas sin redirección', () => {
    const mt07 = resolveModelSlug('yamaha', 'mt-07');
    expect(mt07).not.toBeNull();
    expect(mt07?.needsRedirect).toBe(false);
    expect(mt07?.canonicalPath).toBe('/escapes/yamaha/mt-07');
    expect(mt07?.brandNode.name).toBe('Yamaha');
    expect(mt07?.modelNode.model).toBe('MT-07');
    expect(mt07?.modelNode.years.length).toBeGreaterThan(5);

    const z900 = resolveModelSlug('kawasaki', 'z-900');
    expect(z900?.needsRedirect).toBe(false);
    expect(z900?.canonicalPath).toBe('/escapes/kawasaki/z-900');

    const cyclone = resolveModelSlug('cyclone', 'rx6');
    expect(cyclone?.needsRedirect).toBe(false);
    expect(cyclone?.canonicalPath).toBe('/escapes/cyclone/rx6');
  });

  it('redirige variantes habituales sin guion, con mayúsculas o en orden inverso', () => {
    expect(resolveBrandSlug('YAMAHA')).toMatchObject({ canonicalPath: '/escapes/yamaha', needsRedirect: true });
    expect(resolveBrandSlug('harleydavidson')).toMatchObject({ canonicalPath: '/escapes/harley-davidson', needsRedirect: true });

    expect(resolveModelSlug('yamaha', 'mt07')).toMatchObject({
      canonicalPath: '/escapes/yamaha/mt-07',
      needsRedirect: true,
    });
    expect(resolveModelSlug('kawasaki', 'z900')).toMatchObject({
      canonicalPath: '/escapes/kawasaki/z-900',
      needsRedirect: true,
    });
    expect(resolveModelSlug('yamaha', 'tmax-560')).toMatchObject({
      canonicalPath: '/escapes/yamaha/t-max-560',
      needsRedirect: true,
    });
    expect(resolveModelSlug('honda', 'cb650r')).toMatchObject({
      canonicalPath: '/escapes/honda/cb-650-r',
      needsRedirect: true,
    });
    expect(resolveModelSlug('ktm', 'duke-125')).toMatchObject({
      canonicalPath: '/escapes/ktm/125-duke',
      needsRedirect: true,
    });
    expect(resolveModelSlug('ducati', 'monster-696')).toMatchObject({
      canonicalPath: '/escapes/ducati/696-monster',
      needsRedirect: true,
    });
    expect(resolveModelSlug('honda', 'cb-650-r-neo-sports-cafe')).toMatchObject({
      canonicalPath: '/escapes/honda/cb-650-r',
      needsRedirect: true,
    });
  });

  it('devuelve null para marcas o modelos inexistentes (404 real)', () => {
    expect(resolveBrandSlug('marca-inventada-xyz')).toBeNull();
    expect(resolveModelSlug('yamaha', 'modelo-inventado-999')).toBeNull();
    expect(resolveModelSlug('', 'mt-07')).toBeNull();
  });
});

describe('clasificación y orden de escapes frente a recambios', () => {
  const rootMap = buildRootCategoryMap([
    { id: 1007, name: 'Escapes', slug: 'escapes', parent_id: null },
    { id: 1000048, name: 'Accesorios de escape', slug: 'accesorios-de-escape', parent_id: 1007 },
    { id: 1030, name: 'Accesorios de escape', slug: 'accesorios-de-escape-1030', parent_id: 1000048 },
    { id: 1008, name: 'Frenos', slug: 'frenos', parent_id: null },
    { id: 1000037, name: 'Pastillas de freno', slug: 'pastillas-de-freno', parent_id: 1008 },
    { id: 1087, name: 'Pastillas de freno', slug: 'pastillas-de-freno-1087', parent_id: 1000037 },
    { id: 1012, name: 'Motor', slug: 'motor', parent_id: null },
    { id: 1045, name: 'Admisión motor', slug: 'admision-motor-1045', parent_id: 1012 },
    { id: 1011, name: 'Material promocional', slug: 'material-promocional', parent_id: null },
  ]);

  it('separa escapes completos/silenciosos de juntas/muelles y descarta colectores de admisión y promocionales', () => {
    const cards = [
      { id: 1, sku: 'J1', name: 'Junta de escape CENTAURO Ø32x42x3 mm', categoryId: 1030, price: 7.5, stock: 10, inStock: true },
      { id: 2, sku: 'E2', name: 'Escape completo IXIL Race Xtrem agotado', categoryId: 1007, price: 950, stock: 0, inStock: false },
      { id: 3, sku: 'E1', name: 'Escape completo IXIL Hyperlow acero inoxidable - XY9362XB', categoryId: 1007, price: 1054.13, stock: 4, inStock: true },
      { id: 4, sku: 'S1', name: 'Silenciador IXIL MXT acero inoxidable', categoryId: 1007, price: 540, stock: 2, inStock: true },
      { id: 5, sku: 'A1', name: 'Colector de admisión IXIL', categoryId: 1045, price: 89, stock: 3, inStock: true },
      { id: 6, sku: 'F1', name: 'Pastillas de freno Brembo Sinter', categoryId: 1087, price: 42, stock: 8, inStock: true },
      { id: 7, sku: 'P1', name: 'Expositor promocional taller', categoryId: 1011, price: 15, stock: 5, inStock: true },
    ];

    expect(isEscapeProduct(cards[4], 1012)).toBe(false);
    expect(isPrimaryEscape(cards[2], 1007)).toBe(true);
    expect(isPrimaryEscape(cards[0], 1007)).toBe(false);

    const out = classifyMotoProducts(cards, rootMap);
    // Silenciador en stock (540 €) primero, luego escape completo en stock (1054 €), luego agotado (950 €).
    expect(out.primaryEscapes.map((p) => p.sku)).toEqual(['S1', 'E1', 'E2']);
    expect(out.escapeAccessories.map((p) => p.sku)).toEqual(['J1']);
    // El colector de admisión queda en Motor, no en Escapes, y el promocional desaparece.
    expect(out.otherProducts.map((p) => p.sku)).toEqual(['F1', 'A1']);
    expect(out.categories.map((c) => `${c.slug}:${c.count}`)).toEqual(['escapes:4', 'frenos:1', 'motor:1']);
  });
});

describe('getMotoSeoDirectory (sin páginas vacías en sitemap)', () => {
  it('marca hasProducts solo en modelos con SKUs publicados o compatibilidad en BD', async () => {
    const fakePool: any = {
      query: async (sqlText: string) => {
        if (sqlText.includes('SELECT sku FROM products')) {
          return { rows: [{ sku: '1111380' }] };
        }
        if (sqlText.includes('SELECT sku, brand, compatibility')) {
          return {
            rows: [
              {
                sku: '1111380',
                brand: 'IXIL',
                name: 'Escape completo IXIL Hyperlow',
                category_id: 1007,
                compatibility: [
                  { brand: 'YAMAHA', model: 'MT-07 (RM17)', year: 2020 },
                  { brand: 'HONDA', model: 'CB 650 R NEO SPORTS CAFE (RH02)', year: 2022 },
                ],
              },
            ],
          };
        }
        if (sqlText.includes('compat_vehicle_models')) {
          return { rows: [{ brand: 'KAWASAKI', model: 'Z 900 (ZR900B)' }] };
        }
        return { rows: [] };
      },
    };

    const dir = await getMotoSeoDirectory(fakePool);
    const yamahaMt07 = dir.modelsByBrandSlug['yamaha']?.find((m) => m.slug === 'mt-07');
    const hondaCb650r = dir.modelsByBrandSlug['honda']?.find((m) => m.slug === 'cb-650-r');
    const kawaZ900 = dir.modelsByBrandSlug['kawasaki']?.find((m) => m.slug === 'z-900');
    const cycloneRx6 = dir.modelsByBrandSlug['cyclone']?.find((m) => m.slug === 'rx6');

    expect(yamahaMt07?.hasProducts).toBe(true);
    expect(yamahaMt07?.escapeCount).toBe(1);
    expect(hondaCb650r?.hasProducts).toBe(true);
    expect(hondaCb650r?.escapeCount).toBe(1);
    expect(kawaZ900?.hasProducts).toBe(true);
    expect(cycloneRx6?.hasProducts).toBe(false);
    expect(dir.topEscapeBrands).toEqual([{ brand: 'IXIL', count: 1 }]);
  });
});

describe('endpoints HTTP /api/catalog/motos (404 y redirecciones canónicas)', () => {
  it('responde 404 en marcas/modelos inexistentes y redirectTo en variantes no canónicas', async () => {
    process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-at-least-32-chars';
    const express = (await import('express')).default;
    const { catalogRouter } = await import('../routes/catalog.js');
    const app = express();
    app.use('/api', catalogRouter);

    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const addr = server.address() as import('net').AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const r404Brand = await fetch(`${base}/api/catalog/motos/marca-falsa-999`);
      expect(r404Brand.status).toBe(404);
      expect(await r404Brand.json()).toEqual({ missing: true });

      const r404Model = await fetch(`${base}/api/catalog/motos/yamaha/modelo-falso-999`);
      expect(r404Model.status).toBe(404);
      expect(await r404Model.json()).toEqual({ missing: true });

      const rRedirBrand = await fetch(`${base}/api/catalog/motos/HARLEYDAVIDSON`);
      expect(rRedirBrand.status).toBe(200);
      expect(await rRedirBrand.json()).toEqual({ redirectTo: '/escapes/harley-davidson' });

      const rRedirModel = await fetch(`${base}/api/catalog/motos/kawasaki/z900?year=2021`);
      expect(rRedirModel.status).toBe(200);
      expect(await rRedirModel.json()).toEqual({ redirectTo: '/escapes/kawasaki/z-900?year=2021' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

