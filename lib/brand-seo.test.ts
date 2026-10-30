import { describe, it, expect } from 'vitest';
import {
  isExcludedSupplierBrand,
  slugifyManufacturerBrand,
  compactManufacturerBrandSlug,
  formatManufacturerBrandDisplay,
  getManufacturerBrandsDirectory,
  resolveManufacturerBrandSlug,
  resolveLegacyProductRedirect,
} from './brand-seo.js';

describe('brand-seo: normalización, confidencialidad de proveedor y formato', () => {
  it('excluye siempre al proveedor mayorista BIHR en cualquier variante', () => {
    expect(isExcludedSupplierBrand('BIHR')).toBe(true);
    expect(isExcludedSupplierBrand('bihr')).toBe(true);
    expect(isExcludedSupplierBrand('Bihr Europe')).toBe(true);
    expect(isExcludedSupplierBrand('')).toBe(true);
    expect(isExcludedSupplierBrand(null)).toBe(true);

    expect(isExcludedSupplierBrand('IXIL')).toBe(false);
    expect(isExcludedSupplierBrand('YOSHIMURA US')).toBe(false);
    expect(isExcludedSupplierBrand('R&G RACING')).toBe(false);
    expect(isExcludedSupplierBrand('BREMBO')).toBe(false);
  });

  it('genera slugs limpios y compactos para fabricantes', () => {
    expect(slugifyManufacturerBrand('IXIL')).toBe('ixil');
    expect(slugifyManufacturerBrand('YOSHIMURA US')).toBe('yoshimura-us');
    expect(slugifyManufacturerBrand('R&G RACING')).toBe('r-g-racing');
    expect(slugifyManufacturerBrand('MUC-OFF')).toBe('muc-off');
    expect(compactManufacturerBrandSlug('YOSHIMURA US')).toBe('yoshimuraus');
    expect(compactManufacturerBrandSlug('R&G RACING')).toBe('rgracing');
  });

  it('formatea nombres de fabricantes respetando siglas reales', () => {
    expect(formatManufacturerBrandDisplay('IXIL')).toBe('IXIL');
    expect(formatManufacturerBrandDisplay('AFAM')).toBe('AFAM');
    expect(formatManufacturerBrandDisplay('NGK')).toBe('NGK');
    expect(formatManufacturerBrandDisplay('YOSHIMURA US')).toBe('Yoshimura US');
    expect(formatManufacturerBrandDisplay('R&G RACING')).toBe('R&G Racing');
    expect(formatManufacturerBrandDisplay('TECNIGAS')).toBe('Tecnigas');
    expect(formatManufacturerBrandDisplay('YASUNI')).toBe('Yasuni');
    expect(formatManufacturerBrandDisplay('TROY LEE DESIGNS')).toBe('Troy Lee Designs');
  });
});

describe('brand-seo: directorio y resolución canónica de slugs', () => {
  const fakePool = {
    async query(sqlText: string) {
      if (sqlText.includes('FROM products p')) {
        return {
          rows: [
            { brand: 'IXIL', cat_id: 1007, cat_name: 'Silenciosos', cat_slug: 'silenciosos', parent_id: 1000, parent_name: 'Escapes', parent_slug: 'escapes', cnt: 350 },
            { brand: 'BREMBO', cat_id: 1020, cat_name: 'Pastillas de freno', cat_slug: 'pastillas-de-freno', parent_id: 1003, parent_name: 'Frenos', parent_slug: 'frenos', cnt: 700 },
            { brand: 'BIHR', cat_id: 1010, cat_name: 'Taller', cat_slug: 'taller', parent_id: null, parent_name: null, parent_slug: null, cnt: 100 },
          ],
        };
      }
      return {
        rows: [
          { brand: 'IXIL', product_count: 398, model_count: 390, in_stock_count: 186, escape_count: 398 },
          { brand: 'YOSHIMURA US', product_count: 92, model_count: 90, in_stock_count: 69, escape_count: 90 },
          { brand: 'BREMBO', product_count: 1052, model_count: 980, in_stock_count: 736, escape_count: 0 },
          { brand: 'BIHR', product_count: 474, model_count: 450, in_stock_count: 359, escape_count: 4 },
        ],
      };
    },
  } as any;

  it('construye el directorio excluyendo BIHR y clasificando especialistas de escape', async () => {
    const dir = await getManufacturerBrandsDirectory(fakePool);
    expect(dir.totalBrands).toBe(3);
    expect(dir.brands.some((b) => /bihr/i.test(b.brand) || b.slug === 'bihr')).toBe(false);
    expect(dir.escapeBrands.map((b) => b.slug)).toEqual(['ixil', 'yoshimura-us']);

    const ixil = dir.brands.find((b) => b.slug === 'ixil');
    expect(ixil?.topCategories[0]?.catalogHref).toBe('/universales/escapes/silenciosos');
  });

  it('resuelve slugs canónicos, variantes con redirección 308 y bloquea BIHR con null', async () => {
    const canon = await resolveManufacturerBrandSlug(fakePool, 'ixil');
    expect(canon?.needsRedirect).toBe(false);
    expect(canon?.canonicalPath).toBe('/marcas/ixil');

    const upper = await resolveManufacturerBrandSlug(fakePool, 'IXIL');
    expect(upper?.needsRedirect).toBe(true);
    expect(upper?.canonicalPath).toBe('/marcas/ixil');

    const compact = await resolveManufacturerBrandSlug(fakePool, 'yoshimuraus');
    expect(compact?.needsRedirect).toBe(true);
    expect(compact?.canonicalPath).toBe('/marcas/yoshimura-us');

    expect(await resolveManufacturerBrandSlug(fakePool, 'bihr')).toBeNull();
    expect(await resolveManufacturerBrandSlug(fakePool, 'BIHR')).toBeNull();
    expect(await resolveManufacturerBrandSlug(fakePool, 'marca-inexistente')).toBeNull();
  });
});

