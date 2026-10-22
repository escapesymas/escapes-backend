import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

const { feedItem, feedPrices, validGtin, plainDescription } = await import('./google-feed.js');

const row = (over: Record<string, unknown> = {}) => ({
  id: 1, sku: '1076063006', name: 'Rueda trasera completa HAAN WHEELS 18x2.50x36T', brand: 'HAAN WHEELS',
  description: '<p>Rueda lista para montar.</p>', price: 112730, sale_price: null, promo_price: null, stock: 6,
  images: [{ src: '/uploads/optimized/1076063006_0_800.webp' }, { src: '/uploads/optimized/1076063006_1_800.webp' }],
  barcode: '4006381333931', supplier_code: 'HAA00018A', weight_g: 4200, category_id: 7, ...over,
});
const cat = () => 'Neumáticos y llantas > Llantas';

describe('feed de Google Shopping', () => {
  it('genera el producto con precio, fotos, marca, EAN, referencia y categoría', () => {
    const it = feedItem(row() as any, cat);
    expect('xml' in it).toBe(true);
    const x = (it as { xml: string }).xml;
    expect(x).toContain('<g:id>1076063006</g:id>');
    expect(x).toContain('<link>https://escapesymas.com/producto/1076063006</link>');
    expect(x).toContain('<g:image_link>https://escapesymas.com/uploads/optimized/1076063006_0_800.webp</g:image_link>');
    expect(x).toContain('<g:additional_image_link>');
    expect(x).toContain('<g:price>1127.30 EUR</g:price>');
    expect(x).not.toContain('sale_price');
    expect(x).toContain('<g:gtin>4006381333931</g:gtin>');
    expect(x).toContain('<g:mpn>HAA00018A</g:mpn>');
    expect(x).toContain('<g:product_type>Neumáticos y llantas &gt; Llantas</g:product_type>');
    expect(x).toContain('<g:availability>in_stock</g:availability>');
  });

  it('deja fuera Bihr, sin stock y sin foto propia', () => {
    expect(feedItem(row({ brand: 'BIHR' }) as any, cat)).toEqual({ skip: 'bihr' });
    expect(feedItem(row({ name: 'Boca Bihr 17 mm', brand: 'VECTOR' }) as any, cat)).toEqual({ skip: 'bihr' });
    expect(feedItem(row({ stock: 0 }) as any, cat)).toEqual({ skip: 'sin_stock' });
    expect(feedItem(row({ images: [{ src: 'https://api.mybihr.com/medias/x.jpg' }] }) as any, cat)).toEqual({ skip: 'sin_foto' });
  });

  it('el precio es el de la web: promoción u oferta menor como sale_price', () => {
    expect(feedPrices(10000, 9000, null)).toEqual({ price: 10000, salePrice: 9000 });
    expect(feedPrices(10000, 12000, null)).toEqual({ price: 10000, salePrice: null });
    expect(feedPrices(10000, 9000, 8500)).toEqual({ price: 10000, salePrice: 8500 });
  });

  it('solo EAN con dígito de control correcto; si no hay identificadores, identifier_exists no', () => {
    expect(validGtin('4006381333931')).toBe('4006381333931');
    expect(validGtin('4006381333932')).toBeNull();
    expect(validGtin('KRSK-001')).toBeNull();
    const x = (feedItem(row({ barcode: 'KRSK-001', supplier_code: '' }) as any, cat) as { xml: string }).xml;
    expect(x).not.toContain('<g:gtin>');
    expect(x).toContain('<g:identifier_exists>no</g:identifier_exists>');
  });

  it('la descripción va sin HTML ni frases que nombren al proveedor', () => {
    expect(plainDescription('<b>Funda</b> impermeable. Distribuido por Bihr. Talla&nbsp;L.')).toBe('Funda impermeable. Talla L.');
  });
});
