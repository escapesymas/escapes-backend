import { describe, it, expect } from 'vitest';
import { foreignWords, garbledTokens, looksForeign, stripForeignWords, stripUnknownForeign, unknownWords } from './spanishGuard.js';

describe('palabras en inglés en una respuesta en español', () => {
  it('detecta las que no estaban en lo que el modelo tenía delante', () => {
    const answer = 'También Available hay opciones con reinforced construction para tu moto.';
    expect(foreignWords(answer, 'Escape Yamaha MT-09 a 199 €').sort()).toEqual(['available', 'construction', 'reinforced']);
  });

  it('no marca las del catálogo ni las del mensaje del cliente', () => {
    const answer = 'El Quality Racing de Akrapovic va muy bien.';
    expect(foreignWords(answer, 'PRODUCTOS: Quality Racing Akrapovic')).toEqual([]);
    expect(foreignWords('Es un escape Premium', 'busco un escape premium')).toEqual([]);
  });

  it('el español normal, con tildes, no se toca', () => {
    expect(foreignWords('Sí, hay stock de las pastillas para tu moto. Compatible con el modelo del 2022.', '')).toEqual([]);
    expect(foreignWords('El envío es gratis desde 200 € y la entrega tarda de 5 a 10 días.', '')).toEqual([]);
  });

  it('las que son válidas en una tienda de moto (stock, email, compatible) no cuentan', () => {
    expect(foreignWords('Escríbenos por email, hay stock y es compatible.', '')).toEqual([]);
  });

  it('una palabra pegada a otra no cuenta como inglesa («forzado», «parte»)', () => {
    expect(foreignWords('Forzado, parte trasera, color negro', '')).toEqual([]);
  });
});

describe('quitar las palabras sueltas como último recurso', () => {
  it('traduce las habituales', () => {
    expect(stripForeignWords('Hay opciones Available para ti.', ['available'])).toBe('Hay opciones disponible para ti.');
  });

  it('las que no sabe traducir se quitan sin dejar dobles espacios ni espacios antes de la puntuación', () => {
    expect(stripForeignWords('Tiene una tracking .', ['tracking'])).toBe('Tiene una.');
  });
});

describe('más inglés habitual', () => {
  it('detecta verbos y nombres sueltos', () => {
    expect(foreignWords('conviene prioritise que no apriete al finalizar el purchase', '').sort()).toEqual(['prioritise', 'purchase']);
    expect(foreignWords('Si la Transmission refers a toda la caja', '').sort()).toEqual(['refers', 'transmission']);
    expect(foreignWords('disculpo sincerely por las molestias', '')).toEqual(['sincerely']);
  });

  it('no marca español válido que se parece al inglés (simple, similar, general, total)', () => {
    expect(foreignWords('Es un recambio simple y similar al original, en general muy completo. Total: 50 €.', '')).toEqual([]);
  });
});

describe('fragmentos rotos', () => {
  it('minúsculas pegadas a mayúsculas que no estaban en el contexto', () => {
    expect(garbledTokens('¿Prefieres un set deAGN seg? ¿Lo quieres más deportivo?', 'pastillas Brembo')).toEqual(['deAGN']);
    expect(garbledTokens('si la laTransmission no encaja', 'correas')).toEqual(['laTransmission']);
  });

  it('un nombre del catálogo escrito igual no cuenta', () => {
    expect(garbledTokens('El casco MotoGP de la lista y el KTM', 'casco MotoGP replica')).toEqual([]);
  });

  it('nombres propios con mayúscula en medio (PayPal, YouTube) no cuentan', () => {
    expect(garbledTokens('No aceptamos PayPal; mira el vídeo de YouTube y el MotoGP', '')).toEqual([]);
  });

  it('texto normal con siglas aisladas no cuenta', () => {
    expect(garbledTokens('Compatible con la Honda CB 500 F y la KTM 390 ABS, envío en 24-72 h.', '')).toEqual([]);
  });
});

describe('palabras que no existen en español (diccionario)', () => {
  it('marca las palabras inventadas o de otro idioma que se cuelan', () => {
    expect(unknownWords('Dime si buscas motor o mingle, y te/helpemos con una waitress distinctive.', '').sort())
      .toEqual(['distinctive', 'helpemos', 'mingle', 'waitress']);
  });

  it('el español normal de la tienda no se marca, con pronombres pegados y adverbios', () => {
    const t = 'Te recomiendo la correa reforzada: confirma la viscosidad en el manual, inclúyelo en el pedido e indícamelo si necesitas ayuda. ' +
      'Sinceramente, dependiendo del año y de la versión, compáralo con las pastillas sinterizadas y los retrovisores del garaje.';
    expect(unknownWords(t, '')).toEqual([]);
  });

  it('no marca lo que está en lo que el modelo tenía delante (catálogo, mensaje del cliente)', () => {
    expect(unknownWords('Mira el hiflofiltro y el tecnigas.', 'HIFLOFILTRO TECNIGAS')).toEqual([]);
  });

  it('no marca nombres propios ni siglas con mayúscula', () => {
    expect(unknownWords('Tecnium, Malossi, Polini y la KTM Duke 390 ABS con Bizum.', '')).toEqual([]);
  });

  it('se puede apagar con CHAT_SPELLCHECK=off', () => {
    process.env.CHAT_SPELLCHECK = 'off';
    try { expect(unknownWords('una waitress mingle', '')).toEqual([]); } finally { delete process.env.CHAT_SPELLCHECK; }
  });
});

describe('último recurso con palabras desconocidas', () => {
  it('quita las que parecen inglesas y deja las dudosas', () => {
    expect(stripUnknownForeign('No veo ningún pedido associated a tu cuenta, ni competition .', '')).toBe('No veo ningún pedido a tu cuenta, ni.');
    // «desprecintado» no está en el diccionario pero es español: se deja
    expect(stripUnknownForeign('El producto desprecintado no se devuelve.', '')).toBe('El producto desprecintado no se devuelve.');
  });

  it('looksForeign', () => {
    for (const w of ['associated', 'waitress', 'competition', 'know', 'distinctive']) expect(looksForeign(w), w).toBe(true);
    for (const w of ['desprecintado', 'semimetálicas', 'reaprovisionamiento', 'catadióptricos']) expect(looksForeign(w), w).toBe(false);
  });
});
