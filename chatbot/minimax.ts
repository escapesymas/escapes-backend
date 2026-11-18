import OpenAI from 'openai';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.warn('[WARNING] MINIMAX_API_KEY not set — chatbot will fail at request time');
}

export const minimaxClient = new OpenAI({
  apiKey: apiKey || 'missing-set-env',
  baseURL: 'https://api.minimax.io/v1',
});

// MiniMax-M3.1-Flash (24/10/2026): mejor español y menos datos inventados que M2.7-highspeed en las pruebas,
// y más barato ($0,15 / $0,60 por millón de tokens de entrada / salida).
export const CHAT_MODEL = 'MiniMax-M3.1-Flash';

export const CHAT_LIMITS = {
  // Incluye el razonamiento del modelo. Con razonamiento «low» gasta ~100-300 tokens, pero se deja holgura por si acaso.
  maxTokens: 3000,
  // M3.1-Flash razonaba 500-1.000 tokens hasta para «¿qué pastillas me recomiendas?» (respuestas de 5 a 27 s). Con «low» la
  // misma pregunta tarda ~2 s y las respuestas siguen siendo correctas (medido con la batería de 30 preguntas del 18/11/2026).
  // `thinking: disabled` no lo admite este modelo. CHAT_REASONING_EFFORT = low | medium | high.
  reasoningEffort: (process.env.CHAT_REASONING_EFFORT || 'low') as 'low' | 'medium' | 'high',
  temperature: 0.2,
  topP: 0.8,
  historyMaxMessages: 20,
};
