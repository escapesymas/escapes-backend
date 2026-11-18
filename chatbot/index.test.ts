import { describe, it, expect, vi, beforeEach } from 'vitest';

// generateReply: reintentos y elección de la mejor respuesta, con MiniMax simulado.
const create = vi.fn();
vi.mock('./minimax.js', () => ({
  minimaxClient: { chat: { completions: { create: (...a: any[]) => create(...a) } } },
  CHAT_MODEL: 'test', CHAT_LIMITS: { maxTokens: 100, reasoningEffort: 'low', temperature: 0.2, topP: 0.8, historyMaxMessages: 20 },
}));
vi.mock('../db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('../redis.js', () => ({ getRedisClient: vi.fn(async () => null) }));
vi.mock('../lib/live-chat.js', () => ({ supportStatus: vi.fn(async () => null) }));
vi.mock('../lib/ai-chat-log.js', () => ({ logAiTurn: vi.fn(), validSessionKey: vi.fn(() => null) }));
vi.mock('../utils.js', () => ({ verifyJWT: vi.fn(() => null) }));
vi.mock('./catalog.js', () => ({
  getCatalogContext: vi.fn(), getGarageContext: vi.fn(), getGarageEntries: vi.fn(), getRecentOrdersContext: vi.fn(),
  extractMotorcycleFromQuery: vi.fn(), cardsFor: vi.fn(() => []),
}));
vi.mock('./webSearch.js', () => ({ isTechSpecQuery: vi.fn(() => false), searchMotorcycleTechSpecs: vi.fn(async () => '') }));
vi.mock('../lib/order-pricing.js', () => ({ ORDER_TIERS: [], MAX_EXTRA_DISCOUNT_PERCENT: 10 }));

const { generateReply, buildSystemPrompt, humanSupportRules } = await import('./index.js');

const reply = (content: string, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { total_tokens: 10 } });
const history = [{ role: 'user' as const, content: 'pastillas para mi moto' }];

describe('generateReply', () => {
  beforeEach(() => create.mockReset());

  it('una respuesta limpia sale a la primera', async () => {
    create.mockResolvedValueOnce(reply('Te recomiendo las pastillas Tecnium, compatibles con tu moto.'));
    const r = await generateReply('sistema', history, 'Tecnium');
    expect(r.attempts).toBe(1);
    expect(r.raw).toContain('Tecnium');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('con una palabra inventada repite y avisa al modelo de cuál es', async () => {
    create
      .mockResolvedValueOnce(reply('Te recomiendo las pastillas, con mucha waitress incluida.'))
      .mockResolvedValueOnce(reply('Te recomiendo las pastillas, compatibles con tu moto.'));
    const r = await generateReply('sistema', history, '');
    expect(r.attempts).toBe(2);
    expect(r.raw).toBe('Te recomiendo las pastillas, compatibles con tu moto.');
    const second = create.mock.calls[1][0].messages[0].content as string;
    expect(second).toContain('waitress');
    expect(second).toContain('IMPORTANTE');
  });

  it('con chino repite, y si no se arregla se queda con la mejor y quita el chino', async () => {
    create
      .mockResolvedValueOnce(reply('Hola 你好 amigo, tienes las pastillas.'))
      .mockResolvedValueOnce(reply('Hola 你好 你好 amigo, tienes las pastillas mingle waitress.'))
      .mockResolvedValueOnce(reply('Hola 你好 amigo, mira las pastillas.'));
    const r = await generateReply('sistema', history, '');
    expect(r.attempts).toBe(3);
    expect(r.raw).not.toMatch(/[一-鿿]/);
    expect(r.raw).toContain('pastillas');
    expect(r.raw).not.toContain('mingle');
  });

  it('una respuesta vacía se repite', async () => {
    create.mockResolvedValueOnce(reply('')).mockResolvedValueOnce(reply('Claro, dime tu moto.'));
    const r = await generateReply('sistema', history, '');
    expect(r.attempts).toBe(2);
    expect(r.raw).toBe('Claro, dime tu moto.');
  });

  it('quita el razonamiento que se cuela delante', async () => {
    create.mockResolvedValueOnce(reply('pienso cosas raras</think>Claro, dime tu moto.'));
    const r = await generateReply('sistema', history, '');
    expect(r.raw).toBe('Claro, dime tu moto.');
  });
});

describe('prompt del asistente', () => {
  it('lleva la ficha del producto de la página y las reglas nuevas', () => {
    const p = buildSystemPrompt('Visitante', 'lista', '', 'DATOS DE LA TIENDA', '', '', 'EL CLIENTE ESTÁ VIENDO ESTE PRODUCTO');
    expect(p).toContain('EL CLIENTE ESTÁ VIENDO ESTE PRODUCTO');
    expect(p).toContain('NUNCA digas que tenemos');
    expect(p).toContain('di «de los que te enseño»');
  });
});

describe('atención humana para visitantes sin cuenta', () => {
  const status: any = { available: true, agentName: 'Laura', mode: 'auto', hoursText: 'L-V 9-18', nextOpen: null };

  it('un invitado oye que necesita una cuenta y que puede crearla en el propio chat', () => {
    const t = humanSupportRules(status, true);
    expect(t).toMatch(/NO tiene sesión/);
    expect(t).toMatch(/necesitas una cuenta/);
    expect(t).toMatch(/crearla aquí mismo/);
    expect(t).toMatch(/\[\[ASESOR\]\]/);
  });

  it('también cuando no hay asesores conectados (dejar un mensaje)', () => {
    const t = humanSupportRules({ ...status, available: false, mode: 'auto' }, true);
    expect(t).toMatch(/\[\[MENSAJE\]\]/);
    expect(t).toMatch(/necesitas una cuenta/);
  });

  it('con sesión no se menciona la cuenta', () => {
    expect(humanSupportRules(status, false)).not.toMatch(/necesitas una cuenta/);
  });
});
