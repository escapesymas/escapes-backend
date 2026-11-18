import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('../chatbot/minimax.js', () => ({ minimaxClient: { chat: { completions: { create: (...a: any[]) => create(...a) } } }, CHAT_MODEL: 'test-model' }));

const { badParticiples, dropCjkSentences, generateOverviewAiReport, gluedNumbers, reportToPromptText, SECTIONS, SYSTEM_PROMPT } = await import('./overview-ai.js');
const { makeReport } = await import('./overview-fixture.js');

const reply = (content: string, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { total_tokens: 100 } });
const GOOD = 'Las ventas han subido hasta 480,00 €, con 4 pedidos pagados.';
/** Sección que pide cada llamada (va en el mensaje del usuario). */
const asked = (call: any[]): string => { const m = /SECCIÓN A REDACTAR: «([^»]+)»/.exec(String(call[0]?.messages?.[1]?.content)); if (!m) throw new Error('llamada sin sección: ' + JSON.stringify(call).slice(0, 200)); return m[1]; };

describe('datos que ve la IA', () => {
  const text = reportToPromptText(makeReport());

  it('lleva el periodo, el comparado y las cifras ya formateadas', () => {
    expect(text).toContain('Últimos 7 días');
    expect(text).toContain('COMPARADO CON: 7 días anteriores');
    expect(text).toContain('Ventas (IVA incluido) | 480,00 € | 200,00 € | +140,0 % | subir');
    expect(text).toContain('Visitantes únicos | 1.200 | 800');
  });

  it('las fotos del momento se marcan como tales y las búsquedas sin resultado salen aparte', () => {
    expect(text).toContain('Carritos activos ahora | 5 | foto del momento');
    expect(text).toContain('Búsquedas SIN resultados: «aceite honda dulan» (3)');
  });

  it('no lleva correos de clientes', () => {
    expect(text).not.toContain('a@b.c');
  });

  it('las instrucciones prohíben inventar y nombrar proveedores', () => {
    expect(SYSTEM_PROMPT).toMatch(/No inventes/);
    expect(SYSTEM_PROMPT).toMatch(/proveedores/);
  });
});

describe('verbos mal conjugados', () => {
  it('detecta el infinitivo tras «haber»', () => {
    expect(badParticiples('El importe ha bajar y los carritos han subir')).toEqual(['ha bajar', 'han subir']);
    expect(badParticiples('Ha bajado, han subido, ha sido, he de decir que sí')).toEqual([]);
  });
});

describe('último recurso con chino', () => {
  it('quita la frase rota y deja el resto intacto', () => {
    expect(dropCjkSentences('Las ventas suben. Los carritos 下降 mucho. El rebote baja.')).toBe('Las ventas suben. El rebote baja.');
  });

  it('quita el punto de lista roto entero y renumera', () => {
    const md = '1. Revisar el pago.\n2. Simplificar 优化 el proceso.\n3. Enviar recordatorios.';
    expect(dropCjkSentences(md)).toBe('1. Revisar el pago.\n2. Enviar recordatorios.');
  });

  it('un texto sin chino no cambia', () => {
    expect(dropCjkSentences('Todo bien.\n\n- Punto A\n- Punto B')).toBe('Todo bien.\n\n- Punto A\n- Punto B');
  });
});

describe('números pegados a palabras', () => {
  it('detecta «5carritos» pero no referencias que vienen en los datos', () => {
    expect(gluedNumbers('solo 1 de los 5carritos llegó y 24h después', '')).toEqual(['5carritos']);
    expect(gluedNumbers('la moto 315rcota del cliente', 'busca 315rcota')).toEqual([]);
    expect(gluedNumbers('cifras normales: 1.175 visitantes, 0,81 € y 24 h', '')).toEqual([]);
  });
});

