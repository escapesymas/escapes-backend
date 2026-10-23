import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('./cache.js', () => ({ cacheBust: vi.fn(async () => {}) }));
vi.mock('../chatbot/minimax.js', () => ({ minimaxClient: {}, CHAT_MODEL: 'test' }));

const { splitHtml, faithful, rebuild } = await import('./description-translation.js');

const html = '<ul><li>Brake calliper piston kit</li><li>Diameter 25.4 mm &amp; 2 seals</li></ul>';

describe('traducción de descripciones', () => {
  it('solo manda los trozos con letras', () => {
    const { parts, texts } = splitHtml(html);
    expect(texts.map((i) => parts[i])).toEqual(['Brake calliper piston kit', 'Diameter 25.4 mm &amp; 2 seals']);
  });

  it('vuelve a montar el HTML con las mismas etiquetas y el texto escapado', () => {
    expect(rebuild(html, ['Kit de pistones de pinza de freno', 'Diámetro 25,4 mm & 2 retenes']))
      .toBe('<ul><li>Kit de pistones de pinza de freno</li><li>Diámetro 25,4 mm &amp; 2 retenes</li></ul>');
  });

  it('descarta traducciones que cambian cifras, faltan trozos o traen etiquetas', () => {
    expect(rebuild(html, ['Kit de pistones de pinza de freno', 'Diámetro 25 mm y 2 retenes'])).toBeNull();
    expect(rebuild(html, ['Kit de pistones de pinza de freno'])).toBeNull();
    expect(rebuild(html, ['Kit <b>pistones</b> de pinza de freno', 'Diámetro 25,4 mm & 2 retenes'])).toBeNull();
  });

  it('descarta textos que se inventan contenido o nombran al proveedor', () => {
    expect(faithful('Steel sprocket for the rear wheel', 'Corona de acero para la rueda trasera, la mejor del mercado con una durabilidad excepcional y garantía de por vida en todas las motos')).toBe(false);
    expect(faithful('Steel sprocket for the rear wheel', 'Corona de acero de Bihr para la rueda trasera')).toBe(false);
    expect(faithful('Steel sprocket for the rear wheel', 'Corona de acero para la rueda trasera')).toBe(true);
  });
});
