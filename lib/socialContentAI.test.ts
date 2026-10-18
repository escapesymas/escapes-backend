import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [{ free: '200' }] })) } }));
vi.mock('../chatbot/minimax.js', () => ({ minimaxClient: {}, CHAT_MODEL: 'x' }));
vi.mock('../chatbot/index.js', () => ({ storePolicies: async () => '' }));
vi.mock('./remote-image.js', () => ({ fetchRemoteImage: vi.fn() }));
vi.mock('sharp', () => ({ default: vi.fn() }));

const { pickAngle, angleFits, isAngle, trustLine } = await import('./socialContentAI.js');

const product = (compatibility = '') => ({
  id: 1, sku: 'X', name: 'Escape', brand: 'Marca', price: 10000, listPrice: 10000,
  inStock: true, description: '', images: [], compatibility,
});

describe('enfoques de las publicaciones', () => {
  it('sin historial empieza por el consejo', () => {
    expect(pickAngle(product('Yamaha MT-07 (2014-2024)'), [])).toBe('consejo');
  });

  it('elige el que lleva más tiempo sin usarse', () => {
    expect(pickAngle(product('Yamaha MT-07 (2014-2024)'), ['consejo', 'pregunta', 'tu_moto', 'guia', 'promo'])).toBe('promo');
    expect(pickAngle(product('Yamaha MT-07 (2014-2024)'), ['promo', 'guia', 'consejo'])).toBe('pregunta');
  });

  it('«Para tu moto» solo con compatibilidades reales', () => {
    expect(angleFits('tu_moto', product())).toBe(false);
    expect(angleFits('tu_moto', product('Honda PCX 125 (2021)'))).toBe(true);
    expect(pickAngle(product(), ['consejo', 'pregunta'])).toBe('guia');
  });

  it('la promo directa sale como mucho una de cada cuatro', () => {
    const recent: string[] = [];
    for (let i = 0; i < 20; i++) recent.unshift(pickAngle(product(), recent.slice(0, 10)));
    for (let i = 0; i + 4 <= recent.length; i++) {
      expect(recent.slice(i, i + 4).filter((a) => a === 'promo').length).toBeLessThanOrEqual(1);
    }
  });

  it('no acepta enfoques inventados ni propiedades del objeto', () => {
    expect(isAngle('consejo')).toBe(true);
    expect(isAngle('__proto__')).toBe(false);
    expect(isAngle('toString')).toBe(false);
    expect(isAngle(3)).toBe(false);
  });
});

describe('línea de confianza', () => {
  it('usa el envío gratis configurado en la tienda', async () => {
    expect(await trustLine()).toBe('✅ Envío gratis desde 200 € ✅ Paga con Bizum o a plazos con Klarna ✅ 3 años de garantía');
  });
});