describe('generación del informe por secciones', () => {
  beforeEach(() => { create.mockReset(); });

  it('pide una llamada por sección y compone el informe con sus títulos, en orden', async () => {
    create.mockResolvedValue(reply(GOOD));
    const r = await generateOverviewAiReport(makeReport());
    expect(create).toHaveBeenCalledTimes(SECTIONS.length);
    expect(r.attempts).toBe(SECTIONS.length);
    const headings = [...r.text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(SECTIONS.map((x) => x.title));
    expect(r.text).toContain('Las ventas han subido hasta 480,00 €');
  });

  it('si una sección trae chino o un verbo sin conjugar se repite SOLO esa y se queda la buena', async () => {
    let ventas = 0;
    create.mockImplementation(async (...call: any[]) => {
      if (asked([call[0]]) === 'Ventas y márgenes' && ventas++ === 0) return reply('Las ventas han bajar 下降 mucho.');
      return reply(GOOD);
    });
    const r = await generateOverviewAiReport(makeReport());
    expect(create).toHaveBeenCalledTimes(SECTIONS.length + 1);
    expect(r.text).not.toMatch(/下降/);
    expect(r.text).not.toContain('han bajar');
    expect(r.notes).toEqual([expect.stringContaining('Ventas y márgenes: con chino')]);
    // el segundo intento de esa sección lleva el aviso del fallo
    const retry = create.mock.calls.find((c) => asked([c[0]]) === 'Ventas y márgenes' && /IMPORTANTE/.test(c[0].messages[0].content));
    expect(retry).toBeTruthy();
  });

  it('una palabra inglesa con mayúscula en medio de una frase también se corrige', async () => {
    let first = true;
    create.mockImplementation(async (...call: any[]) => {
      if (asked([call[0]]) === 'Recomendaciones' && first) { first = false; return reply('1. Revisar el stock para no perder Visibility en las fichas.'); }
      return reply(GOOD);
    });
    const r = await generateOverviewAiReport(makeReport());
    expect(r.notes.join(' ')).toMatch(/Recomendaciones: con palabras raras: visibility/);
    expect(r.text).not.toMatch(/Visibility/);
  });

  it('si una sección no mejora en 3 intentos se limpia el chino en lugar de fallar', async () => {
    create.mockImplementation(async (...call: any[]) => (asked([call[0]]) === 'Alertas' ? reply('Los carritos 上升 siguen parados.') : reply(GOOD)));
    const r = await generateOverviewAiReport(makeReport());
    expect(create).toHaveBeenCalledTimes(SECTIONS.length - 1 + 3);
    expect(r.text).not.toMatch(/[\u4e00-\u9fff]/);
    // la frase rota se quita entera (no queda «Los carritos siguen parados.» mutilado)
    expect(r.text).not.toContain('Los carritos');
  });

  it('quita el título y el razonamiento que el modelo cuela delante', async () => {
    create.mockResolvedValue(reply(`<think>pienso cosas</think>## Resumen ejecutivo\n\n${GOOD}`));
    const r = await generateOverviewAiReport(makeReport());
    expect(r.text).not.toContain('pienso');
    expect(r.text.match(/^## Resumen ejecutivo$/gm)).toHaveLength(1);
  });

  it('un número pegado a una palabra se reintenta y, si no mejora, se separa', async () => {
    create.mockImplementation(async (...call: any[]) => (asked([call[0]]) === 'Embudo y carritos' ? reply('Solo 1 de los 5carritos llegó a pagar.') : reply(GOOD)));
    const r = await generateOverviewAiReport(makeReport());
    expect(r.text).toContain('5 carritos');
    expect(r.text).not.toContain('5carritos');
  });

  it('«reembolsos» es una palabra válida del informe', async () => {
    create.mockResolvedValue(reply('Los reembolsos han bajado de 0,59 € a 0,00 €.'));
    const r = await generateOverviewAiReport(makeReport());
    expect(r.attempts).toBe(SECTIONS.length);
  });

  it('nunca usa más de 7 llamadas a la vez', async () => {
    let live = 0;
    let peak = 0;
    create.mockImplementation(async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return reply(GOOD);
    });
    await generateOverviewAiReport(makeReport());
    expect(peak).toBeLessThanOrEqual(7);
    expect(peak).toBeGreaterThan(1);
  });

  it('si casi todas las secciones salen vacías da un error claro', async () => {
    create.mockResolvedValue(reply(''));
    await expect(generateOverviewAiReport(makeReport())).rejects.toThrow(/ningún texto/);
  });
});