describe('brand-seo: rescate de URLs antiguas de WooCommerce (404 en Search Console)', () => {
  it('redirige slugs descriptivos de escapes antiguos a la moto o hub correspondiente', () => {
    const tuareg = resolveLegacyProductRedirect('mivv-slip-on-dakar-st-steel-aprilia-tuareg-660-2022-25');
    expect(tuareg).toMatch(/^\/escapes\/aprilia(\/tuareg-660)?$/);

    const bmw = resolveLegacyProductRedirect(
      'mivv-tubo-no-kat-compatible-con-silenciadores-mivv-y-originales-bmw-r-1200-gs-adventure-2004-09',
    );
    expect(bmw).toMatch(/^\/escapes\/bmw\//);

    const genericPart = resolveLegacyProductRedirect('mivv-protector-de-calor-50-cr-036-sx');
    expect(genericPart).toBe('/escapes');
  });

  it('no interfiere con SKUs inexistentes normales (deben seguir dando 404)', () => {
    expect(resolveLegacyProductRedirect('8009773003')).toBeNull();
    expect(resolveLegacyProductRedirect('1060246')).toBeNull();
    expect(resolveLegacyProductRedirect('sku-inexistente-999')).toBeNull();
  });
});

describe('catalogRouter + mapProductToFrontend: imágenes vacías, MPN y endpoint /api/catalog/marcas', () => {
  it('descarta objetos de imagen con src vacío (caso real SKU 79900181 en Search Console), expone mpn y responde en /api/catalog/marcas', async () => {
    process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-at-least-32-chars';
    const express = (await import('express')).default;
    const { mapProductToFrontend, catalogRouter } = await import('../routes/catalog.js');

    const mapped = mapProductToFrontend({
      id: 201793,
      sku: '79900181',
      name: 'Kit de adhesivos Fresco 2T, color azul',
      brand: 'FRESCO',
      price: 2990,
      stock: 3,
      barcode: '5014152031022',
      supplier_code: 'FRTENADOTCA-B',
      images: [{ alt: 'Kit de adhesivos Fresco 2T, color azul', src: '', originalUrl: 'no-image:not-in-FRESCO-zip' }],
    });
    expect(mapped.images).toEqual([]);
    expect(mapped.image).toBe('');
    expect(mapped.mpn).toBe('FRTENADOTCA-B');
    expect(mapped.barcode).toBe('5014152031022');

    const app = express();
    app.use('/api', catalogRouter);
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address() as import('net').AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const rBihr = await fetch(`${base}/api/catalog/marcas/bihr`);
      expect(rBihr.status).toBe(404);

      const rRedir = await fetch(`${base}/api/catalog/marcas/IXIL?page=2`);
      expect(rRedir.status).toBe(200);
      expect(await rRedir.json()).toEqual({ redirectTo: '/marcas/ixil?page=2' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
